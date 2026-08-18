import { NextResponse } from "next/server";

import { syncIfStale } from "@/lib/event/calendar-sync.mjs";
import { calendarConfig, supabaseConfig } from "@/lib/event/config.mjs";
import * as db from "@/lib/event/db.mjs";
import { buildSchedulePayload } from "@/lib/event/schedule.mjs";

/*
 * 開催日一覧の公開API（/event/api/schedule/）。
 *
 * LP（public/event/script.js）と申込フォームの両方が、この応答を
 * 「どの回が受付中か」の唯一の情報源として使う。
 *
 * カレンダー同期は sync-on-read + TTL（syncIfStale 側で制御）。
 * GOOGLE_CALENDAR_* が未設定、またはGoogle側の障害で同期できなくても、
 * 500 にはせずDBの現状で応答する（表示を止めないため。webhook/route.ts の
 * buildMailer と同じ「未設定は握りつぶして続行する」考え方）。
 */

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const config = supabaseConfig();

  try {
    const calendar = calendarConfig();
    await syncIfStale({ config, calendar, db, now: new Date() });
  } catch (error) {
    /*
     * calendarConfig() は環境変数未設定で例外にする（config.mjs の方針）。
     * syncIfStale 自体は同期失敗を投げずに { error } で返すため、ここに来るのは
     * 主に未設定のケース。どちらもログのみに留め、応答は継続する。
     */
    console.warn(
      `[event-schedule] カレンダー同期をスキップしました: ${(error as Error).message}`,
    );
  }

  const now = new Date();
  const events = await db.listPublishedUpcomingEvents(config, now.toISOString());

  /*
   * 満席判定のための件数取得。
   *
   * このAPIは誰でも叩けるため、1リクエストあたりのDB問い合わせ回数を抑える。
   *   * 定員が無い回（capacity が null）は満席になりようがないので数えない
   *   * 残りは回ごとではなく1回の問い合わせでまとめて数える
   * 以前は回の数だけ HEAD リクエストを投げていた（回が増えるほど増幅した）。
   */
  const countable = events.filter(
    (event) => event.capacity !== null && event.capacity !== undefined,
  );

  const paidCounts = countable.length > 0
    ? await db.countPaidApplicationsByEventIds(config, countable.map((event) => event.id))
    : {};

  const payload = buildSchedulePayload({ events, paidCounts, now });

  return NextResponse.json(payload, {
    headers: {
      /*
       * 1分キャッシュ。同期TTL（10分）より十分短く、更新の遅延を抑える。
       * s-maxage も同じ値にして、CDN（Cloudflare）側にも1分持たせる。
       * ブラウザのキャッシュだけでは、別々の閲覧者からの連続アクセスが
       * そのままDBへの問い合わせになるため。
       */
      "Cache-Control": "public, max-age=60, s-maxage=60",
    },
  });
}

import { currentAdmin } from "@/lib/event/admin-session";
import {
  APPLICATION_CSV_COLUMNS,
  toAdminRow,
} from "@/lib/event/admin-view.mjs";
import { isUuid } from "@/lib/event/application-input.mjs";
import { supabaseConfig } from "@/lib/event/config.mjs";
import { buildCsv, csvFileName } from "@/lib/event/csv.mjs";
import { findEventById, listApplications } from "@/lib/event/db.mjs";

/*
 * 申込者一覧のCSV（仕様書9章の①）。
 * 一覧と同じ項目を出す。?eventId= を指定した回だけに絞れる
 * （管理画面のCSVリンクが選択中の回のIDを付ける）。無指定は従来どおり全回。
 */

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  /* 未ログインには渡さない（受入条件10）。 */
  if ((await currentAdmin()) === null) {
    return new Response("unauthorized", { status: 401 });
  }

  const config = supabaseConfig();
  const eventId = new URL(request.url).searchParams.get("eventId");

  /*
   * eventId はURLから来る。events.id は UUID なので、形の合わない値は
   * そのまま問い合わせに載せずここで断る（認可を通ったあとに確かめる。
   * 未ログインには「形式が不正」すら返さない）。
   */
  if (eventId !== null && !isUuid(eventId)) {
    return new Response("bad request", { status: 400 });
  }

  const applications = await listApplications(config, { eventId });
  const csv = buildCsv(APPLICATION_CSV_COLUMNS, applications.map(toAdminRow));

  /* ファイル名にも回の開催日を入れる。全回まとめの場合は今日の日付のまま。 */
  const event = eventId ? await findEventById(config, eventId) : null;
  const fileDate = event ? new Date(event.event_date) : new Date();

  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition":
        `attachment; filename="${csvFileName("applications", fileDate)}"`,
      "Cache-Control": "no-store",
    },
  });
}

import { syncIfStale } from "@/lib/event/calendar-sync.mjs";
import { calendarConfig, supabaseConfig } from "@/lib/event/config.mjs";
import * as db from "@/lib/event/db.mjs";
import { resolveSelectableEvents } from "@/lib/event/schedule.mjs";

import { ApplyForm } from "./ApplyForm";

/*
 * 参加申込ページ（仕様書4.2）。
 *
 * 入口は静的な詳細ページ（/event/）。ここは入力だけを担い、
 * 金額の表示は次の確認画面（/event/apply/confirm/）が行う。
 *
 * 開催日が複数あるため、選べる回の一覧を作ってフォームへ渡す。
 * 「受け付けているか」の判定は /event/api/schedule/ と同じ
 * lib/event/schedule.mjs（resolveSelectableEvents）を使い、
 * LPとフォームでずれが起きないようにする。
 *
 * 公開回が1件も選べない場合と、選べる回はあるが全回満席の場合とで、
 * 出す案内を分ける（後者は既存の満席画面をそのまま使う）。
 * どちらも「見せない」だけで、止める役目は submitApplication と
 * startCheckout が負う（URLを直接開かれても効くようにするため）。
 */

/* 開催日一覧は都度DBを見る。静的に焼くと満席・受付終了が古い表示のままになる。 */
export const dynamic = "force-dynamic";

export default async function ApplyPage() {
  const config = supabaseConfig();

  /*
   * カレンダー同期はベストエフォート。/event/api/schedule/ と同じ方針で、
   * GOOGLE_CALENDAR_* が未設定・Google側の障害でもページ表示は止めない。
   */
  try {
    const calendar = calendarConfig();
    await syncIfStale({ config, calendar, db, now: new Date() });
  } catch (error) {
    console.warn(
      `[apply] カレンダー同期をスキップしました: ${(error as Error).message}`,
    );
  }

  const now = new Date();
  const events = await db.listPublishedUpcomingEvents(config, now.toISOString());

  /*
   * 満席判定の件数は1回の問い合わせでまとめて取る（/event/api/schedule/ と同じ）。
   * 定員が無い回は満席になりようがないので数えない。
   * ここは表示のための判定で、実際に止めるのは submitApplication と
   * startCheckout（回ごとに数え直す）。
   */
  const countable = events.filter(
    (event) => event.capacity !== null && event.capacity !== undefined,
  );

  const paidCounts = countable.length > 0
    ? await db.countPaidApplicationsByEventIds(config, countable.map((event) => event.id))
    : {};

  const scheduleItems = resolveSelectableEvents({ events, paidCounts, now });

  if (scheduleItems.length === 0) {
    return (
      <>
        <section className="section event-hero" aria-labelledby="apply-title">
          <div className="container">
            <nav className="breadcrumb" aria-label="パンくずリスト">
              <ol className="breadcrumb__list">
                <li>
                  <a href="/">ホーム</a>
                </li>
                <li>
                  <a href="/event/">交流会</a>
                </li>
                <li aria-current="page">お申し込み</li>
              </ol>
            </nav>

            <div className="event-hero__inner">
              <p className="event-hero__label" lang="en">
                Not Available
              </p>
              <h1 id="apply-title" className="event-hero__title">
                現在お申し込みを受け付けておりません
              </h1>
              <p className="event-hero__lead">
                現在、お申し込みを受け付けている開催日がありません。
              </p>
            </div>
          </div>
        </section>

        <section className="section" aria-labelledby="not-accepting-detail-title">
          <div className="container container--narrow">
            <h2 id="not-accepting-detail-title" className="visually-hidden">
              受付についてのご案内
            </h2>

            <div className="policy-box">
              <p>
                次回の開催が決まりましたら、交流会のご案内ページでお知らせします。
              </p>
            </div>

            <div className="confirm__actions">
              <a className="btn btn--primary" href="/event/">
                交流会のご案内へ
              </a>
            </div>
          </div>
        </section>
      </>
    );
  }

  const allSoldOut = scheduleItems.every((item) => item.soldOut);

  if (allSoldOut) {
    return (
      <>
        <section className="section event-hero" aria-labelledby="apply-title">
          <div className="container">
            <nav className="breadcrumb" aria-label="パンくずリスト">
              <ol className="breadcrumb__list">
                <li>
                  <a href="/">ホーム</a>
                </li>
                <li>
                  <a href="/event/">交流会</a>
                </li>
                <li aria-current="page">お申し込み</li>
              </ol>
            </nav>

            <div className="event-hero__inner">
              <p className="event-hero__label" lang="en">
                Sold Out
              </p>
              <h1 id="apply-title" className="event-hero__title">
                満席になりました
              </h1>
              <p className="event-hero__lead">
                定員に達したため、お申し込みの受付を終了しました。たくさんのお申し込みをありがとうございました。
              </p>
            </div>
          </div>
        </section>

        <section className="section" aria-labelledby="sold-out-detail-title">
          <div className="container container--narrow">
            <h2 id="sold-out-detail-title" className="visually-hidden">
              受付終了のご案内
            </h2>

            <div className="policy-box">
              <p>
                次回の開催が決まりましたら、交流会のご案内ページでお知らせします。
              </p>
            </div>

            <div className="confirm__actions">
              <a className="btn btn--primary" href="/event/">
                交流会のご案内へ
              </a>
            </div>

            <p className="confirm__note">
              お支払いがお済みの方は、ご登録のメールアドレス宛にお送りした参加確定メールをご確認ください。
            </p>
          </div>
        </section>
      </>
    );
  }

  return (
    <>
      <section className="section event-hero" aria-labelledby="apply-title">
        <div className="container">
          <nav className="breadcrumb" aria-label="パンくずリスト">
            <ol className="breadcrumb__list">
              <li>
                <a href="/">ホーム</a>
              </li>
              <li>
                <a href="/event/">交流会</a>
              </li>
              <li aria-current="page">お申し込み</li>
            </ol>
          </nav>

          <div className="event-hero__inner">
            <p className="event-hero__label" lang="en">
              Application
            </p>
            <h1 id="apply-title" className="event-hero__title">
              お申し込み
            </h1>
            <p className="event-hero__lead">
              まず参加日をお選びください。続けて必要事項をご入力いただくと、業界・職種・立場・年齢区分に応じて参加費を計算し、次の画面で金額をご確認いただいてから決済へお進みいただきます。
            </p>
          </div>
        </div>
      </section>

      <section className="section" aria-labelledby="apply-form-title">
        <div className="container container--narrow">
          <h2 id="apply-form-title" className="visually-hidden">
            申込フォーム
          </h2>
          <ApplyForm events={scheduleItems} />
        </div>
      </section>
    </>
  );
}

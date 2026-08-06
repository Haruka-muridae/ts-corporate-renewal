import { isEventSoldOut } from "@/lib/event/capacity.mjs";
import { supabaseConfig } from "@/lib/event/config.mjs";
import { findPublishedEvent } from "@/lib/event/db.mjs";

import { ApplyForm } from "./ApplyForm";

/*
 * 参加申込ページ（仕様書4.2）。
 *
 * 入口は静的な詳細ページ（/event/）。ここは入力だけを担い、
 * 金額の表示は次の確認画面（/event/apply/confirm/）が行う。
 *
 * 定員に達している場合はフォームを出さず、満席の案内に差し替える。
 * ここは「見せない」だけで、止める役目は submitApplication と
 * startCheckout が負う（URLを直接開かれても効くようにするため）。
 */

/* 定員の判定は都度DBを見る。静的に焼くと満席になっても古い表示のままになる。 */
export const dynamic = "force-dynamic";

export default async function ApplyPage() {
  const config = supabaseConfig();
  const event = await findPublishedEvent(config);

  /*
   * イベントが無いときはフォームを出す（従来どおり）。
   * 送信すると submitApplication が「受け付けているイベントがありません」と返す。
   * ここで画面を変えると、受付前・受付終了との区別が付かなくなる。
   */
  const soldOut = await isEventSoldOut(config, event);

  if (soldOut) {
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
              必要事項をご入力ください。ご入力いただいた業界・職種・立場・年齢区分に応じて参加費を計算し、次の画面で金額をご確認いただいてから決済へお進みいただきます。
            </p>
          </div>
        </div>
      </section>

      <section className="section" aria-labelledby="apply-form-title">
        <div className="container container--narrow">
          <h2 id="apply-form-title" className="visually-hidden">
            申込フォーム
          </h2>
          <ApplyForm />
        </div>
      </section>
    </>
  );
}

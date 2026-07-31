import { ApplyForm } from "./ApplyForm";

/*
 * 参加申込ページ（仕様書4.2）。
 *
 * 入口は静的な詳細ページ（/event/）。ここは入力だけを担い、
 * 金額の表示は次の確認画面（/event/apply/confirm/）が行う。
 */
export default function ApplyPage() {
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

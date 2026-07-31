import { notFound } from "next/navigation";

import { supabaseConfig } from "@/lib/event/config.mjs";
import { findApplicationById, findEventById } from "@/lib/event/db.mjs";
import { formatEventDateTime, formatYen } from "@/lib/event/mail/confirmation.mjs";
import {
  AGE_GROUP_LABELS,
  INDUSTRY_LABELS,
  OCCUPATION_LABELS,
  POSITION_LABELS,
  buildBreakdownLines,
  calculatePrice,
} from "@/lib/event/pricing.mjs";

import { startCheckout } from "../actions";

/*
 * 金額確認ページ（仕様書4.3）。
 *
 * 金額はURLやフォームから受け取らず、DBの申込内容から毎回計算し直す
 * （仕様書5.1、受入条件3）。ブラウザ側で金額を書き換えても、
 * ここにもStripeにも反映されない。
 */

/* 申込内容は都度DBから読む。キャッシュに載せない。 */
export const dynamic = "force-dynamic";

type SearchParams = Promise<{ id?: string }>;

export default async function ConfirmPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const { id } = await searchParams;

  if (!id) {
    notFound();
  }

  const config = supabaseConfig();
  const application = await findApplicationById(config, id);

  if (application === null) {
    notFound();
  }

  const event = await findEventById(config, application.event_id);

  if (event === null) {
    notFound();
  }

  const attributes = {
    industry: application.industry,
    occupation: application.occupation,
    position: application.position,
    ageGroup: application.age_group,
    isBannedDeclared: application.is_banned_declared,
  };

  const breakdown = calculatePrice(attributes);
  const lines = buildBreakdownLines(breakdown, attributes);

  return (
    <>
      <section className="section event-hero" aria-labelledby="confirm-title">
        <div className="container">
          <nav className="breadcrumb" aria-label="パンくずリスト">
            <ol className="breadcrumb__list">
              <li>
                <a href="/">ホーム</a>
              </li>
              <li>
                <a href="/event/">交流会</a>
              </li>
              <li aria-current="page">お申し込み内容の確認</li>
            </ol>
          </nav>

          <div className="event-hero__inner">
            <p className="event-hero__label" lang="en">
              Confirmation
            </p>
            <h1 id="confirm-title" className="event-hero__title">
              お申し込み内容の確認
            </h1>
            <p className="event-hero__lead">
              内容と金額をご確認のうえ、決済へお進みください。この時点ではまだお支払いは完了していません。
            </p>
          </div>
        </div>
      </section>

      <section className="section" aria-labelledby="confirm-detail-title">
        <div className="container container--narrow">
          <h2 id="confirm-detail-title" className="confirm__heading">
            ご参加内容
          </h2>

          <dl className="event-outline__list">
            <div className="event-outline__row">
              <dt>交流会名</dt>
              <dd>{event.name}</dd>
            </div>
            <div className="event-outline__row">
              <dt>開催日時</dt>
              <dd>{formatEventDateTime(
                      new Date(event.event_date),
                      event.event_end_at ? new Date(event.event_end_at) : null,
                    )}</dd>
            </div>
            <div className="event-outline__row">
              <dt>開催場所</dt>
              <dd>
                {String(event.venue)
                  .split("\n")
                  .map((line: string) => (
                    <span className="confirm__line" key={line}>
                      {line}
                    </span>
                  ))}
              </dd>
            </div>
          </dl>

          <h2 className="confirm__heading">お申し込み者</h2>

          <dl className="event-outline__list">
            <div className="event-outline__row">
              <dt>氏名</dt>
              <dd>
                {application.name}（{application.name_kana}）
              </dd>
            </div>
            <div className="event-outline__row">
              <dt>メールアドレス</dt>
              <dd>{application.email}</dd>
            </div>
            <div className="event-outline__row">
              <dt>電話番号</dt>
              <dd>{application.phone}</dd>
            </div>
            <div className="event-outline__row">
              <dt>会社名または団体名</dt>
              <dd>{application.company}</dd>
            </div>
            {application.department ? (
              <div className="event-outline__row">
                <dt>部署名</dt>
                <dd>{application.department}</dd>
              </div>
            ) : null}
            {application.job_title ? (
              <div className="event-outline__row">
                <dt>役職名</dt>
                <dd>{application.job_title}</dd>
              </div>
            ) : null}
            <div className="event-outline__row">
              <dt>業界</dt>
              <dd>
                {INDUSTRY_LABELS[
                  application.industry as keyof typeof INDUSTRY_LABELS
                ]}
                {application.industry_other_text
                  ? `（${application.industry_other_text}）`
                  : ""}
              </dd>
            </div>
            <div className="event-outline__row">
              <dt>職種</dt>
              <dd>
                {OCCUPATION_LABELS[
                  application.occupation as keyof typeof OCCUPATION_LABELS
                ]}
                {application.occupation_other_text
                  ? `（${application.occupation_other_text}）`
                  : ""}
              </dd>
            </div>
            <div className="event-outline__row">
              <dt>立場</dt>
              <dd>
                {POSITION_LABELS[
                  application.position as keyof typeof POSITION_LABELS
                ]}
              </dd>
            </div>
            <div className="event-outline__row">
              <dt>年齢区分</dt>
              <dd>
                {AGE_GROUP_LABELS[
                  application.age_group as keyof typeof AGE_GROUP_LABELS
                ]}
              </dd>
            </div>
          </dl>

          <h2 className="confirm__heading">お支払い金額</h2>

          {/*
            出禁を申告した場合は内訳も理由も出さず、金額だけを示す（仕様書3.3）。
          */}
          {breakdown.isBannedDeclared ? (
            <dl className="price-breakdown">
              <div className="price-breakdown__row price-breakdown__row--total">
                <dt>参加費</dt>
                <dd>{formatYen(breakdown.finalPrice)}（税込）</dd>
              </div>
            </dl>
          ) : (
            <dl className="price-breakdown">
              <div className="price-breakdown__row">
                <dt>交流会参加費</dt>
                <dd>{formatYen(breakdown.basePrice)}</dd>
              </div>
              {lines.map((line) => (
                <div className="price-breakdown__row" key={line.label}>
                  <dt>{line.label}</dt>
                  <dd>{formatYen(line.amount)}</dd>
                </div>
              ))}
              {breakdown.discountTotal > 0 ? (
                <div className="price-breakdown__row">
                  <dt>割引合計</dt>
                  <dd>{formatYen(-breakdown.discountTotal)}</dd>
                </div>
              ) : null}
              <div className="price-breakdown__row price-breakdown__row--total">
                <dt>お支払い金額</dt>
                <dd>{formatYen(breakdown.finalPrice)}（税込）</dd>
              </div>
            </dl>
          )}

          {breakdown.isMinPriceApplied ? (
            <p className="confirm__note">
              割引後の金額が最低販売価格を下回るため、3,300円（税込）となります。
            </p>
          ) : null}

          <div className="policy-box">
            <h2 className="confirm__heading confirm__heading--inline">
              キャンセルについて
            </h2>
            <ul className="policy-box__list">
              <li>
                <strong>
                  参加者ご都合によるキャンセル・返金は、一切お受けしておりません。
                </strong>
                ご欠席、遅刻、途中退出の場合も返金はいたしません。
              </li>
              <li>
                参加権を第三者へお譲りいただくことは可能です。開催前であればいつでも承ります。
              </li>
            </ul>
            <p className="policy-box__note">
              詳細は
              <a href="/event/legal.html">特定商取引法に基づく表記</a>
              をご確認ください。
            </p>
          </div>

          <div className="confirm__actions">
            {/*
              決済へ進むときに送るのは申込IDだけ。金額は送らない。
              サーバーがDBから読み直して計算する。
            */}
            <form action={startCheckout}>
              <input type="hidden" name="applicationId" value={application.id} />
              <button className="btn btn--primary" type="submit">
                決済へ進む
              </button>
            </form>

            <a className="btn btn--secondary" href="/event/apply/">
              修正する
            </a>
          </div>

          <p className="confirm__note">
            「修正する」を選ぶと、入力画面に戻って最初からご入力いただきます。
          </p>
        </div>
      </section>
    </>
  );
}

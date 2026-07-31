import { supabaseConfig } from "@/lib/event/config.mjs";
import {
  findApplicationById,
  findEventById,
  findPaymentByApplicationId,
  findPaymentBySessionId,
} from "@/lib/event/db.mjs";
import { formatEventDateTime, formatYen } from "@/lib/event/mail/confirmation.mjs";
import { resolveResultState } from "@/lib/event/payment-result.mjs";

/*
 * 決済完了ページ（仕様書4.5）。
 *
 * このページに来たこと自体は「支払済み」の根拠にしない。確定はWebhookだけが行う。
 * ここではDBに記録された状態を読み、そのとき言えることだけを出す。
 *
 * PayPay のようなリダイレクト型では、戻ってきた時点でまだ Webhook が
 * 届いていないことがある。その場合は「確認中」を出す。
 */

/* 状態は決済のたびに変わる。キャッシュに載せない。 */
export const dynamic = "force-dynamic";

type SearchParams = Promise<{ session_id?: string; id?: string }>;

export default async function DonePage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const { session_id: sessionId, id } = await searchParams;
  const config = supabaseConfig();

  /*
   * Stripe からは session_id で戻る。
   * 「確認中」からの再読み込み用に、申込IDでも引けるようにしておく。
   */
  const payment = sessionId
    ? await findPaymentBySessionId(config, sessionId)
    : id
      ? await findPaymentByApplicationId(config, id)
      : null;

  const applicationId = payment?.application_id ?? id ?? null;

  const application = applicationId
    ? await findApplicationById(config, applicationId)
    : null;

  const state = resolveResultState({ application, payment });

  const event =
    application !== null ? await findEventById(config, application.event_id) : null;

  /*
   * 確定として見せてよいのは「支払済み」かつ「受付番号が発行済み」のときだけ。
   * 支払済みだが番号がまだ無い場合（採番の途中で止まった場合）は、
   * 空欄の完了画面ではなく確認中の案内を出す。
   */
  const showsConfirmed = state.kind === "paid" && state.isConfirmed;
  const showsPending =
    state.kind === "pending" || (state.kind === "paid" && !state.isConfirmed);

  return (
    <>
      <section className="section event-hero" aria-labelledby="done-title">
        <div className="container">
          <div className="event-hero__inner">
            <p className="event-hero__label" lang="en">
              {showsConfirmed ? "Thank you" : "Status"}
            </p>
            <h1 id="done-title" className="event-hero__title">
              {showsConfirmed
                ? "お申し込みが完了しました"
                : showsPending
                  ? "お支払いを確認しています"
                  : state.kind === "unknown"
                    ? "お申し込みが見つかりません"
                    : "お申し込みの状況"}
            </h1>
            <p className="event-hero__lead">
              {showsConfirmed
                ? "お支払いを確認いたしました。当日お会いできることを楽しみにしております。"
                : showsPending
                  ? "決済事業者からの確認をお待ちしています。確認が取れ次第、参加確定メールをお送りします。"
                  : state.kind === "unknown"
                    ? "お手数ですが、お申し込みからやり直してください。"
                    : "現在の状況をご確認ください。"}
            </p>
          </div>
        </div>
      </section>

      <section className="section" aria-labelledby="done-detail-title">
        <div className="container container--narrow">
          <h2 id="done-detail-title" className="visually-hidden">
            お申し込みの状況
          </h2>

          {showsConfirmed ? (
            <>
              <div className="result-receipt">
                <p className="result-receipt__label">受付番号</p>
                <p className="result-receipt__number">{state.receiptNumber}</p>
                <p className="result-receipt__note">
                  当日の受付でお伝えいただく場合があります。参加確定メールにも記載しています。
                </p>
              </div>

              {event !== null ? (
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
                  {payment !== null ? (
                    <div className="event-outline__row">
                      <dt>お支払い金額</dt>
                      <dd>{formatYen(payment.final_price)}（税込）</dd>
                    </div>
                  ) : null}
                </dl>
              ) : null}

              <div className="policy-box">
                <p>
                  ご入力いただいたメールアドレス宛に、参加確定メールをお送りしています。
                  届かない場合は迷惑メールフォルダをご確認のうえ、
                  <a href="mailto:architect@potenitas.com">architect@potenitas.com</a>
                  までご連絡ください。
                </p>
                <p>
                  領収書は、決済時にStripeより別途メールでお送りしています。
                </p>
              </div>

              <div className="policy-box">
                <h3 className="confirm__heading confirm__heading--inline">
                  当日について
                </h3>
                <p>
                  当日は、参加者の皆さまに名札を着用いただきます。名札には、氏名・会社名・業界・職種・立場を記載します。年齢は記載いたしません。
                </p>
              </div>

              <div className="policy-box">
                <h3 className="confirm__heading confirm__heading--inline">
                  キャンセルについて
                </h3>
                <p>
                  参加者ご都合によるキャンセル・返金は、一切お受けしておりません。ご欠席、遅刻、途中退出の場合も返金はいたしません。
                </p>
                <p>
                  参加権を第三者へお譲りいただくことは可能です。開催前であればいつでも承ります。ご希望の場合は上記の問い合わせ先までご連絡ください。受付番号は変更されません。
                </p>
              </div>
            </>
          ) : null}

          {showsPending ? (
            <>
              <div className="policy-box">
                <p>
                  お支払い手続きは受け付けています。決済事業者からの確認が取れ次第、
                  参加確定メールをお送りし、このページにも受付番号が表示されます。
                </p>
                <p>
                  PayPayなど、確認までに時間がかかる決済手段をお選びの場合、
                  数分かかることがあります。しばらくおいてから、このページを再読み込みしてください。
                </p>
              </div>

              <div className="confirm__actions">
                {/*
                  再読み込み用。申込IDで引けるようにしておくと、
                  Stripe から戻ったURLを閉じたあとでも状況を確認できる。
                */}
                <a
                  className="btn btn--secondary"
                  href={
                    applicationId
                      ? `/event/apply/done/?id=${applicationId}`
                      : "/event/apply/done/"
                  }
                >
                  状況を再確認する
                </a>
              </div>

              <p className="confirm__note">
                しばらく経っても変わらない場合は、
                <a href="mailto:architect@potenitas.com">architect@potenitas.com</a>
                までご連絡ください。
              </p>
            </>
          ) : null}

          {state.kind === "failed" || state.kind === "expired" ? (
            <>
              <div className="policy-box">
                <p>
                  {state.kind === "failed"
                    ? "決済が完了しませんでした。お支払いは発生していません。"
                    : "決済手続きの有効期限が切れました。お支払いは発生していません。"}
                </p>
                <p>
                  お手数ですが、お申し込みからやり直してください。
                </p>
              </div>

              <div className="confirm__actions">
                <a className="btn btn--primary" href="/event/apply/">
                  お申し込みへ戻る
                </a>
              </div>
            </>
          ) : null}

          {state.kind === "refunded" ? (
            <div className="policy-box">
              <p>
                このお申し込みは返金処理が行われています（受付番号
                {state.receiptNumber ?? "―"}）。
              </p>
              <p>
                ご不明な点は
                <a href="mailto:architect@potenitas.com">architect@potenitas.com</a>
                までご連絡ください。
              </p>
            </div>
          ) : null}

          {state.kind === "unknown" ? (
            <div className="confirm__actions">
              <a className="btn btn--primary" href="/event/apply/">
                お申し込みへ戻る
              </a>
              <a className="btn btn--secondary" href="/event/">
                交流会のご案内へ
              </a>
            </div>
          ) : null}
        </div>
      </section>
    </>
  );
}

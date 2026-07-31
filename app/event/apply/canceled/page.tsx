import { supabaseConfig } from "@/lib/event/config.mjs";
import {
  findApplicationById,
  findPaymentByApplicationId,
} from "@/lib/event/db.mjs";
import { resolveResultState } from "@/lib/event/payment-result.mjs";

import { startCheckout } from "../actions";

/*
 * 決済のキャンセル・中断ページ（仕様書4.5）。
 *
 * Stripe の決済画面で「戻る」を押した場合にここへ来る。
 * 申込の記録は残っているため、同じ内容のまま決済をやり直せる。
 *
 * ここでも「支払いは発生していない」と断定しない。中断したつもりでも
 * 実際には成立していることがあるため、DBの状態を見て案内を変える。
 */

export const dynamic = "force-dynamic";

type SearchParams = Promise<{ id?: string }>;

export default async function CanceledPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const { id } = await searchParams;
  const config = supabaseConfig();

  const application = id ? await findApplicationById(config, id) : null;
  const payment =
    application !== null
      ? await findPaymentByApplicationId(config, application.id)
      : null;

  const state = resolveResultState({ application, payment });

  /* 中断したはずが、実は支払が成立していた場合は完了ページへ案内する。 */
  const alreadyPaid = state.kind === "paid";

  /* 申込を特定できないときは、見出しから直さないと本文と食い違う。 */
  const isUnknown = application === null;

  return (
    <>
      <section className="section event-hero" aria-labelledby="canceled-title">
        <div className="container">
          <div className="event-hero__inner">
            <p className="event-hero__label" lang="en">
              {isUnknown ? "Status" : "Canceled"}
            </p>
            <h1 id="canceled-title" className="event-hero__title">
              {isUnknown
                ? "お申し込みが見つかりません"
                : alreadyPaid
                  ? "お支払いは完了しています"
                  : "決済を中断しました"}
            </h1>
            <p className="event-hero__lead">
              {isUnknown
                ? "お手数ですが、お申し込みからやり直してください。"
                : alreadyPaid
                  ? "この申し込みのお支払いは確認できています。内容は完了ページでご確認ください。"
                  : "お支払いは完了していません。お申し込みの内容は保存されていますので、続きから決済へ進めます。"}
            </p>
          </div>
        </div>
      </section>

      <section className="section" aria-labelledby="canceled-detail-title">
        <div className="container container--narrow">
          <h2 id="canceled-detail-title" className="visually-hidden">
            決済の再開
          </h2>

          {alreadyPaid ? (
            <div className="confirm__actions">
              <a
                className="btn btn--primary"
                href={`/event/apply/done/?id=${application?.id ?? ""}`}
              >
                完了ページへ
              </a>
            </div>
          ) : application !== null && state.canRetry ? (
            <>
              <div className="policy-box">
                <p>
                  お申し込みの内容はそのまま残っています。金額を確認してから、
                  もう一度決済へお進みください。
                </p>
              </div>

              <div className="confirm__actions">
                {/*
                  金額は送らない。サーバーがDBの申込内容から計算し直す。
                */}
                <form action={startCheckout}>
                  <input
                    type="hidden"
                    name="applicationId"
                    value={application.id}
                  />
                  <button className="btn btn--primary" type="submit">
                    決済をやり直す
                  </button>
                </form>

                <a
                  className="btn btn--secondary"
                  href={`/event/apply/confirm/?id=${application.id}`}
                >
                  内容を確認する
                </a>
              </div>

              <p className="confirm__note">
                最初から入力し直す場合は
                <a href="/event/apply/">お申し込みページ</a>
                へお進みください。
              </p>
            </>
          ) : (
            <>
              <div className="policy-box">
                <p>
                  お申し込みの内容を確認できませんでした。お手数ですが、
                  お申し込みからやり直してください。
                </p>
              </div>

              <div className="confirm__actions">
                <a className="btn btn--primary" href="/event/apply/">
                  お申し込みへ戻る
                </a>
                <a className="btn btn--secondary" href="/event/">
                  交流会のご案内へ
                </a>
              </div>
            </>
          )}
        </div>
      </section>
    </>
  );
}

import { notFound } from "next/navigation";

import { requireAdmin } from "@/lib/event/admin-session";
import {
  STATUS_LABELS,
  formatDateTime,
  paymentOf,
  toAdminRow,
} from "@/lib/event/admin-view.mjs";
import { supabaseConfig } from "@/lib/event/config.mjs";
import { findApplicationWithPayment, findEventById } from "@/lib/event/db.mjs";
import { buildBreakdownLines, calculatePrice } from "@/lib/event/pricing.mjs";

import { ApplicationEditor } from "./ApplicationEditor";

/*
 * 申込者詳細（仕様書9章）。
 *
 * 全入力情報、割引計算の内訳、Stripe の ID 類、譲渡履歴、管理者メモを出す。
 * 申込者情報の編集（譲渡対応）と参加確定メールの再送もここから行う。
 */

export const dynamic = "force-dynamic";

type Params = Promise<{ id: string }>;

export default async function AdminDetailPage({ params }: { params: Params }) {
  await requireAdmin();

  const { id } = await params;
  const config = supabaseConfig();
  const application = await findApplicationWithPayment(config, id);

  if (application === null) {
    notFound();
  }

  const event = await findEventById(config, application.event_id);
  const payment = paymentOf(application);
  const row = toAdminRow(application);

  /*
   * 割引の内訳は payments に保存した申込時点の値を正とする。
   * ここでの再計算は、記録と現在のルールがずれていないかの確認用。
   */
  const attributes = {
    industry: application.industry,
    occupation: application.occupation,
    position: application.position,
    ageGroup: application.age_group,
    isBannedDeclared: application.is_banned_declared,
  };

  const recalculated = calculatePrice(attributes);
  const lines = buildBreakdownLines(recalculated, attributes);

  const savedTotal = payment?.discount_total ?? null;
  const differs =
    payment !== null && payment.final_price !== recalculated.finalPrice;

  return (
    <main id="main-content" className="admin">
      <header className="admin__header">
        <div className="admin__header-inner">
          <h1 className="admin__title">
            申込者詳細
            {row.receiptNumber ? `（${row.receiptNumber}）` : ""}
          </h1>
          <a className="admin__back" href="/event/admin/">
            一覧へ戻る
          </a>
        </div>
      </header>

      <div className="admin__body admin__body--narrow">
        <section className="admin-section">
          <h2 className="admin-section__title">申込内容</h2>
          <dl className="admin-detail">
            <div className="admin-detail__row">
              <dt>ステータス</dt>
              <dd>
                <span className={`admin-status admin-status--${application.status}`}>
                  {STATUS_LABELS[application.status] ?? application.status}
                </span>
              </dd>
            </div>
            <div className="admin-detail__row">
              <dt>受付番号</dt>
              <dd>{row.receiptNumber || "未発行（支払済みで発行）"}</dd>
            </div>
            <div className="admin-detail__row">
              <dt>交流会</dt>
              <dd>{event?.name ?? "―"}</dd>
            </div>
            <div className="admin-detail__row">
              <dt>氏名</dt>
              <dd>
                {application.name}（{application.name_kana}）
              </dd>
            </div>
            <div className="admin-detail__row">
              <dt>メールアドレス</dt>
              <dd>{application.email}</dd>
            </div>
            <div className="admin-detail__row">
              <dt>電話番号</dt>
              <dd>{application.phone}</dd>
            </div>
            <div className="admin-detail__row">
              <dt>会社名</dt>
              <dd>{application.company}</dd>
            </div>
            <div className="admin-detail__row">
              <dt>部署名 / 役職名</dt>
              <dd>
                {application.department || "―"} / {application.job_title || "―"}
              </dd>
            </div>
            <div className="admin-detail__row">
              <dt>業界</dt>
              <dd>{row.industry}</dd>
            </div>
            <div className="admin-detail__row">
              <dt>職種</dt>
              <dd>{row.occupation}</dd>
            </div>
            <div className="admin-detail__row">
              <dt>立場</dt>
              <dd>{row.position}</dd>
            </div>
            <div className="admin-detail__row">
              <dt>年齢区分</dt>
              <dd>{row.ageGroup}</dd>
            </div>
            <div className="admin-detail__row">
              <dt>出禁の申告</dt>
              <dd>
                {application.is_banned_declared ? (
                  <span className="admin-flag">該当する</span>
                ) : (
                  "該当しない"
                )}
              </dd>
            </div>
            <div className="admin-detail__row">
              <dt>同意日時 / ポリシー版</dt>
              <dd>
                {formatDateTime(application.agreed_at)} / {application.policy_version}
              </dd>
            </div>
            <div className="admin-detail__row">
              <dt>申込日時</dt>
              <dd>{row.appliedAt}</dd>
            </div>
          </dl>
        </section>

        <section className="admin-section">
          <h2 className="admin-section__title">割引計算の内訳</h2>

          {payment === null ? (
            <p className="admin__empty">支払記録がありません。</p>
          ) : (
            <>
              <dl className="price-breakdown">
                <div className="price-breakdown__row">
                  <dt>交流会参加費</dt>
                  <dd>{payment.base_price.toLocaleString("ja-JP")}円</dd>
                </div>
                <div className="price-breakdown__row">
                  <dt>業界割引</dt>
                  <dd>-{payment.discount_industry.toLocaleString("ja-JP")}円</dd>
                </div>
                <div className="price-breakdown__row">
                  <dt>職種割引</dt>
                  <dd>-{payment.discount_occupation.toLocaleString("ja-JP")}円</dd>
                </div>
                <div className="price-breakdown__row">
                  <dt>立場割引</dt>
                  <dd>-{payment.discount_position.toLocaleString("ja-JP")}円</dd>
                </div>
                <div className="price-breakdown__row">
                  <dt>年齢割引</dt>
                  <dd>-{payment.discount_age.toLocaleString("ja-JP")}円</dd>
                </div>
                <div className="price-breakdown__row">
                  <dt>割引合計</dt>
                  <dd>-{Number(savedTotal).toLocaleString("ja-JP")}円</dd>
                </div>
                <div className="price-breakdown__row price-breakdown__row--total">
                  <dt>支払金額</dt>
                  <dd>{payment.final_price.toLocaleString("ja-JP")}円（税込）</dd>
                </div>
              </dl>

              <p className="admin__note">
                上記は申込時点のスナップショットです。現在の割引ルールで計算し直すと{" "}
                {recalculated.finalPrice.toLocaleString("ja-JP")}円
                {differs ? (
                  <strong>（記録と一致しません。ルールの変更後に申し込まれた記録です）</strong>
                ) : (
                  "（記録と一致）"
                )}
                。
              </p>

              {lines.length > 0 ? (
                <p className="admin__note">
                  現在のルールでの内訳：
                  {lines.map((line) => `${line.label} ${line.amount}円`).join(" / ")}
                </p>
              ) : null}
            </>
          )}
        </section>

        <section className="admin-section">
          <h2 className="admin-section__title">Stripe</h2>
          <dl className="admin-detail">
            <div className="admin-detail__row">
              <dt>Checkout Session</dt>
              <dd className="admin-detail__mono">
                {payment?.stripe_checkout_session_id ?? "―"}
              </dd>
            </div>
            <div className="admin-detail__row">
              <dt>PaymentIntent</dt>
              <dd className="admin-detail__mono">
                {payment?.stripe_payment_intent_id ?? "―"}
              </dd>
            </div>
            <div className="admin-detail__row">
              <dt>決済日時</dt>
              <dd>{row.paidAt || "―"}</dd>
            </div>
            <div className="admin-detail__row">
              <dt>返金</dt>
              <dd>
                {payment?.refunded_at
                  ? `${formatDateTime(payment.refunded_at)}／${
                      payment.refunded_amount?.toLocaleString("ja-JP") ?? "―"
                    }円`
                  : "―"}
              </dd>
            </div>
          </dl>
          <p className="admin__note">
            返金はこの画面では行いません。Stripeダッシュボードから手動で返金すると、
            Webhookでステータスが「返金済み（例外対応）」になります。
          </p>
        </section>

        <section className="admin-section">
          <h2 className="admin-section__title">譲渡履歴</h2>
          {application.is_transferred ? (
            <dl className="admin-detail">
              <div className="admin-detail__row">
                <dt>譲渡日時</dt>
                <dd>{formatDateTime(application.transferred_at)}</dd>
              </div>
              <div className="admin-detail__row">
                <dt>譲渡元 氏名</dt>
                <dd>{application.original_name ?? "―"}</dd>
              </div>
              <div className="admin-detail__row">
                <dt>譲渡元 メール</dt>
                <dd>{application.original_email ?? "―"}</dd>
              </div>
            </dl>
          ) : (
            <p className="admin__empty">譲渡の記録はありません。</p>
          )}
        </section>

        <ApplicationEditor
          applicationId={application.id}
          initial={{
            name: application.name,
            nameKana: application.name_kana,
            email: application.email,
            phone: application.phone,
            company: application.company,
            department: application.department ?? "",
            jobTitle: application.job_title ?? "",
            adminMemo: application.admin_memo ?? "",
          }}
          canResend={application.receipt_number !== null}
        />
      </div>
    </main>
  );
}

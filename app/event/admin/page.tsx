import { requireAdmin } from "@/lib/event/admin-session";
import { toAdminRow } from "@/lib/event/admin-view.mjs";
import { supabaseConfig } from "@/lib/event/config.mjs";
import { listApplications } from "@/lib/event/db.mjs";

import { logout } from "./actions";

/*
 * 申込者一覧（仕様書9章）。
 *
 * 未ログインでは表示しない（受入条件10）。requireAdmin() が
 * ログイン画面へ送る。
 */

export const dynamic = "force-dynamic";

export default async function AdminListPage() {
  const admin = await requireAdmin();

  const applications = await listApplications(supabaseConfig());
  const rows = applications.map(toAdminRow);

  const paidCount = rows.filter((row) => row.statusKey === "paid").length;
  const total = rows
    .filter((row) => row.statusKey === "paid")
    .reduce((sum, row) => sum + Number(row.finalPrice || 0), 0);

  return (
    <main id="main-content" className="admin">
      <header className="admin__header">
        <div className="admin__header-inner">
          <h1 className="admin__title">申込者一覧</h1>
          <div className="admin__account">
            <span className="admin__email">{admin.email}</span>
            <form action={logout}>
              <button className="admin__logout" type="submit">
                ログアウト
              </button>
            </form>
          </div>
        </div>
      </header>

      <div className="admin__body">
        <div className="admin__summary">
          <p>
            全 <strong>{rows.length}</strong> 件／支払済み{" "}
            <strong>{paidCount}</strong> 件／支払済みの合計{" "}
            <strong>{new Intl.NumberFormat("ja-JP").format(total)}円</strong>
          </p>

          <div className="admin__downloads">
            {/* CSVは別のルートで返す。ダウンロードとして扱わせる。 */}
            <a className="btn btn--secondary" href="/event/admin/csv/applications/">
              申込者CSV（全件）
            </a>
            <a className="btn btn--secondary" href="/event/admin/csv/nametags/">
              名札印刷用CSV（支払済みのみ）
            </a>
          </div>
        </div>

        {rows.length === 0 ? (
          <p className="admin__empty">まだ申し込みはありません。</p>
        ) : (
          /* 列が多いため、表だけを横スクロールさせる。 */
          <div className="admin__table-scroll">
            <table className="admin-table">
              <thead>
                <tr>
                  <th scope="col">受付番号</th>
                  <th scope="col">氏名</th>
                  <th scope="col">メール</th>
                  <th scope="col">会社名</th>
                  <th scope="col">業界</th>
                  <th scope="col">職種</th>
                  <th scope="col">立場</th>
                  <th scope="col">年齢区分</th>
                  <th scope="col">出禁申告</th>
                  <th scope="col">割引内訳</th>
                  <th scope="col">支払金額</th>
                  <th scope="col">ステータス</th>
                  <th scope="col">申込日時</th>
                  <th scope="col">決済日時</th>
                  <th scope="col">詳細</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td>{row.receiptNumber || "―"}</td>
                    <td>{row.name}</td>
                    <td className="admin-table__email">{row.email}</td>
                    <td>{row.company}</td>
                    <td>{row.industry}</td>
                    <td>{row.occupation}</td>
                    <td>{row.position}</td>
                    <td>{row.ageGroup}</td>
                    <td>
                      {row.bannedDeclared === "該当する" ? (
                        <span className="admin-flag">該当する</span>
                      ) : (
                        "―"
                      )}
                    </td>
                    <td className="admin-table__nowrap">
                      {row.discountTotal === "" ? "―" : (
                        <>
                          業界 {row.discountIndustry} / 職種 {row.discountOccupation}
                          <br />
                          立場 {row.discountPosition} / 年齢 {row.discountAge}
                          <br />
                          合計 {row.discountTotal}
                        </>
                      )}
                    </td>
                    <td className="admin-table__number">
                      {row.finalPrice === ""
                        ? "―"
                        : `${new Intl.NumberFormat("ja-JP").format(Number(row.finalPrice))}円`}
                    </td>
                    <td>
                      <span className={`admin-status admin-status--${row.statusKey}`}>
                        {row.status}
                      </span>
                      {row.transferred ? (
                        <span className="admin-flag admin-flag--muted">譲渡</span>
                      ) : null}
                    </td>
                    <td className="admin-table__nowrap">{row.appliedAt}</td>
                    <td className="admin-table__nowrap">{row.paidAt || "―"}</td>
                    <td>
                      <a href={`/event/admin/${row.id}/`}>開く</a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </main>
  );
}

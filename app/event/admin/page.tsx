import { requireAdmin } from "@/lib/event/admin-session";
import {
  describeCalendarSyncState,
  formatDateTime,
  toAdminRow,
} from "@/lib/event/admin-view.mjs";
import { resolveCapacityStatus } from "@/lib/event/capacity.mjs";
import { supabaseConfig } from "@/lib/event/config.mjs";
import {
  findCalendarSyncState,
  listApplications,
  listEventsForAdmin,
} from "@/lib/event/db.mjs";

import { logout } from "./actions";

/*
 * 申込者一覧（仕様書9章）。
 *
 * 未ログインでは表示しない（受入条件10）。requireAdmin() が
 * ログイン画面へ送る。
 *
 * 開催日が複数あるため、?eventId= で回を選ぶ。指定が無ければ
 * 「直近の公開回（開催日が最も近い未来の公開回）」、それも無ければ
 * 最新の行（listEventsForAdmin は開催日の新しい順）を既定にする。
 * 定員は回ごとの値なので、全回を混ぜて数えると「支払済み / 定員」が
 * 合わなくなる。イベントが1件も無いときだけ、従来どおり全件を出す。
 */

export const dynamic = "force-dynamic";

type SearchParams = Promise<{ eventId?: string }>;

export default async function AdminListPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const { eventId: eventIdParam } = await searchParams;
  const admin = await requireAdmin();

  const config = supabaseConfig();

  const events = await listEventsForAdmin(config);
  const now = new Date();

  const upcomingPublished = events
    .filter(
      (row) => row.is_published && new Date(row.event_date).getTime() >= now.getTime(),
    )
    .sort((a, b) => Date.parse(a.event_date) - Date.parse(b.event_date));

  const defaultEvent = upcomingPublished[0] ?? events[0] ?? null;

  const selectedEvent =
    (eventIdParam ? events.find((row) => row.id === eventIdParam) : undefined)
    ?? defaultEvent;

  const applications = await listApplications(config, { eventId: selectedEvent?.id ?? null });
  const rows = applications.map(toAdminRow);

  const paidCount = rows.filter((row) => row.statusKey === "paid").length;
  const capacity = resolveCapacityStatus({
    capacity: selectedEvent?.capacity ?? null,
    paidCount,
  });
  const total = rows
    .filter((row) => row.statusKey === "paid")
    .reduce((sum, row) => sum + Number(row.finalPrice || 0), 0);

  const syncState = await findCalendarSyncState(config);
  const csvQuery = selectedEvent ? `?eventId=${selectedEvent.id}` : "";

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
        {events.length > 0 ? (
          <nav className="admin-event-switch" aria-label="開催日の切り替え">
            <ul className="admin-event-switch__list">
              {events.map((row) => {
                const isSelected = selectedEvent?.id === row.id;

                return (
                  <li key={row.id}>
                    <a
                      className={`admin-event-switch__link${
                        isSelected ? " is-active" : ""
                      }`}
                      href={isSelected ? "/event/admin/" : `/event/admin/?eventId=${row.id}`}
                      aria-current={isSelected ? "page" : undefined}
                    >
                      {formatDateTime(row.event_date)}
                      {row.is_published ? "" : "（非公開）"}
                      {row.sync_warning ? " ⚠" : ""}
                    </a>
                  </li>
                );
              })}
            </ul>
          </nav>
        ) : null}

        {/*
          カレンダーが真実源のため、予定の削除・改題で is_published=false に
          なった回・日時がずれた回には sync_warning が付く（支払済みがある場合のみ）。
          自動では参加者へ連絡しないため、ここで気づいて手動対応する。
        */}
        {selectedEvent?.sync_warning ? (
          <p className="admin-notice" role="alert">
            <span className="admin-flag">要確認</span> {selectedEvent.sync_warning}
            {selectedEvent.sync_warning_at
              ? `（${formatDateTime(selectedEvent.sync_warning_at)}）`
              : ""}
          </p>
        ) : null}

        {/*
          初期状態（calendar_sync_state.last_synced_at = epoch）や結果が空のときは
          「未実行」と出す。1970年の日時を見せても、同期が動いていないのか
          壊れているのかが読み取れないため（判定は admin-view.mjs に置いてある）。
        */}
        <p className="admin__note">
          カレンダー同期の最終実行：{describeCalendarSyncState(syncState)}
        </p>

        {/*
          定員の状態。超過は返金対応が要るため、ちょうど（full）より強く出す。
          申込フローは支払済みが定員に達した時点で自動的に止まっている。
        */}
        {capacity.state === "over" ? (
          <p className="admin-notice" role="alert">
            <span className="admin-flag">定員超過</span> 支払済み{" "}
            <strong>{capacity.paidCount}</strong> 件に対して定員は{" "}
            <strong>{capacity.capacity}</strong> 名です（
            <strong>{capacity.over}</strong> 件の超過）。
            申込フローは停止済みです。超過分は Stripe
            ダッシュボードから返金してください。返金すると席は自動的に空きます。
          </p>
        ) : capacity.state === "full" ? (
          <p className="admin-notice" role="status">
            定員 <strong>{capacity.capacity}</strong> 名に達したため、申込フローを停止しました。
          </p>
        ) : null}

        <div className="admin__summary">
          <p>
            全 <strong>{rows.length}</strong> 件／支払済み{" "}
            <strong>{paidCount}</strong>
            {capacity.state === "none" ? " 件" : ` / ${capacity.capacity} 名`}
            ／支払済みの合計{" "}
            <strong>{new Intl.NumberFormat("ja-JP").format(total)}円</strong>
          </p>

          <div className="admin__downloads">
            {/* CSVは別のルートで返す。ダウンロードとして扱わせる。 */}
            <a
              className="btn btn--secondary"
              href={`/event/admin/csv/applications/${csvQuery}`}
            >
              申込者CSV（{selectedEvent ? "この回" : "全件"}）
            </a>
            <a
              className="btn btn--secondary"
              href={`/event/admin/csv/nametags/${csvQuery}`}
            >
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

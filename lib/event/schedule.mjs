/*
 * 開催日一覧の組み立て。
 *
 * ==================================================================
 * 方針
 * ==================================================================
 *   - 公開API（/event/api/schedule/）と申込ページで同じ判定を使う。
 *     「受け付けているか」の判断が2か所に分かれると、LPでは申し込めるのに
 *     フォームでは選べない、といったずれが起きるため。
 *   - 純粋な関数にする。DBアクセスも実時計も持ち込まない
 *     （件数と現在時刻は呼び出し側が渡す）。
 *   - 表示の文言は参加確定メールと同じ formatEventDateTime を使う。
 *     メールとLPで開催日時の書式が違うと、同じ回に見えなくなる。
 * ==================================================================
 */

import { isSoldOut } from './capacity.mjs';
import { formatEventDateTime } from './mail/confirmation.mjs';

/**
 * 「今この回を受け付けてよいか」を、公開状態と受付期間だけで判定する。
 *
 * 定員は含めない。定員の判定は件数の問い合わせ（DB）を伴い、
 * 場面によって「一覧のために一括で数えた値」と「決済直前に数え直した値」の
 * どちらを使うかが変わるため、ここでは分けてある。
 *
 * 表示（一覧）とサーバー側の再確認（submitApplication / startCheckout /
 * 確認画面）で同じ関数を使う。片方だけ条件が抜けると、押せてしまう導線や
 * 逆に選べない表示が生まれるため。
 *
 * 受付期間の値が日時として読めない場合は false（受け付けない側）に倒す。
 *
 * @param {{ is_published?: boolean, apply_start_at?: string, apply_end_at?: string } | null} event
 * @param {Date} now
 * @returns {boolean}
 */
export function isEventAcceptingNow(event, now) {
  if (event === null || event === undefined) {
    return false;
  }

  if (event.is_published !== true) {
    return false;
  }

  const nowMs = now.getTime();
  const applyStart = Date.parse(event.apply_start_at);
  const applyEnd = Date.parse(event.apply_end_at);

  return Number.isFinite(applyStart) && Number.isFinite(applyEnd)
    && nowMs >= applyStart && nowMs <= applyEnd;
}

/*
 * 1件分の表示情報を作る。
 *
 * accepting は「今このリンクを押して申し込めるか」。受付期間内で、
 * 満席でなく、公開されていることの3つが揃ったときだけ true にする。
 * 最終的な可否はサーバー側（submitApplication）で作り直して確かめるため、
 * ここでの判定は表示のためのもの。
 */
function buildItem(event, paidCounts, now) {
  const startAt = new Date(event.event_date).toISOString();
  const endAt = event.event_end_at ? new Date(event.event_end_at).toISOString() : null;

  const paidCount = paidCounts?.[event.id] ?? 0;
  const soldOut = isSoldOut({ capacity: event.capacity, paidCount });

  return {
    id: event.id,
    startAt,
    endAt,
    label: formatEventDateTime(new Date(startAt), endAt ? new Date(endAt) : null),
    accepting: isEventAcceptingNow(event, now) && !soldOut,
    soldOut,
  };
}

/**
 * 開催日一覧の応答を組み立てる。
 *
 * 過去回（開催開始が現在より前）は落とす。開催中の回も落ちるが、
 * 当日の開始時刻で受付が終わる運用なので、載せても申し込めない。
 *
 * @param {{
 *   events: object[],
 *   paidCounts?: Record<string, number>,
 *   now: Date,
 * }} input
 * @returns {{
 *   events: { id: string, startAt: string, endAt: string | null,
 *             label: string, accepting: boolean, soldOut: boolean }[],
 *   syncedAt: string | null,
 * }}
 */
export function buildSchedulePayload({ events, paidCounts = {}, now }) {
  const nowMs = now.getTime();
  const rows = events ?? [];

  const items = rows
    .filter((event) => Date.parse(event.event_date) >= nowMs)
    .map((event) => buildItem(event, paidCounts, now))
    .sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt));

  /*
   * 鮮度の目安として、いちばん新しい synced_at を返す。
   * カレンダー同期が止まっていることに気づけるようにするためで、
   * 表示の可否には使わない（同期が止まってもDBの内容で表示は続ける）。
   */
  const syncedAt = rows
    .map((event) => event.synced_at)
    .filter((value) => typeof value === 'string' && Number.isFinite(Date.parse(value)))
    /* 文字列の大小ではなく時刻で比べる（表記が揃っている保証はないため）。 */
    .sort((a, b) => Date.parse(a) - Date.parse(b))
    .at(-1) ?? null;

  return { events: items, syncedAt };
}

/**
 * 申込ページで見せる回を返す。
 *
 * 満席の回も落とさずに含める。一覧から消すと「その日は無かった」ように
 * 見えてしまい、満席なのか未設定なのか区別できないため。呼び出し側は
 * soldOut の回を選択不可（disabled）にして表示する。
 *
 * @param {{ events: object[], paidCounts?: Record<string, number>, now: Date }} input
 */
export function resolveSelectableEvents({ events, paidCounts = {}, now }) {
  return buildSchedulePayload({ events, paidCounts, now })
    .events
    .filter((item) => item.accepting || item.soldOut);
}

/*
 * 定員の判定。
 *
 * ==================================================================
 * 方針
 * ==================================================================
 *   - 数えるのは「支払済み（applications.status = 'paid'）」だけ。
 *     決済待ち（awaiting）は席として扱わない。非同期決済（PayPay など）が
 *     確定するまでの間に定員を超えることは許容し、管理画面の警告で
 *     気づいて手動返金する運用にする。
 *   - 返金すると status が 'refunded' に変わるため、件数から自動的に外れる。
 *     席を空ける専用の処理は要らない。
 *   - 譲渡・特別価格は区別しない。席は席として1つ数える。
 *   - capacity が null のイベントは「定員なし」。従来どおり止めない。
 *   - 判定そのものは純粋な関数にしておき、DBアクセスと切り離す。
 * ==================================================================
 */

import { countPaidApplications } from './db.mjs';

/** 満席のときに申込者へ見せる文言。表示箇所で文言がぶれないよう1か所に置く。 */
export const SOLD_OUT_MESSAGE = '定員に達したため、お申し込みの受付を終了しました。';

/**
 * 満席かどうか。
 *
 * 境界は「支払済み >= 定員」で満席。定員ちょうどの時点で締める。
 *
 * @param {{ capacity: number | null | undefined, paidCount: number }} input
 * @returns {boolean}
 */
export function isSoldOut({ capacity, paidCount }) {
  /* 定員なしのイベントは、何件入っていても止めない。 */
  if (capacity === null || capacity === undefined) {
    return false;
  }

  if (!Number.isInteger(capacity) || capacity <= 0) {
    /*
     * 0 や負数、小数が入っていたら設定ミス。ここで満席扱いにすると
     * 受付が丸ごと止まって原因も分かりにくいため、定員なしとして扱う。
     * 気づけるように管理画面側は resolveCapacityStatus で 'none' を返す。
     */
    return false;
  }

  return paidCount >= capacity;
}

/**
 * 管理画面に出す定員の状態。
 *
 * @param {{ capacity: number | null | undefined, paidCount: number }} input
 * @returns {{ state: 'none' | 'ok' | 'full' | 'over', capacity: number | null,
 *            paidCount: number, remaining: number | null, over: number }}
 */
export function resolveCapacityStatus({ capacity, paidCount }) {
  const hasCapacity =
    capacity !== null && capacity !== undefined
    && Number.isInteger(capacity) && capacity > 0;

  if (!hasCapacity) {
    return {
      state: 'none',
      capacity: null,
      paidCount,
      remaining: null,
      over: 0,
    };
  }

  const over = paidCount - capacity;

  return {
    /* over > 0 は返金対応が要る状態。ちょうど（over === 0）とは分けて出す。 */
    state: over > 0 ? 'over' : over === 0 ? 'full' : 'ok',
    capacity,
    paidCount,
    remaining: Math.max(0, capacity - paidCount),
    over: Math.max(0, over),
  };
}

/**
 * イベントが満席かどうかをDBを見て判定する。
 *
 * 定員なしのイベントでは件数を数えない（無駄な問い合わせを増やさない）。
 *
 * @param {import('./config.mjs').SupabaseConfig} config
 * @param {{ id: string, capacity: number | null }} event
 * @returns {Promise<boolean>}
 */
export async function isEventSoldOut(config, event) {
  if (event === null || event === undefined) {
    return false;
  }

  if (event.capacity === null || event.capacity === undefined) {
    return false;
  }

  const paidCount = await countPaidApplications(config, event.id);

  return isSoldOut({ capacity: event.capacity, paidCount });
}

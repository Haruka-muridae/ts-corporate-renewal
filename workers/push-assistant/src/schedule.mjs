/**
 * 「いつ・どの予定を・どこへ向けて通知するか」を決める（仕様書 §8-2）。純関数だけ。
 *
 * ==================================================================
 * 純関数にしてある理由
 * ==================================================================
 * 通知判定は、この MVP でいちばん間違えると痛いところである
 * （二重通知・通知漏れは利用者から見て致命的で、しかも再現しにくい）。
 * D1 も fetch も時計も触らない形にすれば、時刻と予定を並べた表で
 * 全パターンを試験できる（試験 B / C）。
 *
 * **`Date.now()` をここで呼ばない。** nowMs は必ず引数で受ける。
 * ==================================================================
 */

import { DUE_GRACE_MS, MAX_TITLE_LENGTH } from './constants.mjs';
import { resolveOpenUrl } from './open-url.mjs';

/**
 * 通知の予定表を作る。
 *
 * 戻り値の `due` は 3 通り。
 *   'due'    … いま送る（notify_at が過ぎており、遅れも許容範囲内）
 *   'future' … まだ先。行も作らない（**作らないことが二重通知防止の土台**。
 *              §8-4 のとおり、リスケ前の古い時刻で行を作ってしまうと、
 *              予定が動いたときに古い行と新しい行の両方が残る）
 *   'stale'  … 遅れすぎ。履歴に skipped として残すだけで送らない
 *
 * 終日予定と、開始時刻が読めない予定は対象外（配列に入れない）。
 */
export function planNotifications({ events, leadMinutes, nowMs, appUrl }) {
  const leads = normalizeLeads(leadMinutes);
  const plans = [];

  for (const event of events ?? []) {
    if (!event || event.allDay === true) {
      continue;
    }

    const startMs = Date.parse(event.start);

    if (!Number.isFinite(startMs)) {
      continue;
    }

    /* 開く URL は予定ごとに 1 回だけ決める（lead が複数でも行き先は同じ）。 */
    const opened = resolveOpenUrl(event, { appUrl });

    for (const lead of leads) {
      const notifyAtMs = startMs - lead * 60 * 1000;

      plans.push({
        eventId: event.id,
        eventStart: new Date(startMs).toISOString(),
        leadMinutes: lead,
        notifyAtMs,
        title: String(event.title ?? '').slice(0, MAX_TITLE_LENGTH),
        openUrl: opened.url,
        urlSource: opened.source,
        due: classify(notifyAtMs, nowMs),
      });
    }
  }

  return plans;
}

/**
 * いま送るべきか。
 *
 * 「開始時刻ちょうど」（lead=0）の予定も同じ式で扱える。開始から
 * DUE_GRACE_MS 以内なら due になり、Cron が数分遅れても通知が出る。
 */
function classify(notifyAtMs, nowMs) {
  if (notifyAtMs > nowMs) {
    return 'future';
  }

  return notifyAtMs >= nowMs - DUE_GRACE_MS ? 'due' : 'stale';
}

/**
 * 設定された lead を整える。
 *
 * 重複を落とし、数値でないものを捨て、大きい順（早く通知するものが先）に並べる。
 * 並べる理由は表示の一貫性だけで、判定には影響しない。
 */
function normalizeLeads(leadMinutes) {
  const seen = new Set();

  for (const value of Array.isArray(leadMinutes) ? leadMinutes : []) {
    const lead = Number(value);

    if (Number.isInteger(lead) && lead >= 0) {
      seen.add(lead);
    }
  }

  return Array.from(seen).sort((a, b) => b - a);
}

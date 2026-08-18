/*
 * lib/event/schedule.mjs の型定義。
 * ファイル名が .d.mts なのは、対象が .mjs だから。
 */

import type { EventRow } from "./db.mjs";

export type ScheduleItem = {
  id: string;
  /** ISO8601（UTC表記）。表示用の文字列は label を使う。 */
  startAt: string;
  endAt: string | null;
  /** 「2026年8月30日（日）14:30〜16:00」（Asia/Tokyo）。 */
  label: string;
  accepting: boolean;
  soldOut: boolean;
};

export type SchedulePayload = {
  events: ScheduleItem[];
  /** いちばん新しい synced_at。同期が止まっていることに気づくための目安。 */
  syncedAt: string | null;
};

/**
 * 公開状態と受付期間だけで「今受け付けてよいか」を判定する。
 * 定員は含まない（件数の問い合わせを伴うため呼び出し側で別に確かめる）。
 *
 * 一覧表示とサーバー側の再確認（申込・決済開始・確認画面）で共用する。
 */
export declare function isEventAcceptingNow(
  event: Pick<EventRow, "is_published" | "apply_start_at" | "apply_end_at"> | null,
  now: Date,
): boolean;

export declare function buildSchedulePayload(input: {
  events: EventRow[];
  /** イベントIDごとの支払済み件数。渡さない回は0件として扱う。 */
  paidCounts?: Record<string, number>;
  now: Date;
}): SchedulePayload;

export declare function resolveSelectableEvents(input: {
  events: EventRow[];
  paidCounts?: Record<string, number>;
  now: Date;
}): ScheduleItem[];

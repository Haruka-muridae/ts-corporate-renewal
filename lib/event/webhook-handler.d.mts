/*
 * lib/event/webhook-handler.mjs の型定義。
 * ファイル名が .d.mts なのは、対象が .mjs だから。
 */

import type { AttendeeNoteWriter } from "./calendar-note.mjs";
import type { StripeEvent } from "./webhook-signature.mjs";

export declare const HANDLED_EVENT_TYPES: readonly string[];

export type Mailer = {
  send: (message: {
    to: string;
    subject: string;
    text: string;
  }) => Promise<unknown>;
};

/**
 * 支払人数と名簿をカレンダーの説明欄へ書き戻す口
 * （`createAttendeeNoteWriter()` が作る。未設定の環境では null）。
 *
 * 書き戻しの失敗は handleStripeEvent の中で握りつぶされ、
 * result の文字列にだけ残る。
 */
export type CalendarNoteWriter = AttendeeNoteWriter;

export declare function handleStripeEvent(input: {
  event: StripeEvent;
  config: unknown;
  /** lib/event/db.mjs の名前空間、またはテスト用の差し替え。 */
  db: Record<string, (...args: never[]) => Promise<unknown>>;
  mailer: Mailer | null;
  calendarNote?: CalendarNoteWriter | null;
}): Promise<{ handled: boolean; duplicate: boolean; result: string }>;

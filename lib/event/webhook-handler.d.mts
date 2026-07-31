/*
 * lib/event/webhook-handler.mjs の型定義。
 * ファイル名が .d.mts なのは、対象が .mjs だから。
 */

import type { StripeEvent } from "./webhook-signature.mjs";

export declare const HANDLED_EVENT_TYPES: readonly string[];

export type Mailer = {
  send: (message: {
    to: string;
    subject: string;
    text: string;
  }) => Promise<unknown>;
};

export declare function handleStripeEvent(input: {
  event: StripeEvent;
  config: unknown;
  /** lib/event/db.mjs の名前空間、またはテスト用の差し替え。 */
  db: Record<string, (...args: never[]) => Promise<unknown>>;
  mailer: Mailer | null;
}): Promise<{ handled: boolean; duplicate: boolean; result: string }>;

/*
 * lib/event/capacity.mjs の型定義。
 * ファイル名が .d.mts なのは、対象が .mjs だから。
 */

import type { SupabaseConfig } from "./config.mjs";

export declare const SOLD_OUT_MESSAGE: string;

export declare function isSoldOut(input: {
  capacity: number | null | undefined;
  paidCount: number;
}): boolean;

export type CapacityStatus = {
  /* none = 定員なし、ok = 空きあり、full = ちょうど、over = 超過（要返金対応）。 */
  state: "none" | "ok" | "full" | "over";
  capacity: number | null;
  paidCount: number;
  remaining: number | null;
  over: number;
};

export declare function resolveCapacityStatus(input: {
  capacity: number | null | undefined;
  paidCount: number;
}): CapacityStatus;

export declare function isEventSoldOut(
  config: SupabaseConfig,
  event: { id: string; capacity: number | null } | null,
): Promise<boolean>;

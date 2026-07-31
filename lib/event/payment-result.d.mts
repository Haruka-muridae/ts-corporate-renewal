/*
 * lib/event/payment-result.mjs の型定義。
 * ファイル名が .d.mts なのは、対象が .mjs だから。
 */

export type ResultKind =
  | "paid"
  | "pending"
  | "failed"
  | "expired"
  | "refunded"
  | "unknown";

export type ResultState = {
  kind: ResultKind;
  receiptNumber: string | null;
  /** 支払済みで受付番号まで発行されているか。 */
  isConfirmed: boolean;
  /** もう一度決済へ進める案内を出してよいか。 */
  canRetry: boolean;
};

export declare const RESULT_KINDS: readonly ResultKind[];

export declare function resolveResultState(input: {
  application: { status: string; receipt_number: string | null } | null | undefined;
  payment: { payment_status: string } | null | undefined;
}): ResultState;

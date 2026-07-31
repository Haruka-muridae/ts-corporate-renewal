/*
 * lib/event/webhook-signature.mjs の型定義。
 * ファイル名が .d.mts なのは、対象が .mjs だから。
 */

export declare const DEFAULT_TOLERANCE_SECONDS: number;

export declare function parseSignatureHeader(header: string): {
  timestamp: number;
  signatures: string[];
};

export declare function verifyStripeSignature(input: {
  /** リクエストの生の本文。整形前の文字列を渡す。 */
  payload: string;
  header: string;
  secret: string;
  toleranceSeconds?: number;
  nowSeconds?: number;
}): true;

export type StripeEvent = {
  id: string;
  type: string;
  data?: { object?: Record<string, unknown> };
};

export declare function parseStripeEvent(payload: string): StripeEvent;

export declare function signPayload(
  payload: string,
  secret: string,
  timestamp: number,
): string;

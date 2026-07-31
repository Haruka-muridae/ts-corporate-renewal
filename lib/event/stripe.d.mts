/*
 * lib/event/stripe.mjs の型定義。
 * ファイル名が .d.mts なのは、対象が .mjs だから。
 */

export type CheckoutSessionInput = {
  eventName: string;
  /** サーバーが計算した支払額（円）。ブラウザから来た値は渡さない。 */
  amount: number;
  email: string;
  applicationId: string;
  eventId: string;
  successUrl: string;
  cancelUrl: string;
};

export declare const STATEMENT_DESCRIPTOR_SUFFIX: string;
export declare const STATEMENT_DESCRIPTOR_SUFFIX_KANJI: string;
export declare const STATEMENT_DESCRIPTOR_SUFFIX_KANA: string;

export declare function toFormEncoded(
  params: Record<string, unknown>,
  prefix?: string,
): string;

export declare function buildCheckoutSessionParams(
  input: CheckoutSessionInput,
): Record<string, unknown>;

export declare function createCheckoutSession(
  options: CheckoutSessionInput & {
    secretKey: string;
    idempotencyKey?: string;
    fetchImpl?: typeof fetch;
  },
): Promise<{ id: string; url: string }>;

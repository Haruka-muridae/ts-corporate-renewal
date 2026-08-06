/*
 * lib/event/db.mjs の型定義。
 * ファイル名が .d.mts なのは、対象が .mjs だから。
 *
 * 列名は PostgREST が返すそのまま（スネークケース）にしてある。
 * DBの列と1対1で対応させ、どこで名前が変わるかを分かりやすくするため。
 */

import type { ApplicationInput } from "./application-input.mjs";
import type {
  AgeGroupKey,
  IndustryKey,
  OccupationKey,
  PositionKey,
  PriceBreakdown,
} from "./pricing.mjs";
import type { SupabaseConfig } from "./config.mjs";

export type EventRow = {
  id: string;
  name: string;
  description: string | null;
  event_date: string;
  /* 終了時刻。設定されていないイベントもある。 */
  event_end_at: string | null;
  venue: string;
  capacity: number | null;
  base_price: number;
  min_price: number;
  apply_start_at: string;
  apply_end_at: string;
  is_published: boolean;
  cancel_policy_text: string;
  policy_version: string;
};

export type ApplicationStatus =
  | "received"
  | "awaiting"
  | "paid"
  | "failed"
  | "expired"
  | "refunded";

export type ApplicationRow = {
  id: string;
  event_id: string;
  receipt_number: string | null;
  name: string;
  name_kana: string;
  email: string;
  phone: string;
  company: string;
  department: string | null;
  job_title: string | null;
  /*
   * 属性の列は選択肢のいずれか。これらの列へは validateApplicationInput を
   * 通った値しか書き込まないため、読み出し側でも選択肢として扱える。
   * 万一ずれた値が入っていた場合は、calculatePrice が実行時に例外にする。
   */
  industry: IndustryKey;
  industry_other_text: string | null;
  occupation: OccupationKey;
  occupation_other_text: string | null;
  position: PositionKey;
  age_group: AgeGroupKey;
  is_banned_declared: boolean;
  status: ApplicationStatus;
  agreed_at: string;
  policy_version: string;
  is_transferred: boolean;
  transferred_at: string | null;
  original_name: string | null;
  original_email: string | null;
  admin_memo: string | null;
  created_at: string;
};

export type PaymentRow = {
  id: string;
  application_id: string;
  base_price: number;
  discount_industry: number;
  discount_occupation: number;
  discount_position: number;
  discount_age: number;
  discount_total: number;
  final_price: number;
  currency: string;
  stripe_checkout_session_id: string | null;
  stripe_payment_intent_id: string | null;
  payment_status: "pending" | "succeeded" | "failed" | "expired" | "refunded";
  paid_at: string | null;
  refunded_amount: number | null;
  refunded_at: string | null;
};

export declare function findPublishedEvent(
  config: SupabaseConfig,
): Promise<EventRow | null>;

/**
 * 支払済みの申込件数。定員判定に使う。
 * status='paid' のみを数える（awaiting は席として扱わない）。
 */
export declare function countPaidApplications(
  config: SupabaseConfig,
  eventId: string,
): Promise<number>;

export declare function findEventById(
  config: SupabaseConfig,
  eventId: string,
): Promise<EventRow | null>;

export declare function insertApplication(
  config: SupabaseConfig,
  application: ApplicationInput & {
    eventId: string;
    agreedAt: string;
    policyVersion: string;
  },
): Promise<ApplicationRow | null>;

export declare function findApplicationById(
  config: SupabaseConfig,
  applicationId: string,
): Promise<ApplicationRow | null>;

export declare function updateApplicationStatus(
  config: SupabaseConfig,
  applicationId: string,
  status: ApplicationStatus,
): Promise<ApplicationRow | null>;

export declare function insertPayment(
  config: SupabaseConfig,
  input: { applicationId: string; breakdown: PriceBreakdown },
): Promise<PaymentRow | null>;

export declare function findPaymentByApplicationId(
  config: SupabaseConfig,
  applicationId: string,
): Promise<PaymentRow | null>;

export declare function attachCheckoutSession(
  config: SupabaseConfig,
  paymentId: string,
  sessionId: string,
): Promise<PaymentRow | null>;

/* ------------------------------------------------------------------ */
/* Webhook 用 */

export type WebhookEventRow = {
  id: string;
  stripe_event_id: string;
  event_type: string;
  received_at: string;
  processed: boolean;
  result: string | null;
};

export declare function insertWebhookEvent(
  config: SupabaseConfig,
  input: { stripeEventId: string; eventType: string },
): Promise<{ row: WebhookEventRow | null; duplicate: boolean }>;

export declare function markWebhookProcessed(
  config: SupabaseConfig,
  stripeEventId: string,
  result: string,
): Promise<WebhookEventRow | null>;

export declare function findPaymentBySessionId(
  config: SupabaseConfig,
  sessionId: string,
): Promise<PaymentRow | null>;

export declare function findPaymentByPaymentIntentId(
  config: SupabaseConfig,
  paymentIntentId: string,
): Promise<PaymentRow | null>;

export declare function updatePayment(
  config: SupabaseConfig,
  paymentId: string,
  patch: Partial<PaymentRow>,
): Promise<PaymentRow | null>;

export declare function assignReceiptNumber(
  config: SupabaseConfig,
  applicationId: string,
): Promise<string | null>;

export declare function insertEmailLog(
  config: SupabaseConfig,
  input: { applicationId: string; mailType: string; status: string },
): Promise<{ id: string } | null>;

/* ------------------------------------------------------------------ */
/* 管理画面用 */

export declare function listApplications(
  config: SupabaseConfig,
  options?: { eventId?: string | null },
): Promise<(ApplicationRow & { payments: PaymentRow[] })[]>;

export declare function findApplicationWithPayment(
  config: SupabaseConfig,
  applicationId: string,
): Promise<(ApplicationRow & { payments: PaymentRow[] }) | null>;

export declare function updateApplicationFields(
  config: SupabaseConfig,
  applicationId: string,
  patch: Record<string, unknown>,
): Promise<ApplicationRow | null>;

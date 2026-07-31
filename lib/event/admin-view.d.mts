/*
 * lib/event/admin-view.mjs の型定義。
 * ファイル名が .d.mts なのは、対象が .mjs だから。
 */

import type { ApplicationRow, PaymentRow } from "./db.mjs";

export type ApplicationWithPayment = ApplicationRow & {
  payments?: PaymentRow[] | PaymentRow | null;
};

export type AdminRow = {
  id: string;
  receiptNumber: string;
  name: string;
  nameKana: string;
  email: string;
  phone: string;
  company: string;
  department: string;
  jobTitle: string;
  industry: string;
  occupation: string;
  position: string;
  ageGroup: string;
  bannedDeclared: string;
  discountIndustry: number | string;
  discountOccupation: number | string;
  discountPosition: number | string;
  discountAge: number | string;
  discountTotal: number | string;
  finalPrice: number | string;
  status: string;
  statusKey: string;
  appliedAt: string;
  paidAt: string;
  transferred: string;
};

export declare const STATUS_LABELS: Record<string, string>;

export declare function formatDateTime(value: string | null | undefined): string;

export declare function paymentOf(
  application: ApplicationWithPayment,
): PaymentRow | null;

export declare function toAdminRow(application: ApplicationWithPayment): AdminRow;

export declare const APPLICATION_CSV_COLUMNS: { header: string; key: string }[];
export declare const NAMETAG_CSV_COLUMNS: { header: string; key: string }[];

export declare function nametagRows(
  applications: ApplicationWithPayment[],
): Record<string, string>[];

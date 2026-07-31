/*
 * lib/event/mail/confirmation.mjs の型定義。
 * ファイル名が .d.mts なのは、対象が .mjs だから。
 */

import type {
  AgeGroupKey,
  IndustryKey,
  OccupationKey,
  PositionKey,
  PriceBreakdown,
} from "../pricing.mjs";

export type ConfirmationMailInput = {
  event: {
    name: string;
    startAt: Date | string | number;
    endAt?: Date | string | number | null;
    venue: string;
  };
  application: {
    name: string;
    receiptNumber: string;
    industry: IndustryKey;
    occupation: OccupationKey;
    position: PositionKey;
    ageGroup: AgeGroupKey;
  };
  payment: PriceBreakdown;
};

export declare const CONTACT_EMAIL: string;

export declare function formatEventDateTime(
  startAt: Date,
  endAt?: Date | null,
): string;

export declare function formatYen(amount: number): string;

export declare function buildConfirmationMail(
  input: ConfirmationMailInput,
): { subject: string; text: string };

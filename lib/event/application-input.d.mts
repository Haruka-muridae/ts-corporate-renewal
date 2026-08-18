/*
 * lib/event/application-input.mjs の型定義。
 * ファイル名が .d.mts なのは、対象が .mjs だから。
 */

import type {
  AgeGroupKey,
  IndustryKey,
  OccupationKey,
  PositionKey,
} from "./pricing.mjs";

/** 検証を通ったあとの、DBへ保存できる形。 */
export type ApplicationInput = {
  /** 選択された開催回（events.id）。形式（UUID）だけを検証済み。 */
  eventId: string;
  name: string;
  nameKana: string;
  email: string;
  phone: string;
  company: string;
  department: string | null;
  jobTitle: string | null;
  industry: IndustryKey;
  industryOtherText: string | null;
  occupation: OccupationKey;
  occupationOtherText: string | null;
  position: PositionKey;
  ageGroup: AgeGroupKey;
  isBannedDeclared: boolean;
};

export type ValidationResult =
  | { ok: true; errors: Record<string, never>; value: ApplicationInput }
  | { ok: false; errors: Record<string, string>; value: null };

export declare const MAX_LENGTHS: Record<string, number>;

export declare const CONSENT_FIELDS: readonly string[];

export declare function toKatakana(value: string): string;

/**
 * UUIDの形式かどうか（形だけの検査）。
 * URL の ?eventId= を受け取る管理画面のCSVなど、フォーム以外でも使う。
 */
export declare function isUuid(value: unknown): boolean;

export declare function validateApplicationInput(
  raw: Record<string, unknown>,
): ValidationResult;

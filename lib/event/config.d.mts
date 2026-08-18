/*
 * lib/event/config.mjs の型定義。
 * ファイル名が .d.mts なのは、対象が .mjs だから。
 */

import type { GmailCredentials } from "./mail/gmail.mjs";

export type SupabaseConfig = {
  url: string;
  serviceRoleKey: string;
  fetchImpl?: typeof fetch;
};

export declare function supabaseConfig(): SupabaseConfig;

export type SupabaseAuthConfig = {
  url: string;
  anonKey: string;
  fetchImpl?: typeof fetch;
  nowSeconds?: number;
};

export declare function supabaseAuthConfig(): SupabaseAuthConfig;

export declare function stripeSecretKey(): string;

export declare function baseUrl(): string;

export declare function gmailConfig(): {
  credentials: GmailCredentials;
  from: string;
};

/*
 * カレンダー用の資格情報も、型としては GmailCredentials と同じ3点
 * （クライアントID・シークレット・リフレッシュトークン）。
 * getAccessToken を共用するため、型も同じものを指す。
 */
export type CalendarConfig = {
  calendarId: string;
  credentials: GmailCredentials;
};

export declare function calendarConfig(): CalendarConfig;

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

export declare function stripeSecretKey(): string;

export declare function baseUrl(): string;

export declare function gmailConfig(): {
  credentials: GmailCredentials;
  from: string;
};

/*
 * lib/card-mail/config.mjs の型定義。
 * ファイル名が .d.mts なのは、対象が .mjs だから。
 */

import type { GmailCredentials } from './gmail.mjs';

export declare function gmailConfig(): {
  credentials: GmailCredentials;
  from: string;
};

export declare function apiToken(): string;

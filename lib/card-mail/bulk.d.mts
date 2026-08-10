/*
 * lib/card-mail/bulk.mjs の型定義。
 * ファイル名が .d.mts なのは、対象が .mjs だから。
 */

import type { GmailCredentials } from './gmail.mjs';

export declare const MAX_RECIPIENTS_PER_REQUEST: number;
export declare const BCC_BATCH_SIZE: number;
export declare const MAX_SUBJECT_LENGTH: number;
export declare const MAX_BODY_LENGTH: number;

export declare function isValidEmail(value: unknown): boolean;

export declare function normalizeRecipients(rawRecipients: unknown[]): {
  recipients: string[];
  invalid: string[];
  duplicateCount: number;
};

export type SendRequest = {
  subject: string;
  text: string;
  replyTo: string | null;
  dryRun: boolean;
  recipients: string[];
  duplicateCount: number;
};

/** 検証に失敗すると TypeError。不正な宛先は invalidRecipients に載る。 */
export declare function parseSendRequest(body: unknown): SendRequest;

export declare function chunkRecipients(recipients: string[], size?: number): string[][];

export declare function extractBearerToken(header: unknown): string | null;

export declare function tokenEquals(candidate: unknown, expected: unknown): boolean;

export type BulkSendResult = {
  sentCount: number;
  batches: { recipientCount: number; messageId: string }[];
};

/** 途中失敗時の例外には sentCount（送信済み件数）が載る。 */
export declare function sendBulkMail(options: {
  subject: string;
  text: string;
  recipients: string[];
  replyTo?: string | null;
  from: string;
  credentials: GmailCredentials;
  batchSize?: number;
  fetchImpl?: typeof fetch;
}): Promise<BulkSendResult>;

/*
 * lib/event/mail/gmail.mjs の型定義。
 * ファイル名が .d.mts なのは、対象が .mjs だから。
 */

export type GmailCredentials = {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
};

export type MailMessage = {
  from: string;
  to: string;
  subject: string;
  text: string;
  replyTo?: string;
};

export type SendResult = {
  id: string;
  threadId: string;
};

export declare function toBase64Url(input: string): string;

export declare function encodeHeaderWord(value: string): string;

export declare function buildRawMessage(message: MailMessage): string;

export declare function getAccessToken(
  credentials: GmailCredentials & { fetchImpl?: typeof fetch },
): Promise<string>;

export declare function sendMail(
  options: MailMessage & {
    credentials: GmailCredentials;
    fetchImpl?: typeof fetch;
  },
): Promise<SendResult>;

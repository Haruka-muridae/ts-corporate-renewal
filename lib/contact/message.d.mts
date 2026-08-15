/*
 * message.mjs の型。実装を .mjs に置く理由と .d.mts にする理由は
 * CLAUDE.md「交流会申込アプリ」の項と同じ（テストランナーが Node で
 * 直接読むため実装は .mjs、tsconfig が allowJs: false のため型は手書き）。
 */

/** 問い合わせの通知先アドレス。 */
export declare const CONTACT_TO: string;

/** 検証・正規化済みの問い合わせ内容。 */
export interface ContactValue {
  company: string;
  name: string;
  email: string;
  aiPreference: string;
  services: string[];
  tasks: string;
  challenges: string;
  timing: string;
}

export type ContactValidation =
  | { ok: true; value: ContactValue }
  | { ok: false; errors: string[] };

export declare function validateContactInput(input: unknown): ContactValidation;

export declare function buildContactMail(value: ContactValue): {
  subject: string;
  text: string;
};

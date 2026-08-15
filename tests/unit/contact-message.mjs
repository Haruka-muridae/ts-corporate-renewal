/*
 * セキュアAIエージェント開発環境 LP の問い合わせ処理の検証。
 *
 * ==================================================================
 * 特に確かめること
 * ==================================================================
 *   - 必須項目（会社名・担当者名・メールアドレス）が欠けると通らないこと
 *   - メール本文へ改行や NUL を差し込んで行構造を崩せないこと
 *   - Reply-To に入るメールアドレスへ空白・改行を含められないこと
 *   - 本文に全項目が載り、任意項目の未記入が判別できること
 *   - 件名に利用者の入力が入らないこと
 *   - 組み立てた文面が gmail.mjs のヘッダー検証を通ること
 * ==================================================================
 */

import { check, section, finish, fatal } from '../../public/apps/tests/helpers/assert.mjs';

import {
  validateContactInput,
  buildContactMail,
  CONTACT_TO,
} from '../../lib/contact/message.mjs';

import { buildRawMessage } from '../../lib/event/mail/gmail.mjs';

/* すべての項目が埋まった問い合わせ。 */
const FULL_INPUT = {
  company: 'テスト株式会社',
  name: '山田 太郎',
  email: 'taro@example.com',
  aiPreference: 'Claude（Claude Code）',
  services: ['Gmail', 'Google Drive', 'GitHub'],
  tasks: '問い合わせメールの下書き。\n議事録の整理。',
  challenges: 'セキュリティが不安で進められない。',
  timing: '1〜3か月以内',
};

try {
  /* ---------------------------------------------------------------- */
  section('必須項目の検証');

  check('全項目が埋まっていれば通る', validateContactInput(FULL_INPUT).ok);

  check('必須3項目だけでも通る',
    validateContactInput({ company: 'A社', name: '佐藤', email: 'a@example.com' }).ok);

  check('会社名が無いと通らない',
    !validateContactInput({ ...FULL_INPUT, company: '' }).ok);

  check('会社名が空白だけでも通らない',
    !validateContactInput({ ...FULL_INPUT, company: '   ' }).ok);

  check('担当者名が無いと通らない',
    !validateContactInput({ ...FULL_INPUT, name: undefined }).ok);

  check('メールアドレスが無いと通らない',
    !validateContactInput({ ...FULL_INPUT, email: '' }).ok);

  check('本文がオブジェクトでないと通らない', !validateContactInput('text').ok);
  check('本文が null だと通らない', !validateContactInput(null).ok);
  check('本文が配列だと通らない', !validateContactInput([]).ok);

  /* ---------------------------------------------------------------- */
  section('メールアドレスの形式（Reply-To ヘッダーへ入る値）');

  check('@ が無いと通らない',
    !validateContactInput({ ...FULL_INPUT, email: 'example.com' }).ok);

  check('空白を含むと通らない',
    !validateContactInput({ ...FULL_INPUT, email: 'a b@example.com' }).ok);

  check('改行を含むと通らない（ヘッダーインジェクション）',
    !validateContactInput({ ...FULL_INPUT, email: 'a@example.com\r\nBcc: x@example.com' }).ok);

  check('ドメインにドットが無いと通らない',
    !validateContactInput({ ...FULL_INPUT, email: 'a@localhost' }).ok);

  /* ---------------------------------------------------------------- */
  section('長さの上限と不正な型');

  check('会社名201文字は通らない',
    !validateContactInput({ ...FULL_INPUT, company: 'あ'.repeat(201) }).ok);

  check('任意テキスト2001文字は通らない',
    !validateContactInput({ ...FULL_INPUT, tasks: 'a'.repeat(2001) }).ok);

  check('services が21件だと通らない',
    !validateContactInput({ ...FULL_INPUT, services: Array(21).fill('Gmail') }).ok);

  const badServices = validateContactInput({ ...FULL_INPUT, services: ['Gmail', 42, ''] });
  check('services の文字列でない要素と空要素は捨てる',
    badServices.ok && badServices.value.services.length === 1
      && badServices.value.services[0] === 'Gmail',
    JSON.stringify(badServices.ok ? badServices.value.services : badServices.errors));

  check('services が配列でなければ空扱いで通る',
    (() => {
      const r = validateContactInput({ ...FULL_INPUT, services: 'Gmail' });
      return r.ok && r.value.services.length === 0;
    })());

  /* ---------------------------------------------------------------- */
  section('入力の正規化（本文の行構造を守る）');

  const injected = validateContactInput({
    ...FULL_INPUT,
    company: 'A社\r\n偽の行: 差し込み',
    tasks: '1行目\n2行目\u0000',
  });

  check('1行項目の改行は空白になる',
    injected.ok && injected.value.company === 'A社  偽の行: 差し込み',
    injected.ok ? injected.value.company : '');

  check('複数行項目の改行は残り、NUL は消える',
    injected.ok && injected.value.tasks === '1行目\n2行目');

  /* ---------------------------------------------------------------- */
  section('通知メールの文面');

  const valid = validateContactInput(FULL_INPUT);
  const mail = buildContactMail(valid.value);

  check('会社名が載る', mail.text.includes('会社名: テスト株式会社'));
  check('担当者名が載る', mail.text.includes('担当者名: 山田 太郎'));
  check('メールアドレスが載る', mail.text.includes('メールアドレス: taro@example.com'));
  check('利用したいAIが載る', mail.text.includes('利用したいAI・AI Agent: Claude（Claude Code）'));
  check('接続したいサービスが並ぶ', mail.text.includes('Gmail / Google Drive / GitHub'));
  check('任せたい業務が載る', mail.text.includes('議事録の整理。'));
  check('現在の課題が載る', mail.text.includes('セキュリティが不安で進められない。'));
  check('導入希望時期が載る', mail.text.includes('導入希望時期: 1〜3か月以内'));

  check('件名に利用者の入力が入らない',
    !mail.subject.includes('テスト株式会社'), mail.subject);

  const minimal = buildContactMail(
    validateContactInput({ company: 'B社', name: '鈴木', email: 'b@example.com' }).value,
  );

  check('任意項目の未記入は（未記入）になる', minimal.text.includes('（未記入）'));
  check('サービス未選択は（未選択）になる', minimal.text.includes('接続したいサービス: （未選択）'));

  /* ---------------------------------------------------------------- */
  section('gmail.mjs との結合（ヘッダー検証を通ること）');

  let raw = null;
  let rawError = null;

  try {
    raw = buildRawMessage({
      from: 'TSアセットマネジメント合同会社 <architect@potenitas.com>',
      to: CONTACT_TO,
      subject: mail.subject,
      text: mail.text,
      replyTo: valid.value.email,
    });
  } catch (error) {
    rawError = error;
  }

  check('組み立てた文面がヘッダー検証を通る', rawError === null, rawError?.message);
  check('Reply-To が問い合わせ者になる',
    raw !== null && raw.includes('Reply-To: taro@example.com'));

  finish();
} catch (error) {
  fatal(error);
}

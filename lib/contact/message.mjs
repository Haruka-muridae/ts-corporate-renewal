/*
 * セキュアAIエージェント開発環境 LP（/secure-ai-agent/）の問い合わせ内容を
 * 検証し、通知メールの文面を組み立てる。
 *
 * ==================================================================
 * 方針
 * ==================================================================
 *   - 送信そのものは lib/event/mail/gmail.mjs を再利用する。gmail.mjs は
 *     資格情報を引数で受け取る汎用モジュールで、交流会アプリ固有の知識を
 *     持たないため、ここから使っても系をまたいだ結合にはならない
 *     （逆に、OAuth 送信処理を複製すると更新漏れの温床になる）。
 *   - このモジュールは純関数のみ。process.env も fetch も触らない。
 *     テストランナー（tests/run.mjs）から Node で直接読めるようにするため。
 *   - 検証に失敗しても、受け取った値そのものはエラーへ含めない。
 *     ログに利用者の入力が残るのを避けるため、項目名だけ返す。
 * ==================================================================
 */

/** 問い合わせの通知先。フッター等で公開している代表アドレスと同じ。 */
export const CONTACT_TO = 'architect@potenitas.com';

/* 入力欄ごとの上限。フォーム側の maxlength と揃えている。 */
const LIMITS = {
  company: 200,
  name: 100,
  email: 254,
  aiPreference: 100,
  timing: 100,
  tasks: 2000,
  challenges: 2000,
};

/* チェックボックス由来の配列。画面の選択肢は9個なので、これを超える入力は不正。 */
const MAX_SERVICES = 20;

/*
 * 1行の入力欄。改行と NUL を落とすのは、後段でメール本文の行構造を
 * 崩されないようにするため（ヘッダーへ入る値は email だけで、
 * そちらは形式検証で弾いている）。
 */
function singleLine(value) {
  if (typeof value !== 'string') {
    return '';
  }

  return value.replace(/[\r\n\u0000]/g, ' ').trim();
}

/* 複数行の入力欄。改行は残し、NUL だけ落とす。 */
function multiLine(value) {
  if (typeof value !== 'string') {
    return '';
  }

  return value.replace(/\u0000/g, '').trim();
}

/**
 * 問い合わせ入力を検証して正規化する。
 *
 * @param {unknown} input リクエスト本文（JSON.parse 済み）
 * @returns {{ ok: true, value: object } | { ok: false, errors: string[] }}
 */
export function validateContactInput(input) {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, errors: ['本文がオブジェクトではありません'] };
  }

  const raw = /** @type {Record<string, unknown>} */ (input);
  const errors = [];

  const value = {
    company: singleLine(raw.company),
    name: singleLine(raw.name),
    email: singleLine(raw.email),
    aiPreference: singleLine(raw.aiPreference),
    services: [],
    tasks: multiLine(raw.tasks),
    challenges: multiLine(raw.challenges),
    timing: singleLine(raw.timing),
  };

  if (value.company === '') {
    errors.push('会社名は必須です');
  }

  if (value.name === '') {
    errors.push('担当者名は必須です');
  }

  /*
   * メールアドレスは Reply-To ヘッダーへ入るため、空白類を含まない形だけ通す。
   * 厳密な RFC 検証はしない（正しさより「ヘッダーを壊せないこと」が目的）。
   */
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.email)) {
    errors.push('メールアドレスの形式が正しくありません');
  }

  for (const [field, limit] of Object.entries(LIMITS)) {
    if (value[field].length > limit) {
      errors.push(`${field} が長すぎます`);
    }
  }

  if (Array.isArray(raw.services)) {
    if (raw.services.length > MAX_SERVICES) {
      errors.push('services が多すぎます');
    } else {
      value.services = raw.services
        .map((item) => singleLine(item))
        .filter((item) => item !== '' && item.length <= 100);
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, value };
}

/* 任意項目の未記入を、本文で「空欄」と区別が付く形にする。 */
function orBlank(value) {
  return value === '' ? '（未記入）' : value;
}

/**
 * 通知メールの件名と本文を組み立てる。
 *
 * 件名へ利用者の入力を入れない。本文だけに載せることで、
 * 件名側の表示崩れや誤解を避ける（差出人は常に自社アドレスのため、
 * どの問い合わせかは本文で判別できれば足りる）。
 *
 * @param {import('./message.d.mts').ContactValue} value 検証済みの値
 * @returns {{ subject: string, text: string }}
 */
export function buildContactMail(value) {
  const lines = [
    'セキュアAIエージェント開発環境 LP（/secure-ai-agent/）から',
    '導入相談の問い合わせが届きました。',
    '',
    `会社名: ${value.company}`,
    `担当者名: ${value.name}`,
    `メールアドレス: ${value.email}`,
    '',
    `利用したいAI・AI Agent: ${orBlank(value.aiPreference)}`,
    `接続したいサービス: ${value.services.length > 0 ? value.services.join(' / ') : '（未選択）'}`,
    `導入希望時期: ${orBlank(value.timing)}`,
    '',
    'AIへ任せたい業務:',
    orBlank(value.tasks),
    '',
    '現在の課題:',
    orBlank(value.challenges),
    '',
    '---',
    'このメールに返信すると、問い合わせ者へ直接届きます（Reply-To 設定済み）。',
  ];

  return {
    subject: '【導入相談】セキュアAIエージェント開発環境LP',
    text: lines.join('\n'),
  };
}

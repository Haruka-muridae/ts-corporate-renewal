/*
 * 名刺メール配信APIの中核ロジック（宛先の検証・重複排除・分割・認証・送信計画）。
 *
 * ==================================================================
 * なぜ「宛先はリクエストで受け取る」のか
 * ==================================================================
 * 名刺データの正本は利用者自身のGoogleスプレッドシート「名刺管理」にあり、
 * アクセスできるのは利用者のブラウザが持つ drive.file トークンだけである
 * （meishi-ocr-requirements-v3.md §FR-02。トークンはメモリ上のみで
 * サーバーへ送らない）。したがってサーバーは台帳を直接読めない。
 * 台帳からメールアドレスを取り出すのは呼び出し側の責務とし、
 * このAPIは受け取った宛先の検証と送信だけを行う。
 *
 * ==================================================================
 * なぜ不正な宛先があると全体を止めるのか
 * ==================================================================
 * OCR由来のデータには読み取りミスが混ざりうる。混ざったまま
 * 「送れる分だけ送る」と、送られなかった宛先の存在に気づけない。
 * 不正な宛先を一覧で返して全体を400にし、直してから送り直させる。
 * 事前確認には dryRun を使う（1通も送らずに送信計画だけ返す）。
 * ==================================================================
 *
 * このファイルはHTTPを知らない。Request/Response の扱いはルートハンドラ
 * （app/api/card-mail/send/route.ts）に置き、ここは純粋な関数だけにして
 * Node のテストランナーから直接検証できるようにする。
 */

import { createHash, timingSafeEqual } from 'node:crypto';

import { sendMail } from './gmail.mjs';

/*
 * 1リクエストで受け付ける宛先数の上限。
 *
 * Gmail の送信上限（アカウント種別により1日あたり500〜2000宛先）を
 * 1回の操作で使い切らないための歯止め。超える場合は呼び出し側が
 * 日を分けて送る。
 */
export const MAX_RECIPIENTS_PER_REQUEST = 500;

/*
 * 1通あたりのBCC宛先数。
 *
 * 無償の Gmail アカウントは1通あたり100宛先までという制限があるため、
 * 余裕を持って90にしてある。件数を増やすより「確実に届く」ほうを取る。
 */
export const BCC_BATCH_SIZE = 90;

/* 件名・本文の上限。誤って巨大な本文を投げたときに早く気づくための歯止め。 */
export const MAX_SUBJECT_LENGTH = 250;
export const MAX_BODY_LENGTH = 100000;

/*
 * メールアドレスの妥当性検査。
 *
 * RFC 5322 を完全に検査することはしない（quoted-string 等まで許すと
 * ヘッダーインジェクションの検査が複雑になる）。名刺から取れる
 * 実在のアドレスで使われる形だけを通す。
 */
const EMAIL_PATTERN = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

export function isValidEmail(value) {
  if (typeof value !== 'string') {
    return false;
  }

  /* SMTPの実装上の上限。これより長いものは実在しないとみなす。 */
  if (value.length === 0 || value.length > 254) {
    return false;
  }

  return EMAIL_PATTERN.test(value);
}

/**
 * 宛先一覧を検証して、送信に使う形へ整える。
 *
 * 重複はアドレスの大文字小文字を無視して1つにまとめる（実在の
 * メールサーバーはほぼ大文字小文字を区別しないため）。送信には
 * 最初に現れた表記をそのまま使う。
 *
 * @param {unknown[]} rawRecipients
 * @returns {{ recipients: string[], invalid: string[], duplicateCount: number }}
 */
export function normalizeRecipients(rawRecipients) {
  const recipients = [];
  const invalid = [];
  const seen = new Set();
  let duplicateCount = 0;

  for (const raw of rawRecipients) {
    const value = typeof raw === 'string' ? raw.trim() : '';

    if (!isValidEmail(value)) {
      /* 何が弾かれたか呼び出し側で分かるよう、原形のまま返す。 */
      invalid.push(typeof raw === 'string' ? raw : String(raw));
      continue;
    }

    const key = value.toLowerCase();

    if (seen.has(key)) {
      duplicateCount += 1;
      continue;
    }

    seen.add(key);
    recipients.push(value);
  }

  return { recipients, invalid, duplicateCount };
}

/**
 * リクエスト本文を検証する。問題があれば TypeError（メッセージは利用者向け）。
 *
 * @param {unknown} body
 * @returns {{
 *   subject: string, text: string, replyTo: string | null, dryRun: boolean,
 *   recipients: string[], duplicateCount: number,
 * }}
 */
export function parseSendRequest(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new TypeError('リクエスト本文はJSONオブジェクトで送ってください');
  }

  const { subject, text, recipients, replyTo, dryRun } = /** @type {Record<string, unknown>} */ (body);

  if (typeof subject !== 'string' || subject.trim() === '') {
    throw new TypeError('件名（subject）がありません');
  }

  if (subject.length > MAX_SUBJECT_LENGTH) {
    throw new TypeError(`件名が長すぎます（${MAX_SUBJECT_LENGTH}文字まで）`);
  }

  if (typeof text !== 'string' || text.trim() === '') {
    throw new TypeError('本文（text）がありません');
  }

  if (text.length > MAX_BODY_LENGTH) {
    throw new TypeError(`本文が長すぎます（${MAX_BODY_LENGTH}文字まで）`);
  }

  if (!Array.isArray(recipients) || recipients.length === 0) {
    throw new TypeError('宛先（recipients）を1件以上の配列で送ってください');
  }

  if (recipients.length > MAX_RECIPIENTS_PER_REQUEST) {
    throw new TypeError(`宛先が多すぎます（1回あたり${MAX_RECIPIENTS_PER_REQUEST}件まで）`);
  }

  if (replyTo !== undefined && replyTo !== null && !isValidEmail(replyTo)) {
    throw new TypeError('返信先（replyTo）がメールアドレスの形式ではありません');
  }

  const normalized = normalizeRecipients(recipients);

  if (normalized.invalid.length > 0) {
    /*
     * どれが弾かれたかを呼び出し側へ返すため、例外に載せる。
     * ルートハンドラがここから応答を組み立てる。
     */
    const error = new TypeError('メールアドレスの形式ではない宛先が含まれています');
    /** @type {TypeError & { invalidRecipients?: string[] }} */ (error).invalidRecipients = normalized.invalid;
    throw error;
  }

  return {
    subject: subject.trim(),
    text,
    replyTo: typeof replyTo === 'string' ? replyTo : null,
    dryRun: dryRun === true,
    recipients: normalized.recipients,
    duplicateCount: normalized.duplicateCount,
  };
}

/** 宛先を1通ぶんずつに分割する。 */
export function chunkRecipients(recipients, size = BCC_BATCH_SIZE) {
  const chunks = [];

  for (let index = 0; index < recipients.length; index += size) {
    chunks.push(recipients.slice(index, index + size));
  }

  return chunks;
}

/*
 * Authorization ヘッダーから Bearer トークンを取り出す。
 * 形式が違うときは null（＝認証失敗として扱う）。
 */
export function extractBearerToken(header) {
  if (typeof header !== 'string') {
    return null;
  }

  const match = header.match(/^Bearer\s+(\S+)$/);

  return match ? match[1] : null;
}

/*
 * トークンの照合。
 *
 * 単純な === は一致した長さに応じて比較時間が変わり、総当たりの
 * 手掛かりになる。両方をSHA-256にしてから timingSafeEqual で比べる
 * （ハッシュにすると長さが揃うため、長さ違いの分岐も要らなくなる）。
 */
export function tokenEquals(candidate, expected) {
  if (typeof candidate !== 'string' || typeof expected !== 'string' || expected === '') {
    return false;
  }

  const a = createHash('sha256').update(candidate, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();

  return timingSafeEqual(a, b);
}

/**
 * 一斉送信を実行する。
 *
 * 1通ずつ直列に送る。並列にしないのは、失敗時に「どこまで送れたか」を
 * 確定させるためと、Gmail API のレート制限を無用に突かないため。
 *
 * 途中で失敗したら例外にし、送信済みの件数を例外に載せる。
 * **送ってしまったメールは取り消せない**ので、呼び出し側はこの件数を
 * 必ず利用者へ見せること。
 *
 * To は送信元自身にする。BCCだけのメールは受信側で迷惑メール判定を
 * 受けやすく、宛先（To）に他人のアドレスを晒すこともできないため。
 *
 * @param {{
 *   subject: string, text: string, recipients: string[], replyTo?: string | null,
 *   from: string,
 *   credentials: { clientId: string, clientSecret: string, refreshToken: string },
 *   batchSize?: number,
 *   fetchImpl?: typeof fetch,
 * }} options
 * @returns {Promise<{ sentCount: number, batches: { recipientCount: number, messageId: string }[] }>}
 */
export async function sendBulkMail({
  subject,
  text,
  recipients,
  replyTo = null,
  from,
  credentials,
  batchSize = BCC_BATCH_SIZE,
  fetchImpl = fetch,
}) {
  const chunks = chunkRecipients(recipients, batchSize);
  const batches = [];
  let sentCount = 0;

  for (const chunk of chunks) {
    try {
      const result = await sendMail({
        from,
        to: from,
        subject,
        text,
        bcc: chunk,
        ...(replyTo ? { replyTo } : {}),
        credentials,
        fetchImpl,
      });

      batches.push({ recipientCount: chunk.length, messageId: result.id });
      sentCount += chunk.length;
    } catch (cause) {
      /*
       * 残りの送信は打ち切る。同じ失敗を繰り返して部分送信を
       * 増やすより、原因を直してから残りだけ送り直すほうが安全。
       */
      const error = new Error(
        `一斉送信が途中で失敗しました（送信済み ${sentCount} 件 / 全 ${recipients.length} 件）`,
      );
      error.cause = cause;
      /** @type {Error & { sentCount?: number }} */ (error).sentCount = sentCount;
      throw error;
    }
  }

  return { sentCount, batches };
}

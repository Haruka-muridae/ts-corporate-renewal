/*
 * RFC 5322 メッセージの組み立てと、Gmail API での送信。
 *
 * ==================================================================
 * 方針
 * ==================================================================
 *   - 外部ライブラリを使わない。ブラウザ標準の TextEncoder と btoa だけで
 *     組み立てる（Node 22 にも両方あるため、テストはそのまま動く）。
 *   - 宛先は**すべて BCC**。To は付けない。受信者に他の宛先を見せない
 *     ためと、To を付けないことで「1通100宛先」という無償Gmailの上限に
 *     BCC 100件がちょうど収まるため（config.js の BCC_BATCH_SIZE）。
 *   - From も付けない。Gmail API が送信アカウント本人のアドレスを
 *     自動で入れる。こちらで書くと、本人のエイリアス設定と食い違った
 *     ときに差し戻される。
 *   - ヘッダーに改行を差し込めるとメールを乗っ取れる
 *     （ヘッダーインジェクション）。値に改行・空白があれば送信前に止める。
 * ==================================================================
 */

import { GMAIL_SEND_ENDPOINT, MAX_BODY_LENGTH, MAX_SUBJECT_LENGTH } from './config.js';
import { DriveError, DriveErrorCode, driveFetchJson } from './drive-api.js';

/* ---------- 文字列 → base64 ---------- */

/*
 * UTF-8 のバイト列にしてから base64 にする。
 *
 * btoa は Latin-1 の文字列しか受けないため、日本語をそのまま渡すと
 * 例外になる。バイト列を1文字ずつの束に変換してから渡す
 * （束にするのは、引数展開が長大な配列で失敗するのを避けるため）。
 */
export function base64FromUtf8(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';

  const CHUNK = 0x8000;

  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK));
  }

  return btoa(binary);
}

/** RFC 4648 の base64url。Gmail API の raw はこの形式で渡す。 */
export function toBase64Url(text) {
  return base64FromUtf8(text)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/* ---------- ヘッダーの組み立て ---------- */

/*
 * ヘッダーに改行を入れられると、任意のヘッダーや別の宛先を差し込まれる。
 * 改行だけでなく、制御文字全般・空白・カンマ・セミコロンも止める。
 *
 * カンマは Bcc の区切りそのものなので、1つの宛先に紛れ込むと宛先の
 * 水増しになる。アプリの経路では recipients.js の形式検査が先に弾くが、
 * ここは**最後の関門**として、呼び出し元に関わらず二重に守る
 * （将来、検証を経ない呼び出しが足されても通さないため）。
 */
function assertHeaderValue(value, label) {
  if (typeof value !== 'string' || value === '') {
    throw new TypeError(`${label}が空です`);
  }

  if (/[\x00-\x20\x7f,;]/.test(value)) {
    throw new TypeError(`${label}に使用できない文字（改行・空白・区切り記号）が含まれています`);
  }
}

/*
 * 非ASCIIを含む件名を RFC 2047 の encoded-word にする。
 *
 * encoded-word 1個は75文字までという上限があるため、元の文字列を分割して
 * 複数の encoded-word にする。マルチバイト文字の途中で切ると壊れるので、
 * 符号位置単位で詰めながらバイト数を見る。
 */
export function encodeHeaderWord(value) {
  /* ASCIIのみなら、そのままのほうが読みやすい。 */
  if (/^[\x20-\x7e]*$/.test(value)) {
    return value;
  }

  const prefix = '=?UTF-8?B?';
  const suffix = '?=';
  /* 75 は encoded-word 全体の上限。前後の記号を引いた分が本体に使える。 */
  const maxBase64 = 75 - prefix.length - suffix.length;
  /* base64 は3バイトが4文字になる。4の倍数に切り下げて使える生バイト数を出す。 */
  const maxBytes = Math.floor(maxBase64 / 4) * 3;

  const encoder = new TextEncoder();
  const words = [];
  let buffer = [];
  let bytes = 0;

  for (const char of value) {
    const size = encoder.encode(char).length;

    if (bytes + size > maxBytes) {
      words.push(`${prefix}${base64FromUtf8(buffer.join(''))}${suffix}`);
      buffer = [];
      bytes = 0;
    }

    buffer.push(char);
    bytes += size;
  }

  if (buffer.length > 0) {
    words.push(`${prefix}${base64FromUtf8(buffer.join(''))}${suffix}`);
  }

  /*
   * **CRLF+空白で折り返す（RFC 5322 の folding）。**
   * 空白1つで連結すると Subject が1行のまま伸び続け、日本語で約200文字を
   * 超えたあたりで1行998文字の上限を破る（送信そのものが400で失敗する）。
   * 隣接する encoded-word 間の折り返し空白は、受信側が復号時に無視する
   * （RFC 2047 §6.2）ので、件名の中身は変わらない。
   */
  return words.join('\r\n ');
}

/*
 * Bcc ヘッダーを組み立てる。
 *
 * RFC 5322 は1行998文字までと定めている。宛先が100件あると1行では
 * 収まらないため、**アドレスごとに折り返す**（継続行は空白で始める folding）。
 * 受信側・Gmail API はこれを1つのヘッダーとして扱う。
 */
export function buildBccHeader(addresses) {
  if (!Array.isArray(addresses) || addresses.length === 0) {
    throw new TypeError('BCC宛先がありません');
  }

  addresses.forEach((address, index) => {
    assertHeaderValue(address, `BCC宛先（${index + 1}件目）`);
  });

  return `Bcc: ${addresses.join(',\r\n ')}`;
}

/**
 * RFC 5322 のメッセージを組み立てる。
 *
 * 本文は base64 にする。日本語の本文をそのまま流すと、経路によっては
 * 行長の制限に触れて壊れることがあるため。
 *
 * @param {{ subject: string, text: string, bcc: string[] }} message
 * @returns {string}
 */
export function buildRawMessage({ subject, text, bcc }) {
  if (typeof subject !== 'string' || subject.trim() === '') {
    throw new TypeError('件名が空です');
  }

  if (subject.length > MAX_SUBJECT_LENGTH) {
    throw new TypeError(`件名が長すぎます（${MAX_SUBJECT_LENGTH}文字まで）`);
  }

  if (/[\r\n]/.test(subject)) {
    throw new TypeError('件名に改行を含めることはできません');
  }

  if (typeof text !== 'string' || text.trim() === '') {
    throw new TypeError('本文が空です');
  }

  if (text.length > MAX_BODY_LENGTH) {
    throw new TypeError(`本文が長すぎます（${MAX_BODY_LENGTH}文字まで）`);
  }

  const headers = [
    buildBccHeader(bcc),
    `Subject: ${encodeHeaderWord(subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
  ];

  /* base64 は76文字ごとに折る（RFC 2045）。 */
  const body = base64FromUtf8(text).replace(/(.{76})/g, '$1\r\n');

  return `${headers.join('\r\n')}\r\n\r\n${body}`;
}

/* ---------- 送信 ---------- */

/* 画面に出す言葉。Gmail の失敗も drive-api.js の分類をそのまま使う。 */
export function describeSendError(error) {
  const isKnown = error instanceof DriveError;
  const code = isKnown ? error.code : DriveErrorCode.UNKNOWN;
  const detail = isKnown ? String(error.detail ?? '') : String(error?.message ?? error);

  const described = (text, errorCode) => ({ text, errorCode, detail });

  switch (code) {
    case DriveErrorCode.UNAUTHORIZED:
      return described('Google連携の期限が切れました。連携し直してください。', 'OAUTH-002');
    case DriveErrorCode.FORBIDDEN:
      return described('メールの送信が許可されませんでした。送信の権限（gmail.send）を許可しているか、Gmailの送信上限に達していないかを確認してください。', 'MAIL-001');
    case DriveErrorCode.RATE_LIMITED:
      return described('Gmailの送信上限または利用制限に達しています。時間をおいて（多い場合は日を改めて）お試しください。', 'MAIL-001');
    case DriveErrorCode.SERVER_ERROR:
      return described('Google側で一時的なエラーが起きました。時間をおいてお試しください。', 'MAIL-001');
    case DriveErrorCode.BAD_REQUEST:
      return described('メールの組み立てが不正でした（アプリの問題です）。', 'MAIL-001');
    case DriveErrorCode.NETWORK:
      return described('通信に失敗しました。', 'MAIL-001');
    default:
      return described('メールの送信に失敗しました。', 'MAIL-001');
  }
}

/**
 * 1通送る（宛先はBCCの束）。
 *
 * @returns {Promise<{ id: string }>}
 */
export async function sendBatch({ subject, text, bcc, token, fetchImpl, signal }) {
  const raw = toBase64Url(buildRawMessage({ subject, text, bcc }));

  const result = await driveFetchJson(GMAIL_SEND_ENDPOINT, {
    token,
    fetchImpl,
    signal,
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify({ raw }),
  });

  return { id: String(result?.id ?? '') };
}

/**
 * 複数の束を**1通ずつ直列に**送る。
 *
 * 並列にしないのは、失敗時に「どこまで送れたか」を確定させるためと、
 * Gmail のレート制限を無用に突かないため。
 *
 * 途中で失敗したら例外にし、送信済みの件数・通数を例外に載せる。
 * **送ってしまったメールは取り消せない。** 呼び出し側はこの値を
 * 必ず利用者へ見せ、再開時は残りの束だけを渡すこと。
 *
 * @param {{
 *   subject: string, text: string, chunks: string[][],
 *   token: string, fetchImpl?: typeof fetch, signal?: AbortSignal,
 *   onProgress?: (done: number, total: number) => void,
 * }} options
 * @returns {Promise<{ sentCount: number, batchCount: number }>}
 */
export async function sendAllBatches({
  subject,
  text,
  chunks,
  token,
  fetchImpl,
  signal,
  onProgress,
}) {
  let sentCount = 0;
  let batchesDone = 0;

  /*
   * 進捗表示は装飾であって、送信の位置管理を巻き込ませない。
   * ここで例外を握りつぶさないと、表示側の不具合で「どこまで送れたか」
   * の情報（batchesDone）が付かない例外が飛び、再送の全件二重送信に
   * つながる。
   */
  const notifyProgress = (done) => {
    try {
      onProgress?.(done, chunks.length);
    } catch {
      /* 表示の失敗で送信計画を壊さない。 */
    }
  };

  for (const chunk of chunks) {
    notifyProgress(batchesDone);

    try {
      await sendBatch({ subject, text, bcc: chunk, token, fetchImpl, signal });
    } catch (cause) {
      const error = new Error('send_failed_midway');
      error.cause = cause;
      /* 再開のために必要な位置情報。 */
      error.sentCount = sentCount;
      error.batchesDone = batchesDone;
      throw error;
    }

    sentCount += chunk.length;
    batchesDone += 1;
  }

  notifyProgress(batchesDone);

  return { sentCount, batchCount: batchesDone };
}

/*
 * Gmail API でメールを送る（BCC対応版）。
 *
 * ==================================================================
 * 複製元
 * ==================================================================
 * lib/event/mail/gmail.mjs からの複製（2026-08-10）。**import はしない。**
 * 交流会アプリと名刺メール配信は独立した系であり、片方の都合で
 * もう片方を変えないため（CLAUDE.md）。
 *
 * 複製元から変えたところ:
 *   - **Bcc ヘッダーに対応した**（一斉送信で宛先を相互に見せないため）
 *   - Bcc が長くなるためヘッダーの折り返し（RFC 5322 の folding）を実装した
 * ==================================================================
 *
 * 方針（複製元と同じ）:
 *   - 外部ライブラリを足さない。Node の fetch と Buffer だけで完結させる。
 *   - 認証は送信元アカウント自身の OAuth リフレッシュトークンを使う。
 *   - 資格情報は引数で受け取る。このモジュールは process.env を直接読まない。
 *   - 例外にキーやトークンを含めない。ログに残ると漏れるため。
 */

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const SEND_ENDPOINT = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';

/*
 * ヘッダーに改行を入れられると、任意のヘッダーや別の宛先を差し込まれる
 * （メールヘッダーインジェクション）。値に制御文字があれば送信前に止める。
 */
function assertHeaderValue(value, label) {
  if (typeof value !== 'string' || value === '') {
    throw new TypeError(`${label}が空です`);
  }

  if (/[\r\n ]/.test(value)) {
    throw new TypeError(`${label}に改行を含めることはできません`);
  }
}

/** RFC 4648 の base64url。Gmail API の raw はこの形式で渡す。 */
export function toBase64Url(input) {
  return Buffer.from(input, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/*
 * 非ASCIIを含むヘッダーを RFC 2047 の encoded-word にする。
 *
 * encoded-word 1個は75文字までという上限があるため、元の文字列を分割して
 * 複数の encoded-word にする。マルチバイト文字の途中で切ると壊れるので、
 * 符号位置単位で詰めながら長さを見る。
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

  const words = [];
  let buffer = [];
  let bytes = 0;

  for (const char of value) {
    const size = Buffer.byteLength(char, 'utf8');

    if (bytes + size > maxBytes) {
      words.push(`${prefix}${Buffer.from(buffer.join(''), 'utf8').toString('base64')}${suffix}`);
      buffer = [];
      bytes = 0;
    }

    buffer.push(char);
    bytes += size;
  }

  if (buffer.length > 0) {
    words.push(`${prefix}${Buffer.from(buffer.join(''), 'utf8').toString('base64')}${suffix}`);
  }

  /* 折り返しは空白1つ。受信側が連結して元の文字列に戻す。 */
  return words.join(' ');
}

/*
 * Bcc ヘッダーを組み立てる。
 *
 * RFC 5322 は1行998文字までと定めている。宛先が数十件あると1行では
 * 収まらないため、**アドレスごとに折り返す**（継続行は空白で始める folding）。
 * 受信側・Gmail API はこれを1つのヘッダーとして扱う。
 */
export function buildBccHeader(addresses) {
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
 * @param {{ from: string, to: string, subject: string, text: string, replyTo?: string, bcc?: string[] }} message
 * @returns {string}
 */
export function buildRawMessage({ from, to, subject, text, replyTo, bcc }) {
  assertHeaderValue(from, '送信元');
  assertHeaderValue(to, '宛先');
  assertHeaderValue(subject, '件名');

  if (typeof text !== 'string' || text === '') {
    throw new TypeError('本文が空です');
  }

  if (replyTo !== undefined) {
    assertHeaderValue(replyTo, '返信先');
  }

  if (bcc !== undefined && !Array.isArray(bcc)) {
    throw new TypeError('BCC宛先は配列で渡してください');
  }

  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    bcc && bcc.length > 0 ? buildBccHeader(bcc) : null,
    replyTo ? `Reply-To: ${replyTo}` : null,
    `Subject: ${encodeHeaderWord(subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
  ].filter((line) => line !== null);

  /* base64 は76文字ごとに折る（RFC 2045）。 */
  const body = Buffer.from(text, 'utf8')
    .toString('base64')
    .replace(/(.{76})/g, '$1\r\n');

  return `${headers.join('\r\n')}\r\n\r\n${body}`;
}

/**
 * リフレッシュトークンからアクセストークンを取る。
 *
 * @param {{ clientId: string, clientSecret: string, refreshToken: string, fetchImpl?: typeof fetch }} credentials
 * @returns {Promise<string>}
 */
export async function getAccessToken({
  clientId,
  clientSecret,
  refreshToken,
  fetchImpl = fetch,
}) {
  if (!clientId || !clientSecret || !refreshToken) {
    throw new TypeError('Gmail送信の資格情報が設定されていません');
  }

  const response = await fetchImpl(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }).toString(),
  });

  if (!response.ok) {
    /*
     * 応答本文には資格情報が含まれうるため、状態コードだけを外に出す。
     * 詳細が必要なときはGoogle Cloud側のログで追う。
     */
    throw new Error(`アクセストークンを取得できませんでした（HTTP ${response.status}）`);
  }

  const payload = await response.json();

  if (!payload?.access_token) {
    throw new Error('アクセストークンが応答に含まれていません');
  }

  return payload.access_token;
}

/**
 * メールを1通送る。
 *
 * @param {{
 *   from: string, to: string, subject: string, text: string, replyTo?: string, bcc?: string[],
 *   credentials: { clientId: string, clientSecret: string, refreshToken: string },
 *   fetchImpl?: typeof fetch,
 * }} options
 * @returns {Promise<{ id: string, threadId: string }>}
 */
export async function sendMail({
  from,
  to,
  subject,
  text,
  replyTo,
  bcc,
  credentials,
  fetchImpl = fetch,
}) {
  const raw = toBase64Url(buildRawMessage({ from, to, subject, text, replyTo, bcc }));

  const accessToken = await getAccessToken({ ...credentials, fetchImpl });

  const response = await fetchImpl(SEND_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ raw }),
  });

  if (!response.ok) {
    throw new Error(`メールを送信できませんでした（HTTP ${response.status}）`);
  }

  const payload = await response.json();

  return { id: payload?.id ?? '', threadId: payload?.threadId ?? '' };
}

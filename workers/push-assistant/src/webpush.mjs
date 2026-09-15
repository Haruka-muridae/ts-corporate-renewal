/**
 * 標準 Web Push の送信（RFC 8030 / 8291 / 8292）を WebCrypto だけで。仕様書 §8-5。
 *
 * ==================================================================
 * 外部ライブラリ（web-push）を使わない
 * ==================================================================
 * web-push は Node の crypto に依存しており、Workers で動かすには
 * nodejs_compat が要る。notifier-gate は WebCrypto だけで VAPID を
 * 実装できているので、同じ判断をここへも適用した。
 * 必要なのは ECDH・HKDF（＝HMAC-SHA256）・AES-128-GCM の 3 つで、
 * すべて crypto.subtle にある。
 * ==================================================================
 *
 * ==================================================================
 * 本文を暗号化する（tickle 方式を採らない）
 * ==================================================================
 * 「本文なしで通知し、端末が取りに来る」方式（notifier V2）は、
 * Apps Script に暗号化手段が無かったための次善策だった。
 * Workers では RFC 8291 をそのまま実装できる。往復が無いぶん速く、
 * **端末が圏外から復帰した時点でも通知の中身（開く URL）が揃っている**。
 * これは「タップ 1 回で URL が開く」という要件そのものに効く。
 * ==================================================================
 *
 * ------------------------------------------------------------------
 * aes128gcm の本文の並び（RFC 8188 §2.1）
 * ------------------------------------------------------------------
 *   salt        16 バイト
 *   rs           4 バイト（ビッグエンディアン。ここでは 4096）
 *   idlen        1 バイト（= 65）
 *   keyid       65 バイト（送信側の一時公開鍵。非圧縮の EC 点）
 *   ciphertext  可変（平文 + 0x02 を AES-128-GCM したもの）
 *
 * レコードは 1 つだけ。平文は 4KB 弱しか入らず、分割する意味が無い。
 * 末尾の 0x02 は「最後のレコード」の印（0x01 は続きがある印）。
 * ------------------------------------------------------------------
 */

import { PUSH_TTL_SEC, VAPID_JWT_TTL_MS } from './constants.mjs';
import { base64ToBytes, utf8Bytes } from './crypto-util.mjs';
import { normalizeBase64Url, signJwt } from './vapid.mjs';

/** レコードサイズ。RFC 8291 が推奨する 4096。 */
const RECORD_SIZE = 4096;

/** AES-GCM の認証タグ（16 バイト）と、末尾の区切り 1 バイト。 */
const TAG_BYTES = 16;
const DELIMITER_BYTES = 1;

/**
 * aes128gcm のヘッダ長。salt(16) + rs(4) + idlen(1) + keyid(65)。
 * **本文全体（ヘッダ込み）が push サービスの上限 4096 に収まる必要がある**ため、
 * 平文の上限を出すときにこれを差し引く。
 */
const HEADER_BYTES = 16 + 4 + 1 + 65;

/**
 * 平文に使える上限（3993 バイト）。
 *
 * 以前は RECORD_SIZE から認証タグと区切りだけを引いていたが、
 * **それでは本文がヘッダの 86 バイトぶん 4096 を超える。**
 * push サービスは 413 を返し、しかも「送信は試みたが必ず失敗する」形になる。
 */
export const MAX_PLAINTEXT_BYTES = RECORD_SIZE - HEADER_BYTES - TAG_BYTES - DELIMITER_BYTES;

/** 非圧縮の P-256 公開鍵の長さ。 */
const PUBLIC_KEY_BYTES = 65;

const ECDH_ALGORITHM = { name: 'ECDH', namedCurve: 'P-256' };

/** バイト列を連結する。 */
function concatBytes(parts) {
  let length = 0;

  for (const part of parts) {
    length += part.length;
  }

  const out = new Uint8Array(length);
  let offset = 0;

  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }

  return out;
}

/** HMAC-SHA256。HKDF の Extract も Expand もこれ 1 つで書ける。 */
async function hmacSha256(keyBytes, dataBytes) {
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  return new Uint8Array(await crypto.subtle.sign('HMAC', key, dataBytes));
}

/**
 * HKDF（RFC 5869）の Extract + Expand を 1 回ぶんだけ。
 *
 * 出力は必ず 32 バイト以下なので、Expand の繰り返し（T(1), T(2), …）は要らない。
 * ライブラリの HKDF を使わないのは、crypto.subtle.deriveBits の HKDF が
 * info と salt の扱いで取り違えやすく、**RFC 8291 の擬似コードと 1 対 1 に
 * 対応する形**で書いたほうが読み合わせできるため。
 */
async function hkdf(salt, ikm, info, lengthBytes) {
  const prk = await hmacSha256(salt, ikm);
  const okm = await hmacSha256(prk, concatBytes([info, Uint8Array.of(0x01)]));

  return okm.slice(0, lengthBytes);
}

/** `Content-Encoding: <name>` + 0x00 という形の info を作る。 */
function contentEncodingInfo(name) {
  return concatBytes([utf8Bytes(`Content-Encoding: ${name}`), Uint8Array.of(0x00)]);
}

/**
 * ペイロードを RFC 8291 の aes128gcm で暗号化する。
 *
 * salt と一時鍵は既定で乱数。テストが往復（暗号化 → 復号）を確かめるときに
 * 固定したい場合のために差し替え口を開けてある。**本番では渡さない。**
 *
 * @param {{ p256dh: string, auth: string, plaintext: string|Uint8Array,
 *           salt?: Uint8Array, serverKeys?: { privateKey: CryptoKey, publicKeyBytes: Uint8Array } }} input
 * @returns {Promise<{ body: Uint8Array }>}
 */
export async function encryptPayload({ p256dh, auth, plaintext, salt, serverKeys }) {
  const uaPublicBytes = base64ToBytes(normalizeBase64Url(p256dh));
  const authSecret = base64ToBytes(normalizeBase64Url(auth));

  if (uaPublicBytes.length !== PUBLIC_KEY_BYTES) {
    throw new Error(`購読の p256dh が ${uaPublicBytes.length} バイトです（65 バイトである必要があります）。`);
  }

  if (authSecret.length < 16) {
    throw new Error(`購読の auth が ${authSecret.length} バイトです（16 バイト以上である必要があります）。`);
  }

  const plainBytes = typeof plaintext === 'string' ? utf8Bytes(plaintext) : plaintext;

  if (plainBytes.length > MAX_PLAINTEXT_BYTES) {
    /* 中身は出さない。長さだけ。 */
    throw new Error(`通知の本文が ${plainBytes.length} バイトあり、上限 ${MAX_PLAINTEXT_BYTES} を超えています。`);
  }

  const uaPublicKey = await crypto.subtle.importKey('raw', uaPublicBytes, ECDH_ALGORITHM, false, []);

  const server = serverKeys ?? await generateServerKeys();
  const asPublicBytes = server.publicKeyBytes;

  /* ECDH。deriveBits は共有点の X 座標（32 バイト）をそのまま返す。 */
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: uaPublicKey }, server.privateKey, 256),
  );

  /*
   * RFC 8291 §3.4。
   *
   * ここで **auth_secret を salt に、ECDH の結果を IKM に**して 1 回、
   * さらに **本文の salt でもう 1 回**という二段になっているのが要点。
   * 一段目は「この購読の持ち主だけが導ける鍵」を作り、二段目は
   * 「このメッセージ固有の鍵」を作る。片方だけでは replay に弱い。
   */
  const keyInfo = concatBytes([
    utf8Bytes('WebPush: info'),
    Uint8Array.of(0x00),
    uaPublicBytes,
    asPublicBytes,
  ]);

  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);

  const messageSalt = salt ?? randomBytes(16);

  const cek = await hkdf(messageSalt, ikm, contentEncodingInfo('aes128gcm'), 16);
  const nonce = await hkdf(messageSalt, ikm, contentEncodingInfo('nonce'), 12);

  const aesKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);

  /* 単一レコードなので区切りは 0x02（= 最後のレコード）。 */
  const record = concatBytes([plainBytes, Uint8Array.of(0x02)]);

  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, tagLength: TAG_BYTES * 8 }, aesKey, record),
  );

  const header = new Uint8Array(HEADER_BYTES);
  header.set(messageSalt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE, false);
  header[20] = PUBLIC_KEY_BYTES;
  header.set(asPublicBytes, 21);

  return { body: concatBytes([header, ciphertext]) };
}

/** 一時鍵ペアを 1 組。メッセージごとに作り捨てる（RFC 8291 の要求）。 */
async function generateServerKeys() {
  const pair = await crypto.subtle.generateKey(ECDH_ALGORITHM, true, ['deriveBits']);

  return {
    privateKey: pair.privateKey,
    publicKeyBytes: new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)),
  };
}

function randomBytes(length) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

/**
 * VAPID の Authorization ヘッダを作る（RFC 8292 §3、`vapid` スキーム）。
 *
 * **aud は送信先 endpoint の origin**（パスを含めない）。ここを間違えると
 * push サービスが 401 を返す。notifier-gate では利用者の GAS が aud を
 * 指定していたため許可ホストの検査が要ったが、こちらは自分で送るので
 * endpoint から機械的に決まる＝外から指定される余地が無い。
 */
export async function buildVapidAuthorization({
  endpoint,
  privateKey,
  publicKeyBase64Url,
  subject,
  nowMs,
  ttlMs = VAPID_JWT_TTL_MS,
}) {
  const audience = new URL(endpoint).origin;

  const jwt = await signJwt({ privateKey, audience, subject, nowMs, ttlMs });

  return `vapid t=${jwt}, k=${normalizeBase64Url(publicKeyBase64Url)}`;
}

/**
 * 1 つの購読へ送る。
 *
 * 戻り値で失敗の種類を伝える。**例外は投げない**（1 台の端末の失敗で
 * 他の端末への送信を止めないため。tick.mjs はこの戻り値で分岐する）。
 *
 *   gone      … 404/410。購読はもう存在しない。無効化して二度と送らない
 *   retryable … 429/5xx/通信断。相手の都合なので後で送り直す
 *   それ以外の 4xx … こちらの組み立てが悪い（400 は本文の形、
 *                   401/403 は VAPID）。送り直しても直らないので再試行しない
 */
export async function sendWebPush({
  subscription,
  payload,
  vapid,
  fetchImpl = fetch,
  ttlSec = PUSH_TTL_SEC,
  urgency = 'high',
  nowMs = Date.now(),
}) {
  const plaintext = typeof payload === 'string' ? payload : JSON.stringify(payload);

  let body;
  let authorization;

  try {
    ({ body } = await encryptPayload({
      p256dh: subscription.p256dh,
      auth: subscription.auth,
      plaintext,
    }));

    authorization = await buildVapidAuthorization({
      endpoint: subscription.endpoint,
      privateKey: vapid.privateKey,
      publicKeyBase64Url: vapid.publicKey,
      subject: vapid.subject,
      nowMs,
    });
  } catch (error) {
    /*
     * 組み立てに失敗した（購読の鍵が壊れている等）。再試行しても直らない。
     * name だけを返す。message には長さなどが入るがログの担当は呼び出し側。
     */
    return {
      ok: false,
      status: 0,
      retryable: false,
      gone: false,
      error: error instanceof Error ? error.name : 'Error',
    };
  }

  let response;

  try {
    response = await fetchImpl(subscription.endpoint, {
      method: 'POST',
      headers: {
        Authorization: authorization,
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: String(ttlSec),
        /* 時刻に間に合わせる通知なので、端末の省電力より優先させる。 */
        Urgency: urgency,
      },
      body,
    });
  } catch {
    return { ok: false, status: 0, retryable: true, gone: false, error: 'NETWORK' };
  }

  const status = response.status;

  if (status >= 200 && status < 300) {
    return { ok: true, status, retryable: false, gone: false, error: '' };
  }

  if (status === 404 || status === 410) {
    return { ok: false, status, retryable: false, gone: true, error: 'GONE' };
  }

  if (status === 429 || status >= 500) {
    return { ok: false, status, retryable: true, gone: false, error: 'TEMPORARY' };
  }

  return { ok: false, status, retryable: false, gone: false, error: 'REJECTED' };
}

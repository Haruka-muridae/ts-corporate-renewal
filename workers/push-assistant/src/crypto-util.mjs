/**
 * base64url と、D1 へ入れる値の暗号化（仕様書 §10）。
 *
 * ------------------------------------------------------------------
 * リフレッシュトークンを平文で置かない
 * ------------------------------------------------------------------
 * D1 の中身は Cloudflare のダッシュボードや `wrangler d1 execute` から
 * そのまま読める。リフレッシュトークンは**期限が無い**（同意が続く限り
 * 何度でもアクセストークンに換えられる）ので、行が 1 つ漏れることの
 * 代償が大きい。鍵は D1 の外（Workers Secrets）に置き、
 * 「DB を読めただけでは使えない」状態にする。
 *
 * 採らなかった案: KV に置く … 同じく読めるので解決にならない。
 * 採らなかった案: 暗号化しない … 上のとおり。
 * ------------------------------------------------------------------
 *
 * 形式は AES-256-GCM。IV は 12 バイト乱数で、`base64url(iv || ciphertext)`
 * の 1 本の文字列にする（IV を別カラムにすると、片方だけ移し替える
 * 事故が起きうる。1 つの値として扱えば取り違えようがない）。
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** AES-GCM の IV 長。GCM の推奨値であり、これ以外は使わない。 */
const IV_BYTES = 12;

/** TOKEN_ENCRYPTION_KEY の必要な長さ（AES-256）。 */
export const ENCRYPTION_KEY_BYTES = 32;

/** バイト列を base64url へ。 */
export function base64UrlEncode(bytes) {
  let binary = '';

  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }

  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** base64 / base64url のどちらでも受けてバイト列にする。 */
export function base64ToBytes(text) {
  const normalized = String(text).replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, '');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes;
}

/** 文字列を UTF-8 のバイト列へ。 */
export function utf8Bytes(text) {
  return encoder.encode(String(text));
}

/** 乱数を base64url で n バイトぶん。state と PKCE の code_verifier に使う。 */
export function randomBase64Url(byteLength) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

/** SHA-256 して base64url。PKCE の code_challenge（S256）はこの形。 */
export async function sha256Base64Url(text) {
  const digest = await crypto.subtle.digest('SHA-256', utf8Bytes(text));
  return base64UrlEncode(new Uint8Array(digest));
}

/**
 * 2 つのバイト列を、長さも中身も一定時間で比べる。
 *
 * 署名の検証で `===` を使うと、先頭から何文字一致したかが時間に出る。
 * セッション Cookie の偽造を 1 文字ずつ詰められては困るので、
 * 早期 return しない形にする。
 */
export function timingSafeEqual(a, b) {
  if (a.length !== b.length) {
    return false;
  }

  let diff = 0;

  for (let i = 0; i < a.length; i += 1) {
    diff |= a[i] ^ b[i];
  }

  return diff === 0;
}

/**
 * TOKEN_ENCRYPTION_KEY（base64 の 32 バイト）を CryptoKey にする。
 *
 * **失敗のメッセージに値を入れない。** 長さと形だけを言う。
 * そのままログへ出ても鍵が漏れないようにするため（notifier-gate/vapid.mjs と同じ方針）。
 */
export async function importEncryptionKey(secret) {
  const text = String(secret ?? '').trim();

  if (text === '') {
    throw new Error('TOKEN_ENCRYPTION_KEY が設定されていません。');
  }

  let bytes;

  try {
    bytes = base64ToBytes(text);
  } catch {
    throw new Error('TOKEN_ENCRYPTION_KEY を base64 として読めませんでした。');
  }

  if (bytes.length !== ENCRYPTION_KEY_BYTES) {
    throw new Error(
      `TOKEN_ENCRYPTION_KEY が ${bytes.length} バイトです。`
      + `${ENCRYPTION_KEY_BYTES} バイト（base64）である必要があります。`,
    );
  }

  return crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/** 文字列を暗号化して base64url(iv || ciphertext) にする。 */
export async function encryptString(key, plaintext) {
  const iv = new Uint8Array(IV_BYTES);
  crypto.getRandomValues(iv);

  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, utf8Bytes(plaintext)),
  );

  const joined = new Uint8Array(iv.length + ciphertext.length);
  joined.set(iv, 0);
  joined.set(ciphertext, iv.length);

  return base64UrlEncode(joined);
}

/**
 * encryptString の逆。改竄されていれば GCM の認証タグが合わずに例外になる。
 *
 * 例外のメッセージに暗号文を入れない（暗号文だけでは復号できないとはいえ、
 * ログに残す理由が無い）。
 */
export async function decryptString(key, encoded) {
  const joined = base64ToBytes(encoded);

  if (joined.length <= IV_BYTES) {
    throw new Error('暗号化された値が短すぎます。');
  }

  const iv = joined.slice(0, IV_BYTES);
  const ciphertext = joined.slice(IV_BYTES);

  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);

  return decoder.decode(plaintext);
}

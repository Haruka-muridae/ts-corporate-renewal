/**
 * VAPID の JWT 発行（ES256 / WebCrypto）。
 *
 * ==================================================================
 * jsrsasign を捨てられた理由
 * ==================================================================
 * V1 では署名を Apps Script 上で行っていたが、Apps Script に ES256 が無く、
 * jsrsasign（約500KB）を利用者に手で貼らせる工程が要った。これが
 * 「エディタを一度も開かせない」（V2 の目的2）の最大の障害だった。
 *
 * Workers には WebCrypto がある。crypto.subtle.sign の ECDSA/P-256 は
 * **r||s の生の64バイト**を返し、これは JWS の ES256 署名そのものである
 * （DER でラップされた形ではないので、変換が要らない）。
 * 外部ライブラリなしで済むのはこのため。
 * ==================================================================
 *
 * ==================================================================
 * 鍵はサービス全体で1ペア（利用者ごとではない）
 * ==================================================================
 * ブラウザの購読（PushSubscription）は applicationServerKey に紐づくため、
 * 鍵を差し替えると**全利用者の購読が無効になり、録音アプリでの取り直しが要る**。
 * ローテーション手順は workers/notifier-gate/README.md §4 に書いてある。
 * ==================================================================
 */

import { MAX_AUDIENCES, VAPID_JWT_TTL_MS } from './constants.mjs';

const encoder = new TextEncoder();

/** バイト列を base64url へ。JWS の各部はすべてこれで繋ぐ。 */
export function base64UrlEncode(bytes) {
  let binary = '';

  for (let i = 0; i < bytes.length; i++) {
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

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes;
}

/**
 * 秘密鍵をシークレットの文字列から読む。
 *
 * 受ける形を2つにしてあるのは、鍵の作り方を1つに縛らないため。
 *   - JWK（`{"kty":"EC",...}` の JSON）… 生成スクリプトが出す形
 *   - PKCS#8（PEM でも、ヘッダーを剥がした base64 でも可）… openssl が出す形
 *
 * どちらも `wrangler secret put VAPID_PRIVATE_KEY` にそのまま貼れる。
 */
const EC_ALGORITHM = { name: 'ECDSA', namedCurve: 'P-256' };

/* P-256 の PKCS#8 は 130〜160 バイト前後。桁が違えば貼り付け事故を疑う。 */
const MIN_PKCS8_BYTES = 60;

/**
 * 渡された文字列がどの形かを見分ける（値そのものは返さない）。
 *
 * **エラーへ中身を混ぜないために、形だけを名前で持つ。**
 * 実機で「/v1/vapid が 500」としか分からなかったとき、
 * 読めなかったのが形式のせいなのかを言えるようにしておく。
 */
export function describeKeyMaterial(secret) {
  const text = String(secret ?? '').trim();

  if (text === '') {
    return { kind: 'empty', length: 0 };
  }

  if (text.charAt(0) === '{') {
    return { kind: 'jwk', length: text.length };
  }

  if (text.indexOf('-----BEGIN') !== -1) {
    return { kind: 'pem', length: text.length };
  }

  if (/^[A-Za-z0-9+/=\-_\s]+$/.test(text)) {
    return { kind: /[-_]/.test(text) ? 'base64url' : 'base64', length: text.length };
  }

  return { kind: 'unknown', length: text.length };
}

/**
 * 秘密鍵をシークレットの文字列から読む。
 *
 * 失敗したときは**何が読めなかったのかを名前で言う。**
 * 値は絶対にメッセージへ入れない（そのままログへ出るため）。
 */
export async function importVapidPrivateKey(secret) {
  const text = String(secret ?? '').trim();
  const shape = describeKeyMaterial(text);

  if (shape.kind === 'empty') {
    throw new Error('VAPID_PRIVATE_KEY が設定されていません。');
  }

  if (shape.kind === 'unknown') {
    throw new Error(
      'VAPID_PRIVATE_KEY に base64 以外の文字が混ざっています'
      + `（長さ ${shape.length}）。見出し行ごと貼っていないか確認してください。`,
    );
  }

  if (shape.kind === 'jwk') {
    let jwk = null;

    try {
      jwk = JSON.parse(text);
    } catch {
      /* JSON.parse のメッセージには入力の断片が混ざる。**転記しない。** */
      throw new Error('VAPID_PRIVATE_KEY を JWK として読めませんでした。');
    }

    return crypto.subtle.importKey('jwk', jwk, EC_ALGORITHM, false, ['sign']);
  }

  let der = null;

  try {
    der = base64ToBytes(text.replace(/-----[^-]+-----/g, ''));
  } catch {
    throw new Error(`VAPID_PRIVATE_KEY を base64 として読めませんでした（形式 ${shape.kind}）。`);
  }

  if (der.length < MIN_PKCS8_BYTES) {
    throw new Error(
      `VAPID_PRIVATE_KEY が短すぎます（${der.length} バイト、形式 ${shape.kind}）。`
      + ' 途中で切れていないか確認してください。',
    );
  }

  try {
    return await crypto.subtle.importKey('pkcs8', der, EC_ALGORITHM, false, ['sign']);
  } catch (error) {
    /*
     * WebCrypto の例外は素っ気ないが、入力を含まないので転記してよい。
     * 「PKCS#8 ではない何かを渡した」ときにここへ来る。
     */
    throw new Error(
      `VAPID_PRIVATE_KEY を PKCS#8 として取り込めませんでした（形式 ${shape.kind}、`
      + `${der.length} バイト、${error instanceof Error ? error.name : 'Error'}）。`,
    );
  }
}

/**
 * 公開鍵を base64url へ寄せる。
 *
 * ブラウザの `applicationServerKey` は base64url でなければならない。
 * 素の base64（`+` `/` `=` を含む）で登録されていても値の意味は同じなので、
 * **拒否せずに直す。** 変種の取り違えは貼り付け事故として起きやすい。
 * どちらで登録されているかは check-vapid-keys.mjs が報告する。
 */
export function normalizeBase64Url(text) {
  return String(text ?? '').trim().replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * aud に使ってよい相手か。
 *
 * 形式（https の origin だけ・パス無し）とホストの両方を見る。
 * ホストを絞る理由は constants.mjs の DEFAULT_PUSH_HOSTS を参照。
 */
export function isAllowedAudience(audience, allowedHosts) {
  let url;

  try {
    url = new URL(String(audience));
  } catch {
    return false;
  }

  if (url.protocol !== 'https:') {
    return false;
  }

  /* origin 以外（パス・クエリ・ハッシュ）が付いていたら受け付けない。 */
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    return false;
  }

  const host = url.hostname.toLowerCase();

  return allowedHosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

/** aud の配列を正規化する。重複を落とし、上限を超えたら切る。 */
export function normalizeAudiences(audiences, allowedHosts) {
  if (!Array.isArray(audiences)) {
    return { ok: false, list: [], message: 'audiences は配列である必要があります。' };
  }

  const seen = new Set();

  for (const audience of audiences) {
    if (!isAllowedAudience(audience, allowedHosts)) {
      return { ok: false, list: [], message: '対応していない push サービスが指定されました。' };
    }

    seen.add(new URL(String(audience)).origin);
  }

  if (seen.size === 0) {
    return { ok: false, list: [], message: 'audiences が空です。' };
  }

  if (seen.size > MAX_AUDIENCES) {
    return { ok: false, list: [], message: 'audiences が多すぎます。' };
  }

  return { ok: true, list: Array.from(seen), message: '' };
}

/** JWS（コンパクト形式）を1本作る。 */
export async function signJwt({ privateKey, audience, subject, nowMs, ttlMs = VAPID_JWT_TTL_MS }) {
  const header = { typ: 'JWT', alg: 'ES256' };
  const claims = {
    aud: audience,
    exp: Math.floor((nowMs + ttlMs) / 1000),
    sub: subject,
  };

  const signingInput = `${base64UrlEncode(encoder.encode(JSON.stringify(header)))}`
    + `.${base64UrlEncode(encoder.encode(JSON.stringify(claims)))}`;

  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    encoder.encode(signingInput),
  );

  return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}

/**
 * aud ごとの JWT をまとめて発行する。
 *
 * 有効期限は全部同じにしてある。GAS 側は expiresAt を1つ覚えて
 * 期限が来たらまとめて取り直す（Script Properties の読み書きを減らすため）。
 */
export async function issueJwts({ privateKey, audiences, subject, nowMs, ttlMs = VAPID_JWT_TTL_MS }) {
  const jwts = {};

  for (const audience of audiences) {
    jwts[audience] = await signJwt({ privateKey, audience, subject, nowMs, ttlMs });
  }

  return { jwts, expiresAt: new Date(nowMs + ttlMs).toISOString() };
}

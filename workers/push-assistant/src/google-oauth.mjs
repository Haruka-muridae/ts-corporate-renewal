/**
 * Google の OAuth 2.0（Authorization Code + PKCE）。仕様書 §4。
 *
 * ==================================================================
 * 応答本文をエラーに転記しない
 * ==================================================================
 * トークンエンドポイントの応答には access_token / refresh_token / id_token が
 * そのまま入る。**失敗時でも body を読んで例外へ入れてはいけない**
 * （lib/event/mail/gmail.mjs の getAccessToken と同じ扱い）。
 * ここが返すのは HTTP ステータスと、Google が付ける短い `error` コード
 * （`invalid_grant` など）だけにしてある。error コードは値ではなく分類なので、
 * ログへ出しても漏れない。
 * ==================================================================
 *
 * fetch は差し替えられる形（fetchImpl）にしてある。テストは Google を
 * 呼ばずに応答を組み立てる（tests/unit/push-assistant.mjs）。
 */

import {
  GOOGLE_AUTH_ENDPOINT,
  GOOGLE_ISSUERS,
  GOOGLE_REVOKE_ENDPOINT,
  GOOGLE_TOKEN_ENDPOINT,
} from './constants.mjs';
import { base64ToBytes } from './crypto-util.mjs';

/**
 * 同意画面へ送る URL を組み立てる。
 *
 *   access_type=offline + prompt=consent … リフレッシュトークンを必ず受け取る。
 *     prompt を省くと、2 回目以降の接続で refresh_token が返らない
 *     （Google は「初回のみ」返す）。再接続で必ず取り直したいので毎回付ける
 *   code_challenge_method=S256 … PKCE。認可コードを横取りされても、
 *     code_verifier を知らなければ交換できない
 *   include_granted_scopes は付けない … 過去に別アプリで得た権限を
 *     引き連れてこないため（スコープ最小の方針。仕様書 §4-3）
 */
export function buildAuthUrl({ clientId, redirectUri, state, codeChallenge, scopes }) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: scopes.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });

  return `${GOOGLE_AUTH_ENDPOINT}?${params.toString()}`;
}

/** トークンエンドポイントを 1 回叩く。応答本文は呼び出し側へ返さない。 */
async function postToken(body, fetchImpl) {
  let response;

  try {
    response = await fetchImpl(GOOGLE_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
  } catch {
    /* 例外の中身（URL や本文の断片）は出さない。到達できなかった事実だけ。 */
    return { ok: false, status: 0, error: 'NETWORK' };
  }

  let payload = null;

  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    /* Google の `error` は分類語（invalid_grant / invalid_client …）。値ではない。 */
    const code = typeof payload?.error === 'string' ? payload.error : 'UNKNOWN';

    return { ok: false, status: response.status, error: code };
  }

  return { ok: true, status: response.status, payload: payload ?? {} };
}

/**
 * 認可コードをトークンへ交換する。
 *
 * 戻り値の tokens は**呼び出し側で暗号化してから保存する**こと。
 * ここでは保存もログ出力もしない。
 */
export async function exchangeCode({
  code,
  clientId,
  clientSecret,
  redirectUri,
  codeVerifier,
  fetchImpl = fetch,
}) {
  const result = await postToken(
    new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      code_verifier: codeVerifier,
    }),
    fetchImpl,
  );

  if (!result.ok) {
    return { ok: false, status: result.status, error: result.error };
  }

  const payload = result.payload;

  if (typeof payload.access_token !== 'string' || payload.access_token === '') {
    return { ok: false, status: result.status, error: 'NO_ACCESS_TOKEN' };
  }

  return {
    ok: true,
    tokens: {
      accessToken: payload.access_token,
      /* 2 回目以降の接続では返らないことがある。呼び出し側が既存の値を残す。 */
      refreshToken: typeof payload.refresh_token === 'string' ? payload.refresh_token : '',
      expiresInSec: Number.isFinite(payload.expires_in) ? Number(payload.expires_in) : 3600,
      scope: typeof payload.scope === 'string' ? payload.scope : '',
      idToken: typeof payload.id_token === 'string' ? payload.id_token : '',
    },
  };
}

/**
 * リフレッシュトークンをアクセストークンへ交換する。
 *
 * **`invalid_grant` だけは他と区別する。** これは「同意が取り消された／
 * 7 日で失効した（仕様書 §14）／トークンが無効」を意味し、
 * 何度やり直しても通らない。呼び出し側は google_tokens.invalid_at を立て、
 * 以後この利用者への tick を止める（再接続してもらうしかない）。
 * 5xx や通信断と同じ扱いにすると、毎分の Cron が延々と叩き続ける。
 */
export async function refreshAccessToken({
  refreshToken,
  clientId,
  clientSecret,
  fetchImpl = fetch,
}) {
  const result = await postToken(
    new URLSearchParams({
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'refresh_token',
    }),
    fetchImpl,
  );

  if (!result.ok) {
    return {
      ok: false,
      status: result.status,
      error: result.error,
      invalidGrant: result.error === 'invalid_grant',
    };
  }

  const payload = result.payload;

  if (typeof payload.access_token !== 'string' || payload.access_token === '') {
    return { ok: false, status: result.status, error: 'NO_ACCESS_TOKEN', invalidGrant: false };
  }

  return {
    ok: true,
    accessToken: payload.access_token,
    expiresInSec: Number.isFinite(payload.expires_in) ? Number(payload.expires_in) : 3600,
    scope: typeof payload.scope === 'string' ? payload.scope : '',
    /*
     * Google はリフレッシュトークンを**ローテーションすることがある**
     * （返ってきたら以後は新しいほうしか通らない）。返ってきたのに
     * 捨てると、古いトークンが失効した時点で invalid_grant になり、
     * 利用者は理由の分からない再接続を求められる。呼び出し側が保存する。
     */
    refreshToken: typeof payload.refresh_token === 'string' ? payload.refresh_token : '',
  };
}

/**
 * トークンを失効させる（接続解除）。
 *
 * **失敗しても呼び出し側は続行する。** ここで止めると、Google 側の不調で
 * 「解除できないアプリ」になってしまう。こちらの D1 から消えれば
 * 少なくともこのサービスは使えなくなり、Google 側は利用者が
 * アカウント設定から取り消せる。
 */
export async function revokeToken({ token, fetchImpl = fetch }) {
  try {
    const response = await fetchImpl(GOOGLE_REVOKE_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }).toString(),
    });

    return { ok: response.ok, status: response.status };
  } catch {
    return { ok: false, status: 0 };
  }
}

/**
 * id_token のクレームを読む（仕様書 §5）。
 *
 * ==================================================================
 * 署名を検証しない理由
 * ==================================================================
 * この id_token は**トークンエンドポイントから TLS で直接受け取ったもの**
 * であり、第三者から渡されたものではない。Google の公式ガイドも
 * 「サーバーが自分で交換した id_token は署名検証を省いてよい」としている
 * （検証が要るのはクライアントから送られてきた id_token を受け取る場合）。
 *
 * 署名検証には JWKS の取得とキャッシュが要る（毎回取ると外部依存が増え、
 * キャッシュすると鍵ローテーションの追随が要る）。得るものが無い。
 *
 * ただし **iss / aud / exp は見る。** 交換先を間違えている（別プロジェクトの
 * クライアント ID で発行された）ことに気づけるのはここだけであり、
 * 検査自体は文字列比較 3 回で済む。
 * ==================================================================
 */
export function parseIdToken(idToken, { clientId, nowMs }) {
  const parts = String(idToken ?? '').split('.');

  if (parts.length !== 3) {
    return { ok: false, reason: 'MALFORMED' };
  }

  let claims;

  try {
    claims = JSON.parse(new TextDecoder().decode(base64ToBytes(parts[1])));
  } catch {
    return { ok: false, reason: 'MALFORMED' };
  }

  if (!claims || typeof claims !== 'object') {
    return { ok: false, reason: 'MALFORMED' };
  }

  if (!GOOGLE_ISSUERS.includes(claims.iss)) {
    return { ok: false, reason: 'BAD_ISSUER' };
  }

  if (claims.aud !== clientId) {
    return { ok: false, reason: 'BAD_AUDIENCE' };
  }

  if (!Number.isFinite(claims.exp) || Number(claims.exp) * 1000 <= nowMs) {
    return { ok: false, reason: 'EXPIRED' };
  }

  if (typeof claims.sub !== 'string' || claims.sub === '') {
    return { ok: false, reason: 'NO_SUBJECT' };
  }

  return {
    ok: true,
    claims: {
      sub: claims.sub,
      email: typeof claims.email === 'string' ? claims.email : '',
      /*
       * Google は boolean で返すが、実装によっては文字列 "true" のこともある。
       * **既定は false**（不明なら「確認されていない」として扱う）。
       */
      emailVerified: claims.email_verified === true || claims.email_verified === 'true',
    },
  };
}

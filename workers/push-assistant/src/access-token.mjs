/**
 * 保存済みのリフレッシュトークンから、使えるアクセストークンを 1 本出す。
 *
 * ------------------------------------------------------------------
 * ここを独立させた理由（仕様書には無い補足）
 * ------------------------------------------------------------------
 * 同じ処理を tick.mjs（Cron）と api.mjs（GET /api/events）の両方が要る。
 * どちらかへ書いて他方から import すると、片方の都合の引数が混ざる。
 * 「トークンを 1 本出す」だけの層として切り出してある。
 *
 * **復号したトークンを戻り値以外のどこにも書かない。** ログにも
 * エラーメッセージにも出さない（仕様書 §10）。
 * ------------------------------------------------------------------
 */

import { ACCESS_TOKEN_REUSE_MARGIN_MS } from './constants.mjs';
import { decryptString, encryptString } from './crypto-util.mjs';
import { refreshAccessToken } from './google-oauth.mjs';

/**
 * アクセストークンを取り出す。
 *
 * 戻り値:
 *   { ok: true, accessToken }
 *   { ok: false, code: 'NOT_CONNECTED' }  … google_tokens に行が無い
 *   { ok: false, code: 'TOKEN_INVALID' }  … invalid_grant（再接続が要る。行に印を付けた）
 *   { ok: false, code: 'REFRESH_FAILED', status } … 一時的な失敗。次の tick で再挑戦
 *
 * ------------------------------------------------------------------
 * キャッシュを使う条件
 * ------------------------------------------------------------------
 * 毎分の Cron が毎回 refresh すると、利用者 20 人で 1 日 28,800 回
 * トークンエンドポイントを叩くことになる。Google の rate limit にも
 * D1 の書き込み上限（Free で 10 万行/日）にも無駄が大きい。
 * 残り 60 秒（ACCESS_TOKEN_REUSE_MARGIN_MS）以上あれば使い回す。
 *
 * 期限そのものではなく余裕を見るのは、**取得してから Calendar を叩くまでの
 * 間に切れる**のを防ぐため。
 * ------------------------------------------------------------------
 */
export async function ensureAccessToken({
  store,
  userId,
  clientId,
  clientSecret,
  encryptionKey,
  nowMs,
  nowIso,
  fetchImpl = fetch,
}) {
  const tokens = await store.getTokens(userId);

  if (!tokens) {
    return { ok: false, code: 'NOT_CONNECTED' };
  }

  if (tokens.invalidAt) {
    return { ok: false, code: 'TOKEN_INVALID' };
  }

  const expiresAtMs = Date.parse(tokens.accessTokenExpiresAt || '');

  if (
    tokens.accessTokenEnc
    && Number.isFinite(expiresAtMs)
    && expiresAtMs - nowMs > ACCESS_TOKEN_REUSE_MARGIN_MS
  ) {
    try {
      return { ok: true, accessToken: await decryptString(encryptionKey, tokens.accessTokenEnc) };
    } catch {
      /*
       * 復号できない＝鍵を差し替えた後の古い行。取り直せば直るので、
       * 例外にせず refresh へ落ちる（鍵ローテーションの逃げ道）。
       */
    }
  }

  let refreshToken;

  try {
    refreshToken = await decryptString(encryptionKey, tokens.refreshTokenEnc);
  } catch {
    /*
     * リフレッシュトークンが復号できないのは致命的（TOKEN_ENCRYPTION_KEY を
     * 差し替えた等）。再接続してもらうしかないので invalid にする。
     */
    await store.markTokenInvalid(userId, 'DECRYPT_FAILED', nowIso);
    return { ok: false, code: 'TOKEN_INVALID' };
  }

  const refreshed = await refreshAccessToken({ refreshToken, clientId, clientSecret, fetchImpl });

  if (!refreshed.ok) {
    if (refreshed.invalidGrant) {
      /* 何度やっても通らない。印を付けて以後の tick から外す（仕様書 §8-3）。 */
      await store.markTokenInvalid(userId, 'invalid_grant', nowIso);
      return { ok: false, code: 'TOKEN_INVALID' };
    }

    return { ok: false, code: 'REFRESH_FAILED', status: refreshed.status };
  }

  const expiresAt = new Date(nowMs + refreshed.expiresInSec * 1000).toISOString();

  await store.updateAccessToken(
    userId,
    {
      accessTokenEnc: await encryptString(encryptionKey, refreshed.accessToken),
      accessTokenExpiresAt: expiresAt,
      /*
       * Google がリフレッシュトークンを差し替えてきたら、そちらを保存する。
       * **捨てると、古いほうが失効した時点で invalid_grant になる**
       * （利用者からは「急に接続が切れた」に見える）。
       * 返ってこなかったときは undefined を渡し、store は既存値を残す。
       */
      refreshTokenEnc: refreshed.refreshToken
        ? await encryptString(encryptionKey, refreshed.refreshToken)
        : undefined,
    },
    nowIso,
  );

  return { ok: true, accessToken: refreshed.accessToken };
}

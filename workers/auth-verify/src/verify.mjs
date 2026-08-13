/*
 * セッション検証の本体。
 *
 * ==================================================================
 * この Worker は「判定」をしない
 * ==================================================================
 * 有効かどうかを決めるのは認証系 GAS（sessions シート）だけである。
 * ここがするのは「GAS が有効と答えた事実」を短時間だけ覚えることに尽きる。
 *
 * だから新しい秘密鍵も、アカウント状態や契約状態の判定ロジックの複製も
 * 要らない。再検証のたびに GAS の既存判定（accountStatus /
 * isSubscriptionUsable_）がそのまま通るため、判定が二重管理にならない。
 * ==================================================================
 *
 * ------------------------------------------------------------------
 * stale-while-revalidate は採らない
 * ------------------------------------------------------------------
 * 期限切れの記録を返しつつ裏で更新する形にすると、失効が反映される
 * までの最大時間が TTL ではなく grace（12 時間）になる。
 * 利用者が受け入れたのは「最大 30 分」であって 12 時間ではない。
 *
 * よって期限が切れたら**必ず GAS へ問い合わせてから返す**。
 * 古い記録を使うのは GAS へ届かないときだけ（grace）。
 * 体感は「30 分に一度だけ約 2 秒、あとは 0.1 秒」になる。
 * ------------------------------------------------------------------
 */

import {
  FRESH_MS,
  GAS_TIMEOUT_MS,
  GRACE_MS,
  MAX_TOKEN_LENGTH,
  NEGATIVE_MS,
} from './constants.mjs';

import { cacheKey, readRecord, tokenHash, writeRecord } from './cache.mjs';

/*
 * 結果の種類。
 *
 *   valid       … 通してよい
 *   invalid     … セッションが無効（GAS がそう答えた）
 *   unavailable … こちらの都合で判定できない
 *
 * **invalid と unavailable を混ぜないこと。**フロントは invalid を
 * 受け取るとトークンを消す。判定できないだけの状況で invalid を返すと、
 * 障害のたびに全利用者を強制ログアウトさせることになる。
 */
export const OUTCOME = Object.freeze({
  VALID: 'valid',
  INVALID: 'invalid',
  UNAVAILABLE: 'unavailable',
});

/* gas-auth の verifySessionToken_ と同じ足切り。ここで落ちれば GAS を叩かない。 */
export function isAcceptableToken(token) {
  return typeof token === 'string'
    && token.trim() !== ''
    && token.length <= MAX_TOKEN_LENGTH;
}

function parseIsoMs(value) {
  const ms = Date.parse(String(value ?? ''));

  return Number.isFinite(ms) ? ms : 0;
}

/*
 * 認証系 GAS へ照会する。
 *
 * 戻り値は { outcome, data }。例外は投げない。
 * GAS が HTML のエラーページを返すこと（実行時例外や権限エラー）が
 * あるため、**JSON として読めなかったものを「無効」と解釈しない**。
 * notifier-gate が踏んだのと同じ罠。
 */
export async function askGas(token, { gasUrl, fetchImpl = fetch, userAgent = null } = {}) {
  if (typeof gasUrl !== 'string' || gasUrl.trim() === '') {
    return { outcome: OUTCOME.UNAVAILABLE, reason: 'not_configured' };
  }

  const payload = { action: 'verifySession', sessionToken: token };

  if (typeof userAgent === 'string' && userAgent !== '') {
    payload.userAgent = userAgent.slice(0, 300);
  }

  let response;

  try {
    response = await fetchImpl(gasUrl, {
      method: 'POST',
      /* GAS は text/plain のまま受ける（プリフライトを避ける既存の作法）。 */
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload),
      redirect: 'follow',
      signal: AbortSignal.timeout(GAS_TIMEOUT_MS),
    });
  } catch {
    return { outcome: OUTCOME.UNAVAILABLE, reason: 'fetch_failed' };
  }

  if (!response || !response.ok) {
    return { outcome: OUTCOME.UNAVAILABLE, reason: 'http_error' };
  }

  let body;

  try {
    body = await response.json();
  } catch {
    /* HTML のエラーページなど。無効とは断じない。 */
    return { outcome: OUTCOME.UNAVAILABLE, reason: 'not_json' };
  }

  if (body && body.success === true && body.data && body.data.user) {
    return { outcome: OUTCOME.VALID, data: body.data };
  }

  /*
   * success:false で返ってきたもののうち、セッションが無効だと
   * 言い切れるのは SESSION_INVALID だけ。SERVER_ERROR や
   * RATE_LIMITED（ロック待ち）は GAS 側の都合なので通さないが消しもしない。
   */
  const code = body && body.error ? String(body.error.code ?? '') : '';

  if (code === 'SESSION_INVALID') {
    return { outcome: OUTCOME.INVALID };
  }

  return { outcome: OUTCOME.UNAVAILABLE, reason: code === '' ? 'unknown' : code };
}

/*
 * 検証する。
 *
 * now と fetchImpl を引数で受けるのは、テストから時間と通信を
 * 差し替えられるようにするため（実時間もネットワークも使わない）。
 */
export async function verifySession(token, {
  kv = null,
  gasUrl = '',
  now = Date.now(),
  fetchImpl = fetch,
  userAgent = null,
} = {}) {
  if (!isAcceptableToken(token)) {
    /* 形が違うものは GAS を叩かずに落とす。キャッシュもしない。 */
    return { outcome: OUTCOME.INVALID, source: 'shape' };
  }

  const key = cacheKey(await tokenHash(token));
  const record = await readRecord(kv, key);

  if (record) {
    /* 「無効」の短期記憶。総当たりで GAS を叩かせないためのもの。 */
    if (record.negative === true && now < Number(record.negativeUntilMs)) {
      return { outcome: OUTCOME.INVALID, source: 'cache-negative' };
    }

    /*
     * セッション自身の期限は、キャッシュがあっても必ず正確に効かせる。
     * ここはほぼ費用ゼロで正しくできるので、緩める理由が無い。
     */
    if (!record.negative && Number(record.sessionExpiresAtMs) > 0
      && now >= Number(record.sessionExpiresAtMs)) {
      return { outcome: OUTCOME.INVALID, source: 'expired' };
    }

    if (!record.negative && now < Number(record.freshUntilMs)) {
      return { outcome: OUTCOME.VALID, data: record.data, source: 'cache' };
    }
  }

  const asked = await askGas(token, { gasUrl, fetchImpl, userAgent });

  if (asked.outcome === OUTCOME.VALID) {
    await writeRecord(kv, key, {
      negative: false,
      data: asked.data,
      sessionExpiresAtMs: parseIsoMs(asked.data.expiresAt),
      verifiedAtMs: now,
      freshUntilMs: now + FRESH_MS,
      graceUntilMs: now + GRACE_MS,
    });

    return { outcome: OUTCOME.VALID, data: asked.data, source: 'origin' };
  }

  if (asked.outcome === OUTCOME.INVALID) {
    await writeRecord(kv, key, {
      negative: true,
      negativeUntilMs: now + NEGATIVE_MS,
    });

    return { outcome: OUTCOME.INVALID, source: 'origin' };
  }

  /*
   * ここへ来るのは「GAS へ届かない・答えが読めない」場合だけ。
   * 覚えている結果があり、grace の内側なら通し続ける（可用性のため）。
   * grace を過ぎたら通さないが、**無効とも言わない**（トークンを消させない）。
   */
  if (record && !record.negative && now < Number(record.graceUntilMs)) {
    if (Number(record.sessionExpiresAtMs) > 0 && now >= Number(record.sessionExpiresAtMs)) {
      return { outcome: OUTCOME.INVALID, source: 'expired' };
    }

    return { outcome: OUTCOME.VALID, data: record.data, source: 'grace' };
  }

  return { outcome: OUTCOME.UNAVAILABLE, source: asked.reason ?? 'unavailable' };
}

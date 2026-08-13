/*
 * auth-verify — セッション検証の代理（キャッシュ付き）。
 *
 * 受けるのは POST の verifySession だけ。ログイン・ログアウト・
 * パスワード系は**この Worker を通さない**（ブラウザ → GAS 直のまま）。
 * パスワードをここへ通さないのは意図的な線引きである。
 *
 * 仕様: docs/specs/auth-verify-cache-spec-v1.md
 */

import { ERRORS, corsHeaders, fail, ok } from './http.mjs';
import { OUTCOME, verifySession } from './verify.mjs';

async function readBody(request) {
  try {
    /* フロントは text/plain で送る。Content-Type では判断しない。 */
    const text = await request.text();

    if (typeof text !== 'string' || text === '') {
      return null;
    }

    const body = JSON.parse(text);

    return body && typeof body === 'object' ? body : null;
  } catch {
    return null;
  }
}

const handler = {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }

    if (request.method !== 'POST') {
      return fail(ERRORS.INVALID_REQUEST, { status: 405, request, env });
    }

    const body = await readBody(request);

    if (!body) {
      return fail(ERRORS.INVALID_REQUEST, { request, env });
    }

    if (body.action !== 'verifySession') {
      /*
       * ここは検証専用の入口。他の操作は受けない。
       * 誤って宛先を差し替えた場合に、黙って通さず気づけるようにする。
       */
      return fail(ERRORS.INVALID_ACTION, { request, env });
    }

    if (typeof env.AUTH_GAS_URL !== 'string' || env.AUTH_GAS_URL.trim() === '') {
      /*
       * 設定漏れ。**セッションが無効なのではない**ので 5xx で返す
       * （200 + SESSION_INVALID にすると全利用者のトークンが消える）。
       */
      return fail(ERRORS.NOT_CONFIGURED, { status: 503, request, env });
    }

    let result;

    try {
      result = await verifySession(body.sessionToken, {
        kv: env.VERIFY_CACHE ?? null,
        gasUrl: env.AUTH_GAS_URL,
        userAgent: typeof body.userAgent === 'string' ? body.userAgent : null,
      });
    } catch {
      /* 想定外。ここでも無効とは言わない。 */
      return fail(ERRORS.SERVER_ERROR, { status: 500, request, env });
    }

    if (result.outcome === OUTCOME.VALID) {
      /*
       * どこから返したかを添える。秘密ではなく（応答時間から推測できる）、
       * 切替後の効果測定に要る。フロントは読まなくてよい。
       */
      return ok(result.data, { request, env, extraHeaders: { 'X-Verify-Source': result.source } });
    }

    if (result.outcome === OUTCOME.INVALID) {
      return fail(ERRORS.SESSION_INVALID, { request, env });
    }

    /*
     * 判定できなかった。フロントの api.js はこれを NETWORK として扱い、
     * session.js はトークンを消さずログイン画面へ送る。
     * GAS が落ちている間の挙動は、この Worker が無かったころと同じになる。
     */
    return fail(ERRORS.SERVER_ERROR, { status: 502, request, env });
  },
};

export default handler;

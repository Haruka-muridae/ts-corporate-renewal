/*
 * 応答の形と CORS。
 *
 * ==================================================================
 * gas-auth の応答と**バイト互換**にする
 * ==================================================================
 * この Worker は既存の verifySession を代理するだけで、フロント側の
 * 改造点は「宛先の差し替え」に限る（仕様 login-page-detailed-spec-v3 §5.1）。
 * そのためには応答の形が gas-auth と一致していなければならない。
 *
 *   成功: { success: true,  data: { user, expiresAt, remember } }
 *   失敗: { success: false, error: { code, message } }
 *
 * public/auth/api.js の readResult は payload.success と payload.data
 * しか見ない。ここを崩すと、フロントは理由が分からないまま NETWORK か
 * SERVER として扱う。**notifier-gate の { ok: true } 形とは違う**ので、
 * あちらを写すときに取り違えないこと。
 * ==================================================================
 */

/* 文言も gas-auth/Response.gs の ERRORS と一字一句そろえる。 */
export const ERRORS = {
  SESSION_INVALID: ['SESSION_INVALID', 'ログインの有効期限が切れました。もう一度ログインしてください。'],
  INVALID_ACTION: ['INVALID_ACTION', 'サポートされていない操作です。'],
  INVALID_REQUEST: ['INVALID_REQUEST', 'リクエストの形式が不正です。'],
  NOT_CONFIGURED: ['NOT_CONFIGURED', 'サーバーの設定が完了していません。'],
  SERVER_ERROR: ['SERVER_ERROR', 'サーバーでエラーが発生しました。時間をおいてお試しください。'],
};

export function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value !== '');
}

export function corsHeaders(request, env) {
  const origin = request.headers.get('Origin');

  if (!origin || allowedOrigins(env).indexOf(origin) === -1) {
    return {};
  }

  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    /*
     * フロントは text/plain で送る（プリフライトを起こさないため）。
     * それでも Content-Type は許可一覧に入れておく。
     */
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

export function json(body, { status = 200, request, env, extraHeaders = {} } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json;charset=UTF-8',
      /* 検証結果は利用者ごとに違う。経路上のキャッシュに残さない。 */
      'Cache-Control': 'no-store',
      ...(request ? corsHeaders(request, env) : {}),
      ...extraHeaders,
    },
  });
}

export function ok(data, options) {
  return json({ success: true, data: data || {} }, options);
}

/*
 * 失敗を返す。
 *
 * ------------------------------------------------------------------
 * status の選び方が安全性に直結する
 * ------------------------------------------------------------------
 * public/auth/api.js は HTTP が 2xx でなければ NETWORK として扱い、
 * session.js は NETWORK のときトークンを**消さない**。
 *
 * 逆に 200 で success:false を返すと、フロントはサーバーが明示的に
 * 「無効」と答えたとみなしてトークンを消す。
 *
 * したがって:
 *   - 本当にセッションが無効なとき（GAS がそう答えた）→ 200 + SESSION_INVALID
 *   - こちらの都合で判定できないとき（GAS 不通・設定不備・想定外）
 *     → 5xx。**絶対に SESSION_INVALID を返さない**
 *
 * ここを取り違えると、障害のたびに全利用者のトークンを消すことになる。
 * ------------------------------------------------------------------
 */
export function fail(pair, options = {}) {
  return json(
    { success: false, error: { code: pair[0], message: pair[1] } },
    { status: options.status ?? 200, ...options },
  );
}

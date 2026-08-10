/**
 * 応答の形と CORS。
 *
 * 応答は gas-notifier / gas-auth と同じ形にそろえてある。
 *   成功: { ok: true,  ... }
 *   失敗: { ok: false, error: { code, message } }
 *
 * ------------------------------------------------------------------
 * CORS を絞る相手はブラウザだけ
 * ------------------------------------------------------------------
 * evaluate / vapid / test-notify を呼ぶのは利用者の Apps Script であり、
 * サーバー間の呼び出しなので CORS は関係しない（Origin も付かない）。
 * ブラウザから来るのは録音アプリのヘルスチェックだけなので、
 * **許可オリジンは録音アプリの配信元に限る**（§3.2）。
 * ------------------------------------------------------------------
 */

export const ERRORS = {
  INVALID_ACTION: ['INVALID_ACTION', 'サポートされていない操作です。'],
  INVALID_REQUEST: ['INVALID_REQUEST', 'リクエストの形式が不正です。'],
  UNAUTHORIZED: ['UNAUTHORIZED', 'ライセンスキーが正しくありません。'],
  LICENSE_EXPIRED: ['LICENSE_EXPIRED', 'ご契約が確認できないため、通知を停止しています。'],
  NOT_CONFIGURED: ['NOT_CONFIGURED', 'サーバーの設定が完了していません。'],
  RATE_LIMITED: ['RATE_LIMITED', '短時間に呼び出しが集中しています。時間をおいてお試しください。'],
  SERVER_ERROR: ['SERVER_ERROR', 'サーバーでエラーが発生しました。時間をおいてお試しください。'],
};

/** 許可オリジンの一覧。vars の ALLOWED_ORIGINS（カンマ区切り）から読む。 */
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
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    /* オリジンごとに応答が変わるため、共有キャッシュに1つ目を使い回させない。 */
    Vary: 'Origin',
  };
}

export function json(body, { status = 200, request, env, extraHeaders = {} } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json;charset=UTF-8',
      /* 判定結果は利用者ごとに違う。経路上のキャッシュに残さない。 */
      'Cache-Control': 'no-store',
      ...(request ? corsHeaders(request, env) : {}),
      ...extraHeaders,
    },
  });
}

export function ok(data, options) {
  return json({ ok: true, ...data }, options);
}

export function fail(pair, options = {}) {
  return json(
    { ok: false, error: { code: pair[0], message: pair[1] } },
    { status: options.status ?? 400, ...options },
  );
}

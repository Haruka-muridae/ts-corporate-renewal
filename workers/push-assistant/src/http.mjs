/**
 * 応答の形と、全応答に付ける保安ヘッダ。
 *
 * ------------------------------------------------------------------
 * 複製元
 * ------------------------------------------------------------------
 * workers/notifier-gate/src/http.mjs（2026-08-26 に複製）。
 * docs/repository-structure.md §4-1「アプリ間で共通層を作らない」に従い、
 * 共通モジュールへ切り出さず写した。
 *
 * 写したうえで変えた点は 2 つ。
 *   1. **CORS を持たない。** 画面と API が同一オリジン
 *      （https://tsam-ai.com/push-assistant/）にあり、他所から呼ばせる
 *      予定が無い。CORS ヘッダを返さないこと自体が防御になる。
 *      代わりに状態を変える要求では Origin を照合する（仕様書 §5、api.mjs）
 *   2. エラーコードごとの既定 HTTP ステータスを持たせた（仕様書 §7）。
 *      呼び出し側が status を書き忘れて 400 になる事故を防ぐ
 * ------------------------------------------------------------------
 */

/**
 * エラーコードと利用者向けの文面（仕様書 §7）。
 *
 * **内部の事情をここへ書かない。** 応答は誰でも受け取れる。
 * 原因の手掛かりはログ側（index.mjs の log）に残す。
 */
export const ERRORS = {
  UNAUTHORIZED: ['UNAUTHORIZED', 'ログインが必要です。'],
  FORBIDDEN_ORIGIN: ['FORBIDDEN_ORIGIN', '不正な要求です。画面を開き直してください。'],
  INVALID_REQUEST: ['INVALID_REQUEST', 'リクエストの形式が不正です。'],
  NOT_CONNECTED: ['NOT_CONNECTED', 'Google カレンダーが接続されていません。'],
  TOKEN_INVALID: ['TOKEN_INVALID', 'Google の接続が切れました。接続し直してください。'],
  CALENDAR_ERROR: ['CALENDAR_ERROR', 'カレンダーを取得できませんでした。時間をおいてお試しください。'],
  NOT_CONFIGURED: ['NOT_CONFIGURED', 'サーバーの設定が完了していません。'],
  SERVER_ERROR: ['SERVER_ERROR', 'サーバーでエラーが発生しました。時間をおいてお試しください。'],
  NOT_FOUND: ['NOT_FOUND', '見つかりませんでした。'],
};

/** エラーコードごとの既定 HTTP ステータス（仕様書 §7 の一覧そのまま）。 */
export const ERROR_STATUS = {
  UNAUTHORIZED: 401,
  FORBIDDEN_ORIGIN: 403,
  INVALID_REQUEST: 400,
  NOT_CONNECTED: 409,
  TOKEN_INVALID: 409,
  CALENDAR_ERROR: 502,
  NOT_CONFIGURED: 500,
  SERVER_ERROR: 500,
  NOT_FOUND: 404,
};

/**
 * 全応答に付けるヘッダ（仕様書 §10）。
 *
 * nosniff … JSON を HTML として解釈させない（誤った Content-Type での XSS 防止）
 * no-referrer … 予定の URL を持つ画面から外部へ Referer を漏らさない
 *
 * ------------------------------------------------------------------
 * frame-ancestors は <meta> では効かない
 * ------------------------------------------------------------------
 * index.html の <meta http-equiv="Content-Security-Policy"> に
 * frame-ancestors を書いても、**CSP の仕様上その指令は meta では無視される**
 * （frame-ancestors / report-uri / sandbox は HTTP ヘッダ専用）。
 * つまり meta だけではクリックジャッキングを止められていない。
 *
 * **ヘッダ側が本体である。** ここで 2 つ返す。
 *   Content-Security-Policy: frame-ancestors 'none' … 現行ブラウザ
 *   X-Frame-Options: DENY                            … 古い実装の保険
 *
 * ここに書いた CSP は frame-ancestors だけなので、index.html の meta CSP
 * （default-src 等）とは競合しない。両方が独立に強制される。
 * ------------------------------------------------------------------
 */
export const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "frame-ancestors 'none'",
};

/** 応答（Response）に保安ヘッダを足す。assets からの応答にも使う。 */
export function withSecurityHeaders(response, extra = {}) {
  const headers = new Headers(response.headers);

  for (const [name, value] of Object.entries({ ...SECURITY_HEADERS, ...extra })) {
    headers.set(name, value);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function json(body, { status = 200, extraHeaders = {} } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json;charset=UTF-8',
      /* 利用者ごとに中身が違う。経路上のキャッシュに残さない。 */
      'Cache-Control': 'no-store',
      ...SECURITY_HEADERS,
      ...extraHeaders,
    },
  });
}

export function ok(data, options) {
  return json({ ok: true, ...data }, options);
}

/**
 * 失敗を返す。status を省くと ERROR_STATUS の既定値を使う。
 *
 * `extra` は本文の**最上位**へ足す（error の中ではない）。
 * error は人に見せる code / message だけに保つ（notifier-gate と同じ）。
 */
export function fail(pair, options = {}) {
  const { extra, status, ...rest } = options;

  return json(
    { ok: false, error: { code: pair[0], message: pair[1] }, ...extra },
    { status: status ?? ERROR_STATUS[pair[0]] ?? 400, ...rest },
  );
}

/** 302 で別の場所へ送る。Set-Cookie を一緒に返せるよう Response を自分で組む。 */
export function redirect(location, { status = 302, extraHeaders = {} } = {}) {
  return new Response(null, {
    status,
    headers: {
      Location: location,
      'Cache-Control': 'no-store',
      ...SECURITY_HEADERS,
      ...extraHeaders,
    },
  });
}

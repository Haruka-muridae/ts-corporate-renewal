/**
 * env（vars / secrets / bindings）を読む薄い層（仕様書 §11）。
 *
 * ------------------------------------------------------------------
 * 「設定漏れ」を 500 の中で迷子にしない
 * ------------------------------------------------------------------
 * Workers の env はただの object なので、シークレットを登録し忘れると
 * `undefined` がそのまま先へ流れ、fetch や importKey の奥で落ちる。
 * 実機では「/api/... が 500」としか分からない（notifier-gate で
 * 2026-08-11 に実際に起きた）。
 *
 * そこで **入口で名前を付けて落とす。** ConfigError は api.mjs が
 * NOT_CONFIGURED（500）に変換し、ログには「どの名前が無いか」だけを残す。
 * 値はログにも応答にも出さない。
 * ------------------------------------------------------------------
 */

/** 設定が足りないときの例外。missing に**名前だけ**を持つ（値は持たない）。 */
export class ConfigError extends Error {
  constructor(name) {
    super(`設定 ${name} がありません。`);
    this.name = 'ConfigError';
    this.missing = name;
  }
}

/** 必須の設定を読む。空文字も「無い」として扱う（wrangler secret put の空登録事故対策）。 */
export function required(env, name) {
  const value = env?.[name];

  if (typeof value !== 'string' || value.trim() === '') {
    throw new ConfigError(name);
  }

  return value.trim();
}

/** 任意の設定。無ければ fallback。 */
export function optional(env, name, fallback = '') {
  const value = env?.[name];

  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback;
}

/** 画面と API のオリジン。Origin 照合の相手でもある（仕様書 §5）。 */
export function appOrigin(env) {
  return required(env, 'APP_ORIGIN').replace(/\/+$/, '');
}

/** 公開パスの接頭辞。末尾のスラッシュは持たない（`/push-assistant`）。 */
export function basePath(env) {
  const value = optional(env, 'APP_BASE_PATH', '/push-assistant').replace(/\/+$/, '');

  return value === '' ? '' : (value.startsWith('/') ? value : `/${value}`);
}

/**
 * OAuth のリダイレクト URI。
 *
 * **Google Cloud Console の「承認済みのリダイレクト URI」と 1 文字も違ってはいけない。**
 * 組み立てを 1 か所に閉じ込めているのはそのため（README §5）。
 */
export function redirectUri(env) {
  return `${appOrigin(env)}${basePath(env)}/api/auth/callback`;
}

/**
 * 利用を許可するメールアドレス（vars ALLOWED_EMAILS、カンマ区切り）。
 *
 * ==================================================================
 * **空なら誰も接続できない（deny by default）**
 * ==================================================================
 * この Worker は tsam-ai.com の公開パスに置かれており、
 * **URL を知っていれば誰でも Google ログインへ進める。** 許可リストが
 * 未設定のときに「全員許可」へ倒すと、設定を書き忘れた瞬間に
 * 見知らぬ他人のカレンダーを読み、そのリフレッシュトークンを
 * こちらの D1 に抱えることになる。持ちたくない責任なので、
 * 設定漏れは「誰も入れない」側へ倒す。
 *
 * 採らなかった案: 本番認証系（tsam-auth-session）で囲う …
 * v1 のスコープ外（仕様書 §2・§13）。MVP の利用者は運営者 1 人なので、
 * vars 1 行の許可リストで足りる。
 * ==================================================================
 *
 * 比較は**小文字・前後空白を除いた完全一致**。Google が返す email は
 * 大文字を含みうる（表示用の綴りを保つため）。
 */
export function allowedEmails(env) {
  return optional(env, 'ALLOWED_EMAILS', '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value !== '');
}

/** 画面の URL。通知の既定の行き先（open-url.mjs の source='app'）でもある。 */
export function appUrl(env) {
  return `${appOrigin(env)}${basePath(env)}/`;
}

/*
 * 管理画面の認証（実装仕様書 9章、受入条件10）。
 *
 * ==================================================================
 * 方針
 * ==================================================================
 *   - Supabase Auth をメールアドレスとパスワードで使う。
 *     外部ライブラリは足さず、Auth の REST を fetch で叩く。
 *   - このプロジェクトの Supabase には管理者しか登録しない。
 *     一般の申込者は認証を一切通らない（申込はサーバー側が service role で書く）。
 *     したがって「このプロジェクトで認証できる＝管理者」となる。
 *     新規登録は Supabase 側で無効にしておくこと（docs/event-admin.md）。
 *   - アクセストークンはブラウザのJavaScriptから触れない形で持たせる。
 *     受け渡しは呼び出し側（サーバーアクション）が httpOnly の Cookie で行う。
 *   - 例外にトークンやパスワードを含めない。
 * ==================================================================
 */

/** アクセストークンの有効期限が近いとみなす余裕（秒）。 */
export const REFRESH_MARGIN_SECONDS = 60;

function authUrl(config, path) {
  return `${config.url}/auth/v1/${path}`;
}

function authHeaders(config, extra = {}) {
  return {
    apikey: config.anonKey,
    'Content-Type': 'application/json',
    ...extra,
  };
}

/**
 * メールアドレスとパスワードでログインする。
 *
 * @returns {Promise<{ accessToken: string, refreshToken: string, expiresAt: number, email: string }>}
 */
export async function signInWithPassword(config, { email, password }) {
  if (!email || !password) {
    throw new TypeError('メールアドレスとパスワードを入力してください');
  }

  const fetchImpl = config.fetchImpl ?? fetch;

  const response = await fetchImpl(authUrl(config, 'token?grant_type=password'), {
    method: 'POST',
    headers: authHeaders(config),
    body: JSON.stringify({ email, password }),
  });

  const payload = await response.json().catch(() => null);

  if (!response.ok || !payload?.access_token) {
    /*
     * 「メールアドレスが存在しない」と「パスワードが違う」を区別しない。
     * どちらかを教えると、登録済みのアドレスを探る手掛かりになる。
     */
    throw new Error('メールアドレスまたはパスワードが正しくありません');
  }

  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    expiresAt: nowSeconds(config) + Number(payload.expires_in ?? 3600),
    email: payload.user?.email ?? email,
  };
}

/** リフレッシュトークンでアクセストークンを取り直す。 */
export async function refreshSession(config, refreshToken) {
  if (!refreshToken) {
    throw new TypeError('リフレッシュトークンがありません');
  }

  const fetchImpl = config.fetchImpl ?? fetch;

  const response = await fetchImpl(authUrl(config, 'token?grant_type=refresh_token'), {
    method: 'POST',
    headers: authHeaders(config),
    body: JSON.stringify({ refresh_token: refreshToken }),
  });

  const payload = await response.json().catch(() => null);

  if (!response.ok || !payload?.access_token) {
    throw new Error('ログインの有効期限が切れました');
  }

  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token ?? refreshToken,
    expiresAt: nowSeconds(config) + Number(payload.expires_in ?? 3600),
    email: payload.user?.email ?? '',
  };
}

/**
 * アクセストークンが今も有効かを Supabase に問い合わせる。
 *
 * 期限の見た目だけで判断しない。管理者を削除した直後や、
 * Supabase 側でセッションを失効させた場合にも弾けるようにする。
 */
export async function getUser(config, accessToken) {
  if (!accessToken) {
    return null;
  }

  const fetchImpl = config.fetchImpl ?? fetch;

  const response = await fetchImpl(authUrl(config, 'user'), {
    headers: authHeaders(config, { Authorization: `Bearer ${accessToken}` }),
  });

  if (!response.ok) {
    return null;
  }

  const user = await response.json().catch(() => null);

  if (!user?.id) {
    return null;
  }

  return { id: user.id, email: user.email ?? '' };
}

/** ログアウト（Supabase 側のセッションも失効させる）。 */
export async function signOut(config, accessToken) {
  if (!accessToken) {
    return;
  }

  const fetchImpl = config.fetchImpl ?? fetch;

  await fetchImpl(authUrl(config, 'logout'), {
    method: 'POST',
    headers: authHeaders(config, { Authorization: `Bearer ${accessToken}` }),
  }).catch(() => {
    /* 失効に失敗しても、こちらのCookieは消す。呼び出し側で消す。 */
  });
}

function nowSeconds(config) {
  return config.nowSeconds ?? Math.floor(Date.now() / 1000);
}

/** 期限切れ、または期限が近いか。 */
export function needsRefresh(session, now = Math.floor(Date.now() / 1000)) {
  if (!session?.expiresAt) {
    return true;
  }

  return session.expiresAt - now <= REFRESH_MARGIN_SECONDS;
}

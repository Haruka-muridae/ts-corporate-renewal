/*
 * Supabase の接続設定。
 * 値を書き換える場所はこのファイルの1か所だけにする。
 * HTMLや他のJSへ直接書かないこと。
 *
 * ------------------------------------------------------------------
 * ここに入れてよいもの / 絶対に入れてはならないもの
 * ------------------------------------------------------------------
 * 入れてよい:
 *   Project URL      … https://xxxxxxxx.supabase.co
 *   anon public key  … 公開前提のキー。ブラウザへ配る想定で作られている。
 *                      RLS（行レベルセキュリティ）で守る設計のため、
 *                      これ単体では他人のデータを読めない。
 *
 * 絶対に入れてはならない:
 *   service_role key  … **全データへの管理者権限**を持つ。
 *                       流出したら全ユーザーのデータを読み書きされる。
 *                       ブラウザへ渡してはならず、コミットもしてはならない。
 *   JWT secret / DBパスワード / SMTP資格情報 / 個人の認証情報
 *
 * anon key と service_role key は見た目が似ている。
 * Supabase ダッシュボードで **anon / public** と表示されているほうを使う。
 * ------------------------------------------------------------------
 *
 * 未設定のあいだは外部通信を一切行わず、
 * ログイン画面は「準備中」としてダミープロバイダのまま動く
 * （apps/auth-config.js と同じ方針）。
 *
 * 設定手順は apps/SUPABASE_SETUP.md を参照する。
 */

/* 未設定を表す値。この値のままなら外部通信は発生しない。 */
export const SUPABASE_URL_PLACEHOLDER = 'REPLACE_WITH_SUPABASE_URL';
export const SUPABASE_ANON_KEY_PLACEHOLDER = 'REPLACE_WITH_SUPABASE_ANON_KEY';

export const SUPABASE_CONFIG = Object.freeze({
  /*
   * Supabase ダッシュボード → Project Settings → Data API → Project URL
   * 形式: https://xxxxxxxxxxxxxxxx.supabase.co
   */
  url: SUPABASE_URL_PLACEHOLDER,

  /*
   * Supabase ダッシュボード → Project Settings → API Keys → anon / public
   * ★ service_role キーを貼らないこと（上の注意を参照）。
   */
  anonKey: SUPABASE_ANON_KEY_PLACEHOLDER,

  /*
   * Supabase SDK がトークンを保存するときのキー接頭辞。
   * TSAM AI の他のキー（tsam-ai-*）と並べて見分けられるようにする。
   */
  storageKey: 'tsam-ai-supabase-auth',
});

/*
 * メール内リンクから戻ってくる先。
 * ここへ来た画面が種別（招待／パスワード再設定／メール確認）を判定して振り分ける。
 *
 * Supabase ダッシュボードの Authentication → URL Configuration →
 * Redirect URLs にも、同じURLを登録する必要がある。
 * 登録が無いと Site URL へ飛ばされ、リンクが機能しない。
 */
export const AUTH_CALLBACK_PATH = 'auth-callback/';

/*
 * Project URL が実際に使える値かどうか。
 * 未設定・プレースホルダー・形式違いは false を返し、
 * 呼び出し側は「準備中」表示へ倒す。ここで false でもページは壊さない。
 */
export function isUrlConfigured(url = SUPABASE_CONFIG.url) {
  if (typeof url !== 'string') {
    return false;
  }

  const value = url.trim();

  if (value === '' || value === SUPABASE_URL_PLACEHOLDER) {
    return false;
  }

  try {
    const parsed = new URL(value);
    /* http は許可しない（資格情報を平文で送ることになる）。 */
    return parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/*
 * anon key が設定されているかどうか。
 *
 * 形が JWT（3区分）であることだけを確認する。
 * 中身の検証はしない（クライアント側で判定する意味が無いため）。
 */
export function isAnonKeyConfigured(key = SUPABASE_CONFIG.anonKey) {
  if (typeof key !== 'string') {
    return false;
  }

  const value = key.trim();

  if (value === '' || value === SUPABASE_ANON_KEY_PLACEHOLDER) {
    return false;
  }

  /* 新形式（sb_publishable_...）と JWT 形式の両方を許容する。 */
  if (value.startsWith('sb_publishable_')) {
    return value.length > 20;
  }

  return value.split('.').length === 3 && value.length > 40;
}

/*
 * service_role キーが誤って貼られていないかを検査する。
 *
 * ------------------------------------------------------------------
 * これは事故を早く見つけるための検査であって、防止策ではない。
 * 誤って service_role キーをコミットしてしまった場合は、
 * ファイルを直すだけでは不十分で、**必ずSupabase側でキーを無効化（rotate）する**。
 * Gitの履歴と、その間にページを開いた全員のブラウザに残るため。
 * ------------------------------------------------------------------
 */
export function looksLikeServiceRoleKey(key = SUPABASE_CONFIG.anonKey) {
  if (typeof key !== 'string' || key.trim() === '') {
    return false;
  }

  const value = key.trim();

  if (value.startsWith('sb_secret_')) {
    return true;
  }

  const parts = value.split('.');

  if (parts.length !== 3) {
    return false;
  }

  /* JWT の payload を読んで role を確認する（署名検証は行わない）。 */
  try {
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
    const payload = JSON.parse(atob(padded));
    return payload?.role === 'service_role';
  } catch {
    return false;
  }
}

/* URL と anon key の両方がそろっているか。 */
export function isSupabaseConfigured() {
  return isUrlConfigured() && isAnonKeyConfigured() && !looksLikeServiceRoleKey();
}

/*
 * 設定状態の説明。
 *
 * ------------------------------------------------------------------
 * reason と detail を分ける理由
 * ------------------------------------------------------------------
 * reason は**画面へそのまま出る**。login / account / password-reset の
 * 3画面が `（${status.reason}）` の形で表示している。
 *
 * そこへ「apps/shared/supabase-config.js を設定してください」と書くと、
 * 一般の利用者に、自分では直せない内部のファイル構成を見せることになる。
 * 直し方の案内にはならず、不信感だけが残る。
 *
 * detail は開発者向けで、**画面へ出してはならない**。
 * 原因を切り分けたいときに DevTools から読む。
 * ------------------------------------------------------------------
 *
 * 戻り値: { configured, reason, detail }
 *   reason … 利用者へ見せてよい文言
 *   detail … 開発者向け。表示禁止
 */

/* 利用者向けの文言。原因によらず同じにする（内部構成を推測させない）。 */
const NOT_READY_MESSAGE = 'ログイン機能は現在準備中です。';

export function describeConfig() {
  if (looksLikeServiceRoleKey()) {
    return {
      configured: false,
      reason: NOT_READY_MESSAGE,
      detail: 'service_role キーが設定されています。anon / public キーに置き換え、'
        + 'Supabase 側で service_role キーを必ず無効化（rotate）してください。',
    };
  }

  if (!isUrlConfigured()) {
    return {
      configured: false,
      reason: NOT_READY_MESSAGE,
      detail: 'Supabase の Project URL が未設定です。',
    };
  }

  if (!isAnonKeyConfigured()) {
    return {
      configured: false,
      reason: NOT_READY_MESSAGE,
      detail: 'Supabase の anon key が未設定です。',
    };
  }

  return { configured: true, reason: null, detail: null };
}

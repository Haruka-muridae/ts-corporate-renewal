/*
 * Googleログインの設定値。
 * クライアントIDを書き換える場所はこのファイルの1か所だけにする。
 * HTMLや他のJSへクライアントIDを直接書かないこと。
 *
 * ------------------------------------------------------------------
 * セキュリティ上の位置付け（重要）
 * ------------------------------------------------------------------
 * ここで扱うOAuthクライアントIDは「公開情報」であり、client secret ではない。
 * 静的サイトのため、IDトークンをサーバー側で検証する仕組みは存在しない。
 * したがって、このログイン機能はクライアント側のプロフィール表示に限定され、
 * セキュリティ境界（アクセス制御・権限判定・本人確認）には使用しない。
 * 詳細は AUTH_SETUP.md を参照する。
 * ------------------------------------------------------------------
 *
 * このリポジトリへ絶対に入れてはならないもの:
 *   client secret / APIキー / refresh token / アクセストークン /
 *   サービスアカウント秘密鍵 / 個人の認証情報
 */

/* 未設定を表す値。この値のままなら「準備中」表示になり、外部通信も行わない。 */
export const CLIENT_ID_PLACEHOLDER = 'REPLACE_WITH_GOOGLE_CLIENT_ID';

export const GOOGLE_AUTH_CONFIG = Object.freeze({
  /*
   * Google Cloud Console で発行した「ウェブアプリケーション」用クライアントID。
   * 形式: 000000000000-xxxxxxxxxxxx.apps.googleusercontent.com
   */
  clientId: CLIENT_ID_PLACEHOLDER,

  /* sessionStorage のキー。プロフィール表示用の最小情報だけを入れる。 */
  storageKey: 'tsam-ai-google-profile',

  /* 保存形式のバージョン。形式を変えたら +1 する（旧データは自動破棄される）。 */
  storageVersion: 1,
});

/* Google Identity Services の公式配信元。自己ホストや差し替えは行わない。 */
export const GIS_SCRIPT_URL = 'https://accounts.google.com/gsi/client';

/* ライブラリ読み込みと初期化の待ち時間の上限（ミリ秒）。 */
export const GIS_LOAD_TIMEOUT_MS = 10000;

/*
 * クライアントIDが実際に使える値かどうかを判定する。
 * 未設定・プレースホルダー・明らかに形式が違う値は false を返し、
 * 呼び出し側は「準備中」表示（unavailable）へ倒す。
 * ここで false でもページ自体は壊さない。
 */
export function isClientIdConfigured(clientId = GOOGLE_AUTH_CONFIG.clientId) {
  if (typeof clientId !== 'string') {
    return false;
  }

  const value = clientId.trim();

  if (value === '' || value === CLIENT_ID_PLACEHOLDER) {
    return false;
  }

  /* Googleのウェブ用クライアントIDは必ずこのドメインで終わる。 */
  return value.endsWith('.apps.googleusercontent.com');
}

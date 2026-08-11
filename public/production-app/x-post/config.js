/*
 * X 投稿アプリの静的設定。**設定値を変えるのはこのファイルだけ。**
 *
 * Threads 投稿（../threads-post/config.js）と同じく、定数を1本へ集約する。
 * **秘密情報を置かない。** ここは公開URLから読める（静的ホスティング）。
 * APIキーは KeyStore（../../auth/keystore.js）だけが扱い、ここには現れない。
 */

/* ================================================================
 * Gemini のモデルとエンドポイント（他の本番アプリと同じ選定）
 * ================================================================ */
export const DEFAULT_MODEL = 'gemini-2.5-flash-lite';
export const FALLBACK_MODEL = 'gemini-3.5-flash-lite';

export const GEMINI_HOST = 'generativelanguage.googleapis.com';
export const GEMINI_ENDPOINT_BASE = `https://${GEMINI_HOST}/v1beta/models`;

export const MAX_OUTPUT_TOKENS = 1024;

/* ================================================================
 * X（旧 Twitter）
 * ================================================================
 *
 * 投稿は intent リンク（本文入りの投稿画面を開く）で行い、
 * 最後の「ポスト」は利用者が押す。API・トークンは使わない。
 * 未ログイン時は X が redirect_after_login=<intent URL> でログインへ誘導し、
 * ログイン後に本文入りの作成画面が開く（2026-08-12 実機確認）。
 */
export const X_INTENT_BASE = 'https://x.com/intent/post';

/*
 * X の上限は280「ウェイト」。半角系（Latin など）が1、日本語を含む
 * 全角系は1文字=2で数えられるため、日本語だけならおよそ140字。
 * 重みの区分は post.js の countWeight()（twitter-text の既定に合わせる）。
 */
export const WEIGHT_LIMIT = 280;

/* テーマ入力の上限（Threads 版と同じ）。 */
export const THEME_MAX_LENGTH = 100;

/* ================================================================
 * 端末内保存（Threads 版と同じ方式・別キー）
 * ================================================================ */
export const STORAGE_KEY = 'tsam-x-post-v1';
export const HISTORY_LIMIT = 100;

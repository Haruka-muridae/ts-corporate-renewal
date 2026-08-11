/*
 * note 下書きアプリの静的設定。**設定値を変えるのはこのファイルだけ。**
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

/*
 * 出力の上限。note は記事（目安 1500〜2000 字）なので、
 * Threads 版より大きく取る（足りないと本文が途中で切れる）。
 */
export const MAX_OUTPUT_TOKENS = 4096;

/* ================================================================
 * note
 * ================================================================
 *
 * note には本文プリフィルの URL が**存在しない**（2026-08-12 実機確認）。
 * そのため「本文をクリップボードへコピーして、作成画面を開き、
 * エディタで貼り付ける」方式にする。未ログイン時は note が
 * /login?redirectPath=/notes/new でログインへ誘導し、ログイン後に
 * エディタが開く（同日確認）。
 */
export const NOTE_NEW_URL = 'https://note.com/notes/new';

/*
 * 本文の上限（文字）。note 側の仕様上の上限は公開されていないため、
 * 記事として現実的な範囲で頭打ちにする（貼り付け事故の防止）。
 */
export const TEXT_LIMIT = 30000;

/* 記事生成の目安文字数（note-auto-fill-gas の選定と同じ）。 */
export const BODY_TARGET_MIN = 1500;
export const BODY_TARGET_MAX = 2000;

/* テーマ入力の上限（Threads 版と同じ）。 */
export const THEME_MAX_LENGTH = 100;

/* ================================================================
 * 端末内保存（Threads 版と同じ方式・別キー）
 * ================================================================ */
export const STORAGE_KEY = 'tsam-note-post-v1';
export const HISTORY_LIMIT = 100;

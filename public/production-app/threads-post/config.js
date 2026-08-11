/*
 * Threads 投稿アプリの静的設定。**設定値を変えるのはこのファイルだけ。**
 *
 * 台本メーカー（../short-script/config.js）と同じく、定数を1本へ集約する。
 * **秘密情報を置かない。** ここは公開URLから読める（静的ホスティング）。
 * APIキーは KeyStore（../../auth/keystore.js）だけが扱い、ここには現れない。
 */

/* ================================================================
 * Gemini のモデルとエンドポイント
 * ================================================================
 *
 * 台本メーカー・名刺OCRと同じ選定に揃える。
 * 主モデルが 404（廃止）のときだけ gemini.js がフォールバックへ切り替える。
 * 503（混雑）では切り替えない。混雑は待って直すものだからである。
 */
export const DEFAULT_MODEL = 'gemini-2.5-flash-lite';
export const FALLBACK_MODEL = 'gemini-3.5-flash-lite';

export const GEMINI_HOST = 'generativelanguage.googleapis.com';
export const GEMINI_ENDPOINT_BASE = `https://${GEMINI_HOST}/v1beta/models`;

/*
 * 出力の上限。投稿文は最大500字なので、余裕を見て 1024 にする
 * （足りないと本文が途中で切れる）。
 */
export const MAX_OUTPUT_TOKENS = 1024;

/* ================================================================
 * Threads
 * ================================================================
 *
 * 投稿は intent リンク（本文入りの投稿画面を開く）で行い、
 * 最後の「投稿」は利用者が押す。API・トークンは使わない
 * （docs/specs/threads-mvp-requirements-v1.md §1.1 の方式選択）。
 *
 * ドメインは threads.com（旧 threads.net は 2026-08-12 の実機確認で
 * threads.com へリダイレクトされることを確認済み。直接向ける）。
 * 未ログイン時は Threads が /login?next=<この URL> へ誘導し、
 * ログイン後に本文入りの作成画面が開く（同日確認）。
 */
export const THREADS_INTENT_BASE = 'https://www.threads.com/intent/post';

/* Threads の本文上限（文字）。 */
export const TEXT_LIMIT = 500;

/* テーマ入力の上限。長すぎる指示は要約されて意図から外れやすい（台本メーカーと同じ）。 */
export const THEME_MAX_LENGTH = 100;

/* ================================================================
 * 端末内保存
 * ================================================================
 *
 * 下書きと履歴は localStorage に置く（この端末の、このブラウザだけ）。
 * 当社サーバーへは何も送らない。キー名は他アプリと衝突しないよう
 * tsam- 接頭辞を付ける。
 */
export const STORAGE_KEY = 'tsam-threads-post-v1';

/* 履歴の保持件数。超えた分は古いものから捨てる。 */
export const HISTORY_LIMIT = 100;

/*
 * AI機能の共通の型・定数・エラー。
 *
 * ------------------------------------------------------------------
 * なぜこのファイルを分けたか（循環importの回避）
 * ------------------------------------------------------------------
 * ai-client.js は providers/*.js を import する。
 * providers/*.js もエラー型とタスク定義を必要とする。
 *
 * これらを ai-client.js に置くと循環参照になり、
 * providers 側がモジュール評価時に AI_TASK を参照した瞬間に
 * TDZ の ReferenceError で落ちる（ESMの仕様上、
 * 循環先の const はまだ初期化されていない）。
 *
 * そこで **どこにも依存しない葉のモジュール** を1つ用意し、
 * ai-client.js と providers/*.js の両方がここを見る形にした。
 *
 *   ai-types.js  ←  ai-client.js
 *        ↑             ↓
 *        └───  providers/*.js
 *
 * 呼び出し側（各アプリ）はこのファイルを直接 import しなくてよい。
 * ai-client.js が再エクスポートしている。
 * ------------------------------------------------------------------
 *
 * このファイルには定数と型だけを置く。
 * 通信・DOM操作・ストレージ操作を書かないこと。
 */

/*
 * 想定するタスク種別。
 * 各アプリはここに無い文字列を渡さない。
 * 増やす場合は providers/*.js の CAPABILITIES も合わせて更新する。
 */
export const AI_TASK = Object.freeze({
  /* 長文を要約する。 */
  SUMMARIZE: 'summarize',
  /* 文章から項目を抽出する（日付・金額・氏名など）。 */
  EXTRACT: 'extract',
  /* 与えた文脈にもとづいて質問へ答える。 */
  ANSWER: 'answer',
});

export const AiErrorCode = Object.freeze({
  /* Phase 1 の全プロバイダはこれを投げる。 */
  NOT_IMPLEMENTED: 'NOT_IMPLEMENTED',
  MODE_UNSUPPORTED: 'MODE_UNSUPPORTED',
  TASK_UNSUPPORTED: 'TASK_UNSUPPORTED',
  API_KEY_MISSING: 'API_KEY_MISSING',
  INVALID_INPUT: 'INVALID_INPUT',
  UNAUTHORIZED: 'UNAUTHORIZED',
  RATE_LIMITED: 'RATE_LIMITED',
  NETWORK: 'NETWORK',
  CANCELLED: 'CANCELLED',
  UNKNOWN: 'UNKNOWN',
});

export class AiError extends Error {
  constructor(code, detail) {
    super(code);
    this.name = 'AiError';
    this.code = code;
    /*
     * detail には利用者へ出さない補助情報だけを入れる。
     * APIキー・送信内容・プロバイダの応答全体は絶対に入れない。
     */
    this.detail = detail ?? null;
  }
}

/*
 * ------------------------------------------------------------------
 * プロバイダのインターフェース
 * ------------------------------------------------------------------
 * providers/*.js は次を export する。
 *
 *   PROVIDER_ID     … 識別子（文字列）
 *   PROVIDER_LABEL  … 画面表示名
 *   CAPABILITIES    … 対応タスクの表 { [AI_TASK の値]: boolean }
 *   isAvailable()   … { ok, reason, code } を返す。設定不足なら ok:false
 *   run(request)    … 実処理。async。失敗時は AiError を投げる
 *
 * request : { task, input, options, signal }
 * 戻り値  : { text, provider, task, meta }
 * ------------------------------------------------------------------
 */

/* プロバイダの戻り値を組み立てる補助。形を1か所に揃えるために使う。 */
export function createAiResult({ text, provider, task, meta = null }) {
  return {
    text: typeof text === 'string' ? text : '',
    provider,
    task,
    meta,
  };
}

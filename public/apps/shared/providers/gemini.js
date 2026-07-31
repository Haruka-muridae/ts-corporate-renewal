/*
 * マイAPIキーモード（Google Gemini）のプロバイダ。**雛形／未実装**
 *
 * ------------------------------------------------------------------
 * Phase 1 時点の状態
 * ------------------------------------------------------------------
 * インターフェースと事前確認（キーの有無）だけを実装してある。
 * run() は NOT_IMPLEMENTED を投げる。実装は Phase 6。
 *
 * 使用モデルとレート超過時の扱いが未確定のため、
 * エンドポイントの定数は用意しつつ呼び出しは行っていない。
 * ------------------------------------------------------------------
 *
 * ------------------------------------------------------------------
 * 実装前に必ず対応すること
 * ------------------------------------------------------------------
 * 1. CSP
 *    apps/knowledge/index.html の meta CSP は connect-src に
 *      https://generativelanguage.googleapis.com
 *    を含んでいない。knowledge からこのプロバイダを呼ぶ場合、
 *    先にCSPへ追加しないとブラウザにブロックされる。
 *    追加するのはこの1ドメインだけにすること。
 *
 * 2. APIキーの渡し方
 *    キーは **URLのクエリに載せない**（履歴・リファラ・ログに残る）。
 *    HTTPヘッダー（x-goog-api-key）で渡す。
 *
 * 3. ログ
 *    キー・送信内容・応答全体をログへ出さない。
 *    出してよいのはエラー種別名とHTTPステータスだけ。
 *
 * 4. 利用者への明示
 *    静的サイトのため中継サーバーが無く、入力内容は
 *    利用者のブラウザから直接 Google へ送られる。
 *    設定画面でこの事実を伝えること。
 * ------------------------------------------------------------------
 */

import { AiError, AiErrorCode, AI_TASK } from '../ai-types.js';
import { getApiKey } from '../ai-config.js';

export const PROVIDER_ID = 'gemini';

export const PROVIDER_LABEL = 'マイAPIキーモード（Gemini）';

/*
 * APIのエンドポイント。
 * Phase 6 で実際に使う。ここではCSP設定の根拠として定義しておく。
 */
export const GEMINI_API_ORIGIN = 'https://generativelanguage.googleapis.com';

/*
 * 対応タスク。実装が済んだものから true にする。
 * モデルの選定が未確定のため、現時点ではすべて false。
 */
export const CAPABILITIES = Object.freeze({
  [AI_TASK.SUMMARIZE]: false,
  [AI_TASK.EXTRACT]: false,
  [AI_TASK.ANSWER]: false,
});

/*
 * このモードが使える状態かどうか。
 *
 * キーの有無だけを見る。キーが有効かどうかは実際に呼ぶまで分からないため、
 * ここでは判定しない（無駄な通信を発生させない）。
 */
export function isAvailable() {
  if (getApiKey() === null) {
    return {
      ok: false,
      reason: 'Gemini APIキーが設定されていません。AI設定からキーを登録してください。',
      code: AiErrorCode.API_KEY_MISSING,
    };
  }

  return {
    ok: false,
    reason: 'マイAPIキーモードのAI機能は準備中です。',
    code: AiErrorCode.NOT_IMPLEMENTED,
  };
}

/*
 * 実処理。
 *
 * Phase 6 でここに実装する。実装時の約束:
 *   - キーは getApiKey() でその都度取得し、モジュール内に保持しない
 *   - キーはヘッダー（x-goog-api-key）で渡す。URLへ載せない
 *   - HTTPステータスを AiErrorCode へ写像する
 *     401/403 → UNAUTHORIZED、429 → RATE_LIMITED、5xx → UNKNOWN
 *   - request.signal による中断に対応する
 *   - 応答は createAiResult() で形を揃えて返す
 */
export async function run(request) {
  throw new AiError(AiErrorCode.NOT_IMPLEMENTED, `${PROVIDER_ID}:${request?.task ?? 'unknown'}`);
}

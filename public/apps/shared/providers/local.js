/*
 * 無料モード（ブラウザ内ローカル処理）のプロバイダ。**雛形／未実装**
 *
 * ------------------------------------------------------------------
 * Phase 1 時点の状態
 * ------------------------------------------------------------------
 * インターフェースだけを定義してある。run() は NOT_IMPLEMENTED を投げる。
 * 実装は Phase 6。
 *
 * 何を「ローカル処理」とするかは未確定である。少なくとも次の2案がある。
 *
 *   案A: LLMを使わない
 *        既存のブラウザ内処理（全文検索・テキスト抽出・整形）だけで応える。
 *        追加ライブラリ不要。スマートフォンでも確実に動く。
 *
 *   案B: WebGPU でローカルLLMを動かす
 *        数百MBのモデルをダウンロードする必要があり、
 *        スマートフォンでは実質動作しない。
 *        apps/knowledge-src/src/config.js の FEATURE_FLAGS.webgpuLlm が
 *        受け口として用意されているが、既定は false。
 *
 * どちらにするかが決まるまで CAPABILITIES はすべて false にしてある。
 * ------------------------------------------------------------------
 *
 * ------------------------------------------------------------------
 * このプロバイダの約束
 * ------------------------------------------------------------------
 * **外部へ一切送信しない。**
 * このファイルに fetch / XMLHttpRequest / WebSocket / sendBeacon を書かない。
 * モデルファイルの取得が必要になる場合は、
 * 「読み込みが発生すること」を事前に画面で明示してから行うこと。
 *
 * 外部ライブラリの追加は AGENTS.md により事前にユーザーへ確認が必要。
 * ------------------------------------------------------------------
 */

import { AiError, AiErrorCode, AI_TASK } from '../ai-types.js';

export const PROVIDER_ID = 'local';

export const PROVIDER_LABEL = '無料モード（ブラウザ内処理）';

/*
 * 対応タスク。実装が済んだものから true にする。
 * ai-client.js の checkReady() がこの表を見て、
 * 未対応のタスクを実行前に弾く。
 */
export const CAPABILITIES = Object.freeze({
  [AI_TASK.SUMMARIZE]: false,
  [AI_TASK.EXTRACT]: false,
  [AI_TASK.ANSWER]: false,
});

/*
 * このモードが使える状態かどうか。
 * 無料モードは利用者側の設定が要らないため、
 * 実装が済めば常に ok:true を返すようになる。
 */
export function isAvailable() {
  return {
    ok: false,
    reason: '無料モードのAI機能は準備中です。',
    code: AiErrorCode.NOT_IMPLEMENTED,
  };
}

/*
 * 実処理。
 *
 * Phase 6 でここに実装する。実装時の約束:
 *   - 外部送信をしない
 *   - request.signal による中断に対応する
 *   - 重い処理は Web Worker へ逃がし、UIスレッドを止めない
 *     （apps/knowledge-src/src/workers/worker-rpc.js が実例）
 */
export async function run(request) {
  throw new AiError(AiErrorCode.NOT_IMPLEMENTED, `${PROVIDER_ID}:${request?.task ?? 'unknown'}`);
}

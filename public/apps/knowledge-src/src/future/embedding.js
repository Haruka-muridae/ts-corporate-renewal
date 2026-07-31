/*
 * Embedding（将来拡張）の受け口。
 *
 * 現時点では **実装していない**。ここにあるのは、後から Transformers.js を
 * 足すときに触る場所を1か所へ固めておくためのインターフェースだけ。
 *
 * 有効化の条件:
 *   1. src/config.js の FEATURE_FLAGS.embedding を true にする
 *   2. @xenova/transformers（または後継）を依存へ追加する
 *   3. workers/embed.worker.js を追加し、この関数から呼ぶ
 *   4. db/db.js に version(3) で embeddings テーブルを足す
 *
 * 制約: 生成したベクトルも Google Drive へは保存しない（IndexedDB のみ）。
 */

import { FEATURE_FLAGS } from '../config.js';
import { AppError, ErrorCode } from '../core/errors.js';

export function isEmbeddingEnabled() {
  return FEATURE_FLAGS.embedding === true;
}

/* WebGPU の有無を確認する。UI側は非対応でも検索機能を止めないこと。 */
export async function detectWebGpu() {
  if (!('gpu' in navigator)) {
    return { supported: false, reason: 'no_navigator_gpu' };
  }

  try {
    const adapter = await navigator.gpu.requestAdapter();
    return adapter ? { supported: true } : { supported: false, reason: 'no_adapter' };
  } catch (error) {
    return { supported: false, reason: error?.name ?? 'request_failed' };
  }
}

/* チャンク配列 → ベクトル配列。未実装のため呼ぶと明示的に失敗する。 */
export async function embedChunks() {
  if (!isEmbeddingEnabled()) {
    throw new AppError(ErrorCode.UNKNOWN, 'embedding_disabled');
  }

  throw new AppError(ErrorCode.UNKNOWN, 'embedding_not_implemented');
}

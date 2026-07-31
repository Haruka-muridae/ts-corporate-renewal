/*
 * ナレッジ管理アプリが保存したデータの読み出し。
 *
 * ------------------------------------------------------------------
 * 既存のIndexedDBをそのまま使う（新しい保存方式を作らない）
 * ------------------------------------------------------------------
 *   DB名        tsam-knowledge
 *   files       fileId をキーにしたファイル1件
 *   chunks      chunkId をキーにした分割済みテキスト
 *   settings    lastSyncAt などの設定値
 *   searchIndex MiniSearch のシリアライズ済み索引
 *
 * このモジュールは **読み出しだけ** を行う。
 * ナレッジの追加・更新・削除はナレッジ管理画面の責務であり、
 * チャット側から書き換えることはない。
 * ------------------------------------------------------------------
 */

import { db } from '../db/db.js';
import { collectStats, getLastSyncAt, getChunksByFile } from '../db/repo.js';
import { FileSyncState } from '../core/state.js';
import { logger } from '../core/logger.js';
import { toAppError, ErrorCode } from '../core/errors.js';

/*
 * チャット画面のヘッダーに出す集計。
 *
 * 返す値:
 *   { fileCount, indexedFileCount, chunkCount, documentCount, lastSyncAt, hasKnowledge }
 */
export async function loadKnowledgeSummary() {
  try {
    const [stats, lastSyncAt, indexedFileCount] = await Promise.all([
      collectStats(),
      getLastSyncAt(),
      db.files.where('syncState').equals(FileSyncState.INDEXED).count(),
    ]);

    return {
      fileCount: stats?.fileCount ?? 0,
      documentCount: stats?.documentCount ?? 0,
      chunkCount: stats?.chunkCount ?? 0,
      indexedFileCount,
      lastSyncAt: lastSyncAt ?? null,
      hasKnowledge: (stats?.chunkCount ?? 0) > 0,
      error: null,
    };
  } catch (error) {
    const appError = toAppError(error, ErrorCode.DB_OPEN_FAILED);
    logger.error('chat:knowledge-summary-failed', appError, { code: appError.code });

    return {
      fileCount: 0,
      documentCount: 0,
      chunkCount: 0,
      indexedFileCount: 0,
      lastSyncAt: null,
      hasKnowledge: false,
      error: { code: appError.code, message: appError.userMessage },
    };
  }
}

/*
 * 前後のチャンクを取り出す（引用の文脈を補うため）。
 *
 * chunkIndex は同一ファイル内の連番。[fileId+chunkIndex] の複合インデックスがあるので
 * 全件走査せずに引ける。
 */
export async function loadNeighborChunks(fileId, chunkIndex, { before = 1, after = 1 } = {}) {
  const from = Math.max(0, Number(chunkIndex) - Number(before));
  const to = Number(chunkIndex) + Number(after);

  if (!fileId || !Number.isFinite(from) || !Number.isFinite(to)) {
    return [];
  }

  try {
    const rows = await db.chunks
      .where('[fileId+chunkIndex]')
      .between([fileId, from], [fileId, to], true, true)
      .toArray();

    return rows.sort((a, b) => (a.chunkIndex ?? 0) - (b.chunkIndex ?? 0));
  } catch (error) {
    logger.warn('chat:neighbor-chunks-failed', { code: error?.name ?? 'unknown' });
    return [];
  }
}

/* 引用元の表示に使う、ファイル1件のメタデータ。 */
export async function loadFileMeta(fileId) {
  try {
    const row = await db.files.get(fileId);

    if (!row) {
      return null;
    }

    return {
      fileId: row.fileId,
      name: row.name ?? '',
      formatLabel: row.formatLabel ?? '',
      folderName: row.folderName ?? '',
      driveUrl: row.driveUrl ?? '',
      modifiedTime: row.modifiedTime ?? '',
      syncState: row.syncState ?? '',
    };
  } catch (error) {
    logger.warn('chat:file-meta-failed', { code: error?.name ?? 'unknown' });
    return null;
  }
}

export { getChunksByFile };

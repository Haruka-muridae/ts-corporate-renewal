/*
 * 全文検索サービス（メインスレッド側の窓口）。
 *
 * 実際の索引・検索は index.worker.js が行う。ここは
 *   - Worker の生成と生存管理
 *   - IndexedDB との受け渡し（インデックスの保存／復元）
 *   - 抜粋（関連部分）の切り出し
 * を担当する。
 */

import { createWorkerClient } from '../workers/worker-rpc.js';
import { eachChunkBatch, getSearchIndex, putSearchIndex, clearSearchIndex, countChunks } from '../db/repo.js';
import { buildSnippet } from './snippet.js';
import { AppError, ErrorCode, toAppError } from '../core/errors.js';
import { logger } from '../core/logger.js';

const BATCH_SIZE = 300;

const client = createWorkerClient(
  () => new Worker(new URL('../workers/index.worker.js', import.meta.url), { type: 'module' }),
  { name: 'index', defaultTimeoutMs: 180000 },
);

let ready = false;
let readyPromise = null;

/*
 * 検索できる状態にする。
 *   1. 保存済みインデックスがあれば復元する（速い）
 *   2. 無ければチャンクから作り直す
 */
export function ensureReady({ force = false } = {}) {
  if (force) {
    ready = false;
    readyPromise = null;
  }

  if (ready) {
    return Promise.resolve(true);
  }

  if (!readyPromise) {
    readyPromise = (async () => {
      const saved = await getSearchIndex();

      if (!force && saved?.serialized) {
        try {
          const result = await client.call('load', { serialized: saved.serialized });
          ready = true;
          logger.info('search:index-loaded', { count: result.count });
          return true;
        } catch (error) {
          logger.warn('search:index-load-failed', { code: error?.code ?? 'unknown' });
          /* 壊れていた場合は作り直す。 */
        }
      }

      await rebuildIndex();
      return true;
    })();

    readyPromise.catch(() => {
      readyPromise = null;
    });
  }

  return readyPromise;
}

/*
 * IndexedDB のチャンクからインデックスを作り直し、保存する。
 * onProgress({ done, total }) で進捗を返す。
 */
export async function rebuildIndex({ onProgress } = {}) {
  try {
    const total = await countChunks();

    await client.call('reset', {});

    let done = 0;

    await eachChunkBatch(BATCH_SIZE, async (batch) => {
      await client.call('add', {
        chunks: batch.map((chunk) => ({
          chunkId: chunk.chunkId,
          fileId: chunk.fileId,
          fileName: chunk.fileName ?? '',
          folderName: chunk.folderName ?? '',
          heading: chunk.heading ?? '',
          text: chunk.text ?? '',
          chunkIndex: chunk.chunkIndex ?? 0,
          updatedTime: chunk.updatedTime ?? '',
          driveUrl: chunk.driveUrl ?? '',
        })),
      });

      done += batch.length;
      onProgress?.({ done, total });
    });

    const serializedResult = await client.call('serialize', {});
    await putSearchIndex({ serialized: serializedResult.serialized, docCount: serializedResult.count });

    ready = true;
    logger.info('search:index-rebuilt', { count: serializedResult.count });

    return { count: serializedResult.count };
  } catch (error) {
    ready = false;
    const appError = toAppError(error, ErrorCode.INDEX_BUILD_FAILED);
    logger.error('search:index-rebuild-failed', appError, { code: appError.code });
    throw appError;
  }
}

/*
 * 同期の途中で1ファイル分だけ差し替える（全体再構築を避ける）。
 *
 * 戻り値 false は「索引へ反映できなかった」ことを表す。
 * 呼び出し側は、同期の最後に必ず rebuildIndex() を実行すること。
 * ここで false を無視すると、保存済みの古い索引が生き残り、
 * 新しいチャンクが検索に出てこない状態になる。
 */
export async function upsertFileChunks(chunks, previousChunkIds = []) {
  if (!ready) {
    return false;
  }

  try {
    if (previousChunkIds.length > 0) {
      await client.call('remove', { chunkIds: previousChunkIds });
    }

    if (chunks.length > 0) {
      await client.call('add', { chunks });
    }

    return true;
  } catch (error) {
    logger.warn('search:incremental-update-failed', { code: error?.code ?? 'unknown' });
    ready = false;
    return false;
  }
}

export async function removeFileChunks(chunkIds) {
  if (chunkIds.length === 0) {
    return true;
  }

  if (!ready) {
    return false;
  }

  try {
    await client.call('remove', { chunkIds });
    return true;
  } catch (error) {
    logger.warn('search:remove-failed', { code: error?.code ?? 'unknown' });
    ready = false;
    return false;
  }
}

/* 現在のインデックスを保存する（同期完了時に呼ぶ）。 */
export async function persistIndex() {
  if (!ready) {
    return null;
  }

  try {
    const result = await client.call('serialize', {});
    await putSearchIndex({ serialized: result.serialized, docCount: result.count });
    return result.count;
  } catch (error) {
    logger.warn('search:persist-failed', { code: error?.code ?? 'unknown' });
    return null;
  }
}

export async function search(query, { limit = 30 } = {}) {
  const trimmed = String(query ?? '').trim();

  if (trimmed === '') {
    return { hits: [], terms: [], total: 0 };
  }

  await ensureReady();

  const result = await client.call('search', { query: trimmed, limit });

  return {
    total: result.total,
    terms: result.terms,
    hits: result.hits.map((hit) => ({
      ...hit,
      snippet: buildSnippet(hit.text, result.terms),
    })),
  };
}

export async function clearIndex() {
  ready = false;
  readyPromise = null;
  await clearSearchIndex();
  await client.call('reset', {}).catch(() => {});
}

export function terminateSearchWorker() {
  ready = false;
  readyPromise = null;
  client.terminate();
}

/*
 * 接続診断用。一時的なチャンクを索引へ入れて検索し、必ず取り除く。
 *
 * 実データを汚さないよう、chunkId には現実に存在しないファイルIDを使い、
 * 成否にかかわらず finally で削除する。
 */
export async function probeIndex() {
  await ensureReady();

  const stamp = Date.now();
  const chunkId = `__diagnostics__:${stamp}`;
  const keyword = `診断用キーワード${stamp}`;

  try {
    await client.call('add', {
      chunks: [{
        chunkId,
        fileId: '__diagnostics__',
        fileName: '接続診断',
        folderName: '接続診断',
        heading: '接続診断',
        text: `これは接続診断のための一時データです。${keyword}`,
        chunkIndex: 0,
        updatedTime: new Date(stamp).toISOString(),
        driveUrl: '',
      }],
    });

    const result = await client.call('search', { query: keyword, limit: 5 });

    return {
      found: result.hits.some((hit) => hit.chunkId === chunkId),
      documentCount: result.total,
    };
  } finally {
    await client.call('remove', { chunkIds: [chunkId] }).catch(() => {});
  }
}

/* 検索が利用可能かどうか（UIの出し分け用）。 */
export function isReady() {
  return ready;
}

export { AppError, buildSnippet };

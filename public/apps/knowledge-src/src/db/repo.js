/*
 * IndexedDB へのアクセスをここへ集約する。
 * UI・同期エンジン・検索は、Dexie の API を直接触らずこのモジュール経由にする。
 */

import { db, runWrite, SettingKey, SEARCH_INDEX_ID } from './db.js';
import { logger } from '../core/logger.js';
import { CHUNK_DEFAULTS, SYNC_DEFAULTS } from '../config.js';
import { parseSetupRecord } from '../setup/wizard-state.js';

/* ---------- settings ---------- */

export async function getSetting(key, fallback = null) {
  const row = await db.settings.get(key);
  return row === undefined ? fallback : row.value;
}

export async function setSetting(key, value) {
  return runWrite(`settings:${key}`, () => db.settings.put({
    key,
    value,
    updatedAt: new Date().toISOString(),
  }));
}

export async function getSelectedFolder() {
  return getSetting(SettingKey.SELECTED_FOLDER, null);
}

export async function setSelectedFolder(folder) {
  return setSetting(SettingKey.SELECTED_FOLDER, folder);
}

/*
 * セットアップウィザードの状態。
 *
 * 保存するのは進捗フラグと完了時刻だけ。
 * トークン・ファイル本文・個人情報は入れない（全キャッシュ削除でも残す設定領域のため）。
 */
export async function getSetupState() {
  return parseSetupRecord(await getSetting(SettingKey.SETUP_STATE, null));
}

export async function setSetupState(record) {
  return setSetting(SettingKey.SETUP_STATE, record);
}

export async function getChunkOptions() {
  const saved = await getSetting(SettingKey.CHUNK_OPTIONS, null);
  return { ...CHUNK_DEFAULTS, ...(saved ?? {}) };
}

export async function setChunkOptions(options) {
  return setSetting(SettingKey.CHUNK_OPTIONS, options);
}

export async function getSyncOptions() {
  const saved = await getSetting(SettingKey.SYNC_OPTIONS, null);
  return { ...SYNC_DEFAULTS, ...(saved ?? {}) };
}

export async function setSyncOptions(options) {
  return setSetting(SettingKey.SYNC_OPTIONS, options);
}

export async function getLastSyncAt() {
  return getSetting(SettingKey.LAST_SYNC_AT, null);
}

export async function setLastSyncAt(iso) {
  return setSetting(SettingKey.LAST_SYNC_AT, iso);
}

/* ---------- files ---------- */

export async function listFiles() {
  return db.files.orderBy('name').toArray();
}

export async function getFile(fileId) {
  return db.files.get(fileId);
}

export async function putFile(record) {
  return runWrite('files:put', () => db.files.put(record));
}

export async function putFiles(records) {
  return runWrite('files:bulkPut', () => db.files.bulkPut(records));
}

export async function updateFile(fileId, patch) {
  return runWrite('files:update', () => db.files.update(fileId, patch));
}

export async function listFileIds() {
  return db.files.toCollection().primaryKeys();
}

/* ---------- documents ---------- */

export async function getDocument(fileId) {
  return db.documents.get(fileId);
}

export async function putDocument(record) {
  return runWrite('documents:put', () => db.documents.put(record));
}

/* ---------- chunks ---------- */

export async function getChunksByFile(fileId) {
  return db.chunks.where('fileId').equals(fileId).sortBy('chunkIndex');
}

export async function countChunks() {
  return db.chunks.count();
}

/*
 * チャンクを1件以上持つファイルIDの一覧。
 *
 * 差分同期で「変更なし」と判定する前に、実際にチャンクが残っているかを
 * 確かめるために使う。ファイルごとに数えると件数分の問い合わせになるため、
 * インデックスを1回走査してまとめて取る。
 */
export async function listFileIdsWithChunks() {
  return db.chunks.orderBy('fileId').uniqueKeys();
}

/*
 * 1ファイル分のチャンクを差し替える。
 * 「消してから入れる」を1トランザクションで行い、途中失敗で欠損させない。
 */
export async function replaceChunks(fileId, chunks) {
  return runWrite('chunks:replace', () => db.transaction('rw', db.chunks, async () => {
    await db.chunks.where('fileId').equals(fileId).delete();
    if (chunks.length > 0) {
      await db.chunks.bulkPut(chunks);
    }
  }));
}

/*
 * 検索インデックス構築用に、全チャンクを取得する。
 * 件数が多い場合に備えてページングで読む（一度に全部を配列化しない）。
 */
export async function eachChunkBatch(batchSize, handler) {
  let offset = 0;

  for (;;) {
    /* eslint-disable-next-line no-await-in-loop */
    const batch = await db.chunks.offset(offset).limit(batchSize).toArray();

    if (batch.length === 0) {
      return;
    }

    /* eslint-disable-next-line no-await-in-loop */
    await handler(batch);
    offset += batch.length;

    if (batch.length < batchSize) {
      return;
    }
  }
}

/* ---------- searchIndex ---------- */

export async function getSearchIndex() {
  return db.searchIndex.get(SEARCH_INDEX_ID);
}

export async function putSearchIndex({ serialized, docCount }) {
  return runWrite('searchIndex:put', () => db.searchIndex.put({
    id: SEARCH_INDEX_ID,
    serialized,
    docCount,
    builtAt: new Date().toISOString(),
  }));
}

export async function clearSearchIndex() {
  return runWrite('searchIndex:clear', () => db.searchIndex.clear());
}

/* ---------- syncLogs ---------- */

export async function listLogs(limit = 300) {
  return db.syncLogs.orderBy('id').reverse().limit(limit).toArray();
}

export async function clearLogs() {
  return runWrite('syncLogs:clear', () => db.syncLogs.clear());
}

/* 古いログを間引く（無制限に増やさない）。 */
export async function trimLogs(keep = 2000) {
  const total = await db.syncLogs.count();

  if (total <= keep) {
    return 0;
  }

  const removable = total - keep;
  const ids = await db.syncLogs.orderBy('id').limit(removable).primaryKeys();
  await runWrite('syncLogs:trim', () => db.syncLogs.bulkDelete(ids));
  return ids.length;
}

/* ---------- 削除操作 ---------- */

/* ファイル1件に紐づくデータをすべて消す（Drive上の削除に追随する場合も使う）。 */
export async function deleteFileData(fileId) {
  return runWrite('file:delete', () => db.transaction('rw', db.files, db.documents, db.chunks, async () => {
    await db.chunks.where('fileId').equals(fileId).delete();
    await db.documents.delete(fileId);
    await db.files.delete(fileId);
  }));
}

/* 抽出結果だけ捨てて、次回の同期で必ず作り直させる（再同期用）。 */
export async function resetFileCache(fileId) {
  return runWrite('file:reset', () => db.transaction('rw', db.files, db.documents, db.chunks, async () => {
    await db.chunks.where('fileId').equals(fileId).delete();
    await db.documents.delete(fileId);
    await db.files.update(fileId, {
      contentHash: '',
      lastSyncedAt: null,
      syncState: 'pending',
      errorCode: '',
      errorMessage: '',
    });
  }));
}

/*
 * 親（files 行）を失ったデータを掃除する。
 *
 * 削除は1トランザクションで行っているため通常は発生しないが、
 * 旧バージョンからの移行や、ブラウザ側の異常終了で取り残される可能性がある。
 * 残ると「一覧に無いのに検索へ出てくる」「使用量だけ増える」状態になるため、
 * 同期の最後に必ず確認する。
 *
 * 戻り値: { chunkIds, documentIds } 取り除いたもの（索引からも消すため呼び出し側で使う）
 */
export async function cleanupOrphans() {
  const knownIds = new Set(await db.files.toCollection().primaryKeys());

  const chunkOwners = await db.chunks.orderBy('fileId').uniqueKeys();
  const orphanChunkOwners = chunkOwners.filter((fileId) => !knownIds.has(fileId));

  const documentIds = await db.documents.toCollection().primaryKeys();
  const orphanDocumentIds = documentIds.filter((fileId) => !knownIds.has(fileId));

  if (orphanChunkOwners.length === 0 && orphanDocumentIds.length === 0) {
    return { chunkIds: [], documentIds: [] };
  }

  const chunkIds = [];

  for (const fileId of orphanChunkOwners) {
    /* eslint-disable-next-line no-await-in-loop */
    const keys = await db.chunks.where('fileId').equals(fileId).primaryKeys();
    chunkIds.push(...keys);
  }

  await runWrite('orphans:cleanup', () => db.transaction('rw', db.chunks, db.documents, async () => {
    if (chunkIds.length > 0) {
      await db.chunks.bulkDelete(chunkIds);
    }
    if (orphanDocumentIds.length > 0) {
      await db.documents.bulkDelete(orphanDocumentIds);
    }
  }));

  logger.warn('db:orphans-removed', { chunks: chunkIds.length, documents: orphanDocumentIds.length });

  return { chunkIds, documentIds: orphanDocumentIds };
}

/* 全キャッシュ削除。settings（選択フォルダ等）は残すか消すかを選べる。 */
export async function clearAllCache({ keepSettings = true } = {}) {
  return runWrite('cache:clear-all', () => db.transaction(
    'rw',
    db.files, db.documents, db.chunks, db.searchIndex, db.syncLogs, db.settings,
    async () => {
      await db.chunks.clear();
      await db.documents.clear();
      await db.files.clear();
      await db.searchIndex.clear();
      await db.syncLogs.clear();

      if (!keepSettings) {
        await db.settings.clear();
      } else {
        await db.settings.delete(SettingKey.LAST_SYNC_AT);
      }
    },
  ));
}

/* ---------- 集計 ---------- */

/*
 * ストレージ画面向けの集計。
 * navigator.storage.estimate() は「オリジン全体」の概算であり、
 * このDBだけの正確な使用量ではない。画面ではその旨を明記する。
 */
export async function collectStats() {
  const [fileCount, documentCount, chunkCount, lastSyncAt, indexRow] = await Promise.all([
    db.files.count(),
    db.documents.count(),
    db.chunks.count(),
    getLastSyncAt(),
    getSearchIndex(),
  ]);

  let usage = null;
  let quota = null;

  if (navigator.storage?.estimate) {
    try {
      const estimate = await navigator.storage.estimate();
      usage = Number.isFinite(estimate.usage) ? estimate.usage : null;
      quota = Number.isFinite(estimate.quota) ? estimate.quota : null;
    } catch (error) {
      logger.warn('storage:estimate-failed', { name: error?.name ?? 'unknown' });
    }
  }

  /* 抽出テキストの総文字数（保存量の目安）。 */
  let totalChars = 0;
  await db.documents.each((doc) => {
    totalChars += Number(doc.charCount) || 0;
  });

  return {
    fileCount,
    documentCount,
    chunkCount,
    totalChars,
    lastSyncAt,
    indexBuiltAt: indexRow?.builtAt ?? null,
    indexDocCount: indexRow?.docCount ?? 0,
    usage,
    quota,
    free: usage !== null && quota !== null ? Math.max(0, quota - usage) : null,
  };
}

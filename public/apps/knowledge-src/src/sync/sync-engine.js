/*
 * 差分同期エンジン。
 *
 * ------------------------------------------------------------------
 * 差分判定の方針
 * ------------------------------------------------------------------
 * 再取得・再解析を避けるため、次の条件がすべて揃ったときだけ「変わっていない」とする。
 *   1. Drive の modifiedTime が前回と同じ
 *   2. version（Driveのリビジョン番号）が同じ
 *   3. 前回の同期が成功している（syncState が indexed）
 *   4. チャンクが実際に残っている
 *   5. 抽出テキストが IndexedDB にある
 * いずれかが欠けたら再取得する。4 と 5 を見るのは、保存が途中で失敗した場合に
 * 「検索へ出てこないまま変更なしと判定され続ける」ことを防ぐため。
 *
 * 取得後は抽出テキストの SHA-256（contentHash）を比べ、
 * 内容が同じならチャンク分割と索引更新を省く。
 * （Driveの更新日時だけが変わるケースが実際に多いため。）
 * ただしファイル名やフォルダ名は検索対象なので、
 * 内容が同じでもメタデータだけは更新する。
 *
 * Drive 側で消えたファイルは、IndexedDB からも関連データを削除する。
 * ------------------------------------------------------------------
 *
 * Drive への書き込みは一切行わない。抽出結果はブラウザ内にのみ保存する。
 */

import {
  collectFolderTree, exportGoogleDoc, downloadFile,
} from '../drive/drive-client.js';
import { classifyFile, formatLabel, ParseKind } from './file-types.js';
import { createWorkerClient } from '../workers/worker-rpc.js';
import { attachChunkMetadata } from '../text/chunk.js';
import {
  listFiles, putFile, updateFile, deleteFileData,
  getDocument, putDocument, replaceChunks, getChunksByFile,
  getChunkOptions, getSyncOptions, setLastSyncAt, listFileIdsWithChunks, cleanupOrphans,
} from '../db/repo.js';
import {
  upsertFileChunks, removeFileChunks, persistIndex, rebuildIndex,
} from '../search/search-service.js';
import { FileSyncState } from '../core/state.js';
import { AppError, ErrorCode, toAppError } from '../core/errors.js';
import { logger } from '../core/logger.js';
import { safeDriveUrl } from '../core/dom.js';
import { getPdfAssetUrls } from '../config.js';

const parseClient = createWorkerClient(
  () => new Worker(new URL('../workers/parse.worker.js', import.meta.url), { type: 'module' }),
  { name: 'parse', defaultTimeoutMs: 300000 },
);

export function terminateParseWorker() {
  parseClient.terminate();
}

/* 実行中の処理。二重起動を防ぐ。 */
let running = null;

export function isSyncing() {
  return running !== null;
}

export function cancelSync() {
  running?.controller.abort();
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw new AppError(ErrorCode.CANCELLED, 'aborted');
  }
}

function emptySummary() {
  return {
    scanned: 0, added: 0, updated: 0, unchanged: 0,
    skipped: 0, deleted: 0, failed: 0, cancelled: false,
    orphansRemoved: 0,
    indexNeedsRebuild: false,
  };
}

/*
 * ---- 走査（取得・解析はしない） ----
 *
 * Drive の一覧を取り、ローカルとの差分を判定して files テーブルへ反映する。
 * 解析が必要なファイルを tasks として返す。
 *
 * runSync（同期）と previewFolder（一覧のみ）の共通処理。
 * ここを分けておくことで、フォルダを選んだ直後に
 * 「何が対象か」だけを素早く表示できる。
 */
async function scanFolder({ folder, force, syncOptions, signal, onProgress, onFileDone, summary }) {
  onProgress?.({ phase: 'listing', done: 0, total: 0, currentName: folder.name ?? '' });

  /* ---- 1. Drive 側の一覧を取得 ---- */
  const remoteFiles = await collectFolderTree({
    folderId: folder.id,
    folderName: folder.name ?? '',
    recursive: syncOptions.recursive,
    maxDepth: syncOptions.maxDepth,
    pageSize: syncOptions.pageSize,
    signal,
    onProgress: (info) => onProgress?.({
      phase: 'listing', done: info.scanned, total: 0, currentName: info.folder,
    }),
  });

  summary.scanned = remoteFiles.length;
  logger.info('sync:listed', { count: remoteFiles.length, recursive: syncOptions.recursive });

  /* ---- 2. ローカルとの差分 ---- */
  const localFiles = await listFiles();
  const localById = new Map(localFiles.map((file) => [file.fileId, file]));
  const remoteIds = new Set(remoteFiles.map((file) => file.id));

  /*
   * チャンクが実際に残っているファイルの一覧。
   * 「変更なし」と判定してよいのは、チャンクまで揃っている場合だけ。
   * 揃っていなければ検索へ出てこないため、取り直す必要がある。
   */
  const withChunks = new Set(await listFileIdsWithChunks());

  /* Drive から消えたもの（別フォルダへ移動した場合も含む）を削除する。 */
  for (const local of localFiles) {
    if (remoteIds.has(local.fileId)) {
      continue;
    }

    const chunkIds = (await getChunksByFile(local.fileId)).map((chunk) => chunk.chunkId);
    await deleteFileData(local.fileId);

    if (!await removeFileChunks(chunkIds)) {
      summary.indexNeedsRebuild = true;
    }

    summary.deleted += 1;
    logger.info('sync:file-deleted', { name: local.name }, { fileId: local.fileId });
  }

  /* ---- 3. 対象を決める ---- */
  const tasks = [];

  for (const remote of remoteFiles) {
    throwIfAborted(signal);

    const local = localById.get(remote.id);
    const classification = classifyFile(remote);

    const base = {
      fileId: remote.id,
      name: String(remote.name ?? ''),
      mimeType: String(remote.mimeType ?? ''),
      formatLabel: formatLabel(remote),
      size: Number(remote.size) || 0,
      modifiedTime: String(remote.modifiedTime ?? ''),
      version: String(remote.version ?? ''),
      md5Checksum: String(remote.md5Checksum ?? ''),
      driveUrl: safeDriveUrl(remote.webViewLink) ?? '',
      folderId: String(remote.folderId ?? folder.id),
      folderName: String(remote.folderName ?? folder.name ?? ''),
      isKnowledge: classification.kind !== null ? 1 : 0,
      contentHash: local?.contentHash ?? '',
      lastSyncedAt: local?.lastSyncedAt ?? null,
      errorCode: '',
      errorMessage: '',
      syncState: FileSyncState.PENDING,
      /* 統計は再解析するまで前回値を保つ（一覧の表示が消えないように）。 */
      charCount: local?.charCount ?? 0,
      chunkCount: local?.chunkCount ?? 0,
      pageCount: local?.pageCount ?? null,
    };

    /* 対象外の形式は取得せず、理由だけ残す。 */
    if (classification.kind === null) {
      base.syncState = FileSyncState.SKIPPED;
      base.errorMessage = classification.reason;
      await putFile(base);
      summary.skipped += 1;
      onFileDone?.(base);
      continue;
    }

    /* サイズ上限。取得前に弾く。 */
    if (base.size > syncOptions.maxFileBytes) {
      base.syncState = FileSyncState.ERROR;
      base.errorCode = ErrorCode.FILE_TOO_LARGE;
      base.errorMessage = 'ファイルサイズが上限を超えています。';
      await putFile(base);
      summary.skipped += 1;
      onFileDone?.(base);
      continue;
    }

    /* 差分判定。 */
    const unchanged = !force
      && local
      && local.modifiedTime === base.modifiedTime
      && local.version === base.version
      && local.syncState === FileSyncState.INDEXED
      && withChunks.has(remote.id)
      && Boolean(await getDocument(remote.id));

    if (unchanged) {
      base.syncState = FileSyncState.INDEXED;
      base.lastSyncedAt = local.lastSyncedAt;
      await putFile(base);
      summary.unchanged += 1;
      onFileDone?.(base);
      continue;
    }

    /* 解析待ちとして先に保存しておく（一覧へすぐ出す）。 */
    await putFile(base);
    onFileDone?.(base);

    /*
     * 「新規」は "一度も同期できていない" こと。
     * previewFolder（一覧のみ取得）で行だけ作られている場合があるため、
     * 行の有無ではなく lastSyncedAt の有無で判定する。
     */
    tasks.push({ record: base, classification, isNew: !local?.lastSyncedAt });
  }

  return tasks;
}

/*
 * フォルダの中身を一覧表示するだけ。取得も解析も行わない。
 * ログイン直後、対象フォルダが決まった時点で呼ぶ。
 */
export async function previewFolder({ folder, onProgress, onFileDone } = {}) {
  if (running) {
    throw new AppError(ErrorCode.UNKNOWN, 'sync_in_progress');
  }

  if (!folder?.id) {
    throw new AppError(ErrorCode.UNKNOWN, 'folder_missing');
  }

  const controller = new AbortController();
  running = { controller };

  const summary = emptySummary();

  try {
    const syncOptions = await getSyncOptions();

    const tasks = await scanFolder({
      folder,
      force: false,
      syncOptions,
      signal: controller.signal,
      onProgress,
      onFileDone,
      summary,
    });

    logger.info('sync:preview', { scanned: summary.scanned, pending: tasks.length });

    return { ...summary, pending: tasks.length };
  } catch (error) {
    if (error?.code === ErrorCode.CANCELLED) {
      return { ...summary, cancelled: true, pending: 0 };
    }

    const appError = toAppError(error, ErrorCode.DRIVE_API_ERROR);
    logger.error('sync:preview-failed', appError, { code: appError.code });
    throw appError;
  } finally {
    running = null;
  }
}

/*
 * 同期を実行する。
 *
 * params:
 *   folder      … { id, name }
 *   onProgress  … ({ phase, done, total, currentName }) => void
 *   onFileDone  … (fileRecord) => void   一覧の逐次更新用
 *   force       … true なら差分判定を無視してすべて再解析する
 */
export async function runSync({ folder, onProgress, onFileDone, force = false } = {}) {
  if (running) {
    throw new AppError(ErrorCode.UNKNOWN, 'sync_in_progress');
  }

  if (!folder?.id) {
    throw new AppError(ErrorCode.UNKNOWN, 'folder_missing');
  }

  const controller = new AbortController();
  running = { controller };

  const summary = emptySummary();

  try {
    const [chunkOptions, syncOptions] = await Promise.all([getChunkOptions(), getSyncOptions()]);

    const tasks = await scanFolder({
      folder,
      force,
      syncOptions,
      signal: controller.signal,
      onProgress,
      onFileDone,
      summary,
    });

    /* ---- 4. 取得と解析 ---- */
    const total = tasks.length;
    let done = 0;

    onProgress?.({ phase: 'parsing', done: 0, total, currentName: '' });

    const concurrency = Math.max(1, Math.min(Number(syncOptions.concurrency) || 2, 4));
    const queue = tasks.slice();

    const consume = async () => {
      for (;;) {
        const task = queue.shift();

        if (!task) {
          return;
        }

        throwIfAborted(controller.signal);
        onProgress?.({ phase: 'parsing', done, total, currentName: task.record.name });

        try {
          const changed = await processFile(task, {
            chunkOptions,
            signal: controller.signal,
            onFileDone,
            summary,
          });

          if (task.isNew) {
            summary.added += 1;
          } else if (changed) {
            summary.updated += 1;
          } else {
            summary.unchanged += 1;
          }
        } catch (error) {
          if (error?.code === ErrorCode.CANCELLED) {
            throw error;
          }

          const appError = toAppError(error, ErrorCode.DRIVE_FETCH_FAILED);
          summary.failed += 1;

          const failed = {
            ...task.record,
            syncState: FileSyncState.ERROR,
            errorCode: appError.code,
            errorMessage: appError.userMessage,
          };

          await putFile(failed).catch(() => {});
          onFileDone?.(failed);

          logger.error('sync:file-failed', appError, {
            fileId: task.record.fileId,
            code: appError.code,
          });
        } finally {
          done += 1;
          onProgress?.({ phase: 'parsing', done, total, currentName: task.record.name });
        }
      }
    };

    await Promise.all(Array.from({ length: concurrency }, consume));

    /* ---- 5. 取り残されたデータの掃除 ---- */
    const orphans = await cleanupOrphans();

    if (orphans.chunkIds.length > 0) {
      summary.orphansRemoved = orphans.chunkIds.length;
      if (!await removeFileChunks(orphans.chunkIds)) {
        summary.indexNeedsRebuild = true;
      }
    }

    /* ---- 6. 索引の保存 ---- */
    onProgress?.({ phase: 'indexing', done: total, total, currentName: '' });

    if (summary.indexNeedsRebuild) {
      /* 差分反映できなかった分があるので、チャンク全体から作り直す。 */
      await rebuildIndex({
        onProgress: ({ done: built, total: all }) => {
          onProgress?.({ phase: 'indexing', done: built, total: all, currentName: '' });
        },
      });
    } else {
      await persistIndex();
    }

    const finishedAt = new Date().toISOString();
    await setLastSyncAt(finishedAt);

    logger.info('sync:completed', summary);
    return { ...summary, finishedAt };
  } catch (error) {
    if (error?.code === ErrorCode.CANCELLED) {
      summary.cancelled = true;
      logger.warn('sync:cancelled', summary);
      return { ...summary, finishedAt: new Date().toISOString() };
    }

    const appError = toAppError(error, ErrorCode.DRIVE_API_ERROR);
    logger.error('sync:failed', appError, { code: appError.code });
    throw appError;
  } finally {
    running = null;
  }
}

/* 1ファイルの取得・解析・保存。戻り値は「内容が変わったか」。 */
async function processFile(task, { chunkOptions, signal, onFileDone, summary }) {
  const { record, classification } = task;

  await putFile({ ...record, syncState: FileSyncState.FETCHING });
  onFileDone?.({ ...record, syncState: FileSyncState.FETCHING });

  /* 取得。Googleドキュメントだけ export、それ以外は本体をそのまま取る。 */
  let payload;

  if (classification.transport === 'export') {
    const text = await exportGoogleDoc(record.fileId, signal);
    payload = { kind: ParseKind.GDOC, text };
  } else {
    const buffer = await downloadFile(record.fileId, signal);
    payload = { kind: classification.kind, buffer };
  }

  throwIfAborted(signal);

  await putFile({ ...record, syncState: FileSyncState.PARSING });
  onFileDone?.({ ...record, syncState: FileSyncState.PARSING });

  /* 解析はすべて Worker 側。ArrayBuffer は転送して複製を避ける。 */
  const result = await parseClient.call('parse', {
    fileId: record.fileId,
    fileName: record.name,
    kind: payload.kind,
    text: payload.text,
    buffer: payload.buffer,
    chunkOptions,
    /* Worker では基準URLを解決できないため、ここで算出して渡す。 */
    pdfAssets: getPdfAssetUrls(),
  }, {
    transfer: payload.buffer ? [payload.buffer] : [],
    signal,
  });

  throwIfAborted(signal);

  const contentChanged = result.contentHash !== record.contentHash;

  /*
   * 保存の順序（重要）
   *
   * チャンク → 検索索引 → 抽出テキスト → ファイル行 の順に書く。
   *
   * 先に「新しい内容ハッシュ」を保存してしまうと、チャンクの保存に失敗した場合に
   * 「ハッシュは新しいがチャンクは古い（または無い）」状態が固定され、
   * 次回以降の同期でも変更なしと判定されて永久に直らない。
   * ハッシュの記録を最後にすることで、途中で失敗しても次回やり直せる。
   */
  const previousChunks = await getChunksByFile(record.fileId);
  const previousChunkIds = previousChunks.map((chunk) => chunk.chunkId);

  /*
   * チャンクを作り直す条件。
   *   - 本文が変わった
   *   - 本文は同じだが、何らかの理由でチャンクが失われている
   *     （保存の途中で失敗した場合など。ここで拾わないと、内容ハッシュが
   *      一致し続ける限り永久に検索へ出てこない。）
   */
  if (contentChanged || previousChunks.length === 0) {
    const chunks = attachChunkMetadata(result.chunks, {
      fileId: record.fileId,
      fileName: record.name,
      updatedTime: record.modifiedTime,
      driveUrl: record.driveUrl,
    }).map((chunk) => ({ ...chunk, folderName: record.folderName }));

    await replaceChunks(record.fileId, chunks);

    if (!await upsertFileChunks(chunks, previousChunkIds)) {
      summary.indexNeedsRebuild = true;
    }
  } else {
    /*
     * 本文が同じでも、ファイル名・フォルダ名・Driveリンク・更新日時は変わりうる。
     * ファイル名とフォルダ名は検索対象、Driveリンクは結果表示に使うため、
     * 作り直さずにメタデータだけ入れ替える。
     * （これをしないと、名前を変えたファイルが新しい名前で検索できない。）
     */
    const isStale = previousChunks.some((chunk) => chunk.fileName !== record.name
      || chunk.folderName !== record.folderName
      || chunk.driveUrl !== record.driveUrl
      || chunk.updatedTime !== record.modifiedTime);

    if (isStale) {
      const refreshed = previousChunks.map((chunk) => ({
        ...chunk,
        fileName: record.name,
        folderName: record.folderName,
        driveUrl: record.driveUrl,
        updatedTime: record.modifiedTime,
      }));

      await replaceChunks(record.fileId, refreshed);

      if (!await upsertFileChunks(refreshed, previousChunkIds)) {
        summary.indexNeedsRebuild = true;
      }

      logger.info('sync:chunk-metadata-refreshed', { name: record.name, count: refreshed.length }, { fileId: record.fileId });
    }
  }

  /* 抽出テキストは IndexedDB のみへ保存する（Drive へは戻さない）。 */
  await putDocument({
    fileId: record.fileId,
    text: result.text,
    charCount: result.charCount,
    contentHash: result.contentHash,
    updatedAt: new Date().toISOString(),
    sourceKind: payload.kind,
  });

  const updated = {
    ...record,
    syncState: FileSyncState.INDEXED,
    contentHash: result.contentHash,
    charCount: result.charCount,
    chunkCount: result.stats?.chunkCount ?? 0,
    pageCount: result.stats?.pageCount ?? null,
    lastSyncedAt: new Date().toISOString(),
    errorCode: '',
    errorMessage: '',
  };

  await putFile(updated);
  onFileDone?.(updated);

  logger.info('sync:file-indexed', {
    name: record.name,
    chars: result.charCount,
    chunks: result.stats?.chunkCount ?? 0,
    changed: contentChanged,
  }, { fileId: record.fileId });

  return contentChanged;
}

/*
 * 1ファイルだけ再同期する。ファイル管理画面の「再同期」から呼ぶ。
 * 実装を単純に保つため、対象ファイルのキャッシュを捨てて全体同期へ委ねる。
 */
export async function resyncFile(fileId) {
  const chunkIds = (await getChunksByFile(fileId)).map((chunk) => chunk.chunkId);
  await removeFileChunks(chunkIds);
  await updateFile(fileId, {
    contentHash: '',
    syncState: FileSyncState.PENDING,
    errorCode: '',
    errorMessage: '',
  });
}

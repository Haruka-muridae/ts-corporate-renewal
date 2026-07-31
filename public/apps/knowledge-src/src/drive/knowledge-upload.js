/*
 * 端末から選んだナレッジを、固定された 01_ナレッジ 配下へ新規追加する。
 *
 * - 呼び出し側から渡された固定フォルダID以外を起点にしない
 * - 既存ファイルは上書きせず、同名は「(1)」付きの別名にする
 * - フォルダ選択では不足するサブフォルダだけを作る
 * - 書き込みトークンは処理中だけ取得し、finallyで必ず破棄する
 */

import { requestWriteToken, discardWriteToken } from '../auth/google-auth.js';
import { AppError, ErrorCode, toAppError } from '../core/errors.js';
import { logger } from '../core/logger.js';
import { listFilesInFolder } from './drive-client.js';
import { createFolder, createKnowledgeFile } from './drive-writer.js';
import { chooseAvailableName, UploadSupport } from './upload-plan.js';

const LOCK_NAME = 'tsam-knowledge-file-upload';
let uploading = false;

export function isUploadingKnowledge() {
  return uploading;
}

export async function uploadKnowledge({
  folderId,
  entries,
  signal,
  onProgress,
  isBusy,
} = {}) {
  if (uploading) {
    return failure(new AppError(ErrorCode.UPLOAD_IN_PROGRESS, 'same_tab'));
  }

  if (!folderId || !Array.isArray(entries) || entries.length === 0) {
    return failure(new AppError(ErrorCode.UPLOAD_INVALID_FILE, 'empty_plan'));
  }

  if (typeof isBusy === 'function' && isBusy()) {
    return failure(new AppError(ErrorCode.UPLOAD_IN_PROGRESS, 'busy'));
  }

  uploading = true;

  try {
    return await withCrossTabLock(() => run({
      folderId: String(folderId), entries, signal, onProgress, isBusy,
    }));
  } catch (error) {
    return failure(toAppError(error, ErrorCode.UPLOAD_FAILED));
  } finally {
    uploading = false;
    discardWriteToken();
  }
}

async function withCrossTabLock(task) {
  const locks = globalThis.navigator?.locks;

  if (!locks || typeof locks.request !== 'function') {
    return task();
  }

  return locks.request(LOCK_NAME, { ifAvailable: true }, async (lock) => (
    lock ? task() : failure(new AppError(ErrorCode.UPLOAD_IN_PROGRESS, 'other_tab'))
  ));
}

async function run({ folderId, entries, signal, onProgress, isBusy }) {
  report(onProgress, {
    phase: 'authorizing', done: 0, total: entries.length, currentName: '',
  });

  try {
    await requestWriteToken();
  } catch (error) {
    return failure(toAppError(error, ErrorCode.WRITE_SCOPE_NOT_GRANTED));
  }

  /*
   * path key → { id, children }
   * children はそのフォルダ直下の最新一覧。作成した項目も逐次足し、
   * 同一バッチ内の重複を防ぐ。
   */
  const folders = new Map();
  folders.set('', { id: folderId, children: null });

  const uploaded = [];
  const failed = [];
  const skipped = [];

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];

    if (signal?.aborted) {
      skipped.push({ entry, error: new AppError(ErrorCode.CANCELLED, 'aborted') });
      continue;
    }

    if (typeof isBusy === 'function' && isBusy()) {
      skipped.push({ entry, error: new AppError(ErrorCode.UPLOAD_IN_PROGRESS, 'busy') });
      continue;
    }

    report(onProgress, {
      phase: 'uploading',
      done: index,
      total: entries.length,
      currentName: entry.relativePath,
      itemId: entry.id,
      itemStatus: 'uploading',
    });

    try {
      /* eslint-disable-next-line no-await-in-loop */
      const parent = await ensurePath({
        rootId: folderId,
        folders,
        parts: entry.folders,
        signal,
      });

      /* eslint-disable-next-line no-await-in-loop */
      const children = await getChildren(parent, signal);
      const occupied = new Set(children.map((child) => String(child.name)));
      const uploadName = chooseAvailableName(entry.safeName, occupied);

      if (!uploadName) {
        throw new AppError(ErrorCode.UPLOAD_INVALID_FILE, 'duplicate_name_exhausted');
      }

      /* eslint-disable-next-line no-await-in-loop */
      const resource = await createKnowledgeFile({
        name: uploadName,
        parentId: parent.id,
        mimeType: entry.mimeType,
        file: entry.file,
        signal,
      });

      children.push({
        id: resource.id,
        name: resource.name,
        mimeType: resource.mimeType,
        webViewLink: resource.webViewLink,
      });

      const item = {
        entry,
        file: resource,
        uploadName,
        renamed: uploadName !== entry.safeName,
        parseable: entry.support === UploadSupport.PARSEABLE,
      };
      uploaded.push(item);

      report(onProgress, {
        phase: 'uploading',
        done: index + 1,
        total: entries.length,
        currentName: entry.relativePath,
        itemId: entry.id,
        itemStatus: 'saved',
        uploadName,
        fileId: resource.id,
      });
    } catch (error) {
      const appError = toAppError(error, ErrorCode.UPLOAD_FAILED);
      failed.push({ entry, error: appError });

      report(onProgress, {
        phase: 'uploading',
        done: index + 1,
        total: entries.length,
        currentName: entry.relativePath,
        itemId: entry.id,
        itemStatus: 'failed',
        error: {
          code: appError.code,
          userMessage: appError.userMessage,
        },
      });

      if (isFatal(appError)) {
        for (let rest = index + 1; rest < entries.length; rest += 1) {
          skipped.push({ entry: entries[rest], error: appError });
        }
        break;
      }
    }
  }

  const ok = failed.length === 0 && skipped.length === 0;

  logger.info('knowledge-upload:done', {
    selected: entries.length,
    uploaded: uploaded.length,
    failed: failed.length,
    skipped: skipped.length,
    renamed: uploaded.filter((item) => item.renamed).length,
  });

  return {
    ok,
    uploaded,
    failed,
    skipped,
    error: ok ? null : new AppError(ErrorCode.UPLOAD_FAILED, 'partial'),
  };
}

async function ensurePath({ rootId, folders, parts, signal }) {
  let key = '';
  let current = folders.get('');

  for (const part of parts) {
    const nextKey = key ? `${key}/${part}` : part;
    const cached = folders.get(nextKey);

    if (cached) {
      current = cached;
      key = nextKey;
      continue;
    }

    /* eslint-disable-next-line no-await-in-loop */
    const children = await getChildren(current, signal);
    const exact = children.filter((child) => (
      child.mimeType === 'application/vnd.google-apps.folder'
      && String(child.name) === part
    ));

    if (exact.length > 1) {
      throw new AppError(ErrorCode.FOLDER_CREATE_AMBIGUOUS, part);
    }

    let folder;

    if (exact.length === 1) {
      folder = exact[0];
    } else {
      /* eslint-disable-next-line no-await-in-loop */
      folder = await createFolder({ name: part, parentId: current.id, signal });
      children.push(folder);
    }

    current = { id: String(folder.id), children: null };
    folders.set(nextKey, current);
    key = nextKey;
  }

  return current?.id ? current : { id: rootId, children: null };
}

async function getChildren(folder, signal) {
  if (Array.isArray(folder.children)) {
    return folder.children;
  }

  const children = [];
  let pageToken;

  do {
    /* eslint-disable-next-line no-await-in-loop */
    const page = await listFilesInFolder({
      folderId: folder.id,
      pageToken,
      pageSize: 100,
      signal,
    });
    children.push(...page.files);
    pageToken = page.nextPageToken;
  } while (pageToken);

  folder.children = children;
  return children;
}

function isFatal(error) {
  return error?.code === ErrorCode.AUTH_EXPIRED
    || error?.code === ErrorCode.WRITE_SCOPE_NOT_GRANTED
    || error?.code === ErrorCode.DRIVE_PERMISSION_DENIED
    || error?.code === ErrorCode.DRIVE_API_DISABLED
    || error?.code === ErrorCode.CANCELLED;
}

function report(onProgress, value) {
  if (typeof onProgress !== 'function') {
    return;
  }
  try {
    onProgress(value);
  } catch {
    /* 表示側の例外でアップロードを止めない。 */
  }
}

function failure(error) {
  return {
    ok: false, uploaded: [], failed: [], skipped: [], error,
  };
}

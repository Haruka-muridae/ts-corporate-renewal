/*
 * エントリポイント。
 *
 * ここが唯一の「副作用のある場所」で、他のモジュールは純粋な部品として保つ。
 *   1. IndexedDB を開く
 *   2. 保存済みの選択フォルダ・統計を読み込む
 *   3. 操作（actions）を組み立てて画面へ渡す
 *
 * 起動時に外部通信は行わない。Googleへの接続は利用者が
 * 「Googleでログイン」を押したときに初めて発生する。
 */

import './styles.css';

import { createStore, AppState } from './core/state.js';
import { logger } from './core/logger.js';
import { toAppError, ErrorCode, AppError } from './core/errors.js';
import { isClientIdConfigured, KNOWLEDGE_FOLDER_PATH, DRIVE_ROOT_LABEL } from './config.js';

import { openDb } from './db/db.js';
import {
  listFiles, collectStats, getSelectedFolder, setSelectedFolder,
  deleteFileData, getChunksByFile, clearAllCache, trimLogs, cleanupOrphans,
} from './db/repo.js';

import {
  ensureAccessToken, signOut as authSignOut, subscribeAuth, hasValidAccessToken,
} from './auth/google-auth.js';
import { fetchAbout } from './drive/drive-client.js';
import { isPickerAvailable, pickFolder } from './drive/picker.js';
import { resolveKnowledgeFolder, PathResolveStatus, formatPath } from './drive/folder-path.js';
import { openFolderBrowser } from './ui/folder-browser.js';

import {
  runSync, previewFolder, cancelSync, resyncFile, isSyncing, terminateParseWorker,
} from './sync/sync-engine.js';
import {
  rebuildIndex, removeFileChunks, clearIndex, ensureReady, terminateSearchWorker,
} from './search/search-service.js';

import { mountApp } from './ui/app.js';

const store = createStore();

/* ---------- 補助 ---------- */

async function refreshFiles() {
  try {
    store.patch({ files: await listFiles() });
  } catch (error) {
    reportError(error, 'files:list-failed');
  }
}

async function refreshStats() {
  try {
    store.patch({ stats: await collectStats() });
  } catch (error) {
    reportError(error, 'stats:collect-failed');
  }
}

function reportError(error, event) {
  const appError = toAppError(error);

  if (appError.code === ErrorCode.CANCELLED) {
    store.setAppState(AppState.CANCELLED);
    store.patch({ progress: null });
    return appError;
  }

  logger.error(event, appError, { code: appError.code });
  store.patch({ lastError: { code: appError.code, message: appError.userMessage }, progress: null });
  store.setAppState(AppState.ERROR);

  return appError;
}

function clearError() {
  if (store.get().lastError) {
    store.patch({ lastError: null });
  }
}

/* 認証・フォルダの有無から、待機時の状態を決める。 */
function settleIdleState() {
  const state = store.get();

  if (!hasValidAccessToken()) {
    store.setAppState(AppState.UNAUTHENTICATED);
    return;
  }

  store.setAppState(state.folder ? AppState.SYNC_IDLE : AppState.NO_FOLDER);
}

/* ---------- 操作 ---------- */

const actions = {
  async signIn() {
    clearError();

    if (!isClientIdConfigured()) {
      reportError(new AppError(ErrorCode.CLIENT_ID_MISSING), 'auth:not-configured');
      return;
    }

    try {
      await ensureAccessToken();
      store.setAppState(AppState.AUTHENTICATED);

      /* 表示名の取得。失敗しても認証自体は成立しているので続行する。 */
      try {
        await fetchAbout();
      } catch (error) {
        logger.warn('auth:about-failed', { code: error?.code ?? 'unknown' });
      }

      settleIdleState();

      /*
       * ログイン後に固定パスを自動探索する。
       * 既に対象フォルダが選ばれている場合は上書きしない（利用者の選択を尊重する）。
       */
      await actions.resolveFixedFolder({ apply: !store.get().folder });
    } catch (error) {
      reportError(error, 'auth:sign-in-failed');
    }
  },

  /*
   * 固定パス（マイドライブ / TSAM AI / ローカルLLM / 01_ナレッジ）を探索する。
   *
   * apply が true で、かつ一意に解決できた場合のみ対象フォルダとして保存する。
   * 見つからない・複数ある場合は保存せず、画面へ理由と候補を出す。
   * **フォルダの自動作成は行わない。**
   */
  async resolveFixedFolder({ apply = true } = {}) {
    if (!hasValidAccessToken()) {
      return null;
    }

    store.patch({ folderResolving: true });

    try {
      const result = await resolveKnowledgeFolder();

      store.patch({ folderResolve: result, folderResolving: false });

      if (result.status !== PathResolveStatus.RESOLVED) {
        logger.warn('folder-path:unresolved', { status: result.status, missingAt: result.missingAt });
        return result;
      }

      if (apply) {
        await actions.useFolder(result.folder);
      }

      return result;
    } catch (error) {
      store.patch({ folderResolving: false });
      reportError(error, 'folder-path:resolve-failed');
      return null;
    }
  },

  /*
   * 対象フォルダを確定し、IndexedDBへ保存したうえで配下の一覧を取得する。
   * ここでは取得・解析は行わない（一覧表示のみ）。
   */
  async useFolder(folder) {
    if (!folder?.id) {
      return;
    }

    const record = {
      id: String(folder.id),
      name: String(folder.name ?? ''),
      path: folder.path ?? formatPath(),
    };

    await setSelectedFolder(record);
    store.patch({ folder: record });
    logger.info('folder:selected', { hasName: Boolean(record.name), source: folder.path ? 'fixed-path' : 'manual' });

    settleIdleState();
    await actions.refreshFolderListing();
  },

  /* 対象フォルダ配下のファイル一覧だけを取り直す（解析はしない）。 */
  async refreshFolderListing() {
    const folder = store.get().folder;

    if (!folder || isSyncing()) {
      return;
    }

    store.setAppState(AppState.SYNCING);
    store.patch({ progress: { phase: 'listing', done: 0, total: 0, currentName: folder.name } });

    try {
      const result = await previewFolder({
        folder,
        onProgress: (progress) => store.patch({ progress }),
        onFileDone: () => scheduleFileRefresh(),
      });

      await refreshFiles();
      await refreshStats();

      store.patch({ progress: null });
      settleIdleState();

      logger.info('folder:listed', { scanned: result.scanned, pending: result.pending });
    } catch (error) {
      await refreshFiles();
      store.patch({ progress: null });
      reportError(error, 'folder:listing-failed');
    }
  },

  signOut() {
    authSignOut();
    /* 探索結果も残さない（別アカウントで入り直したときに前の結果を見せない）。 */
    store.patch({ profile: null, progress: null, folderResolve: null, folderResolving: false });
    store.setAppState(AppState.UNAUTHENTICATED);
  },

  async chooseFolder() {
    clearError();

    try {
      /* Picker用APIキーがある場合のみ Picker を使う。無ければ一覧から選ぶ。 */
      const folder = isPickerAvailable() ? await pickFolder() : await openFolderBrowser();

      if (!folder) {
        return;
      }

      await actions.useFolder(folder);
    } catch (error) {
      const appError = toAppError(error);

      /* Pickerが使えないときは黙って一覧方式へ倒す。 */
      if (appError.code === ErrorCode.PICKER_KEY_MISSING) {
        const folder = await openFolderBrowser();

        if (folder) {
          await actions.useFolder(folder);
        }

        return;
      }

      reportError(error, 'folder:select-failed');
    }
  },

  async startSync({ force = false } = {}) {
    if (isSyncing()) {
      return;
    }

    const folder = store.get().folder;

    if (!folder) {
      store.setAppState(AppState.NO_FOLDER);
      return;
    }

    clearError();
    store.setAppState(AppState.SYNCING);
    store.patch({ progress: { phase: 'listing', done: 0, total: 0, currentName: '' } });

    try {
      const result = await runSync({
        folder,
        force,
        onProgress: (progress) => {
          if (progress.phase === 'parsing' && store.get().appState !== AppState.PARSING) {
            store.setAppState(AppState.PARSING);
          }
          store.patch({ progress });
        },
        onFileDone: () => {
          /* 逐次反映。件数が多いときの再描画コストを抑えるため間引く。 */
          scheduleFileRefresh();
        },
      });

      await refreshFiles();
      await refreshStats();
      await trimLogs().catch(() => {});

      store.patch({ progress: null });
      store.setAppState(result.cancelled ? AppState.CANCELLED : AppState.DONE);

      logger.info('sync:summary', result);
    } catch (error) {
      await refreshFiles();
      await refreshStats();
      reportError(error, 'sync:failed');
    }
  },

  cancelSync() {
    cancelSync();
    store.patch({ progress: null });
  },

  async resyncFile(fileId) {
    try {
      await resyncFile(fileId);
      await refreshFiles();
      await actions.startSync({ force: false });
    } catch (error) {
      reportError(error, 'file:resync-failed');
    }
  },

  async deleteFile(fileId) {
    try {
      const chunkIds = (await getChunksByFile(fileId)).map((chunk) => chunk.chunkId);
      await deleteFileData(fileId);
      await removeFileChunks(chunkIds);
      await refreshFiles();
      await refreshStats();
      logger.info('file:deleted-by-user', {}, { fileId });
    } catch (error) {
      reportError(error, 'file:delete-failed');
    }
  },

  async rebuildIndex() {
    clearError();
    store.patch({ progress: { phase: 'rebuilding', done: 0, total: 0, currentName: '' } });

    try {
      const result = await rebuildIndex({
        onProgress: ({ done, total }) => {
          store.patch({ progress: { phase: 'rebuilding', done, total, currentName: '' } });
        },
      });

      store.patch({ progress: null });
      await refreshStats();
      settleIdleState();

      return result.count;
    } catch (error) {
      reportError(error, 'index:rebuild-failed');
      return null;
    }
  },

  /* 取り残されたチャンク・文書を掃除する（ストレージ画面から手動実行）。 */
  async cleanupOrphans() {
    try {
      const removed = await cleanupOrphans();

      if (removed.chunkIds.length > 0) {
        await removeFileChunks(removed.chunkIds);
      }

      await refreshStats();

      return { chunks: removed.chunkIds.length, documents: removed.documentIds.length };
    } catch (error) {
      reportError(error, 'cache:cleanup-failed');
      return null;
    }
  },

  async clearAllCache() {
    try {
      await clearAllCache({ keepSettings: true });
      await clearIndex();
      await refreshFiles();
      await refreshStats();
      logger.info('cache:cleared');
      settleIdleState();
    } catch (error) {
      reportError(error, 'cache:clear-failed');
    }
  },
};

/* 逐次更新の間引き（同期中に毎回DBを読み直さない）。 */
let refreshTimer = null;

function scheduleFileRefresh() {
  if (refreshTimer !== null) {
    return;
  }

  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    refreshFiles();
  }, 400);
}

/* ---------- 起動 ---------- */

const ctx = { store, actions };

async function bootstrap() {
  mountApp(ctx);

  /* 認証状態の変化を状態機械へ反映する。 */
  subscribeAuth(({ profile }) => {
    store.patch({ profile });
  });

  try {
    await openDb();
  } catch (error) {
    reportError(error, 'db:open-failed');
    return;
  }

  const folder = await getSelectedFolder();

  store.patch({ folder });

  await refreshFiles();
  await refreshStats();

  /*
   * 検索インデックスは、既にチャンクがある場合のみ先に復元しておく。
   * 起動直後の検索を速くするためで、外部通信は発生しない。
   */
  if ((store.get().stats?.chunkCount ?? 0) > 0) {
    ensureReady().catch((error) => {
      logger.warn('search:warmup-failed', { code: error?.code ?? 'unknown' });
    });
  }

  settleIdleState();

  logger.info('app:ready', {
    clientIdConfigured: isClientIdConfigured(),
    pickerConfigured: isPickerAvailable(),
    files: store.get().files.length,
  });
}

/* 想定外の例外も日本語で拾う（画面が無反応になるのを防ぐ）。 */
window.addEventListener('unhandledrejection', (event) => {
  const appError = toAppError(event.reason);

  if (appError.code === ErrorCode.CANCELLED) {
    return;
  }

  logger.error('app:unhandled-rejection', appError, { code: appError.code });
});

window.addEventListener('error', (event) => {
  logger.error('app:uncaught-error', {
    message: String(event.message ?? '').slice(0, 300),
    source: String(event.filename ?? '').slice(0, 200),
  });
});

/* ページ離脱時にWorkerを片付ける。 */
window.addEventListener('pagehide', () => {
  terminateParseWorker();
  terminateSearchWorker();
});

bootstrap().catch((error) => {
  reportError(error, 'app:bootstrap-failed');
});

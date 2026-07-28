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
  getSetupState, setSetupState,
} from './db/repo.js';
import {
  WizardStep, createProgress, makeSetupRecord, canFinish, summarizeDiagnosis,
} from './setup/wizard-state.js';
import { createSampleFiles as runCreateSampleFiles } from './drive/sample-files.js';
import { runDiagnostics } from './diagnostics/connection-check.js';
import { SAMPLE_SEARCH_TERM, getDriveScope } from './config.js';
import { hasWriteToken, requestWriteToken, discardWriteToken } from './auth/google-auth.js';

import {
  ensureAccessToken, signOut as authSignOut, subscribeAuth, hasValidAccessToken,
} from './auth/google-auth.js';
import { fetchAbout } from './drive/drive-client.js';
import { isPickerAvailable, pickFolder } from './drive/picker.js';
import { resolveKnowledgeFolder, PathResolveStatus, formatPath } from './drive/folder-path.js';
import { scanFolderStructure, createMissingFolders, isCreatingFolders } from './drive/folder-create.js';
import { formatNodePath } from './drive/folder-plan.js';
import { openFolderBrowser } from './ui/folder-browser.js';
import { openCreateFoldersDialog } from './ui/create-folders-dialog.js';

import {
  runSync, previewFolder, cancelSync, resyncFile, isSyncing, terminateParseWorker,
} from './sync/sync-engine.js';
import {
  rebuildIndex, removeFileChunks, clearIndex, ensureReady, terminateSearchWorker,
  search as searchChunks,
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

/*
 * 作成結果を表示用へ整形する。
 * AppError をそのまま画面へ渡さず、日本語メッセージとパスだけにする。
 */
function toDisplayResult(result) {
  if (!result) {
    return null;
  }

  const line = (item) => ({
    key: item.node.key,
    name: item.node.name,
    path: formatNodePath(item.node),
  });

  return {
    ok: result.ok === true,
    created: result.created.map((item) => ({
      ...line(item),
      id: item.folder.id,
      webViewLink: item.folder.webViewLink ?? '',
    })),
    reused: result.reused.map(line),
    failed: result.failed.map((item) => ({
      ...line(item),
      message: item.error?.userMessage ?? 'フォルダの作成に失敗しました。',
      code: item.error?.code ?? ErrorCode.UNKNOWN,
    })),
    skipped: result.skipped.map((item) => ({
      ...line(item),
      message: '前の段階が完了しなかったため実行していません。',
      code: item.reason ?? ErrorCode.UNKNOWN,
    })),
    error: result.error
      ? { code: result.error.code, message: result.error.userMessage }
      : null,
  };
}

/* サンプルファイル作成の結果を表示用へ整形する。 */
function toSampleDisplayResult(result) {
  if (!result) {
    return null;
  }

  return {
    ok: result.ok === true,
    created: result.created.map((item) => ({
      name: item.name,
      webViewLink: item.file?.webViewLink ?? '',
    })),
    skipped: result.skipped.map((item) => ({ name: item.name })),
    failed: result.failed.map((item) => ({
      name: item.name,
      message: item.error?.userMessage ?? 'サンプルファイルの作成に失敗しました。',
      code: item.error?.code ?? ErrorCode.UNKNOWN,
    })),
    error: result.error
      ? { code: result.error.code, message: result.error.userMessage }
      : null,
  };
}

/* ---------- セットアップウィザードの進捗 ---------- */

/*
 * 進捗フラグを1つ更新して保存する。
 *
 * ウィザードが完了済み（または未読込）のときは何もしない。
 * 通常運用のたびに IndexedDB へ書きに行かないようにするため。
 */
async function markSetupStep(stepId, { done = false, skipped = false, extra = {} } = {}) {
  const current = store.get().setup;

  if (!current || current.completed) {
    return null;
  }

  const KEYS = {
    [WizardStep.SIGN_IN]: ['signIn', null],
    [WizardStep.FOLDER]: ['folder', null],
    [WizardStep.CREATE]: ['create', 'createSkipped'],
    [WizardStep.SAMPLES]: ['samples', 'samplesSkipped'],
    [WizardStep.SYNC]: ['sync', 'syncSkipped'],
    [WizardStep.SEARCH]: ['search', 'searchSkipped'],
    [WizardStep.DIAGNOSE]: ['diagnose', 'diagnoseSkipped'],
  };

  const keys = KEYS[stepId];

  if (!keys) {
    return null;
  }

  const [doneKey, skippedKey] = keys;
  const progress = { ...current.progress, ...extra };

  if (done) {
    progress[doneKey] = true;
    if (skippedKey) {
      progress[skippedKey] = false;
    }
  }

  if (skipped && skippedKey) {
    progress[skippedKey] = true;
  }

  const record = makeSetupRecord(progress, { completed: false });

  store.patch({ setup: record });

  try {
    await setSetupState(record);
  } catch (error) {
    /* 保存に失敗しても画面の進行は止めない（次回もう一度案内されるだけ）。 */
    logger.warn('setup:save-failed', { code: error?.code ?? 'unknown' });
  }

  return record;
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
      await markSetupStep(WizardStep.SIGN_IN, { done: true });

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
  async resolveFixedFolder({ apply = true, scanStructure = true } = {}) {
    if (!hasValidAccessToken()) {
      return null;
    }

    store.patch({ folderResolving: true });

    try {
      const result = await resolveKnowledgeFolder();

      store.patch({ folderResolve: result, folderResolving: false });

      if (result.status !== PathResolveStatus.RESOLVED) {
        logger.warn('folder-path:unresolved', { status: result.status, missingAt: result.missingAt });

        /*
         * 固定パスの一部が無いときは、構成の確認もその場で行う。
         * こうしておくと「不足フォルダを作成」ボタンがすぐ出る。
         */
        if (scanStructure) {
          await actions.checkFolderStructure();
        }

        return result;
      }

      if (apply) {
        await actions.useFolder(result.folder);
      }

      /* 01_ナレッジ が揃っていても 02/03/99 が欠けていることがある。 */
      if (scanStructure) {
        await actions.checkFolderStructure();
      }

      return result;
    } catch (error) {
      store.patch({ folderResolving: false });
      reportError(error, 'folder-path:resolve-failed');
      return null;
    }
  },

  /*
   * 目標のフォルダ構成が揃っているかを確認する（読み取り専用）。
   * ここでは書き込み権限を一切要求しない。
   */
  async checkFolderStructure() {
    if (!hasValidAccessToken()) {
      return null;
    }

    store.patch({ structureScanning: true });

    try {
      const structure = await scanFolderStructure();
      store.patch({ structure, structureScanning: false });
      await markSetupStep(WizardStep.FOLDER, { done: true });
      return structure;
    } catch (error) {
      store.patch({ structureScanning: false });
      reportError(error, 'folder-structure:scan-failed');
      return null;
    }
  },

  /*
   * 不足フォルダを作成する。
   *
   *   1. 最新の構成を取り直す
   *   2. 確認ダイアログを出す（キャンセルなら何も書き込まない）
   *   3. 作成する（ここで初めて書き込み権限を要求する）
   *   4. 固定パスを再探索し、対象フォルダIDを更新する
   */
  async createMissingFolders() {
    clearError();

    if (!hasValidAccessToken()) {
      return null;
    }

    if (isSyncing()) {
      reportError(new AppError(ErrorCode.FOLDER_CREATE_BLOCKED_BY_SYNC), 'folder-create:blocked');
      return null;
    }

    if (isCreatingFolders() || store.get().folderCreating) {
      /* 連打・多重呼び出しはここで落とす（画面もボタンを無効化している）。 */
      return null;
    }

    const structure = await actions.checkFolderStructure();

    if (!structure || !structure.needsCreation) {
      return structure;
    }

    if (!structure.canCreate) {
      reportError(new AppError(ErrorCode.FOLDER_CREATE_AMBIGUOUS), 'folder-create:ambiguous');
      return structure;
    }

    const confirmed = await openCreateFoldersDialog(structure);

    if (!confirmed) {
      logger.info('folder-create:cancelled-by-user');
      return structure;
    }

    store.patch({
      folderCreating: true,
      folderCreateResult: null,
      folderCreateProgress: { phase: 'authorizing', done: 0, total: structure.missing.length, currentName: '' },
    });

    let result;

    try {
      result = await createMissingFolders({
        isBusy: () => isSyncing(),
        onProgress: (progress) => store.patch({ folderCreateProgress: progress }),
      });
    } finally {
      store.patch({ folderCreating: false, folderCreateProgress: null });
    }

    store.patch({ folderCreateResult: toDisplayResult(result) });

    if (result.error) {
      logger.warn('folder-create:incomplete', {
        code: result.error.code, created: result.created.length, failed: result.failed.length,
      });
    }

    /*
     * 01_ナレッジ を「今回新しく作った」かどうかを覚える。
     * サンプルファイルを置いてよいのは、このときだけ。
     */
    const knowledgeCreated = result.created.some((item) => item.node.isKnowledge === true);

    if (result.ok) {
      await markSetupStep(WizardStep.CREATE, {
        done: true,
        extra: knowledgeCreated ? { knowledgeFolderCreated: true } : {},
      });
    } else if (knowledgeCreated) {
      await markSetupStep(WizardStep.CREATE, { extra: { knowledgeFolderCreated: true } });
    }

    /* 作成後は必ず構成と固定パスを取り直し、保存済みフォルダIDを更新する。 */
    await actions.checkFolderStructure();
    await actions.resolveFixedFolder({ apply: true, scanStructure: false });

    return result;
  },

  /*
   * サンプルファイル（README.md / サンプル.txt）を作る。
   *
   * 01_ナレッジ を新規作成したときだけウィザードに出る手順。
   * 同名ファイルが既にあれば作らない（上書きはしない）。
   */
  async createSampleFiles() {
    clearError();

    const folder = store.get().folder;

    if (!folder?.id) {
      reportError(new AppError(ErrorCode.SETUP_STEP_BLOCKED, 'no_folder'), 'samples:no-folder');
      return null;
    }

    if (store.get().samplesCreating || isSyncing() || isCreatingFolders()) {
      return null;
    }

    store.patch({
      samplesCreating: true,
      samplesResult: null,
      samplesProgress: { phase: 'authorizing', done: 0, total: 0, currentName: '' },
    });

    let result;

    try {
      /* 作成のときだけ書き込み権限を要求し、終わったら破棄する。 */
      await requestWriteToken();

      result = await runCreateSampleFiles({
        folderId: folder.id,
        onProgress: (progress) => store.patch({ samplesProgress: progress }),
      });
    } catch (error) {
      result = {
        ok: false,
        created: [],
        skipped: [],
        failed: [],
        plan: [],
        error: toAppError(error, ErrorCode.SAMPLE_CREATE_FAILED),
      };
    } finally {
      discardWriteToken();
      store.patch({ samplesCreating: false, samplesProgress: null });
    }

    store.patch({ samplesResult: toSampleDisplayResult(result) });

    if (result.ok) {
      await markSetupStep(WizardStep.SAMPLES, { done: true });
      /* 追加したファイルを一覧へ反映する（解析はまだ行わない）。 */
      await actions.refreshFolderListing();
    }

    return result;
  },

  /* 検索テスト。ブラウザ内で完結し、外部通信は発生しない。 */
  async runSetupSearchTest(term = SAMPLE_SEARCH_TERM) {
    clearError();

    try {
      const result = await searchChunks(term, { limit: 5 });
      const names = [...new Set(result.hits.map((hit) => hit.fileName))].slice(0, 5);

      store.patch({ setupSearch: { term, hits: result.hits.length, names } });

      if (result.hits.length > 0) {
        await markSetupStep(WizardStep.SEARCH, { done: true });
      }

      return result;
    } catch (error) {
      reportError(error, 'setup:search-test-failed');
      return null;
    }
  },

  /*
   * 診断。既存の接続診断を実行し、結果を7分類へまとめる。
   * 権限の判定だけは通信では測れないため、アプリが持つ状態から出す。
   */
  async runSetupDiagnosis() {
    if (store.get().setupDiagnosing) {
      return null;
    }

    clearError();
    store.patch({ setupDiagnosing: true });

    try {
      const { results } = await runDiagnostics();
      const indexed = (store.get().files ?? []).filter((file) => file.syncState === 'indexed').length;

      const areas = summarizeDiagnosis(results, {
        scope: getDriveScope(),
        writeTokenHeld: hasWriteToken(),
        syncedFiles: indexed,
        searchHits: store.get().setupSearch?.hits ?? undefined,
      });

      store.patch({ setupDiagnosis: areas, setupDiagnosing: false });
      await markSetupStep(WizardStep.DIAGNOSE, { done: true });

      return areas;
    } catch (error) {
      store.patch({ setupDiagnosing: false });
      reportError(error, 'setup:diagnosis-failed');
      return null;
    }
  },

  /* 任意の手順を省略する。 */
  async skipSetupStep(stepId) {
    return markSetupStep(stepId, { skipped: true });
  },

  /* 「ナレッジ管理を開始」。完了状態を保存し、通常画面へ切り替える。 */
  async finishSetup() {
    const current = store.get().setup;

    if (!current || !canFinish(current.progress)) {
      return null;
    }

    const record = makeSetupRecord(current.progress, { completed: true });

    store.patch({ setup: record });

    try {
      await setSetupState(record);
    } catch (error) {
      logger.warn('setup:save-failed', { code: error?.code ?? 'unknown' });
    }

    logger.info('setup:completed');
    settleIdleState();

    return record;
  },

  /* 設定画面から「セットアップを再実行」。進捗を初期化して案内をやり直す。 */
  async restartSetup() {
    const record = makeSetupRecord(createProgress(), { completed: false });

    store.patch({
      setup: record,
      setupSearch: null,
      setupDiagnosis: null,
      samplesResult: null,
      folderCreateResult: null,
    });

    try {
      await setSetupState(record);
    } catch (error) {
      logger.warn('setup:save-failed', { code: error?.code ?? 'unknown' });
    }

    logger.info('setup:restarted');

    return record;
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

    if (!folder || isSyncing() || isCreatingFolders()) {
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
    store.patch({
      profile: null,
      progress: null,
      folderResolve: null,
      folderResolving: false,
      structure: null,
      structureScanning: false,
      folderCreateResult: null,
      folderCreateProgress: null,
    });
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

    /* フォルダ作成中は同期を始めない（作成途中の構成で走らせない）。 */
    if (isCreatingFolders()) {
      reportError(new AppError(ErrorCode.FOLDER_CREATE_IN_PROGRESS), 'sync:blocked-by-folder-create');
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

      if (!result.cancelled) {
        await markSetupStep(WizardStep.SYNC, { done: true });
      }

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

  /*
   * セットアップの完了状態を読む。
   * 未完了（＝初回アクセス）ならウィザードを出す。
   * 読めなかった場合は「未完了」として扱い、案内を出す側へ倒す。
   */
  try {
    store.patch({ setup: await getSetupState() });
  } catch (error) {
    logger.warn('setup:load-failed', { code: error?.code ?? 'unknown' });
    store.patch({ setup: makeSetupRecord(createProgress(), { completed: false }) });
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

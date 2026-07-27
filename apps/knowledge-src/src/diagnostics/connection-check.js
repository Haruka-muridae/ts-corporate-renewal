/*
 * 接続診断。
 *
 * Google 認証と Drive API の実通信を、項目ごとに順番へ分けて確認する。
 * どこで失敗しているかを切り分けるためのもので、通常の同期経路とは独立している。
 *
 * ------------------------------------------------------------------
 * 記録してはならないもの（重要）
 * ------------------------------------------------------------------
 * アクセストークン / Authorization ヘッダー / IDトークン / 本文全体。
 * このモジュールは token の値を一切保持せず、
 * 「取得できたか」「長さの桁数」だけを扱う。
 * ------------------------------------------------------------------
 *
 * DOM に依存しない（表示は ui/views/diagnostics-panel.js が行う）。
 */

import { loadGis } from '../auth/script-loader.js';
import { ensureAccessToken, hasValidAccessToken } from '../auth/google-auth.js';
import {
  fetchAbout, findFoldersByName, listFilesInFolder, exportGoogleDoc, downloadFile,
} from '../drive/drive-client.js';
import {
  KNOWLEDGE_FOLDER_PATH, DRIVE_ROOT_LABEL, SCOPE_MODE, getDriveScope, isClientIdConfigured, MIME,
} from '../config.js';
import { getSetting, setSetting } from '../db/repo.js';
import { probeIndex } from '../search/search-service.js';
import { AppError, ErrorCode, toAppError } from '../core/errors.js';
import { logger } from '../core/logger.js';

export const CheckStatus = Object.freeze({
  PENDING: 'pending',   // 未実行
  RUNNING: 'running',   // 実行中
  SUCCESS: 'success',   // 成功
  FAILURE: 'failure',   // 失敗
  SKIPPED: 'skipped',   // 前段が失敗したため未実施
});

export const CHECK_STATUS_LABEL_JA = Object.freeze({
  [CheckStatus.PENDING]: '未実行',
  [CheckStatus.RUNNING]: '実行中',
  [CheckStatus.SUCCESS]: '成功',
  [CheckStatus.FAILURE]: '失敗',
  [CheckStatus.SKIPPED]: '未実施',
});

/*
 * 診断項目の定義。
 * run(context) は成功時に { detail, data } を返し、失敗時は例外を投げる。
 * context は項目間で共有され、後の項目が前の結果を使う。
 */
export const CHECK_IDS = Object.freeze({
  GIS: 'gis',
  TOKEN: 'token',
  ABOUT: 'about',
  FOLDER_1: 'folder1',
  FOLDER_2: 'folder2',
  FOLDER_3: 'folder3',
  FILE_LIST: 'fileList',
  GDOC_EXPORT: 'gdocExport',
  PDF_DOWNLOAD: 'pdfDownload',
  INDEXED_DB: 'indexedDb',
  SEARCH_INDEX: 'searchIndex',
});

const DIAG_SETTING_KEY = 'diagnostics:lastRun';

function buildDefinitions() {
  const [name1, name2, name3] = KNOWLEDGE_FOLDER_PATH;

  return [
    {
      id: CHECK_IDS.GIS,
      label: 'Google Identity Services 読込',
      description: 'accounts.google.com から認証ライブラリを読み込めるか。',
      async run() {
        if (!isClientIdConfigured()) {
          throw new AppError(ErrorCode.CLIENT_ID_MISSING, 'client_id_missing');
        }

        await loadGis();
        return { detail: 'google.accounts.oauth2 を利用できます。' };
      },
    },

    {
      id: CHECK_IDS.TOKEN,
      label: 'アクセストークン取得',
      description: `OAuth 同意（${SCOPE_MODE === 'file' ? 'drive.file' : 'drive.readonly'}）を得てトークンを取得する。`,
      async run(context) {
        /*
         * トークンの値は context にも戻り値にも入れない。
         * drive-client が内部で ensureAccessToken() を呼ぶため、
         * ここでは「取得できたこと」だけを確認する。
         */
        const token = await ensureAccessToken();
        const ok = typeof token === 'string' && token.length > 0;

        if (!ok) {
          throw new AppError(ErrorCode.AUTH_FAILED, 'empty_token');
        }

        context.tokenAcquired = true;

        return { detail: `スコープ ${getDriveScope()} で取得しました（値は記録しません）。` };
      },
    },

    {
      id: CHECK_IDS.ABOUT,
      label: 'Drive about.get',
      description: 'Drive API へ到達できるか。アカウント情報を取得する。',
      requires: [CHECK_IDS.TOKEN],
      async run(context) {
        const result = await fetchAbout();
        context.profile = result.profile;

        const name = result.profile?.displayName || '（表示名なし）';
        const quota = result.storageQuota;
        const quotaText = quota?.limit
          ? `Drive容量 ${Math.round(Number(quota.usage) / 1e9 * 10) / 10}GB / ${Math.round(Number(quota.limit) / 1e9 * 10) / 10}GB`
          : 'Drive容量 上限なし';

        return { detail: `${name} として接続。${quotaText}` };
      },
    },

    {
      id: CHECK_IDS.FOLDER_1,
      label: `「${name1}」フォルダ検索`,
      description: `${DRIVE_ROOT_LABEL} 直下を親IDに指定して名前完全一致で探す。`,
      requires: [CHECK_IDS.TOKEN],
      async run(context) {
        return findFolderStep(context, { parentKey: null, parentLabel: DRIVE_ROOT_LABEL, parentId: 'root', name: name1, key: 'folder1' });
      },
    },

    {
      id: CHECK_IDS.FOLDER_2,
      label: `「${name2}」フォルダ検索`,
      description: `「${name1}」のフォルダIDを親に指定して探す。`,
      requires: [CHECK_IDS.FOLDER_1],
      async run(context) {
        return findFolderStep(context, { parentKey: 'folder1', parentLabel: name1, name: name2, key: 'folder2' });
      },
    },

    {
      id: CHECK_IDS.FOLDER_3,
      label: `「${name3}」フォルダ検索`,
      description: `「${name2}」のフォルダIDを親に指定して探す。ここが同期対象。`,
      requires: [CHECK_IDS.FOLDER_2],
      async run(context) {
        return findFolderStep(context, { parentKey: 'folder2', parentLabel: name2, name: name3, key: 'folder3' });
      },
    },

    {
      id: CHECK_IDS.FILE_LIST,
      label: 'フォルダ内ファイル一覧取得',
      description: `「${name3}」直下のファイルを取得する。`,
      requires: [CHECK_IDS.FOLDER_3],
      async run(context) {
        const target = context.folder3;
        const page = await listFilesInFolder({ folderId: target.id, pageSize: 100 });

        context.files = page.files;

        const folders = page.files.filter((file) => file.mimeType === MIME.GOOGLE_FOLDER);
        const docs = page.files.filter((file) => file.mimeType === MIME.GOOGLE_DOC);
        const pdfs = page.files.filter((file) => file.mimeType === MIME.PDF);

        return {
          detail: `${page.files.length}件（サブフォルダ ${folders.length} / Googleドキュメント ${docs.length} / PDF ${pdfs.length}）`
            + `${page.nextPageToken ? '。次ページあり' : ''}`,
        };
      },
    },

    {
      id: CHECK_IDS.GDOC_EXPORT,
      label: 'Googleドキュメント export',
      description: 'Googleドキュメントをプレーンテキストとして書き出せるか。',
      requires: [CHECK_IDS.FILE_LIST],
      async run(context) {
        const doc = (context.files ?? []).find((file) => file.mimeType === MIME.GOOGLE_DOC);

        if (!doc) {
          throw new AppError(
            ErrorCode.DRIVE_NOT_FOUND,
            'no_google_doc',
          );
        }

        const text = await exportGoogleDoc(doc.id);
        const chars = String(text ?? '').length;

        if (chars === 0) {
          throw new AppError(ErrorCode.EMPTY_TEXT, 'export_empty');
        }

        return { detail: `「${doc.name}」を ${chars.toLocaleString('ja-JP')} 文字で書き出しました。` };
      },
    },

    {
      id: CHECK_IDS.PDF_DOWNLOAD,
      label: 'PDFダウンロード',
      description: 'バイナリ本体（alt=media）を取得できるか。',
      requires: [CHECK_IDS.FILE_LIST],
      async run(context) {
        const pdf = (context.files ?? []).find((file) => file.mimeType === MIME.PDF);

        if (!pdf) {
          throw new AppError(ErrorCode.DRIVE_NOT_FOUND, 'no_pdf');
        }

        const buffer = await downloadFile(pdf.id);
        const bytes = buffer.byteLength;

        if (bytes === 0) {
          throw new AppError(ErrorCode.DRIVE_FETCH_FAILED, 'empty_body');
        }

        /* 先頭が %PDF- であることだけ確認する（内容は保持しない）。 */
        const head = new TextDecoder('latin1').decode(new Uint8Array(buffer, 0, Math.min(5, bytes)));

        return {
          detail: `「${pdf.name}」を ${bytes.toLocaleString('ja-JP')} バイト取得（先頭 ${head}）。`,
        };
      },
    },

    {
      id: CHECK_IDS.INDEXED_DB,
      label: 'IndexedDB 保存',
      description: 'ブラウザ内データベースへ書き込み・読み出しできるか。',
      async run() {
        const stamp = new Date().toISOString();
        await setSetting(DIAG_SETTING_KEY, { at: stamp });
        const readBack = await getSetting(DIAG_SETTING_KEY, null);

        if (readBack?.at !== stamp) {
          throw new AppError(ErrorCode.DB_WRITE_FAILED, 'readback_mismatch');
        }

        return { detail: '書き込みと読み出しに成功しました。' };
      },
    },

    {
      id: CHECK_IDS.SEARCH_INDEX,
      label: '検索インデックス登録',
      description: '一時的なチャンクを索引へ入れ、検索してから取り除く。',
      async run() {
        const result = await probeIndex();

        if (!result.found) {
          throw new AppError(ErrorCode.SEARCH_FAILED, 'probe_not_found');
        }

        return { detail: `一時チャンクを登録・検索・削除できました（索引 ${result.documentCount} 件）。` };
      },
    },
  ];
}

/* 階層ごとのフォルダ検索。同名が複数ある場合は失敗として候補を示す。 */
async function findFolderStep(context, { parentKey, parentLabel, parentId, name, key }) {
  const resolvedParentId = parentId ?? context[parentKey]?.id;

  if (!resolvedParentId) {
    throw new AppError(ErrorCode.DRIVE_NOT_FOUND, `parent_missing:${parentKey}`);
  }

  const result = await findFoldersByName({ parentId: resolvedParentId, name });

  if (result.exact.length === 0) {
    const error = new AppError(ErrorCode.DRIVE_NOT_FOUND, `not_found_in:${parentLabel}`);
    error.diagnosticHint = `「${parentLabel}」の直下に「${name}」がありません。`
      + (result.loose.length > 0 ? `名前が近いもの: ${result.loose.map((f) => f.name).join(' / ')}` : '');
    throw error;
  }

  if (result.exact.length > 1) {
    const error = new AppError(ErrorCode.DRIVE_NOT_FOUND, `ambiguous:${result.exact.length}`);
    error.diagnosticHint = `「${parentLabel}」の直下に「${name}」が ${result.exact.length} 件あります。`
      + '自動選択はしません。フォルダ選択画面で使用するフォルダを指定してください。';
    throw error;
  }

  const folder = result.exact[0];
  context[key] = { id: folder.id, name: folder.name };

  return { detail: `「${parentLabel}」の直下に1件だけ見つかりました。` };
}

/*
 * 診断を実行する。
 *
 * onUpdate(results) が各項目の前後で呼ばれる。
 * results は id をキーにした { status, at, httpStatus, message, detail } のオブジェクト。
 */
export async function runDiagnostics({ onUpdate, only = null } = {}) {
  const definitions = buildDefinitions();
  const results = {};
  const context = {};

  definitions.forEach((definition) => {
    results[definition.id] = {
      id: definition.id,
      label: definition.label,
      description: definition.description,
      status: CheckStatus.PENDING,
      at: null,
      httpStatus: null,
      message: '',
      detail: '',
    };
  });

  const emit = () => onUpdate?.({ ...results });
  emit();

  const targets = only ? definitions.filter((d) => only.includes(d.id)) : definitions;

  for (const definition of targets) {
    const entry = results[definition.id];

    /* 前提が失敗している項目は実行しない（無駄な通信をしない）。 */
    const blocked = (definition.requires ?? []).find(
      (id) => results[id] && results[id].status !== CheckStatus.SUCCESS,
    );

    if (blocked) {
      entry.status = CheckStatus.SKIPPED;
      entry.at = new Date().toISOString();
      entry.message = `前段の「${results[blocked].label}」が成功していないため実行しませんでした。`;
      emit();
      continue;
    }

    entry.status = CheckStatus.RUNNING;
    entry.at = new Date().toISOString();
    emit();

    try {
      /* eslint-disable-next-line no-await-in-loop */
      const outcome = await definition.run(context);

      entry.status = CheckStatus.SUCCESS;
      entry.at = new Date().toISOString();
      entry.httpStatus = 200;
      entry.message = outcome?.detail ?? '成功しました。';
      entry.detail = '';

      logger.info('diagnostics:step-ok', { id: definition.id });
    } catch (error) {
      const appError = toAppError(error);

      entry.status = CheckStatus.FAILURE;
      entry.at = new Date().toISOString();
      entry.httpStatus = typeof error?.status === 'number' ? error.status : null;
      entry.message = error?.diagnosticHint ?? appError.userMessage;

      /* 開発者向け詳細。トークン・本文は含めない。 */
      entry.detail = JSON.stringify({
        code: appError.code,
        detail: typeof appError.detail === 'string' ? appError.detail : null,
        reason: error?.reason ?? null,
        httpStatus: entry.httpStatus,
      });

      logger.error('diagnostics:step-failed', appError, {
        code: appError.code,
      });
    }

    emit();
  }

  const summary = {
    total: targets.length,
    success: targets.filter((d) => results[d.id].status === CheckStatus.SUCCESS).length,
    failure: targets.filter((d) => results[d.id].status === CheckStatus.FAILURE).length,
    skipped: targets.filter((d) => results[d.id].status === CheckStatus.SKIPPED).length,
    finishedAt: new Date().toISOString(),
    /* 診断が解決したフォルダ（見つかった場合のみ）。 */
    resolvedFolder: context.folder3 ?? null,
  };

  logger.info('diagnostics:completed', {
    total: summary.total, success: summary.success, failure: summary.failure, skipped: summary.skipped,
  });

  return { results, summary };
}

/* 認証状態に応じた事前確認（実行ボタンの出し分け用）。 */
export function diagnosticsPrecondition() {
  return {
    clientIdConfigured: isClientIdConfigured(),
    signedIn: hasValidAccessToken(),
    scope: getDriveScope(),
    scopeMode: SCOPE_MODE,
  };
}

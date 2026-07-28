/*
 * Google Drive API v3 への **唯一の書き込み経路**。
 *
 * ------------------------------------------------------------------
 * このファイルにしか非GETリクエストは存在しない（重要）
 * ------------------------------------------------------------------
 * 呼び出してよいのは2つだけ。どちらも **新規作成** で、既存には触れない。
 *
 *   1. フォルダ作成（常用）
 *      POST https://www.googleapis.com/drive/v3/files
 *           body: { name, mimeType: 'application/vnd.google-apps.folder', parents: [<親ID>] }
 *           fields: id,name,mimeType,parents,webViewLink
 *
 *   2. 本文つきファイル作成（セットアップの「サンプルファイル」だけ）
 *      POST https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart
 *           同じ3項目のメタデータ + 本文
 *           呼び出し側が「同名ファイルが無いこと」を確認してからしか呼ばない。
 *
 *   3. 利用者が明示選択したナレッジファイルの新規アップロード
 *      POST https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart
 *           保存先は呼び出し側が解決した 01_ナレッジ 配下だけ。
 *           既存ファイルは更新せず、重複名は呼び出し側で別名にする。
 *
 * PUT / PATCH / DELETE は実装しない。
 * 既存ファイルの編集・移動・削除は、経路そのものを持たないことで防ぐ。
 *
 * 監査するときはこのファイルだけを見ればよい。
 * （tests/tools/analyze-source.mjs と統合テストの両方で機械的に確認している。）
 * ------------------------------------------------------------------
 *
 * 使うトークンは google-auth.js の「書き込み用トークン」だけで、
 * 読み取り用トークンは使わない（読み取り経路と権限をはっきり分けるため）。
 */

import { DRIVE_API_BASE, DRIVE_UPLOAD_BASE, MIME } from '../config.js';
import { peekWriteToken } from '../auth/google-auth.js';
import { AppError, ErrorCode, driveErrorCode } from '../core/errors.js';
import { logger } from '../core/logger.js';
import { buildCreateBody, validateCreatedFolder } from './folder-plan.js';

/* 作成レスポンスで受け取るフィールド。要件で決められた5つ。 */
export const CREATE_FIELDS = 'id,name,mimeType,parents,webViewLink';

/*
 * 再試行してよいコード。読み取り側（drive-client.js）と同じ方針にそろえる。
 * 401 / 403 は再試行しない（権限の問題であり、待っても変わらないため）。
 */
const RETRYABLE = new Set([ErrorCode.DRIVE_RATE_LIMIT, ErrorCode.SERVER_ERROR]);

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);

    if (signal) {
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new AppError(ErrorCode.CANCELLED, 'aborted'));
      }, { once: true });
    }
  });
}

async function readErrorBody(response) {
  try {
    return await response.clone().json();
  } catch {
    return null;
  }
}

/*
 * フォルダを1つ作る。
 *
 * 成功時: { id, name, mimeType, parents, webViewLink }
 *
 * 失敗時は AppError を投げる。`error.status` にHTTPステータスが入る
 * （接続診断・エラーログ用。本文やトークンは載せない）。
 */
export async function createFolder({ name, parentId, signal, retries = 3 }) {
  const built = buildCreateBody({ name, parentId });

  if (!built.ok) {
    /* 通信する前に弾く。空の名前や不正な親IDをGoogleへ送らない。 */
    logger.warn('drive-writer:invalid-request', { reason: built.reason });
    throw new AppError(ErrorCode.FOLDER_CREATE_FAILED, built.reason);
  }

  const token = peekWriteToken();

  if (!token) {
    /* 書き込みトークンが無い状態でここへ来るのは呼び出し側の誤り。 */
    throw new AppError(ErrorCode.WRITE_SCOPE_NOT_GRANTED, 'no_write_token');
  }

  const url = new URL(`${DRIVE_API_BASE}/files`);
  url.searchParams.set('fields', CREATE_FIELDS);
  url.searchParams.set('supportsAllDrives', 'true');

  const resource = await send({
    url,
    token,
    contentType: 'application/json; charset=UTF-8',
    body: JSON.stringify(built.body),
    signal,
    retries,
    responseErrorCode: ErrorCode.FOLDER_CREATE_UNVERIFIED,
  });

  const verdict = validateCreatedFolder(resource, { name, parentId });

  if (!verdict.ok) {
    /* 依頼した名前・親と違うものが返ってきた。成功として扱わない。 */
    logger.error('drive-writer:unexpected-response', { reason: verdict.reason });
    throw new AppError(ErrorCode.FOLDER_CREATE_UNVERIFIED, verdict.reason);
  }

  logger.info('drive-writer:folder-created', { depthHint: built.body.parents.length });

  return toFolderResult(resource);
}

/*
 * 本文つきのテキストファイルを1つ作る（multipart/related）。
 *
 * ------------------------------------------------------------------
 * 呼び出す前に、呼び出し側が「同名ファイルが無いこと」を確認すること。
 * ここは **作成しかしない**。既存ファイルを見つけて更新する経路は無い。
 * ------------------------------------------------------------------
 */
export async function createTextFile({ name, parentId, mimeType, content, signal, retries = 3 }) {
  const built = buildCreateBody({ name, parentId });

  if (!built.ok) {
    logger.warn('drive-writer:invalid-request', { reason: built.reason });
    throw new AppError(ErrorCode.SAMPLE_CREATE_FAILED, built.reason);
  }

  const text = String(content ?? '');

  if (text === '') {
    throw new AppError(ErrorCode.SAMPLE_CREATE_FAILED, 'empty_content');
  }

  const token = peekWriteToken();

  if (!token) {
    throw new AppError(ErrorCode.WRITE_SCOPE_NOT_GRANTED, 'no_write_token');
  }

  /* メタデータはフォルダ作成と同じ3項目のみ。mimeType だけ差し替える。 */
  const metadata = { ...built.body, mimeType: String(mimeType) };
  const boundary = makeBoundary();

  const url = new URL(`${DRIVE_UPLOAD_BASE}/files`);
  url.searchParams.set('uploadType', 'multipart');
  url.searchParams.set('fields', CREATE_FIELDS);
  url.searchParams.set('supportsAllDrives', 'true');

  const payload = [
    `--${boundary}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    JSON.stringify(metadata),
    `--${boundary}`,
    `Content-Type: ${metadata.mimeType}; charset=UTF-8`,
    '',
    text,
    `--${boundary}--`,
    '',
  ].join('\r\n');

  const resource = await send({
    url,
    token,
    contentType: `multipart/related; boundary=${boundary}`,
    body: payload,
    signal,
    retries,
    responseErrorCode: ErrorCode.SAMPLE_CREATE_UNVERIFIED,
  });

  /* 名前と親が依頼どおりかを確認する（種別はフォルダではないので別扱い）。 */
  if (String(resource?.name) !== String(name)) {
    throw new AppError(ErrorCode.SAMPLE_CREATE_UNVERIFIED, 'name_mismatch');
  }

  if (!Array.isArray(resource?.parents) || !resource.parents.includes(String(parentId))) {
    throw new AppError(ErrorCode.SAMPLE_CREATE_UNVERIFIED, 'parent_mismatch');
  }

  logger.info('drive-writer:file-created', { mimeType: metadata.mimeType });

  return toFolderResult(resource);
}

/*
 * 利用者が選んだファイルをmultipart/relatedで新規作成する。
 *
 * File/Blobは読み直さず、そのままBlobの一部としてfetchへ渡す。
 * 本文をログ、URL、Storageへ複製しない。
 */
export async function createKnowledgeFile({
  name, parentId, mimeType, file, signal, retries = 3,
}) {
  const built = buildCreateBody({ name, parentId });

  if (!built.ok) {
    logger.warn('drive-writer:invalid-upload', { reason: built.reason });
    throw new AppError(ErrorCode.UPLOAD_INVALID_FILE, built.reason);
  }

  if (!file || typeof file.size !== 'number' || file.size <= 0) {
    throw new AppError(ErrorCode.UPLOAD_EMPTY_FILE, 'empty_file');
  }

  const token = peekWriteToken();

  if (!token) {
    throw new AppError(ErrorCode.WRITE_SCOPE_NOT_GRANTED, 'no_write_token');
  }

  const metadata = {
    name: String(name),
    mimeType: String(mimeType || file.type || 'application/octet-stream'),
    parents: [String(parentId)],
  };
  const boundary = makeBoundary();
  const url = new URL(`${DRIVE_UPLOAD_BASE}/files`);
  url.searchParams.set('uploadType', 'multipart');
  url.searchParams.set('fields', CREATE_FIELDS);
  url.searchParams.set('supportsAllDrives', 'true');

  const payload = new Blob([
    `--${boundary}\r\n`,
    'Content-Type: application/json; charset=UTF-8\r\n\r\n',
    JSON.stringify(metadata),
    `\r\n--${boundary}\r\n`,
    `Content-Type: ${metadata.mimeType}\r\n\r\n`,
    file,
    `\r\n--${boundary}--\r\n`,
  ], { type: `multipart/related; boundary=${boundary}` });

  const resource = await send({
    url,
    token,
    contentType: payload.type,
    body: payload,
    signal,
    retries,
    responseErrorCode: ErrorCode.UPLOAD_UNVERIFIED,
  });

  if (String(resource?.name) !== metadata.name) {
    throw new AppError(ErrorCode.UPLOAD_UNVERIFIED, 'name_mismatch');
  }

  if (!Array.isArray(resource?.parents) || !resource.parents.includes(metadata.parents[0])) {
    throw new AppError(ErrorCode.UPLOAD_UNVERIFIED, 'parent_mismatch');
  }

  if (resource?.mimeType && String(resource.mimeType) !== metadata.mimeType) {
    throw new AppError(ErrorCode.UPLOAD_UNVERIFIED, 'mime_type_mismatch');
  }

  logger.info('drive-writer:knowledge-uploaded', {
    mimeType: metadata.mimeType,
    bytes: Number(file.size),
  });

  return toFolderResult(resource);
}

/* 本文に現れない区切り文字を作る。 */
function makeBoundary() {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return `tsam${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

function toFolderResult(resource) {
  return {
    id: String(resource.id),
    name: String(resource.name),
    mimeType: String(resource.mimeType),
    parents: Array.isArray(resource.parents) ? resource.parents.map(String) : [],
    webViewLink: typeof resource.webViewLink === 'string' ? resource.webViewLink : '',
  };
}

/*
 * 書き込みリクエストの共通処理。
 *   - 429 / 5xx は指数バックオフで再試行（Retry-After を優先）
 *   - 401 / 403 は再試行しない（権限の問題であり、待っても変わらない）
 */
async function send({
  url, token, contentType, body, signal, retries,
  responseErrorCode = ErrorCode.FOLDER_CREATE_UNVERIFIED,
}) {
  let attempt = 0;

  for (;;) {
    let response;

    try {
      response = await fetch(url, {
        /* ここが唯一の非GET。値を変数にせず直接書き、置換されないようにする。 */
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': contentType,
        },
        body,
        signal,
      });
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new AppError(ErrorCode.CANCELLED, 'aborted');
      }
      throw new AppError(ErrorCode.NETWORK_ERROR, error?.message ?? 'fetch_failed', error);
    }

    if (response.ok) {
      try {
        return await response.json();
      } catch {
        throw new AppError(responseErrorCode, 'invalid_json');
      }
    }

    const errorBody = await readErrorBody(response);
    const code = driveErrorCode(response.status, errorBody);

    if (RETRYABLE.has(code) && attempt < retries) {
      attempt += 1;

      const headerWait = Number(response.headers.get('retry-after'));
      const waitMs = Number.isFinite(headerWait) && headerWait > 0
        ? Math.min(headerWait * 1000, 30000)
        : Math.min(1000 * (2 ** (attempt - 1)), 8000);

      logger.warn('drive-writer:retry', { status: response.status, attempt, waitMs });
      await sleep(waitMs, signal);
      continue;
    }

    logger.error('drive-writer:create-failed', {
      status: response.status,
      reason: errorBody?.error?.errors?.[0]?.reason ?? null,
      message: errorBody?.error?.message ?? null,
    }, { code });

    const error = new AppError(code, `${response.status}`, errorBody);
    error.status = response.status;
    error.reason = errorBody?.error?.errors?.[0]?.reason ?? null;
    throw error;
  }
}

/* 監査・テスト用。実際に使う定数をここから読めるようにしておく。 */
export const WRITE_CONTRACT = Object.freeze({
  method: 'POST',
  path: '/files',
  uploadPath: '/upload/drive/v3/files',
  knowledgeUpload: true,
  mimeType: MIME.GOOGLE_FOLDER,
  fields: CREATE_FIELDS,
  forbiddenMethods: Object.freeze(['PUT', 'PATCH', 'DELETE']),
});

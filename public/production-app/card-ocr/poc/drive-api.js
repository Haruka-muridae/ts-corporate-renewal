/*
 * Drive API v3 の下回り（通信・エラー分類・multipart 本文）。
 *
 * ==================================================================
 * 複製元
 * ==================================================================
 * public/apps/card-scanner/drive-ocr.js の下回り部分を複製したもの。
 * **import はしない。** `/apps/` はテスト環境であり、本番アプリから
 * そこへ依存を作らない（docs/repository-structure.md §2-1、要件定義書 §3）。
 *
 * 複製元との違い:
 *   - ロガーを持たない（検証ページには不要）
 *   - フォルダ名などアプリ固有の定数は drive-storage.js へ分けた
 * ==================================================================
 *
 * 方針:
 *   - トークンは引数で受け取り、このモジュールに保持しない
 *   - 例外にトークンを含めない
 *   - fetchImpl を差し替えられるようにする（テストで実APIを叩かないため）
 */

/* 要件定義書 §12 が許す3系統のうちの2つ。ここを変えないこと。 */
export const DRIVE_FILES_ENDPOINT = 'https://www.googleapis.com/drive/v3/files';
export const DRIVE_UPLOAD_ENDPOINT = 'https://www.googleapis.com/upload/drive/v3/files';

export const DRIVE_FOLDER_MIME = 'application/vnd.google-apps.folder';
export const GOOGLE_DOC_MIME = 'application/vnd.google-apps.document';
export const GOOGLE_SHEET_MIME = 'application/vnd.google-apps.spreadsheet';
export const JPEG_MIME = 'image/jpeg';

export const DriveErrorCode = {
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  RATE_LIMITED: 'RATE_LIMITED',
  NETWORK: 'NETWORK',
  UNKNOWN: 'UNKNOWN',
};

export class DriveError extends Error {
  constructor(code, status = 0, detail = null) {
    /* メッセージにトークンや応答本体を含めない。 */
    super(`drive:${code}`);
    this.name = 'DriveError';
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

/* 画面に出す言葉。エラーコードは要件定義書 §15 に対応する。 */
export function describeDriveError(error) {
  const code = error instanceof DriveError ? error.code : DriveErrorCode.UNKNOWN;

  switch (code) {
    case DriveErrorCode.UNAUTHORIZED:
      return { text: 'Google連携の期限が切れました。連携し直してください。', errorCode: 'OAUTH-002' };
    case DriveErrorCode.FORBIDDEN:
      return { text: 'ドライブへの操作が許可されませんでした。', errorCode: 'DRV-001' };
    case DriveErrorCode.NOT_FOUND:
      return { text: '対象が見つかりませんでした。', errorCode: 'SETUP-002' };
    case DriveErrorCode.RATE_LIMITED:
      return { text: '利用が集中しています。時間をおいてお試しください。', errorCode: 'DRV-001' };
    case DriveErrorCode.NETWORK:
      return { text: '通信に失敗しました。', errorCode: 'DRV-001' };
    default:
      return { text: 'ドライブの操作に失敗しました。', errorCode: 'DRV-001' };
  }
}

function extractReason(body) {
  const error = body?.error;

  if (!error) {
    return '';
  }

  if (Array.isArray(error.errors) && error.errors.length > 0) {
    return String(error.errors[0]?.reason ?? '');
  }

  return String(error.status ?? '');
}

export function mapHttpErrorToCode(status) {
  if (status === 401) {
    return DriveErrorCode.UNAUTHORIZED;
  }

  if (status === 403) {
    return DriveErrorCode.FORBIDDEN;
  }

  if (status === 404) {
    return DriveErrorCode.NOT_FOUND;
  }

  if (status === 429) {
    return DriveErrorCode.RATE_LIMITED;
  }

  return DriveErrorCode.UNKNOWN;
}

async function readJsonSafely(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function readTextSafely(response) {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

/*
 * Drive API を呼ぶ。
 *
 * export エンドポイントは JSON ではなくプレーンテキストを返すため、
 * 応答の読み方は呼び出し側が選べるようにしてある。
 */
export async function driveRequest(url, { token, method = 'GET', body = null, headers = {}, fetchImpl }) {
  const doFetch = fetchImpl ?? globalThis.fetch;

  if (typeof doFetch !== 'function') {
    throw new DriveError(DriveErrorCode.NETWORK, 0, 'fetch_unavailable');
  }

  let response;

  try {
    response = await doFetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...headers,
      },
      body,
    });
  } catch (error) {
    /* 通信そのものが失敗（オフライン、CORS、遮断など）。 */
    throw new DriveError(DriveErrorCode.NETWORK, 0, error?.name ?? 'fetch_failed');
  }

  if (!response.ok) {
    const errorBody = await readJsonSafely(response);
    throw new DriveError(
      mapHttpErrorToCode(response.status),
      response.status,
      extractReason(errorBody) || null,
    );
  }

  return response;
}

export async function driveFetchJson(url, options) {
  const response = await driveRequest(url, options);
  return readJsonSafely(response);
}

export async function driveFetchText(url, options) {
  const response = await driveRequest(url, options);
  return readTextSafely(response);
}

/* ---------- クエリ ---------- */

/* Drive の検索クエリでは \ と ' をエスケープする。 */
export function escapeQueryValue(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/*
 * 名前・親・種別・未削除をすべて条件にする。
 *
 * **親を条件から外さないこと。** 外すと、別の場所にある同名フォルダを
 * 掴んでしまう。
 */
export function buildChildQuery(name, mimeType, parentId = null) {
  return [
    `name='${escapeQueryValue(name)}'`,
    `mimeType='${escapeQueryValue(mimeType)}'`,
    'trashed=false',
    `'${escapeQueryValue(parentId ?? 'root')}' in parents`,
  ].join(' and ');
}

/* ---------- multipart 本文 ---------- */

export function createBoundary() {
  const cryptoObj = globalThis.crypto;

  if (typeof cryptoObj?.randomUUID === 'function') {
    return `tsam-${cryptoObj.randomUUID()}`;
  }

  if (typeof cryptoObj?.getRandomValues === 'function') {
    const bytes = cryptoObj.getRandomValues(new Uint8Array(16));
    return `tsam-${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
  }

  return `tsam-${String(Date.now())}`;
}

/*
 * multipart/related の本文を Blob として組み立てる。
 *
 * 画像は Blob のまま連結する。Base64化しないため、メモリが増えない。
 *
 * 本文パートの Content-Type は画像のMIME。**メタデータ側の mimeType を
 * Google ドキュメントにすることで、Drive が変換（＝OCR）を行う。**
 */
export function buildMultipartBody(metadata, blob, boundary) {
  const head = [
    `--${boundary}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    JSON.stringify(metadata),
    '',
    `--${boundary}`,
    `Content-Type: ${blob?.type || JPEG_MIME}`,
    '',
    '',
  ].join('\r\n');

  const tail = `\r\n--${boundary}--\r\n`;

  return new Blob([head, blob, tail], {
    type: `multipart/related; boundary=${boundary}`,
  });
}

/* ---------- ファイル操作 ---------- */

export async function searchFiles(name, mimeType, parentId, { token, fetchImpl, pageSize = 10 }) {
  const params = new URLSearchParams({
    q: buildChildQuery(name, mimeType, parentId),
    fields: 'files(id,name,modifiedTime)',
    orderBy: 'modifiedTime desc',
    pageSize: String(pageSize),
    spaces: 'drive',
  });

  const result = await driveFetchJson(`${DRIVE_FILES_ENDPOINT}?${params}`, { token, fetchImpl });

  return Array.isArray(result?.files) ? result.files : [];
}

/*
 * ファイル・フォルダのメタデータを取得する。
 * キャッシュしたIDがまだ使えるかの検証に使う。
 */
export async function getFileMeta(fileId, { token, fetchImpl }) {
  const params = new URLSearchParams({ fields: 'id,name,mimeType,parents,trashed' });

  return driveFetchJson(
    `${DRIVE_FILES_ENDPOINT}/${encodeURIComponent(fileId)}?${params}`,
    { token, fetchImpl },
  );
}

export async function createFolder(name, parentId, { token, fetchImpl }) {
  const metadata = { name, mimeType: DRIVE_FOLDER_MIME };

  if (parentId) {
    metadata.parents = [parentId];
  }

  const params = new URLSearchParams({ fields: 'id,name' });

  const result = await driveFetchJson(`${DRIVE_FILES_ENDPOINT}?${params}`, {
    token,
    fetchImpl,
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify(metadata),
  });

  if (!result?.id) {
    throw new DriveError(DriveErrorCode.UNKNOWN, 0, 'folder_id_missing');
  }

  return result.id;
}

export async function deleteFile(fileId, { token, fetchImpl }) {
  await driveRequest(`${DRIVE_FILES_ENDPOINT}/${encodeURIComponent(fileId)}`, {
    token,
    fetchImpl,
    method: 'DELETE',
  });
}

/*
 * Google Drive API v3 クライアント（AI議事録アプリ・保存専用）。
 *
 * public/production-app/audio-transcriber/drive-client.js からの複製・適合
 * （2026-08-18。本番アプリ間で共通層を作らず複製する …
 * docs/repository-structure.md §4）。このアプリは Drive を「保存先」として
 * しか使わないため、複製元にあった読み取り系（フォルダの厳密解決・
 * 音声一覧・ダウンロード）は持ち込まず、保存に要る部分だけを写した。
 *
 * 担当するのは Drive API の呼び出しだけ。
 * DOM操作・認可フロー・画面文言はここに置かない。
 * 認可（アクセストークンの取得）は ./oauth.js が担う。
 *
 * ------------------------------------------------------------------
 * drive.file スコープで「何が見えるか」（重要）
 * ------------------------------------------------------------------
 * このアプリは drive.file スコープだけを要求する。
 * このスコープで見える・書けるのは「同じOAuthクライアントのアプリが
 * 作成したファイル・フォルダ」に限られる。
 *
 * クライアントIDを voice-recorder / audio-transcriber と共用しているため
 * （config.js の OAUTH 参照）、それらが作成済みの「TSAM AI」フォルダは
 * このアプリからも見える。逆に、利用者が手動で作った同名フォルダは
 * 見えないことがあり、その場合は同名の別フォルダが作られうる。
 * それは drive.file の仕様であり、スコープを広げて回避してはならない。
 * ------------------------------------------------------------------
 *
 * ------------------------------------------------------------------
 * フォルダの特定方法
 * ------------------------------------------------------------------
 * 名前だけで Drive 全体を検索しない。必ず親フォルダIDを指定して、
 * 上から順に1階層ずつ降りる。
 *
 *   1. 'root'（マイドライブ直下）から TSAM AI を探す。無ければ作る
 *   2. TSAM AI の直下から 議事録データ を探す。無ければ作る
 *
 * フォルダIDは利用者ごとに違うので、コードに固定値として書かない。
 * 見つかった最初の1件を使う（保存先の用意は audio-transcriber の
 * 保存経路と同じ方針。読み取りと違い、書き込み先の重複は実害が小さい）。
 * ------------------------------------------------------------------
 *
 * APIキー・client secret・refresh token はここでは使用しない。
 * 認可はアクセストークン（Authorization ヘッダー）のみで行う。
 */

import { DRIVE_NAMES } from './config.js';

export const DRIVE_FOLDER_MIME = 'application/vnd.google-apps.folder';
export const MARKDOWN_MIME = 'text/markdown';

const FILES_ENDPOINT = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD_ENDPOINT = 'https://www.googleapis.com/upload/drive/v3/files';

export const DriveErrorCode = {
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  API_DISABLED: 'API_DISABLED',
  QUOTA_EXCEEDED: 'QUOTA_EXCEEDED',
  RATE_LIMITED: 'RATE_LIMITED',
  NOT_FOUND: 'NOT_FOUND',
  NETWORK: 'NETWORK',
  SERVER_ERROR: 'SERVER_ERROR',
  CANCELLED: 'CANCELLED',
  UNKNOWN: 'UNKNOWN',
};

export class DriveError extends Error {
  constructor(code, status = 0, detail = null) {
    super(code);
    this.name = 'DriveError';
    this.code = code;
    this.status = status;
    /* detail には API のエラー理由だけを入れる。トークンは入れない。 */
    this.detail = detail;
  }
}

/* ---------- エラー分類（audio-transcriber / voice-recorder と同じ方針） ---------- */

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

export function mapHttpErrorToCode(status, body) {
  const reason = extractReason(body);
  const message = String(body?.error?.message ?? '');

  if (status === 401) {
    return DriveErrorCode.UNAUTHORIZED;
  }

  if (status === 429) {
    return DriveErrorCode.RATE_LIMITED;
  }

  if (status === 404) {
    return DriveErrorCode.NOT_FOUND;
  }

  if (status === 403) {
    if (reason === 'accessNotConfigured'
      || /has not been used in project|is disabled|API has not been used/i.test(message)) {
      return DriveErrorCode.API_DISABLED;
    }

    if (reason === 'storageQuotaExceeded' || /storage quota|out of space/i.test(message)) {
      return DriveErrorCode.QUOTA_EXCEEDED;
    }

    if (reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded'
      || /rate limit/i.test(message)) {
      return DriveErrorCode.RATE_LIMITED;
    }

    return DriveErrorCode.FORBIDDEN;
  }

  if (status >= 500) {
    return DriveErrorCode.SERVER_ERROR;
  }

  return DriveErrorCode.UNKNOWN;
}

/* ---------- 低レベル呼び出し ---------- */

async function readJsonSafely(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/*
 * fetch を1か所に集約する。fetchImpl はテスト用の差し替え口。
 * ここでも上位でも、トークンをログへ出さないこと。
 */
async function driveFetchJson(url, { token, method = 'GET', body = null, headers = {}, signal, fetchImpl }) {
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
      signal,
    });
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new DriveError(DriveErrorCode.CANCELLED, 0, 'aborted');
    }

    throw new DriveError(DriveErrorCode.NETWORK, 0, error?.name ?? 'fetch_failed');
  }

  if (!response.ok) {
    const errorBody = await readJsonSafely(response);
    throw new DriveError(
      mapHttpErrorToCode(response.status, errorBody),
      response.status,
      extractReason(errorBody) || null,
    );
  }

  return readJsonSafely(response);
}

/* ---------- 保存先フォルダの用意 ---------- */

/* Drive の検索クエリでは \ と ' をエスケープする。 */
function escapeQueryValue(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

export function buildFolderQuery(name, parentId = null) {
  return [
    `name='${escapeQueryValue(name)}'`,
    `mimeType='${DRIVE_FOLDER_MIME}'`,
    'trashed=false',
    `'${escapeQueryValue(parentId ?? 'root')}' in parents`,
  ].join(' and ');
}

async function findFolder(name, parentId, options) {
  const params = new URLSearchParams({
    q: buildFolderQuery(name, parentId),
    fields: 'files(id,name)',
    pageSize: '1',
    spaces: 'drive',
  });

  const result = await driveFetchJson(`${FILES_ENDPOINT}?${params}`, options);
  const files = Array.isArray(result?.files) ? result.files : [];

  return files.length > 0 ? files[0].id : null;
}

async function createFolder(name, parentId, options) {
  const metadata = { name, mimeType: DRIVE_FOLDER_MIME };

  if (parentId) {
    metadata.parents = [parentId];
  }

  const params = new URLSearchParams({ fields: 'id' });
  const result = await driveFetchJson(`${FILES_ENDPOINT}?${params}`, {
    ...options,
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify(metadata),
  });

  if (!result?.id) {
    throw new DriveError(DriveErrorCode.UNKNOWN, 0, 'folder_id_missing');
  }

  return result.id;
}

async function ensureFolder(name, parentId, options) {
  const found = await findFolder(name, parentId, options);
  return found ?? createFolder(name, parentId, options);
}

/* マイドライブ / TSAM AI / 議事録データ を用意し、最下層のIDを返す。 */
export async function ensureMinutesFolder(options) {
  const rootId = await ensureFolder(DRIVE_NAMES.root, null, options);
  return ensureFolder(DRIVE_NAMES.minutes, rootId, options);
}

/* ---------- Markdown の保存 ---------- */

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

export function buildMultipartBody(metadata, blob, boundary) {
  const head = [
    `--${boundary}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    JSON.stringify(metadata),
    '',
    `--${boundary}`,
    `Content-Type: ${blob?.type || MARKDOWN_MIME}`,
    '',
    '',
  ].join('\r\n');

  const tail = `\r\n--${boundary}--\r\n`;

  return new Blob([head, blob, tail], {
    type: `multipart/related; boundary=${boundary}`,
  });
}

export function driveFileUrl(fileId) {
  return `https://drive.google.com/file/d/${encodeURIComponent(fileId)}/view`;
}

/*
 * 議事録Markdownを保存する。
 * 文字コードは UTF-8（Blob へ文字列を渡した時点で UTF-8 になる）。
 *
 * 毎回新しいファイルを作る（既存ファイルの上書き・更新はしない）。
 * 同名ファイルがあっても Drive は許容するため、保存し直すと別ファイルとして
 * 積み上がる。誤って前の版を消さないことを優先した判断である。
 */
export async function saveMinutesMarkdown({ token, text, fileName, signal, fetchImpl }) {
  const folderId = await ensureMinutesFolder({ token, signal, fetchImpl });
  const blob = new Blob([text], { type: `${MARKDOWN_MIME}; charset=utf-8` });
  const boundary = createBoundary();

  const body = buildMultipartBody(
    { name: fileName, mimeType: MARKDOWN_MIME, parents: [folderId] },
    blob,
    boundary,
  );

  const params = new URLSearchParams({
    uploadType: 'multipart',
    fields: 'id,name,webViewLink',
  });

  const result = await driveFetchJson(`${UPLOAD_ENDPOINT}?${params}`, {
    token,
    signal,
    fetchImpl,
    method: 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  });

  if (!result?.id) {
    throw new DriveError(DriveErrorCode.UNKNOWN, 0, 'file_id_missing');
  }

  return {
    id: result.id,
    name: result.name ?? fileName,
    webViewLink: result.webViewLink || driveFileUrl(result.id),
  };
}

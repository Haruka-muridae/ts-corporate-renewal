/*
 * Google Drive API v3 クライアント（音声文字起こしアプリ・本番用）。
 *
 * public/apps/audio-transcriber/drive-client.js からの複製・適合
 * （本番アプリからテスト環境を参照しない … docs/repository-structure.md §1）。
 *
 * 担当するのは Drive API の呼び出しだけ。
 * DOM操作・認可フロー・画面文言はここに置かない。
 * 認可（アクセストークンの取得）は ./oauth.js が担う。
 *
 * ------------------------------------------------------------------
 * drive.file スコープで「何が見えるか」（重要）
 * ------------------------------------------------------------------
 * このサイトの Drive 連携は drive.file スコープだけを要求する。
 * このスコープで見えるのは次の2種類に限られる。
 *
 *   A. 同じOAuthクライアントのアプリが作成したファイル
 *      → voice-recorder が保存した録音、このアプリが保存したTXT など
 *   B. 利用者が Google Picker で明示的に選んだファイル
 *
 * このアプリが読みに行くのは A である。
 * ブラウザ録音アプリ（production-app/voice-recorder/）は、このアプリと
 * 同じOAuthクライアント（config.js の OAUTH.clientId）で
 * 「マイドライブ / TSAM AI / Voice Recorder」へ録音を保存している。
 * 同一クライアントが作成したものなので、drive.file のままで一覧・取得できる。
 *
 * 利用者が手動でアップロードした音声は A にも B にも当たらないため見えない。
 * それは仕様であり、スコープを広げて回避してはならない。
 * ------------------------------------------------------------------
 *
 * ------------------------------------------------------------------
 * フォルダの特定方法（重要）
 * ------------------------------------------------------------------
 * 名前だけで Drive 全体を検索しない。必ず親フォルダIDを指定して、
 * 上から順に1階層ずつ降りる。
 *
 *   1. 'root' in parents から TSAM AI を探す
 *   2. TSAM AI の ID in parents から Voice Recorder を探す
 *   3. Voice Recorder の ID in parents から音声ファイルを取る
 *
 * フォルダIDは利用者ごとに違うので、コードに固定値として書かない。
 * ------------------------------------------------------------------
 *
 * APIキー・client secret・refresh token はここでは使用しない。
 * 認可はアクセストークン（Authorization ヘッダー）のみで行う。
 */

import { AUDIO_MIME_TYPES, DRIVE, DRIVE_NAMES } from './config.js';

export const DRIVE_FOLDER_MIME = 'application/vnd.google-apps.folder';
export const TEXT_MIME = 'text/plain';

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

  /* 固定フォルダの解決に固有のもの。 */
  ROOT_FOLDER_MISSING: 'ROOT_FOLDER_MISSING',
  APP_FOLDER_MISSING: 'APP_FOLDER_MISSING',
  ROOT_FOLDER_AMBIGUOUS: 'ROOT_FOLDER_AMBIGUOUS',
  APP_FOLDER_AMBIGUOUS: 'APP_FOLDER_AMBIGUOUS',
  NO_AUDIO_FILES: 'NO_AUDIO_FILES',

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

/* ---------- エラー分類（voice-recorder / card-scanner と同じ方針） ---------- */

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
 * fetch を1か所に集約し、生の Response を返す。
 * 音声本体は Blob で受けるため、応答の読み方は呼び出し側が選ぶ。
 * fetchImpl はテスト用の差し替え口。
 * ここでも上位でも、トークンをログへ出さないこと。
 */
async function driveRequest(url, { token, method = 'GET', body = null, headers = {}, signal, fetchImpl }) {
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

  return response;
}

async function driveFetchJson(url, options) {
  const response = await driveRequest(url, options);
  return readJsonSafely(response);
}

/* ---------- 固定フォルダの解決 ---------- */

/* Drive の検索クエリでは \ と ' をエスケープする。 */
function escapeQueryValue(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/*
 * 「特定の親の直下にある、この名前のフォルダ」を探すクエリ。
 *
 * parentId は必須。名前だけで Drive 全体を探させないための形にしてある。
 * マイドライブ直下を指すときは 'root' を渡す。
 */
export function buildFolderLookupQuery(name, parentId) {
  return [
    `name='${escapeQueryValue(name)}'`,
    `mimeType='${DRIVE_FOLDER_MIME}'`,
    `'${escapeQueryValue(parentId)}' in parents`,
    'trashed=false',
  ].join(' and ');
}

/*
 * 該当するフォルダを **すべて** 返す。
 *
 * 1件目だけを取らないのは、同名フォルダが複数あるときに
 * 黙ってどちらかを使ってしまわないため。判断は呼び出し側で行う。
 */
export async function findFoldersByName(name, parentId, { token, signal, fetchImpl } = {}) {
  const params = new URLSearchParams({
    q: buildFolderLookupQuery(name, parentId),
    /* 重複時に利用者へ提示するため、日時も取る。 */
    fields: 'files(id,name,createdTime,modifiedTime)',
    orderBy: 'createdTime',
    /* 重複は多くても数件。多すぎる場合は解決を諦めさせる。 */
    pageSize: '10',
    spaces: 'drive',
  });

  const result = await driveFetchJson(`${FILES_ENDPOINT}?${params}`, { token, signal, fetchImpl });

  return Array.isArray(result?.files) ? result.files : [];
}

/*
 * ちょうど1件に決まるときだけIDを返す。
 * 0件・複数件は、呼び出し側が渡したコードで投げ分ける。
 */
async function resolveSingleFolder(name, parentId, { missingCode, ambiguousCode, options }) {
  const folders = await findFoldersByName(name, parentId, options);

  if (folders.length === 0) {
    throw new DriveError(missingCode, 0, 'not_found');
  }

  if (folders.length > 1) {
    const error = new DriveError(ambiguousCode, 0, 'duplicated');
    /*
     * 利用者に選ばせるための候補。
     * 名前と日時だけで、他の情報は載せない。
     */
    error.candidates = folders.map((folder) => ({
      id: String(folder.id),
      name: String(folder.name ?? name),
      createdTime: folder.createdTime ?? null,
      modifiedTime: folder.modifiedTime ?? null,
    }));
    throw error;
  }

  return String(folders[0].id);
}

/*
 * マイドライブ / TSAM AI / Voice Recorder を上から順にたどってIDを解決する。
 *
 * 見つからなくても作らない。ここで作ると、録音アプリが使っているのとは
 * 別の空フォルダを増やしてしまい、利用者を余計に混乱させる。
 *
 * 戻り値: { rootId, folderId }
 */
export async function resolveVoiceRecorderFolder({ token, signal, fetchImpl } = {}) {
  const options = { token, signal, fetchImpl };

  /* 1. マイドライブ直下から TSAM AI を探す。 */
  const rootId = await resolveSingleFolder(DRIVE_NAMES.root, 'root', {
    missingCode: DriveErrorCode.ROOT_FOLDER_MISSING,
    ambiguousCode: DriveErrorCode.ROOT_FOLDER_AMBIGUOUS,
    options,
  });

  /* 2. TSAM AI の直下から Voice Recorder を探す。 */
  const folderId = await resolveSingleFolder(DRIVE_NAMES.voiceRecorder, rootId, {
    missingCode: DriveErrorCode.APP_FOLDER_MISSING,
    ambiguousCode: DriveErrorCode.APP_FOLDER_AMBIGUOUS,
    options,
  });

  return { rootId, folderId };
}

/* ---------- 音声ファイルの一覧 ---------- */

/*
 * 拡張子での補助判定。
 * Drive が MIME を空や application/octet-stream で返すことがあるため、
 * MIME だけで落とすと録音が一覧から消える。
 */
const AUDIO_EXTENSION_PATTERN = /\.(mp3|wav|m4a|aac|ogg|oga|webm|flac)$/i;

export function isAudioFile(file) {
  const mime = String(file?.mimeType ?? '').toLowerCase();

  if (AUDIO_MIME_TYPES.includes(mime) || mime === 'audio/mp3' || mime.startsWith('audio/')) {
    return true;
  }

  return AUDIO_EXTENSION_PATTERN.test(String(file?.name ?? ''));
}

/*
 * 指定フォルダ直下だけを対象にするクエリ。
 *
 * MIME での絞り込みはクエリへ入れず、取得後に isAudioFile で判定する。
 * Drive 側の MIME が当てにならない場合に取りこぼすのを避けるためで、
 * 対象は1フォルダの直下だけなので件数も問題にならない。
 */
export function buildFolderFilesQuery(folderId) {
  return `'${escapeQueryValue(folderId)}' in parents and trashed=false`;
}

/*
 * Voice Recorder フォルダ直下の音声ファイルを、更新日時の新しい順に返す。
 * ページ分割された場合は最後までたどる。
 */
export async function listVoiceRecorderAudio({ token, folderId, signal, fetchImpl } = {}) {
  const collected = [];
  let pageToken = '';

  for (let page = 0; page < DRIVE.maxListPages; page += 1) {
    const params = new URLSearchParams({
      q: buildFolderFilesQuery(folderId),
      fields: 'nextPageToken,files(id,name,mimeType,size,modifiedTime)',
      orderBy: 'modifiedTime desc',
      pageSize: String(DRIVE.listPageSize),
      spaces: 'drive',
    });

    if (pageToken) {
      params.set('pageToken', pageToken);
    }

    const result = await driveFetchJson(`${FILES_ENDPOINT}?${params}`, { token, signal, fetchImpl });

    if (Array.isArray(result?.files)) {
      collected.push(...result.files);
    }

    pageToken = typeof result?.nextPageToken === 'string' ? result.nextPageToken : '';

    if (!pageToken) {
      break;
    }
  }

  return collected.filter(isAudioFile);
}

/*
 * フォルダの解決と一覧取得をまとめて行う。
 *
 * folderId を渡すと解決を省く（同じセッション中の2回目以降）。
 * 戻り値: { folderId, files }
 */
export async function loadVoiceRecorderAudio({ token, folderId, signal, fetchImpl } = {}) {
  const resolvedId = folderId ?? (await resolveVoiceRecorderFolder({ token, signal, fetchImpl })).folderId;
  const files = await listVoiceRecorderAudio({ token, folderId: resolvedId, signal, fetchImpl });

  return { folderId: resolvedId, files };
}

/* 1件ぶんのメタデータ。Picker はMIMEを返さないことがあるため、ここで補う。 */
export async function getFileMetadata({ token, fileId, signal, fetchImpl }) {
  const params = new URLSearchParams({ fields: 'id,name,mimeType,size' });
  const url = `${FILES_ENDPOINT}/${encodeURIComponent(fileId)}?${params}`;

  return driveFetchJson(url, { token, signal, fetchImpl });
}

/* ---------- ダウンロード ---------- */

/*
 * ファイル本体を Blob として取得する。
 *
 * Gemini へは「Drive の URL」ではなく、ここで取得した実体を渡す。
 * Drive の URL をそのまま渡しても、Google 側は利用者の認可を持たないため読めない。
 */
export async function downloadFile({ token, fileId, mimeType, signal, fetchImpl }) {
  const params = new URLSearchParams({ alt: 'media' });
  const url = `${FILES_ENDPOINT}/${encodeURIComponent(fileId)}?${params}`;

  const response = await driveRequest(url, { token, signal, fetchImpl });

  let blob;

  try {
    blob = await response.blob();
  } catch (error) {
    throw new DriveError(DriveErrorCode.NETWORK, 0, error?.name ?? 'body_read_failed');
  }

  /*
   * Drive が Content-Type を返さない場合があるので、メタデータのMIMEで補う。
   * 型が空のままだと <audio> も decodeAudioData も判定に迷う。
   */
  if (!blob.type && mimeType) {
    return blob.slice(0, blob.size, mimeType);
  }

  return blob;
}

/* ---------- TXT の保存 ---------- */

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
    `Content-Type: ${blob?.type || TEXT_MIME}`,
    '',
    '',
  ].join('\r\n');

  const tail = `\r\n--${boundary}--\r\n`;

  return new Blob([head, blob, tail], {
    type: `multipart/related; boundary=${boundary}`,
  });
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

/* マイドライブ / TSAM AI / Audio Transcriber を用意し、最下層のIDを返す。 */
export async function ensureTranscriptFolder(options) {
  const rootId = await ensureFolder(DRIVE_NAMES.root, null, options);
  return ensureFolder(DRIVE_NAMES.audioTranscriber, rootId, options);
}

export function driveFileUrl(fileId) {
  return `https://drive.google.com/file/d/${encodeURIComponent(fileId)}/view`;
}

/*
 * 文字起こし結果のTXTを保存する。
 * 文字コードは UTF-8（Blob へ文字列を渡した時点で UTF-8 になる）。
 */
export async function saveTranscriptText({ token, text, fileName, signal, fetchImpl }) {
  const folderId = await ensureTranscriptFolder({ token, signal, fetchImpl });
  const blob = new Blob([text], { type: `${TEXT_MIME}; charset=utf-8` });
  const boundary = createBoundary();

  const body = buildMultipartBody(
    { name: fileName, mimeType: TEXT_MIME, parents: [folderId] },
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

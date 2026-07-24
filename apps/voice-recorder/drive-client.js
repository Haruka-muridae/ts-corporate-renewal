/*
 * Google Drive API v3 クライアント。
 * フォルダの確認・作成と、MP3の multipart アップロードだけを担当する。
 * DOM操作・認可フロー・UI文言はここに置かない。
 *
 * 権限は drive.file スコープのみ。
 * このスコープでは、このアプリが作成した（または利用者が明示的に選んだ）
 * ファイルとフォルダしか見えない。したがって files.list の検索結果にも、
 * 利用者が手動で作った同名フォルダは現れない（意図した挙動）。
 *
 * APIキー・client secret・refresh token は使用しない。
 * 認可はアクセストークン（Authorization ヘッダー）のみで行う。
 */

export const DRIVE_FOLDER_MIME = 'application/vnd.google-apps.folder';
export const MP3_MIME = 'audio/mpeg';

/* 保存先: マイドライブ / TSAM AI / Voice Recorder */
export const ROOT_FOLDER_NAME = 'TSAM AI';
export const APP_FOLDER_NAME = 'Voice Recorder';

const FILES_ENDPOINT = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD_ENDPOINT = 'https://www.googleapis.com/upload/drive/v3/files';

/* 保存後に取得するフィールド。必要なものだけに絞る。 */
export const RESULT_FIELDS = 'id,name,webViewLink,size,createdTime';

export const DriveErrorCode = {
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  API_DISABLED: 'API_DISABLED',
  QUOTA_EXCEEDED: 'QUOTA_EXCEEDED',
  RATE_LIMITED: 'RATE_LIMITED',
  NOT_FOUND: 'NOT_FOUND',
  NETWORK: 'NETWORK',
  SERVER_ERROR: 'SERVER_ERROR',
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

/* ---------- ファイル名 ---------- */

function pad2(value) {
  return String(value).padStart(2, '0');
}

/*
 * voice-recording_YYYY-MM-DD_HH-mm-ss.mp3
 * 日時は利用者のブラウザのローカル時刻。
 * 録音開始日時が分かる場合はそれを渡す（呼び出し側の責任）。
 */
export function buildDriveFileName(date = new Date()) {
  const stamp = [
    date.getFullYear(),
    pad2(date.getMonth() + 1),
    pad2(date.getDate()),
  ].join('-') + '_' + [
    pad2(date.getHours()),
    pad2(date.getMinutes()),
    pad2(date.getSeconds()),
  ].join('-');

  return `voice-recording_${stamp}.mp3`;
}

/* ---------- クエリ・メタデータ ---------- */

/* Drive の検索クエリでは \ と ' をエスケープする。 */
function escapeQueryValue(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/*
 * フォルダ検索クエリ。
 * trashed=false を必ず含め、ゴミ箱内のフォルダを再利用しないようにする。
 * parentId が null のときはマイドライブ直下（root）を対象にする。
 */
export function buildFolderQuery(name, parentId = null) {
  return [
    `name='${escapeQueryValue(name)}'`,
    `mimeType='${DRIVE_FOLDER_MIME}'`,
    'trashed=false',
    `'${escapeQueryValue(parentId ?? 'root')}' in parents`,
  ].join(' and ');
}

export function buildFolderMetadata(name, parentId = null) {
  const metadata = {
    name,
    mimeType: DRIVE_FOLDER_MIME,
  };

  if (parentId) {
    metadata.parents = [parentId];
  }

  return metadata;
}

export function buildFileMetadata(fileName, folderId) {
  const metadata = {
    name: fileName,
    mimeType: MP3_MIME,
  };

  if (folderId) {
    metadata.parents = [folderId];
  }

  return metadata;
}

/* webViewLink が取得できなかった場合の代替URL。 */
export function driveFileUrl(fileId) {
  return `https://drive.google.com/file/d/${encodeURIComponent(fileId)}/view`;
}

/* ---------- multipart 本文 ---------- */

/* 本文に現れない値を使う。ランダム性は crypto から取る。 */
export function createBoundary() {
  const cryptoObj = globalThis.crypto;

  if (typeof cryptoObj?.randomUUID === 'function') {
    return `tsam-${cryptoObj.randomUUID()}`;
  }

  if (typeof cryptoObj?.getRandomValues === 'function') {
    const bytes = cryptoObj.getRandomValues(new Uint8Array(16));
    return `tsam-${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
  }

  /* crypto が無い環境向けの最終手段。実ブラウザでは通らない。 */
  return `tsam-${String(Date.now())}-${String(performance?.now?.() ?? 0).replace('.', '')}`;
}

/*
 * multipart/related の本文を Blob として組み立てる。
 * 音声本体は Blob のまま連結するため、Base64化によるメモリ増加は起きない。
 */
export function buildMultipartBody(metadata, blob, boundary) {
  const head = [
    `--${boundary}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    JSON.stringify(metadata),
    '',
    `--${boundary}`,
    `Content-Type: ${blob?.type || MP3_MIME}`,
    '',
    '',
  ].join('\r\n');

  const tail = `\r\n--${boundary}--\r\n`;

  return new Blob([head, blob, tail], {
    type: `multipart/related; boundary=${boundary}`,
  });
}

/* ---------- エラー分類 ---------- */

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

/*
 * HTTPステータスと応答本文から、扱いやすいコードへ落とす。
 * 403 は原因が複数あるため、reason と message で切り分ける。
 */
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
 * fetch を1か所に集約する。
 * fetchImpl を差し替えられるようにしてあるのはテスト用。
 * ここでも上位でも、トークンをログへ出さないこと。
 */
async function driveFetch(url, { token, method = 'GET', body = null, headers = {}, fetchImpl }) {
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
      mapHttpErrorToCode(response.status, errorBody),
      response.status,
      extractReason(errorBody) || null,
    );
  }

  return readJsonSafely(response);
}

/* ---------- フォルダ ---------- */

/*
 * 同名フォルダを探す。
 * 複数見つかった場合は、最初に取得できたものを使う。
 * 見つからなければ null。
 */
export async function findFolder(name, parentId, { token, fetchImpl }) {
  const params = new URLSearchParams({
    q: buildFolderQuery(name, parentId),
    fields: 'files(id,name)',
    pageSize: '1',
    spaces: 'drive',
  });

  const result = await driveFetch(`${FILES_ENDPOINT}?${params}`, { token, fetchImpl });
  const files = Array.isArray(result?.files) ? result.files : [];

  return files.length > 0 ? files[0].id : null;
}

export async function createFolder(name, parentId, { token, fetchImpl }) {
  const params = new URLSearchParams({ fields: 'id,name' });

  const result = await driveFetch(`${FILES_ENDPOINT}?${params}`, {
    token,
    fetchImpl,
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify(buildFolderMetadata(name, parentId)),
  });

  if (!result?.id) {
    throw new DriveError(DriveErrorCode.UNKNOWN, 0, 'folder_id_missing');
  }

  return result.id;
}

/* 無ければ作り、あれば再利用する。 */
export async function ensureFolder(name, parentId, options) {
  const found = await findFolder(name, parentId, options);
  return found ?? createFolder(name, parentId, options);
}

/* マイドライブ / TSAM AI / Voice Recorder を用意し、最下層のIDを返す。 */
export async function ensureRecordingFolder(options) {
  const rootId = await ensureFolder(ROOT_FOLDER_NAME, null, options);
  return ensureFolder(APP_FOLDER_NAME, rootId, options);
}

/* ---------- アップロード ---------- */

export async function uploadMp3({ token, blob, fileName, folderId, fetchImpl }) {
  const boundary = createBoundary();
  const metadata = buildFileMetadata(fileName, folderId);
  const body = buildMultipartBody(metadata, blob, boundary);

  const params = new URLSearchParams({
    uploadType: 'multipart',
    fields: RESULT_FIELDS,
  });

  const result = await driveFetch(`${UPLOAD_ENDPOINT}?${params}`, {
    token,
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
    /* webViewLink が返らない場合はIDから組み立てる。 */
    webViewLink: result.webViewLink || driveFileUrl(result.id),
    size: result.size ?? null,
    createdTime: result.createdTime ?? null,
  };
}

/* フォルダ準備からアップロードまでの一連の流れ。 */
export async function saveMp3ToDrive({ token, blob, fileName, fetchImpl }) {
  const folderId = await ensureRecordingFolder({ token, fetchImpl });
  return uploadMp3({ token, blob, fileName, folderId, fetchImpl });
}

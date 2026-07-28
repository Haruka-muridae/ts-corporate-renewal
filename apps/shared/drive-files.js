/*
 * Google Drive API v3 の汎用クライアント。
 * /apps/ 配下の全アプリが共有する。
 *
 * フォルダの確認・作成、ファイルの検索、JSONの読み書き、
 * 任意Blobのアップロードだけを担当する。
 * DOM操作・認可フロー・UI文言はここに置かない。
 *
 * ------------------------------------------------------------------
 * 認可を持ち込まない（重要）
 * ------------------------------------------------------------------
 * このモジュールは drive-auth.js を import しない。
 * アクセストークンは必ず引数（options.token）で受け取る。
 * 401 の再認可は呼び出し側（drive-auth.js の withAccessToken）が行う。
 *
 * こうしておくと、このファイルは通信の組み立てだけを検証すればよく、
 * 純関数（クエリ組み立て・エラー写像）を単体で確認できる。
 * ------------------------------------------------------------------
 *
 * 権限は drive.file スコープを前提にしている。
 * このスコープでは、このアプリが作成した（または利用者が明示的に選んだ）
 * ファイルとフォルダしか見えない。したがって files.list の検索結果にも、
 * 利用者が手動で作った同名フォルダは現れない（意図した挙動）。
 * アプリの作成物への権限は **クライアントID単位** なので、
 * /apps/ 配下のアプリはすべて同じファイル群を扱える。
 *
 * APIキー・client secret・refresh token は使用しない。
 * 認可はアクセストークン（Authorization ヘッダー）のみで行う。
 * トークンをURLへ載せないこと（履歴・リファラ・ログに残るため）。
 */

export const DRIVE_FOLDER_MIME = 'application/vnd.google-apps.folder';
export const JSON_MIME = 'application/json';

/*
 * Drive上のフォルダ名の正本。
 * 各アプリでハードコードせず、必ずここを参照する。
 *
 * ROOT は voice-recorder（マイドライブ/TSAM AI/Voice Recorder）および
 * knowledge（マイドライブ/TSAM AI/ローカルLLM/01_ナレッジ）と一致している。
 */
export const DRIVE_PATHS = Object.freeze({
  ROOT: 'TSAM AI',
  MYPAGE: 'マイページ',
});

/* 表示用のラベル（先頭に付けるマイドライブの呼称）。 */
export const DRIVE_ROOT_LABEL = 'マイドライブ';

const FILES_ENDPOINT = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD_ENDPOINT = 'https://www.googleapis.com/upload/drive/v3/files';

/* 取得するフィールド。必要なものだけに絞る（転送量と権限の最小化）。 */
export const FILE_FIELDS = 'id,name,mimeType,size,modifiedTime,webViewLink';

/*
 * JSONとして読み込む際の上限。
 * 想定外に巨大なファイルを JSON.parse してタブを固まらせないための保険。
 */
export const MAX_JSON_BYTES = 1024 * 1024;

export const DriveErrorCode = Object.freeze({
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  API_DISABLED: 'API_DISABLED',
  QUOTA_EXCEEDED: 'QUOTA_EXCEEDED',
  RATE_LIMITED: 'RATE_LIMITED',
  NOT_FOUND: 'NOT_FOUND',
  NETWORK: 'NETWORK',
  SERVER_ERROR: 'SERVER_ERROR',
  TOO_LARGE: 'TOO_LARGE',
  BAD_CONTENT: 'BAD_CONTENT',
  CANCELLED: 'CANCELLED',
  UNKNOWN: 'UNKNOWN',
});

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

/* drive-auth.js の withAccessToken へ渡すための判定。 */
export function isUnauthorized(error) {
  return error?.code === DriveErrorCode.UNAUTHORIZED || error?.status === 401;
}

/* ---------- クエリ・メタデータ（純関数） ---------- */

/* Drive の検索クエリでは \ と ' をエスケープする。 */
export function escapeQueryValue(value) {
  return String(value ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/*
 * 「特定の親フォルダの直下にある、その名前のフォルダ」を探すクエリ。
 *
 * 条件は必ず4つそろえる。1つでも欠けると別階層の同名フォルダを拾う。
 *   1. 名前の一致
 *   2. フォルダ種別（mimeType）
 *   3. ゴミ箱除外（trashed=false）… ゴミ箱内のフォルダを再利用しないため
 *   4. 親フォルダID（parentId が null ならマイドライブ直下 = root）
 */
export function buildFolderQuery(name, parentId = null) {
  return [
    `name='${escapeQueryValue(name)}'`,
    `mimeType='${DRIVE_FOLDER_MIME}'`,
    'trashed=false',
    `'${escapeQueryValue(parentId ?? 'root')}' in parents`,
  ].join(' and ');
}

/* 「特定の親フォルダの直下にある、その名前のファイル」を探すクエリ。 */
export function buildFileQuery(name, parentId = null) {
  return [
    `name='${escapeQueryValue(name)}'`,
    `mimeType!='${DRIVE_FOLDER_MIME}'`,
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

export function buildFileMetadata(name, { parentId = null, mimeType = JSON_MIME } = {}) {
  const metadata = { name, mimeType };

  if (parentId) {
    metadata.parents = [parentId];
  }

  return metadata;
}

/* webViewLink が取得できなかった場合の代替URL。 */
export function driveFileUrl(fileId) {
  return `https://drive.google.com/file/d/${encodeURIComponent(fileId)}/view`;
}

/* 表示用のパス文字列。「マイドライブ / TSAM AI / マイページ」 */
export function formatPath(segments = []) {
  return [DRIVE_ROOT_LABEL, ...segments].join(' / ');
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
 * 本体は Blob のまま連結するため、Base64化によるメモリ増加は起きない。
 */
export function buildMultipartBody(metadata, body, boundary) {
  const contentType = (body instanceof Blob && body.type) ? body.type : JSON_MIME;

  const head = [
    `--${boundary}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    JSON.stringify(metadata),
    '',
    `--${boundary}`,
    `Content-Type: ${contentType}`,
    '',
    '',
  ].join('\r\n');

  const tail = `\r\n--${boundary}--\r\n`;

  return new Blob([head, body, tail], {
    type: `multipart/related; boundary=${boundary}`,
  });
}

/* ---------- エラー分類（純関数） ---------- */

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
async function driveFetch(url, {
  token,
  method = 'GET',
  body = null,
  headers = {},
  signal,
  fetchImpl,
  responseType = 'json',
}) {
  const doFetch = fetchImpl ?? globalThis.fetch;

  if (typeof doFetch !== 'function') {
    throw new DriveError(DriveErrorCode.NETWORK, 0, 'fetch_unavailable');
  }

  if (typeof token !== 'string' || token === '') {
    throw new DriveError(DriveErrorCode.UNAUTHORIZED, 401, 'token_missing');
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

  if (responseType === 'text') {
    return response.text();
  }

  if (responseType === 'none') {
    return null;
  }

  return readJsonSafely(response);
}

/* ---------- フォルダ ---------- */

/*
 * 同名フォルダを探す。
 * 複数見つかった場合は、最初に取得できたものを使う。
 * 見つからなければ null。
 */
export async function findFolder(name, parentId, { token, signal, fetchImpl } = {}) {
  const params = new URLSearchParams({
    q: buildFolderQuery(name, parentId),
    fields: 'files(id,name)',
    pageSize: '1',
    spaces: 'drive',
  });

  const result = await driveFetch(`${FILES_ENDPOINT}?${params}`, { token, signal, fetchImpl });
  const files = Array.isArray(result?.files) ? result.files : [];

  return files.length > 0 ? files[0].id : null;
}

export async function createFolder(name, parentId, { token, signal, fetchImpl } = {}) {
  const params = new URLSearchParams({ fields: 'id,name' });

  const result = await driveFetch(`${FILES_ENDPOINT}?${params}`, {
    token,
    signal,
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
export async function ensureFolder(name, parentId, options = {}) {
  const found = await findFolder(name, parentId, options);
  return found ?? createFolder(name, parentId, options);
}

/*
 * フォルダの階層をマイドライブ直下から順に用意し、最下層のIDを返す。
 *
 *   await ensureFolderPath([DRIVE_PATHS.ROOT, DRIVE_PATHS.MYPAGE], { token })
 *   → マイドライブ / TSAM AI / マイページ
 *
 * 名前だけの全体検索は行わない。必ず1階層ずつ親IDを指定して降りる
 * （別階層の同名フォルダを拾わないため）。
 *
 * 注意: drive.file スコープでは、利用者が手動で作った同名フォルダは見えない。
 * その場合はアプリが別途フォルダを作成する（既知かつ意図した挙動）。
 */
export async function ensureFolderPath(segments, options = {}) {
  if (!Array.isArray(segments) || segments.length === 0) {
    throw new DriveError(DriveErrorCode.UNKNOWN, 0, 'empty_path');
  }

  let parentId = null;

  for (const name of segments) {
    /* 上の階層が決まらないと次を探せないため、直列に実行する。 */
    /* eslint-disable-next-line no-await-in-loop */
    parentId = await ensureFolder(name, parentId, options);
  }

  return parentId;
}

/* ---------- ファイル ---------- */

/*
 * 親フォルダ直下から名前でファイルを探す。
 * 見つからなければ null（エラーにはしない）。
 */
export async function findFile(name, parentId, { token, signal, fetchImpl } = {}) {
  const params = new URLSearchParams({
    q: buildFileQuery(name, parentId),
    fields: `files(${FILE_FIELDS})`,
    pageSize: '1',
    spaces: 'drive',
    orderBy: 'modifiedTime desc',
  });

  const result = await driveFetch(`${FILES_ENDPOINT}?${params}`, { token, signal, fetchImpl });
  const files = Array.isArray(result?.files) ? result.files : [];

  return files.length > 0 ? files[0] : null;
}

/* 新規ファイルを作成する（multipart: メタデータ + 本体）。 */
export async function createFile({
  token,
  name,
  parentId,
  body,
  mimeType = JSON_MIME,
  signal,
  fetchImpl,
}) {
  const boundary = createBoundary();
  const metadata = buildFileMetadata(name, { parentId, mimeType });
  const payload = buildMultipartBody(metadata, body, boundary);

  const params = new URLSearchParams({
    uploadType: 'multipart',
    fields: FILE_FIELDS,
  });

  const result = await driveFetch(`${UPLOAD_ENDPOINT}?${params}`, {
    token,
    signal,
    fetchImpl,
    method: 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body: payload,
  });

  if (!result?.id) {
    throw new DriveError(DriveErrorCode.UNKNOWN, 0, 'file_id_missing');
  }

  return normalizeFileResult(result, name);
}

/*
 * 既存ファイルの中身を差し替える。
 * PATCH + uploadType=media なので、ファイルID・共有設定・作成日時は保たれる。
 * 親フォルダの移動は行わない（意図しない移動を避けるため）。
 */
export async function updateFileContent({
  token,
  fileId,
  body,
  mimeType = JSON_MIME,
  signal,
  fetchImpl,
}) {
  if (typeof fileId !== 'string' || fileId === '') {
    throw new DriveError(DriveErrorCode.UNKNOWN, 0, 'file_id_missing');
  }

  const params = new URLSearchParams({
    uploadType: 'media',
    fields: FILE_FIELDS,
  });

  const result = await driveFetch(
    `${UPLOAD_ENDPOINT}/${encodeURIComponent(fileId)}?${params}`,
    {
      token,
      signal,
      fetchImpl,
      method: 'PATCH',
      headers: { 'Content-Type': mimeType },
      body,
    },
  );

  return normalizeFileResult(result, null);
}

/* ファイル本体をテキストとして取得する。 */
export async function downloadFileText({ token, fileId, signal, fetchImpl }) {
  const params = new URLSearchParams({ alt: 'media' });

  return driveFetch(`${FILES_ENDPOINT}/${encodeURIComponent(fileId)}?${params}`, {
    token,
    signal,
    fetchImpl,
    responseType: 'text',
  });
}

function normalizeFileResult(result, fallbackName) {
  return {
    id: result?.id ?? null,
    name: result?.name ?? fallbackName,
    mimeType: result?.mimeType ?? null,
    size: result?.size ?? null,
    modifiedTime: result?.modifiedTime ?? null,
    /* webViewLink が返らない場合はIDから組み立てる。 */
    webViewLink: result?.webViewLink || (result?.id ? driveFileUrl(result.id) : null),
  };
}

/* ---------- JSON の読み書き ---------- */

/*
 * JSONファイルを読む。
 * 存在しない場合は null を返す（エラーにはしない）。
 *
 * 内容が壊れている・大きすぎる場合は BAD_CONTENT / TOO_LARGE を投げる。
 * 呼び出し側は「壊れていたら作り直す」判断ができる。
 */
export async function readJsonFile({ token, name, parentId, signal, fetchImpl }) {
  const file = await findFile(name, parentId, { token, signal, fetchImpl });

  if (!file) {
    return null;
  }

  const size = Number(file.size);

  if (Number.isFinite(size) && size > MAX_JSON_BYTES) {
    throw new DriveError(DriveErrorCode.TOO_LARGE, 0, `size:${size}`);
  }

  const text = await downloadFileText({ token, fileId: file.id, signal, fetchImpl });

  if (typeof text !== 'string' || text.length > MAX_JSON_BYTES) {
    throw new DriveError(DriveErrorCode.TOO_LARGE, 0, 'text_too_large');
  }

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    /*
     * 解析エラーのメッセージにはファイル内容が含まれ得るため、
     * 例外の中身は持ち回らない。
     */
    throw new DriveError(DriveErrorCode.BAD_CONTENT, 0, 'json_parse_failed');
  }

  return { file, data };
}

/*
 * JSONファイルを書く。無ければ作り、あれば中身を差し替える。
 * 戻り値の created で、新規作成だったかを判別できる。
 */
export async function writeJsonFile({ token, name, parentId, data, signal, fetchImpl }) {
  /* 2スペースインデント。利用者がDriveで直接開いても読める形にする。 */
  const text = JSON.stringify(data, null, 2);
  const body = new Blob([text], { type: `${JSON_MIME}; charset=UTF-8` });

  const existing = await findFile(name, parentId, { token, signal, fetchImpl });

  if (existing) {
    const file = await updateFileContent({
      token,
      fileId: existing.id,
      body,
      signal,
      fetchImpl,
    });

    return { file: { ...existing, ...file }, created: false };
  }

  const file = await createFile({
    token,
    name,
    parentId,
    body,
    signal,
    fetchImpl,
  });

  return { file, created: true };
}

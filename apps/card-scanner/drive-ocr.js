/*
 * Google Drive を使った名刺画像の文字認識（OCR）と、元画像の保存。
 *
 * 担当するのは Drive API v3 の呼び出しだけ。
 * DOM操作・認可フロー・画面文言・項目の振り分けはここに置かない。
 *
 * ------------------------------------------------------------------
 * なぜ Drive で OCR ができるのか
 * ------------------------------------------------------------------
 * 画像を mimeType='application/vnd.google-apps.document' として
 * アップロードすると、Drive 側が画像を Google ドキュメントへ変換する。
 * その変換の過程で OCR が走り、ドキュメント本文に文字が入る。
 * それを text/plain でエクスポートすれば文字列が得られる。
 *
 * この方式なら生成AIもAPIキーもCloudの課金も不要で、
 * 必要な権限は既存の drive.file スコープだけで足りる。
 *
 * 代償として、返るのはレイアウト情報を失った一続きのテキストである。
 * 項目への振り分けの限界は card-parser.js の冒頭に書いてある。
 * ------------------------------------------------------------------
 *
 * OCR用に作ったドキュメントは中間生成物なので必ず削除する。
 * 取得が失敗しても削除は実行する（finally）。
 *
 * APIキー・client secret・refresh token は使用しない。
 * 認可はアクセストークン（Authorization ヘッダー）のみで行う。
 */

export const DRIVE_FOLDER_MIME = 'application/vnd.google-apps.folder';
export const GOOGLE_DOC_MIME = 'application/vnd.google-apps.document';
export const JPEG_MIME = 'image/jpeg';

/*
 * 保存先の階層。実際の解決（キャッシュ検証 → 検索 → 選択/作成）は
 * drive-folders.js が行う。ここは名前の定義とAPI呼び出しだけを持つ。
 *
 *   マイドライブ / TSAM AI / 名刺スキャナ / 名刺画像 / 表面画像
 *                                                    / 裏面画像
 *                                        / 添付ファイル
 *
 * drive.file スコープで見えるのは「このクライアントIDが作成したファイル」だけ。
 * voice-recorder は同じクライアントIDを使うため、voice-recorder が作った
 * TSAM AI は検索で見つかり、再利用される。
 * 別のクライアントIDのアプリが作った TSAM AI や、利用者が手で作った TSAM AI は
 * 見えないため、その場合は同じ名前で新しく作る。
 */
export const ROOT_FOLDER_NAME = 'TSAM AI';
export const APP_FOLDER_NAME = '名刺スキャナ';
export const IMAGE_FOLDER_NAME = '名刺画像';
export const FRONT_IMAGE_FOLDER_NAME = '表面画像';
export const BACK_IMAGE_FOLDER_NAME = '裏面画像';
export const ATTACHMENT_FOLDER_NAME = '添付ファイル';

const FILES_ENDPOINT = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD_ENDPOINT = 'https://www.googleapis.com/upload/drive/v3/files';

/* OCRの言語ヒント。精度向上のために付ける。 */
const OCR_LANGUAGE = 'ja';

export const RESULT_FIELDS = 'id,name,webViewLink,createdTime';

export const DriveErrorCode = {
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  API_DISABLED: 'API_DISABLED',
  QUOTA_EXCEEDED: 'QUOTA_EXCEEDED',
  RATE_LIMITED: 'RATE_LIMITED',
  NOT_FOUND: 'NOT_FOUND',
  NETWORK: 'NETWORK',
  SERVER_ERROR: 'SERVER_ERROR',
  /* OCRは通ったが文字が1つも取れなかった。 */
  OCR_EMPTY: 'OCR_EMPTY',
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

/* ---------- ログ出力の差し替え ---------- */

/*
 * 既定では何も出力しない。呼び出し側が必要に応じて差し込む。
 * 渡してよいのは要約だけ。トークン・画像の内容・メールアドレスは渡さない。
 */
let logger = () => {};

export function setDriveOcrLogger(fn) {
  logger = typeof fn === 'function' ? fn : () => {};
}

/* ---------- ファイル名 ---------- */

function pad2(value) {
  return String(value).padStart(2, '0');
}

/* Drive のファイル名に使えない文字を落とす。 */
function sanitizeNamePart(value) {
  return String(value ?? '')
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/*
 * YYYY-MM-DD_HH-mm-ss_会社名_氏名_表.jpg
 * 会社名・氏名が空のときはその部分を省く。
 *
 * side は '表' / '裏' を想定する。省略した場合は付けない
 * （片面しか無い呼び出し方でもファイル名が壊れないようにするため）。
 */
export function buildCardImageFileName({
  date = new Date(),
  company = '',
  name = '',
  side = '',
} = {}) {
  const stamp = [
    date.getFullYear(),
    pad2(date.getMonth() + 1),
    pad2(date.getDate()),
  ].join('-') + '_' + [
    pad2(date.getHours()),
    pad2(date.getMinutes()),
    pad2(date.getSeconds()),
  ].join('-');

  const parts = [
    stamp,
    sanitizeNamePart(company),
    sanitizeNamePart(name),
    sanitizeNamePart(side),
  ].filter((part) => part !== '');

  return `${parts.join('_')}.jpg`;
}

/* ---------- クエリ・メタデータ ---------- */

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

export function buildFolderMetadata(name, parentId = null) {
  const metadata = { name, mimeType: DRIVE_FOLDER_MIME };

  if (parentId) {
    metadata.parents = [parentId];
  }

  return metadata;
}

/* webViewLink が取得できなかった場合の代替URL。 */
export function driveFileUrl(fileId) {
  return `https://drive.google.com/file/d/${encodeURIComponent(fileId)}/view`;
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
 * 画像は Blob のまま連結するため、Base64化によるメモリ増加は起きない。
 *
 * 本文パートの Content-Type は画像のMIME。
 * メタデータ側の mimeType を Google ドキュメントにすると、
 * Drive が「画像 → ドキュメント」の変換（＝OCR）を行う。
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

async function readTextSafely(response) {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

/*
 * fetch を1か所に集約し、生の Response を返す。
 *
 * export エンドポイントは JSON ではなくプレーンテキストを返すため、
 * 呼び出し側が応答の読み方を選べるようにしている。
 * fetchImpl を差し替えられるようにしてあるのはテスト用。
 * ここでも上位でも、トークンをログへ出さないこと。
 */
async function driveRequest(url, { token, method = 'GET', body = null, headers = {}, fetchImpl }) {
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

  return response;
}

async function driveFetchJson(url, options) {
  const response = await driveRequest(url, options);
  return readJsonSafely(response);
}

async function driveFetchText(url, options) {
  const response = await driveRequest(url, options);
  return readTextSafely(response);
}

/* ---------- フォルダ ---------- */

export async function findFolder(name, parentId, { token, fetchImpl }) {
  const found = await searchFolders(name, parentId, { token, fetchImpl });
  return found.length > 0 ? found[0].id : null;
}

/*
 * 名前・親・種別・未削除をすべて条件にしてフォルダを探す。
 *
 * 親を条件から外すと、別の場所にある同名フォルダを掴んでしまうため必ず含める。
 * 同名が複数ある場合に備えて modifiedTime の新しい順で返し、
 * 呼び出し側が「新しい方を仮採用して、利用者に選び直させる」判断をできるようにする。
 *
 * drive.file スコープでは、このクライアントIDが作成したフォルダだけが対象になる。
 *
 * 戻り値: [{ id, name, modifiedTime }]
 */
export async function searchFolders(name, parentId, { token, fetchImpl, pageSize = 10 }) {
  const params = new URLSearchParams({
    q: buildFolderQuery(name, parentId),
    fields: 'files(id,name,modifiedTime)',
    orderBy: 'modifiedTime desc',
    pageSize: String(pageSize),
    spaces: 'drive',
  });

  const result = await driveFetchJson(`${FILES_ENDPOINT}?${params}`, { token, fetchImpl });

  return Array.isArray(result?.files) ? result.files : [];
}

/*
 * ファイル・フォルダのメタデータを取得する。
 * キャッシュしたIDがまだ使えるかの検証に使う。
 *
 * 404（削除済み・存在しない）と403（権限が無い）はそのまま DriveError で返す。
 * 呼び出し側がキャッシュを捨てるかどうかを、コードを見て判断する。
 */
export async function getFileMeta(fileId, { token, fetchImpl }) {
  const params = new URLSearchParams({
    fields: 'id,name,mimeType,parents,trashed',
  });

  return driveFetchJson(
    `${FILES_ENDPOINT}/${encodeURIComponent(fileId)}?${params}`,
    { token, fetchImpl },
  );
}

export async function createFolder(name, parentId, { token, fetchImpl }) {
  const params = new URLSearchParams({ fields: 'id,name' });

  const result = await driveFetchJson(`${FILES_ENDPOINT}?${params}`, {
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

/* マイドライブ / TSAM AI / Card Scanner を用意し、最下層のIDを返す。 */
export async function ensureCardFolder(options) {
  const rootId = await ensureFolder(ROOT_FOLDER_NAME, null, options);
  return ensureFolder(APP_FOLDER_NAME, rootId, options);
}

/* ---------- OCR ---------- */

/*
 * 画像を Google ドキュメントへ変換してアップロードする。
 * 変換の過程で OCR が走る。戻り値はドキュメントのID。
 *
 * このドキュメントは中間生成物なので、呼び出し側が必ず削除する。
 * OCR用ドキュメントはフォルダに入れない（すぐ消すため）。
 */
async function uploadForOcr({ token, blob, fetchImpl }) {
  const boundary = createBoundary();
  const metadata = {
    /* 画面には出ない一時ファイル。消し忘れたときに識別できる名前にする。 */
    name: `card-scanner-ocr-${Date.now()}`,
    mimeType: GOOGLE_DOC_MIME,
  };
  const body = buildMultipartBody(metadata, blob, boundary);

  const params = new URLSearchParams({
    uploadType: 'multipart',
    ocrLanguage: OCR_LANGUAGE,
    fields: 'id',
  });

  const result = await driveFetchJson(`${UPLOAD_ENDPOINT}?${params}`, {
    token,
    fetchImpl,
    method: 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  });

  if (!result?.id) {
    throw new DriveError(DriveErrorCode.UNKNOWN, 0, 'ocr_file_id_missing');
  }

  return result.id;
}

/*
 * ドキュメントの本文をプレーンテキストで取り出す。
 *
 * このエンドポイントは JSON ではなくテキストを返すため、
 * response.json() ではなく response.text() で受ける。
 */
async function exportPlainText({ token, fileId, fetchImpl }) {
  const params = new URLSearchParams({ mimeType: 'text/plain' });
  const url = `${FILES_ENDPOINT}/${encodeURIComponent(fileId)}/export?${params}`;

  return driveFetchText(url, { token, fetchImpl });
}

/*
 * 一時ドキュメントを削除する。
 *
 * 失敗しても全体を失敗にしない。消えなかった場合は Drive に残るが、
 * OCR結果は既に取得できているため利用者の作業は続行できる。
 */
async function deleteFile({ token, fileId, fetchImpl }) {
  try {
    await driveRequest(`${FILES_ENDPOINT}/${encodeURIComponent(fileId)}`, {
      token,
      fetchImpl,
      method: 'DELETE',
    });
    logger('ocr:temp-deleted', { deleted: true });
  } catch (error) {
    /* 削除できなかったことだけ残す。ファイルIDや内容は出さない。 */
    logger('ocr:temp-delete-failed', {
      code: error instanceof DriveError ? error.code : 'UNEXPECTED',
    });
  }
}

/*
 * 画像から文字を読み取る。
 *
 *   アップロード（Google ドキュメントへ変換）
 *     → text/plain でエクスポート
 *     → 一時ドキュメントを削除（エクスポートが失敗しても実行する）
 *
 * 戻り値: { text }
 * 文字が1つも取れなかった場合は DriveError(OCR_EMPTY) を投げる。
 */
export async function ocrImage({ token, blob, fetchImpl }) {
  logger('ocr:start', { hasBlob: Boolean(blob), size: blob?.size ?? null, type: blob?.type ?? null });

  const fileId = await uploadForOcr({ token, blob, fetchImpl });
  logger('ocr:uploaded', { hasFileId: true });

  let text = '';

  try {
    text = await exportPlainText({ token, fileId, fetchImpl });
    /* 読み取れた文字数だけを出す。内容は出さない。 */
    logger('ocr:exported', { length: text.length });
  } finally {
    /* 取得が失敗しても中間生成物は必ず消す。 */
    await deleteFile({ token, fileId, fetchImpl });
  }

  if (text.trim() === '') {
    throw new DriveError(DriveErrorCode.OCR_EMPTY, 0, 'empty_text');
  }

  return { text };
}

/* ---------- 元画像の保存 ---------- */

/*
 * 縮小済みのJPEGを指定フォルダへ保存する。
 * OCRとは別の操作で、利用者が保存を選んだときだけ呼ぶ。
 *
 * folderId は drive-folders.js が解決したもの（表面画像 / 裏面画像）を渡す。
 * 省略された場合だけ、後方互換のために自前でフォルダを用意する。
 *
 * 戻り値: { id, webViewLink }
 */
export async function saveCardImage({ token, blob, fileName, folderId: givenFolderId, fetchImpl }) {
  const folderId = givenFolderId ?? await ensureCardFolder({ token, fetchImpl });

  const boundary = createBoundary();
  const metadata = {
    name: fileName,
    mimeType: JPEG_MIME,
    parents: [folderId],
  };
  const body = buildMultipartBody(metadata, blob, boundary);

  const params = new URLSearchParams({
    uploadType: 'multipart',
    fields: RESULT_FIELDS,
  });

  const result = await driveFetchJson(`${UPLOAD_ENDPOINT}?${params}`, {
    token,
    fetchImpl,
    method: 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  });

  if (!result?.id) {
    throw new DriveError(DriveErrorCode.UNKNOWN, 0, 'image_file_id_missing');
  }

  logger('image:saved', { hasFileId: true });

  return {
    id: result.id,
    name: result.name ?? fileName,
    webViewLink: result.webViewLink || driveFileUrl(result.id),
  };
}

/*
 * Google Drive API v3。
 *
 * 再利用元:
 *   - voice-recorder/drive.js … フォルダの名前解決・作成、resumable upload
 *   - audio-transcriber/drive-client.js … フォルダ直下の一覧・ダウンロード・multipart 保存
 *
 * 保存先だけを Potenitas voice / Potenitas record へ合わせる。
 * トークンは引数で受け取り、ここには保持しない。
 * permissions.create は持たない。
 */

import {
  AUDIO_MIME_TYPES,
  DRIVE,
  DRIVE_RECORD_PATH,
  DRIVE_VOICE_PATH,
  GOOGLE_API,
  MARKDOWN_MIME,
  MP3_MIME,
} from './config.js';
import { AppError, ErrorCode } from './errors.js';
import { withSequence } from './filename.js';

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const CHUNK_BYTES = 8 * 1024 * 1024;
const AUDIO_EXTENSION_PATTERN = /\.(mp3|wav|m4a|aac|ogg|oga|webm|flac)$/i;
const MARKDOWN_EXTENSION_PATTERN = /\.md$/i;

function escapeQueryValue(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
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

function toErrorCode(status, body) {
  const reason = extractReason(body);
  const message = String(body?.error?.message ?? '');

  if (status === 401) {
    return ErrorCode.OAUTH_EXPIRED;
  }

  if (status === 429) {
    return ErrorCode.DRIVE_RATE_LIMITED;
  }

  if (status === 403) {
    if (reason === 'accessNotConfigured'
      || /has not been used in project|is disabled|API has not been used/i.test(message)) {
      return ErrorCode.DRIVE_API_DISABLED;
    }

    if (reason === 'storageQuotaExceeded' || /storage quota|out of space/i.test(message)) {
      return ErrorCode.DRIVE_QUOTA;
    }

    if (reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded'
      || /rate limit/i.test(message)) {
      return ErrorCode.DRIVE_RATE_LIMITED;
    }

    return ErrorCode.FOLDER_FORBIDDEN;
  }

  if (status === 404) {
    return ErrorCode.FOLDER_FORBIDDEN;
  }

  return ErrorCode.UPLOAD_FAILED;
}

function tokenOf(auth) {
  return auth?.accessToken ?? auth?.token ?? '';
}

async function callJson(url, { accessToken, token, method = 'GET', body = null, headers = null, signal } = {}) {
  const requestHeaders = { Authorization: `Bearer ${accessToken ?? token}` };

  if (headers) {
    Object.assign(requestHeaders, headers);
  } else if (body !== null && !(body instanceof Blob)) {
    requestHeaders['Content-Type'] = 'application/json; charset=UTF-8';
  }

  let response;

  try {
    response = await fetch(url, {
      method,
      headers: requestHeaders,
      body: body === null
        ? undefined
        : (body instanceof Blob ? body : JSON.stringify(body)),
      signal,
    });
  } catch (error) {
    throw new AppError(ErrorCode.NETWORK, 'fetch_failed', error);
  }

  let payload = null;

  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    throw new AppError(toErrorCode(response.status, payload), `http_${response.status}`);
  }

  return payload ?? {};
}

export function driveFileUrl(fileId) {
  return `https://drive.google.com/file/d/${encodeURIComponent(fileId)}/view`;
}

export function fileViewUrl(file) {
  if (file?.webViewLink) {
    return file.webViewLink;
  }

  return file?.id ? driveFileUrl(file.id) : '';
}

async function findFolder(name, parentId, auth) {
  const url = new URL(GOOGLE_API.driveFiles);
  url.searchParams.set('q', [
    `name='${escapeQueryValue(name)}'`,
    `mimeType='${FOLDER_MIME}'`,
    'trashed=false',
    `'${escapeQueryValue(parentId)}' in parents`,
  ].join(' and '));
  url.searchParams.set('fields', 'files(id,name,createdTime)');
  url.searchParams.set('pageSize', '10');
  url.searchParams.set('spaces', 'drive');
  url.searchParams.set('orderBy', 'createdTime');

  const result = await callJson(url.href, auth);
  const files = Array.isArray(result.files) ? result.files : [];
  return files.length > 0 ? files[0].id : null;
}

async function createFolder(name, parentId, auth) {
  const metadata = { name, mimeType: FOLDER_MIME, parents: [parentId] };
  const url = new URL(GOOGLE_API.driveFiles);
  url.searchParams.set('fields', 'id');
  const result = await callJson(url.href, { ...auth, method: 'POST', body: metadata });

  if (!result?.id) {
    throw new AppError(ErrorCode.UPLOAD_FAILED, 'folder_id_missing');
  }

  return result.id;
}

async function findOrCreateFolder(name, parentId, auth) {
  const existing = await findFolder(name, parentId, auth);
  return existing ?? createFolder(name, parentId, auth);
}

export async function ensureFolderPath(names, auth) {
  let parentId = 'root';

  for (const name of names) {
    parentId = await findOrCreateFolder(name, parentId, auth);
  }

  return parentId;
}

export async function resolveVoiceFolder(auth) {
  return ensureFolderPath(DRIVE_VOICE_PATH, auth);
}

export async function resolveRecordFolder(auth) {
  return ensureFolderPath(DRIVE_RECORD_PATH, auth);
}

export function isAudioFile(file) {
  const mime = String(file?.mimeType ?? '').toLowerCase();

  if (AUDIO_MIME_TYPES.includes(mime) || mime === 'audio/mp3' || mime.startsWith('audio/')) {
    return true;
  }

  return AUDIO_EXTENSION_PATTERN.test(String(file?.name ?? ''));
}

export function isMarkdownFile(file) {
  const mime = String(file?.mimeType ?? '').toLowerCase();

  if (mime === MARKDOWN_MIME || mime === 'text/plain' || mime === 'text/x-markdown') {
    return MARKDOWN_EXTENSION_PATTERN.test(String(file?.name ?? '')) || mime === MARKDOWN_MIME;
  }

  return MARKDOWN_EXTENSION_PATTERN.test(String(file?.name ?? ''));
}

async function listFolderFiles(folderId, auth, fields) {
  const collected = [];
  let pageToken = '';

  for (let page = 0; page < DRIVE.maxListPages; page += 1) {
    const url = new URL(GOOGLE_API.driveFiles);
    url.searchParams.set('q', `'${escapeQueryValue(folderId)}' in parents and trashed=false`);
    url.searchParams.set('fields', `nextPageToken,files(${fields})`);
    url.searchParams.set('orderBy', 'modifiedTime desc');
    url.searchParams.set('pageSize', String(DRIVE.listPageSize));
    url.searchParams.set('spaces', 'drive');

    if (pageToken) {
      url.searchParams.set('pageToken', pageToken);
    }

    const result = await callJson(url.href, auth);

    if (Array.isArray(result?.files)) {
      collected.push(...result.files);
    }

    pageToken = typeof result?.nextPageToken === 'string' ? result.nextPageToken : '';

    if (!pageToken) {
      break;
    }
  }

  return collected;
}

const LIST_FIELDS = 'id,name,mimeType,size,createdTime,modifiedTime,webViewLink';

export async function listVoiceAudio(auth, folderId) {
  const id = folderId ?? await resolveVoiceFolder(auth);
  const files = await listFolderFiles(id, auth, LIST_FIELDS);
  return { folderId: id, files: files.filter(isAudioFile) };
}

export async function listRecordMarkdown(auth, folderId) {
  const id = folderId ?? await resolveRecordFolder(auth);
  const files = await listFolderFiles(id, auth, LIST_FIELDS);
  return { folderId: id, files: files.filter(isMarkdownFile) };
}

export async function getFileMetadata(fileId, auth) {
  const url = new URL(`${GOOGLE_API.driveFiles}/${encodeURIComponent(fileId)}`);
  url.searchParams.set('fields', LIST_FIELDS);
  return callJson(url.href, auth);
}

export async function downloadFile(fileId, auth, mimeType) {
  const url = new URL(`${GOOGLE_API.driveFiles}/${encodeURIComponent(fileId)}`);
  url.searchParams.set('alt', 'media');

  let response;

  try {
    response = await fetch(url.href, {
      headers: { Authorization: `Bearer ${tokenOf(auth)}` },
      signal: auth?.signal,
    });
  } catch (error) {
    throw new AppError(ErrorCode.NETWORK, 'download_failed', error);
  }

  if (!response.ok) {
    let payload = null;
    try { payload = await response.json(); } catch { payload = null; }
    throw new AppError(toErrorCode(response.status, payload), `download_http_${response.status}`);
  }

  let blob;

  try {
    blob = await response.blob();
  } catch (error) {
    throw new AppError(ErrorCode.NETWORK, 'download_body_failed', error);
  }

  if (!blob.type && mimeType) {
    return blob.slice(0, blob.size, mimeType);
  }

  return blob;
}

export async function pickAvailableName(desiredName, folderId, auth) {
  const files = await listFolderFiles(folderId, auth, 'name');
  const taken = new Set(files.map((file) => String(file.name)));

  if (!taken.has(desiredName)) {
    return desiredName;
  }

  for (let sequence = 2; sequence <= 1000; sequence += 1) {
    const candidate = withSequence(desiredName, sequence);

    if (!taken.has(candidate)) {
      return candidate;
    }
  }

  throw new AppError(ErrorCode.UPLOAD_FAILED, 'no_available_name');
}

async function createUploadSession({ name, folderId, size, mimeType }, auth) {
  const url = new URL(GOOGLE_API.driveUpload);
  url.searchParams.set('uploadType', 'resumable');
  url.searchParams.set('fields', 'id,name,webViewLink');

  let response;

  try {
    response = await fetch(url.href, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokenOf(auth)}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': mimeType,
        'X-Upload-Content-Length': String(size),
      },
      body: JSON.stringify({ name, mimeType, parents: [folderId] }),
      signal: auth.signal,
    });
  } catch (error) {
    throw new AppError(ErrorCode.NETWORK, 'session_fetch_failed', error);
  }

  if (!response.ok) {
    let payload = null;
    try { payload = await response.json(); } catch { payload = null; }
    throw new AppError(toErrorCode(response.status, payload), `session_http_${response.status}`);
  }

  const location = response.headers.get('location');

  if (!location) {
    throw new AppError(ErrorCode.UPLOAD_FAILED, 'no_session_uri');
  }

  return location;
}

async function readUploadChunk(source, start, end) {
  if (typeof source.readChunk === 'function') {
    return source.readChunk(start, end - start);
  }

  return source.file.slice(start, end);
}

export async function uploadResumable({
  file,
  name,
  folderId,
  mimeType = MP3_MIME,
  onProgress,
  signal,
  readChunk,
  size,
} = {}, auth) {
  const total = Number(size ?? file?.size ?? 0);

  if (!Number.isFinite(total) || total <= 0) {
    throw new AppError(ErrorCode.UPLOAD_FAILED, 'empty_file');
  }

  const sessionUri = await createUploadSession(
    { name, folderId, size: total, mimeType },
    { ...auth, signal },
  );

  let sent = 0;
  const source = { file, readChunk };

  while (sent < total) {
    const end = Math.min(sent + CHUNK_BYTES, total);
    const chunk = await readUploadChunk(source, sent, end);
    let response;

    try {
      response = await fetch(sessionUri, {
        method: 'PUT',
        headers: {
          'Content-Range': `bytes ${sent}-${end - 1}/${total}`,
        },
        body: chunk,
        signal,
      });
    } catch (error) {
      throw new AppError(ErrorCode.NETWORK, 'chunk_fetch_failed', error);
    }

    if (response.status === 308) {
      sent = end;
      onProgress?.(sent, total);
      continue;
    }

    if (response.ok) {
      let payload = null;
      try { payload = await response.json(); } catch { payload = null; }

      onProgress?.(total, total);

      const id = payload?.id ?? null;

      return {
        id,
        name: payload?.name ?? name,
        webViewLink: payload?.webViewLink ?? null,
        url: payload?.webViewLink ?? (id ? driveFileUrl(id) : null),
      };
    }

    let payload = null;
    try { payload = await response.json(); } catch { payload = null; }
    throw new AppError(toErrorCode(response.status, payload), `chunk_http_${response.status}`);
  }

  throw new AppError(ErrorCode.UPLOAD_FAILED, 'no_completion_response');
}

function createBoundary() {
  const cryptoObj = globalThis.crypto;

  if (typeof cryptoObj?.randomUUID === 'function') {
    return `tsam-${cryptoObj.randomUUID()}`;
  }

  return `tsam-${String(Date.now())}`;
}

function buildMultipartBody(metadata, blob, boundary) {
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

export async function saveMarkdown({ text, fileName, folderId, existingId, signal }, auth) {
  const blob = new Blob([text], { type: `${MARKDOWN_MIME}; charset=utf-8` });

  if (existingId) {
    const url = new URL(`${GOOGLE_API.driveUpload}/${encodeURIComponent(existingId)}`);
    url.searchParams.set('uploadType', 'media');
    url.searchParams.set('fields', 'id,name,webViewLink');

    const result = await callJson(url.href, {
      ...auth,
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${tokenOf(auth)}`,
        'Content-Type': MARKDOWN_MIME,
      },
      body: blob,
      signal,
    });

    return {
      id: result.id ?? existingId,
      name: result.name ?? fileName,
      url: result.webViewLink ?? driveFileUrl(result.id ?? existingId),
    };
  }

  const boundary = createBoundary();
  const body = buildMultipartBody(
    { name: fileName, mimeType: MARKDOWN_MIME, parents: [folderId] },
    blob,
    boundary,
  );

  const url = new URL(GOOGLE_API.driveUpload);
  url.searchParams.set('uploadType', 'multipart');
  url.searchParams.set('fields', 'id,name,webViewLink');

  const result = await callJson(url.href, {
    ...auth,
    method: 'POST',
    headers: {
      Authorization: `Bearer ${tokenOf(auth)}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body,
    signal,
  });

  const id = result.id ?? null;

  return {
    id,
    name: result.name ?? fileName,
    url: result.webViewLink ?? (id ? driveFileUrl(id) : null),
  };
}

export async function fetchAccountEmail(auth) {
  const url = new URL(`${GOOGLE_API.driveFiles.replace(/\/files$/, '')}/about`);
  url.searchParams.set('fields', 'user(emailAddress)');

  try {
    const result = await callJson(url.href, auth);
    const email = result?.user?.emailAddress;
    return typeof email === 'string' && email !== '' ? email : null;
  } catch {
    return null;
  }
}

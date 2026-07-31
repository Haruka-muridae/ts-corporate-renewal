/*
 * Google Drive API v3 クライアント（**読み取り専用**）。
 *
 * ------------------------------------------------------------------
 * 呼び出してよいエンドポイント
 * ------------------------------------------------------------------
 *   GET /about              … 表示用のアカウント情報（追加スコープ不要）
 *   GET /files              … 一覧（メタデータのみ）
 *   GET /files/{id}         … メタデータ / alt=media で本体取得
 *   GET /files/{id}/export  … Googleドキュメントのプレーンテキスト書き出し
 *
 * POST / PATCH / DELETE / upload は **一切呼ばない**。
 * Drive の容量を増やさないため、抽出テキスト等の書き戻しも行わない。
 * ------------------------------------------------------------------
 */

import { DRIVE_API_BASE, MIME } from '../config.js';
import { ensureAccessToken, clearAccessToken, setProfile } from '../auth/google-auth.js';
import { AppError, ErrorCode, driveErrorCode } from '../core/errors.js';
import { logger } from '../core/logger.js';

/* 一覧で取得するフィールド。必要な項目だけに絞る（転送量と権限の最小化）。 */
const FILE_FIELDS = 'id,name,mimeType,size,modifiedTime,version,md5Checksum,'
  + 'webViewLink,iconLink,trashed,shortcutDetails(targetId,targetMimeType)';

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

function buildUrl(path, params = {}) {
  const url = new URL(`${DRIVE_API_BASE}${path}`);

  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  });

  return url;
}

async function readErrorBody(response) {
  try {
    return await response.clone().json();
  } catch {
    return null;
  }
}

/*
 * Drive API 呼び出しの共通処理。
 *   - アクセストークンの付与（Authorization ヘッダー。URLへは絶対に載せない）
 *   - 401 のときの1回だけの再認可
 *   - 429 / 5xx の指数バックオフ
 *   - エラーの日本語コードへの変換
 */
async function request(path, { params = {}, responseType = 'json', signal, retries = 3, reauth = true } = {}) {
  const url = buildUrl(path, params);
  let attempt = 0;

  for (;;) {
    const token = await ensureAccessToken();

    let response;

    try {
      response = await fetch(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
        signal,
      });
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new AppError(ErrorCode.CANCELLED, 'aborted');
      }
      throw new AppError(ErrorCode.NETWORK_ERROR, error?.message ?? 'fetch_failed', error);
    }

    if (response.ok) {
      if (responseType === 'arrayBuffer') {
        return response.arrayBuffer();
      }
      if (responseType === 'text') {
        return response.text();
      }
      return response.json();
    }

    const body = await readErrorBody(response);
    const code = driveErrorCode(response.status, body);

    /* 401 は一度だけ、同意画面込みで取り直す。 */
    if (code === ErrorCode.AUTH_EXPIRED && reauth) {
      logger.warn('drive:token-expired', { path });
      clearAccessToken();
      await ensureAccessToken({ forceConsent: false });
      reauth = false;
      continue;
    }

    if (RETRYABLE.has(code) && attempt < retries) {
      attempt += 1;
      /* 1s, 2s, 4s（上限8s）。Retry-After があればそちらを優先する。 */
      const headerWait = Number(response.headers.get('retry-after'));
      const waitMs = Number.isFinite(headerWait) && headerWait > 0
        ? Math.min(headerWait * 1000, 30000)
        : Math.min(1000 * (2 ** (attempt - 1)), 8000);

      logger.warn('drive:retry', { path, status: response.status, attempt, waitMs });
      await sleep(waitMs, signal);
      continue;
    }

    logger.error('drive:request-failed', {
      path,
      status: response.status,
      reason: body?.error?.errors?.[0]?.reason ?? null,
      message: body?.error?.message ?? null,
    }, { code });

    const error = new AppError(code, `${response.status}`, body);
    /* 接続診断画面がHTTPステータスを表示できるようにする（本文は載せない）。 */
    error.status = response.status;
    error.reason = body?.error?.errors?.[0]?.reason ?? null;
    throw error;
  }
}

/* ---------- 公開API ---------- */

/*
 * 表示用のアカウント情報。
 * drive.readonly / drive.file のどちらでも呼べるため、追加スコープが要らない。
 */
export async function fetchAbout(signal) {
  const data = await request('/about', {
    params: { fields: 'user(displayName,emailAddress,photoLink),storageQuota(limit,usage)' },
    signal,
  });

  const profile = data?.user
    ? {
      displayName: String(data.user.displayName ?? ''),
      email: String(data.user.emailAddress ?? ''),
      photoLink: typeof data.user.photoLink === 'string' ? data.user.photoLink : '',
    }
    : null;

  setProfile(profile);
  return { profile, storageQuota: data?.storageQuota ?? null };
}

/*
 * フォルダ一覧（Picker が使えないときのフォールバック）。
 * parentId 未指定なら「マイドライブ直下」を返す。
 */
export async function listFolders({ parentId = 'root', pageToken, pageSize = 100, signal } = {}) {
  const q = [
    `'${escapeQueryValue(parentId)}' in parents`,
    `mimeType = '${MIME.GOOGLE_FOLDER}'`,
    'trashed = false',
  ].join(' and ');

  const data = await request('/files', {
    params: {
      q,
      fields: `nextPageToken, files(id,name,modifiedTime,webViewLink)`,
      pageSize,
      pageToken,
      orderBy: 'name',
      spaces: 'drive',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    },
    signal,
  });

  return {
    folders: Array.isArray(data.files) ? data.files : [],
    nextPageToken: data.nextPageToken ?? null,
  };
}

/*
 * 親フォルダIDを指定して、名前が一致するフォルダを探す。
 *
 * ------------------------------------------------------------------
 * 名前だけの全体検索は行わない（重要）
 * ------------------------------------------------------------------
 * Drive 全体を名前で検索すると、別階層の同名フォルダを拾う。
 * 必ず `'<親ID>' in parents` を条件に含め、1階層ずつ降りる。
 * ------------------------------------------------------------------
 *
 * Drive API の `name = '...'` は大文字小文字を区別しないことがあるため、
 * 取得後にクライアント側で**完全一致**（大文字小文字・前後空白を含む）を確認する。
 *
 * 戻り値: { exact: [...], loose: [...] }
 *   exact … 完全一致したフォルダ
 *   loose … サーバー側では一致したが、完全一致ではなかったもの（候補表示用）
 */
export async function findFoldersByName({ parentId, name, signal, pageSize = 50 }) {
  const data = await request('/files', {
    params: {
      q: buildFolderNameQuery({ parentId, name }),
      fields: 'nextPageToken, files(id,name,modifiedTime,webViewLink)',
      pageSize,
      orderBy: 'name',
      spaces: 'drive',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    },
    signal,
  });

  const folders = Array.isArray(data.files) ? data.files : [];
  const target = String(name);

  return {
    exact: folders.filter((folder) => String(folder.name) === target),
    loose: folders.filter((folder) => String(folder.name) !== target),
  };
}

/* フォルダ名などの単体メタデータ。 */
export async function fetchFileMeta(fileId, signal) {
  return request(`/files/${encodeURIComponent(fileId)}`, {
    params: {
      fields: FILE_FIELDS,
      supportsAllDrives: true,
    },
    signal,
  });
}

/* フォルダ直下のファイル一覧（1ページ分）。 */
export async function listFilesInFolder({ folderId, pageToken, pageSize = 100, signal }) {
  const data = await request('/files', {
    params: {
      q: buildChildrenQuery({ parentId: folderId }),
      fields: `nextPageToken, files(${FILE_FIELDS})`,
      pageSize,
      pageToken,
      orderBy: 'folder,name',
      spaces: 'drive',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    },
    signal,
  });

  return {
    files: Array.isArray(data.files) ? data.files : [],
    nextPageToken: data.nextPageToken ?? null,
  };
}

/*
 * フォルダを（必要なら再帰的に）走査して、全ファイルのメタデータを返す。
 * ショートカットは対象外にする（実体の二重取り込みを避けるため）。
 */
export async function collectFolderTree({
  folderId,
  folderName = '',
  recursive = true,
  maxDepth = 5,
  pageSize = 100,
  signal,
  onProgress,
}) {
  const files = [];
  const visited = new Set();
  const queue = [{ id: folderId, name: folderName, depth: 0 }];

  while (queue.length > 0) {
    const current = queue.shift();

    if (visited.has(current.id)) {
      continue;
    }
    visited.add(current.id);

    let pageToken;

    do {
      /* eslint-disable-next-line no-await-in-loop */
      const page = await listFilesInFolder({
        folderId: current.id,
        pageToken,
        pageSize,
        signal,
      });

      page.files.forEach((file) => {
        if (file.mimeType === MIME.GOOGLE_FOLDER) {
          if (recursive && current.depth < maxDepth) {
            queue.push({ id: file.id, name: file.name, depth: current.depth + 1 });
          }
          return;
        }

        /* ショートカットは実体側で取り込まれるためスキップする。 */
        if (file.shortcutDetails) {
          return;
        }

        files.push({ ...file, folderId: current.id, folderName: current.name });
      });

      pageToken = page.nextPageToken;

      if (typeof onProgress === 'function') {
        onProgress({ scanned: files.length, folder: current.name });
      }
    } while (pageToken);
  }

  return files;
}

/*
 * Googleドキュメントをプレーンテキストとして書き出す。
 * text/plain を指定するため、HTMLは一切受け取らない（XSS面を持ち込まない）。
 * Google 側の書き出し上限は10MB。超過は専用のエラーコードに変換される。
 */
export async function exportGoogleDoc(fileId, signal) {
  return request(`/files/${encodeURIComponent(fileId)}/export`, {
    params: { mimeType: 'text/plain' },
    responseType: 'text',
    signal,
  });
}

/* バイナリ本体を取得する（PDF / DOCX / TXT / Markdown）。 */
export async function downloadFile(fileId, signal) {
  return request(`/files/${encodeURIComponent(fileId)}`, {
    params: { alt: 'media', supportsAllDrives: true },
    responseType: 'arrayBuffer',
    signal,
  });
}

/*
 * Drive の検索クエリに文字列を埋め込む際のエスケープ。
 * ' と \ を落とすだけで足りる（IDは英数字が前提だが、外部由来の値を信用しない）。
 */
function escapeQueryValue(value) {
  return String(value ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/*
 * 「特定の親フォルダの直下にある、その名前のフォルダ」を探すクエリ。
 *
 * 条件は必ず4つそろえる。1つでも欠けると別階層の同名フォルダを拾う。
 *   1. 親フォルダID（'<id>' in parents）
 *   2. フォルダ種別（mimeType）
 *   3. ゴミ箱除外（trashed = false）
 *   4. 名前の一致（name = '...'）
 *
 * 単体で検証できるよう、通信から切り離した純関数にしてある。
 */
export function buildFolderNameQuery({ parentId, name }) {
  return [
    `'${escapeQueryValue(parentId)}' in parents`,
    `mimeType = '${MIME.GOOGLE_FOLDER}'`,
    'trashed = false',
    `name = '${escapeQueryValue(name)}'`,
  ].join(' and ');
}

/* 「特定の親フォルダの直下にあるファイル（ゴミ箱を除く）」を取るクエリ。 */
export function buildChildrenQuery({ parentId }) {
  return [
    `'${escapeQueryValue(parentId)}' in parents`,
    'trashed = false',
  ].join(' and ');
}

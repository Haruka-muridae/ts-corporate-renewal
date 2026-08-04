/*
 * Drive API v3 の下回り（通信・エラー分類・multipart 本文）。
 *
 * ==================================================================
 * 複製元
 * ==================================================================
 * public/production-app/card-ocr/poc/drive-api.js を複製（2026-08-04）。
 * その元は public/apps/card-scanner/drive-ocr.js の下回り部分。
 * **どちらも import はしない**（docs/repository-structure.md §2-1・§4-1）。
 *
 * PoC からの変更:
 *   - 定数を ./config.js へ移した
 *   - **500番台を UNKNOWN に落とすのをやめた**（下記）
 *   - **403 の内訳を分けた**（容量不足 / レート制限 / 権限不足）
 *   - AbortSignal を通せるようにした（領収書OCRから取り込み）
 * ==================================================================
 *
 * ==================================================================
 * 失敗の中身を潰さないこと
 * ==================================================================
 * PoC は 500番台を UNKNOWN に落としていた。そのため Gemini 側で 503
 * （混雑）が出たとき「不明なエラー（SYS-999）」としか表示されず、
 * 原因の切り分けに何時間もかかった（フェーズ0計画 §7-5-2）。
 *
 * 領収書OCRは 401/403/404 以外をすべて1つのコードに潰しており、
 * 画像アップロードの失敗でも「シートへの書き込みに失敗しました」と
 * 表示される（docs/receipt-ocr-findings-20260804.md #5）。
 *
 * **待てば直るのか、操作で直るのか、こちらの不具合なのか。**
 * この3つが区別できる粒度まで分ける。
 * ==================================================================
 *
 * 方針:
 *   - トークンは引数で受け取り、このモジュールに保持しない
 *   - 例外にトークンを含めない
 *   - fetchImpl を差し替えられるようにする（テストで実APIを叩かないため）
 */

import {
  DRIVE_FILES_ENDPOINT,
  DRIVE_FOLDER_MIME,
  JPEG_MIME,
} from './config.js';

export const DriveErrorCode = {
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  /* ドライブの空き容量が無い。利用者が消せば直る。 */
  STORAGE_FULL: 'STORAGE_FULL',
  NOT_FOUND: 'NOT_FOUND',
  RATE_LIMITED: 'RATE_LIMITED',
  /* Google 側の一時的な障害。待てば直る。 */
  SERVER_ERROR: 'SERVER_ERROR',
  /* こちらの組み立てが不正。利用者の操作では直らない。 */
  BAD_REQUEST: 'BAD_REQUEST',
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

/*
 * 画面に出す言葉。エラーコードは要件定義書 §15 に対応する。
 *
 * **§15 に無いコードを作らない。** 仕様書が実装の正なので、
 * 分類を細かくしても表に出すコードは §15 の範囲に収める。
 * 分けた甲斐は「利用者が次に何をすればよいか」の文言に出す。
 */
export function describeDriveError(error) {
  const isKnown = error instanceof DriveError;
  const code = isKnown ? error.code : DriveErrorCode.UNKNOWN;
  const detail = isKnown
    ? String(error.detail ?? '')
    : `${error?.name ?? 'Error'}: ${error?.message ?? String(error)}`;

  const described = (text, errorCode) => ({ text, errorCode, detail });

  switch (code) {
    case DriveErrorCode.UNAUTHORIZED:
      return described('Google連携の期限が切れました。連携し直してください。', 'OAUTH-002');
    case DriveErrorCode.FORBIDDEN:
      return described('ドライブへの操作が許可されませんでした。', 'DRV-001');
    case DriveErrorCode.STORAGE_FULL:
      return described('Googleドライブの空き容量がありません。整理してからお試しください。', 'DRV-001');
    case DriveErrorCode.NOT_FOUND:
      return described('対象が見つかりませんでした。', 'SETUP-002');
    case DriveErrorCode.RATE_LIMITED:
      return described('利用が集中しています。時間をおいてお試しください。', 'DRV-001');
    case DriveErrorCode.SERVER_ERROR:
      return described('Google側で一時的なエラーが起きました。時間をおいてお試しください。', 'DRV-001');
    case DriveErrorCode.BAD_REQUEST:
      return described('ドライブへの要求が不正でした（設定の問題です）。', 'DRV-001');
    case DriveErrorCode.NETWORK:
      return described('通信に失敗しました。', 'DRV-001');
    default:
      return described('ドライブの操作に失敗しました。', 'DRV-001');
  }
}

export function extractReason(body) {
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
 * HTTPステータスと reason から分類する。
 *
 * **403 を一括りにしない。** Drive はレート制限も 403 で返す。
 * 認可の問題として扱うと、呼び出し側が「トークンを捨てて再連携」へ
 * 進んでしまい、待てば直るものを直らなくする
 * （docs/receipt-ocr-findings-20260804.md #2）。
 */
export function mapHttpErrorToCode(status, reason = '') {
  const code = String(reason ?? '');

  if (status === 400) {
    return DriveErrorCode.BAD_REQUEST;
  }

  if (status === 401) {
    return DriveErrorCode.UNAUTHORIZED;
  }

  if (status === 403) {
    /*
     * 容量不足を先に見る。`storageQuotaExceeded` は下の
     * `quotaExceeded` にも一致してしまうため、順序に意味がある。
     */
    if (/storageQuotaExceeded|insufficientStorage/i.test(code)) {
      return DriveErrorCode.STORAGE_FULL;
    }

    /*
     * `rateLimitExceeded` は `userRateLimitExceeded` と
     * `sharingRateLimitExceeded` にも一致する。
     * 単独の `quotaExceeded` は API 側のクォータで、容量ではない
     * （容量不足は `storageQuotaExceeded` として返る）。
     */
    if (/rateLimitExceeded|dailyLimitExceeded|quotaExceeded/i.test(code)) {
      return DriveErrorCode.RATE_LIMITED;
    }

    return DriveErrorCode.FORBIDDEN;
  }

  if (status === 404) {
    return DriveErrorCode.NOT_FOUND;
  }

  if (status === 429) {
    return DriveErrorCode.RATE_LIMITED;
  }

  if (status >= 500) {
    return DriveErrorCode.SERVER_ERROR;
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
export async function driveRequest(url, {
  token,
  method = 'GET',
  body = null,
  headers = {},
  fetchImpl,
  signal = null,
}) {
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
    /*
     * 中断は失敗ではない。呼び出し側が「利用者がやめた」と
     * 「通信できなかった」を区別できるよう、detail に残す。
     */
    const aborted = error?.name === 'AbortError' || signal?.aborted === true;

    throw new DriveError(
      DriveErrorCode.NETWORK,
      0,
      aborted ? 'aborted' : (error?.name ?? 'fetch_failed'),
    );
  }

  if (!response.ok) {
    const errorBody = await readJsonSafely(response);
    const reason = extractReason(errorBody);

    throw new DriveError(
      mapHttpErrorToCode(response.status, reason),
      response.status,
      reason || null,
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

/*
 * boundary は**その本文の中に現れない並び**でなければならない。
 *
 * 内容から決めると（例: サイズとMIMEを連結する）、現れないと言える
 * 根拠が無い。画像の中身は利用者が決めるものである
 * （docs/receipt-ocr-findings-20260804.md #7）。
 */
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

export async function searchFiles(name, mimeType, parentId, { token, fetchImpl, signal, pageSize = 10 }) {
  const params = new URLSearchParams({
    q: buildChildQuery(name, mimeType, parentId),
    fields: 'files(id,name,createdTime)',
    /*
     * **古いほうを先頭にする。** 同名のものが複数見つかったときは、
     * 先に作られたほうを正本として採る（領収書OCRと揃えた。
     * docs/receipt-ocr-findings-20260804.md の逆方向の項）。
     * 新しいほうを採ると、事故で増えた空のフォルダへ乗り換えてしまう。
     */
    orderBy: 'createdTime',
    pageSize: String(pageSize),
    spaces: 'drive',
  });

  const result = await driveFetchJson(`${DRIVE_FILES_ENDPOINT}?${params}`, { token, fetchImpl, signal });

  return Array.isArray(result?.files) ? result.files : [];
}

/*
 * ファイル・フォルダのメタデータを取得する。
 * キャッシュしたIDがまだ使えるかの検証に使う。
 */
export async function getFileMeta(fileId, { token, fetchImpl, signal }) {
  const params = new URLSearchParams({ fields: 'id,name,mimeType,parents,trashed' });

  return driveFetchJson(
    `${DRIVE_FILES_ENDPOINT}/${encodeURIComponent(fileId)}?${params}`,
    { token, fetchImpl, signal },
  );
}

export async function createFolder(name, parentId, { token, fetchImpl, signal }) {
  const metadata = { name, mimeType: DRIVE_FOLDER_MIME };

  if (parentId) {
    metadata.parents = [parentId];
  }

  const params = new URLSearchParams({ fields: 'id,name' });

  const result = await driveFetchJson(`${DRIVE_FILES_ENDPOINT}?${params}`, {
    token,
    fetchImpl,
    signal,
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify(metadata),
  });

  if (!result?.id) {
    throw new DriveError(DriveErrorCode.UNKNOWN, 0, 'folder_id_missing');
  }

  return result.id;
}

export async function deleteFile(fileId, { token, fetchImpl, signal }) {
  await driveRequest(`${DRIVE_FILES_ENDPOINT}/${encodeURIComponent(fileId)}`, {
    token,
    fetchImpl,
    signal,
    method: 'DELETE',
  });
}

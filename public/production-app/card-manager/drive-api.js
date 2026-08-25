/*
 * Drive / Sheets API の下回り（通信・エラー分類）。
 *
 * ==================================================================
 * 複製元
 * ==================================================================
 * ../card-mail/drive-api.js を複製（2026-08-20）。**import はしない**
 * （docs/repository-structure.md §4-1）。
 *
 * 複製元から変えたところ:
 *   - 無し（このアプリも card-mail と同じく、書き込み系（アップロード・
 *     フォルダ作成・削除）を持たない。台帳の検索・読み込みと、
 *     Sheets の values.update / values:append だけを使う）
 * ==================================================================
 *
 * ==================================================================
 * 失敗の中身を潰さないこと（複製元と同じ）
 * ==================================================================
 * **待てば直るのか、操作で直るのか、こちらの不具合なのか。**
 * この3つが区別できる粒度まで分ける。403 を一括りにしない
 * （Drive はレート制限も 403 で返す）。
 * ==================================================================
 *
 * 方針:
 *   - トークンは引数で受け取り、このモジュールに保持しない
 *   - 例外にトークンを含めない
 *   - fetchImpl を差し替えられるようにする（テストで実APIを叩かないため）
 */

import { DRIVE_FILES_ENDPOINT } from './config.js';

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

/* 画面に出す言葉。 */
export function describeDriveError(error) {
  const isKnown = error instanceof DriveError;
  const code = isKnown ? error.code : DriveErrorCode.UNKNOWN;
  const status = isKnown ? Number(error.status ?? 0) : 0;
  const detail = isKnown
    ? String(error.detail ?? '')
    : `${error?.name ?? 'Error'}: ${error?.message ?? String(error)}`;

  const described = (text, errorCode) => ({ text, errorCode, detail, status, code });

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

/*
 * 分類に使う識別子（`insufficientPermissions` など）を取り出す。
 * **これは分類のためだけ。** 画面へ出すのは下の summarizeErrorBody。
 */
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
 * 原因の要約を作る。**画面へ出すのはこの値である。**
 * HTTPステータスを必ず入れる（reason だけでは対処を選べない）。
 */
export function summarizeErrorBody(body, status) {
  const error = body?.error;
  const parts = [];

  const reason = extractReason(body);

  if (reason !== '') {
    parts.push(reason);
  }

  if (typeof error?.message === 'string' && error.message !== '') {
    parts.push(error.message);
  }

  if (parts.length === 0) {
    return `HTTP ${status}`;
  }

  const text = `HTTP ${status} ${parts.join(': ')}`;

  /* 長すぎると画面が壊れる。頭を切る。トークンは本文に出ない。 */
  return text.length > 300 ? `${text.slice(0, 297)}…` : text;
}

/*
 * HTTPステータスと reason から分類する。
 *
 * **403 を一括りにしない。** Drive はレート制限も 403 で返す。
 * 認可の問題として扱うと、呼び出し側が「トークンを捨てて再連携」へ
 * 進んでしまい、待てば直るものを直らなくする。
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

/*
 * Google API を呼ぶ。名前は drive だが、中身は「Authorization を付けて
 * fetch する」だけで、Sheets にも使える。エラー分類も共通で効く。
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
    /* エラー応答の本文を読んでから投げる（複製元と同じ理由）。 */
    const errorBody = await readJsonSafely(response);
    const reason = extractReason(errorBody);

    throw new DriveError(
      mapHttpErrorToCode(response.status, reason),
      response.status,
      summarizeErrorBody(errorBody, response.status),
    );
  }

  return response;
}

export async function driveFetchJson(url, options) {
  const response = await driveRequest(url, options);
  return readJsonSafely(response);
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

/* ---------- ファイル参照 ---------- */

export async function searchFiles(name, mimeType, parentId, { token, fetchImpl, signal, pageSize = 10 }) {
  const params = new URLSearchParams({
    q: buildChildQuery(name, mimeType, parentId),
    fields: 'files(id,name,createdTime)',
    /*
     * **古いほうを先頭にする。** 同名のものが複数見つかったときは、
     * 先に作られたほうを正本として採る（card-ocr と同じ判断）。
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

/*
 * Google Drive API v3 の呼び出し（要件書 §FR-03 / §FR-07 / §FR-08 / §8.2）。
 *
 * 担当するのは Drive の操作だけ。DOM操作・画面文言・判断はここに置かない。
 * トークンは引数で受け取り、このモジュールでは保持しない（§8.1）。
 *
 * ------------------------------------------------------------------
 * 共有設定を一切付与しない
 * ------------------------------------------------------------------
 * このファイルには permissions.create を呼ぶ関数が無い。**足さないこと。**
 * 保存先は利用者本人のマイドライブであり、当社も他人も見えなくてよい。
 * ------------------------------------------------------------------
 *
 * 使うスコープは drive.file のみ（§FR-02）。
 * これは「このアプリが作成したファイル」だけに届くため、
 * 名前検索で見つかるのも自分の作成物に限られる。
 * 保存先フォルダを ID で固定登録せず名前から解決・作成しているのは、この制約による。
 */

import { GOOGLE_API, DRIVE_NAMES, MP3_MIME } from './config.js';
import { AppError, ErrorCode } from './errors.js';
import { withSequence } from './filename.js';

const FOLDER_MIME = 'application/vnd.google-apps.folder';

/*
 * resumable upload のチャンク長。
 * Google の仕様で 256KB の倍数であることが要る。8MB なら 90分（約86MB）でも
 * 11回程度で終わり、1回あたりの再送も現実的な大きさに収まる。
 */
const CHUNK_BYTES = 8 * 1024 * 1024;

/* Drive の検索クエリでは \ と ' をエスケープする。 */
function escapeQueryValue(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/* API のエラー本文から reason を取り出す（トークンは含まれない）。 */
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
 * HTTPステータスと応答本文を、画面が扱えるエラーコードへ落とす。
 * 403 は原因が複数あるため、reason と message で切り分ける。
 */
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

/* JSON を返す API 呼び出し。失敗は AppError にして投げる。 */
async function callJson(url, { accessToken, method = 'GET', body = null, signal } = {}) {
  const headers = { Authorization: `Bearer ${accessToken}` };

  if (body !== null) {
    headers['Content-Type'] = 'application/json; charset=UTF-8';
  }

  let response;

  try {
    response = await fetch(url, {
      method,
      headers,
      body: body === null ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (error) {
    /* 通信そのものが成立しなかった。中断も含む。 */
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

/* ---------- 連携アカウント ---------- */

/*
 * 連携中の Google アカウントのメールアドレス（§FR-02）。
 *
 * GIS のトークンモデルはアクセストークンしか返さず、誰と連携したかは分からない。
 * そこで Drive の about.get から取る。
 *
 * **取れなくても保存は続行できる。** スコープや API の状態によっては 403 になり得るため、
 * 失敗は null で返し、画面は「連携済み」だけを出す。ここで例外を投げて
 * 保存操作そのものを止めない（表示のための情報にすぎない）。
 */
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

/* ---------- フォルダ ---------- */

/*
 * 親の直下から名前でフォルダを探す。見つからなければ null。
 * trashed=false を必ず入れる。ゴミ箱の中のフォルダを再利用しないため。
 */
async function findFolder(name, parentId, auth) {
  const query = [
    `name='${escapeQueryValue(name)}'`,
    `mimeType='${FOLDER_MIME}'`,
    'trashed=false',
    `'${escapeQueryValue(parentId)}' in parents`,
  ].join(' and ');

  const url = new URL(GOOGLE_API.driveFiles);
  url.searchParams.set('q', query);
  url.searchParams.set('fields', 'files(id,name)');
  url.searchParams.set('pageSize', '10');

  const result = await callJson(url.href, auth);
  const files = Array.isArray(result.files) ? result.files : [];

  return files.length > 0 ? files[0].id : null;
}

async function createFolder(name, parentId, auth) {
  const url = new URL(GOOGLE_API.driveFiles);
  url.searchParams.set('fields', 'id,name');

  const created = await callJson(url.href, {
    ...auth,
    method: 'POST',
    body: { name, mimeType: FOLDER_MIME, parents: [parentId] },
  });

  if (!created?.id) {
    throw new AppError(ErrorCode.FOLDER_FORBIDDEN, 'folder_create_no_id');
  }

  return created.id;
}

async function findOrCreateFolder(name, parentId, auth) {
  const existing = await findFolder(name, parentId, auth);
  return existing ?? createFolder(name, parentId, auth);
}

/*
 * 保存先「マイドライブ ＞ TSAM AI ＞ Voice Recorder」を解決する（§FR-03）。
 *
 * ID は返すが、**呼び出し側で保存しないこと。** 利用者ごとに違う値であり、
 * 次回も名前から引き直す。config.js にも書かない。
 */
export async function resolveTargetFolder(auth) {
  const rootId = await findOrCreateFolder(DRIVE_NAMES.root, 'root', auth);
  const appId = await findOrCreateFolder(DRIVE_NAMES.app, rootId, auth);
  return appId;
}

/* ---------- ファイル名の重複 ---------- */

/*
 * 保存先にある同名ファイルを避けた名前を返す（§FR-07）。
 * `名前.mp3` が既にあれば `名前_2.mp3`、それもあれば `名前_3.mp3`…。
 *
 * drive.file スコープでは「このアプリが作成したファイル」しか見えない。
 * 利用者が手で置いた同名ファイルは検索に出てこないため、そのときは
 * Drive 側に同名が2つ並ぶ。Drive は同名を許すので保存は成功する。
 * これは避けられない（スコープを広げない方針を優先する）。
 */
export async function pickAvailableName(desiredName, folderId, auth) {
  const url = new URL(GOOGLE_API.driveFiles);
  url.searchParams.set('q', [
    'trashed=false',
    `'${escapeQueryValue(folderId)}' in parents`,
  ].join(' and '));
  url.searchParams.set('fields', 'files(name)');
  url.searchParams.set('pageSize', '1000');

  const result = await callJson(url.href, auth);
  const taken = new Set(
    (Array.isArray(result.files) ? result.files : []).map((f) => String(f.name)),
  );

  if (!taken.has(desiredName)) {
    return desiredName;
  }

  /* 1000件も同名が並ぶことは無いが、無限ループにはしない。 */
  for (let sequence = 2; sequence <= 1000; sequence += 1) {
    const candidate = withSequence(desiredName, sequence);

    if (!taken.has(candidate)) {
      return candidate;
    }
  }

  throw new AppError(ErrorCode.UPLOAD_FAILED, 'no_available_name');
}

/* ---------- resumable upload ---------- */

/*
 * アップロードセッションを開始し、セッションURIを得る。
 *
 * セッションURIは Location ヘッダーで返る。Google は CORS の
 * Access-Control-Expose-Headers に location を含めているため読み取れる。
 */
async function createUploadSession({ name, folderId, size }, auth) {
  const url = new URL(GOOGLE_API.driveUpload);
  url.searchParams.set('uploadType', 'resumable');
  url.searchParams.set('fields', 'id,name,webViewLink');

  let response;

  try {
    response = await fetch(url.href, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${auth.accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': MP3_MIME,
        'X-Upload-Content-Length': String(size),
      },
      body: JSON.stringify({ name, mimeType: MP3_MIME, parents: [folderId] }),
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
    /* CORS の設定変更などでヘッダーが読めなくなった場合。 */
    throw new AppError(ErrorCode.UPLOAD_FAILED, 'no_session_uri');
  }

  return location;
}

/*
 * MP3 を分割送信する（§FR-08 / §8.2）。
 *
 * File.slice は実データを読み込まずに範囲を指すだけなので、
 * 86MB のファイルでもメモリには乗らない。ここが「全体をメモリに置かない」
 * という §8.2 の要件と対になる。
 *
 * onProgress(sentBytes, totalBytes) は各チャンクの完了時に呼ぶ。
 */
export async function uploadResumable({ file, name, folderId, onProgress, signal }, auth) {
  const total = file.size;

  if (total === 0) {
    throw new AppError(ErrorCode.UPLOAD_FAILED, 'empty_file');
  }

  const sessionUri = await createUploadSession(
    { name, folderId, size: total },
    { ...auth, signal },
  );

  let sent = 0;

  while (sent < total) {
    const end = Math.min(sent + CHUNK_BYTES, total);
    const chunk = file.slice(sent, end);

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

    /*
     * 308 は「ここまで受け取った、続けてよい」。
     * fetch は Location の無い 308 をリダイレクトとして追えないため、
     * そのまま応答として返ってくる。これが分割送信の続行条件になる。
     */
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
        /* webViewLink が無い場合に備え、ID から組み立てた URL を代わりに使う。 */
        url: payload?.webViewLink
          ?? (id ? `https://drive.google.com/file/d/${encodeURIComponent(id)}/view` : null),
      };
    }

    let payload = null;
    try { payload = await response.json(); } catch { payload = null; }
    throw new AppError(toErrorCode(response.status, payload), `chunk_http_${response.status}`);
  }

  /* ループを抜けたのに完了応答が来ていない。 */
  throw new AppError(ErrorCode.UPLOAD_FAILED, 'no_completion_response');
}

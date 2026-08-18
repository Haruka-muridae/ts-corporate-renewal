/*
 * Drive API v3 の呼び出し（仕様書 §5-① / §5-④ / §9）。
 *
 * 担当するのは Drive の操作だけ。DOM操作・画面文言・判断はここに置かない。
 *
 * ------------------------------------------------------------------
 * 共有設定を一切付与しない（§9.5）
 * ------------------------------------------------------------------
 * このファイルには permissions.create を呼ぶ関数が無い。
 * **足さないこと。** §9.5 と §15.2 が「作成物に共有設定が付与されていない」ことを
 * 求めており、自動テストもそれを見ている。
 * ------------------------------------------------------------------
 *
 * 使うスコープは drive.file のみ（§4-2）。
 * これは「このアプリが作成したファイル」だけに届くため、
 * 名前検索（§9.2-3）で見つかるのも自分の作成物に限られる。
 * 利用者のドライブ全体は見えないし、見てはならない。
 */

import { GOOGLE_API } from './config.js';
import { PROGRESS } from './errors.js';
import { callGoogle, callGoogleJson, quoteDriveQueryValue } from './google-api.js';

export const FOLDER_MIME = 'application/vnd.google-apps.folder';
export const SPREADSHEET_MIME = 'application/vnd.google-apps.spreadsheet';
export const GOOGLE_DOC_MIME = 'application/vnd.google-apps.document';

/*
 * ファイルの情報を取る。
 * 見つからない・触れない場合は null を返す（例外にしない）。
 * §9.2-2 の「存在・アクセス可を確認」がこれにあたり、
 * 呼び出し側は null を見て §9.2-3 の名前検索へ進む。
 */
export async function getFileMeta(fileId, { accessToken, signal } = {}) {
  const url = new URL(`${GOOGLE_API.driveFiles}/${encodeURIComponent(fileId)}`);
  url.searchParams.set('fields', 'id,name,mimeType,trashed,parents,createdTime');

  try {
    const meta = await callGoogle(url.href, { accessToken, signal, progress: PROGRESS.NONE });

    /* ゴミ箱の中は「無い」として扱う。復活させる判断はアプリが持たない。 */
    return meta?.trashed === true ? null : meta;
  } catch (error) {
    /*
     * 「見つからない（404）」「触れない（401 / 403）」は null にして、
     * 呼び出し側の名前検索（§9.2-3）へ渡す。
     *
     * DRV-004 は 2026-08-18 に 403 を OAUTH-001 から切り出したときに
     * 加えた。ここへ足さないと、記憶した ID へ触れなくなった利用者が
     * 名前検索による復旧経路へ進めなくなる（従来は 403 が OAUTH-001 として
     * ここで null になっていた）。
     *
     * **レート制限（RATE-001）と通信断（NET-001）は握らない。**
     * 「無い」ことの証拠にならず、握ると空のシートをもう1つ作りかねない。
     */
    if (error?.code === 'DRV-001' || error?.code === 'OAUTH-001' || error?.code === 'DRV-004') {
      return null;
    }

    throw error;
  }
}

/*
 * multipart の境界文字列を作る（2026-08-18 追加）。
 *
 * 複製元: public/production-app/card-ocr/drive-api.js の createBoundary()
 * （複製日 2026-08-18。import はしない。docs/repository-structure.md §4-1）。
 *
 * boundary の要件は「**その本文の中に同じ並びが現れないこと**」である。
 * 改訂前は `receipt-${Math.random()}-${blob.size}` や
 * `ocr-${blob.size}-${blob.type.length}` のように内容から決めており、
 * 後者は短い ASCII 列なので、画像のバイナリに現れないと言える根拠が無い
 * （画像の中身は利用者が決める。findings #7）。
 *
 * crypto.randomUUID → getRandomValues → 時刻の三段で落とす。
 * 最後の段は安全ではないが、Web Crypto が無い環境でも動くための保険である。
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

  return `tsam-${String(Date.now())}-${String(Math.random()).slice(2)}`;
}

/*
 * 名前・親・種別で探す（§9.2-3）。
 *
 * 作成日時の昇順で返す。§9.3 の「2タブ同時初回起動」で
 * 「作成日時が古い方へ寄せる」ために、並び順をここで決めておく。
 */
export async function findByName(name, {
  accessToken,
  parentId = null,
  mimeType = FOLDER_MIME,
  signal,
} = {}) {
  const clauses = [
    `name = ${quoteDriveQueryValue(name)}`,
    `mimeType = ${quoteDriveQueryValue(mimeType)}`,
    'trashed = false',
  ];

  if (parentId) {
    clauses.push(`${quoteDriveQueryValue(parentId)} in parents`);
  }

  const url = new URL(GOOGLE_API.driveFiles);
  url.searchParams.set('q', clauses.join(' and '));
  url.searchParams.set('fields', 'files(id,name,mimeType,createdTime,parents)');
  url.searchParams.set('orderBy', 'createdTime');
  url.searchParams.set('pageSize', '100');

  const result = await callGoogle(url.href, { accessToken, signal, progress: PROGRESS.NONE });

  return Array.isArray(result?.files) ? result.files : [];
}

/*
 * 名前に文字列を含むものを探す（2026-08-18 追加）。
 *
 * Drive の q は前方一致を書けないため `name contains` で拾い、
 * 前方一致の絞り込みは呼び出し側が行う。用途は OCR 一時ドキュメントの
 * 孤児回収（§9.5・findings #6）だけであり、**drive.file スコープなので
 * このアプリが作ったものしか返らない。** 利用者の他のファイルには届かない。
 */
export async function findByNameContains(fragments, {
  accessToken,
  mimeType = GOOGLE_DOC_MIME,
  pageSize = 50,
  signal,
} = {}) {
  const list = (Array.isArray(fragments) ? fragments : [fragments])
    .map((value) => String(value ?? '').trim())
    .filter((value) => value !== '');

  if (list.length === 0) {
    return [];
  }

  const nameClause = list
    .map((fragment) => `name contains ${quoteDriveQueryValue(fragment)}`)
    .join(' or ');

  const url = new URL(GOOGLE_API.driveFiles);
  url.searchParams.set('q', [
    `(${nameClause})`,
    `mimeType = ${quoteDriveQueryValue(mimeType)}`,
    'trashed = false',
  ].join(' and '));
  url.searchParams.set('fields', 'files(id,name,createdTime)');
  url.searchParams.set('orderBy', 'createdTime');
  url.searchParams.set('pageSize', String(pageSize));

  const result = await callGoogle(url.href, { accessToken, signal, progress: PROGRESS.NONE });

  return Array.isArray(result?.files) ? result.files : [];
}

/* フォルダを作る。共有設定は付けない（§9.5）。 */
export async function createFolder(name, { accessToken, parentId = null, signal } = {}) {
  const body = { name: String(name), mimeType: FOLDER_MIME };

  if (parentId) {
    body.parents = [parentId];
  }

  const url = new URL(GOOGLE_API.driveFiles);
  url.searchParams.set('fields', 'id,name,mimeType,createdTime');

  return callGoogleJson(url.href, {
    accessToken,
    method: 'POST',
    body,
    signal,
    progress: PROGRESS.NONE,
  });
}

/*
 * 名前で探し、無ければ作る。
 *
 * **キャッシュが空というだけで作らない。** 必ず検索を通してから作る
 * （§9.2-3 → §9.2-4 の順序。localStorage 消去後の再発見が §15.2 の要件）。
 */
export async function findOrCreateFolder(name, { accessToken, parentId = null, signal } = {}) {
  const found = await findByName(name, { accessToken, parentId, mimeType: FOLDER_MIME, signal });

  if (found.length > 0) {
    return { folder: found[0], created: false, duplicates: found.slice(1) };
  }

  return { folder: await createFolder(name, { accessToken, parentId, signal }), created: true, duplicates: [] };
}

/*
 * 原本の月別フォルダを用意する（§9.1「保存時に随時作成」）。
 * 原本/YYYY/MM の2階層を、必要な分だけ掘る。
 */
export async function ensureMonthFolder({ accessToken, originalsFolderId, year, month, signal }) {
  const yearFolder = await findOrCreateFolder(String(year), {
    accessToken,
    parentId: originalsFolderId,
    signal,
  });

  const monthFolder = await findOrCreateFolder(String(month), {
    accessToken,
    parentId: yearFolder.folder.id,
    signal,
  });

  return monthFolder.folder;
}

/*
 * 原本画像を上げる（§5-④）。
 *
 * multipart で「情報」と「中身」を1回の要求にまとめる。
 * 失敗したときの progress は NONE（まだ原本も保存できていない）。
 */
export async function uploadImage({ accessToken, blob, name, parentId, signal }) {
  const metadata = { name: String(name), parents: [parentId] };
  /* 内容から決めない（findings #7）。 */
  const boundary = createBoundary();

  const head = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${blob.type || 'application/octet-stream'}\r\n\r\n`;
  const tail = `\r\n--${boundary}--`;

  const body = new Blob([head, blob, tail], { type: `multipart/related; boundary=${boundary}` });

  const url = new URL(GOOGLE_API.driveUpload);
  url.searchParams.set('uploadType', 'multipart');
  url.searchParams.set('fields', 'id,name,webViewLink');

  return callGoogle(url.href, {
    accessToken,
    method: 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
    signal,
    progress: PROGRESS.NONE,
  });
}

/*
 * 親フォルダを付け替える。
 *
 * Sheets API で作ったスプレッドシートはマイドライブの直下に出るため、
 * 作成直後に §9.1 の階層へ入れ直す。ここでも共有設定は触らない（§9.5）。
 */
export async function moveFile(fileId, { accessToken, parentId, previousParentId = null, signal } = {}) {
  const url = new URL(`${GOOGLE_API.driveFiles}/${encodeURIComponent(fileId)}`);
  url.searchParams.set('addParents', parentId);
  url.searchParams.set('fields', 'id,parents');

  if (previousParentId) {
    url.searchParams.set('removeParents', previousParentId);
  } else {
    url.searchParams.set('removeParents', 'root');
  }

  return callGoogleJson(url.href, {
    accessToken,
    method: 'PATCH',
    body: {},
    signal,
    progress: PROGRESS.NONE,
  });
}

/*
 * 消す。OCR一時ドキュメントの即時削除に使う（§9.5）。
 * 失敗しても呼び出し側を止めない（消し残りは次回の掃除対象）。
 */
export async function deleteFile(fileId, { accessToken, signal } = {}) {
  try {
    await callGoogle(`${GOOGLE_API.driveFiles}/${encodeURIComponent(fileId)}`, {
      accessToken,
      method: 'DELETE',
      signal,
      progress: PROGRESS.NONE,
    });
    return true;
  } catch {
    return false;
  }
}

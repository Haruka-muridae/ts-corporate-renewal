/*
 * 保存構造の解決（要件定義書 §FR-07、8.1 ステージ0）。
 *
 * **検証ページ専用の名前を使う**（下の ★ を参照）。
 * 本番アプリと同じ名前にすると、同じクライアントIDのため取り合いになる。
 *
 *   マイドライブ
 *   └─ TSAM AI
 *      └─ 名刺データ（フェーズ0検証）
 *         ├─ 名刺管理（フェーズ0検証）（Googleスプレッドシート）
 *         └─ images
 *
 * ==================================================================
 * 複製元
 * ==================================================================
 * public/apps/card-scanner/drive-folders.js の3段階解決と、
 * sheets-client.js の台帳作成を複製したもの。**import はしない。**
 * （docs/repository-structure.md §2-1、要件定義書 §3）
 *
 * 複製元との違い:
 *   - フォルダ名を要件定義書 §FR-07 に合わせた
 *     （card-scanner は `TSAM AI/名刺スキャナ/`）
 *   - 同名フォルダが複数見つかったときの「利用者に選ばせる」分岐を
 *     落とした。検証ページでは最新のものを使う
 *   - 台帳の列は検証用の最小構成にした。MVPの列構成は §11.2 で決める
 * ==================================================================
 *
 * ==================================================================
 * localStorage はキャッシュであって正本ではない
 * ==================================================================
 * 正本は Drive 上の実体である。localStorage は「前回そこにあった」という
 * 手がかりに過ぎない。したがって空でも、消えても、別端末でも動く。
 *
 * 解決は必ず3段階を通る。
 *
 *   段階1 … キャッシュのIDを検証する
 *            有効     → そのまま使う
 *            404/403  → キャッシュを捨てて段階2
 *            401/通信不良 → **キャッシュを捨てない**（認可・一時障害のため）
 *   段階2 … 名前・親・種別・未削除で検索する
 *            見つかればキャッシュへ書き戻す
 *   段階3 … 見つからなければ作成する
 *            **キャッシュが空というだけでは作らない。** 段階2を必ず通す
 * ==================================================================
 */

import {
  DRIVE_FILES_ENDPOINT,
  DRIVE_FOLDER_MIME,
  DriveError,
  DriveErrorCode,
  GOOGLE_SHEET_MIME,
  createFolder,
  driveFetchJson,
  getFileMeta,
  searchFiles,
} from './drive-api.js';

/*
 * ==================================================================
 * ★ 保存先の名前を本番アプリと分けている（2026-08-04）
 * ==================================================================
 * もとは §FR-07 のとおり `TSAM AI/名刺データ/` ＋ `名刺管理` だったが、
 * **本番アプリと同じ名前・同じクライアントIDだったため、本番が
 * この検証ページの作った台帳を拾ってしまった。**
 *
 * `drive.file` の可視範囲はクライアントIDごとに決まる。オリジンが
 * 違っても、同じクライアントIDなら同じファイルが見える。
 * 検証ページと本番アプリは同じIDを使っているので、名前が同じなら
 * 必ずぶつかる。
 *
 * 実際に本番の初回起動で、この検証ページが作った `名刺管理`
 * （既定のタブ1つだけ）が見つかり、本番側がタブを補修した。
 *
 * この検証ページはフェーズ2の測定まで残す（計画 §3-3）。
 * それまで衝突しないよう、**アプリフォルダ・台帳・キャッシュキー・
 * 一時ドキュメントの接頭辞をすべて検証用の名前にする。**
 *
 * ルートの `TSAM AI` だけは共有してよい。ここは本番も検証も
 * 「作って中に置く」だけで、中身を取り違える余地がない。
 * ==================================================================
 */
export const ROOT_FOLDER_NAME = 'TSAM AI';
export const APP_FOLDER_NAME = '名刺データ（フェーズ0検証）';
export const IMAGE_FOLDER_NAME = 'images';
export const SPREADSHEET_NAME = '名刺管理（フェーズ0検証）';

/* 要件定義書 §12 が許す3系統のうちの1つ。 */
const SHEETS_ENDPOINT = 'https://sheets.googleapis.com/v4/spreadsheets';

/*
 * キャッシュの保存キー。
 *
 * **ここに入るのはIDだけ。** 名刺データもトークンも入れない
 * （要件定義書 §FR-21）。
 *
 * **本番アプリとは別のキーにする。** 同じオリジンに配信されるので、
 * 同じキー名だと localStorage を取り合うことになる。名前が違えば
 * verifyCachedId が弾いて自己修復はするが、毎回キャッシュが無駄になり、
 * 原因も分かりにくい。
 */
export const STORAGE_KEYS = Object.freeze({
  appFolder: 'tsam-card-ocr-poc-app-folder-id',
  imageFolder: 'tsam-card-ocr-poc-image-folder-id',
  spreadsheet: 'tsam-card-ocr-poc-spreadsheet-id',
});

/* 保存領域が使えない環境（プライベートモード等）でも壊れない。 */
function readCache(key) {
  try {
    const value = globalThis.localStorage?.getItem(key);
    return typeof value === 'string' && value !== '' ? value : null;
  } catch {
    return null;
  }
}

function writeCache(key, value) {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    /* 書けなくても解決自体は成立する。次回また検索するだけ。 */
  }
}

function dropCache(key) {
  try {
    globalThis.localStorage?.removeItem(key);
  } catch {
    /* 同上。 */
  }
}

/*
 * キャッシュしたIDがまだ使えるか確かめる。
 *
 * 戻り値 true … そのまま使ってよい
 *        false … キャッシュを捨てて探し直す
 *
 * **401 と通信不良ではキャッシュを捨てない。** 認可の問題や一時障害で
 * 捨ててしまうと、復旧したときに重複して作ることになる。
 */
async function verifyCachedId(id, { expectedName, expectedMime, parentId, token, fetchImpl }) {
  try {
    const meta = await getFileMeta(id, { token, fetchImpl });

    if (meta?.trashed === true) {
      return false;
    }

    if (meta?.mimeType !== expectedMime) {
      return false;
    }

    if (meta?.name !== expectedName) {
      return false;
    }

    if (parentId && Array.isArray(meta?.parents) && !meta.parents.includes(parentId)) {
      return false;
    }

    return true;
  } catch (error) {
    const code = error instanceof DriveError ? error.code : DriveErrorCode.UNKNOWN;

    if (code === DriveErrorCode.NOT_FOUND || code === DriveErrorCode.FORBIDDEN) {
      return false;
    }

    /* 401・通信不良・不明はそのまま投げる。キャッシュは残す。 */
    throw error;
  }
}

/*
 * フォルダを3段階で解決する。
 *
 * 戻り値: { id, created, from }
 *   from … 'cache' | 'search' | 'created'
 */
export async function resolveFolder(name, parentId, cacheKey, { token, fetchImpl }) {
  const cached = readCache(cacheKey);

  if (cached) {
    const valid = await verifyCachedId(cached, {
      expectedName: name,
      expectedMime: DRIVE_FOLDER_MIME,
      parentId,
      token,
      fetchImpl,
    });

    if (valid) {
      return { id: cached, created: false, from: 'cache' };
    }

    dropCache(cacheKey);
  }

  const found = await searchFiles(name, DRIVE_FOLDER_MIME, parentId, { token, fetchImpl });

  if (found.length > 0) {
    writeCache(cacheKey, found[0].id);
    return { id: found[0].id, created: false, from: 'search' };
  }

  const id = await createFolder(name, parentId, { token, fetchImpl });
  writeCache(cacheKey, id);

  return { id, created: true, from: 'created' };
}

/* ---------- スプレッドシート ---------- */

/* 検証用の最小構成。MVP の列は要件定義書 §11.2 で決める。 */
export const SHEET_HEADERS = Object.freeze([
  'record_id',
  '登録日時',
  '会社名',
  '氏名',
  'メールアドレス',
  '電話番号',
  'duplicate_key',
  'image_hash',
  'drive_file_url',
  'app_version',
  'prompt_version',
]);

/*
 * 台帳を作る。
 *
 * `spreadsheets.create` は親フォルダを指定できないため、
 * 作成後に Drive API で親を付け替える。
 * **移動に失敗しても全体は失敗にしない**（マイドライブ直下に残るだけで、
 * 台帳としては使えるため）。
 */
async function createSpreadsheet(parentFolderId, { token, fetchImpl }) {
  const created = await driveFetchJson(`${SHEETS_ENDPOINT}?fields=spreadsheetId`, {
    token,
    fetchImpl,
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify({
      properties: { title: SPREADSHEET_NAME, locale: 'ja_JP', timeZone: 'Asia/Tokyo' },
    }),
  });

  const spreadsheetId = created?.spreadsheetId;

  if (!spreadsheetId) {
    throw new DriveError(DriveErrorCode.UNKNOWN, 0, 'spreadsheet_id_missing');
  }

  /* 見出し行を書く。 */
  const params = new URLSearchParams({ valueInputOption: 'USER_ENTERED' });

  await driveFetchJson(
    `${SHEETS_ENDPOINT}/${encodeURIComponent(spreadsheetId)}/values/A1?${params}`,
    {
      token,
      fetchImpl,
      method: 'PUT',
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify({ values: [[...SHEET_HEADERS]] }),
    },
  );

  try {
    const moveParams = new URLSearchParams({ addParents: parentFolderId, fields: 'id,parents' });

    await driveFetchJson(
      `${DRIVE_FILES_ENDPOINT}/${encodeURIComponent(spreadsheetId)}?${moveParams}`,
      { token, fetchImpl, method: 'PATCH' },
    );
  } catch {
    /* 移動できなくても台帳は使える。全体を失敗にしない。 */
  }

  return spreadsheetId;
}

/* 台帳をフォルダと同じ3段階で解決する。 */
export async function resolveSpreadsheet(parentFolderId, { token, fetchImpl }) {
  const cacheKey = STORAGE_KEYS.spreadsheet;
  const cached = readCache(cacheKey);

  if (cached) {
    const valid = await verifyCachedId(cached, {
      expectedName: SPREADSHEET_NAME,
      expectedMime: GOOGLE_SHEET_MIME,
      parentId: parentFolderId,
      token,
      fetchImpl,
    });

    if (valid) {
      return { id: cached, created: false, from: 'cache' };
    }

    dropCache(cacheKey);
  }

  const found = await searchFiles(SPREADSHEET_NAME, GOOGLE_SHEET_MIME, parentFolderId, {
    token,
    fetchImpl,
  });

  if (found.length > 0) {
    writeCache(cacheKey, found[0].id);
    return { id: found[0].id, created: false, from: 'search' };
  }

  const id = await createSpreadsheet(parentFolderId, { token, fetchImpl });
  writeCache(cacheKey, id);

  return { id, created: true, from: 'created' };
}

/*
 * 保存構造をまとめて用意する。
 *
 * 戻り値:
 *   { appFolderId, imageFolderId, spreadsheetId, createdAny, steps }
 *
 * steps は各段階がどこから解決されたか（cache / search / created）。
 * **2回目の起動で重複作成されないこと**（§5 の項目10）を、
 * 画面でこの値を見て確かめる。
 */
export async function ensureStorage({ token, fetchImpl }) {
  const root = await resolveFolder(ROOT_FOLDER_NAME, null, 'tsam-card-ocr-poc-root-folder-id', {
    token,
    fetchImpl,
  });

  const app = await resolveFolder(APP_FOLDER_NAME, root.id, STORAGE_KEYS.appFolder, {
    token,
    fetchImpl,
  });

  const images = await resolveFolder(IMAGE_FOLDER_NAME, app.id, STORAGE_KEYS.imageFolder, {
    token,
    fetchImpl,
  });

  const sheet = await resolveSpreadsheet(app.id, { token, fetchImpl });

  return {
    appFolderId: app.id,
    imageFolderId: images.id,
    spreadsheetId: sheet.id,
    createdAny: root.created || app.created || images.created || sheet.created,
    steps: {
      root: root.from,
      app: app.from,
      images: images.from,
      spreadsheet: sheet.from,
    },
  };
}

/* 検証をやり直すためにキャッシュだけ捨てる。Drive 上の実体は消さない。 */
export function clearStorageCache() {
  dropCache('tsam-card-ocr-poc-root-folder-id');

  for (const key of Object.values(STORAGE_KEYS)) {
    dropCache(key);
  }
}

export function spreadsheetUrl(spreadsheetId) {
  return `https://docs.google.com/spreadsheets/d/${encodeURIComponent(spreadsheetId)}/edit`;
}

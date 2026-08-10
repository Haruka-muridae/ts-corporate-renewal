/*
 * 名刺台帳（card-ocr が作った「名刺管理」スプレッドシート）から
 * メールアドレス列を読む。**このアプリは台帳を読むだけで、作らない・書かない。**
 *
 * ==================================================================
 * なぜ作らないのか
 * ==================================================================
 * 保存構造の正本は card-ocr が管理している。こちらが「無ければ作る」を
 * すると、**空の台帳がもう1つでき、card-ocr がどちらを正本と見るかが
 * 運任せになる**（同名検索は古いほうを採るため、先に作った側が勝つ）。
 * 台帳が無い＝まだ名刺を登録していない、なので、案内して終わりにする。
 * ==================================================================
 *
 * ==================================================================
 * 解決の段取り（card-ocr の drive-storage.js の3段階から「作成」を抜いた形）
 * ==================================================================
 *   段階1 … キャッシュのIDを検証する（404/403系なら捨てて段階2）
 *   段階2 … 名前・親・種別・未削除で検索する
 *   （段階3の「作成」は無い。見つからなければ LEDGER_NOT_FOUND）
 * ==================================================================
 *
 * 列は**見出し行から探す**。card-ocr の列構成は版によって増える
 * （右端に追加される決まり）ため、「何列目」を決め打ちすると
 * 古い版・新しい版のどちらかで別の列を読んでしまう。
 */

import {
  APP_FOLDER_NAME,
  DATA_TAB_NAME,
  DRIVE_FOLDER_MIME,
  EMAIL_COLUMN_HEADER,
  GOOGLE_SHEET_MIME,
  ROOT_FOLDER_NAME,
  SHEETS_ENDPOINT,
  SPREADSHEET_NAME,
  STORAGE_KEYS,
} from './config.js';

import {
  DriveError,
  DriveErrorCode,
  driveFetchJson,
  getFileMeta,
  searchFiles,
} from './drive-api.js';

export const LedgerErrorCode = {
  /* 台帳（またはフォルダ）が見つからない。名刺OCR側で先に登録が要る。 */
  LEDGER_NOT_FOUND: 'LEDGER_NOT_FOUND',
  /* タブや列が見つからない。台帳が改変されているか、古すぎる。 */
  COLUMN_NOT_FOUND: 'COLUMN_NOT_FOUND',
};

export class LedgerError extends Error {
  constructor(code, detail = '') {
    super(`ledger:${code}`);
    this.name = 'LedgerError';
    this.code = code;
    this.detail = detail;
  }
}

/* 画面に出す言葉。 */
export function describeLedgerError(error) {
  const code = error instanceof LedgerError ? error.code : '';

  switch (code) {
    case LedgerErrorCode.LEDGER_NOT_FOUND:
      return {
        text: '名刺管理シートが見つかりませんでした。先に名刺OCRアプリで名刺を登録してください。',
        errorCode: 'SETUP-002',
      };
    case LedgerErrorCode.COLUMN_NOT_FOUND:
      return {
        text: `名刺管理シートに「${EMAIL_COLUMN_HEADER}」列が見つかりませんでした。シートの見出し行を変更していないか確認してください。`,
        errorCode: 'SETUP-002',
      };
    default:
      return { text: '名刺管理シートの読み取りに失敗しました。', errorCode: 'DRV-001' };
  }
}

/* ---------- キャッシュ（台帳の場所のIDのみ） ---------- */

/* ID として妥当な形か。形の検査であって、実在の確認ではない。 */
export function isFileId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{10,120}$/.test(value);
}

function readCache(key) {
  if (!key) {
    return null;
  }

  try {
    const value = globalThis.localStorage?.getItem(key);
    return isFileId(value) ? value : null;
  } catch {
    return null;
  }
}

function writeCache(key, value) {
  if (!key) {
    return;
  }

  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    /* 書けなくても解決自体は成立する。次回また検索するだけ。 */
  }
}

function dropCache(key) {
  if (!key) {
    return;
  }

  try {
    globalThis.localStorage?.removeItem(key);
  } catch {
    /* 同上。 */
  }
}

/* 検証をやり直すためにキャッシュだけ捨てる。Drive 上の実体は消さない。 */
export function clearLedgerCache() {
  for (const key of Object.values(STORAGE_KEYS)) {
    dropCache(key);
  }
}

/*
 * キャッシュしたIDがまだ使えるか確かめる。
 *
 * **401 と通信不良ではキャッシュを捨てない**（card-ocr と同じ判断）。
 * 認可の問題や一時障害で捨てると、復旧したときに探し直しになるだけで
 * 得るものが無い。
 */
async function verifyCachedId(id, { expectedName, expectedMime, parentId, token, fetchImpl, signal }) {
  try {
    const meta = await getFileMeta(id, { token, fetchImpl, signal });

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

    if (code === DriveErrorCode.NOT_FOUND) {
      return false;
    }

    throw error;
  }
}

/* 検索だけで解決する（作らない）。見つからなければ null。 */
async function findChild(name, mimeType, parentId, cacheKey, { token, fetchImpl, signal }) {
  const cached = readCache(cacheKey);

  if (cached) {
    const valid = await verifyCachedId(cached, {
      expectedName: name,
      expectedMime: mimeType,
      parentId,
      token,
      fetchImpl,
      signal,
    });

    if (valid) {
      return cached;
    }

    dropCache(cacheKey);
  }

  const found = await searchFiles(name, mimeType, parentId, { token, fetchImpl, signal });

  if (found.length === 0) {
    return null;
  }

  /* 古い順に並べてある（drive-api.js）。先に作られたほうが正本。 */
  writeCache(cacheKey, found[0].id);
  return found[0].id;
}

/*
 * 台帳のファイルIDを解決する。
 *
 *   マイドライブ / TSAM AI / 名刺データ / 名刺管理
 *
 * どこかで見つからなければ LEDGER_NOT_FOUND。
 */
export async function resolveLedger({ token, fetchImpl, signal } = {}) {
  const rootId = await findChild(
    ROOT_FOLDER_NAME,
    DRIVE_FOLDER_MIME,
    null,
    STORAGE_KEYS.rootFolder,
    { token, fetchImpl, signal },
  );

  if (!rootId) {
    throw new LedgerError(LedgerErrorCode.LEDGER_NOT_FOUND, 'root_folder_missing');
  }

  const appId = await findChild(
    APP_FOLDER_NAME,
    DRIVE_FOLDER_MIME,
    rootId,
    STORAGE_KEYS.appFolder,
    { token, fetchImpl, signal },
  );

  if (!appId) {
    throw new LedgerError(LedgerErrorCode.LEDGER_NOT_FOUND, 'app_folder_missing');
  }

  const sheetId = await findChild(
    SPREADSHEET_NAME,
    GOOGLE_SHEET_MIME,
    appId,
    STORAGE_KEYS.spreadsheet,
    { token, fetchImpl, signal },
  );

  if (!sheetId) {
    throw new LedgerError(LedgerErrorCode.LEDGER_NOT_FOUND, 'spreadsheet_missing');
  }

  return sheetId;
}

/* ---------- 列の読み取り ---------- */

/*
 * 0起点の列番号を A1 記法の列名にする（0 → A、25 → Z、26 → AA）。
 * card-ocr の sheets.js と同じ実装（複製。import はしない）。
 */
export function columnLetter(index) {
  let value = Math.max(0, Math.floor(index));
  let letters = '';

  do {
    letters = String.fromCharCode(65 + (value % 26)) + letters;
    value = Math.floor(value / 26) - 1;
  } while (value >= 0);

  return letters;
}

/* タブ名は A1 記法で ' で囲む。名前に ' が含まれる場合は '' にする。 */
export function quoteTabTitle(title) {
  return `'${String(title ?? '').replace(/'/g, "''")}'`;
}

/*
 * 見出し行から対象列の位置（0起点）を探す。見つからなければ -1。
 *
 * 前後の空白だけ許す（利用者がセルを触って空白が付くことがある）。
 * 表記そのものの揺れは許さない。**別の意味の列を誤って読むほうが
 * 「見つからない」より深刻**なため（宛先は他人のメールアドレスである）。
 */
export function findEmailColumnIndex(headerRow, header = EMAIL_COLUMN_HEADER) {
  if (!Array.isArray(headerRow)) {
    return -1;
  }

  return headerRow.findIndex((cell) => String(cell ?? '').trim() === header);
}

function sheetsValuesUrl(spreadsheetId, range) {
  return `${SHEETS_ENDPOINT}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`;
}

/*
 * 台帳からメールアドレス列の値を読む（見出し行を除く2行目以降）。
 *
 * **必要な列だけを読む。** 台帳には氏名・住所・電話番号など第三者の
 * 個人情報が並んでいる。使わない列を取得しない。
 *
 * 戻り値: 上から順の生の値（空セルは除く。検証は recipients.js が行う）。
 */
export async function readEmailColumn(spreadsheetId, { token, fetchImpl, signal } = {}) {
  const headerRange = `${quoteTabTitle(DATA_TAB_NAME)}!1:1`;
  const headerResult = await driveFetchJson(sheetsValuesUrl(spreadsheetId, headerRange), {
    token,
    fetchImpl,
    signal,
  });

  const headerRow = Array.isArray(headerResult?.values?.[0]) ? headerResult.values[0] : [];
  const columnIndex = findEmailColumnIndex(headerRow);

  if (columnIndex < 0) {
    throw new LedgerError(LedgerErrorCode.COLUMN_NOT_FOUND, 'email_header_missing');
  }

  const letter = columnLetter(columnIndex);
  const valueRange = `${quoteTabTitle(DATA_TAB_NAME)}!${letter}2:${letter}`;

  const result = await driveFetchJson(sheetsValuesUrl(spreadsheetId, valueRange), {
    token,
    fetchImpl,
    signal,
  });

  const rows = Array.isArray(result?.values) ? result.values : [];

  return rows
    .map((row) => String(row?.[0] ?? '').trim())
    .filter((value) => value !== '');
}

/*
 * 台帳「名刺管理」（card-ocr が作る本番の台帳）の場所の解決・読み込み・更新。
 *
 * ==================================================================
 * 複製元
 * ==================================================================
 * ../card-mail/ledger.js（台帳の場所の解決。3段階のうち「作成」を
 * 持たない形）と ../card-ocr/sheets.js・register.js（読み書き・変更履歴）
 * を突き合わせて作った（2026-08-20）。**どれも import はしない**
 * （docs/repository-structure.md §4-1）。
 * ==================================================================
 *
 * ==================================================================
 * このアプリが対象にするのは card-ocr の台帳である
 * ==================================================================
 * テスト環境 `/apps/card-manager/` は名刺スキャナ（card-scanner）が作る
 * 別形式の台帳「名刺台帳（表裏対応 v3）」を対象にしていたが、本番では
 * 対象にしない。card-ocr と同じクライアントIDを使う理由が「card-ocr が
 * 作った台帳が見えるようにするため」である以上、読み書きすべき台帳は
 * card-ocr の「名刺管理」である（ルート CLAUDE.md「名刺メール配信
 * アプリ」節、card-mail の config.js と同じ理由）。列構成は ./schema.js
 * （card-ocr/schema.js の複製）。
 *
 * ==================================================================
 * 台帳は作らない・列構成も直さない
 * ==================================================================
 * card-mail と同じ理由で、台帳が無ければ「先に名刺OCRで登録して
 * ください」と案内して終わる。列が古い版（右端が足りない = upgrade）
 * でも、**列を広げる作業はしない**（card-ocr/drive-storage.js の役割）。
 * このアプリの役割は「読む・編集する」であって「台帳を管理する」では
 * ないため、書き込みは見出しが現在の版と完全一致するときだけ許可する。
 *
 * ==================================================================
 * 更新は「台帳が先、変更履歴が後」（card-ocr/register.js と同じ順序）
 * ==================================================================
 * 逆にすると、書き換えに失敗したのに「こう変えた」という履歴だけが
 * 残る。台帳を先に書けば、履歴に失敗しても「更新はできた／記録は
 * 残せなかった」と利用者に伝えられる（historyRecorded を返す）。
 */

import {
  APP_FOLDER_NAME,
  DRIVE_FOLDER_MIME,
  GOOGLE_SHEET_MIME,
  ROOT_FOLDER_NAME,
  SHEETS_ENDPOINT,
  SPREADSHEET_NAME,
  STORAGE_KEYS,
  TABS,
} from './config.js';

import {
  DriveError,
  DriveErrorCode,
  driveFetchJson,
  getFileMeta,
  searchFiles,
} from './drive-api.js';

import {
  DATA_COLUMNS,
  HISTORY_COLUMNS,
  diffValues,
  verifyHeader,
} from './schema.js';

import { escapeCellText } from './sanitize.js';
import { applyEditsToRow, checkHeader, rowToRecord } from './records.js';

export { DriveError, DriveErrorCode };

export const ManagerErrorCode = {
  /* 台帳（またはその親フォルダ）が見つからない。card-ocr で先に登録が要る。 */
  LEDGER_NOT_FOUND: 'LEDGER_NOT_FOUND',
  /* 見出し行が現在の版と一致しない（'altered' または未対応の形）。 */
  HEADER_MISMATCH: 'HEADER_MISMATCH',
  /* 台帳が現在の版より古い（'upgrade'）。閲覧はできるが編集はできない。 */
  HEADER_OUTDATED: 'HEADER_OUTDATED',
  /* 保存直前の再取得で、編集開始時と行の record_id が一致しなかった。 */
  ROW_CONFLICT: 'ROW_CONFLICT',
};

export class ManagerError extends Error {
  constructor(code, detail = null) {
    super(`manager:${code}`);
    this.name = 'ManagerError';
    this.code = code;
    this.detail = detail;
  }
}

/* ---------- ログ出力の差し替え ---------- */

let logger = () => {};

export function setManagerLogger(fn) {
  logger = typeof fn === 'function' ? fn : () => {};
}

/* ---------- キャッシュ（台帳の場所のIDのみ） ---------- */

function isFileId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{10,120}$/.test(value);
}

function readCache(key) {
  try {
    const value = globalThis.localStorage?.getItem(key);
    return isFileId(value) ? value : null;
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

/* 検証をやり直すためにキャッシュだけ捨てる。Drive 上の実体は消さない。 */
export function clearLedgerCache() {
  for (const key of Object.values(STORAGE_KEYS)) {
    dropCache(key);
  }
}

/*
 * キャッシュしたIDがまだ使えるか確かめる。
 *
 * **401 と通信不良ではキャッシュを捨てない**（card-mail / card-ocr と
 * 同じ判断）。認可の問題や一時障害で捨てると、復旧したときに探し直しに
 * なるだけで得るものが無い。
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

/* ---------- 台帳の場所の解決 ---------- */

/*
 * 台帳のファイルIDを解決する（作らない）。
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
    logger('manager:ledger-not-found', { stage: 'root' });
    return { spreadsheetId: '', found: false };
  }

  const appId = await findChild(
    APP_FOLDER_NAME,
    DRIVE_FOLDER_MIME,
    rootId,
    STORAGE_KEYS.appFolder,
    { token, fetchImpl, signal },
  );

  if (!appId) {
    logger('manager:ledger-not-found', { stage: 'app' });
    return { spreadsheetId: '', found: false };
  }

  const sheetId = await findChild(
    SPREADSHEET_NAME,
    GOOGLE_SHEET_MIME,
    appId,
    STORAGE_KEYS.spreadsheet,
    { token, fetchImpl, signal },
  );

  if (!sheetId) {
    logger('manager:ledger-not-found', { stage: 'spreadsheet' });
    return { spreadsheetId: '', found: false };
  }

  logger('manager:ledger-resolved', {});
  return { spreadsheetId: sheetId, found: true };
}

/* ---------- Sheets の範囲・URL ---------- */

/* 0起点の列番号を A1 記法の列名にする（0 → A、25 → Z、26 → AA）。 */
function columnLetter(index) {
  let value = Math.max(0, Math.floor(index));
  let letters = '';

  do {
    letters = String.fromCharCode(65 + (value % 26)) + letters;
    value = Math.floor(value / 26) - 1;
  } while (value >= 0);

  return letters;
}

function quoteTabTitle(title) {
  return `'${String(title ?? '').replace(/'/g, "''")}'`;
}

const LAST_COLUMN_LETTER = columnLetter(DATA_COLUMNS.length - 1);
const DATA_RANGE = `${quoteTabTitle(TABS.data)}!A2:${LAST_COLUMN_LETTER}`;
const HEADER_RANGE = `${quoteTabTitle(TABS.data)}!A1:${LAST_COLUMN_LETTER}1`;

const HISTORY_LAST_COLUMN_LETTER = columnLetter(HISTORY_COLUMNS.length - 1);
const HISTORY_HEADER_RANGE = `${quoteTabTitle(TABS.history)}!A1:${HISTORY_LAST_COLUMN_LETTER}1`;

function sheetsValuesUrl(spreadsheetId, range, params, suffix = '') {
  const base = `${SHEETS_ENDPOINT}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}${suffix}`;
  return params ? `${base}?${params}` : base;
}

/*
 * 複数範囲を1回の往復でまとめて読む（values:batchGet）。
 *
 * updateRecord() が保存直前に「見出し」と「対象行」を同時に取得するために
 * 使う。2回に分けて読むと、その間に見出しが変わる隙が生まれるため、
 * 1リクエストにまとめて隙を無くす（往復回数は分割読みと同じ1回）。
 */
function sheetsBatchGetUrl(spreadsheetId, ranges, extraParams = {}) {
  const params = new URLSearchParams();
  ranges.forEach((range) => params.append('ranges', range));
  Object.entries(extraParams).forEach(([key, value]) => params.append(key, value));

  return `${SHEETS_ENDPOINT}/${encodeURIComponent(spreadsheetId)}/values:batchGet?${params}`;
}

export function spreadsheetUrl(spreadsheetId) {
  return `https://docs.google.com/spreadsheets/d/${encodeURIComponent(spreadsheetId)}/edit`;
}

/* ---------- 全行の読み込み ---------- */

/*
 * 台帳の見出しと全行を読み、見出しの版を確かめたうえでレコードへ
 * 変換する。
 *
 * 戻り値: { records, headerStatus, writable }
 *   headerStatus … schema.verifyHeader() の status（'ok'/'upgrade'/
 *                  'altered'/'empty'）
 *   writable     … 'ok' のときだけ true。編集の可否は呼び出し側が
 *                  これを見て決める
 *
 * **'altered' では続行しない。** 列の位置が信用できない状態で読み進めると、
 * 電話番号の欄をメールとして表示するような事故になる。
 */
export async function readAllRecords({ token, spreadsheetId, fetchImpl, signal } = {}) {
  const headerResult = await driveFetchJson(
    sheetsValuesUrl(spreadsheetId, HEADER_RANGE, new URLSearchParams({ valueRenderOption: 'FORMULA' })),
    { token, fetchImpl, signal },
  );

  const headerRow = Array.isArray(headerResult?.values?.[0]) ? headerResult.values[0] : [];
  const verdict = checkHeader(headerRow);

  if (verdict.status === 'altered') {
    throw new ManagerError(ManagerErrorCode.HEADER_MISMATCH, verdict);
  }

  if (verdict.status === 'empty') {
    logger('manager:loaded', { count: 0, headerStatus: verdict.status });
    return { records: [], headerStatus: verdict.status, writable: false };
  }

  const dataResult = await driveFetchJson(
    sheetsValuesUrl(spreadsheetId, DATA_RANGE, new URLSearchParams({ valueRenderOption: 'FORMULA' })),
    { token, fetchImpl, signal },
  );

  const rows = Array.isArray(dataResult?.values) ? dataResult.values : [];

  const records = rows
    .map((row, index) => rowToRecord(row, index + 2))
    /* record_id が空の行（誤って残った空行など）は一覧に出さない。 */
    .filter((record) => record.recordId !== '');

  const writable = verdict.status === 'ok';

  logger('manager:loaded', { count: records.length, headerStatus: verdict.status });

  return { records, headerStatus: verdict.status, writable };
}

/* ---------- 記録用の値 ---------- */

function buildLocalId() {
  const cryptoObj = globalThis.crypto;

  if (typeof cryptoObj?.randomUUID === 'function') {
    return cryptoObj.randomUUID();
  }

  if (typeof cryptoObj?.getRandomValues === 'function') {
    const bytes = cryptoObj.getRandomValues(new Uint8Array(16));
    return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  return `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/* 変更履歴の changed_at（card-ocr/register.js の formatRegisteredAt と同じ書式）。 */
function formatChangedAt(at = new Date()) {
  const date = at instanceof Date && !Number.isNaN(at.getTime()) ? at : new Date();
  const pad = (value) => String(value).padStart(2, '0');

  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/*
 * 変更履歴タブの列順（card-ocr/schema.js の HISTORY_COLUMNS と同じ）:
 * history_id, changed_at, record_id, field_name, old_value, new_value
 */
function buildHistoryRow({ recordId, change, at }) {
  return [
    buildLocalId(),
    formatChangedAt(at),
    recordId,
    change.header,
    change.oldValue,
    change.newValue,
  ].map((value) => escapeCellText(value));
}

/* ---------- 1件の更新 ---------- */

/*
 * 行ずれ防止のため、保存直前に該当行を再取得して record_id を確かめて
 * から更新する。再取得した行を土台にするので、この端末が読み込んだ
 * あとに別の場所でその行の他のセルが変わっていても、それを消さずに済む。
 *
 * record_id が一致しなければ ROW_CONFLICT を投げ、更新は行わない。
 *
 * ==================================================================
 * 見出し行も保存直前に再検証する（レビュー指摘。2026-08-20 追加）
 * ==================================================================
 * `writable` は読み込み時点のスナップショットにすぎない。読み込み後に
 * 別の場所（card-ocr のスキーマ更新・利用者の手編集）で列が挿入・
 * 並べ替えされても、`record_id`（A列）は変わらないことがあるため、
 * 行の同一性チェックだけでは検出できない。**見出しと対象行を1回の
 * values:batchGet でまとめて取得し**、`checkHeader().status === 'ok'`
 * のときだけ PUT する。往復回数は従来（行の単独取得）と変わらない。
 * ==================================================================
 *
 * **writable は入口の早期リターンにのみ使う**（読み込み時点で既に
 * 書けないと分かっている場合に通信を発生させないため）。実際の書き込み
 * 可否は、このあと再取得した見出しで判定し直す。
 *
 * 戻り値: { record, historyRecorded }
 */
export async function updateRecord({
  token, spreadsheetId, record, values, writable, fetchImpl, signal, at = new Date(),
} = {}) {
  if (writable !== true) {
    throw new ManagerError(ManagerErrorCode.HEADER_OUTDATED);
  }

  const rowRange = `${quoteTabTitle(TABS.data)}!A${record.rowNumber}:${LAST_COLUMN_LETTER}${record.rowNumber}`;

  const batchResult = await driveFetchJson(
    sheetsBatchGetUrl(spreadsheetId, [HEADER_RANGE, rowRange], { valueRenderOption: 'FORMULA' }),
    { token, fetchImpl, signal },
  );

  const valueRanges = Array.isArray(batchResult?.valueRanges) ? batchResult.valueRanges : [];
  const headerRow = Array.isArray(valueRanges[0]?.values?.[0]) ? valueRanges[0].values[0] : [];
  const freshRow = Array.isArray(valueRanges[1]?.values?.[0]) ? valueRanges[1].values[0] : [];

  const verdict = checkHeader(headerRow);

  if (verdict.status !== 'ok') {
    /*
     * 読み込み後に見出しが崩れた／古くなった。**書き込まずに止める。**
     * 'altered'（並び替え・削除）と 'empty' は列の位置が信用できない
     * ため HEADER_MISMATCH。'upgrade' は card-ocr が追従すべき範囲
     * なので HEADER_OUTDATED（FR-04 と同じ分類）。
     */
    logger('manager:header-changed-since-load', { row: record.rowNumber, status: verdict.status });

    throw new ManagerError(
      verdict.status === 'upgrade' ? ManagerErrorCode.HEADER_OUTDATED : ManagerErrorCode.HEADER_MISMATCH,
      verdict,
    );
  }

  const recordIdIndex = DATA_COLUMNS.findIndex((column) => column.key === 'record_id');
  const currentRecordId = String(freshRow[recordIdIndex] ?? '');

  if (currentRecordId === '' || currentRecordId !== record.recordId) {
    logger('manager:row-conflict', { row: record.rowNumber });
    throw new ManagerError(ManagerErrorCode.ROW_CONFLICT);
  }

  const existingValues = rowToRecord(freshRow, record.rowNumber);
  const newRow = applyEditsToRow({ raw: freshRow, values });

  const updateParams = new URLSearchParams({ valueInputOption: 'USER_ENTERED', fields: 'updatedRange' });

  await driveFetchJson(
    sheetsValuesUrl(spreadsheetId, rowRange, updateParams),
    {
      token,
      fetchImpl,
      signal,
      method: 'PUT',
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify({ values: [newRow] }),
    },
  );

  logger('manager:updated', { row: record.rowNumber });

  const updatedRecord = rowToRecord(newRow, record.rowNumber);

  /*
   * 変更履歴（card-ocr 要件書 §11.3）。**台帳の更新に成功した後で記録する。**
   * 記録に失敗しても更新そのものは失敗にしない（card-ocr/register.js と
   * 同じ考え方）。名刺の中身（CONTENT_COLUMNS）＋duplicate_key の
   * 変化だけを見る。record_id は行の同一性そのものなので比較しない。
   */
  const compareColumns = DATA_COLUMNS.filter((column) => column.key !== 'record_id');
  const changes = diffValues(
    { ...existingValues.values, ...existingValues.auto },
    { ...updatedRecord.values, ...updatedRecord.auto },
    compareColumns,
  );

  let historyRecorded = true;

  if (changes.length > 0) {
    try {
      /*
       * **追記の前に「変更履歴」タブの見出しも検証する。** 検証せずに
       * 追記すると、タブが改変されていた場合に壊れた記録（列がずれた
       * 履歴行）を残してしまう。台帳の更新（上）はすでに成功しているので、
       * ここで止めるのは記録だけであり、historyRecorded=false として
       * 呼び出し側に伝える（catch した場合と同じ扱い）。
       */
      const historyHeaderResult = await driveFetchJson(
        sheetsValuesUrl(spreadsheetId, HISTORY_HEADER_RANGE, new URLSearchParams({ valueRenderOption: 'FORMULA' })),
        { token, fetchImpl, signal },
      );

      const historyHeaderRow = Array.isArray(historyHeaderResult?.values?.[0])
        ? historyHeaderResult.values[0]
        : [];
      const historyVerdict = verifyHeader(historyHeaderRow, HISTORY_COLUMNS);

      if (historyVerdict.status !== 'ok') {
        historyRecorded = false;
        logger('manager:history-header-mismatch', { row: record.rowNumber, status: historyVerdict.status });
      } else {
        const historyRows = changes.map((change) => buildHistoryRow({ recordId: record.recordId, change, at }));

        const appendParams = new URLSearchParams({
          valueInputOption: 'USER_ENTERED',
          insertDataOption: 'INSERT_ROWS',
          fields: 'updates(updatedRange)',
        });

        await driveFetchJson(
          sheetsValuesUrl(spreadsheetId, `${quoteTabTitle(TABS.history)}!A1`, appendParams, ':append'),
          {
            token,
            fetchImpl,
            signal,
            method: 'POST',
            headers: { 'Content-Type': 'application/json; charset=UTF-8' },
            body: JSON.stringify({ values: historyRows }),
          },
        );
      }
    } catch {
      /* 台帳は書けている。**更新そのものを失敗にしない。** */
      historyRecorded = false;
      logger('manager:history-failed', { row: record.rowNumber });
    }
  }

  return { record: updatedRecord, changes, historyRecorded };
}

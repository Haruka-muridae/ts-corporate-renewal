/*
 * Google スプレッドシート「名刺台帳（表裏対応 v3）」の読み込み・更新。
 *
 * 担当するのは Sheets API v4 の呼び出しのうち、次の3つだけ。
 *   ・台帳の特定（作成はしない）
 *   ・全行の読み込み
 *   ・1行の更新
 * DOM操作・認可フロー・画面文言・検索や絞り込みのロジックはここに置かない。
 *
 * ------------------------------------------------------------------
 * 台帳の特定はキャッシュだけを見る（Driveの検索・フォルダ解決はしない）
 * ------------------------------------------------------------------
 * card-scanner/sheets-client.js は「キャッシュ検証 → Drive検索 → 新規作成」の
 * 3段階で台帳を解決するが、そのためには保存先フォルダ（TSAM AI ＞ 名刺スキャナ）の
 * 解決が前提になる（drive-folders.js）。フォルダ候補が複数あるときの選択画面まで
 * このアプリに持ち込むと、「閲覧・編集するだけのアプリ」の責務を大きく超える。
 *
 * このアプリは台帳を作らないため、次の1段階だけで済ませる。
 *   ・card-scanner と同じ localStorage キー（SPREADSHEET_ID_STORAGE_KEY）を読み、
 *     Sheets API で実在と名前を確認する
 * キャッシュが無い／無効な場合は「台帳が見つからない」として扱い、
 * 台帳の新規作成やDrive全体の検索は行わない
 * （名刺スキャナで1件登録すれば、次回このキャッシュ経由で見つかる）。
 * ------------------------------------------------------------------
 *
 * ------------------------------------------------------------------
 * 読み取りは valueRenderOption=FORMULA を使う
 * ------------------------------------------------------------------
 * 既定（FORMATTED_VALUE）だと、表面/裏面画像URL列の
 * =HYPERLINK("url","label") が表示文言（"表面画像を見る"等）に化けてしまい、
 * リンク先URLも、保存し直すときの数式も失われる。
 * FORMULA を使うと、数式セルはそのままの文字列（=HYPERLINK(...)）で、
 * それ以外のセルは UNFORMATTED_VALUE と同じ値（日時はシリアル値の数値）で返る。
 * 日時の表示用変換は records.js の formatSheetTimestamp() が担う。
 * ------------------------------------------------------------------
 */

import {
  LAST_COLUMN_LETTER,
  SHEET_RANGE,
} from '../card-scanner/fields.js';

import {
  SheetsError,
  SheetsErrorCode,
  SPREADSHEET_ID_STORAGE_KEY,
  SPREADSHEET_NAME,
  escapeCellText,
  formatTimestamp,
  mapHttpErrorToCode,
} from '../card-scanner/sheets-client.js';

import { applyEditsToRow, rowToRecord, validateHeaderRow } from './records.js';

export { SheetsError, SheetsErrorCode };

const SHEETS_ENDPOINT = 'https://sheets.googleapis.com/v4/spreadsheets';

export const ManagerErrorCode = {
  /* localStorage にキャッシュが無い、または実在を確認できなかった。 */
  LEDGER_NOT_FOUND: 'LEDGER_NOT_FOUND',
  /* 見出し行が fields.js の定義と一致しない。列ずれ事故を避けるため続行しない。 */
  HEADER_MISMATCH: 'HEADER_MISMATCH',
  /* 保存直前の再取得で、編集開始時と行のカードIDが一致しなかった。 */
  ROW_CONFLICT: 'ROW_CONFLICT',
};

export class ManagerError extends Error {
  constructor(code, detail = null) {
    super(code);
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

/* ---------- 低レベル呼び出し ---------- */

async function readJsonSafely(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/* fetch を1か所に集約する。fetchImpl はテスト用の差し替え口。 */
async function apiFetch(url, { token, method = 'GET', body = null, headers = {}, fetchImpl }) {
  const doFetch = fetchImpl ?? globalThis.fetch;

  if (typeof doFetch !== 'function') {
    throw new SheetsError(SheetsErrorCode.NETWORK, 0, 'fetch_unavailable');
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
    throw new SheetsError(SheetsErrorCode.NETWORK, 0, error?.name ?? 'fetch_failed');
  }

  if (!response.ok) {
    const errorBody = await readJsonSafely(response);
    throw new SheetsError(mapHttpErrorToCode(response.status, errorBody), response.status, null);
  }

  return readJsonSafely(response);
}

/* ---------- キャッシュの読み取り ---------- */

function readCachedSpreadsheetId() {
  try {
    const value = globalThis.localStorage?.getItem(SPREADSHEET_ID_STORAGE_KEY);
    return typeof value === 'string' && value !== '' ? value : null;
  } catch {
    return null;
  }
}

/* ---------- 台帳の特定 ---------- */

/*
 * 名刺スキャナが使ったキャッシュ（同じ localStorage キー）を読み、
 * 実在と名前を確認する。見つからなくても新規作成はしない。
 *
 * 戻り値: { spreadsheetId, found }
 */
export async function resolveLedger({ token, fetchImpl }) {
  const cachedId = readCachedSpreadsheetId();

  if (!cachedId) {
    logger('manager:ledger-not-cached', {});
    return { spreadsheetId: '', found: false };
  }

  try {
    const params = new URLSearchParams({ fields: 'properties.title' });
    const meta = await apiFetch(
      `${SHEETS_ENDPOINT}/${encodeURIComponent(cachedId)}?${params}`,
      { token, fetchImpl },
    );

    if (meta?.properties?.title === SPREADSHEET_NAME) {
      logger('manager:ledger-resolved', { from: 'cache' });
      return { spreadsheetId: cachedId, found: true };
    }

    logger('manager:ledger-name-mismatch', {});
    return { spreadsheetId: '', found: false };
  } catch (error) {
    if (error instanceof SheetsError
      && (error.code === SheetsErrorCode.NOT_FOUND || error.code === SheetsErrorCode.FORBIDDEN)) {
      logger('manager:ledger-cache-invalid', { code: error.code });
      return { spreadsheetId: '', found: false };
    }

    /* 401・通信不良・レート制限などは呼び出し元へそのまま投げる。 */
    throw error;
  }
}

/* ---------- 全行の読み込み ---------- */

/*
 * 台帳の全行を読み、見出しを検証したうえでレコードへ変換する。
 * 見出しが一致しない場合は続行せず ManagerError を投げる
 * （部分一致でそのまま読み進めると列ずれのまま表示・保存する事故になる）。
 *
 * 戻り値: { records }
 */
export async function readAllRecords({ token, spreadsheetId, fetchImpl }) {
  const params = new URLSearchParams({ valueRenderOption: 'FORMULA' });
  const range = encodeURIComponent(SHEET_RANGE);

  const result = await apiFetch(
    `${SHEETS_ENDPOINT}/${encodeURIComponent(spreadsheetId)}/values/${range}?${params}`,
    { token, fetchImpl },
  );

  const rows = Array.isArray(result?.values) ? result.values : [];

  if (rows.length === 0) {
    logger('manager:loaded', { count: 0, headerless: true });
    return { records: [] };
  }

  if (!validateHeaderRow(rows[0])) {
    throw new ManagerError(ManagerErrorCode.HEADER_MISMATCH);
  }

  const records = rows
    .slice(1)
    .map((row, index) => rowToRecord(row, index + 2))
    /* カードIDが空の行（誤って残った空行など）は一覧に出さない。 */
    .filter((record) => record.cardId !== '');

  logger('manager:loaded', { count: records.length });

  return { records };
}

/* ---------- 1行の更新 ---------- */

/*
 * 行ずれ防止のため、保存直前に該当行を再取得してカードIDを確かめてから
 * 更新する。再取得した行を土台にするので、この端末が読み込んだあとに
 * 別の場所でその行の他のセルが変わっていても、それを消さずに済む。
 *
 * カードIDが一致しなければ ROW_CONFLICT を投げ、更新は行わない。
 *
 * 戻り値: 更新後のレコード
 */
export async function updateRecord({ token, spreadsheetId, record, values, fetchImpl }) {
  const range = `A${record.rowNumber}:${LAST_COLUMN_LETTER}${record.rowNumber}`;
  const encodedRange = encodeURIComponent(range);

  const fresh = await apiFetch(
    `${SHEETS_ENDPOINT}/${encodeURIComponent(spreadsheetId)}/values/${encodedRange}`
    + '?valueRenderOption=FORMULA',
    { token, fetchImpl },
  );

  const freshRow = Array.isArray(fresh?.values?.[0]) ? fresh.values[0] : [];
  const currentCardId = String(freshRow[0] ?? '');

  if (currentCardId === '' || currentCardId !== record.cardId) {
    logger('manager:row-conflict', { row: record.rowNumber });
    throw new ManagerError(ManagerErrorCode.ROW_CONFLICT);
  }

  const updatedAt = new Date();
  const row = applyEditsToRow({
    raw: freshRow,
    values,
    updatedAt,
    escapeCellText,
    formatTimestamp,
  });

  const updateParams = new URLSearchParams({ valueInputOption: 'USER_ENTERED' });

  await apiFetch(
    `${SHEETS_ENDPOINT}/${encodeURIComponent(spreadsheetId)}/values/${encodedRange}?${updateParams}`,
    {
      token,
      fetchImpl,
      method: 'PUT',
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify({ values: [row] }),
    },
  );

  logger('manager:updated', { row: record.rowNumber });

  return rowToRecord(row, record.rowNumber);
}

/* スプレッドシートを開くURL。画面のリンクに使う。 */
export function spreadsheetUrl(spreadsheetId) {
  return `https://docs.google.com/spreadsheets/d/${encodeURIComponent(spreadsheetId)}/edit`;
}

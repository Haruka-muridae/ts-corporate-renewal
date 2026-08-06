/*
 * Sheets API v4 の呼び出し（要件定義書 §12 の3系統のうちの1つ）。
 *
 * ==================================================================
 * 複製元
 * ==================================================================
 * ../receipt-ocr/sheets.js と public/apps/card-scanner/sheets-client.js を
 * 突き合わせて作った（2026-08-04）。**どちらも import はしない**
 * （docs/repository-structure.md §4-1）。
 *
 * 領収書OCRから変えたところ:
 *   - **valueInputOption を USER_ENTERED にした**（下記）
 *   - タブ構成を §11.2・§11.3 に合わせた
 * ==================================================================
 *
 * ==================================================================
 * なぜ USER_ENTERED なのか
 * ==================================================================
 * 領収書OCRは RAW で書いている。数式が評価されないので、
 * 数式インジェクションに対して一段強い。
 *
 * **名刺OCRでは使えない。** §11.2 が保存画像へのリンクを
 * `=HYPERLINK()` でクリックできる形にすることを要求しており、
 * RAW だと文字列のまま残るためである。
 *
 * 代わりに、台帳へ入る値は**必ず sanitize.js を通す。**
 * 通さない値は、こちらが組み立てる HYPERLINK の2列だけで、
 * そのURLも sanitize.js 側で検証している。
 * ==================================================================
 *
 * 通信は drive-api.js の driveRequest を使う。名前は drive だが、
 * 中身は「Authorization を付けて fetch する」だけで、Sheets にも使える。
 * エラー分類も共通で効く（403 のレート制限を認可エラーにしない等）。
 */

import {
  DRIVE_FILES_ENDPOINT,
  SHEETS_ENDPOINT,
  SPREADSHEET_NAME,
  TABS,
} from './config.js';

import {
  DriveError,
  DriveErrorCode,
  driveFetchJson,
} from './drive-api.js';

import { DATA_COLUMNS, HISTORY_COLUMNS, headersOf } from './schema.js';

const JSON_HEADERS = Object.freeze({ 'Content-Type': 'application/json; charset=UTF-8' });

/* タブ名と、そこに置く列。 */
export const TAB_COLUMNS = Object.freeze({
  [TABS.data]: DATA_COLUMNS,
  [TABS.history]: HISTORY_COLUMNS,
});

export const TAB_ORDER = Object.freeze([TABS.data, TABS.history]);

/*
 * タブを作るときに確保する列数。
 *
 * **Sheets の既定は26列。** 列定義がそれを超えると、見出しを書いた
 * 瞬間に「exceeds grid limits」で 400 になる。作る時点で足りるだけ
 * 確保しておけば、そのあとの書き込みは素直に通る。
 *
 * 26 を下回らせないのは、利用者が見慣れた幅を狭めないため。
 */
export function gridWidthFor(tabTitle) {
  return Math.max(26, (TAB_COLUMNS[tabTitle] ?? []).length);
}

/*
 * 0起点の列番号を A1 記法の列名にする（0 → A、25 → Z、26 → AA）。
 *
 * 列は26を超えうる（§11.2 の v3.1 で面ごとに分けたため）。
 * 「Z の次は AA」を自前で書くのは、Sheets API に列名を計算する口が
 * 無いからである。
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

function sheetsUrl(spreadsheetId, path = '', params = null) {
  const base = `${SHEETS_ENDPOINT}/${encodeURIComponent(spreadsheetId)}${path}`;
  return params ? `${base}?${params}` : base;
}

/* ---------- 作成 ---------- */

/*
 * 台帳を作り、見出し行まで書いてフォルダへ移す。
 *
 * `spreadsheets.create` は親フォルダを指定できないため、作成後に
 * Drive API で親を付け替える。**移動に失敗しても全体は失敗にしない。**
 * マイドライブ直下に残るだけで、台帳としては使えるためである。
 */
export async function createSpreadsheet(parentFolderId, { token, fetchImpl, signal } = {}) {
  const created = await driveFetchJson(`${SHEETS_ENDPOINT}?fields=spreadsheetId`, {
    token,
    fetchImpl,
    signal,
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({
      properties: {
        title: SPREADSHEET_NAME,
        /* 日付の解釈を利用者のロケール任せにしない。 */
        locale: 'ja_JP',
        timeZone: 'Asia/Tokyo',
      },
      /*
       * **列数を明示する。** 既定は26列で、27列目（その他）へ見出しを
       * 書いた瞬間に 400 になる。作るときに広げておけば、そのあとの
       * 書き込みは素直に通る。
       */
      sheets: TAB_ORDER.map((title) => ({
        properties: {
          title,
          gridProperties: { columnCount: gridWidthFor(title) },
        },
      })),
    }),
  });

  const spreadsheetId = created?.spreadsheetId;

  if (!spreadsheetId) {
    throw new DriveError(DriveErrorCode.UNKNOWN, 0, 'spreadsheet_id_missing');
  }

  for (const title of TAB_ORDER) {
    await writeHeader(spreadsheetId, title, TAB_COLUMNS[title], { token, fetchImpl, signal });
  }

  try {
    const moveParams = new URLSearchParams({ addParents: parentFolderId, fields: 'id,parents' });

    await driveFetchJson(
      `${DRIVE_FILES_ENDPOINT}/${encodeURIComponent(spreadsheetId)}?${moveParams}`,
      { token, fetchImpl, signal, method: 'PATCH' },
    );
  } catch {
    /* 移動できなくても台帳は使える。全体を失敗にしない。 */
  }

  return spreadsheetId;
}

/* ---------- 構造の読み取り ---------- */

/* タブの一覧。健全性の確認に使う。 */
export async function getStructure(spreadsheetId, { token, fetchImpl, signal } = {}) {
  /*
   * **列数（gridProperties.columnCount）も取る。**
   * Sheets はグリッドの外側へ書けない。列を足す前に、いまの幅を
   * 知っておく必要がある（下の ensureColumnCount）。
   */
  const params = new URLSearchParams({
    fields: 'sheets(properties(sheetId,title,gridProperties(columnCount,rowCount)))',
  });

  const result = await driveFetchJson(sheetsUrl(spreadsheetId, '', params), {
    token,
    fetchImpl,
    signal,
  });

  const sheets = Array.isArray(result?.sheets) ? result.sheets : [];

  return {
    tabs: sheets.map((sheet) => ({
      title: String(sheet?.properties?.title ?? ''),
      sheetId: sheet?.properties?.sheetId ?? null,
      columnCount: Number(sheet?.properties?.gridProperties?.columnCount ?? 0),
      rowCount: Number(sheet?.properties?.gridProperties?.rowCount ?? 0),
    })),
  };
}

/* 見出し行（1行目）を読む。 */
export async function readHeader(spreadsheetId, tabTitle, { token, fetchImpl, signal } = {}) {
  const range = `${quoteTabTitle(tabTitle)}!1:1`;

  const result = await driveFetchJson(
    sheetsUrl(spreadsheetId, `/values/${encodeURIComponent(range)}`),
    { token, fetchImpl, signal },
  );

  const values = Array.isArray(result?.values) ? result.values : [];

  return Array.isArray(values[0]) ? values[0] : [];
}

/*
 * 1列ぶんを読む（重複判定キーの列など）。
 * **必要な列だけを読む。** 名刺データ全体を読み込む必要はない。
 */
export async function readColumn(spreadsheetId, tabTitle, columnIndex, { token, fetchImpl, signal } = {}) {
  const letter = columnLetter(columnIndex);
  const range = `${quoteTabTitle(tabTitle)}!${letter}2:${letter}`;

  const result = await driveFetchJson(
    sheetsUrl(spreadsheetId, `/values/${encodeURIComponent(range)}`),
    { token, fetchImpl, signal },
  );

  const values = Array.isArray(result?.values) ? result.values : [];

  return values.map((row) => String(row?.[0] ?? ''));
}

/* ---------- 書き込み ---------- */

/*
 * 見出し行を書く。**見出しは静的な定義なのでサニタイズを通さない。**
 * 利用者の入力ではなく、こちらが決めた文字列である。
 */
export async function writeHeader(spreadsheetId, tabTitle, columns, { token, fetchImpl, signal } = {}) {
  const range = `${quoteTabTitle(tabTitle)}!A1`;
  const params = new URLSearchParams({ valueInputOption: 'RAW' });

  await driveFetchJson(
    sheetsUrl(spreadsheetId, `/values/${encodeURIComponent(range)}`, params),
    {
      token,
      fetchImpl,
      signal,
      method: 'PUT',
      headers: JSON_HEADERS,
      body: JSON.stringify({ values: [headersOf(columns)] }),
    },
  );
}

/*
 * グリッドの幅を広げる。
 *
 * ==================================================================
 * Sheets はグリッドの外へ書けない
 * ==================================================================
 * 既定のシートは26列（Z列まで）しかない。27列目（AA）へ
 * `values.update` すると、**400 で弾かれる。**
 *
 *   Range ('名刺データ'!AA1) exceeds grid limits. Max columns: 26
 *
 * 実際に本番で起きた（v3.5 で「その他」を足したとき）。
 * **書く前に、まずグリッドそのものを広げる。**
 *
 * テストのスタブがこの検査をしていなかったため、通ってしまっていた。
 * いまはスタブ側でも範囲を検査している。
 * ==================================================================
 */
export async function ensureColumnCount(spreadsheetId, sheetId, needed, { token, fetchImpl, signal } = {}) {
  /*
   * sheetId が分からないときは広げようがない。**黙って進めない。**
   * 呼び出し側が getStructure から渡す。
   */
  if (sheetId === null || sheetId === undefined) {
    throw new DriveError(DriveErrorCode.BAD_REQUEST, 0, 'sheet_id_unknown_cannot_expand_grid');
  }

  await driveFetchJson(sheetsUrl(spreadsheetId, ':batchUpdate'), {
    token,
    fetchImpl,
    signal,
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({
      requests: [{
        appendDimension: { sheetId, dimension: 'COLUMNS', length: needed },
      }],
    }),
  });
}

/*
 * 足りない列を**右端へ足す**（既存の列には触れない）。
 *
 * 触れないのは、利用者がすでに入れた値を動かさないため。
 * 列の意味は位置で決まるので、途中へ挿入すると既存の行がずれる。
 *
 * **書く前にグリッドを広げる。** currentColumnCount より右へ書く場合、
 * 先に列を足さないと 400 になる（上の ensureColumnCount）。
 */
export async function appendMissingColumns(
  spreadsheetId,
  tabTitle,
  existingCount,
  missingColumns,
  { token, fetchImpl, signal, sheetId = null, currentColumnCount = 0 } = {},
) {
  if (!Array.isArray(missingColumns) || missingColumns.length === 0) {
    return;
  }

  const lastColumnNeeded = existingCount + missingColumns.length;

  if (currentColumnCount > 0 && lastColumnNeeded > currentColumnCount) {
    await ensureColumnCount(
      spreadsheetId,
      sheetId,
      lastColumnNeeded - currentColumnCount,
      { token, fetchImpl, signal },
    );
  }

  const start = `${columnLetter(existingCount)}1`;
  const range = `${quoteTabTitle(tabTitle)}!${start}`;
  const params = new URLSearchParams({ valueInputOption: 'RAW' });

  await driveFetchJson(
    sheetsUrl(spreadsheetId, `/values/${encodeURIComponent(range)}`, params),
    {
      token,
      fetchImpl,
      signal,
      method: 'PUT',
      headers: JSON_HEADERS,
      body: JSON.stringify({ values: [headersOf(missingColumns)] }),
    },
  );
}

/*
 * 1行を追記する。
 *
 * **valueInputOption は USER_ENTERED。** 理由はファイル冒頭。
 * row は schema.js の buildDataRow が作ったもの（＝サニタイズ済み）を
 * 渡すこと。**生の値をここへ渡さない。**
 */
export async function appendRow(spreadsheetId, tabTitle, row, { token, fetchImpl, signal } = {}) {
  const range = `${quoteTabTitle(tabTitle)}!A1`;
  const params = new URLSearchParams({
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    fields: 'updates(updatedRange)',
  });

  const result = await driveFetchJson(
    sheetsUrl(spreadsheetId, `/values/${encodeURIComponent(range)}:append`, params),
    {
      token,
      fetchImpl,
      signal,
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ values: [row] }),
    },
  );

  return String(result?.updates?.updatedRange ?? '');
}

/* 欠けているタブを作る。 */
export async function addTabs(spreadsheetId, titles, { token, fetchImpl, signal } = {}) {
  if (!Array.isArray(titles) || titles.length === 0) {
    return;
  }

  await driveFetchJson(sheetsUrl(spreadsheetId, ':batchUpdate'), {
    token,
    fetchImpl,
    signal,
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({
      /* 作り直すタブにも列数を明示する（作成時と同じ理由）。 */
      requests: titles.map((title) => ({
        addSheet: {
          properties: { title, gridProperties: { columnCount: gridWidthFor(title) } },
        },
      })),
    }),
  });
}

export function spreadsheetUrl(spreadsheetId) {
  return `https://docs.google.com/spreadsheets/d/${encodeURIComponent(spreadsheetId)}/edit`;
}

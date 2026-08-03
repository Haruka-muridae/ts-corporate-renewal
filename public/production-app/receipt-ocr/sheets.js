/*
 * Sheets API v4 の呼び出し（仕様書 §5-③ / §5-⑨ / §9）。
 *
 * 担当するのはスプレッドシートの操作だけ。判断は provisioning.js に置く。
 *
 * ------------------------------------------------------------------
 * 数式インジェクション対策（§13）
 * ------------------------------------------------------------------
 * 守る対象は利用者自身のシートである。領収書の文字列がそのまま
 * `=` や `+` で始まっていると、開いた瞬間に数式として評価される。
 * OCR の結果は「読み取った紙の文字」であって式ではないので、
 * 書き込む値はすべて escapeFormula() を通す。
 *
 * 通すのは「値」だけ。ヘッダーは静的定義であり通さない。
 * ------------------------------------------------------------------
 */

import { GOOGLE_API } from './config.js';
import { PROGRESS } from './errors.js';
import { callGoogle, callGoogleJson } from './google-api.js';
import {
  DATA_COLUMNS,
  DEFAULT_SETTINGS,
  REVIEW_FILTER_VIEW_NAME,
  SETTINGS_KEYS,
  SCHEMA_VERSION,
  TABS,
  TAB_COLUMNS,
  TAB_ORDER,
  columnIndex,
  columnLetter,
  headersOf,
} from './schema.js';

/*
 * 数式として評価されうる先頭文字を無害化する。
 *
 * 先頭にシングルクォートを足すと、Sheets は「文字列として扱え」と解釈し、
 * 表示上はクォートが出ない。値を削らずに評価だけを止められる。
 */
export function escapeFormula(value) {
  if (value === null || value === undefined) {
    return '';
  }

  const text = String(value);

  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}

export function escapeRow(values) {
  return (Array.isArray(values) ? values : []).map(escapeFormula);
}

/* ---------- 読み取り ---------- */

/* タブ名とフィルタビュー名。起動時の構造確認に使う（§9.3）。 */
export async function getStructure(spreadsheetId, { accessToken, signal } = {}) {
  const url = new URL(`${GOOGLE_API.sheets}/${encodeURIComponent(spreadsheetId)}`);
  url.searchParams.set('fields', 'sheets(properties(sheetId,title),filterViews(title))');

  const result = await callGoogle(url.href, { accessToken, signal, progress: PROGRESS.NONE });
  const sheets = Array.isArray(result?.sheets) ? result.sheets : [];

  return {
    tabs: sheets.map((sheet) => ({
      sheetId: sheet?.properties?.sheetId ?? null,
      title: String(sheet?.properties?.title ?? ''),
    })),
    filterViews: sheets.flatMap((sheet) =>
      (Array.isArray(sheet?.filterViews) ? sheet.filterViews : [])
        .map((view) => String(view?.title ?? ''))),
  };
}

/* ヘッダー行（1行目）を取る。検証は schema.js の verifyHeader が行う。 */
export async function readHeader(spreadsheetId, tabTitle, { accessToken, signal } = {}) {
  const range = `${tabTitle}!1:1`;
  const url = new URL(`${GOOGLE_API.sheets}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`);

  const result = await callGoogle(url.href, { accessToken, signal, progress: PROGRESS.NONE });

  return Array.isArray(result?.values?.[0]) ? result.values[0] : [];
}

/*
 * 1列だけを取る（§10）。
 *
 * **全列の全件取得を行わない。** 重複判定に要るのはハッシュ列だけであり、
 * 領収書の中身をまとめて読み出す必要はない。
 */
export async function readColumn(spreadsheetId, tabTitle, columnKey, {
  accessToken,
  columns = DATA_COLUMNS,
  signal,
} = {}) {
  const index = columnIndex(columns, columnKey);

  if (index < 0) {
    return [];
  }

  const letter = columnLetter(index);
  const range = `${tabTitle}!${letter}2:${letter}`;
  const url = new URL(`${GOOGLE_API.sheets}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`);
  url.searchParams.set('majorDimension', 'COLUMNS');

  const result = await callGoogle(url.href, { accessToken, signal, progress: PROGRESS.NONE });

  return Array.isArray(result?.values?.[0]) ? result.values[0] : [];
}

/*
 * 重複判定に要る列だけをまとめて取る（§10）。
 *
 * batchGet を使い、列ごとに範囲を指定する。
 * OCR原文や但し書きは取らない。判定に要らないものを端末へ運ばない。
 */
export async function readDuplicateColumns(spreadsheetId, columnKeys, {
  accessToken,
  columns = DATA_COLUMNS,
  tabTitle = TABS.data,
  signal,
} = {}) {
  const targets = columnKeys
    .map((key) => ({ key, index: columnIndex(columns, key) }))
    .filter((target) => target.index >= 0);

  if (targets.length === 0) {
    return {};
  }

  const url = new URL(`${GOOGLE_API.sheets}/${encodeURIComponent(spreadsheetId)}/values:batchGet`);
  url.searchParams.set('majorDimension', 'COLUMNS');

  for (const target of targets) {
    const letter = columnLetter(target.index);
    url.searchParams.append('ranges', `${tabTitle}!${letter}2:${letter}`);
  }

  const result = await callGoogle(url.href, { accessToken, signal, progress: PROGRESS.NONE });
  const ranges = Array.isArray(result?.valueRanges) ? result.valueRanges : [];
  const out = {};

  targets.forEach((target, i) => {
    out[target.key] = Array.isArray(ranges[i]?.values?.[0]) ? ranges[i].values[0] : [];
  });

  return out;
}

/* ---------- 書き込み ---------- */

function valuesUpdateUrl(spreadsheetId, range) {
  const url = new URL(`${GOOGLE_API.sheets}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`);
  url.searchParams.set('valueInputOption', 'RAW');
  return url;
}

/* 指定範囲を上書きする。ヘッダー行の作成・補修に使う。 */
export function writeRange(spreadsheetId, range, rows, { accessToken, signal, progress } = {}) {
  return callGoogleJson(valuesUpdateUrl(spreadsheetId, range).href, {
    accessToken,
    method: 'PUT',
    body: { values: rows },
    signal,
    progress,
  });
}

/* 末尾へ1行足す（§5-⑨）。値は必ず escapeRow を通してから渡すこと。 */
export function appendRow(spreadsheetId, tabTitle, values, { accessToken, signal } = {}) {
  const url = new URL(`${GOOGLE_API.sheets}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(`${tabTitle}!A1`)}:append`);
  url.searchParams.set('valueInputOption', 'RAW');
  url.searchParams.set('insertDataOption', 'INSERT_ROWS');

  return callGoogleJson(url.href, {
    accessToken,
    method: 'POST',
    body: { values: [escapeRow(values)] },
    signal,
    /* ここで失敗したときは原本だけが保存済み（§12 SHEET-001）。 */
    progress: PROGRESS.ORIGINAL_SAVED,
  });
}

export function batchUpdate(spreadsheetId, requests, { accessToken, signal, progress } = {}) {
  return callGoogleJson(`${GOOGLE_API.sheets}/${encodeURIComponent(spreadsheetId)}:batchUpdate`, {
    accessToken,
    method: 'POST',
    body: { requests },
    signal,
    progress,
  });
}

/* ---------- 作成（§9.2-4） ---------- */

/*
 * スプレッドシートを作り、4つのタブとヘッダー行を用意する。
 * 共有設定は付けない（§9.5）。Drive 側の permissions は一切呼ばない。
 */
export async function createSpreadsheet({ accessToken, title, signal }) {
  const url = new URL(GOOGLE_API.sheets);
  url.searchParams.set('fields', 'spreadsheetId,sheets(properties(sheetId,title))');

  const created = await callGoogleJson(url.href, {
    accessToken,
    method: 'POST',
    body: {
      properties: { title: String(title) },
      sheets: TAB_ORDER.map((tabTitle) => ({ properties: { title: tabTitle } })),
    },
    signal,
    progress: PROGRESS.NONE,
  });

  return created;
}

/* 各タブのヘッダー行を書く。ヘッダーは静的定義なので escape しない。 */
export async function writeAllHeaders(spreadsheetId, { accessToken, signal } = {}) {
  for (const tabTitle of TAB_ORDER) {
    const columns = TAB_COLUMNS[tabTitle];
    await writeRange(spreadsheetId, `${tabTitle}!A1`, [headersOf(columns)], {
      accessToken,
      signal,
      progress: PROGRESS.NONE,
    });
  }
}

/*
 * 設定タブを書く（§9.4 / v1.3 §16.6）。
 *
 * 1行目はスキーマバージョン。2行目以降が利用者の調整対象。
 * バージョンだけを更新する場合は seedDefaults を false にする
 * （利用者が変えた閾値を上書きしないため）。
 */
export function writeSchemaVersion(spreadsheetId, {
  accessToken,
  signal,
  version = SCHEMA_VERSION,
  seedDefaults = false,
} = {}) {
  const rows = [
    [SETTINGS_KEYS.schemaVersion, version, 'アプリが管理します。手で変更しないでください。'],
  ];

  if (seedDefaults) {
    rows.push(...DEFAULT_SETTINGS.map((row) => [...row]));
  }

  return writeRange(spreadsheetId, `${TABS.settings}!A2`, rows, {
    accessToken,
    signal,
    progress: PROGRESS.NONE,
  });
}

/*
 * 設定タブを読む（v1.3 §16.6）。
 * 設定名 → 値 の対応を返す。読めなければ空を返し、既定値で動く。
 */
export async function readSettings(spreadsheetId, { accessToken, signal } = {}) {
  const range = `${TABS.settings}!A2:B`;
  const url = new URL(`${GOOGLE_API.sheets}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`);

  const result = await callGoogle(url.href, { accessToken, signal, progress: PROGRESS.NONE });
  const rows = Array.isArray(result?.values) ? result.values : [];
  const out = {};

  for (const row of rows) {
    const name = String(row?.[0] ?? '').trim();

    if (name !== '') {
      out[name] = String(row?.[1] ?? '').trim();
    }
  }

  return out;
}

/* 初期店舗マスタを書く。空なら何もしない（§9.1・§0.6-2 が未確定のため）。 */
export function writeStoreMaster(spreadsheetId, rows, { accessToken, signal } = {}) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return Promise.resolve(null);
  }

  return writeRange(spreadsheetId, `${TABS.storeMaster}!A2`, rows.map(escapeRow), {
    accessToken,
    signal,
    progress: PROGRESS.NONE,
  });
}

/*
 * 不足している列を右端へ足す（§9.4）。
 * 既存列には触れない。並べ替えも改名もしない。
 */
export function appendMissingColumns(spreadsheetId, tabTitle, existingCount, missingColumns, {
  accessToken,
  signal,
} = {}) {
  if (!Array.isArray(missingColumns) || missingColumns.length === 0) {
    return Promise.resolve(null);
  }

  const startLetter = columnLetter(existingCount);

  return writeRange(
    spreadsheetId,
    `${tabTitle}!${startLetter}1`,
    [missingColumns.map((column) => column.header)],
    { accessToken, signal, progress: PROGRESS.NONE },
  );
}

/*
 * 「要確認一覧」フィルタビューとヘッダー行の保護（§11・§15.2）。
 *
 * 保護するのはヘッダー行だけ。本人のシートなので、
 * データ行の編集は妨げない（§11「本人のシートのため強制しない」）。
 */
export function createReviewViewAndProtection(spreadsheetId, dataSheetId, { accessToken, signal } = {}) {
  const reviewIndex = columnIndex(DATA_COLUMNS, 'reviewStatus');
  const requests = [
    {
      addFilterView: {
        filter: {
          title: REVIEW_FILTER_VIEW_NAME,
          range: {
            sheetId: dataSheetId,
            startRowIndex: 0,
            startColumnIndex: 0,
            endColumnIndex: DATA_COLUMNS.length,
          },
          criteria: reviewIndex >= 0
            ? { [reviewIndex]: { condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: '要確認' }] } } }
            : {},
        },
      },
    },
    {
      addProtectedRange: {
        protectedRange: {
          range: { sheetId: dataSheetId, startRowIndex: 0, endRowIndex: 1 },
          description: 'ヘッダー行（アプリが管理します）',
          warningOnly: true,
        },
      },
    },
  ];

  return batchUpdate(spreadsheetId, requests, { accessToken, signal, progress: PROGRESS.NONE });
}

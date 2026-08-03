/*
 * 保存する1件の組み立て（仕様書 §5-⑨ / §9.1 / §13）。
 *
 * ------------------------------------------------------------------
 * 列の位置を数えない
 * ------------------------------------------------------------------
 * 行は必ず schema.js の DATA_COLUMNS の並びから作る。
 * ここで「3列目が金額」のように数えると、§9.4 で列を足したときに
 * 2か所を直すことになり、片方を忘れた瞬間に利用者のデータがずれる。
 * ------------------------------------------------------------------
 *
 * 値の無害化（数式インジェクション対策）は sheets.js の appendRow が行う。
 * ここでは「どの列に何を入れるか」だけを決める。
 */

import { DATA_COLUMNS, OCR_TEXT_COLUMNS, TABS } from './schema.js';
import { appendRow } from './sheets.js';
import { timestamp } from './datetime.js';

/*
 * 管理ID。
 *
 * 利用者ごとに独立したシートなので、社内で一意である必要はない。
 * 「その人のシートの中で重ならない」ことと、目で見て日付が分かることを優先する。
 * 採番は原子的ではない（同時に2タブで押されると衝突しうる）が、
 * §10 が「単一利用者・自己データという前提で許容する」としている。
 */
export function newRecordId(date = new Date(), random = Math.random) {
  const stamp = timestamp(date).replace(/[-: ]/g, '');
  const suffix = Math.floor(random() * 36 ** 4).toString(36).padStart(4, '0').toUpperCase();

  return `R${stamp}-${suffix}`;
}

/*
 * record（key → 値の object）を、DATA_COLUMNS の並びの配列にする。
 * 未設定の列は空文字。undefined を残すと Sheets 側で列がずれる。
 */
export function toDataRow(record, columns = DATA_COLUMNS) {
  return columns.map((column) => {
    const value = record?.[column.key];
    return value === null || value === undefined ? '' : value;
  });
}

/* OCR原文タブの行。管理IDで本体と紐付ける（§9.1）。 */
export function toOcrTextRow(record, columns = OCR_TEXT_COLUMNS) {
  return columns.map((column) => {
    const value = record?.[column.key];
    return value === null || value === undefined ? '' : value;
  });
}

/*
 * 保存する。
 *
 * データ行を先に書き、そのあとで OCR原文を書く。
 * 逆にすると、原文だけが残って本体が無い行ができる。
 * どちらで失敗しても SHEET-001 が投げられ、
 * 「原本保存済み・データ未保存」が画面に出る（§12）。
 */
export async function saveRecord({ accessToken, spreadsheetId, record, ocrText, signal }) {
  await appendRow(spreadsheetId, TABS.data, toDataRow(record), { accessToken, signal });

  if (typeof ocrText === 'string' && ocrText !== '') {
    await appendRow(
      spreadsheetId,
      TABS.ocrText,
      toOcrTextRow({
        recordId: record.recordId,
        engine: record.extractionMethod ?? '',
        capturedAt: record.createdAt ?? '',
        text: ocrText,
      }),
      { accessToken, signal },
    );
  }

  return record.recordId;
}

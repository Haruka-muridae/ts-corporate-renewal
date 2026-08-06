/*
 * 保存する1件の組み立て（v2.0 §5-⑨ / v1.3 §16.1〜16.2）。
 *
 * ------------------------------------------------------------------
 * 列の位置を数えない
 * ------------------------------------------------------------------
 * 行は必ず schema.js の列定義の並びから作る。
 * ここで「3列目が金額」のように数えると、§9.4 で列を足したときに
 * 2か所を直すことになり、片方を忘れた瞬間に利用者のデータがずれる。
 * ------------------------------------------------------------------
 *
 * 数式インジェクション対策は sheets.js が書き込み直前に行う。
 * ここでは「どの列に何を入れるか」と「金額は数値で入れる」だけを決める。
 */

import { DATA_COLUMNS, OCR_TEXT_COLUMNS } from './schema.js';
import { TABS } from './schema.js';
import { appendRow } from './sheets.js';
import { dateStamp, timestamp } from './datetime.js';
import { normalizeAmount } from './amount.js';

/*
 * 管理ID（v1.3 §16.1 A列）。
 *
 * RCP-YYYYMMDD-ランダム6文字。
 * v1.3 は「生成時に既存IDとの衝突チェックを行う」としているが、
 * v2.0 §10 が「単一利用者・自己データという前提で許容する」として
 * サーバーの排他制御を持たない構成にしている。
 * 6文字（36^6 ≒ 21億通り）の衝突は、同一利用者の1日ぶんの件数から見て
 * 無視できる。照合が要るなら保存前の重複判定で拾う。
 */
export function newRecordId(date = new Date(), random = Math.random) {
  const day = dateStamp(date).replace(/-/g, '');
  let suffix = '';

  for (let i = 0; i < 6; i += 1) {
    suffix += Math.floor(random() * 36).toString(36).toUpperCase();
  }

  return `RCP-${day}-${suffix}`;
}

/*
 * 金額列は数値で書く（v1.3 §16.1 の書き込み要件）。
 * 文字列のまま入れると、シート上で集計できない。
 */
function cellValue(column, raw) {
  if (raw === null || raw === undefined || raw === '') {
    return '';
  }

  if (column.kind === 'number') {
    const number = normalizeAmount(raw);
    return number === null ? '' : number;
  }

  return raw;
}

/* record（key → 値）を、列定義の並びの配列にする。 */
export function toDataRow(record, columns = DATA_COLUMNS) {
  return columns.map((column) => cellValue(column, record?.[column.key]));
}

/* OCR原文タブの行（v1.3 §16.2：管理ID / OCR原文 / 保存日時）。 */
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
 * 「原本保存済み・データ未保存」が画面に出る（v2.0 §12）。
 */
export async function saveRecord({ accessToken, spreadsheetId, record, ocrText, signal, now = new Date() }) {
  await appendRow(spreadsheetId, TABS.data, toDataRow(record), { accessToken, signal });

  if (typeof ocrText === 'string' && ocrText !== '') {
    await appendRow(
      spreadsheetId,
      TABS.ocrText,
      toOcrTextRow({
        recordId: record.recordId,
        text: ocrText,
        savedAt: timestamp(now),
      }),
      { accessToken, signal },
    );
  }

  return record.recordId;
}

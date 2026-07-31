/*
 * CSV の組み立て（実装仕様書 9章）。
 *
 * ==================================================================
 * 方針
 * ==================================================================
 *   - Excel で開くことを前提にする。文字化けを避けるため BOM を付け、
 *     改行は CRLF にする。
 *   - 値に含まれる引用符・カンマ・改行はエスケープする。
 *   - 数式として解釈されうる先頭文字（= + - @ など）を無害化する。
 *     氏名や会社名に「=」で始まる文字列が入っていた場合、Excel が
 *     数式として実行してしまうため（CSVインジェクション）。
 * ==================================================================
 */

/** Excel が UTF-8 と判定するための印。 */
export const BOM = '﻿';

/*
 * 数式の起点になりうる文字。
 * タブと復帰も含めるのは、前置きされた空白を Excel が読み飛ばして
 * 続く = を数式として扱うことがあるため。
 */
const FORMULA_PREFIXES = ['=', '+', '-', '@', '\t', '\r'];

/**
 * 1つの値をCSVの1項目にする。
 *
 * @param {unknown} value
 * @returns {string}
 */
export function escapeCsvValue(value) {
  if (value === null || value === undefined) {
    return '';
  }

  let text = String(value);

  /*
   * 先頭が数式の起点なら、シングルクォートを前置して文字列として読ませる。
   * 値そのものは変えず、表示上も元の文字列が見える。
   */
  if (text.length > 0 && FORMULA_PREFIXES.includes(text[0])) {
    text = `'${text}`;
  }

  if (/["\n\r,]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }

  return text;
}

/**
 * 表をCSVの文字列にする。
 *
 * @param {{ header: string, key: string }[]} columns
 * @param {Record<string, unknown>[]} rows
 * @returns {string}
 */
export function buildCsv(columns, rows) {
  const lines = [];

  lines.push(columns.map((column) => escapeCsvValue(column.header)).join(','));

  rows.forEach((row) => {
    lines.push(columns.map((column) => escapeCsvValue(row[column.key])).join(','));
  });

  /* Excel が扱いやすいよう CRLF で終端する。 */
  return BOM + lines.join('\r\n') + '\r\n';
}

/**
 * ダウンロード用のファイル名を組み立てる。
 *
 * @param {string} prefix
 * @param {Date} date
 */
export function csvFileName(prefix, date) {
  const parts = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);

  const get = (type) => parts.find((part) => part.type === type)?.value ?? '';
  /* ja-JP は「2026/08/01」の形で返すため、区切りを除いて連結する。 */
  const stamp = `${get('year')}${get('month')}${get('day')}`.replace(/[^0-9]/g, '');

  return `${prefix}_${stamp}.csv`;
}

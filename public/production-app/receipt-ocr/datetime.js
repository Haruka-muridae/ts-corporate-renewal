/*
 * 日付の取り扱い（仕様書 §6「タイムゾーン Asia/Tokyo」）。
 *
 * ------------------------------------------------------------------
 * 端末の時間帯を使わない
 * ------------------------------------------------------------------
 * 原本の月別フォルダ（§9.1 の YYYY/MM）は、利用者が海外にいても
 * 日本時間で切りたい。端末の設定に任せると、同じ領収書が
 * 端末によって別の月へ入る。Intl で明示的に Asia/Tokyo へ寄せる。
 * ------------------------------------------------------------------
 */

import { TIME_ZONE } from './config.js';

const partsFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

function partsOf(date) {
  const result = {};

  for (const part of partsFormatter.formatToParts(date)) {
    if (part.type !== 'literal') {
      result[part.type] = part.value;
    }
  }

  /* 24時制の 24:xx を 00:xx へ寄せる（環境によって表記が割れるため）。 */
  if (result.hour === '24') {
    result.hour = '00';
  }

  return result;
}

/* 原本の保存先となる年フォルダ・月フォルダの名前（§9.1）。 */
export function yearMonthPath(date = new Date()) {
  const { year, month } = partsOf(date);
  return { year, month };
}

/* シートへ書く日時。'YYYY-MM-DD HH:mm:ss'（日本時間）。 */
export function timestamp(date = new Date()) {
  const { year, month, day, hour, minute, second } = partsOf(date);
  return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
}

/* シートへ書く日付。'YYYY-MM-DD'（日本時間）。 */
export function dateStamp(date = new Date()) {
  const { year, month, day } = partsOf(date);
  return `${year}-${month}-${day}`;
}

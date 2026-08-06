/*
 * 金額の正規化（v1.3 §10.1）。全金額フィールド共通の前処理。
 *
 * ------------------------------------------------------------------
 * 変換に失敗したら null。0にしない
 * ------------------------------------------------------------------
 * §10.1 が明示している。0 を返すと「0円の領収書」として通ってしまい、
 * §13.1 の「合計金額が0円より大きい」検証もすり抜ける。
 * 読めなかったことは、読めなかったまま上へ伝える。
 * ------------------------------------------------------------------
 *
 * ------------------------------------------------------------------
 * 「1.000」を 1 と読まない
 * ------------------------------------------------------------------
 * §10.1 が対策対象として名指ししている誤読である。
 * 日本の領収書に小数の円は出てこないため、金額中のピリオドは
 * カンマの誤認とみなし、桁区切りとして扱う。
 *
 * ただし「1.5」のように3桁で区切られていないものは、桁区切りとして
 * 説明がつかない。**推測して直さず null にする。**
 * ------------------------------------------------------------------
 */

/* 全角英数字・全角記号を半角へ。 */
export function toHalfWidth(text) {
  return String(text ?? '')
    .replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/　/g, ' ');
}

/* 桁区切り（カンマ、またはその誤認であるピリオド）で3桁ずつ区切られた形。 */
const GROUPED = /^-?\d{1,3}(?:[,.]\d{3})+$/;
const PLAIN = /^-?\d+$/;

/*
 * 金額文字列を整数にする。できなければ null。
 *
 * 受け付ける例:
 *   「1,000」「1.000」「¥1000」「￥ 1,234,567」「1000円」「△1,000」
 * null にする例:
 *   「1.5」「1,00」「約1000」「－」「」
 */
export function normalizeAmount(value) {
  if (typeof value === 'number') {
    return Number.isInteger(value) ? value : null;
  }

  let text = toHalfWidth(value).trim();

  if (text === '') {
    return null;
  }

  /* 会計表記の負号。記号を落とす前に符号へ移す。 */
  const negative = /^[-△▲]/.test(text) || /^\(.*\)$/.test(text);

  text = text
    .replace(/^[-△▲]/, '')
    .replace(/^\((.*)\)$/, '$1')
    .replace(/[¥￥]/g, '')
    .replace(/円/g, '')
    .replace(/\s/g, '')
    .trim();

  if (text === '') {
    return null;
  }

  let digits = null;

  if (GROUPED.test(text)) {
    digits = text.replace(/[,.]/g, '');
  } else if (PLAIN.test(text)) {
    digits = text;
  } else {
    /* 「1.5」「1,00」「約1000」等。桁区切りとして説明がつかない。 */
    return null;
  }

  const number = Number(digits);

  if (!Number.isSafeInteger(number)) {
    return null;
  }

  return negative ? -number : number;
}

/*
 * 文字列の中から金額らしい部分をすべて拾う。
 *
 * 記号や単位が付いているものを優先して探し、
 * 見つからなければ裸の数字列も候補にする。
 * 戻り値は正規化済みの整数の配列（変換できなかったものは落とす）。
 */
export function findAmounts(line) {
  const text = toHalfWidth(line);
  const found = [];

  /* 「¥1,000」「1,000円」「1.000」など、区切りや単位を伴うもの。 */
  const marked = text.match(/[¥￥]\s?-?[\d,.]+|-?[\d,.]+\s?円|-?\d{1,3}(?:[,.]\d{3})+/g) ?? [];

  for (const item of marked) {
    const value = normalizeAmount(item);

    if (value !== null) {
      found.push(value);
    }
  }

  if (found.length > 0) {
    return found;
  }

  /* 裸の数字列。桁区切りが無いレシートのため。 */
  for (const item of text.match(/-?\d+/g) ?? []) {
    const value = normalizeAmount(item);

    if (value !== null) {
      found.push(value);
    }
  }

  return found;
}

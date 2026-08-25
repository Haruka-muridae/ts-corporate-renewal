/*
 * 台帳の行 ⇄ レコードオブジェクトの変換。
 *
 * 担当するのはこの往復変換だけ。**純粋関数のみ**（DOM・fetch を参照しない）。
 * 列順・列定義の単一の情報源は ../card-scanner/fields.js の COLUMN_DEFS。
 * ここで列順を独自に組み立て直さないこと（二重定義は事故のもと）。
 *
 * ------------------------------------------------------------------
 * Sheets のシリアル日時について
 * ------------------------------------------------------------------
 * 行の読み込みは valueRenderOption=FORMULA で行う（manager-client.js）。
 * この場合、数式でないセルは UNFORMATTED_VALUE と同じ値になり、
 * 日時セルは「シリアル値」という数値で返る（文字列には戻らない）。
 *
 * 表示用にシリアル値を "YYYY/MM/DD HH:mm" へ変換するのが
 * sheetSerialToDate() / formatSheetTimestamp() で、常に UTC の
 * getter で読み書きする。シリアル値はタイムゾーンを持たない
 * 「壁時計の数値」なので、ブラウザのタイムゾーンに影響されない
 * 変換にするため（UTCとして扱うのは実装上の都合であり、
 * 実際にUTC時刻というわけではない）。
 *
 * 逆方向（表示用文字列 → シリアル値）の変換は持たない。
 * 保存時は更新日時だけを新しい文字列（sheets-client.js の
 * formatTimestamp()）で置き換え、それ以外の auto列はシリアル値も
 * 含めて読み取った生セルをそのまま書き戻す（applyEditsToRow）。
 * ------------------------------------------------------------------
 */

import {
  COLUMN_DEFS,
  EMAIL_HEADERS,
  SHEET_HEADERS,
  columnsToEmails,
  emailsToColumns,
  formatTags,
} from '../card-scanner/fields.js';

/* ==================================================================
 * 列の位置
 * ================================================================== */

/*
 * 行配列上の位置を列ごとに求める。
 * emails は4列へ展開されるため span=4、それ以外は span=1。
 */
export function buildColumnLayout() {
  let index = 0;

  return COLUMN_DEFS.map((column) => {
    const span = column.kind === 'emails' ? EMAIL_HEADERS.length : 1;
    const entry = { key: column.key, kind: column.kind, index, span };
    index += span;
    return entry;
  });
}

/* ==================================================================
 * 見出し行の検証
 * ================================================================== */

/*
 * 見出し行が SHEET_HEADERS と完全一致するかを確かめる。
 *
 * 部分一致では続行しない。列が増減・並べ替えされていた場合に
 * ずれたまま読み書きする事故を防ぐため、1列でも違えば不一致として扱う。
 */
export function validateHeaderRow(headerRow) {
  const header = Array.isArray(headerRow) ? headerRow.map((cell) => String(cell ?? '')) : [];

  if (header.length !== SHEET_HEADERS.length) {
    return false;
  }

  return header.every((label, index) => label === SHEET_HEADERS[index]);
}

/* ==================================================================
 * Sheets のシリアル日時
 * ================================================================== */

const MS_PER_DAY = 24 * 60 * 60 * 1000;
/* Sheetsのシリアル値で 1970-01-01 に当たる日数（SheetJS等と同じ定数）。 */
const UNIX_EPOCH_SERIAL = 25569;

/* シリアル値 → Date。壁時計の数値として UTC の各フィールドへ詰める。 */
export function sheetSerialToDate(serial) {
  const n = Number(serial);

  if (!Number.isFinite(n)) {
    return null;
  }

  return new Date(Math.round((n - UNIX_EPOCH_SERIAL) * MS_PER_DAY));
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

/* "YYYY/MM/DD HH:mm" 形式。空・不正な値は空文字。 */
export function formatSheetTimestamp(serial) {
  if (serial === '' || serial === null || serial === undefined) {
    return '';
  }

  const date = sheetSerialToDate(serial);

  if (!date || Number.isNaN(date.getTime())) {
    return '';
  }

  const day = [
    date.getUTCFullYear(),
    pad2(date.getUTCMonth() + 1),
    pad2(date.getUTCDate()),
  ].join('/');

  return `${day} ${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}`;
}

/* ==================================================================
 * 画像リンク（=HYPERLINK("url","label")）
 * ================================================================== */

/*
 * sheets-client.js の buildImageFormula() が作る形だけを対象にする。
 * 空・数式でない値は空文字を返す。
 */
const HYPERLINK_RE = /^=HYPERLINK\(\s*"((?:[^"]|"")*)"\s*,/i;

/* sheets-client.js の formatTimestamp() が作る形式と同じ。 */
const TIMESTAMP_TEXT_RE = /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}$/;

export function extractHyperlinkUrl(cellValue) {
  const text = String(cellValue ?? '');
  const match = text.match(HYPERLINK_RE);

  if (!match) {
    return '';
  }

  return match[1].replace(/""/g, '"');
}

/* ==================================================================
 * 行 → レコード
 * ================================================================== */

/*
 * 1行分の生セル配列（valueRenderOption=FORMULA で取得したもの）を
 * 編集・表示用のレコードへ変換する。
 *
 * rowNumber は1始まりのシート上の行番号（見出し行が1行目）。
 *
 * 戻り値:
 *   {
 *     rowNumber,
 *     cardId,
 *     values: { <field列のキー>: 文字列, emails: 配列, primaryEmail: 実値 },
 *     auto:   { <auto列のキー>: 表示用の値 },
 *     raw:    読み取った生セル配列そのもの（保存時の書き戻しに使う）,
 *   }
 */
export function rowToRecord(row, rowNumber) {
  const cells = Array.isArray(row) ? row : [];
  const layout = buildColumnLayout();

  const values = {};
  const auto = {};
  let emails = [];

  layout.forEach(({ key, kind, index, span }) => {
    if (kind === 'emails') {
      emails = columnsToEmails(cells.slice(index, index + span));
      return;
    }

    const raw = cells[index];

    if (kind === 'field') {
      values[key] = String(raw ?? '');
      return;
    }

    /* kind === 'auto' */
    if (key === 'frontImageUrl' || key === 'backImageUrl') {
      auto[key] = extractHyperlinkUrl(raw);
    } else if (key === 'createdAt' || key === 'updatedAt' || key === 'ocrAt') {
      /*
       * 通常はSheetsのシリアル値（数値）が来るが、保存直後にローカルで
       * rowToRecord() を呼ぶ場合だけは applyEditsToRow() が入れた
       * "YYYY/MM/DD HH:mm" 形式の文字列がそのまま入っている
       * （更新後の行をもう一度 Sheets から読み直してはいないため）。
       * その形に一致する文字列はそのまま使い、それ以外はシリアル値として変換する。
       */
      auto[key] = TIMESTAMP_TEXT_RE.test(String(raw ?? '')) ? String(raw) : formatSheetTimestamp(raw);
    } else if (key === 'ocrConfidence') {
      const n = raw === '' || raw === null || raw === undefined ? NaN : Number(raw);
      auto[key] = Number.isFinite(n) ? n : null;
    } else {
      auto[key] = String(raw ?? '');
    }
  });

  return {
    rowNumber,
    cardId: auto.cardId ?? '',
    values: { ...values, emails, primaryEmail: emails[0] ?? '' },
    auto,
    raw: [...cells],
  };
}

/* ==================================================================
 * 編集内容 → 書き戻す行
 * ================================================================== */

/*
 * 編集対象（field列・emails）だけを新しい値へ差し替え、
 * それ以外（auto列）は読み取った生セルをそのまま残す。
 *
 * updatedAt だけは例外で、アプリが新しい値へ書き換える。
 *
 * escapeCellText / formatTimestamp は sheets-client.js の実装を
 * 呼び出し側（manager-client.js）から注入してもらう。
 * このファイルは fetch も DOM も参照しないため、
 * sheets-client.js（fetchを含むモジュール）を直接importしない。
 */
export function applyEditsToRow({ raw, values, updatedAt, escapeCellText, formatTimestamp }) {
  const row = Array.isArray(raw) ? [...raw] : [];
  const layout = buildColumnLayout();

  layout.forEach(({ key, kind, index }) => {
    if (kind === 'emails') {
      emailsToColumns(values?.emails, values?.primaryEmail).forEach((cell, offset) => {
        row[index + offset] = escapeCellText(cell);
      });
      return;
    }

    if (kind === 'field') {
      if (key === 'tags') {
        row[index] = escapeCellText(formatTags(values?.tags));
      } else {
        row[index] = escapeCellText(values?.[key] ?? '');
      }
      return;
    }

    /* kind === 'auto'。updatedAt だけ更新し、他は raw のまま。 */
    if (key === 'updatedAt') {
      row[index] = formatTimestamp(updatedAt);
    }
  });

  return row;
}

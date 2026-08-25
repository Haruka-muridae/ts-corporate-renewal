/*
 * 台帳の行 ⇄ レコードオブジェクトの変換、および画面用の項目定義。
 *
 * 担当するのはこの往復変換と表示整形だけ。**純粋関数のみ**
 * （DOM・fetch を参照しない）。列順・列定義の単一の情報源は
 * ./schema.js の DATA_COLUMNS（card-ocr/schema.js の複製）。
 * ここで列順を独自に組み立て直さないこと（二重定義は事故のもと）。
 *
 * ==================================================================
 * テスト環境からの変更点
 * ==================================================================
 * テスト環境 `/apps/card-manager/records.js` は名刺スキャナ台帳
 * （メール複数件・タグ・OCR生テキストあり）を対象にしていたが、
 * このアプリが対象にする card-ocr の台帳にはそれらの列が無い
 * （メールは1件、タグ無し、OCR生テキストは保存されない）。
 * したがって複数メール管理（emailRows 相当）と生テキスト表示は
 * このアプリには存在しない。
 * ==================================================================
 */

import {
  BOOKKEEPING_COLUMNS,
  CONTENT_COLUMNS,
  DATA_COLUMNS,
  buildDuplicateKey,
  rowToValues,
  verifyHeader,
} from './schema.js';

import {
  LONG_CELL_MAX_LENGTH,
  SHORT_CELL_MAX_LENGTH,
  escapeCellText,
  escapeLongCellText,
} from './sanitize.js';

/*
 * 保存時に無警告で切り詰めない（レビュー指摘。2026-08-20 追加）。
 *
 * sanitize.js の escapeCellText / escapeLongCellText は台帳へ書く直前に
 * 文字数を切り詰める（SHORT_CELL_MAX_LENGTH=1000 / LONG_CELL_MAX_LENGTH=
 * 50000）。**画面の入力欄にこの上限を反映しないと、利用者が気づかない
 * まま保存時に末尾が消える。** CONTENT_FIELDS の maxLength を
 * script.js の createFieldRow() が `input.maxLength` に反映する。
 *
 * 「その他」欄だけ長い上限にする（card-ocr/schema.js の
 * otherInformation と同じ扱い。applyEditsToRow も同じ列だけ
 * escapeLongCellText を使う）。
 */
function maxLengthFor(key) {
  return key === 'otherInformation' ? LONG_CELL_MAX_LENGTH : SHORT_CELL_MAX_LENGTH;
}

/* ==================================================================
 * 画面用の項目定義（編集フォーム）
 * ================================================================== */

/*
 * CONTENT_COLUMNS の各キーに、入力欄の種類とリンクの作り方を足す。
 * 定義していないキーは既定（1行テキスト・リンク無し）で扱う。
 */
const FIELD_UI = Object.freeze({
  address: { multiline: true, rows: 3 },
  otherInformation: { multiline: true, rows: 4 },
  url: { multiline: true, rows: 2, autocomplete: 'off' },
  postalCode: { inputMode: 'numeric', autocomplete: 'postal-code' },
  phone: { type: 'tel', inputMode: 'tel', autocomplete: 'tel' },
  mobile: { type: 'tel', inputMode: 'tel', autocomplete: 'tel' },
  fax: { type: 'tel', inputMode: 'tel', autocomplete: 'off' },
  email: { type: 'email', inputMode: 'email', autocomplete: 'email' },
  companyName: { autocomplete: 'organization' },
  fullName: { autocomplete: 'name' },
});

/*
 * 編集フォームに出す項目一覧。**この並び順で表示する。**
 * DATA_COLUMNS（＝台帳の列順）をそのまま使う。
 */
export const CONTENT_FIELDS = Object.freeze(
  CONTENT_COLUMNS.map((column) => ({
    key: column.key,
    label: column.header,
    maxLength: maxLengthFor(column.key),
    ...(FIELD_UI[column.key] ?? {}),
  })),
);

/* 自動項目（読み取り専用）の見出し。schema.js の英語ヘッダーのままだと
 * 分かりづらいものだけ、日本語の見出しを与える。 */
const META_LABELS = Object.freeze({
  record_id: 'カードID',
  registeredAt: '登録日時',
  duplicateKey: '重複判定キー',
  hasBack: '裏面の有無',
  backFilledFields: '裏面から補完した項目',
  frontImageHash: '表面画像ハッシュ',
  backImageHash: '裏面画像ハッシュ',
  frontFileId: '表面ファイルID',
  backFileId: '裏面ファイルID',
  frontFileUrl: '表面画像',
  backFileUrl: '裏面画像',
  appVersion: '登録アプリの版',
  promptVersion: '抽出プロンプトの版',
  uncertainFields: '要確認項目（OCR）',
});

export const META_FIELDS = Object.freeze(
  BOOKKEEPING_COLUMNS.map((column) => ({
    key: column.key,
    label: META_LABELS[column.key] ?? column.header,
  })),
);

/* ==================================================================
 * 見出し行の検証
 * ================================================================== */

/*
 * 見出し行が現在の版と一致するか。
 *
 *   'ok'      … 閲覧・編集ともに可
 *   'upgrade' … 閲覧は可。**編集は不可**（card-ocr の役割である列の
 *               追加をこのアプリでは行わない。schema.js のコメント参照）
 *   'altered' … 閲覧・編集ともに不可（列の位置が信用できない）
 *   'empty'   … 台帳が空。まだ名刺が1件も登録されていない
 */
export function checkHeader(headerRow) {
  return verifyHeader(headerRow, DATA_COLUMNS);
}

/* ==================================================================
 * 台帳のシリアル日時
 * ================================================================== */

const MS_PER_DAY = 24 * 60 * 60 * 1000;
/* Sheetsのシリアル値で 1970-01-01 に当たる日数（SheetJS等と同じ定数）。 */
const UNIX_EPOCH_SERIAL = 25569;

/* シリアル値 → Date。壁時計の数値として UTC の各フィールドへ詰める。 */
function sheetSerialToDate(serial) {
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
function formatSheetSerial(serial) {
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

/*
 * registeredAt の表示整形。
 *
 * card-ocr（register.js の formatRegisteredAt）は "YYYY-MM-DD HH:mm:ss"
 * という文字列で書き込むが、Sheets はそれを日時として解釈するため、
 * FORMULA で読み返すと**シリアル値（数値文字列）で返ることがある**
 * （card-ocr/register.js のコメントと同じ現象）。両方の形に対応する。
 */
export function formatRegisteredAtDisplay(raw) {
  const text = String(raw ?? '');

  if (text === '') {
    return '';
  }

  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text)) {
    return text;
  }

  const n = Number(text);

  if (Number.isFinite(n)) {
    const formatted = formatSheetSerial(n);
    return formatted !== '' ? formatted : text;
  }

  return text;
}

/* ==================================================================
 * 画像リンク（=HYPERLINK("url","label")）
 * ================================================================== */

/* card-ocr/sheets.js が書く形（=HYPERLINK("url","label")）だけを対象にする。 */
const HYPERLINK_RE = /^=HYPERLINK\(\s*"((?:[^"]|"")*)"\s*,/i;

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
 * 表示・編集用のレコードへ変換する。
 *
 * rowNumber は1始まりのシート上の行番号（見出し行が1行目）。
 *
 * 戻り値:
 *   {
 *     rowNumber,
 *     recordId,
 *     values: { <CONTENT_COLUMNSのキー>: 文字列 },
 *     auto:   { <自動項目のキー>: 表示用の値 },
 *     raw:    読み取った生セル配列そのもの（保存時の書き戻しの土台）,
 *   }
 */
export function rowToRecord(row, rowNumber) {
  const cells = Array.isArray(row) ? row : [];
  const values = rowToValues(cells, DATA_COLUMNS);

  const contentValues = {};
  CONTENT_COLUMNS.forEach((column) => {
    contentValues[column.key] = values[column.key] ?? '';
  });

  const auto = {};
  BOOKKEEPING_COLUMNS.forEach((column) => {
    const raw = values[column.key] ?? '';

    if (column.key === 'frontFileUrl' || column.key === 'backFileUrl') {
      auto[column.key] = extractHyperlinkUrl(raw);
    } else if (column.key === 'registeredAt') {
      auto[column.key] = formatRegisteredAtDisplay(raw);
    } else if (column.key === 'hasBack') {
      auto[column.key] = raw === 'TRUE';
    } else {
      auto[column.key] = raw;
    }
  });

  return {
    rowNumber,
    recordId: values.record_id ?? '',
    values: contentValues,
    auto,
    raw: [...cells],
  };
}

/* ==================================================================
 * 編集内容 → 書き戻す行
 * ================================================================== */

/*
 * 編集対象（CONTENT_COLUMNS）だけを新しい値へ差し替え、それ以外
 * （自動項目）は読み取った生セルをそのまま残す。
 *
 * **frontFileUrl / backFileUrl も raw のまま残す。** card-ocr が書いた
 * `=HYPERLINK(...)` を作り直すと、URLの取り違えや壊れたリンクの原因に
 * なる（schema.js buildDataRow のコメント参照）。
 *
 * duplicateKey だけは例外で、email / mobile / companyName / fullName の
 * 編集後の値から再計算する（card-ocr の buildRecord と同じ規則。
 * schema.js buildDuplicateKey）。編集で連絡先を直したのに重複判定キーが
 * 古いまま残ると、以後の名刺OCR側の重複検出が誤って働くため。
 */
export function applyEditsToRow({ raw, values }) {
  const row = Array.isArray(raw) ? [...raw] : [];

  DATA_COLUMNS.forEach((column, index) => {
    if (column.key in values) {
      /*
       * 「その他」欄だけ長い上限（LONG_CELL_MAX_LENGTH）でサニタイズする。
       * 画面の maxLength（CONTENT_FIELDS）と揃えてあるので、ここで初めて
       * 切り詰められることはない（上の maxLengthFor と同じ判定）。
       */
      row[index] = column.key === 'otherInformation'
        ? escapeLongCellText(values[column.key] ?? '')
        : escapeCellText(values[column.key] ?? '');
      return;
    }

    if (column.key === 'duplicateKey') {
      const duplicate = buildDuplicateKey({
        email: values.email,
        mobile: values.mobile,
        companyName: values.companyName,
        fullName: values.fullName,
      });

      row[index] = escapeCellText(duplicate.key);
      return;
    }

    /*
     * それ以外は raw のまま残す。**ただし raw がこの列より短い場合**
     * （Sheets は行末の空セルを省略して返す）、row[index] は未設定の
     * まま（sparse array の穴）になる。JSON.stringify() は穴を null に
     * 変換してしまい、書き戻す値に本来無いはずの null が混ざる。
     * Sheets の values.update は文字列以外の型を渡されると別の解釈を
     * しかねないため、ここで空文字へ正規化しておく。
     */
    if (row[index] === undefined) {
      row[index] = '';
    }
  });

  return row;
}

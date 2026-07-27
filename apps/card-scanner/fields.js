/*
 * 名刺1件を表す列の定義。
 *
 * この1か所だけが列順の情報源で、次のすべてがここを参照する。
 *   ・スプレッドシートの見出しと行（sheets-client.js）
 *   ・確認フォームの入力欄（script.js）
 *   ・パーサーの出力キー（card-parser.js）
 * 列を増やす・並べ替える・ラベルを変えるときは、このファイルだけを直す。
 *
 * ここに置かないもの:
 *   DOM操作 / fetch / 抽出ロジック / 文言以外のUI設定 / 値の計算
 *
 * ------------------------------------------------------------------
 * 列の種類（kind）
 * ------------------------------------------------------------------
 *   field  … 利用者が確認・修正する項目。フォームに入力欄を作る
 *   emails … メールアドレス。1項目が4列へ展開される特別扱い
 *   auto   … アプリが自動で決める項目。フォームには入力欄を作らない
 *             （カードID・日時・OCR本文・ハッシュ・判定キーなど）
 *
 * COLUMN_DEFS の並びがそのまま列順になる。
 * 列順を別の場所で組み立て直さないこと（二重定義は事故のもと）。
 * ------------------------------------------------------------------
 *
 * メールアドレスだけ扱いが違う:
 *   values.emails       … 文字列の配列（出現順）
 *   values.primaryEmail … メインに選んだ実値（インデックスでは持たない）
 * インデックスで持つと、途中の1件を削除したときにメインの指す先がずれる。
 */

/*
 * confidence は「その項目を正規表現でどこまで確実に取れるか」の静的な区分。
 * UI の注意表示と OCR信頼度の計算に使い、実行時に上書きしない。
 *
 *   high   … 書式が決まっており、ほぼ確実に取れる（メール・電話・郵便番号など）
 *   medium … 手がかりはあるが外れることがある（法人格を含む会社名・住所）
 *   low    … 原理的に安定しない（氏名・氏名かな・部署・役職）
 *
 * low の項目は、OCR が返す一続きのテキストからでは並び順だけで判別できない。
 * 「営業本部」「部長」「山田太郎」を確実に切り分ける手段は存在しないため、
 * 確認・修正画面を必須の要素として扱う。
 */
export const COLUMN_DEFS = Object.freeze([
  /* --- 識別と日時 --- */
  { key: 'cardId', label: 'カードID', kind: 'auto' },
  { key: 'createdAt', label: '登録日時', kind: 'auto' },
  { key: 'updatedAt', label: '更新日時', kind: 'auto' },
  { key: 'ocrAt', label: 'OCR実行日時', kind: 'auto' },
  { key: 'companyId', label: '会社ID', kind: 'auto' },

  /* --- 名刺の内容（利用者が確認・修正する） --- */
  { key: 'company', label: '会社名', kind: 'field', confidence: 'medium' },
  { key: 'department', label: '部署名', kind: 'field', confidence: 'low' },
  { key: 'title', label: '役職', kind: 'field', confidence: 'low' },
  { key: 'name', label: '氏名', kind: 'field', confidence: 'low' },
  { key: 'nameKana', label: '氏名かな', kind: 'field', confidence: 'low' },
  { key: 'emails', label: 'メールアドレス', kind: 'emails', confidence: 'high' },
  { key: 'tel', label: '電話番号', kind: 'field', confidence: 'high' },
  { key: 'mobile', label: '携帯電話', kind: 'field', confidence: 'high' },
  { key: 'fax', label: 'FAX', kind: 'field', confidence: 'high' },
  { key: 'postalCode', label: '郵便番号', kind: 'field', confidence: 'high' },
  { key: 'address', label: '住所', kind: 'field', confidence: 'medium' },
  { key: 'website', label: 'Webサイト', kind: 'field', confidence: 'high' },
  { key: 'socialUrl', label: 'SNS・その他URL', kind: 'field', confidence: 'high' },
  { key: 'tags', label: 'タグ', kind: 'field', confidence: 'low' },
  { key: 'assignee', label: '担当者', kind: 'field', confidence: 'low' },
  { key: 'note', label: '備考', kind: 'field', confidence: 'low' },

  /* --- 画像とOCRの記録 --- */
  { key: 'frontImageUrl', label: '表面画像URL', kind: 'auto' },
  { key: 'backImageUrl', label: '裏面画像URL', kind: 'auto' },
  { key: 'frontOcr', label: '表面OCR', kind: 'auto' },
  { key: 'backOcr', label: '裏面OCR', kind: 'auto' },
  { key: 'mergedOcr', label: '統合OCR', kind: 'auto' },
  { key: 'ocrEngine', label: 'OCRエンジン', kind: 'auto' },
  { key: 'ocrConfidence', label: 'OCR信頼度', kind: 'auto' },
  { key: 'frontImageHash', label: '表面画像ハッシュ', kind: 'auto' },
  { key: 'backImageHash', label: '裏面画像ハッシュ', kind: 'auto' },
  { key: 'orientation', label: '名刺の向き', kind: 'auto' },
  { key: 'language', label: '言語', kind: 'auto' },
  { key: 'duplicateKey', label: '重複判定キー', kind: 'auto' },
]);

/* 確認フォームに入力欄を作る項目。card-parser.js の出力キーでもある。 */
export const FIELDS = Object.freeze(COLUMN_DEFS.filter((column) => column.kind === 'field'));

/* メールの列。並びを変えるときは emailsToColumns も一緒に直す。 */
export const EMAIL_HEADERS = Object.freeze([
  'メインメールアドレス',
  'メールアドレス2',
  'メールアドレス3',
  'その他メールアドレス',
]);

/* 個別の列を持つメールの件数（4件目以降は最後の列へまとめる）。 */
export const EMAIL_COLUMN_SLOTS = 3;

/*
 * スプレッドシートの見出し行。列順は COLUMN_DEFS が唯一の定義で、
 * ここでは展開しているだけ。全36列（メールが1項目 → 4列になる）。
 */
export const SHEET_HEADERS = Object.freeze(
  COLUMN_DEFS.flatMap((column) => (
    column.kind === 'emails' ? [...EMAIL_HEADERS] : [column.label]
  )),
);

/* 読み書きする範囲。列数から自動で決める（A1形式の終端列）。 */
function toColumnLetter(index) {
  let n = index + 1;
  let out = '';

  while (n > 0) {
    const remainder = (n - 1) % 26;
    out = String.fromCharCode(65 + remainder) + out;
    n = Math.floor((n - 1) / 26);
  }

  return out;
}

export const LAST_COLUMN_LETTER = toColumnLetter(SHEET_HEADERS.length - 1);
export const SHEET_RANGE = `A:${LAST_COLUMN_LETTER}`;

/* 列ラベル → 0始まりの位置。既存行を読むときに使う。 */
export const COLUMN_INDEX = Object.freeze(
  SHEET_HEADERS.reduce((map, label, index) => {
    map[label] = index;
    return map;
  }, {}),
);

/* 項目キー → confidence 区分。OCR信頼度の計算へ渡す。 */
export const CONFIDENCE_BY_KEY = Object.freeze(
  COLUMN_DEFS.reduce((map, column) => {
    if (column.confidence) {
      map[column.key] = column.confidence;
    }
    return map;
  }, {}),
);

/* 入力欄の種類。指定が無い項目は1行のテキスト入力にする。 */
export const FIELD_INPUT_TYPES = Object.freeze({
  postalCode: { inputMode: 'numeric', autocomplete: 'postal-code' },
  tel: { inputMode: 'tel', type: 'tel', autocomplete: 'tel' },
  mobile: { inputMode: 'tel', type: 'tel' },
  fax: { inputMode: 'tel', type: 'tel' },
  website: { type: 'url', inputMode: 'url' },
  socialUrl: { type: 'url', inputMode: 'url' },
  address: { multiline: true },
  /* タグはカンマ区切りでも改行区切りでも書けるようにする。 */
  tags: { multiline: true, placeholder: '展示会, 2026年度, 要フォロー' },
  note: { multiline: true },
});

/* ==================================================================
 * タグ
 * ================================================================== */

/* 保存時の区切り。読みやすさのためカンマ + 半角スペースで揃える。 */
export const TAG_SEPARATOR = ', ';

/*
 * 自由入力のタグを配列へ整える。
 * カンマ（半角・全角）と改行のどちらでも区切れる。
 * 前後の空白を落とし、重複を除き、入力順を保つ。
 */
export function parseTags(value) {
  const seen = new Set();
  const out = [];

  String(value ?? '')
    .split(/[,、\n\r]+/)
    .forEach((part) => {
      const tag = part.trim();

      if (tag === '' || seen.has(tag)) {
        return;
      }

      seen.add(tag);
      out.push(tag);
    });

  return out;
}

/* 配列を保存用の文字列へ戻す。 */
export function formatTags(tags) {
  return (Array.isArray(tags) ? tags : parseTags(tags)).join(TAG_SEPARATOR);
}

/* ==================================================================
 * メールの正規化と列への展開
 * 抽出・保存・重複判定のすべてがこの関数群を通る。
 * ================================================================== */

/* 比較用。大文字小文字と前後の空白だけを揃える（別名の同一視はしない）。 */
export function normalizeEmail(value) {
  return String(value ?? '').trim().toLowerCase();
}

/* 空を落とし、正規化して重複を除く。出現順は保つ。 */
export function dedupeEmails(list) {
  const seen = new Set();
  const out = [];

  (Array.isArray(list) ? list : []).forEach((item) => {
    const value = String(item ?? '').trim();
    const key = normalizeEmail(value);

    if (key === '' || seen.has(key)) {
      return;
    }

    seen.add(key);
    out.push(value);
  });

  return out;
}

/*
 * メインを先頭へ寄せた配列を返す。
 * primaryEmail が配列に無い（削除された等）場合は、元の先頭をメインとして扱う。
 */
export function orderEmails(emails, primaryEmail) {
  const list = dedupeEmails(emails);
  const primary = normalizeEmail(primaryEmail);

  if (primary === '') {
    return list;
  }

  const index = list.findIndex((item) => normalizeEmail(item) === primary);

  if (index <= 0) {
    return list;
  }

  return [list[index], ...list.slice(0, index), ...list.slice(index + 1)];
}

/*
 * 4つの列へ展開する。
 * 戻り値の並びは EMAIL_HEADERS と同じ。4件目以降は最後の列へ改行区切りで入れる。
 */
export function emailsToColumns(emails, primaryEmail) {
  const ordered = orderEmails(emails, primaryEmail);
  const columns = [];

  for (let i = 0; i < EMAIL_COLUMN_SLOTS; i += 1) {
    columns.push(ordered[i] ?? '');
  }

  columns.push(ordered.slice(EMAIL_COLUMN_SLOTS).join('\n'));

  return columns;
}

/*
 * 4つの列から配列へ戻す。既存行との突き合わせに使う。
 * 最後の列は改行・カンマ・空白のいずれで区切られていても受け付ける。
 */
export function columnsToEmails(cells) {
  const list = [];

  (Array.isArray(cells) ? cells : []).forEach((cell, index) => {
    const text = String(cell ?? '');

    if (index < EMAIL_COLUMN_SLOTS) {
      list.push(text);
      return;
    }

    text.split(/[\n,、;\s]+/).forEach((part) => list.push(part));
  });

  return dedupeEmails(list);
}

/* ==================================================================
 * 初期値
 * ================================================================== */

/*
 * 入力項目のキーをすべて空で持つオブジェクトを作る。
 * パーサーと画面の初期値に使う。メールだけ配列と実値の2つを持つ。
 * auto 列は保存時に組み立てるため、ここには含めない。
 */
export function createEmptyValues() {
  const values = {};

  FIELDS.forEach((field) => {
    values[field.key] = '';
  });

  values.emails = [];
  values.primaryEmail = '';

  return values;
}

/* すべてのキーを false で持つオブジェクト。matched の初期値に使う。 */
export function createEmptyMatched() {
  const matched = {};

  FIELDS.forEach((field) => {
    matched[field.key] = false;
  });

  matched.emails = false;

  return matched;
}

/*
 * フォーム上部に一度だけ出す案内。
 *
 * 備考（note）・タグ・担当者も confidence: 'low' だが、これらは自動入力の対象では
 * ないため、この文には含めない。推測が外れる項目だけを名指しする。
 */
export const LOW_CONFIDENCE_NOTICE = '氏名・氏名かな・部署名・役職は読み取り精度が低いため、必ずご確認ください。';

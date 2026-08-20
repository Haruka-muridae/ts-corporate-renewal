/*
 * 台帳へ書く値の無害化。
 *
 * ==================================================================
 * 複製元
 * ==================================================================
 * ../card-ocr/sanitize.js を複製（2026-08-20）。**import はしない**
 * （docs/repository-structure.md §4-1）。card-ocr の台帳（名刺管理）を
 * 直接編集するため、サニタイズの規則を1文字も変えずに合わせる必要がある。
 * ==================================================================
 *
 * ==================================================================
 * ここが唯一の防御である
 * ==================================================================
 * 台帳は USER_ENTERED で書かれている（card-ocr 要件書 §11.2 の
 * =HYPERLINK() を維持するため。card-ocr/sheets.js）。したがって
 * 数式インジェクションへの防御は**このアポストロフィだけ**である。
 * ここを迂回して台帳へ書く経路を作らないこと。
 *
 * 数式インジェクションは、利用者が自分のシートを開いた瞬間に動くもので、
 * 当社のサーバーには届かない。だから軽い問題ではなく、
 * むしろこちらからは気づけない問題である。
 * ==================================================================
 */

/*
 * 表計算ソフトが数式として解釈しはじめる文字。
 *
 * タブと復帰を含めるのは、これらがセルの区切りとして解釈され、
 * 1つの値が複数セルへ散る（＝先頭が別の文字になる）ことがあるため。
 */
const FORMULA_HEAD = /^[=+\-@\t\r]/;

/* 通常の項目。名刺1枚ぶんの1項目としては十分に長い。 */
export const SHORT_CELL_MAX_LENGTH = 1000;

/* 長くなる値（その他欄など）。 */
export const LONG_CELL_MAX_LENGTH = 50000;

function truncate(value, max) {
  return value.length > max ? value.slice(0, max) : value;
}

/*
 * 台帳のセルへ入れる値にする。
 *
 * **戻り値は必ず文字列。** null や undefined を空文字にするのは、
 * Sheets が undefined を受け取ると列がずれるため。
 */
export function escapeCellText(value, maxLength = SHORT_CELL_MAX_LENGTH) {
  if (value === null || value === undefined) {
    return '';
  }

  const text = truncate(String(value), maxLength);

  return FORMULA_HEAD.test(text) ? `'${text}` : text;
}

/* 「その他」欄のように長い値。上限だけが違う。 */
export function escapeLongCellText(value) {
  return escapeCellText(value, LONG_CELL_MAX_LENGTH);
}

/*
 * シートから読んだ値を、比べられる形へ戻す（escapeCellText の逆）。
 *
 * ==================================================================
 * なぜ必要か
 * ==================================================================
 * 更新（FR-17・FR-18）では、いまシートに入っている値と、これから
 * 書く値を突き合わせて差分を出す。書く側は escapeCellText を
 * 通っているため `+81…` が `'+81…` になっている。素で比べると、
 * 何も変えていない項目まで「変更あり」になる。
 *
 * 落とすのは「アポストロフィ＋数式の始まり文字」の並びだけである。
 * `'` で始まるだけの値（人名の `'t Hooft` など）は触らない。
 * escapeCellText が付けた印だけを、正確に剥がす。
 * ==================================================================
 */
export function unescapeCellText(value) {
  const text = String(value ?? '');

  return /^'[=+\-@\t\r]/.test(text) ? text.slice(1) : text;
}

/*
 * 画像へのリンクは**こちらが組み立てる数式**（card-ocr と同じ関数）。
 *
 * **このアプリでは実際には呼ばない。** frontFileUrl / backFileUrl は
 * card-ocr が書いた生セル（=HYPERLINK(...)）をそのまま書き戻す
 * （manager-client.js・records.js）。schema.js の buildDataRow が
 * import する対称性のためだけに、複製元と同じ形で残してある。
 *
 * card-ocr 要件書 §11.2 が `=HYPERLINK()` を要求しており、これは利用者の入力ではない。
 * したがって上のサニタイズは通さない。**ただしURLはこちらで検証する。**
 * URL が Google ドライブのものでなければ数式を作らず、空文字を返す。
 */
export function buildImageLink(url, label) {
  const text = String(url ?? '');

  if (!/^https:\/\/(drive|docs)\.google\.com\//.test(text)) {
    return '';
  }

  /* Sheets の文字列リテラルでは " を "" にする。 */
  const quotedUrl = text.replace(/"/g, '""');
  const quotedLabel = String(label ?? '').replace(/"/g, '""');

  return `=HYPERLINK("${quotedUrl}","${quotedLabel}")`;
}

/*
 * ファイル名に使えない記号を落とす。card-ocr と同じ規則
 * （現状このアプリはファイルを作らないため未使用だが、複製元との
 * 差分を最小にするため残してある）。
 */
export function sanitizeFileNamePart(value, maxLength = 40) {
  const text = String(value ?? '')
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  return truncate(text, maxLength);
}

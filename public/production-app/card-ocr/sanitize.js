/*
 * 台帳へ書く値の無害化（要件定義書 §FR-18）。
 *
 * ==================================================================
 * 複製元
 * ==================================================================
 * public/production-app/card-ocr/poc/sanitize.js（2026-08-04）と、
 * ../receipt-ocr/sheets.js の escapeFormula を突き合わせて作った。
 * その元は public/apps/card-scanner/sheets-client.js の escapeCellText。
 * **どこからも import はしない**（docs/repository-structure.md §4-1）。
 *
 * PoC から変えたところ:
 *   - 対象文字に**タブと復帰**を足した（領収書OCR側が広かった）
 * ==================================================================
 *
 * ==================================================================
 * ここが唯一の防御である（領収書OCRとは条件が違う）
 * ==================================================================
 * 領収書OCRは valueInputOption='RAW' で書いており、そもそも数式が
 * 評価されない。アポストロフィと合わせて2枚重ねになっている。
 *
 * **名刺OCRでは RAW を使えない。** §11.2 が画像リンクを
 * `=HYPERLINK()` でクリックできる形にすることを要求しており、
 * RAW にすると数式が文字列のまま残るためである（sheets.js）。
 *
 * したがって書き込みは USER_ENTERED で行い、**このアポストロフィが
 * 唯一の防御になる。** 弱くなったのではなく、**より重要になった。**
 * ここを迂回して台帳へ書く経路を作らないこと。
 *
 * 数式インジェクションは、利用者が自分のシートを開いた瞬間に
 * 動くもので、当社のサーバーには届かない。だから軽い問題では
 * なく、むしろこちらからは気づけない問題である。
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

/* OCR本文など、長くなる値。 */
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

/* OCR本文のように長い値。上限だけが違う。 */
export function escapeOcrText(value) {
  return escapeCellText(value, LONG_CELL_MAX_LENGTH);
}

/*
 * シートから読んだ値を、比べられる形へ戻す（escapeCellText の逆）。
 *
 * ==================================================================
 * なぜ必要か
 * ==================================================================
 * 更新（FR-17・FR-18）では、**いまシートに入っている値と、これから
 * 書く値を突き合わせて差分を出す。** 書く側は escapeCellText を
 * 通っているため `+81…` が `'+81…` になっている。素で比べると、
 * **何も変えていない項目まで「変更あり」になる。**
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
 * 画像へのリンクは**こちらが組み立てる数式**である。
 *
 * §11.2 が `=HYPERLINK()` を要求しており、これは利用者の入力ではない。
 * したがって上のサニタイズは通さない。**ただしURLはこちらで検証する。**
 * 素通しにすると、URLの側から数式を壊されうる。
 *
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
 * ファイル名に使えない記号を落とす（§FR-07）。
 *
 * Drive 自体はほとんどの文字を許すが、利用者が端末へ書き出したときに
 * 困るのはこちらの都合ではない。Windows で使えない記号を基準にする。
 *
 * ハイフンと空白は残す。社名にごく普通に現れるため。
 * 改行とタブは空白1つへ畳む（\s+ がまとめて拾う）。
 */
export function sanitizeFileNamePart(value, maxLength = 40) {
  const text = String(value ?? '')
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  return truncate(text, maxLength);
}

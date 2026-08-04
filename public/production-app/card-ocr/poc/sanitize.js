/*
 * スプレッドシートへ入れる値の保護。
 *
 * ==================================================================
 * 複製元
 * ==================================================================
 * public/apps/card-scanner/sheets-client.js の escapeCellText /
 * escapeOcrText を複製したもの。**import はしない。**
 *
 * `/apps/` はテスト環境であり、本番アプリからテスト環境のコードへ
 * 依存を作らない（docs/repository-structure.md §2-1、
 * docs/specs/meishi-ocr-requirements-v3.md §3）。
 * テスト環境はいつ壊れてもよい前提の場所なので、そこへ線を伸ばすと
 * 本番が巻き添えになる。重複は承知のうえで複製する。
 *
 * 複製元との違い:
 *   - ログ出力を持たない（検証ページには不要）
 *   - 上限値の名前を要件定義書 §FR-18 の用語へ寄せた
 * ==================================================================
 */

/* 通常の文字列セルの上限。 */
export const SHORT_CELL_MAX_LENGTH = 1000;

/* OCR本文セルの上限。Sheets の1セルの上限に合わせてある。 */
export const CELL_MAX_LENGTH = 50000;

const TRUNCATED_SUFFIX = '…';

/*
 * 数式として解釈されうるセルを、文字列として入れるための保護。
 *
 * 送信は valueInputOption=USER_ENTERED で行うため、= + - @ で始まる値は
 * Sheets が数式と解釈する。先頭にアポストロフィを付けると、
 * 表示は元のまま文字列として入る。
 *
 * 守る対象は**利用者自身のスプレッドシート**である（要件定義書 §14.3）。
 * 当社にデータは無いが、利用者のシートが壊れることは防ぐ。
 */
export function escapeCellText(value, maxLength = SHORT_CELL_MAX_LENGTH) {
  let text = String(value ?? '');

  if (text === '') {
    return '';
  }

  if (text.length > maxLength) {
    text = text.slice(0, Math.max(0, maxLength - TRUNCATED_SUFFIX.length)) + TRUNCATED_SUFFIX;
  }

  return /^[=+\-@]/.test(text) ? `'${text}` : text;
}

/* OCR本文用。上限だけが違う。 */
export function escapeOcrText(value) {
  return escapeCellText(value, CELL_MAX_LENGTH);
}

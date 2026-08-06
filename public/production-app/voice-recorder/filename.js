/*
 * Drive へ保存するときのファイル名（要件書 §FR-07）。
 *
 * OPFS 上の一時ファイル名（recorder/opfs-storage.js の buildPartName）とは別物。
 * あちらは端末内の作業ファイル、こちらは利用者の目に触れる保存名である。
 *
 * 同名時の連番（_2, _3…）は保存先の状況が要るため、ここではなく
 * Drive へ問い合わせる側（drive.js）で決める。ここは純粋な文字列処理だけを持つ。
 */

import { FILE_EXTENSION, FILE_NAME_SUFFIX } from './config.js';

/*
 * 初期値：YYYYMMDD_HHmmss_録音.mp3
 * 基準は録音開始時刻・ブラウザのローカル日時（§FR-07）。
 * UTC ではないので、利用者の手元の時計と一致する。
 */
export function buildDefaultFileName(date) {
  const p2 = (n) => String(n).padStart(2, '0');
  const stamp = `${date.getFullYear()}${p2(date.getMonth() + 1)}${p2(date.getDate())}`
    + `_${p2(date.getHours())}${p2(date.getMinutes())}${p2(date.getSeconds())}`;
  return `${stamp}${FILE_NAME_SUFFIX}${FILE_EXTENSION}`;
}

/* 拡張子が無ければ付ける。大文字の .MP3 も拡張子ありとみなす。 */
export function ensureExtension(name) {
  return name.toLowerCase().endsWith(FILE_EXTENSION) ? name : `${name}${FILE_EXTENSION}`;
}

/*
 * ファイル名に使えない文字を落とす。
 *
 * 落とすのは制御文字とパス区切り（/ と \）だけにする。
 * Drive 自体はスラッシュを含む名前も受け付けるが、利用者から見ると
 * フォルダ階層と紛らわしく、ダウンロード時にも扱いづらい。
 *
 * **記号や空白まで落とさないこと。** ドットを落とすと拡張子が壊れ、
 * 空白を落とすと利用者が付けた区切りが消える。
 */
function stripUnsafe(name) {
  const out = [];

  for (const ch of String(name)) {
    const code = ch.codePointAt(0);
    const isControl = code < 0x20 || code === 0x7f;
    if (!isControl && ch !== '/' && ch !== '\\') {
      out.push(ch);
    }
  }

  return out.join('').trim();
}

/*
 * 入力欄の値から保存名を決める。
 * 未入力（空白のみを含む）のときは初期値を使う（§FR-07）。
 */
export function resolveFileName(input, fallback) {
  const cleaned = stripUnsafe(input ?? '');
  return ensureExtension(cleaned === '' ? fallback : cleaned);
}

/*
 * 連番を付けた候補名を作る。`名前.mp3` → `名前_2.mp3`
 * 拡張子の前に入れる。末尾へ付けると拡張子が消えるため。
 */
export function withSequence(name, sequence) {
  if (sequence <= 1) {
    return name;
  }

  const dot = name.lastIndexOf('.');

  if (dot <= 0) {
    return `${name}_${sequence}`;
  }

  return `${name.slice(0, dot)}_${sequence}${name.slice(dot)}`;
}

/*
 * 保存名の組み立て（仕様書 §4-2）。
 *
 * ------------------------------------------------------------------
 * 移植元と複製の理由
 * ------------------------------------------------------------------
 * public/production-app/voice-recorder/filename.js からの複製（2026-08-19）。
 * 同じ Drive フォルダへ並べて置くファイルなので、日時部分の書式
 * （YYYYMMDD_HHmmss）・サニタイズの方針・連番の付け方を1文字も違えないため
 * 複製している。
 *
 * import ではなく複製にしているのは、本番アプリ同士を相互参照しないという
 * 流儀（voice-recorder/config.js の DRIVE_NAMES コメント、
 * docs/repository-structure.md §1）による。
 *
 * v1.1 では label / resolveFileName / ensureExtension を「入力欄が無いから」
 * という理由で削っていたが、**v1.2 で入力欄を付けたため複製元から復元した**。
 * サニタイズ（制御文字と / \ だけを落とす）も複製元のまま戻してある。
 *
 * ------------------------------------------------------------------
 * 複製元と挙動が違う唯一の点：label を入れても接尾辞を残す
 * ------------------------------------------------------------------
 * voice-recorder は label を入れると接尾辞（`_録音`）を **置き換える**。
 *   voice-recorder : 20260819_143000_田中様.mp3
 *   このアプリ     : 20260819_143000_田中様_面談録音.mp3
 *
 * 置き換え方式を採らなかったのは、`_面談録音` が「同じ Voice Recorder
 * フォルダの中で、どちらのアプリの録音かを見分ける唯一の目印」だからである
 * （§4-2）。置き換えると、相手名を入れた面談録音と、お客様名を入れた
 * ブラウザ録音が **どちらも `20260819_143000_田中様.mp3` になり区別できない**。
 * label の入る位置（日時の直後）は複製元と同じにしてある。
 * ------------------------------------------------------------------
 *
 * 複製元に無く、こちらだけにあるもの:
 *   - withExtension（拡張子の差し替え）
 * WebM 安全網と記録情報 JSON のローカル保存名を、利用者が編集した MP3 の
 * 名前と同じベース名に揃えるために要る（§4-2）。
 * あとから見て「同じ録音の3ファイル」と分かるようにする。
 *
 * 同名時の連番（_2, _3…）は保存先の状況が要るため、ここではなく
 * Drive へ問い合わせる側（drive.js）で決める。ここは純粋な文字列処理だけを持つ。
 */

import { FILE_EXTENSION, FILE_NAME_SUFFIX } from './config.js';

/*
 * 初期値：YYYYMMDD_HHmmss_面談録音.mp3
 *
 * 基準は録音開始時刻・**ブラウザのローカル日時**。
 * voice-recorder（§FR-07「ブラウザ日時基準」）と同じ扱いにしてある。
 * Intl で Asia/Tokyo へ固定変換しないのは、そうすると海外から使ったときに
 * 同じフォルダの中で voice-recorder の名前と時刻の基準がずれるためで、
 * 「揃える」という目的に反する。国内で使う限り両者は一致する。
 *
 * label（「面談相手名」欄。§4-2）を渡すと、日時の直後へ `_<label>` を挟む
 * （例: `20260819_143000_田中様_面談録音.mp3`）。
 * label が空（未入力・サニタイズ後に空）のときは日時＋接尾辞だけになる。
 */
export function buildDefaultFileName(date, label) {
  const p2 = (n) => String(n).padStart(2, '0');
  const stamp = `${date.getFullYear()}${p2(date.getMonth() + 1)}${p2(date.getDate())}`
    + `_${p2(date.getHours())}${p2(date.getMinutes())}${p2(date.getSeconds())}`;
  const cleanedLabel = stripUnsafe(label ?? '');
  const middle = cleanedLabel === '' ? '' : `_${cleanedLabel}`;
  return `${stamp}${middle}${FILE_NAME_SUFFIX}${FILE_EXTENSION}`;
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
 * 未入力（空白のみ、またはサニタイズ後に空）のときは初期値を使う（§4-2）。
 */
export function resolveFileName(input, fallback) {
  const cleaned = stripUnsafe(input ?? '');
  return ensureExtension(cleaned === '' ? fallback : cleaned);
}

/*
 * 拡張子だけを差し替える。`名前.mp3` → `名前.webm` / `名前.json`
 *
 * 利用者が編集した MP3 の名前を基準にするため、ここで stem を取り直す
 * （編集後の名前から作らないと、WebM と JSON だけ旧い名前になる）。
 * 拡張子が無い名前はそのまま stem として扱う。
 */
export function withExtension(name, extension) {
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  return `${stem}${extension}`;
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

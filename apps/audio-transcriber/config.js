/*
 * 音声文字起こしアプリの設定値。
 *
 * モデルID・分割時間・上限サイズなどを書き換える場所は、このファイル1か所だけにする。
 * 他のファイルへ直接埋め込まないこと（変更漏れの原因になる）。
 *
 * ------------------------------------------------------------------
 * このリポジトリへ絶対に入れてはならないもの
 * ------------------------------------------------------------------
 * Gemini APIキー / Google APIキー / client secret / アクセストークン。
 * Gemini APIキーは利用者が画面で入力し、JavaScriptのメモリ上だけで保持する。
 * この設定ファイルにキーを書く欄は「意図的に存在しない」。
 * ------------------------------------------------------------------
 */

/* ---------- 対応する音声形式 ---------- */

/*
 * input[type=file] の accept と、拡張子・MIMEの事前判定に使う。
 * ここに無い形式でも、ブラウザがデコードできれば最終的には通す
 * （判定は audio-loader.js が「実際にデコードできたか」を最終根拠にする）。
 */
export const AUDIO_EXTENSIONS = Object.freeze([
  '.mp3', '.wav', '.m4a', '.aac', '.ogg', '.oga', '.webm', '.flac',
]);

/* Drive の一覧・Picker で選択対象にするMIME。 */
export const AUDIO_MIME_TYPES = Object.freeze([
  'audio/mpeg',
  'audio/wav',
  'audio/x-wav',
  'audio/mp4',
  'audio/aac',
  'audio/ogg',
  'audio/webm',
  'audio/flac',
]);

/* accept 属性は「拡張子 + MIME」の両方を並べる（環境によってどちらかしか効かない）。 */
export const FILE_ACCEPT = [...AUDIO_EXTENSIONS, ...AUDIO_MIME_TYPES, 'audio/*'].join(',');

/* ---------- サイズ・長さの上限 ---------- */

export const LIMITS = Object.freeze({
  /*
   * 端末内モードの上限。
   * デコード後の PCM は「秒数 × 16000 × 4バイト」までメモリに載るため、
   * 元ファイルのサイズだけでなく長さでも止める。
   */
  localMaxBytes: 512 * 1024 * 1024,
  localMaxDurationSec: 4 * 60 * 60,

  /*
   * Gemini Files API の上限。
   * 1ファイル2GBまでだが、ブラウザからの単発アップロードとしては大きすぎるため
   * 現実的な値に絞る。無料枠の消費を抑える意味もある。
   */
  geminiMaxBytes: 200 * 1024 * 1024,
  geminiMaxDurationSec: 2 * 60 * 60,
});

/* ---------- 端末内AI（Transformers.js / Whisper） ---------- */

export const WHISPER = Object.freeze({
  /*
   * 使用ライブラリ。バージョンは固定する（CDNの latest を指さない）。
   * 2026-07 時点の最新は 4.2.0。
   */
  libraryUrl: 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0/dist/transformers.min.js',

  /*
   * 既定モデル。
   *
   * whisper-small は多言語で精度が高いが、量子化しても 200MB 超で
   * スマートフォンでは初回ダウンロードが現実的でない。
   * whisper-base（多言語 / q8 で数十MB）を既定とし、
   * 精度を求める利用者は画面から whisper-small へ切り替えられるようにする。
   *
   * *.en 系は英語専用なので、日本語が既定のこのアプリでは候補に入れない。
   */
  defaultModelId: 'onnx-community/whisper-base',

  /* 画面のプルダウンに出す候補。ここに無いモデルは選べない。 */
  models: Object.freeze([
    {
      id: 'onnx-community/whisper-tiny',
      label: '軽量（tiny）',
      note: '最速。ダウンロード量が最小。精度は低め',
    },
    {
      id: 'onnx-community/whisper-base',
      label: '標準（base）',
      note: '既定。速度と精度のつり合いが良い',
    },
    {
      id: 'onnx-community/whisper-small',
      label: '高精度（small）',
      note: '精度は高いがダウンロードが大きく、低性能端末では重い',
    },
  ]),

  /*
   * 量子化の種別。
   * q8 は onnx-community の Whisper に必ず用意されている。
   * 実ファイルは onnx/encoder_model_quantized.onnx などで、実在を確認済み。
   * fp32 は大きく、速度も出ないため使わない。
   */
  dtype: 'q8',

  /*
   * WASM で実行するときだけ渡す ONNX Runtime の設定。
   *
   * 既定の graphOptimizationLevel（'all'）のままだと、Whisper の
   * decoder_model_merged を読む段階で ONNX Runtime が必ず失敗する。
   *
   *   Can't create a session. ERROR_CODE: 1,
   *   qdq_actions.cc:137 TransposeDQWeightsForMatMulNBits
   *   Missing required scale: model.decoder.embed_tokens.weight_merged_0_scale
   *
   * これは dtype やモデルの選び方の問題ではない。
   * 実ブラウザで q8 / int8 / uint8 / q4 / fp32 のすべて、
   * onnx-community と Xenova の tiny / base すべてで同じ失敗を確認した。
   * Transformers.js 4.2.0 が同梱する ONNX Runtime のグラフ最適化の不具合である。
   *
   * 'basic' まで下げると読み込みも推論も通る。'disabled' でも通るが、
   * 実測で3倍近く遅くなったため 'basic' を採用する。
   * WebGPU は既定のままで問題なく動くので、この設定は WASM にだけ渡す。
   */
  wasmSessionOptions: Object.freeze({ graphOptimizationLevel: 'basic' }),

  /*
   * 長時間音声の分割時間（秒）。
   * 30秒はWhisperの入力長そのもの。それより長い塊を一度に渡すと
   * ライブラリ側が内部で切るため、メモリのピークを制御できない。
   * ここでは「メモリ上で扱う塊」の大きさとして扱う。
   */
  chunkSeconds: 30,

  /* 分割の境目で語が切れないよう、前後を重ねる秒数。 */
  chunkOverlapSeconds: 5,

  /*
   * 一度に Worker へ渡す塊の長さ（秒）。
   * これを超える音声は、この長さごとに区切って順番に処理し、結果を連結する。
   */
  segmentSeconds: 5 * 60,

  /* Whisper が想定するサンプリングレート。変更不可。 */
  sampleRate: 16000,
});

/* 言語の選択肢。value は Whisper / Gemini 双方へ渡す共通の値。 */
export const LANGUAGES = Object.freeze([
  { value: 'ja', label: '日本語' },
  { value: 'en', label: '英語' },
  { value: 'auto', label: '自動判定' },
]);

export const DEFAULT_LANGUAGE = 'ja';

/* ---------- Gemini API ---------- */

export const GEMINI = Object.freeze({
  apiBase: 'https://generativelanguage.googleapis.com',
  apiVersion: 'v1beta',

  /*
   * モデルの候補。先頭から順に試し、404 / 400（未対応）なら次へ落とす。
   *
   * 決め打ちにしないための仕組み:
   *   1. 利用者のキーで models.list を呼び、実際に使えるモデルを確認する
   *   2. 一覧が取れなければ、この配列の順に総当たりする
   *
   * 2026-07 時点で音声入力に対応し無料枠のある Flash 系を、新しい順に並べる。
   */
  models: Object.freeze([
    { id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash（推奨）' },
    { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash' },
    { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
  ]),

  /* 画面の初期選択。'auto' なら models.list の結果から自動で選ぶ。 */
  defaultModelId: 'auto',

  /* アップロード完了待ちの間隔と上限。 */
  pollIntervalMs: 2000,
  pollTimeoutMs: 10 * 60 * 1000,

  /* APIキーの取得先。別タブで開く。 */
  apiKeyUrl: 'https://aistudio.google.com/apikey',
});

/*
 * 文字起こしの指示文。
 * 要約させないこと、聞き取れない箇所を明示させることが目的。
 */
export const TRANSCRIPTION_PROMPT = `この音声を、聞こえた内容に忠実に日本語で文字起こししてください。

要件:
- 内容を要約しない
- 発言を勝手に補完しない
- 聞き取れない箇所は「[聞き取り不能]」と記載する
- 明らかな言い直しやフィラーを過度に削除しない
- 複数の話者を識別できる場合は「話者1」「話者2」のように区別する
- 可能な範囲でタイムスタンプを付ける
- Markdownの説明文は付けず、文字起こし本文のみ返す`;

/* ---------- Google Drive ---------- */

export const DRIVE = Object.freeze({
  /*
   * Google Picker のブラウザ用APIキーは **このファイルには置かない**。
   *
   * 実キーは picker-key.local.js（.gitignore 済み）にだけ置き、
   * drive-picker.js が動的 import で読む。
   * 名刺スキャナ（apps/card-scanner/）と同じ方式にそろえてある。
   * 手順は picker-key.local.example.js を参照する。
   *
   * キーが無い場合は Picker を読み込まず、
   * Drive API の files.list によるアプリ内一覧へ自動的に切り替わる。
   */

  /*
   * OAuthクライアントIDの先頭の数字部分＝Google Cloud のプロジェクト番号。
   * 公開情報であり秘密ではない。
   * drive.file スコープで Picker 選択後も継続してアクセスするために必要で、
   * これが無いと選択直後は読めても、次のセッションで403になることがある。
   */
  pickerAppId: '603018562548',

  /*
   * フォルダ名は ../drive-folders.js で一元管理する（録音アプリと共有）。
   * ここには持たない。フォルダIDも持たない（利用者ごとに異なるため）。
   */

  /* files.list の1ページあたりの件数。 */
  listPageSize: 100,

  /* ページ送りの上限。暴走を防ぐための歯止め。 */
  maxListPages: 10,
});

/* ---------- 表示 ---------- */

/* 1024 区切りで読みやすい単位へ直す。 */
export function formatBytes(bytes) {
  const value = Number(bytes);

  if (!Number.isFinite(value) || value < 0) {
    return '不明';
  }

  if (value < 1024) {
    return `${value} B`;
  }

  const units = ['KB', 'MB', 'GB'];
  let size = value / 1024;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  return `${size.toFixed(size >= 100 ? 0 : 1)} ${units[unitIndex]}`;
}

/* 秒 → H:MM:SS もしくは M:SS。 */
export function formatDuration(seconds) {
  const total = Math.round(Number(seconds));

  if (!Number.isFinite(total) || total < 0) {
    return '不明';
  }

  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const pad = (value) => String(value).padStart(2, '0');

  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${minutes}:${pad(secs)}`;
}

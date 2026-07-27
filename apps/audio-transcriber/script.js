/*
 * 音声文字起こしアプリの UI 層。
 *
 * 担当するのは「DOMの更新」「利用者の操作の受け取り」「文言」の3つだけ。
 * 音声処理・API呼び出し・認可のロジックは各モジュールへ置く。
 *
 * ------------------------------------------------------------------
 * APIキーの扱い（このファイルで最も重要な点）
 * ------------------------------------------------------------------
 * 入力されたキーは、下の apiKey 変数（このモジュールのクロージャ）だけに置く。
 *
 *   input.value からは毎回読み直さず、変数へ写して使う
 *   → data属性・localStorage・sessionStorage・Cookie・URLへは書かない
 *   → console へも出さない。エラー文言にも混ぜない
 *   → ページを閉じる／再読み込みすれば、変数ごと消える
 *
 * この方針を崩す変更（「次回も使えるように保存」など）を安易に入れないこと。
 * ------------------------------------------------------------------
 *
 * 外部由来の文字列（ファイル名・Driveの表示名・APIの応答）は、
 * すべて textContent か フォーム値として扱う。innerHTML は使わない。
 */

import {
  DEFAULT_LANGUAGE,
  FILE_ACCEPT,
  GEMINI,
  LANGUAGES,
  LIMITS,
  WHISPER,
  formatBytes,
  formatDuration,
} from './config.js';

import { State, getState, isBusy, subscribe, transition, update } from './state.js';

import {
  AudioError,
  AudioErrorCode,
  looksLikeAudio,
  probeAudio,
} from './audio-loader.js';

import {
  DriveAuthError,
  DriveAuthErrorCode,
  ensureAccessToken,
  clearAccessToken,
} from '../drive-auth.js';

import { DRIVE_FOLDERS, formatFolderPath } from '../drive-folders.js';

import {
  DriveError,
  DriveErrorCode,
  downloadFile,
  findFoldersByName,
  getFileMetadata,
  listVoiceRecorderAudio,
  loadVoiceRecorderAudio,
  saveTranscriptText,
} from './drive-client.js';

/*
 * Google Picker はこのアプリの経路では使わない。
 *
 * 取得元は「端末」と「マイドライブ ＞ TSAM AI ＞ Voice Recorder」の2つに限定し、
 * Drive 側は Drive API でこの固定フォルダだけを見る。
 * drive-picker.js は将来ドライブ全体から選ばせたくなったときのために残してあるが、
 * 現在どこからも読み込んでいない（読み込むと CSP の追加が必要になる。
 * 詳細は drive-picker.js の冒頭を参照）。
 */

import { WhisperError, WhisperErrorCode, disposeWorker, transcribeBlob } from './whisper-transcriber.js';

import {
  GeminiError,
  GeminiErrorCode,
  transcribeWithGemini,
} from './gemini-transcriber.js';

import {
  buildTextFileName,
  copyText,
  countCharacters,
  downloadText,
  formatChunks,
  formatElapsed,
  replaceSpeakerName,
} from './result-exporter.js';

/* ============================================================
   文言
   ============================================================ */

const MODE_LABELS = Object.freeze({
  local: '完全無料・端末内処理',
  gemini: 'Gemini API',
});

/* 取得元の表示。Drive は「どのフォルダから来たか」まで見せる。 */
const SOURCE_LABELS = Object.freeze({
  local: 'この端末',
  drive: `Google Drive：${DRIVE_FOLDERS.root} ＞ ${DRIVE_FOLDERS.voiceRecorder}`,
});

/* 「マイドライブ ＞ TSAM AI ＞ Voice Recorder」 */
const VOICE_RECORDER_PATH = formatFolderPath(DRIVE_FOLDERS.root, DRIVE_FOLDERS.voiceRecorder);

const AUDIO_ERROR_MESSAGES = Object.freeze({
  [AudioErrorCode.NO_FILE]: '音声ファイルが選ばれていません。',
  [AudioErrorCode.UNSUPPORTED_TYPE]:
    'このファイルは音声として読み込めませんでした。MP3・WAV・M4A・AAC・OGG・WebM・FLACのいずれかをお試しください。',
  [AudioErrorCode.DECODE_FAILED]:
    '音声の解析に失敗しました。このブラウザが対応していない形式の可能性があります。MP3またはWAVへ変換してからお試しください。',
  [AudioErrorCode.EMPTY_AUDIO]: '音声データが含まれていないようです。別のファイルをお試しください。',
  [AudioErrorCode.TOO_LARGE]: 'ファイルサイズが上限を超えています。分割してからお試しください。',
  [AudioErrorCode.TOO_LONG]: '音声が長すぎます。分割してからお試しください。',
  [AudioErrorCode.OUT_OF_MEMORY]:
    'メモリが不足しました。他のタブを閉じるか、短い音声に分割してからお試しください。',
  [AudioErrorCode.CANCELLED]: '処理を中止しました。',
  [AudioErrorCode.UNKNOWN]: '音声ファイルの読み込みに失敗しました。',
});

const AUTH_ERROR_MESSAGES = Object.freeze({
  [DriveAuthErrorCode.CLIENT_ID_MISSING]:
    'Googleドライブ連携が設定されていません。管理者へお問い合わせください。',
  [DriveAuthErrorCode.NOT_SIGNED_IN]: 'Googleへログインしてからお試しください。',
  [DriveAuthErrorCode.GIS_LOAD_FAILED]:
    'Googleの認証機能を読み込めませんでした。通信環境を確認して、もう一度お試しください。',
  [DriveAuthErrorCode.POPUP_CLOSED]: 'Googleドライブへの接続が中断されました。',
  [DriveAuthErrorCode.POPUP_BLOCKED]:
    'ポップアップがブロックされました。ブラウザの設定でこのサイトのポップアップを許可してください。',
  [DriveAuthErrorCode.ACCESS_DENIED]: 'Googleドライブへの接続が許可されませんでした。',
  [DriveAuthErrorCode.SCOPE_NOT_GRANTED]:
    'Googleドライブの権限が許可されませんでした。もう一度お試しいただき、権限の確認画面で許可してください。',
  [DriveAuthErrorCode.UNKNOWN]: 'Googleドライブへの接続に失敗しました。',
});

const DRIVE_ERROR_MESSAGES = Object.freeze({
  [DriveErrorCode.UNAUTHORIZED]:
    'Googleドライブの利用許可の期限が切れました。「再読み込み」を押して、もう一度許可してください。',
  [DriveErrorCode.FORBIDDEN]:
    'Googleドライブへのアクセスが拒否されました。権限が足りないか、このアプリに許可されていないファイルの可能性があります。'
    + '音声録音アプリと同じGoogleアカウントでログインしているかご確認ください。',

  /* 固定フォルダの解決に固有のもの。 */
  [DriveErrorCode.ROOT_FOLDER_MISSING]:
    `Google Driveに「${VOICE_RECORDER_PATH}」フォルダが見つかりませんでした。`
    + '先に音声録音アプリで録音を保存してください。',
  [DriveErrorCode.APP_FOLDER_MISSING]:
    `Google Driveに「${VOICE_RECORDER_PATH}」フォルダが見つかりませんでした。`
    + '先に音声録音アプリで録音を保存してください。',
  [DriveErrorCode.ROOT_FOLDER_AMBIGUOUS]:
    `同じ場所に「${DRIVE_FOLDERS.root}」フォルダが複数見つかりました。`
    + '使用するフォルダを特定できません。下から選んでください。',
  [DriveErrorCode.APP_FOLDER_AMBIGUOUS]:
    `同じ場所に「${DRIVE_FOLDERS.voiceRecorder}」フォルダが複数見つかりました。`
    + '使用するフォルダを特定できません。下から選んでください。',
  [DriveErrorCode.NO_AUDIO_FILES]:
    `${DRIVE_FOLDERS.voiceRecorder}フォルダに音声ファイルがありません。`,

  [DriveErrorCode.API_DISABLED]:
    'Google Drive APIが有効になっていません。管理者へお問い合わせください。',
  [DriveErrorCode.QUOTA_EXCEEDED]: 'Googleドライブの空き容量が不足しています。',
  [DriveErrorCode.RATE_LIMITED]: 'アクセスが集中しています。しばらく待ってからお試しください。',
  [DriveErrorCode.NOT_FOUND]: '指定されたファイルが見つかりませんでした。',
  [DriveErrorCode.NETWORK]: '通信に失敗しました。ネットワークの状態を確認してください。',
  [DriveErrorCode.SERVER_ERROR]: 'Google側で問題が発生しています。しばらく待ってからお試しください。',
  [DriveErrorCode.CANCELLED]: '処理を中止しました。',
  [DriveErrorCode.UNKNOWN]: 'Googleドライブの処理に失敗しました。',
});

const WHISPER_ERROR_MESSAGES = Object.freeze({
  [WhisperErrorCode.WORKER_FAILED]:
    '端末内AIの起動に失敗しました。ページを再読み込みしてお試しください。',
  [WhisperErrorCode.MODEL_LOAD_FAILED]:
    'AIモデルを読み込めませんでした。通信環境を確認するか、より軽量なモデルを選んでお試しください。',
  /*
   * 通常は WASM での再挑戦に吸収されるため、ここまで来ることはない。
   * 万一表に出ても意味の通る文言にしておく。
   */
  [WhisperErrorCode.WEBGPU_FAILED]:
    'WebGPUを利用できませんでした。ページを再読み込みしてお試しください。',
  [WhisperErrorCode.MODEL_RUN_FAILED]:
    '端末内での文字起こしに失敗しました。より軽量なモデルを選ぶか、短い音声でお試しください。',
  [WhisperErrorCode.OUT_OF_MEMORY]:
    'メモリが不足しました。他のタブを閉じるか、より軽量なモデル・短い音声でお試しください。',
  [WhisperErrorCode.CANCELLED]: '処理を中止しました。',
  [WhisperErrorCode.UNKNOWN]: '端末内での文字起こしに失敗しました。',
});

const GEMINI_ERROR_MESSAGES = Object.freeze({
  [GeminiErrorCode.API_KEY_MISSING]: 'Gemini APIキーを入力してください。',
  [GeminiErrorCode.API_KEY_INVALID]:
    'APIキーが正しくないようです。Google AI Studio で発行したキーを確認してください。',
  [GeminiErrorCode.PERMISSION_DENIED]:
    'このAPIキーには必要な権限がありません。Google Cloud プロジェクトの設定を確認してください。',
  [GeminiErrorCode.QUOTA_EXCEEDED]:
    '無料枠または利用上限を超えました。時間をおいてお試しいただくか、Google Cloud の割り当てを確認してください。',
  [GeminiErrorCode.MODEL_NOT_FOUND]:
    '指定したGeminiモデルが利用できませんでした。別のモデルを選んでお試しください。',
  [GeminiErrorCode.AUDIO_NOT_SUPPORTED]:
    'このGeminiモデルは音声入力に対応していません。別のモデルを選んでお試しください。',
  [GeminiErrorCode.UPLOAD_FAILED]: '音声ファイルのアップロードに失敗しました。',
  [GeminiErrorCode.FILE_PROCESSING_FAILED]: 'Gemini側で音声ファイルを処理できませんでした。',
  [GeminiErrorCode.FILE_TIMEOUT]:
    'Gemini側の準備が時間内に終わりませんでした。短い音声でお試しください。',
  [GeminiErrorCode.GENERATION_FAILED]: 'Geminiの処理に失敗しました。',
  [GeminiErrorCode.EMPTY_RESULT]: '文字起こし結果が空でした。音声の内容を確認してください。',
  [GeminiErrorCode.NETWORK]: '通信に失敗しました。ネットワークの状態を確認してください。',
  [GeminiErrorCode.SERVER_ERROR]: 'Google側で問題が発生しています。しばらく待ってからお試しください。',
  [GeminiErrorCode.CANCELLED]: '処理を中止しました。',
  [GeminiErrorCode.UNKNOWN]: 'Geminiの処理に失敗しました。',
});

/*
 * 例外を利用者向けの文言へ直す。
 *
 * ここが「機密情報を外へ出さない」最後の関門になる。
 * error.message や API の応答本文を、そのまま画面へ出してはならない。
 */
function describeError(error) {
  if (error instanceof AudioError) {
    return AUDIO_ERROR_MESSAGES[error.code] ?? AUDIO_ERROR_MESSAGES[AudioErrorCode.UNKNOWN];
  }

  if (error instanceof DriveAuthError) {
    return AUTH_ERROR_MESSAGES[error.code] ?? AUTH_ERROR_MESSAGES[DriveAuthErrorCode.UNKNOWN];
  }

  if (error instanceof DriveError) {
    return DRIVE_ERROR_MESSAGES[error.code] ?? DRIVE_ERROR_MESSAGES[DriveErrorCode.UNKNOWN];
  }

  if (error instanceof WhisperError) {
    return WHISPER_ERROR_MESSAGES[error.code] ?? WHISPER_ERROR_MESSAGES[WhisperErrorCode.UNKNOWN];
  }

  if (error instanceof GeminiError) {
    return GEMINI_ERROR_MESSAGES[error.code] ?? GEMINI_ERROR_MESSAGES[GeminiErrorCode.UNKNOWN];
  }

  /* 想定外の例外は、種別も出さずに一般的な文言へ寄せる。 */
  return '処理に失敗しました。ページを再読み込みしてお試しください。';
}

function isCancellation(error) {
  return (error instanceof WhisperError && error.code === WhisperErrorCode.CANCELLED)
    || (error instanceof GeminiError && error.code === GeminiErrorCode.CANCELLED)
    || (error instanceof DriveError && error.code === DriveErrorCode.CANCELLED)
    || (error instanceof AudioError && error.code === AudioErrorCode.CANCELLED);
}

/* ============================================================
   要素
   ============================================================ */

const el = {};

function cacheElements() {
  const ids = [
    'at-app', 'at-file-input', 'at-local-button', 'at-drive-button', 'at-drive-note',
    'at-drive-dialog', 'at-dialog-status', 'at-dialog-error', 'at-drive-list',
    'at-drive-reload', 'at-drive-cancel',
    'at-file-info', 'at-file-name', 'at-file-type', 'at-file-size', 'at-file-duration',
    'at-file-source', 'at-player', 'at-clear-file',
    'at-mode-local', 'at-mode-gemini',
    'at-language', 'at-timestamps',
    'at-local-settings', 'at-whisper-model', 'at-whisper-model-note', 'at-device-note',
    'at-gemini-settings', 'at-gemini-model', 'at-api-key', 'at-key-toggle', 'at-key-status',
    'at-status', 'at-progress', 'at-progress-fill', 'at-progress-label', 'at-error',
    'at-start', 'at-cancel',
    'at-result', 'at-result-count', 'at-result-mode', 'at-result-elapsed',
    'at-copy', 'at-download', 'at-save-drive', 'at-clear-result',
    'at-speaker-from', 'at-speaker-to', 'at-speaker-apply', 'at-toast',
  ];

  ids.forEach((id) => {
    /* ハイフンを取り除いたキー名で引けるようにする（at-file-name → fileName）。 */
    const key = id.replace(/^at-/, '').replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    el[key] = document.getElementById(id);
  });
}

/* ============================================================
   このモジュールだけが持つ値
   ============================================================ */

/*
 * Gemini APIキー。ここ以外のどこにも書かない。
 * 画面の input からは submit のたびに読み直さず、この変数を使う。
 */
let apiKey = '';

/* 進行中の処理を止めるための AbortController。 */
let abortController = null;

/* 直前に発行したオブジェクトURL。差し替え時に必ず解放する。 */
let currentObjectUrl = null;

/* 端末内モードで得られたタイムスタンプ付きの結果。表示の切り替えに使う。 */
let lastChunks = [];

let toastTimer = 0;

/* ============================================================
   小さな道具
   ============================================================ */

function setText(node, text) {
  if (node) {
    /* 外部入力を含むため、必ず textContent で入れる。 */
    node.textContent = text;
  }
}

function setHidden(node, hidden) {
  if (node) {
    node.hidden = Boolean(hidden);
  }
}

function showToast(message) {
  setText(el.toast, message);
  setHidden(el.toast, false);
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => setHidden(el.toast, true), 4000);
}

function releaseObjectUrl() {
  if (currentObjectUrl) {
    URL.revokeObjectURL(currentObjectUrl);
    currentObjectUrl = null;
  }
}

/* ============================================================
   初期描画
   ============================================================ */

function populateSelects() {
  el.fileInput.accept = FILE_ACCEPT;

  LANGUAGES.forEach((language) => {
    const option = document.createElement('option');
    option.value = language.value;
    option.textContent = language.label;
    option.selected = language.value === DEFAULT_LANGUAGE;
    el.language.append(option);
  });

  WHISPER.models.forEach((model) => {
    const option = document.createElement('option');
    option.value = model.id;
    option.textContent = model.label;
    option.selected = model.id === WHISPER.defaultModelId;
    el.whisperModel.append(option);
  });

  const autoOption = document.createElement('option');
  autoOption.value = 'auto';
  autoOption.textContent = '自動（推奨）';
  autoOption.selected = GEMINI.defaultModelId === 'auto';
  el.geminiModel.append(autoOption);

  GEMINI.models.forEach((model) => {
    const option = document.createElement('option');
    option.value = model.id;
    option.textContent = model.label;
    option.selected = model.id === GEMINI.defaultModelId;
    el.geminiModel.append(option);
  });

  updateWhisperModelNote();
  updateDeviceNote();
  updateDriveNote();
}

function updateWhisperModelNote() {
  const selected = WHISPER.models.find((model) => model.id === el.whisperModel.value);
  setText(el.whisperModelNote, selected ? selected.note : '');
}

function updateDeviceNote() {
  const hasWebGpu = typeof navigator?.gpu?.requestAdapter === 'function';

  setText(
    el.deviceNote,
    hasWebGpu
      ? 'このブラウザはWebGPUに対応しています。高速な処理を試み、失敗した場合は自動的に通常処理へ切り替えます。'
      : 'このブラウザはWebGPUに対応していないため、CPUで処理します。時間がかかることがあります。',
  );
}

/*
 * Drive の説明文。
 *
 * 対象は固定フォルダの中だけなので、「ドライブ全体から選べる」と
 * 誤解される書き方をしない。
 */
function updateDriveNote() {
  setText(
    el.driveNote,
    `Google Driveは「${VOICE_RECORDER_PATH}」の中だけを対象にします。`
    + 'ドライブ全体は検索しません。',
  );
}

/* ============================================================
   状態に応じた描画
   ============================================================ */

function render(snapshot) {
  const { state, file, mode, progress, errorMessage, result, resultMeta } = snapshot;

  el.app.dataset.appState = state;
  el.app.dataset.mode = mode;

  /* ---- ファイル情報 ---- */
  setHidden(el.fileInfo, !file);

  if (file) {
    setText(el.fileName, file.name);
    setText(el.fileType, file.mimeType || '不明');
    setText(el.fileSize, formatBytes(file.size));
    setText(el.fileDuration, file.durationSec === null ? '取得できません' : formatDuration(file.durationSec));
    setText(el.fileSource, SOURCE_LABELS[file.source] ?? '不明');
  }

  /* ---- モード別の設定欄 ---- */
  setHidden(el.localSettings, mode !== 'local');
  setHidden(el.geminiSettings, mode !== 'gemini');

  /* ---- 実行ボタン ---- */
  const busy = isBusy(state);
  el.start.disabled = busy || !file;
  el.start.textContent = busy ? '処理中…' : '文字起こしを開始';
  setHidden(el.cancel, !busy);

  el.localButton.disabled = busy;
  el.driveButton.disabled = busy;
  el.clearFile.disabled = busy;
  el.modeLocal.disabled = busy;
  el.modeGemini.disabled = busy;
  el.whisperModel.disabled = busy;
  el.geminiModel.disabled = busy;
  el.language.disabled = busy;
  el.apiKey.disabled = busy;

  /* ---- 結果の操作 ---- */
  const hasResult = result.trim() !== '';
  el.copy.disabled = !hasResult;
  el.download.disabled = !hasResult;
  el.saveDrive.disabled = !hasResult || busy;
  el.clearResult.disabled = !hasResult;
  el.speakerApply.disabled = !hasResult;

  setText(el.resultCount, `${countCharacters(result)}文字`);

  setHidden(el.resultMode, !resultMeta);
  setHidden(el.resultElapsed, !resultMeta);

  if (resultMeta) {
    setText(el.resultMode, `使用モード：${resultMeta.modeLabel}`);
    setText(el.resultElapsed, `処理時間：${formatElapsed(resultMeta.elapsedMs)}`);
  }

  /* ---- 進捗 ---- */
  setHidden(el.progress, !progress);

  if (progress) {
    const hasRatio = Number.isFinite(progress.ratio);
    el.progress.dataset.indeterminate = String(!hasRatio);
    el.progressFill.style.width = hasRatio ? `${Math.round(progress.ratio * 100)}%` : '';

    const bar = el.progress.querySelector('[role="progressbar"]');

    if (hasRatio) {
      bar.setAttribute('aria-valuenow', String(Math.round(progress.ratio * 100)));
    } else {
      bar.removeAttribute('aria-valuenow');
    }

    setText(el.progressLabel, progress.label);
  }

  /* ---- 状態表示 ---- */
  setHidden(el.error, !errorMessage);

  if (errorMessage) {
    setText(el.error, errorMessage);
  }

  const statusText = buildStatusText(snapshot);
  setText(el.status, statusText.text);
  el.status.dataset.tone = statusText.tone;
}

function buildStatusText({ state, file, mode }) {
  switch (state) {
    case State.IDLE:
      return { text: '音声ファイルが選ばれていません。', tone: 'idle' };
    case State.FILE_SELECTED:
      return {
        text: `「${file?.name ?? ''}」を選択中です。${MODE_LABELS[mode]}で文字起こしを開始できます。`,
        tone: 'idle',
      };
    case State.LOADING_MODEL:
      return { text: '処理中：AIモデルを準備しています。', tone: 'busy' };
    case State.UPLOADING:
      return { text: '処理中：音声ファイルを送信しています。', tone: 'busy' };
    case State.TRANSCRIBING:
      return { text: '処理中：文字起こしをしています。', tone: 'busy' };
    case State.COMPLETED:
      return { text: '完了：文字起こしが終わりました。結果は下の欄で編集できます。', tone: 'done' };
    case State.CANCELLED:
      return { text: '中止：処理を中止しました。もう一度開始できます。', tone: 'idle' };
    case State.ERROR:
      return { text: '失敗：処理を完了できませんでした。下の内容を確認してください。', tone: 'error' };
    default:
      return { text: '', tone: 'idle' };
  }
}

/* ============================================================
   ファイルの受け取り
   ============================================================ */

/*
 * Blob を受け取り、検証してから状態へ入れる。
 * 端末選択・Drive取得のどちらもここへ集約する。
 */
async function acceptFile({ blob, name, source }) {
  /*
   * 検証は「今の選択を捨てる前」に行う。
   *
   * 先に releaseObjectUrl() すると、新しいファイルが読めなかったときに
   * 直前まで選べていたファイルのプレーヤーだけが壊れた状態で残る。
   * 実ブラウザでの検証で、拡張子を偽装したファイルを選ぶと選択中の
   * ファイルごと消える挙動になっていたため、この順序にしてある。
   */
  let probe;

  try {
    probe = await probeAudio(blob);
  } catch (error) {
    /*
     * 読み込めなかったファイルは採用しない。
     * 直前の選択はそのまま残し、理由だけを伝える。
     */
    update({ errorMessage: describeError(error) });
    return false;
  }

  /* 新しいファイルが使えると分かってから、古いURLを解放する。 */
  releaseObjectUrl();
  currentObjectUrl = probe.objectUrl;
  el.player.src = probe.objectUrl;

  transition(State.FILE_SELECTED, {
    file: {
      name,
      mimeType: blob.type || '',
      size: blob.size,
      durationSec: probe.durationSec,
      source,
      blob,
    },
  });

  return true;
}

/* 処理中に新しいファイルを選ばせない。 */
function rejectIfBusy() {
  if (!isBusy(getState().state)) {
    return false;
  }

  update({ errorMessage: '処理中は別のファイルを選べません。中止してからお試しください。' });
  return true;
}

async function onLocalFileChosen(event) {
  const [file] = event.target.files ?? [];

  /* 同じファイルを続けて選べるよう、値は毎回空にする。 */
  event.target.value = '';

  if (!file) {
    return;
  }

  if (rejectIfBusy()) {
    return;
  }

  if (!looksLikeAudio(file)) {
    /*
     * 選択の拒否であって処理の失敗ではないので、状態は動かさない。
     * （直前に選んでいたファイルがあれば、それを選んだままにする）
     */
    update({ errorMessage: AUDIO_ERROR_MESSAGES[AudioErrorCode.UNSUPPORTED_TYPE] });
    return;
  }

  await acceptFile({ blob: file, name: file.name, source: 'local' });
}

function clearFile() {
  if (rejectIfBusy()) {
    return;
  }

  releaseObjectUrl();
  el.player.removeAttribute('src');
  el.player.load();
  transition(State.IDLE);
}

/* ============================================================
   Google ドライブ
   ============================================================ */

/*
 * Picker が使える構成なら Picker、そうでなければ一覧を出す。
 *
 * どちらの経路でも認可は ../drive-auth.js の ensureAccessToken() を使う。
 * このアプリ用に認可処理を書き起こさない。
 */
async function onDriveButtonClick() {
  if (rejectIfBusy()) {
    return;
  }

  update({ errorMessage: null });

  /*
   * 先にダイアログを開いてから通信する。
   * 認可のポップアップは押下と同じ操作の流れで出す必要があるため、
   * ここで長い非同期処理を挟まない。
   */
  openDriveDialog();

  await loadDriveList({ forceConsent: false });
}

/* ---------- ダイアログ ---------- */

/* ダイアログを開く前にフォーカスがあった要素。閉じたときにここへ戻す。 */
let dialogOpener = null;

function openDriveDialog() {
  if (el.driveDialog.open) {
    return;
  }

  dialogOpener = document.activeElement;

  /*
   * showModal() を使うと Escape での閉じる・フォーカスの閉じ込め・
   * 背面の不活性化をブラウザが行う。自前で実装しない。
   */
  el.driveDialog.showModal();
}

function closeDriveDialog() {
  /* 取得中なら中断する。閉じたあとに結果が届いても書き込まないようにする。 */
  driveListController?.abort();
  driveListController = null;

  if (el.driveDialog.open) {
    el.driveDialog.close();
  }
}

/* ダイアログが閉じたとき（Escape・close() のどちらでも呼ばれる）。 */
function onDialogClose() {
  driveListController?.abort();
  driveListController = null;

  /*
   * 元の位置へフォーカスを戻す。キーボード操作で迷子にならないようにする。
   * 開いたときにフォーカスが body だった場合（プログラムから開いた場合など）は、
   * 戻す先が無いので Drive ボタンへ寄せる。
   */
  const restoreTo = dialogOpener instanceof HTMLElement
    && dialogOpener !== document.body
    && document.contains(dialogOpener)
    ? dialogOpener
    : el.driveButton;

  restoreTo?.focus();

  dialogOpener = null;
}

function setDialogStatus(text) {
  setText(el.dialogStatus, text);
}

function setDialogError(message) {
  setHidden(el.dialogError, !message);

  if (message) {
    setText(el.dialogError, message);
  }
}

/* 一覧の代わりに1行だけ出す（読み込み中・空・失敗）。 */
function renderListMessage(text) {
  const item = document.createElement('li');
  item.className = 'at-drive-list__empty';
  item.textContent = text;
  el.driveList.replaceChildren(item);
}

/* ---------- 一覧の取得 ---------- */

/*
 * 同じセッション中は解決済みのフォルダIDを使い回す。
 *
 * メモリ上だけに置く。localStorage / sessionStorage / Cookie / URL へは書かない。
 * ページを再読み込みすれば消え、また名前から解決し直す。
 */
let voiceRecorderFolderId = null;

/* 進行中の一覧取得。ダイアログを閉じたら中断する。 */
let driveListController = null;

async function loadDriveList({ forceConsent = false } = {}) {
  driveListController?.abort();
  driveListController = new AbortController();

  const { signal } = driveListController;

  setDialogError(null);
  setDialogStatus('Google Driveに接続しています…');
  renderListMessage('読み込んでいます…');
  el.driveReload.disabled = true;

  try {
    const token = await ensureAccessToken({ forceConsent });

    if (signal.aborted) {
      return;
    }

    setDialogStatus('フォルダを探しています…');

    const result = await loadVoiceRecorderAudio({
      token,
      folderId: voiceRecorderFolderId,
      signal,
    });

    if (signal.aborted) {
      return;
    }

    /* 解決できたIDは、このセッションの間だけ覚えておく。 */
    voiceRecorderFolderId = result.folderId;
    renderDriveList(result.files);
  } catch (error) {
    if (signal.aborted) {
      return;
    }

    handleDriveListError(error);
  } finally {
    el.driveReload.disabled = false;
  }
}

function handleDriveListError(error) {
  /* 期限切れは黙って捨て、次回は取り直しになる。 */
  if (error instanceof DriveError && error.code === DriveErrorCode.UNAUTHORIZED) {
    clearAccessToken();
    voiceRecorderFolderId = null;
  }

  /* 利用者が認可画面を閉じた場合は、失敗ではなく中止として扱う。 */
  if (error instanceof DriveAuthError
    && (error.code === DriveAuthErrorCode.POPUP_CLOSED || error.code === DriveAuthErrorCode.ACCESS_DENIED)) {
    closeDriveDialog();
    showToast('Googleドライブへの接続を中止しました。');
    return;
  }

  setDialogStatus('');
  setDialogError(describeError(error));

  /* 同名フォルダが複数あるときは、候補を並べて利用者に選ばせる。 */
  if (error instanceof DriveError && Array.isArray(error.candidates) && error.candidates.length > 0) {
    renderFolderCandidates(error);
    return;
  }

  renderListMessage('一覧を取得できませんでした。');
}

/* ---------- 描画 ---------- */

function formatDateTime(value) {
  const date = new Date(String(value ?? ''));

  if (Number.isNaN(date.getTime())) {
    return '日時不明';
  }

  const pad = (n) => String(n).padStart(2, '0');

  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/*
 * ファイル名から拡張子を取り出す。
 * Drive の MIME が空のときの表示に使う。
 */
function extensionLabel(name) {
  const match = /\.([^.]+)$/.exec(String(name ?? ''));
  return match ? match[1].toUpperCase() : '形式不明';
}

function renderDriveList(files) {
  if (files.length === 0) {
    setDialogStatus('');
    renderListMessage('Voice Recorderフォルダに音声ファイルがありません。');
    return;
  }

  setDialogStatus(`${files.length}件の音声ファイルが見つかりました。`);

  const fragment = document.createDocumentFragment();

  files.forEach((file) => {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'at-drive-list__button';

    const name = document.createElement('span');
    name.className = 'at-drive-list__name';
    /* Drive の表示名は外部入力。必ず textContent で入れる。 */
    name.textContent = String(file.name ?? '');

    const meta = document.createElement('span');
    meta.className = 'at-drive-list__meta';
    meta.textContent = [
      formatDateTime(file.modifiedTime),
      formatBytes(file.size ?? 0),
      String(file.mimeType ?? '') || extensionLabel(file.name),
    ].join(' ・ ');

    button.append(name, meta);
    button.addEventListener('click', () => {
      void selectDriveFile({
        id: String(file.id),
        name: String(file.name ?? 'audio'),
        mimeType: String(file.mimeType ?? ''),
      });
    });

    item.append(button);
    fragment.append(item);
  });

  el.driveList.replaceChildren(fragment);
}

/*
 * 同名フォルダが複数あったときの候補一覧。
 * 作成日時を添えて、どれを使うかを利用者に決めてもらう。
 */
function renderFolderCandidates(error) {
  const isRoot = error.code === DriveErrorCode.ROOT_FOLDER_AMBIGUOUS;
  const fragment = document.createDocumentFragment();

  error.candidates.forEach((folder) => {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'at-drive-list__button';

    const name = document.createElement('span');
    name.className = 'at-drive-list__name';
    name.textContent = `${folder.name}（このフォルダを使う）`;

    const meta = document.createElement('span');
    meta.className = 'at-drive-list__meta';
    meta.textContent = `作成 ${formatDateTime(folder.createdTime)} ・ 更新 ${formatDateTime(folder.modifiedTime)}`;

    button.append(name, meta);
    button.addEventListener('click', () => {
      void chooseFolderCandidate(folder.id, isRoot);
    });

    item.append(button);
    fragment.append(item);
  });

  el.driveList.replaceChildren(fragment);
}

/*
 * 利用者が候補から選んだフォルダで続きを進める。
 *
 * TSAM AI を選んだ場合は、その直下から Voice Recorder を探し直す。
 * Voice Recorder を選んだ場合は、それを対象フォルダとして確定する。
 */
async function chooseFolderCandidate(folderId, isRoot) {
  setDialogError(null);
  setDialogStatus('フォルダを確認しています…');
  renderListMessage('読み込んでいます…');

  driveListController?.abort();
  driveListController = new AbortController();
  const { signal } = driveListController;

  try {
    const token = await ensureAccessToken();

    if (isRoot) {
      const folders = await findFoldersByName(DRIVE_FOLDERS.voiceRecorder, folderId, { token, signal });

      if (folders.length === 0) {
        throw new DriveError(DriveErrorCode.APP_FOLDER_MISSING, 0, 'not_found');
      }

      if (folders.length > 1) {
        const ambiguous = new DriveError(DriveErrorCode.APP_FOLDER_AMBIGUOUS, 0, 'duplicated');
        ambiguous.candidates = folders.map((folder) => ({
          id: String(folder.id),
          name: String(folder.name ?? DRIVE_FOLDERS.voiceRecorder),
          createdTime: folder.createdTime ?? null,
          modifiedTime: folder.modifiedTime ?? null,
        }));
        throw ambiguous;
      }

      voiceRecorderFolderId = String(folders[0].id);
    } else {
      voiceRecorderFolderId = folderId;
    }

    const files = await listVoiceRecorderAudio({ token, folderId: voiceRecorderFolderId, signal });

    if (signal.aborted) {
      return;
    }

    renderDriveList(files);
  } catch (error) {
    if (signal.aborted) {
      return;
    }

    handleDriveListError(error);
  }
}

/* ---------- 選択 ---------- */

async function selectDriveFile({ id, name, mimeType }) {
  setDialogStatus('ファイルを取得しています…');
  setDialogError(null);

  try {
    /* 直前の認可がまだ有効なら、ensureAccessToken はポップアップを出さずに返す。 */
    const token = await ensureAccessToken();
    const accepted = await fetchDriveFile({ token, fileId: id, name, mimeType });

    if (accepted) {
      closeDriveDialog();
    }
  } catch (error) {
    setDialogStatus('');
    setDialogError(describeError(error));
  }
}

/*
 * Drive のファイル本体をブラウザへ取得する。
 *
 * Gemini へは、ここで得た Blob を渡す。
 * Drive の URL をそのまま渡すことはしない（Google側に読む権限が無いため）。
 */
async function fetchDriveFile({ token, fileId, name, mimeType }) {
  update({ errorMessage: null, progress: { label: 'Googleドライブから取得しています…', ratio: null } });

  try {
    let resolvedMime = mimeType;
    let resolvedName = name;

    if (!resolvedMime) {
      const metadata = await getFileMetadata({ token, fileId });
      resolvedMime = String(metadata?.mimeType ?? '');
      resolvedName = String(metadata?.name ?? name);
    }

    const blob = await downloadFile({ token, fileId, mimeType: resolvedMime });

    update({ progress: null });
    /* 以降は端末選択と同じ経路。取得元だけが違う。 */
    return await acceptFile({ blob, name: resolvedName, source: 'drive' });
  } catch (error) {
    update({ progress: null });

    if (error instanceof DriveError && error.code === DriveErrorCode.UNAUTHORIZED) {
      /* 期限切れのトークンは捨てる。次回は取り直しになる。 */
      clearAccessToken();
      voiceRecorderFolderId = null;
    }

    /* ダイアログ側で見せるので、ここでは投げ直すだけにする。 */
    throw error;
  }
}

/* ============================================================
   文字起こしの実行
   ============================================================ */

function progressLabelFor(phase, detail) {
  switch (phase) {
    case 'decoding':
      return '音声を解析しています…';
    case 'loading-model':
      if (detail?.file && detail?.total) {
        return `AIモデルをダウンロードしています（${detail.file}）`;
      }

      return 'AIモデルを読み込んでいます…';
    case 'model-fallback':
      return 'WebGPUを利用できないため、通常処理へ切り替えています…';
    case 'model-ready':
      return detail?.device === 'webgpu' ? 'WebGPUで実行します。' : 'CPU（WASM）で実行します。';
    case 'checking-model':
      return '利用できるGeminiモデルを確認しています…';
    case 'uploading':
      return '音声ファイルを送信しています…';
    case 'transcribing':
      if (detail?.total > 1) {
        return `文字起こし中（${detail.index}/${detail.total} 区間）`;
      }

      return '文字起こしをしています…';
    default:
      return '処理しています…';
  }
}

function phaseToState(phase) {
  if (phase === 'loading-model' || phase === 'model-fallback' || phase === 'model-ready' || phase === 'checking-model') {
    return State.LOADING_MODEL;
  }

  if (phase === 'uploading') {
    return State.UPLOADING;
  }

  return State.TRANSCRIBING;
}

function handleProgress(progress) {
  const state = phaseToState(progress.phase);
  const current = getState();

  update({
    state: current.state === state ? current.state : state,
    progress: {
      label: progressLabelFor(progress.phase, progress),
      ratio: Number.isFinite(progress.ratio) ? progress.ratio : null,
    },
  });
}

function checkLimits(file, mode) {
  const maxBytes = mode === 'gemini' ? LIMITS.geminiMaxBytes : LIMITS.localMaxBytes;
  const maxDuration = mode === 'gemini' ? LIMITS.geminiMaxDurationSec : LIMITS.localMaxDurationSec;

  if (file.size > maxBytes) {
    throw new AudioError(AudioErrorCode.TOO_LARGE, 'size_limit');
  }

  if (Number.isFinite(file.durationSec) && file.durationSec > maxDuration) {
    throw new AudioError(AudioErrorCode.TOO_LONG, 'duration_limit');
  }
}

async function onStart() {
  const snapshot = getState();

  /* 二重実行の防止。ボタンは無効化してあるが、経路が増えても守れるようにする。 */
  if (isBusy(snapshot.state) || abortController) {
    return;
  }

  if (!snapshot.file) {
    update({ state: State.ERROR, errorMessage: AUDIO_ERROR_MESSAGES[AudioErrorCode.NO_FILE] });
    return;
  }

  if (snapshot.mode === 'gemini' && apiKey === '') {
    update({ state: State.ERROR, errorMessage: GEMINI_ERROR_MESSAGES[GeminiErrorCode.API_KEY_MISSING] });
    return;
  }

  try {
    checkLimits(snapshot.file, snapshot.mode);
  } catch (error) {
    update({ state: State.ERROR, errorMessage: describeError(error) });
    return;
  }

  abortController = new AbortController();
  lastChunks = [];

  const startedAt = performance.now();
  const withTimestamps = el.timestamps.checked;
  const language = el.language.value;

  update({
    state: State.LOADING_MODEL,
    errorMessage: null,
    result: '',
    resultMeta: null,
    progress: { label: '準備しています…', ratio: null },
  });

  try {
    const output = snapshot.mode === 'local'
      ? await runLocal({ snapshot, language, withTimestamps })
      : await runGemini({ snapshot, language, withTimestamps });

    transition(State.COMPLETED, {
      result: output.text,
      resultMeta: {
        elapsedMs: performance.now() - startedAt,
        modeLabel: output.modeLabel,
      },
    });

    el.result.value = output.text;
    showToast('文字起こしが完了しました。');
  } catch (error) {
    if (isCancellation(error) || abortController?.signal.aborted) {
      transition(State.CANCELLED);
      return;
    }

    transition(State.ERROR, { errorMessage: describeError(error), progress: null });
  } finally {
    abortController = null;
  }
}

async function runLocal({ snapshot, language, withTimestamps }) {
  const modelId = el.whisperModel.value;

  const result = await transcribeBlob(snapshot.file.blob, {
    modelId,
    language,
    returnTimestamps: withTimestamps,
    signal: abortController.signal,
    onProgress: handleProgress,
  });

  lastChunks = result.chunks ?? [];

  /*
   * タイムスタンプを求められていて、区間の情報が取れている場合はそちらを使う。
   * 取れていなければ、連結済みの本文をそのまま出す。
   */
  const text = withTimestamps && lastChunks.length > 0
    ? formatChunks(lastChunks, { withTimestamps: true })
    : result.text;

  const modelLabel = WHISPER.models.find((model) => model.id === modelId)?.label ?? modelId;
  const deviceLabel = result.device === 'webgpu' ? 'WebGPU' : 'CPU';

  return {
    text,
    modeLabel: `${MODE_LABELS.local}（${modelLabel} / ${deviceLabel}）`,
  };
}

async function runGemini({ snapshot, language, withTimestamps }) {
  const result = await transcribeWithGemini(snapshot.file.blob, {
    apiKey,
    displayName: snapshot.file.name,
    preferredModelId: el.geminiModel.value,
    language,
    withTimestamps,
    signal: abortController.signal,
    onProgress: handleProgress,
  });

  return {
    text: result.text,
    modeLabel: `${MODE_LABELS.gemini}（${result.modelId}）`,
  };
}

function onCancel() {
  if (!abortController) {
    return;
  }

  abortController.abort();
  update({ progress: { label: '中止しています…', ratio: null } });
}

/* ============================================================
   結果の操作
   ============================================================ */

async function onCopy() {
  const copied = await copyText(el.result.value);

  showToast(copied
    ? 'コピーしました。'
    : 'コピーできませんでした。文字起こし結果を選択して、手動でコピーしてください。');
}

function onDownload() {
  const file = getState().file;
  const fileName = buildTextFileName(file?.name ?? 'transcript');

  downloadText(el.result.value, fileName);
  showToast(`「${fileName}」を保存しました。`);
}

async function onSaveToDrive() {
  if (isBusy(getState().state)) {
    return;
  }

  const file = getState().file;
  const fileName = buildTextFileName(file?.name ?? 'transcript');

  try {
    const token = await ensureAccessToken();
    const saved = await saveTranscriptText({ token, text: el.result.value, fileName });

    showToast(`Googleドライブへ「${saved.name}」を保存しました。`);
  } catch (error) {
    if (error instanceof DriveAuthError && error.code === DriveAuthErrorCode.POPUP_CLOSED) {
      showToast('Googleドライブへの接続を中止しました。');
      return;
    }

    if (error instanceof DriveError && error.code === DriveErrorCode.UNAUTHORIZED) {
      clearAccessToken();
    }

    update({ state: State.ERROR, errorMessage: describeError(error) });
  }
}

function onClearResult() {
  el.result.value = '';
  lastChunks = [];
  update({ result: '', resultMeta: null });
  showToast('結果をクリアしました。');
}

function onSpeakerReplace() {
  const replaced = replaceSpeakerName(el.result.value, el.speakerFrom.value, el.speakerTo.value);

  if (replaced === el.result.value) {
    showToast('置き換える話者名が見つかりませんでした。');
    return;
  }

  el.result.value = replaced;
  update({ result: replaced });
  showToast('話者名を置き換えました。');
}

/*
 * タイムスタンプの表示切り替え。
 * 端末内モードで区間情報が残っているときだけ、本文を作り直す。
 * 利用者が本文を編集していた場合は上書きしない。
 */
function onTimestampToggle() {
  if (lastChunks.length === 0) {
    return;
  }

  const rebuilt = formatChunks(lastChunks, { withTimestamps: el.timestamps.checked });

  if (el.result.value.trim() === '' || confirmOverwrite()) {
    el.result.value = rebuilt;
    update({ result: rebuilt });
  }
}

function confirmOverwrite() {
  return window.confirm('編集中の内容を、タイムスタンプの設定に合わせて作り直します。よろしいですか？');
}

/* ============================================================
   APIキー
   ============================================================ */

function onApiKeyInput() {
  /*
   * 入力欄の値を変数へ写す。
   * この変数はページを閉じれば消える。保存先はここ以外に無い。
   */
  apiKey = el.apiKey.value.trim();

  setText(
    el.keyStatus,
    apiKey === ''
      ? 'APIキーは未入力です。'
      : 'APIキーを受け取りました。この端末には保存されません。',
  );
}

function onKeyToggle() {
  const showing = el.apiKey.type === 'text';

  el.apiKey.type = showing ? 'password' : 'text';
  el.keyToggle.textContent = showing ? '表示' : '隠す';
  el.keyToggle.setAttribute('aria-pressed', String(!showing));
}

/* ============================================================
   起動
   ============================================================ */

function bindEvents() {
  el.localButton.addEventListener('click', () => {
    if (!rejectIfBusy()) {
      el.fileInput.click();
    }
  });

  el.fileInput.addEventListener('change', (event) => void onLocalFileChosen(event));
  el.driveButton.addEventListener('click', () => void onDriveButtonClick());
  el.driveReload.addEventListener('click', () => {
    /* 再読み込みではフォルダの解決からやり直す。 */
    voiceRecorderFolderId = null;
    void loadDriveList({ forceConsent: false });
  });
  el.driveCancel.addEventListener('click', closeDriveDialog);
  /* Escape で閉じた場合もここを通る。 */
  el.driveDialog.addEventListener('close', onDialogClose);
  el.clearFile.addEventListener('click', clearFile);

  el.modeLocal.addEventListener('change', () => update({ mode: 'local', errorMessage: null }));
  el.modeGemini.addEventListener('change', () => update({ mode: 'gemini', errorMessage: null }));

  el.whisperModel.addEventListener('change', updateWhisperModelNote);
  el.timestamps.addEventListener('change', onTimestampToggle);

  el.apiKey.addEventListener('input', onApiKeyInput);
  el.keyToggle.addEventListener('click', onKeyToggle);

  el.start.addEventListener('click', () => void onStart());
  el.cancel.addEventListener('click', onCancel);

  el.result.addEventListener('input', () => update({ result: el.result.value }));
  el.copy.addEventListener('click', () => void onCopy());
  el.download.addEventListener('click', onDownload);
  el.saveDrive.addEventListener('click', () => void onSaveToDrive());
  el.clearResult.addEventListener('click', onClearResult);
  el.speakerApply.addEventListener('click', onSpeakerReplace);

  /*
   * ページを離れるときに後始末をする。
   * apiKey はページの破棄と同時に消えるが、明示的に空にしておく。
   */
  window.addEventListener('pagehide', () => {
    apiKey = '';
    abortController?.abort();
    disposeWorker();
    releaseObjectUrl();
  });
}

function init() {
  cacheElements();

  if (!el.app) {
    return;
  }

  populateSelects();
  bindEvents();
  subscribe(render);
  render(getState());

}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}

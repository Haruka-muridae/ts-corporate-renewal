/*
 * 音声文字起こしアプリ（本番）の UI 層。
 *
 * public/apps/audio-transcriber/script.js からの複製・適合。
 * 複製であって import ではないのは、本番アプリからテスト環境（public/apps/）を
 * 参照しないという境界（docs/repository-structure.md §1）による。
 * テスト版との差分は次の4点で、文字起こしの挙動は変えていない。
 *   1. 認可を ../drive-auth.js から自前の ./oauth.js へ置き換えた
 *   2. フォルダ名を ../drive-folders.js から ./config.js の DRIVE_NAMES へ移した
 *   3. 起動時に guardPage() でポータル認証を確認し、通るまで main を隠す
 *   4. Gemini APIキーの都度入力を廃し、KeyStore（ポータルの「API設定」）へ
 *      置き換えた（docs/specs/keystore-spec-v1.md。short-script と同じ流儀）
 * これに加え、本番版だけの機能として次を持つ。
 *   5. Gemini APIの利用可否（接続済み/未設定/接続エラー）を表示する。
 *      詳しい文言は「設定」アコーディオンの先頭区画、短いバッジは
 *      「設定」の summary（閉じた状態でも見える）の2か所に出す
 *      （利用者フィードバックにより、当初の画面最上部固定表示から移した）
 *   6. 「設定」（Gemini APIの状態・音声ファイルの入力元・文字起こしの方法・
 *      言語・タイムスタンプ・AIモデル）と「音声ファイルを選ぶ」を
 *      details/summary のアコーディオンにし、初期状態を閉にする。
 *      「設定」を先頭に置く（状態確認・入力元/方法の選択 → ファイル選択 →
 *      実行、の順にするため。利用者フィードバックにより、構成・順序を
 *      複数回変更した）
 *   7. 音声ファイル本体・APIキーを除く選択・設定値（入力元を含む）を
 *      settings-store.js で次回起動時に復元する
 *   8. 「音声ファイルを選ぶ」には端末・Googleドライブ両方の取得操作を常に出し、
 *      「設定」の『よく使う入力元』で選んだ側だけを主要ボタン（強調）にする
 *      （実機フィードバックにより、片方を隠す方式から強調の差をつけて
 *      両方出す方式へ変更した。applyFileSourceEmphasis 参照）。
 *      「設定」側の選択変更自体はOAuth認可を起動しない
 *      （認可は「Google Driveから選択」ボタン押下でのみ開始する）。
 *      実際に取得できた入力元は、次回以降の手数を減らすため『よく使う
 *      入力元』として保存し直す（rememberFileSourceDefault 参照）
 *
 * 担当するのは「DOMの更新」「利用者の操作の受け取り」「文言」の3つだけ。
 * 音声処理・API呼び出し・認可のロジックは各モジュールへ置く。
 *
 * ------------------------------------------------------------------
 * APIキーの扱い（このファイルで最も重要な点）
 * ------------------------------------------------------------------
 * 画面では KeyStore の**有無だけ**を見る（KeyStore.has）。
 * **値を読むのは次の2か所だけ**で、モジュール変数・DOM・state・console の
 * どこにも保持しない。
 *   - 実行の瞬間の KeyStore.get 1回（runGemini）
 *   - 接続状態の確認（refreshGeminiConnectionStatus）。起動時と、キーの有無が
 *     変わったとき・利用者がGeminiモードへ切り替えたときだけ行い、
 *     ポーリングはしない（keystore-spec-v1.md §8-2 の疎通テストと同じ、
 *     参照系のみの軽量な確認）
 * KeyStore の外で localStorage を触らない（keystore-spec-v1.md §2-1）。
 * ------------------------------------------------------------------
 *
 * 外部由来の文字列（ファイル名・Driveの表示名・APIの応答）は、
 * すべて textContent か フォーム値として扱う。innerHTML は使わない。
 */

import { guardPage } from '../../auth/session.js';
import { setScreenDepth } from '../../auth/config.js';
import { KeyStore, PROVIDERS, isKeyStoreAvailable } from '../../auth/keystore.js';

import {
  DEFAULT_LANGUAGE,
  DRIVE_NAMES,
  FILE_ACCEPT,
  GEMINI,
  LANGUAGES,
  LIMITS,
  SCREEN_DEPTH,
  WHISPER,
  formatBytes,
  formatDuration,
  formatFolderPath,
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
} from './oauth.js';

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
 * テスト版に残されていた drive-picker.js / picker-key.local.example.js は
 * 未使用のため本番へは複製していない。使う場合はテスト版から持ち込み、
 * index.html の CSP に apis.google.com などを足す必要がある。
 */

import { WhisperError, WhisperErrorCode, disposeWorker, transcribeBlob } from './whisper-transcriber.js';

import {
  GeminiError,
  GeminiErrorCode,
  checkGeminiConnection,
  transcribeWithGemini,
} from './gemini-transcriber.js';

/*
 * 音声ファイル・APIキーを含まない、利用者の選択・設定だけの永続化。
 * APIキーは引き続き KeyStore（public/auth/keystore.js）だけが扱う。
 */
import { loadSettings, saveSettings } from './settings-store.js';

import {
  buildTextFileName,
  copyText,
  countCharacters,
  downloadText,
  formatChunks,
  formatElapsed,
  replaceSpeakerName,
} from './result-exporter.js';

import { HandoffResultReason, saveHandoff } from './minutes-handoff.js';

/* guardPage() のリンク生成が正しい深さを指すように、最初に階層を宣言する。 */
setScreenDepth(SCREEN_DEPTH);

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
  drive: `Google Drive：${DRIVE_NAMES.root} ＞ ${DRIVE_NAMES.voiceRecorder}`,
});

/* 「マイドライブ ＞ TSAM AI ＞ Voice Recorder」 */
const VOICE_RECORDER_PATH = formatFolderPath(DRIVE_NAMES.root, DRIVE_NAMES.voiceRecorder);

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
  /* NOT_SIGNED_IN はテスト版 drive-auth.js の名残。本番 oauth.js には無いため持たない。 */
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
    + 'ブラウザ録音アプリと同じGoogleアカウントでログインしているかご確認ください。',

  /* 固定フォルダの解決に固有のもの。 */
  [DriveErrorCode.ROOT_FOLDER_MISSING]:
    `Google Driveに「${VOICE_RECORDER_PATH}」フォルダが見つかりませんでした。`
    + '先にブラウザ録音アプリで録音を保存してください。',
  [DriveErrorCode.APP_FOLDER_MISSING]:
    `Google Driveに「${VOICE_RECORDER_PATH}」フォルダが見つかりませんでした。`
    + '先にブラウザ録音アプリで録音を保存してください。',
  [DriveErrorCode.ROOT_FOLDER_AMBIGUOUS]:
    `同じ場所に「${DRIVE_NAMES.root}」フォルダが複数見つかりました。`
    + '使用するフォルダを特定できません。下から選んでください。',
  [DriveErrorCode.APP_FOLDER_AMBIGUOUS]:
    `同じ場所に「${DRIVE_NAMES.voiceRecorder}」フォルダが複数見つかりました。`
    + '使用するフォルダを特定できません。下から選んでください。',
  [DriveErrorCode.NO_AUDIO_FILES]:
    `${DRIVE_NAMES.voiceRecorder}フォルダに音声ファイルがありません。`,

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
  [GeminiErrorCode.API_KEY_MISSING]:
    'Gemini APIキーが設定されていません。ポータルの「API設定」で設定してください。',
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
    'at-gemini-connection',
    'at-app', 'at-file-input', 'at-local-button', 'at-drive-button', 'at-drive-note',
    'at-drive-dialog', 'at-dialog-status', 'at-dialog-error', 'at-drive-list',
    'at-drive-reload', 'at-drive-cancel',
    'at-source-local', 'at-source-drive',
    'at-file-current', 'at-file-info', 'at-file-name', 'at-file-type', 'at-file-size', 'at-file-duration',
    'at-file-source', 'at-player', 'at-clear-file',
    'at-settings-current', 'at-settings-connection-badge', 'at-mode-local', 'at-mode-gemini',
    'at-language', 'at-timestamps',
    'at-local-settings', 'at-whisper-model', 'at-whisper-model-note', 'at-device-note',
    'at-gemini-settings', 'at-gemini-model',
    'at-key-guidance', 'at-key-guidance-title', 'at-key-guidance-text', 'at-portal-link',
    'at-status', 'at-progress', 'at-progress-fill', 'at-progress-label', 'at-error',
    'at-start', 'at-cancel',
    'at-result-section', 'at-result', 'at-result-count', 'at-result-mode', 'at-result-elapsed',
    'at-copy', 'at-download', 'at-save-drive', 'at-clear-result', 'at-create-minutes',
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
 * Gemini APIキーの「有無」。値は持たない。
 *
 * 値を読むのは runGemini の KeyStore.get 1回だけで、
 * この画面はモジュール変数・DOM・state のどこにもキーを保持しない。
 * 利用者がポータルの別タブでキーを設定して戻ってくることがあるため、
 * refreshKeyState() が visibilitychange / focus で読み直す。
 */
let geminiKeyOk = false;

/*
 * 直前に確認したキーの「有無」。null は「まだ一度も確認していない」。
 * 接続確認（refreshGeminiConnectionStatus）は、これが変わったとき
 * （起動時の初回判定を含む）だけ行い、ポーリングはしない。
 */
let lastKnownKeyPresence = null;

/*
 * 接続確認の世代カウンタ。
 * 確認中に次の確認が始まったら、古い応答が届いても画面へ反映しない。
 */
let geminiConnectionGeneration = 0;

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

/*
 * saved は settings-store.js から読んだ保存済み設定（無ければ {}）。
 * 壊れた値・存在しない選択肢が入っていても、既定値へ静かに落とす
 * （KeyStore §3-3 と同じ「壊れた値でも画面を止めない」考え方）。
 */
function populateSelects(saved = {}) {
  el.fileInput.accept = FILE_ACCEPT;

  const savedLanguage = LANGUAGES.some((language) => language.value === saved.language)
    ? saved.language
    : DEFAULT_LANGUAGE;

  LANGUAGES.forEach((language) => {
    const option = document.createElement('option');
    option.value = language.value;
    option.textContent = language.label;
    option.selected = language.value === savedLanguage;
    el.language.append(option);
  });

  const savedWhisperModelId = WHISPER.models.some((model) => model.id === saved.whisperModelId)
    ? saved.whisperModelId
    : WHISPER.defaultModelId;

  WHISPER.models.forEach((model) => {
    const option = document.createElement('option');
    option.value = model.id;
    option.textContent = model.label;
    option.selected = model.id === savedWhisperModelId;
    el.whisperModel.append(option);
  });

  const geminiModelIds = ['auto', ...GEMINI.models.map((model) => model.id)];
  const savedGeminiModelId = geminiModelIds.includes(saved.geminiModelId)
    ? saved.geminiModelId
    : GEMINI.defaultModelId;

  const autoOption = document.createElement('option');
  autoOption.value = 'auto';
  autoOption.textContent = '自動（推奨）';
  autoOption.selected = savedGeminiModelId === 'auto';
  el.geminiModel.append(autoOption);

  GEMINI.models.forEach((model) => {
    const option = document.createElement('option');
    option.value = model.id;
    option.textContent = model.label;
    option.selected = model.id === savedGeminiModelId;
    el.geminiModel.append(option);
  });

  updateWhisperModelNote();
  updateDeviceNote();
  updateDriveNote();
}

/*
 * 文字起こしの方法（モード）・入力元・タイムスタンプの有無を、保存済み設定から復元する。
 * 音声ファイル本体・APIキーはここでは扱わない（対象外。settings-store.js 冒頭参照）。
 *
 * 前バージョンの保存値（fileSource キーが無い状態）を読み込んでもエラーにならず、
 * 既定値（'local'）へ静かにフォールバックする（他の項目と同じ「壊れた値・
 * 存在しないキーでも画面を止めない」考え方。KeyStore §3-3 参照）。
 */
function applySavedSettings(saved) {
  const mode = saved.mode === 'gemini' ? 'gemini' : 'local';
  el.modeLocal.checked = mode === 'local';
  el.modeGemini.checked = mode === 'gemini';
  update({ mode });

  el.timestamps.checked = typeof saved.withTimestamps === 'boolean' ? saved.withTimestamps : true;

  const fileSource = saved.fileSource === 'drive' ? 'drive' : 'local';
  el.sourceLocal.checked = fileSource === 'local';
  el.sourceDrive.checked = fileSource === 'drive';
  applyFileSourceEmphasis(fileSource);
}

/*
 * 「音声ファイルを選ぶ」アコーディオン内の、端末／Googleドライブ両ボタンの強調度の切替。
 *
 * 実機フィードバックにより、「設定」で選ばれていない側を hidden にする方式は
 * やめた。設定を開いて切り替えないとドライブが使えない、という状態を
 * 作らないため、**常に両方のボタンを表示**し、既定（よく使う入力元）の
 * 側だけを主要ボタン（.auth-button のプレーンな塗りつぶし）にし、
 * もう一方は補助的な見た目（.auth-button--ghost）にする。
 * どちらのボタンを押しても、押した側の取得操作が普通に動く
 * （Driveボタン押下時にのみ onDriveButtonClick が OAuth 認可を始める）。
 *
 * ここを呼んでもOAuth認可は一切起動しない（ensureAccessToken を呼ばない）。
 * 認可は利用者が「Google Driveから選択」ボタンを押した時点でのみ始まる。
 * 設定の変更それ自体を認可のトリガーにしないための境界を、
 * 関数を分けることで明示している。
 */
function applyFileSourceEmphasis(defaultSource) {
  const isDriveDefault = defaultSource === 'drive';
  el.localButton.classList.toggle('auth-button--ghost', isDriveDefault);
  el.driveButton.classList.toggle('auth-button--ghost', !isDriveDefault);
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
   Gemini APIキーの状態（KeyStore）
   ============================================================ */

/*
 * KeyStore の有無だけを見て、案内と実行可否を切り替える（short-script と同じ流儀）。
 * **値は読まない**（読むのは実際に実行するとき … runGemini）。
 *
 * 利用者がポータルの別タブでキーを設定して戻ってくることがあるため、
 * 画面が再表示された（visibilitychange / focus）ときにも呼び直す。
 */
function refreshKeyState() {
  const storageOk = isKeyStoreAvailable();
  geminiKeyOk = storageOk && KeyStore.has(PROVIDERS.gemini);

  if (!storageOk) {
    setText(el.keyGuidanceTitle, 'この端末ではキーを保存できません');
    setText(
      el.keyGuidanceText,
      'プライベートモードなどで localStorage が使えないため、APIキーを保存・参照できません。'
      + '通常のウィンドウでお試しください。',
    );
    setHidden(el.portalLink, true);
    setHidden(el.keyGuidance, false);
  } else if (!geminiKeyOk) {
    setText(el.keyGuidanceTitle, 'Gemini APIキーの設定が必要です');
    setText(
      el.keyGuidanceText,
      'Gemini APIでの文字起こしには、あなた自身の Gemini APIキーを使います。'
      + 'ポータルの「API設定」で一度だけ設定してください。'
      + 'キーはこの端末にのみ保存され、当社サーバーには送信されません。',
    );
    setHidden(el.portalLink, false);
    setHidden(el.keyGuidance, false);
  } else {
    setHidden(el.keyGuidance, true);
  }

  /*
   * キーの「有無」が前回確認時から変わっていたら（起動時の初回判定を含む）、
   * 画面上部の接続状態を確認し直す。値が変わっていなければ何もしない
   * （ポーリングしない。visibilitychange / focus のたびに毎回叩かない）。
   */
  if (geminiKeyOk !== lastKnownKeyPresence) {
    lastKnownKeyPresence = geminiKeyOk;
    void refreshGeminiConnectionStatus();
  }

  /* 開始ボタンの可否は render が geminiKeyOk を見て決める。 */
  render(getState());
  return geminiKeyOk;
}

/*
 * 「設定」アコーディオンの summary（閉じたタイトル行）に出す、
 * 「Gemini キー [接続済み / 未設定 / 接続エラー / 確認中]」の角括弧の中身。
 * 長い説明文（at-gemini-connection）とは別に、閉じた状態でも読める
 * 短い語だけを持つ。角括弧は「ラベルに続く状態値である」ことを、
 * 色を判別できない環境でも分かるようにするため（色だけに頼らない）。
 */
const CONNECTION_BADGE_LABELS = Object.freeze({
  unset: '未設定',
  checking: '確認中',
  ok: '接続済み',
  error: '接続エラー',
});

/*
 * Gemini キー（APIキー）の状態表示。呼ばれるのは起動時と、キーの有無が
 * 変わったとき・利用者がこの画面でGeminiモードへ切り替えたときだけ
 * （bindEvents 参照）。定期実行はしない。
 *
 * 表示先は2か所（同じ状態を同時に更新する。ラベルの表記は両方とも
 * 「Gemini キー」に揃え、片方だけ変わって表記が割れないようにする）。
 *   - el.geminiConnection … 「設定」アコーディオンを開いたときの詳しい文言
 *     （「Gemini キー：<状態>」。role="status" aria-live="polite" で
 *     読み上げに乗る）
 *   - el.settingsConnectionBadge … 「設定」の summary に出す角括弧つきの
 *     短いバッジ（「[<状態>]」。閉じた状態でも接続状態が分かるようにする
 *     ため。当初要件の「画面上でAPIの利用可否を目視確認できる」を維持する）
 *
 * 値を読むのはこの確認の間だけで、確認が終わればどこにも残さない
 * （KeyStore の外にキーを保持しないという方針は変えない。§8-2 の
 * 疎通テストと同じ、参照系のみを使う軽量な確認）。
 */
function setConnectionStatus(tone, text) {
  setText(el.geminiConnection, `Gemini キー：${text}`);

  if (el.geminiConnection) {
    el.geminiConnection.dataset.tone = tone;
  }

  const badgeLabel = CONNECTION_BADGE_LABELS[tone];
  setText(el.settingsConnectionBadge, badgeLabel ? `[${badgeLabel}]` : '');

  if (el.settingsConnectionBadge) {
    el.settingsConnectionBadge.dataset.tone = tone;
  }
}

async function refreshGeminiConnectionStatus() {
  /*
   * 呼ばれるたびに世代を進める（早期returnする分岐でも進める）。
   * こうしておかないと、「キー有り→確認中」に入った直後に「キー無し」へ
   * 変わった場合、後から届く古い確認結果が同じ世代番号のまま生き残り、
   * 同期的に確定させた「未設定」を後から上書きしてしまう。
   */
  const generation = (geminiConnectionGeneration += 1);
  const storageOk = isKeyStoreAvailable();

  if (!storageOk) {
    setConnectionStatus('unset', '未設定（この端末ではキーを保存できません）');
    return;
  }

  if (!KeyStore.has(PROVIDERS.gemini)) {
    setConnectionStatus('unset', '未設定');
    return;
  }

  setConnectionStatus('checking', '確認しています…');

  const apiKey = KeyStore.get(PROVIDERS.gemini);
  let result;

  try {
    result = await checkGeminiConnection({ apiKey });
  } catch {
    result = { ok: false };
  }

  /* 確認中に、有無の変化などで新しい確認が始まっていたら、古い結果は捨てる。 */
  if (generation !== geminiConnectionGeneration) {
    return;
  }

  setConnectionStatus(result.ok ? 'ok' : 'error', result.ok ? '接続済み' : '接続エラー');
}

/* ============================================================
   状態に応じた描画
   ============================================================ */

function render(snapshot) {
  const { state, file, mode, progress, errorMessage, result, resultMeta } = snapshot;

  el.app.dataset.appState = state;
  el.app.dataset.mode = mode;

  /*
   * ---- アコーディオンを閉じたときの表示 ----
   * :empty で消えるCSS（.at-accordion__current:empty）を使うため、
   * 値が無いときは空文字にする（要素そのものを hidden にしない）。
   */
  setText(el.fileCurrent, file ? `　｜　${file.name}` : '');
  /* 「設定」アコーディオン（文字起こしの方法＋各種設定を統合）の閉時表示。 */
  setText(el.settingsCurrent, `　｜　${MODE_LABELS[mode] ?? ''}`);

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
  /* Gemini モードはキー未設定（KeyStore 未登録・保存先なし）の間は開始できない。 */
  el.start.disabled = busy || !file || (mode === 'gemini' && !geminiKeyOk);
  el.start.textContent = busy ? '処理中…' : '文字起こしを開始';
  setHidden(el.cancel, !busy);

  el.localButton.disabled = busy;
  el.driveButton.disabled = busy;
  el.clearFile.disabled = busy;
  el.sourceLocal.disabled = busy;
  el.sourceDrive.disabled = busy;
  el.modeLocal.disabled = busy;
  el.modeGemini.disabled = busy;
  el.whisperModel.disabled = busy;
  el.geminiModel.disabled = busy;
  el.language.disabled = busy;

  /* ---- 結果と結果操作 ---- */
  const hasResult = result.trim() !== '';

  /*
   * 結果が無い間は結果欄・結果操作ボタンごと隠す。
   * 実行前・処理中は実行ボタンと状態・進捗だけが見え、完了して結果が
   * 入ってから現れる（トースト #at-toast はこの対象に含めない。結果の
   * 有無に関わらず使うため、index.html で hidden 対象の外に置いてある）。
   */
  setHidden(el.resultSection, !hasResult);

  el.copy.disabled = !hasResult;
  el.download.disabled = !hasResult;
  el.saveDrive.disabled = !hasResult || busy;
  el.clearResult.disabled = !hasResult;
  el.speakerApply.disabled = !hasResult;
  el.createMinutes.disabled = !hasResult;

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

  /*
   * 実際に使えた入力元を「よく使う入力元」として覚え直す。
   * 補助側のボタン（設定の既定と異なる側）から取得できた場合、
   * 次回以降は毎回強調を切り替える手間を減らすため、その入力元を
   * 新しい既定にする（次回起動時にも settings-store.js 経由で復元される）。
   */
  rememberFileSourceDefault(source);

  return true;
}

/*
 * 実際にファイルを取得できた入力元を「よく使う入力元」として保存し直す。
 * 「設定」のラジオ・強調表示・保存済み設定のすべてを、この入力元へ揃える。
 */
function rememberFileSourceDefault(source) {
  if (source !== 'local' && source !== 'drive') {
    return;
  }

  el.sourceLocal.checked = source === 'local';
  el.sourceDrive.checked = source === 'drive';
  applyFileSourceEmphasis(source);
  saveSettings({ fileSource: source });
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
 * どちらの経路でも認可は ./oauth.js の ensureAccessToken() を使う。
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
      const folders = await findFoldersByName(DRIVE_NAMES.voiceRecorder, folderId, { token, signal });

      if (folders.length === 0) {
        throw new DriveError(DriveErrorCode.APP_FOLDER_MISSING, 0, 'not_found');
      }

      if (folders.length > 1) {
        const ambiguous = new DriveError(DriveErrorCode.APP_FOLDER_AMBIGUOUS, 0, 'duplicated');
        ambiguous.candidates = folders.map((folder) => ({
          id: String(folder.id),
          name: String(folder.name ?? DRIVE_NAMES.voiceRecorder),
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

  /* キーの「有無」を実行直前にも確かめる（別タブで削除された場合に備える）。 */
  if (snapshot.mode === 'gemini' && !refreshKeyState()) {
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
  /*
   * キーの値を読むのはこの1行だけ。変数へ受けたら、この関数の外へ渡さない。
   * gemini-transcriber.js も引数で受け取るだけで、モジュール内に保持しない設計。
   */
  const apiKey = KeyStore.get(PROVIDERS.gemini);

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

/*
 * sessionStorage が使えるかどうかを確かめてから返す。
 *
 * プライベートモード等では window.sessionStorage への参照そのものが
 * 例外を投げるブラウザがあるため、KeyStore の localStorage 参照
 * （public/auth/keystore.js の getStorage）と同じ形で防御する。
 */
function getSessionStorage() {
  try {
    return window.sessionStorage ?? null;
  } catch {
    return null;
  }
}

/*
 * AI議事録アプリ（meeting-minutes）への引継ぎ。
 *
 * 結果テキスト（タイムスタンプ付きならそのまま）を sessionStorage へ保存し、
 * 同一タブで ../meeting-minutes/ へ遷移する。window.open は使わない。
 * sessionStorage はタブごとに独立しており、別タブで開くと meeting-minutes 側が
 * 引継ぎデータを読めないため（meeting-minutes-requirements-v1.md §5-3）。
 *
 * URLのクエリ・ハッシュへ本文を載せない（同 §5-1）。遷移先は相対パスの固定文字列のみ。
 */
function onCreateMinutes() {
  const snapshot = getState();
  const durationSec = snapshot.file?.durationSec;

  const result = saveHandoff(
    {
      transcript: el.result.value,
      metadata: {
        title: snapshot.file?.name ?? '',
        durationSeconds: Number.isFinite(durationSec) ? durationSec : undefined,
      },
    },
    { storage: getSessionStorage() },
  );

  if (!result.ok) {
    showToast(
      result.reason === HandoffResultReason.STORAGE_UNAVAILABLE
        ? 'AI議事録アプリへ引き継げませんでした。この端末では一時保存ができないようです。'
        : 'AI議事録アプリへ引き継げませんでした。文字起こし結果をご確認ください。',
    );
    return;
  }

  window.location.href = '../meeting-minutes/';
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

  /*
   * よく使う入力元（端末／Googleドライブ）の選択。
   * ここでは主要/補助の強調度の切替と設定の保存だけを行い、OAuth認可は
   * 起動しない（認可は「Google Driveから選択」ボタン押下 = onDriveButtonClick でのみ）。
   */
  el.sourceLocal.addEventListener('change', () => {
    applyFileSourceEmphasis('local');
    saveSettings({ fileSource: 'local' });
  });
  el.sourceDrive.addEventListener('change', () => {
    applyFileSourceEmphasis('drive');
    saveSettings({ fileSource: 'drive' });
  });

  el.modeLocal.addEventListener('change', () => {
    update({ mode: 'local', errorMessage: null });
    saveSettings({ mode: 'local' });
  });
  el.modeGemini.addEventListener('change', () => {
    update({ mode: 'gemini', errorMessage: null });
    /* Gemini モードに入った時点でキーの有無を確かめ、案内を出し分ける。 */
    refreshKeyState();
    /* 利用者がこの画面で明示的にGeminiモードへ切り替えた操作なので、接続状態も確かめ直す。 */
    void refreshGeminiConnectionStatus();
    saveSettings({ mode: 'gemini' });
  });

  el.language.addEventListener('change', () => saveSettings({ language: el.language.value }));

  el.whisperModel.addEventListener('change', () => {
    updateWhisperModelNote();
    saveSettings({ whisperModelId: el.whisperModel.value });
  });

  el.geminiModel.addEventListener('change', () => {
    saveSettings({ geminiModelId: el.geminiModel.value });
  });

  el.timestamps.addEventListener('change', () => {
    onTimestampToggle();
    saveSettings({ withTimestamps: el.timestamps.checked });
  });

  /*
   * ポータルの別タブでキーを設定して戻ってきたときに拾う。
   * KeyStore の有無を見るだけで、値は読まない。
   */
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      refreshKeyState();
    }
  });
  window.addEventListener('focus', () => refreshKeyState());

  el.start.addEventListener('click', () => void onStart());
  el.cancel.addEventListener('click', onCancel);

  el.result.addEventListener('input', () => update({ result: el.result.value }));
  el.copy.addEventListener('click', () => void onCopy());
  el.download.addEventListener('click', onDownload);
  el.saveDrive.addEventListener('click', () => void onSaveToDrive());
  el.clearResult.addEventListener('click', onClearResult);
  el.createMinutes.addEventListener('click', onCreateMinutes);
  el.speakerApply.addEventListener('click', onSpeakerReplace);

  /*
   * ページを離れるときに後始末をする。
   * APIキーはこの画面が保持していない（KeyStore の外へ出さない）ため、
   * ここで消すものは無い。
   */
  window.addEventListener('pagehide', () => {
    abortController?.abort();
    disposeWorker();
    releaseObjectUrl();
  });
}

async function init() {
  /*
   * ポータル認証の確認。共通実装の guardPage() を使う（独自実装は禁止）。
   * 静的配信のため HTML と JS の取得自体は防げない。Drive のデータを
   * 守っているのは OAuth であって、このガードではない（SECURITY_NOTES.md）。
   * 未ログイン時は guardPage() がログイン画面へ遷移させるので、ここで止める。
   */
  const user = await guardPage({ next: 'portal' });

  if (!user) {
    return;
  }

  cacheElements();

  if (!el.app) {
    return;
  }

  /*
   * 保存済みの選択・設定を復元する（音声ファイル本体・APIキーは対象外）。
   * populateSelects より前に読み、プルダウンの初期選択へ反映する。
   */
  const savedSettings = loadSettings();
  applySavedSettings(savedSettings);
  populateSelects(savedSettings);
  bindEvents();
  subscribe(render);
  /*
   * キーの有無の初期判定（render も内側で走る）。値は読まない。
   * 有無は初回なので必ず接続確認（refreshGeminiConnectionStatus）が走る
   * （lastKnownKeyPresence の初期値が null のため）。
   */
  refreshKeyState();

  /* 認証が確認できてから中身を出す。hidden を外すのはここだけ。 */
  const main = document.getElementById('at-main');

  if (main) {
    main.hidden = false;
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => void init(), { once: true });
} else {
  void init();
}

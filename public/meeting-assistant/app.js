/*
 * Meeting Assistant の画面制御。
 * innerHTML は使わない。外から来た値は textContent / createElement だけ。
 *
 * ------------------------------------------------------------------
 * 録音の行き先
 * ------------------------------------------------------------------
 *   PC ブラウザ / スマートフォンブラウザ
 *     Recorder（AudioWorklet → Worker → OPFS）で確定 → 保存待ち台帳（pending-store.js）
 *     → Drive へアップロード → 台帳と OPFS から削除 → 文字起こし・議事録
 *   ネイティブ（Capacitor。現フェーズは停止中だが経路は残す）
 *     NativeRecorder → 端末ファイル → Drive
 *
 * 録音の確定は「録音停止」ボタン以外（上限・中断・容量不足・マイク切断）でも
 * 起きる。どの経路でも onFinalized に集約し、Drive へ上げ終わるまで録音を消さない。
 * ------------------------------------------------------------------
 */

import { KeyStore, PROVIDERS, isKeyStoreAvailable } from './keystore.js';
import { addKind, loadKinds, removeKind } from './kinds.js';

import {
  DRIVE_RECORD_PATH,
  DRIVE_VOICE_PATH,
  GEMINI_API_KEY_URL,
  MAX_SECONDS,
  MP3_MIME,
  OAUTH,
  formatFolderPath,
} from './config.js';
import { AppError, ErrorCode, describeError } from './errors.js';
import { buildRecordingFileName } from './filename.js';
import {
  consumeRedirectResult,
  currentToken,
  forgetToken,
  hasValidToken,
  preloadGis,
  requestAccess,
  tokenRemainingSeconds,
} from './oauth.js';
import {
  downloadFile,
  fileViewUrl,
  listRecordMarkdown,
  listVoiceAudio,
  resolveRecordFolder,
  resolveVoiceFolder,
  saveMarkdown,
  uploadResumable,
} from './drive.js';
import { findMatchingMarkdown, isProcessed, toMarkdownFileName } from './markdown.js';
import { isMockGeminiEnabled, runGeminiPipeline } from './pipeline.js';
import { canCaptureTabAudio, startOnlineMix } from './mix.js';
import { createDocumentPip, isDocumentPipSupported } from './pip.js';
import {
  LOCAL_KEPT_DRIVE_FAILED,
  NATIVE_AUDIO_MIME,
  getNativeStatus,
  isNativePlatform,
  isNativeRecorderAvailable,
  listPendingNativeRecordings,
  markNativeUploadFailed,
  markNativeUploaded,
  readNativeChunk,
  startNativeRecording,
  stopNativeRecording,
} from './native-bridge.js';
import {
  applyUploadFailure,
  createRecordingId,
  elapsedSecondsFrom,
  isPendingUpload,
} from './recording-checkpoint.js';
import {
  discardButtonLabel,
  discardConfirmText,
  formatPendingTitle,
  pendingHeading,
  retryButtonLabel,
  saveButtonLabel,
  visiblePendingRecordings,
} from './pending-recordings.js';
import { createBrowserEntry, createPendingStore, isBrowserEntry } from './pending-store.js';
import {
  canOfferRemote,
  isMobileBrowser,
  isStandaloneDisplay,
  prefersRedirectAuth,
} from './platform.js';
import { createWakeLockKeeper } from './wake-lock.js';
import { formatDuration } from './recorder/capabilities.js';
import { cleanupStaleFiles, deleteRecording, getRecordingFile } from './recorder/opfs-storage.js';
import { Recorder, RecorderState } from './recorder/recorder.js';

const OVERWRITE_CONFIRM = 'すでに議事録があります。再生成しますか？';
const REMOTE_PC_ONLY = 'Remote録音はパソコン版で利用できます。';
const SAVED_LOCAL_CONNECT = '録音を端末に保存しました。「Driveへ保存」を押して Google と連携し、保存してください。';
const NOT_CONNECTED_RECORDING = 'Google 未連携のまま録音します。停止後に「Driveへ保存」から連携できます。';

const el = {
  main: document.getElementById('ma-main'),
  message: document.getElementById('ma-message'),
  pickList: document.getElementById('pick-list'),
  pickEmpty: document.getElementById('pick-empty'),
  pickRun: document.getElementById('pick-run'),
  recList: document.getElementById('rec-list'),
  recEmpty: document.getElementById('rec-empty'),
  setKeyState: document.getElementById('set-key-state'),
  setKeyInput: document.getElementById('set-key-input'),
  setKeyLink: document.getElementById('set-key-link'),
  setGoogleState: document.getElementById('set-google-state'),
  setGoogleLink: document.getElementById('set-google-link'),
  setGoogleRelink: document.getElementById('set-google-relink'),
  setGoogleRedirectNote: document.getElementById('set-google-redirect-note'),
  procFile: document.getElementById('proc-file'),
  procStatus: document.getElementById('proc-status'),
  doneText: document.getElementById('done-text'),
  doneOpen: document.getElementById('done-open'),
  offIndicator: document.getElementById('off-indicator'),
  offIndicatorText: document.getElementById('off-indicator-text'),
  offTimer: document.getElementById('off-timer'),
  offLimit: document.getElementById('off-limit'),
  offStart: document.getElementById('off-start'),
  offStop: document.getElementById('off-stop'),
  offPip: document.getElementById('off-pip'),
  offPipUnsupported: document.getElementById('off-pip-unsupported'),
  offStatus: document.getElementById('off-status'),
  offMobileHint: document.getElementById('off-mobile-hint'),
  onConsent: document.getElementById('on-consent'),
  onUnsupported: document.getElementById('on-unsupported'),
  onIndicator: document.getElementById('on-indicator'),
  onIndicatorText: document.getElementById('on-indicator-text'),
  onTimer: document.getElementById('on-timer'),
  onLimit: document.getElementById('on-limit'),
  onStart: document.getElementById('on-start'),
  onStop: document.getElementById('on-stop'),
  onPip: document.getElementById('on-pip'),
  onPipUnsupported: document.getElementById('on-pip-unsupported'),
  onStatus: document.getElementById('on-status'),
};

const screens = {};
for (const node of document.querySelectorAll('[data-screen]')) {
  screens[node.getAttribute('data-screen')] = node;
}

/* 実行環境。起動時に一度だけ決める。 */
const env = Object.freeze({
  native: isNativePlatform(),
  mobile: isMobileBrowser(),
  standalone: isStandaloneDisplay(),
});

const state = {
  selectedAudio: null,
  voiceFiles: [],
  recordFiles: [],
  voiceFolderId: null,
  recordFolderId: null,
  recorder: null,
  mix: null,
  mode: null,
  recordingMeta: null,
  recordingStartedAt: null,
  nativeRecording: null,
  /* このセッションで利用者が Google 連携を断った。録音開始のたびに再要求しない。 */
  authDeclined: false,
};

const recorderView = {
  offline: { recording: false, seconds: 0, status: '', error: '' },
  online: { recording: false, seconds: 0, status: '', error: '' },
};

const pendingStore = createPendingStore();
const wakeLock = createWakeLockKeeper();

const pip = createDocumentPip({
  onStop() {
    const mode = state.mode === 'online' ? 'online' : 'offline';
    stopRecording(mode).catch((error) => {
      setRecordingMetaDisabled(mode, false);
      showMessage(describeAppError(error), true);
      showScreen(mode);
    });
  },
});

/* ---------- 環境 ---------- */

function remoteAvailable() {
  return canOfferRemote({
    native: env.native,
    mobile: env.mobile,
    canCaptureTab: canCaptureTabAudio(),
  });
}

function shouldRedirectAuth() {
  return prefersRedirectAuth({ native: env.native, standalone: env.standalone });
}

function authOptions(resume = null, prompt = '') {
  return {
    prompt,
    resume,
    redirect: shouldRedirectAuth(),
    allowRedirectFallback: OAUTH.redirectFallback === true && !env.native,
  };
}

/* ---------- 共通 UI ---------- */

function showMessage(text, isError = false) {
  if (!text) {
    el.message.hidden = true;
    el.message.textContent = '';
    el.message.classList.remove('vr-message--error');
    return;
  }

  el.message.hidden = false;
  el.message.textContent = text;
  el.message.classList.toggle('vr-message--error', isError);
}

function showScreen(name) {
  Object.entries(screens).forEach(([key, node]) => {
    node.hidden = key !== name;
  });
}

const HISTORY_SCREENS = new Set(['home', 'offline', 'online', 'pick', 'records']);

function hashScreen() {
  const hash = String(globalThis.location?.hash ?? '').replace(/^#/, '');
  return screens[hash] ? hash : '';
}

function enterScreen(name) {
  if (name === 'online' && !remoteAvailable()) {
    showMessage(REMOTE_PC_ONLY, true);
    name = 'home';
  }

  showScreen(name);

  if (name === 'online' || name === 'offline') {
    fillKindSelects();
  }

  if (name === 'online') {
    const ok = canCaptureTabAudio();
    el.onUnsupported.hidden = ok;
    el.onStart.disabled = !ok;
  }

  if (name === 'pick') {
    refreshDriveLists({ screen: 'pick' })
      .then(() => {
        state.selectedAudio = null;
        renderAudioList();
      })
      .catch((error) => {
        showMessage(describeAppError(error), true);
      });
  }

  if (name === 'records') {
    refreshDriveLists({ screen: 'records' })
      .then(renderRecordList)
      .catch((error) => {
        showMessage(describeAppError(error), true);
      });
  }
}

function navigateTo(name) {
  showMessage('');

  if (name === 'home') {
    if (history.state?.screen && history.state.screen !== 'home') {
      history.back();
      return;
    }

    enterScreen('home');
    history.replaceState({ screen: 'home' }, '', `${location.pathname}${location.search}`);
    return;
  }

  enterScreen(name);

  if (HISTORY_SCREENS.has(name) && history.state?.screen !== name) {
    history.pushState({ screen: name }, '', `${location.pathname}${location.search}#${name}`);
  }
}

/* 履歴を進めずにホームへ戻す（処理の結果を伝えるとき）。 */
function goHomeFlat() {
  showScreen('home');
  history.replaceState({ screen: 'home' }, '', `${location.pathname}${location.search}`);
}

function setStep(name, label, kind = '') {
  const node = document.querySelector(`[data-step="${name}"]`);

  if (!node) {
    return;
  }

  node.textContent = label;
  if (kind) {
    node.dataset.kind = kind;
  } else {
    delete node.dataset.kind;
  }
}

function resetSteps() {
  setStep('audio', '待機');
  setStep('transcribe', '待機');
  setStep('minutes', '待機');
  setStep('save', '待機');
}

function formatWhen(iso) {
  if (!iso) {
    return '日時不明';
  }

  const date = new Date(iso);

  if (Number.isNaN(date.getTime())) {
    return '日時不明';
  }

  return date.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
}

/* ---------- 設定 ---------- */

function keyConfigured() {
  return isKeyStoreAvailable() && KeyStore.has(PROVIDERS.gemini);
}

function refreshKeyState() {
  const configured = keyConfigured();
  el.setKeyState.textContent = configured ? '設定済み' : '未設定';
  el.setKeyState.dataset.state = configured ? 'ok' : 'off';
  el.setKeyInput.value = '';
}

function refreshGoogleState() {
  if (!el.setGoogleState) {
    return;
  }

  const connected = hasValidToken();
  const minutes = Math.floor(tokenRemainingSeconds() / 60);
  el.setGoogleState.textContent = connected ? `連携済み（残り約${minutes}分）` : '未連携';
  el.setGoogleState.dataset.state = connected ? 'ok' : 'off';

  if (el.setGoogleLink) {
    el.setGoogleLink.hidden = connected;
  }

  if (el.setGoogleRelink) {
    el.setGoogleRelink.hidden = !connected;
  }

  if (el.setGoogleRedirectNote) {
    el.setGoogleRedirectNote.hidden = !shouldRedirectAuth();
  }
}

function openHomeSettings({ openKey = false } = {}) {
  const home = document.getElementById('home-settings');

  if (home) {
    home.open = true;
  }

  refreshKeyState();
  refreshGoogleState();
  renderKindSettings();
  closeSettingsAccordions();

  if (openKey) {
    const keyAcc = document.getElementById('set-key-acc');

    if (keyAcc) {
      keyAcc.open = true;
    }
  }
}

function closeSettingsAccordions() {
  ['set-google-acc', 'set-key-acc', 'set-kind-acc'].forEach((id) => {
    const acc = document.getElementById(id);

    if (acc) {
      acc.open = false;
    }
  });
}

function fillKindSelect(select) {
  if (!select) {
    return;
  }

  const current = select.value;
  const kinds = loadKinds();
  select.replaceChildren();

  const empty = document.createElement('option');
  empty.value = '';
  empty.textContent = '未選択';
  select.append(empty);

  for (const name of kinds) {
    const option = document.createElement('option');
    option.value = name;
    option.textContent = name;
    select.append(option);
  }

  select.value = kinds.includes(current) ? current : '';
}

function fillKindSelects() {
  fillKindSelect(document.getElementById('on-kind'));
  fillKindSelect(document.getElementById('off-kind'));
}

function renderKindSettings() {
  const list = document.getElementById('set-kind-list');
  const empty = document.getElementById('set-kind-empty');
  const count = document.getElementById('set-kind-count');
  const kinds = loadKinds();

  if (count) {
    count.textContent = kinds.length === 0 ? '未登録' : `${kinds.length}種類登録済み`;
  }

  list.replaceChildren();
  empty.hidden = kinds.length > 0;

  for (const name of kinds) {
    const item = document.createElement('li');
    item.className = 'ma-item ma-item--split';

    const label = document.createElement('span');
    label.className = 'ma-item__name';
    label.textContent = name;

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'ma-button ma-button--ghost ma-button--small';
    remove.textContent = '削除';
    remove.addEventListener('click', () => {
      if (!window.confirm(`「${name}」を削除しますか？`)) {
        return;
      }

      removeKind(name);
      renderKindSettings();
      fillKindSelects();
    });

    item.append(label, remove);
    list.append(item);
  }
}

/* ---------- Google ---------- */

/*
 * resume はリダイレクト方式で Google から戻ったあとの再開先
 * （{ screen, action }。トークンは含めない）。ポップアップ方式では使わない。
 */
async function ensureGoogle(resume = null) {
  if (!hasValidToken()) {
    await requestAccess(authOptions(resume));
    refreshGoogleState();
  }

  return { accessToken: currentToken() };
}

async function withGoogleRetry(task, resume = null) {
  try {
    return await task(await ensureGoogle(resume));
  } catch (error) {
    if (error?.code === 'OAUTH_EXPIRED') {
      forgetToken();
      refreshGoogleState();
      return task(await ensureGoogle(resume));
    }

    throw error;
  }
}

function fillPaths() {
  const voice = formatFolderPath(DRIVE_VOICE_PATH);
  const record = formatFolderPath(DRIVE_RECORD_PATH);

  document.querySelectorAll('[data-voice-path]').forEach((node) => {
    node.textContent = voice;
  });
  document.querySelectorAll('[data-record-path]').forEach((node) => {
    node.textContent = record;
  });
}

/* ---------- Drive 一覧 ---------- */

function renderAudioList() {
  el.pickList.replaceChildren();
  el.pickEmpty.hidden = state.voiceFiles.length > 0;
  el.pickRun.disabled = state.selectedAudio === null;

  for (const file of state.voiceFiles) {
    const item = document.createElement('li');
    item.className = 'ma-item';
    item.dataset.selected = state.selectedAudio?.id === file.id ? 'true' : 'false';

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ma-item-button';

    const name = document.createElement('div');
    name.className = 'ma-item__name';
    name.textContent = file.name;

    const meta = document.createElement('div');
    meta.className = 'ma-item__meta';

    const when = document.createElement('span');
    when.textContent = formatWhen(file.modifiedTime || file.createdTime);

    const badge = document.createElement('span');
    badge.className = 'ma-badge';
    const processed = isProcessed(file.name, state.recordFiles);
    badge.dataset.kind = processed ? 'done' : 'todo';
    badge.textContent = processed ? '処理済み' : '未処理';

    meta.append(when, badge);
    button.append(name, meta);
    button.addEventListener('click', () => {
      state.selectedAudio = file;
      renderAudioList();
    });

    item.append(button);
    el.pickList.append(item);
  }
}

function renderRecordList() {
  el.recList.replaceChildren();
  el.recEmpty.hidden = state.recordFiles.length > 0;

  for (const file of state.recordFiles) {
    const item = document.createElement('li');
    item.className = 'ma-item';

    const name = document.createElement('div');
    name.className = 'ma-item__name';
    name.textContent = file.name;

    const meta = document.createElement('div');
    meta.className = 'ma-item__meta';

    const when = document.createElement('span');
    when.textContent = formatWhen(file.modifiedTime || file.createdTime);

    const link = document.createElement('a');
    link.className = 'ma-open-link';
    link.href = fileViewUrl(file);
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = 'Markdownを開く';

    meta.append(when, link);
    item.append(name, meta);
    el.recList.append(item);
  }
}

async function refreshDriveLists(resume = null) {
  const result = await withGoogleRetry(async (auth) => {
    const voice = await listVoiceAudio(auth, state.voiceFolderId);
    const record = await listRecordMarkdown(auth, state.recordFolderId);
    return { voice, record };
  }, resume);

  state.voiceFolderId = result.voice.folderId;
  state.recordFolderId = result.record.folderId;
  state.voiceFiles = result.voice.files;
  state.recordFiles = result.record.files;
}

/* ---------- 録音 UI ---------- */

function setRecorderUi(mode, patch = {}) {
  const key = mode === 'online' ? 'online' : 'offline';
  const view = recorderView[key];

  if (typeof patch.recording === 'boolean') {
    view.recording = patch.recording;
  }
  if (typeof patch.seconds === 'number') {
    view.seconds = patch.seconds;
  }
  if (typeof patch.status === 'string') {
    view.status = patch.status;
  }
  if (typeof patch.error === 'string') {
    view.error = patch.error;
  }

  const prefix = key === 'online' ? 'on' : 'off';
  const indicator = el[`${prefix}Indicator`];
  const text = el[`${prefix}IndicatorText`];
  const timer = el[`${prefix}Timer`];
  const start = el[`${prefix}Start`];
  const stop = el[`${prefix}Stop`];
  const statusNode = el[`${prefix}Status`];

  indicator.dataset.state = view.recording ? 'recording' : 'idle';
  text.textContent = view.recording ? '録音中' : '待機中';
  timer.textContent = formatDuration(view.seconds);
  start.disabled = view.recording;
  stop.disabled = !view.recording;
  statusNode.textContent = view.error || view.status;

  pip.sync({
    mode: key,
    recording: view.recording,
    seconds: view.seconds,
    status: view.status,
    error: view.error,
  });
}

function stopReasonText(reason) {
  switch (reason) {
    case 'limit':
      return '上限時間に達したため録音を停止しました。ここまでの録音を保存します。';
    case 'interrupted':
      return '録音が中断されました（着信・画面ロック・アプリ切替など）。ここまでの録音を保存します。';
    case 'capacity':
      return '端末の空き容量が不足したため録音を停止しました。ここまでの録音を保存します。';
    case 'backpressure':
      return '処理が追いつかないため録音を停止しました。ここまでの録音を保存します。';
    case 'mic-ended':
      return 'マイクが切断されたため録音を停止しました。ここまでの録音を保存します。';
    default:
      return '保存しています。';
  }
}

function warningText(kind) {
  switch (kind) {
    case 'limit-approaching':
      return 'まもなく上限です。';
    case 'hidden':
      return '画面が隠れています。録音が止まる場合があります。';
    case 'capacity-low':
      return '端末の空き容量が少なくなっています。';
    case 'backpressure':
      return '処理が遅れています。';
    default:
      return '録音に注意が必要です。';
  }
}

function releaseRecordingResources() {
  state.mix?.stop();
  state.mix = null;
  state.recorder = null;
  pip.close();
  wakeLock.stop().catch(() => {});
}

/*
 * Recorder を組み立てる。
 * 停止の理由（手動・上限・中断・容量・マイク切断）によらず、確定は onFinalized に集約する。
 */
function attachRecorder(mode) {
  return new Recorder({
    onTick(elapsedSeconds) {
      setRecorderUi(mode, { recording: true, seconds: elapsedSeconds });
    },
    onWarning(kind) {
      setRecorderUi(mode, { recording: true, status: warningText(kind) });
    },
    onStopped(reason) {
      setRecorderUi(mode, { recording: false, status: stopReasonText(reason), error: '' });
    },
    onFinalized(result) {
      handleFinalizedRecording(mode, result).catch((error) => {
        releaseRecordingResources();
        setRecordingMetaDisabled(mode, false);
        showMessage(describeAppError(error), true);
        showScreen(mode);
      });
    },
    onError(code) {
      releaseRecordingResources();
      setRecordingMetaDisabled(mode, false);
      const message = describeAppError({ code });
      showMessage(message, true);
      setRecorderUi(mode, { recording: false, error: message });
    },
  });
}

/* ---------- 保存待ち（ブラウザ録音） ---------- */

/*
 * 確定した録音を台帳へ載せ、Google 連携済みならそのまま Drive へ上げる。
 * 未連携なら台帳に残してホームへ戻す（連携は利用者の押下から始める。
 * 停止処理のあとでは利用者操作の猶予が切れており、ポップアップが阻止されるため）。
 */
async function handleFinalizedRecording(mode, result) {
  const meta = state.recordingMeta ?? readRecordingMeta(mode);
  const startedAt = state.recordingStartedAt ?? new Date();
  releaseRecordingResources();
  setRecordingMetaDisabled(mode, false);
  setRecorderUi(mode, {
    recording: false,
    seconds: Number(result.durationSeconds) || 0,
    status: '端末に保存しました。',
    error: '',
  });

  const file = result.file;

  if (!file || file.size === 0) {
    await deleteRecording(result.fileName);
    throw new AppError(ErrorCode.ENCODE_FAILED, 'empty_recording');
  }

  const entry = createBrowserEntry({
    recordingId: createRecordingId(),
    fileName: buildRecordingFileName({ method: mode, ...meta, date: startedAt }),
    localPath: result.fileName,
    sizeBytes: Number(result.sizeBytes) || file.size,
    durationSeconds: Number(result.durationSeconds) || 0,
    mimeType: file.type || MP3_MIME,
    method: mode,
    organization: meta.organization,
    personName: meta.personName,
    kind: meta.kind,
    startedAt: startedAt.toISOString(),
  });

  pendingStore.put(entry);
  await refreshPendingRecordings();

  if (hasValidToken()) {
    await uploadBrowserRecordingAndProcess(entry, { file });
    return;
  }

  goHomeFlat();
  showMessage(SAVED_LOCAL_CONNECT);
}

/*
 * 台帳の 1 件を Drive へ上げ、成功したら台帳と OPFS から消して議事録処理へ進む。
 * 失敗したら台帳を「失敗」にして残す。
 */
async function uploadBrowserRecordingAndProcess(entry, { file = null } = {}) {
  showScreen('process');
  el.procFile.textContent = entry.fileName;
  resetSteps();
  setStep('audio', '処理中');
  el.procStatus.textContent = '音声を Drive へ保存しています。';

  let blob = file;

  if (!blob) {
    try {
      blob = await getRecordingFile(entry.localPath);
    } catch {
      /* OPFS から消えている。台帳だけ残っても意味がないので落とす。 */
      pendingStore.remove(entry.recordingId);
      await refreshPendingRecordings();
      throw new AppError(ErrorCode.UPLOAD_FAILED, 'local_file_missing');
    }
  }

  let uploaded;

  try {
    uploaded = await withGoogleRetry(async (auth) => {
      const folderId = state.voiceFolderId ?? await resolveVoiceFolder(auth);
      state.voiceFolderId = folderId;
      return uploadResumable({
        file: blob,
        name: entry.fileName,
        folderId,
        mimeType: entry.mimeType || blob.type || MP3_MIME,
      }, auth);
    }, { screen: 'home', action: { type: 'upload', recordingId: entry.recordingId } });
  } catch (error) {
    pendingStore.put(applyUploadFailure(entry, error?.code || ''));
    await refreshPendingRecordings();
    goHomeFlat();
    showMessage(`${describeAppError(error)} ${LOCAL_KEPT_DRIVE_FAILED}`, true);
    return;
  }

  pendingStore.remove(entry.recordingId);
  await deleteRecording(entry.localPath);
  await refreshPendingRecordings();

  setStep('audio', '完了', 'ok');
  await processExistingAudio({
    id: uploaded.id,
    name: uploaded.name,
    webViewLink: uploaded.webViewLink,
    url: uploaded.url,
    blob,
  }, { skipProcessedCheck: true });
}

async function discardBrowserRecording(entry) {
  if (!window.confirm(discardConfirmText(entry))) {
    return;
  }

  pendingStore.remove(entry.recordingId);
  await deleteRecording(entry.localPath);
  await refreshPendingRecordings();
  showMessage('録音を端末から削除しました。');
}

/* 台帳に載っているのに OPFS に無いものを落とす（起動時に一度）。 */
async function dropMissingBrowserEntries() {
  for (const entry of pendingStore.list().filter(isBrowserEntry)) {
    try {
      await getRecordingFile(entry.localPath);
    } catch {
      pendingStore.remove(entry.recordingId);
    }
  }
}

/* ---------- 議事録処理 ---------- */

async function processExistingAudio(file, { skipProcessedCheck = false } = {}) {
  showScreen('process');
  el.procFile.textContent = file.name;

  if (!skipProcessedCheck) {
    resetSteps();
    const matching = findMatchingMarkdown(file.name, state.recordFiles);

    if (matching && !window.confirm(OVERWRITE_CONFIRM)) {
      showScreen('pick');
      showMessage('再生成をキャンセルしました。');
      return;
    }
  }

  if (!isMockGeminiEnabled() && !keyConfigured()) {
    goHomeFlat();
    openHomeSettings({ openKey: true });
    showMessage('音声は Drive に保存しました。議事録を作るには Gemini APIキーを設定してください。', true);
    return;
  }

  setStep('transcribe', '処理中');
  el.procStatus.textContent = isMockGeminiEnabled()
    ? 'モック結果で Markdown を組み立てています。'
    : '文字起こしと議事録を生成しています。';

  const blob = file.blob ?? await withGoogleRetry(
    (auth) => downloadFile(file.id, auth, file.mimeType),
    { screen: 'pick' },
  );
  const audioUrl = file.url || file.webViewLink || fileViewUrl(file);
  const apiKey = keyConfigured() ? KeyStore.get(PROVIDERS.gemini) : '';

  setStep('audio', '完了', 'ok');

  const result = await runGeminiPipeline({
    blob,
    displayName: file.name,
    apiKey,
    audioUrl,
    onProgress(progress) {
      if (progress?.phase === 'transcribing' || progress?.phase === 'mock') {
        setStep('transcribe', '処理中');
      }

      if (progress?.phase === 'minutes') {
        setStep('transcribe', '完了', 'ok');
        setStep('minutes', '処理中');
      }

      if (progress?.phase === 'markdown') {
        setStep('minutes', '完了', 'ok');
      }
    },
  });

  setStep('transcribe', '完了', 'ok');
  setStep('minutes', '完了', 'ok');
  setStep('save', '処理中');
  el.procStatus.textContent = 'Markdown を Drive へ保存しています。';

  const markdownName = toMarkdownFileName(file.name);
  const matching = findMatchingMarkdown(file.name, state.recordFiles);

  const saved = await withGoogleRetry(async (auth) => {
    const folderId = state.recordFolderId ?? await resolveRecordFolder(auth);
    state.recordFolderId = folderId;
    return saveMarkdown({
      text: result.markdown,
      fileName: markdownName,
      folderId,
      existingId: matching?.id ?? null,
    }, auth);
  }, { screen: 'pick' });

  state.recordFiles = [
    {
      id: saved.id,
      name: saved.name,
      webViewLink: saved.url,
      modifiedTime: new Date().toISOString(),
    },
    ...state.recordFiles.filter((item) => item.id !== saved.id && item.name !== saved.name),
  ];

  setStep('save', '完了', 'ok');
  el.doneText.textContent = result.mock
    ? 'モック結果の Markdown を保存しました。'
    : '議事録を保存しました。';
  el.doneOpen.href = saved.url || '#';
  showScreen('done');
}

/* ---------- 録音開始・停止 ---------- */

function readRecordingMeta(mode) {
  const prefix = mode === 'online' ? 'on' : 'off';
  return {
    organization: document.getElementById(`${prefix}-org`)?.value ?? '',
    personName: document.getElementById(`${prefix}-person`)?.value ?? '',
    kind: document.getElementById(`${prefix}-kind`)?.value ?? '',
  };
}

function setRecordingMetaDisabled(mode, disabled) {
  const prefix = mode === 'online' ? 'on' : 'off';
  ['org', 'person', 'kind'].forEach((name) => {
    const input = document.getElementById(`${prefix}-${name}`);
    if (input) {
      input.disabled = disabled;
    }
  });
}

/*
 * 録音開始の押下で先に Google と連携しておく。
 * 停止後に連携を求めると利用者操作の猶予が切れてポップアップが阻止されるため、
 * 押下の文脈にあるうちに済ませる。断られても録音は始める（台帳に残る）。
 * リダイレクト方式ではこの時点で Google へ移動し、戻ったあとに改めて押してもらう。
 */
async function connectBeforeRecording(mode) {
  if (env.native || hasValidToken() || state.authDeclined) {
    return;
  }

  try {
    await requestAccess(authOptions({ screen: mode }));
    refreshGoogleState();
  } catch (error) {
    if (error?.code === ErrorCode.OAUTH_REDIRECT_FAILED) {
      throw error;
    }

    state.authDeclined = true;
    setRecorderUi(mode, { status: NOT_CONNECTED_RECORDING });
  }
}

let nativeElapsedTimer = null;
let nativeVisibilityHandler = null;

function stopNativeElapsedWatch() {
  if (nativeElapsedTimer) {
    clearInterval(nativeElapsedTimer);
    nativeElapsedTimer = null;
  }

  if (nativeVisibilityHandler) {
    document.removeEventListener('visibilitychange', nativeVisibilityHandler);
    nativeVisibilityHandler = null;
  }
}

async function pollNativeElapsed() {
  if (document.visibilityState !== 'visible') {
    return;
  }

  const status = await getNativeStatus();
  const recording = status.state === 'RECORDING' || status.state === 'INTERRUPTED';
  const seconds = Number(status.elapsedSeconds);
  setRecorderUi('offline', {
    recording,
    seconds: Number.isFinite(seconds) ? seconds : elapsedSecondsFrom(status.startedAt),
    status: status.state === 'INTERRUPTED' ? '録音が中断されました。' : '',
  });
}

function startNativeElapsedWatch() {
  stopNativeElapsedWatch();

  const arm = () => {
    if (document.visibilityState === 'visible') {
      if (!nativeElapsedTimer) {
        nativeElapsedTimer = setInterval(() => {
          pollNativeElapsed().catch(() => {});
        }, 1000);
      }

      pollNativeElapsed().catch(() => {});
      return;
    }

    if (nativeElapsedTimer) {
      clearInterval(nativeElapsedTimer);
      nativeElapsedTimer = null;
    }
  };

  nativeVisibilityHandler = arm;
  document.addEventListener('visibilitychange', arm);
  arm();
}

async function startOffline() {
  showMessage('');
  state.mode = 'offline';
  state.recordingMeta = readRecordingMeta('offline');
  state.recordingStartedAt = new Date();
  el.offLimit.textContent = `上限 ${formatDuration(MAX_SECONDS)}`;
  setRecorderUi('offline', { recording: false, seconds: 0, status: '準備しています。', error: '' });
  setRecordingMetaDisabled('offline', true);

  if (isNativeRecorderAvailable()) {
    const started = await startNativeRecording(state.recordingMeta);
    state.nativeRecording = started;
    state.recorder = null;
    setRecorderUi('offline', { recording: true, seconds: 0, error: '' });
    startNativeElapsedWatch();
    return;
  }

  state.nativeRecording = null;
  state.recorder = attachRecorder('offline');
  await state.recorder.start();
  setRecorderUi('offline', { recording: true, seconds: 0, error: '' });
  wakeLock.start().catch(() => {});
}

async function startOnline() {
  showMessage('');

  if (!canCaptureTabAudio()) {
    el.onUnsupported.hidden = false;
    el.onStart.disabled = true;
    return;
  }

  if (!el.onConsent.checked) {
    showMessage('録音を始める前に、同意の確認にチェックしてください。', true);
    return;
  }

  state.mode = 'online';
  state.recordingMeta = readRecordingMeta('online');
  state.recordingStartedAt = new Date();
  setRecordingMetaDisabled('online', true);
  state.mix = await startOnlineMix();
  state.recorder = attachRecorder('online');
  el.onLimit.textContent = `上限 ${formatDuration(MAX_SECONDS)}`;

  let status = '';

  if (!state.mix.hasTabAudio) {
    status = 'タブの音声を共有していないため、マイクのみで録音します。';
  } else if (state.mix.micDenied) {
    status = 'マイクを取得できなかったため、タブ音声のみで録音します。';
  }

  await state.recorder.start({ stream: state.mix.stream });
  setRecorderUi('online', { recording: true, seconds: 0, status, error: '' });
  wakeLock.start().catch(() => {});
}

/* 手動停止。確定後の流れは attachRecorder の onFinalized に集約している。 */
async function stopRecording(mode) {
  const recorder = state.recorder;

  if (!recorder || recorder.state !== RecorderState.RECORDING) {
    return;
  }

  setRecorderUi(mode, { status: '保存しています。', error: '' });
  recorder.stop('manual');
}

/* ---------- ネイティブ録音（現フェーズは停止中。経路は保持） ---------- */

async function uploadNativeFile(item) {
  const uploaded = await withGoogleRetry(async (auth) => {
    const folderId = state.voiceFolderId ?? await resolveVoiceFolder(auth);
    state.voiceFolderId = folderId;
    return uploadResumable({
      name: item.fileName,
      folderId,
      mimeType: NATIVE_AUDIO_MIME,
      size: item.sizeBytes,
      readChunk: (offset, size) => readNativeChunk(item.localPath, offset, size),
    }, auth);
  });

  await markNativeUploaded(item.recordingId, {
    driveFileId: uploaded.id,
    driveUrl: uploaded.url || uploaded.webViewLink,
  });

  return uploaded;
}

async function stopNativeOffline() {
  stopNativeElapsedWatch();
  const finalized = await stopNativeRecording();
  state.nativeRecording = null;
  setRecorderUi('offline', {
    recording: false,
    seconds: Number(finalized.durationSeconds) || 0,
    status: '端末に保存しました。',
    error: '',
  });
  setRecordingMetaDisabled('offline', false);

  try {
    await uploadNativeFile({
      recordingId: finalized.recordingId,
      fileName: finalized.fileName,
      localPath: finalized.path || finalized.localPath,
      sizeBytes: finalized.sizeBytes,
    });
    showMessage('Driveへ保存しました。');
  } catch (error) {
    await markNativeUploadFailed(finalized.recordingId, error.code || '');
    showMessage(LOCAL_KEPT_DRIVE_FAILED, true);
  }

  await refreshPendingRecordings();
}

async function retryNativeUpload(item) {
  showMessage('');

  try {
    await uploadNativeFile(item);
    showMessage('Driveへ保存しました。');
  } catch (error) {
    await markNativeUploadFailed(item.recordingId, error.code || '');
    showMessage(LOCAL_KEPT_DRIVE_FAILED, true);
  }

  await refreshPendingRecordings();
}

/* ---------- 保存待ち一覧（ブラウザ＋ネイティブ） ---------- */

function renderPendingRecordings(items) {
  const section = document.getElementById('pending-recordings');
  const list = document.getElementById('pending-list');
  const title = document.getElementById('pending-title');

  if (!section || !list) {
    return;
  }

  const visible = visiblePendingRecordings(items);
  list.replaceChildren();

  if (visible.length === 0) {
    section.hidden = true;
    return;
  }

  section.hidden = false;
  if (title) {
    title.textContent = pendingHeading();
  }

  for (const item of visible) {
    const row = document.createElement('li');
    row.className = 'ma-item ma-item--stack';

    const name = document.createElement('div');
    name.className = 'ma-item__name';
    name.textContent = formatPendingTitle(item);
    row.append(name);

    const sub = document.createElement('div');
    sub.className = 'ma-item__sub';
    const parts = [formatDuration(item.durationSeconds)];

    if (item.startedAt) {
      parts.push(formatWhen(item.startedAt));
    }

    if (item.driveUploadState === 'failed') {
      parts.push('前回の保存に失敗');
    }

    sub.textContent = parts.join(' / ');
    row.append(sub);

    const actions = document.createElement('div');
    actions.className = 'ma-item__actions';

    if (isBrowserEntry(item)) {
      const discard = document.createElement('button');
      discard.type = 'button';
      discard.className = 'ma-button ma-button--ghost ma-button--small';
      discard.textContent = discardButtonLabel();
      discard.addEventListener('click', () => {
        discardBrowserRecording(item).catch((error) => {
          showMessage(describeAppError(error), true);
        });
      });
      actions.append(discard);

      const save = document.createElement('button');
      save.type = 'button';
      save.className = 'ma-button ma-button--small';
      save.textContent = saveButtonLabel(item);
      save.addEventListener('click', () => {
        showMessage('');
        uploadBrowserRecordingAndProcess(item).catch((error) => {
          goHomeFlat();
          showMessage(describeAppError(error), true);
        });
      });
      actions.append(save);
    } else if (isPendingUpload(item)) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'ma-button ma-button--small';
      button.textContent = retryButtonLabel();
      button.addEventListener('click', () => {
        retryNativeUpload(item).catch((error) => {
          showMessage(describeAppError(error), true);
        });
      });
      actions.append(button);
    }

    row.append(actions);
    list.append(row);
  }
}

async function refreshPendingRecordings() {
  const browserItems = pendingStore.list().filter(isBrowserEntry);
  let nativeItems = [];

  if (isNativeRecorderAvailable()) {
    try {
      nativeItems = await listPendingNativeRecordings();
    } catch {
      nativeItems = [];
    }
  }

  renderPendingRecordings([...nativeItems, ...browserItems]);
}

/* ---------- 環境に応じた見せ方 ---------- */

function applyNativeShell() {
  const native = env.native;
  const noRemote = !remoteAvailable();
  document.body.classList.toggle('ma-native', native);
  document.body.classList.toggle('ma-no-remote', noRemote);
  document.body.classList.toggle('ma-mobile', env.mobile);
  document.body.classList.toggle('ma-standalone', env.standalone);

  const remote = document.querySelector('.ma-circle--remote');
  if (remote) {
    remote.hidden = noRemote;
  }

  if (el.offMobileHint) {
    el.offMobileHint.hidden = !(env.mobile && !native);
  }
}

function describeAppError(error) {
  if (!error) {
    return '処理に失敗しました。';
  }

  if (error instanceof AppError) {
    return describeError(error);
  }

  if (error.code === 'API_KEY_MISSING' || error.code === 'KEY_MISSING') {
    return 'Gemini APIキーを設定してください。';
  }

  if (error.code === 'DISPLAY_UNSUPPORTED') {
    return 'この端末ではオンライン録音を使えません。';
  }

  if (error.name === 'NotAllowedError' || error.code === 'PERMISSION_DENIED') {
    return '録音の許可が得られませんでした。画面共有またはマイクの許可を確認してください。';
  }

  if (error.code === 'NO_DEVICE') {
    return 'マイクが見つかりません。マイクを接続してから、もう一度お試しください。';
  }

  if (error.code === 'DEVICE_BUSY') {
    return 'マイクを他のアプリが使用しています。他のアプリを閉じてから、もう一度お試しください。';
  }

  if (error.code === 'UNSUPPORTED' || error.code === 'SYNC_ACCESS_UNSUPPORTED') {
    return 'このブラウザは録音に対応していません。最新の Chrome / Safari / Edge でお試しください。';
  }

  if (error.code === 'INSUFFICIENT_STORAGE') {
    return '端末の空き容量が足りないため録音を開始できません。不要なファイルを削除してから、もう一度お試しください。';
  }

  return '処理に失敗しました。もう一度お試しください。';
}

/* ---------- イベント ---------- */

document.addEventListener('click', (event) => {
  const go = event.target.closest('[data-go]')?.getAttribute('data-go');

  if (!go) {
    return;
  }

  navigateTo(go);
});

el.offStart.addEventListener('click', () => {
  connectBeforeRecording('offline')
    .then(() => startOffline())
    .catch((error) => {
      stopNativeElapsedWatch();
      state.nativeRecording = null;
      releaseRecordingResources();
      setRecordingMetaDisabled('offline', false);
      showMessage(describeAppError(error), true);
      setRecorderUi('offline', { recording: false, error: describeAppError(error) });
    });
});

el.offStop.addEventListener('click', () => {
  if (state.nativeRecording) {
    stopNativeOffline().catch((error) => {
      setRecordingMetaDisabled('offline', false);
      showMessage(describeAppError(error), true);
      showScreen('offline');
    });
    return;
  }

  stopRecording('offline').catch((error) => {
    setRecordingMetaDisabled('offline', false);
    showMessage(describeAppError(error), true);
    showScreen('offline');
  });
});

el.onStart.addEventListener('click', () => {
  connectBeforeRecording('online')
    .then(() => startOnline())
    .catch((error) => {
      releaseRecordingResources();
      setRecordingMetaDisabled('online', false);
      showMessage(describeAppError(error), true);
      setRecorderUi('online', { recording: false, error: describeAppError(error) });
    });
});

el.onStop.addEventListener('click', () => {
  stopRecording('online').catch((error) => {
    setRecordingMetaDisabled('online', false);
    showMessage(describeAppError(error), true);
    showScreen('online');
  });
});

function openPip(mode) {
  const key = mode === 'online' ? 'online' : 'offline';
  pip.open({ mode: key, ...recorderView[key] }).catch(() => {
    showMessage('最前面表示を開けませんでした。', true);
  });
}

el.offPip?.addEventListener('click', () => {
  openPip('offline');
});

el.onPip?.addEventListener('click', () => {
  openPip('online');
});

document.getElementById('pick-refresh').addEventListener('click', () => {
  refreshDriveLists({ screen: 'pick' })
    .then(() => {
      renderAudioList();
      showMessage('');
    })
    .catch((error) => {
      showMessage(describeAppError(error), true);
    });
});

el.pickRun.addEventListener('click', () => {
  if (!state.selectedAudio) {
    return;
  }

  processExistingAudio(state.selectedAudio).catch((error) => {
    showMessage(describeAppError(error), true);
    showScreen('pick');
  });
});

document.getElementById('rec-refresh').addEventListener('click', () => {
  refreshDriveLists({ screen: 'records' })
    .then(() => {
      renderRecordList();
      showMessage('');
    })
    .catch((error) => {
      showMessage(describeAppError(error), true);
    });
});

function linkGoogle({ relink = false } = {}) {
  showMessage('');

  if (relink) {
    forgetToken();
    refreshGoogleState();
  }

  requestAccess(authOptions({ screen: 'home' }, relink ? 'select_account' : ''))
    .then(() => {
      refreshGoogleState();
      showMessage('Google と連携しました。');
    })
    .catch((error) => {
      refreshGoogleState();
      showMessage(describeAppError(error), true);
    });
}

el.setGoogleLink?.addEventListener('click', () => {
  linkGoogle();
});

el.setGoogleRelink?.addEventListener('click', () => {
  linkGoogle({ relink: true });
});

document.getElementById('set-key-save').addEventListener('click', () => {
  const value = el.setKeyInput.value;

  if (!isKeyStoreAvailable()) {
    showMessage('この端末ではAPIキーを保存できません。', true);
    return;
  }

  if (!KeyStore.set(PROVIDERS.gemini, value)) {
    showMessage('APIキーを保存できませんでした。入力内容を確認してください。', true);
    return;
  }

  refreshKeyState();
  showMessage('APIキーを保存しました。');
});

document.getElementById('set-key-remove').addEventListener('click', () => {
  KeyStore.remove(PROVIDERS.gemini);
  refreshKeyState();
  showMessage('APIキーを削除しました。');
});

document.getElementById('set-kind-add').addEventListener('click', () => {
  const input = document.getElementById('set-kind-input');
  const result = addKind(input.value);

  if (!result.ok) {
    showMessage(result.reason === 'duplicate' ? '同じ対応種別は追加できません。' : '対応種別を入力してください。', true);
    return;
  }

  input.value = '';
  renderKindSettings();
  fillKindSelects();
  showMessage('対応種別を追加しました。');
});

function applyPipAvailability() {
  const supported = isDocumentPipSupported();
  if (el.offPip) {
    el.offPip.hidden = !supported;
  }
  if (el.onPip) {
    el.onPip.hidden = !supported;
  }
  if (el.offPipUnsupported) {
    el.offPipUnsupported.hidden = supported;
  }
  if (el.onPipUnsupported) {
    el.onPipUnsupported.hidden = supported;
  }
}

/* リダイレクト方式で Google から戻ったあとの続き。 */
function resumeAfterRedirect(redirect) {
  if (!redirect?.ok) {
    return;
  }

  showMessage('Google と連携しました。');
  const action = redirect.resume?.action;

  if (action?.type === 'upload' && action.recordingId) {
    const entry = pendingStore.get(action.recordingId);

    if (entry) {
      uploadBrowserRecordingAndProcess(entry).catch((error) => {
        goHomeFlat();
        showMessage(describeAppError(error), true);
      });
    }
  }
}

function boot() {
  /* 最初に fragment を読む。#access_token=… を画面名として扱わないため。 */
  const redirect = consumeRedirectResult();

  fillPaths();
  el.setKeyLink.href = GEMINI_API_KEY_URL;
  el.offLimit.textContent = `上限 ${formatDuration(MAX_SECONDS)}`;
  el.onLimit.textContent = `上限 ${formatDuration(MAX_SECONDS)}`;
  refreshKeyState();
  refreshGoogleState();
  fillKindSelects();
  applyPipAvailability();
  applyNativeShell();

  if (!env.native) {
    preloadGis();
  }

  /*
   * OPFS の掃除。保存待ち台帳に載っている確定ファイルは残し、
   * それ以外の .part（異常終了の名残）だけ消す。
   */
  dropMissingBrowserEntries()
    .then(() => cleanupStaleFiles({ keep: pendingStore.keepFileNames() }))
    .catch(() => {})
    .finally(() => {
      refreshPendingRecordings().catch(() => {});
    });

  const homeSettings = document.getElementById('home-settings');
  homeSettings?.addEventListener('toggle', () => {
    if (homeSettings.open) {
      refreshKeyState();
      refreshGoogleState();
      renderKindSettings();
      closeSettingsAccordions();
    }
  });

  window.addEventListener('popstate', (event) => {
    enterScreen(event.state?.screen || hashScreen() || 'home');
  });

  let initial = hashScreen() || 'home';

  if (redirect) {
    if (redirect.ok) {
      const wanted = redirect.resume?.screen;
      initial = wanted && screens[wanted] && wanted !== 'process' && wanted !== 'done' ? wanted : 'home';
    } else {
      initial = 'home';
      showMessage(describeError(new AppError(redirect.code)), true);
    }
  }

  const url = initial === 'home'
    ? `${location.pathname}${location.search}`
    : `${location.pathname}${location.search}#${initial}`;
  history.replaceState({ screen: initial }, '', url);

  document.getElementById('home-reload')?.addEventListener('click', () => {
    window.location.reload();
  });

  el.main.hidden = false;
  enterScreen(initial);
  resumeAfterRedirect(redirect);
}

boot();

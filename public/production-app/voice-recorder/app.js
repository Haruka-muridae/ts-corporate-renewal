/*
 * ブラウザ録音アプリの画面制御。
 * 要件: docs/requirements/mvp-requirements.md（§FR-01〜§FR-08 / §7 / §9）
 *
 * ------------------------------------------------------------------
 * innerHTML を使わない
 * ------------------------------------------------------------------
 * ファイル名は利用者の入力、フォルダ名とファイルURLは Google の応答である。
 * どちらも外から来た値として扱う。
 * 文字を入れるのは textContent、要素を作るのは createElement だけにする。
 * ------------------------------------------------------------------
 *
 * ------------------------------------------------------------------
 * ここに秘密を残さない（§8.1）
 * ------------------------------------------------------------------
 * OAuth トークンは oauth.js のクロージャにあり、この画面は呼び出しの直前に
 * 取り出して渡すだけにする。変数へ写したり、状態オブジェクトへ入れたりしない。
 * ------------------------------------------------------------------
 */

import { guardPage } from '../../auth/session.js';
import { setScreenDepth } from '../../auth/config.js';

import {
  DRIVE_NAMES,
  MAX_SECONDS,
  MIN_FREE_BYTES,
  SCREEN_DEPTH,
  formatFolderPath,
  isOauthConfigured,
} from './config.js';

import { AppError, ErrorCode, PROGRESS, describeError } from './errors.js';
import { buildDefaultFileName, resolveFileName } from './filename.js';
import { currentToken, forgetToken, hasValidToken, requestAccess } from './oauth.js';
import { fetchAccountEmail, pickAvailableName, resolveTargetFolder, uploadResumable } from './drive.js';

import {
  checkFreeSpace,
  detectSupport,
  estimateMp3Bytes,
  formatBytes,
  formatDuration,
  unmetReasonMessages,
} from './recorder/capabilities.js';

import { Recorder, RecorderErrorCode, RecorderState } from './recorder/recorder.js';
import { cleanupStaleFiles } from './recorder/opfs-storage.js';

import { currentEventIdFromUrl, mountNotifier } from './notifier-panel.js';

setScreenDepth(SCREEN_DEPTH);

/* ---------- 要素 ---------- */

const el = {};

for (const id of [
  'vr-main',
  'vr-state-auth', 'vr-state-oauth', 'vr-state-folder', 'vr-state-device',
  'vr-device-reason', 'vr-connect',
  'vr-time', 'vr-limit', 'vr-indicator', 'vr-indicator-label',
  'vr-size', 'vr-free', 'vr-start', 'vr-stop',
  'vr-save-panel', 'vr-player', 'vr-recorded-meta',
  'vr-name', 'vr-save-folder', 'vr-save-hint', 'vr-save', 'vr-discard',
  'vr-progress-panel', 'vr-progress', 'vr-progress-title', 'vr-progress-bar', 'vr-progress-text',
  'vr-result-panel', 'vr-result-name', 'vr-result-folder', 'vr-result-link', 'vr-again',
  'vr-message', 'vr-error', 'vr-retry-actions',
]) {
  el[id] = document.getElementById(id);
}

/* ---------- 画面の状態 ---------- */

/*
 * 未保存の録音があるか。離脱警告（§7）と破棄の判断に使う。
 * 録音中も「未保存」に含める。
 */
const current = {
  file: null,          // 確定した MP3（File）
  fileName: null,      // OPFS 上の一時ファイル名
  previewUrl: null,    // createObjectURL の戻り。必ず revoke する
  defaultName: null,   // 保存名の初期値（§FR-07）
  saved: false,
};

/*
 * 連携したアカウントの表示名。**トークンそのものは持たない**（§8.1）。
 *
 * これを持つ理由は「一度も連携していない」と「連携したが期限が切れた」を
 * 区別するため。区別しないと、90分録音のあとに保存できなくなった利用者へ
 * 「連携してください」としか言えず、何が起きたのか分からない。
 */
const google = { linkedAccount: null };

function hasUnsavedRecording() {
  if (recorder && recorder.state === RecorderState.RECORDING) {
    return true;
  }
  return current.file !== null && !current.saved;
}

/* ---------- 画面へ出す ---------- */

function setState(node, text, kind = '') {
  node.textContent = text;
  node.dataset.kind = kind;
}

function showMessage(text) {
  el['vr-message'].textContent = text;
  el['vr-message'].hidden = text === '';
}

function showError(text) {
  el['vr-error'].textContent = text;
  el['vr-error'].hidden = text === '';
}

function clearError() {
  showError('');
  el['vr-retry-actions'].replaceChildren();
  el['vr-retry-actions'].hidden = true;
}

/*
 * 例外を §9 の文言に変換して出す。message は画面へ出さない。
 *
 * ------------------------------------------------------------------
 * 生の例外はコンソールへ残す
 * ------------------------------------------------------------------
 * describeError は知らないコードを既定文言（「処理に失敗しました」）へ丸める。
 * これは利用者には親切だが、**実装のバグまで同じ文言に化ける。**
 * 実際、要素の取得漏れによる TypeError がこの文言になって原因が見えなくなった。
 *
 * そこで生の例外は console.error へ出す。トークンは例外に入れていないため、
 * ここから漏れることはない（§8.1）。
 * ------------------------------------------------------------------
 */
function reportError(error) {
  console.error('[voice-recorder]', error);
  showError(describeError(error));
}

function setIndicator(state, label) {
  el['vr-indicator'].dataset.state = state;
  el['vr-indicator-label'].textContent = label;
}

/* ---------- 準備の確認 ---------- */

/*
 * 保存先は「マイドライブ ＞ TSAM AI ＞ Voice Recorder」で固定（§FR-03）。
 * フォルダIDは持たない。実体の確認と作成は保存時に行うため、
 * ここで出すのは「どこへ入るか」の予告にすぎない。
 */
function showFolder() {
  const path = formatFolderPath(DRIVE_NAMES.root, DRIVE_NAMES.app);
  setState(el['vr-state-folder'], path, 'ok');
  el['vr-save-folder'].textContent = `保存先: ${path}`;
}

/* 空き容量の表示を更新する。開始前・停止後に呼ぶ。 */
async function refreshFreeSpace() {
  const space = await checkFreeSpace();
  el['vr-free'].textContent = formatBytes(space.freeBytes);
  return space;
}

/*
 * 端末が録音に対応しているかを確認する（§8.3）。
 * このアプリには代替モードが無いため、非対応ならここで操作を止める。
 */
async function checkDevice() {
  const { supported, reasons } = detectSupport();

  if (!supported) {
    setState(el['vr-state-device'], '利用できません', 'error');
    el['vr-device-reason'].textContent = unmetReasonMessages(reasons).join(' ');
    el['vr-device-reason'].hidden = false;
    el['vr-start'].disabled = true;
    return false;
  }

  const space = await refreshFreeSpace();

  if (!space.ok) {
    setState(el['vr-state-device'], '空き容量が不足しています', 'error');
    el['vr-device-reason'].textContent =
      `録音の開始には ${formatBytes(MIN_FREE_BYTES)} 以上の空き容量が必要です。`
      + '不要なファイルを削除してから、画面を再読み込みしてください。';
    el['vr-device-reason'].hidden = false;
    el['vr-start'].disabled = true;
    return false;
  }

  setState(el['vr-state-device'], '利用できます', 'ok');
  el['vr-device-reason'].hidden = true;
  el['vr-start'].disabled = false;
  return true;
}

/* ---------- 録音 ---------- */

let recorder = null;

/*
 * 録音側のエラーコードを §9 の表示用コードへ写す。
 * recorder.js は画面を知らないため、対応付けはこちらが持つ。
 */
function toAppErrorCode(code) {
  switch (code) {
    case RecorderErrorCode.PERMISSION_DENIED:
      return ErrorCode.MIC_DENIED;
    case RecorderErrorCode.NO_DEVICE:
    case RecorderErrorCode.DEVICE_BUSY:
      return ErrorCode.MIC_NOT_FOUND;
    case RecorderErrorCode.UNSUPPORTED_SAMPLE_RATE:
      return ErrorCode.UNSUPPORTED_SAMPLE_RATE;
    case RecorderErrorCode.INSUFFICIENT_STORAGE:
      return ErrorCode.STORAGE_LOW;
    case RecorderErrorCode.UNSUPPORTED:
    case RecorderErrorCode.SYNC_ACCESS_UNSUPPORTED:
    case RecorderErrorCode.WORKLET_FAILED:
    case RecorderErrorCode.WORKER_FAILED:
      return ErrorCode.UNSUPPORTED_ENVIRONMENT;
    default:
      /* OPFS_FAILED / ENCODE_FAILED / FINALIZE_FAILED。
         変換は録音と同時に進むため、これらは「録音失敗」として扱う（§FR-06）。 */
      return ErrorCode.ENCODE_FAILED;
  }
}

/* 停止理由を利用者向けの一言にする。手動停止のときは何も出さない。 */
function describeStopReason(reason) {
  switch (reason) {
    case 'limit':
      return `上限の ${formatDuration(MAX_SECONDS)} に達したため、自動的に停止しました。`;
    case 'capacity':
      return '端末の空き容量が不足したため停止しました。ここまでの録音は保存できます。';
    case 'backpressure':
      return '端末の処理が追いつかなくなったため停止しました。ここまでの録音は保存できます。';
    case 'mic-ended':
      return 'マイクが切断されたため停止しました。ここまでの録音は保存できます。';
    case 'interrupted':
      return '音声の取り込みが中断されたため停止しました。ここまでの録音は保存できます。';
    default:
      return '';
  }
}

function describeWarning(kind) {
  switch (kind) {
    case 'limit-approaching':
      return `まもなく上限です。残り5分で自動的に停止します（上限 ${formatDuration(MAX_SECONDS)}）。`;
    case 'capacity-low':
      return '端末の空き容量が少なくなっています。まもなく自動停止する場合があります。';
    case 'backpressure':
      return '端末の処理が遅れています。他のアプリを閉じると改善する場合があります。';
    case 'hidden':
      return 'この画面が非表示になっています。録音を続けるには画面を表示したままにしてください。';
    case 'interrupted':
      return '音声の取り込みが中断されました。';
    default:
      return '';
  }
}

function createRecorder() {
  return new Recorder({
    onStateChange: (state) => {
      const recording = state === RecorderState.RECORDING;
      el['vr-start'].hidden = recording;
      el['vr-stop'].hidden = !recording;
      el['vr-start'].disabled = recording;

      if (recording) {
        setIndicator('recording', '録音中');
      } else if (state === RecorderState.STOPPING) {
        setIndicator('stopped', '停止処理中');
      } else if (state === RecorderState.FINALIZED) {
        setIndicator('stopped', '停止');
      } else {
        setIndicator('idle', '待機中');
      }
    },

    onTick: (elapsed) => {
      el['vr-time'].textContent = formatDuration(elapsed);
      /* §7 の「推定ファイルサイズ」。経過秒 × ビットレートで見積もる。 */
      el['vr-size'].textContent = formatBytes(estimateMp3Bytes(elapsed));
    },

    onWarning: (kind) => {
      const text = describeWarning(kind);
      if (text !== '') {
        showMessage(text);
      }
    },

    onStopped: (reason) => {
      const text = describeStopReason(reason);
      showMessage(text === '' ? '録音を停止しました。' : text);
    },

    onFinalized: (result) => showFinalized(result),

    onError: (code) => {
      setIndicator('idle', '待機中');
      el['vr-start'].hidden = false;
      el['vr-stop'].hidden = true;
      el['vr-start'].disabled = false;
      reportError(new AppError(toAppErrorCode(code)));
    },
  });
}

async function startRecording() {
  clearError();
  showMessage('');

  if (!recorder) {
    recorder = createRecorder();
  }

  try {
    await recorder.start();
    showMessage('録音しています。');
  } catch (error) {
    reportError(new AppError(toAppErrorCode(error?.code)));
  }
}

function stopRecording() {
  recorder?.stop('manual');
}

/* ---------- 停止後：プレビューと保存の準備 ---------- */

function releasePreview() {
  if (current.previewUrl !== null) {
    URL.revokeObjectURL(current.previewUrl);
    current.previewUrl = null;
  }
  el['vr-player'].removeAttribute('src');
  el['vr-player'].load();
}

/*
 * 確定した MP3 を画面へ出す（§FR-05 / §FR-07）。
 * プレビューは blob: URL。ページを離れる前に必ず revoke する。
 */
function showFinalized(result) {
  current.file = result.file;
  current.fileName = result.fileName;
  current.saved = false;

  releasePreview();

  if (result.file) {
    current.previewUrl = URL.createObjectURL(result.file);
    el['vr-player'].src = current.previewUrl;
  }

  /*
   * 初期値の基準は「録音開始時刻」（§FR-07）。停止時刻ではない。
   * 開始ボタンを押した時点で current.defaultName に入れてある。
   * null になるのは想定外の経路だけで、そのときは停止時刻で代用する。
   */
  current.defaultName = current.defaultName ?? buildDefaultFileName(new Date());
  el['vr-name'].value = current.defaultName;
  el['vr-name'].placeholder = current.defaultName;

  el['vr-recorded-meta'].textContent =
    `録音時間 ${formatDuration(result.durationSeconds)} ／ サイズ ${formatBytes(result.sizeBytes)}`;

  el['vr-save-panel'].hidden = false;
  el['vr-size'].textContent = formatBytes(result.sizeBytes);

  /* 連携がまだなら保存ボタンは押せない。その旨もここで案内する。 */
  updateSaveButton();
  refreshFreeSpace();
}

/* 破棄（§FR-05）。OPFS の一時ファイルも消す。 */
async function discardRecording() {
  clearError();
  releasePreview();

  try {
    await recorder?.discard();
  } catch (error) {
    console.warn('[voice-recorder] 破棄に失敗', error);
  }

  current.file = null;
  current.fileName = null;
  current.defaultName = null;
  current.saved = false;

  el['vr-save-panel'].hidden = true;
  el['vr-result-panel'].hidden = true;
  el['vr-progress-panel'].hidden = true;
  el['vr-name'].value = '';
  el['vr-time'].textContent = formatDuration(0);
  el['vr-size'].textContent = formatBytes(0);
  el['vr-start'].hidden = false;
  el['vr-stop'].hidden = true;
  el['vr-start'].disabled = false;
  setIndicator('idle', '待機中');

  updateSaveButton();
  showMessage('録音を破棄しました。');
  await refreshFreeSpace();
}

/* ---------- Google 連携（§FR-02） ---------- */

/*
 * 連携する。アプリを開いただけでは呼ばない（§FR-02）。
 * ポップアップを開くため、必ず利用者の操作から呼ぶこと。
 */
async function connectGoogle() {
  clearError();
  el['vr-connect'].disabled = true;
  setState(el['vr-state-oauth'], '連携しています…');

  try {
    await requestAccess();

    /* 表示用。取れなくても保存はできる（drive.js の注記を参照）。 */
    const email = await fetchAccountEmail({ accessToken: currentToken() });
    google.linkedAccount = email ?? '連携済み';
    el['vr-connect'].textContent = '連携しなおす';
  } catch (error) {
    forgetToken();
    google.linkedAccount = null;
    reportError(error);
  } finally {
    el['vr-connect'].disabled = false;
    updateSaveButton();
  }
}

/*
 * 連携状態の表示を、いまのトークンの状態に合わせる。
 *
 * ------------------------------------------------------------------
 * 期限切れを「連携済み」のまま見せない
 * ------------------------------------------------------------------
 * アクセストークンの寿命は約1時間で、**録音の上限（90分）より短い。**
 * 先に連携して90分録音すると、停止した時点では必ず切れている。
 *
 * ここでメールアドレスを出したままにすると、利用者は連携できているのに
 * 保存だけ押せない、という説明のつかない状態を見ることになる。
 * 実際に90分の通し確認でこれを踏んだ。
 * ------------------------------------------------------------------
 */
function refreshOauthState() {
  /* クライアントID未設定のときは、その表示を上書きしない（連携しようがない）。 */
  if (!isOauthConfigured()) {
    return false;
  }

  if (google.linkedAccount === null) {
    setState(el['vr-state-oauth'], '未連携', '');
    return false;
  }

  if (!hasValidToken()) {
    setState(el['vr-state-oauth'], '認証の期限切れ', 'error');
    return false;
  }

  setState(el['vr-state-oauth'], google.linkedAccount, 'ok');
  return true;
}

/*
 * 保存ボタンの可否。録音があり、かつ有効なトークンがあるときだけ押せる。
 *
 * 案内は専用の #vr-save-hint に出すこと。共有の #vr-message を使うと、
 * 「上限に達したので自動停止した」という停止理由（§FR-04）を上書きしてしまう。
 */
function updateSaveButton() {
  const linked = refreshOauthState();
  const hasRecording = current.file !== null && !current.saved;

  el['vr-save'].disabled = !(hasRecording && linked);

  let hint = '';

  if (hasRecording && !linked) {
    /*
     * 期限切れの文言は errors.js を使い回す。同じ事象を2か所で別々に書かない。
     * 「連携しなおす」というボタン名まで含めて1か所に持つ。
     */
    hint = google.linkedAccount === null
      ? '保存するには、先に「連携する」でGoogleドライブと連携してください。'
      : describeError(new AppError(ErrorCode.OAUTH_EXPIRED));
  }

  el['vr-save-hint'].textContent = hint;
  el['vr-save-hint'].hidden = hint === '';
}

/* ---------- 保存（§FR-08） ---------- */

function setProgress(stage, ratio = null) {
  el['vr-progress-panel'].hidden = false;
  el['vr-progress-title'].textContent = stage;

  const percent = ratio === null ? 0 : Math.round(ratio * 100);
  el['vr-progress'].setAttribute('aria-valuenow', String(percent));
  el['vr-progress-bar'].style.width = `${percent}%`;
  el['vr-progress-text'].textContent = `${percent}%`;
}

/* 失敗時の再試行導線（§FR-08）。録音は残っているので、押せば同じ手順をやり直せる。 */
function showRetry(label, handler) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'auth-button';
  button.textContent = label;
  button.addEventListener('click', handler);

  el['vr-retry-actions'].replaceChildren(button);
  el['vr-retry-actions'].hidden = false;
}

function showResult({ name, url }) {
  el['vr-result-name'].textContent = name;
  el['vr-result-folder'].textContent = formatFolderPath(DRIVE_NAMES.root, DRIVE_NAMES.app);

  el['vr-result-link'].replaceChildren();

  if (url) {
    const link = document.createElement('a');
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = 'Driveで開く';
    el['vr-result-link'].append(link);
  } else {
    el['vr-result-link'].textContent = '（リンクを取得できませんでした）';
  }

  el['vr-result-panel'].hidden = false;
}

async function saveToDrive() {
  clearError();
  showMessage('');

  if (current.file === null) {
    return;
  }

  el['vr-save'].disabled = true;
  el['vr-discard'].disabled = true;

  try {
    setProgress(PROGRESS.PREPARING);

    /*
     * トークンは呼び出しの直前に取り出し、変数へ写さない（§8.1）。
     * 期限が切れていればここで OAUTH_EXPIRED になり、再連携の案内が出る。
     */
    const auth = { accessToken: currentToken() };

    setProgress(PROGRESS.RESOLVING_FOLDER);
    const folderId = await resolveTargetFolder(auth);

    /* 保存名の決定と、同名時の連番付与（§FR-07）。 */
    const desired = resolveFileName(el['vr-name'].value, current.defaultName);
    const finalName = await pickAvailableName(desired, folderId, auth);

    setProgress(PROGRESS.UPLOADING, 0);
    const result = await uploadResumable({
      file: current.file,
      name: finalName,
      folderId,
      onProgress: (sent, total) => setProgress(PROGRESS.UPLOADING, sent / total),
    }, auth);

    setProgress(PROGRESS.FINISHING, 1);

    /*
     * 保存が確定してから端末内の一時データを消す（§FR-08）。
     * 順序を逆にすると、削除後に保存が失敗したとき録音を失う。
     */
    current.saved = true;
    releasePreview();
    await recorder?.discard();

    el['vr-progress-panel'].hidden = true;
    el['vr-save-panel'].hidden = true;
    showMessage('');
    showResult({ name: result.name, url: result.url });
  } catch (error) {
    el['vr-progress-panel'].hidden = true;
    reportError(error);

    /* 認証切れは再連携から、それ以外は保存の再試行から。 */
    if (error instanceof AppError && error.code === ErrorCode.OAUTH_EXPIRED) {
      /* 状態表示は finally の updateSaveButton が「認証の期限切れ」へ更新する。 */
      forgetToken();
      showRetry('連携しなおす', connectGoogle);
    } else {
      showRetry('保存をやり直す', saveToDrive);
    }
  } finally {
    el['vr-discard'].disabled = false;
    updateSaveButton();
  }
}

/* ---------- 離脱警告（§7） ---------- */

/*
 * 未保存のまま閉じようとしたら警告する。
 * 文言はブラウザが決めるため、preventDefault と returnValue の設定だけ行う。
 */
function handleBeforeUnload(event) {
  if (!hasUnsavedRecording()) {
    return;
  }
  event.preventDefault();
  /* 一部のブラウザは returnValue が空でないことを条件にする。 */
  event.returnValue = '';
}

/* ---------- 起動 ---------- */

async function main() {
  /*
   * ポータル認証の確認（§FR-01）。
   * 共通実装の guardPage() を使う。独自実装は禁止。
   *
   * 静的配信のため、この画面のHTMLとJSの取得自体は防げない。
   * 守られているのは Drive のデータであり、それを守るのは OAuth である
   * （SECURITY_NOTES.md / CLAUDE.md）。
   *
   * ------------------------------------------------------------------
   * 戻り先は Portal ではなくこの画面にする
   * ------------------------------------------------------------------
   * カレンダー通知は `?eventId=` 付きでこの画面を開く。未ログインだと
   * ログイン画面を挟むが、そこで next を 'portal' にしていたため、
   * ログイン後に Portal へ着き、**どの予定の通知だったのかが消えていた**
   * （実機検証で確認）。
   *
   * eventId は guardPage() へ渡す。持ち回れるのは
   * session.js の画面ごとの許可リストに載せた値だけで、
   * 元URLをそのまま引き継ぐわけではない
   * （docs/specs/login-page-detailed-spec-v3.md §6）。
   * ------------------------------------------------------------------
   */
  const user = await guardPage({
    next: 'voiceRecorder',
    params: { eventId: currentEventIdFromUrl() },
  });

  if (!user) {
    return; /* すでにログイン画面へ遷移している。ここで描画を止める。 */
  }

  el['vr-main'].hidden = false;
  setState(el['vr-state-auth'], 'ログイン済み', 'ok');

  el['vr-limit'].textContent = `上限 ${formatDuration(MAX_SECONDS)}`;
  el['vr-time'].textContent = formatDuration(0);

  showFolder();

  /*
   * クライアントIDが未設定なら連携できない。
   * 「連携する」を押せる状態のまま失敗させず、ここで理由を出す。
   */
  if (!isOauthConfigured()) {
    setState(el['vr-state-oauth'], '設定が未完了です', 'error');
    el['vr-connect'].disabled = true;
  }

  /*
   * 異常終了で残った一時ファイルを削除する（§FR-08 / §10-14）。
   * 24時間の経過待ちはしない。復旧機能を持たないため、残存は名残とみなす。
   */
  cleanupStaleFiles().then(({ removed }) => {
    if (removed > 0) {
      console.info(`[voice-recorder] 前回の一時ファイルを${removed}件削除しました`);
    }
  });

  await checkDevice();

  /*
   * カレンダー通知（要件書 5.1）。
   *
   * ------------------------------------------------------------------
   * 録音より後に、失敗しても録音を止めない形で組み立てる
   * ------------------------------------------------------------------
   * 通知は録音の付随機能である。GAS が落ちていても、通知の設定が
   * 未完了でも、録音と保存は従来どおり使えなければならない。
   * したがって await せず、例外もここで握りつぶす。
   * ------------------------------------------------------------------
   */
  mountNotifier().catch((error) => {
    console.warn('[voice-recorder] カレンダー通知の初期化に失敗', error);
  });

  el['vr-start'].addEventListener('click', () => {
    /* 保存名の基準は録音開始時刻（§FR-07）。押した時点で確定させる。 */
    current.defaultName = buildDefaultFileName(new Date());
    startRecording();
  });
  el['vr-stop'].addEventListener('click', stopRecording);
  el['vr-discard'].addEventListener('click', discardRecording);
  el['vr-again'].addEventListener('click', discardRecording);
  el['vr-connect'].addEventListener('click', connectGoogle);
  el['vr-save'].addEventListener('click', saveToDrive);

  window.addEventListener('beforeunload', handleBeforeUnload);
  window.addEventListener('pagehide', () => {
    releasePreview();
    recorder?.dispose();
  });
}

main();

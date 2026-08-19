/*
 * 面談録音ツール
 * 画面遷移を状態機械として管理する。
 * 状態: idle / capture-guide / no-tab-audio / recording / done
 * （録音同意モーダルは idle 画面の上に重ねるオーバーレイとして扱う）
 *
 * 移植元: スタンドアロン版 interview-recorder リポジトリ
 * （/home/yuki9/projects/interview-recorder/public/app.js）。
 * 移植日 2026-08-18。
 *
 * ------------------------------------------------------------------
 * 移植にあたっての変更点（録音ロジック・同意ゲート・状態機械は不変）
 * ------------------------------------------------------------------
 * - IIFE ('use strict' + 即時関数) から ES module へ変換した。
 * - guardPage によるログイン確認を追加した（他の本番アプリと同じ約束）。
 *   認証確認が終わるまで #app-main を表示しない。
 * - MP3_BITRATE_KBPS / MP3_WORKLET_URL / PCM_FLUSH_SAMPLES / MIX_SOURCE_GAIN の
 *   定数を config.js へ移した（値そのものは変更していない）。
 * - 「開始画面の機能検出表示」（isBrowserSupported の判定と初期画面表示）を
 *   guard 通過後の init() 内へ移した。それ以外のイベントリスナー登録・
 *   状態機械・録音／MP3エンコード処理・ダウンロード処理は変更していない。
 * ------------------------------------------------------------------
 *
 * ------------------------------------------------------------------
 * v1.1（2026-08-19）で足したもの
 * ------------------------------------------------------------------
 * 結果画面からの Google ドライブ保存（仕様書 §4）。保存先はブラウザ録音
 * アプリ（voice-recorder）と同じ「マイドライブ ＞ TSAM AI ＞ Voice Recorder」で、
 * oauth.js / drive.js / filename.js は voice-recorder からの複製である。
 *
 * **録音同意モーダル・状態機械・ミックス処理・AudioWorklet は触っていない。**
 * 変えたのは保存の経路（Drive を追加）と保存名・ビットレートだけである。
 *
 * ローカルダウンロードは残してある。Drive 保存の失敗・未連携でも録音を
 * 手元へ退避できるようにするためで、記録情報 JSON と WebM 安全網は
 * ローカル専用のままにする（同じフォルダを文字起こしアプリが読みに来るため、
 * あの場所に音声（MP3）以外を置かない）。
 * ------------------------------------------------------------------
 */

import { guardPage } from '../../auth/session.js';
import { setScreenDepth } from '../../auth/config.js';
import {
  SCREEN_DEPTH,
  MP3_BITRATE_KBPS,
  MP3_WORKLET_URL,
  PCM_FLUSH_SAMPLES,
  MIX_SOURCE_GAIN,
  DRIVE_NAMES,
  JSON_EXTENSION,
  WEBM_EXTENSION,
  formatFolderPath,
  isOauthConfigured,
} from './config.js';
import { AppError, ErrorCode, PROGRESS, describeError } from './errors.js';
import { buildDefaultFileName, resolveFileName, withExtension } from './filename.js';
import { currentToken, forgetToken, hasValidToken, requestAccess } from './oauth.js';
import { fetchAccountEmail, pickAvailableName, resolveTargetFolder, uploadResumable } from './drive.js';

setScreenDepth(SCREEN_DEPTH);

var Screen = {
  IDLE: 'idle',
  CAPTURE_GUIDE: 'capture-guide',
  NO_TAB_AUDIO: 'no-tab-audio',
  RECORDING: 'recording',
  DONE: 'done'
};

// ---- DOM 参照 ----
var el = {
  screens: {},
  authLoading: document.getElementById('auth-loading'),
  appMain: document.getElementById('app-main'),

  btnStart: document.getElementById('btn-start'),
  idleError: document.getElementById('idle-error'),

  btnCaptureContinue: document.getElementById('btn-capture-continue'),
  btnCaptureCancel: document.getElementById('btn-capture-cancel'),

  btnRetryShare: document.getElementById('btn-retry-share'),
  btnMicOnly: document.getElementById('btn-mic-only'),

  recTimer: document.getElementById('rec-timer'),
  recWarning: document.getElementById('rec-warning'),
  btnStop: document.getElementById('btn-stop'),

  playback: document.getElementById('playback'),
  consentInfo: document.getElementById('consent-info'),
  mp3FallbackNote: document.getElementById('mp3-fallback-note'),
  btnDownloadAudio: document.getElementById('btn-download-audio'),
  btnDownloadJson: document.getElementById('btn-download-json'),
  btnDownloadWebmOriginal: document.getElementById('btn-download-webm-original'),
  btnRestart: document.getElementById('btn-restart'),

  // 保存名の編集（v1.2）
  inputPartner: document.getElementById('input-partner'),
  inputFileName: document.getElementById('input-filename'),

  // Google ドライブ保存（v1.1）
  btnSaveDrive: document.getElementById('btn-save-drive'),
  driveFolder: document.getElementById('drive-folder'),
  driveHint: document.getElementById('drive-hint'),
  driveProgressPanel: document.getElementById('drive-progress-panel'),
  driveProgress: document.getElementById('drive-progress'),
  driveProgressTitle: document.getElementById('drive-progress-title'),
  driveProgressBar: document.getElementById('drive-progress-bar'),
  driveProgressText: document.getElementById('drive-progress-text'),
  driveResultPanel: document.getElementById('drive-result-panel'),
  driveResultName: document.getElementById('drive-result-name'),
  driveResultFolder: document.getElementById('drive-result-folder'),
  driveResultAccount: document.getElementById('drive-result-account'),
  driveResultLink: document.getElementById('drive-result-link'),
  driveError: document.getElementById('drive-error'),
  driveRetryActions: document.getElementById('drive-retry-actions'),

  modalConsent: document.getElementById('modal-consent'),
  modalConsentDenied: document.getElementById('modal-consent-denied'),
  btnConsentYes: document.getElementById('btn-consent-yes'),
  btnConsentNo: document.getElementById('btn-consent-no')
};

document.querySelectorAll('.screen').forEach(function (node) {
  el.screens[node.dataset.screen] = node;
});

// ---- アプリ状態 ----
var state = createInitialState();

function createInitialState() {
  return {
    current: Screen.IDLE,
    consentConfirmedAt: null,
    startedAt: null,
    endedAt: null,
    displayStream: null,
    micStream: null,
    audioContext: null,
    mixNode: null,
    mediaRecorder: null,
    recordedChunks: [],
    mimeType: '',
    timerId: null,
    elapsedSeconds: 0,
    micDenied: false,
    hasTabAudio: false,
    audioBlob: null,
    audioUrl: null,
    // MP3 逐次エンコード用の状態
    mp3SampleRate: 0,
    mp3Encoder: null,
    mp3WorkletNode: null,
    mp3Chunks: [],
    mp3PcmQueue: [],
    mp3PcmQueueLength: 0,
    mp3Ready: false, // addModule + Mp3Encoder の初期化が完了しているか
    mp3Failed: false, // 生成過程で失敗が確定したか
    mp3Blob: null,
    mp3Url: null,
    finalFormat: 'webm', // 結果画面で確定した保存形式（'mp3' | 'webm'）
    // 保存名の初期値（v1.1、v1.2 で相手名を反映するようにした）。
    // 利用者が「ファイル名」欄を空にしたときの戻り先になる。
    defaultFileName: '',
    // Google ドライブ保存（v1.1）
    driveSaving: false, // 保存処理の実行中（連打の再入防止）
    driveSaved: false, // Drive への保存が完了したか
    // 連打・二重実行対策
    capturing: false, // 音声キャプチャ開始～録音セッション確立までの再入防止フラグ
    finalized: false, // finalizeRecording() の冪等ガード
    preserved: false, // 録音をどこか（この端末 or Drive）へ保存済みか
    recordingError: null // MediaRecorder の onerror で発生したエラーメッセージ
  };
}

// ---- 画面遷移 ----
function showScreen(name) {
  state.current = name;
  Object.keys(el.screens).forEach(function (key) {
    el.screens[key].hidden = key !== name;
  });
}

function showIdleError(message) {
  el.idleError.textContent = message;
  el.idleError.hidden = !message;
}

// ---- 対応ブラウザの機能検出 ----
// getDisplayMedia / getUserMedia / MediaRecorder / AudioContext のいずれかが
// 無い環境では、開始直後に同期 TypeError が発生して UI がデッドロックする
// おそれがあるため、起動時にまとめて検出し、開始ボタンをブロックする。
function isBrowserSupported() {
  return !!(
    navigator.mediaDevices &&
    typeof navigator.mediaDevices.getDisplayMedia === 'function' &&
    typeof navigator.mediaDevices.getUserMedia === 'function' &&
    typeof window.MediaRecorder !== 'undefined' &&
    (window.AudioContext || window.webkitAudioContext)
  );
}

// ---- モーダル制御 ----
var modalOpen = false;

function openModal() {
  modalOpen = true;
  el.modalConsentDenied.hidden = true;
  el.btnConsentYes.hidden = false;
  el.btnConsentNo.hidden = false;
  // [hidden] 属性の CSS 上の優先順位に加えて、二重防御として
  // 「いいえ」で無効化したボタンを再度有効に戻す。
  el.btnConsentYes.disabled = false;
  el.modalConsent.hidden = false;
  el.btnConsentYes.focus();
  document.addEventListener('keydown', onModalKeydown);
}

function closeModal() {
  modalOpen = false;
  el.modalConsent.hidden = true;
  document.removeEventListener('keydown', onModalKeydown);
  el.btnStart.focus();
}

function onModalKeydown(e) {
  if (e.key === 'Escape') {
    // Esc では「はい」扱いにせず、閉じるだけ。
    closeModal();
  }
}

el.modalConsent.addEventListener('click', function (e) {
  // 背景クリックでは「はい」扱いにせず、閉じるだけ。
  if (e.target === el.modalConsent) {
    closeModal();
  }
});

el.btnConsentYes.addEventListener('click', function () {
  state.consentConfirmedAt = new Date().toISOString();
  closeModal();
  showIdleError('');
  beginCapture();
});

el.btnConsentNo.addEventListener('click', function () {
  el.btnConsentYes.hidden = true;
  el.btnConsentNo.hidden = true;
  // [hidden] が効かない場合でもクリックできないよう、二重防御として無効化する。
  el.btnConsentYes.disabled = true;
  el.modalConsentDenied.hidden = false;
});

// 同意を得られなかった場合の案内内に「閉じる」導線がないため、
// 背景クリック・Esc で閉じられるようにしてある（仕様どおり「モーダルは閉じられる」）。
// 分かりやすさのため、案内メッセージ内クリックでも閉じられるようにする。
el.modalConsentDenied.addEventListener('click', function () {
  closeModal();
});

el.btnStart.addEventListener('click', function () {
  showIdleError('');
  openModal();
});

// ---- 3. 音声キャプチャ ----

function beginCapture() {
  showScreen(Screen.CAPTURE_GUIDE);
}

el.btnCaptureCancel.addEventListener('click', function () {
  resetToIdle();
});

el.btnCaptureContinue.addEventListener('click', function () {
  requestDisplayCapture();
});

// タブ音声なし画面のボタンを、再挑戦できる状態に戻す。
function resetNoTabAudioButtons() {
  el.btnRetryShare.disabled = false;
  el.btnMicOnly.disabled = false;
}

function requestDisplayCapture() {
  // 「共有ダイアログを開く」の連打によるキャプチャ処理の再入を防ぐ。
  if (state.capturing) {
    return;
  }
  state.capturing = true;
  el.btnCaptureContinue.disabled = true;
  try {
    navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
      .then(function (stream) {
        el.btnCaptureContinue.disabled = false;
        state.displayStream = stream;
        state.hasTabAudio = stream.getAudioTracks().length > 0;
        if (!state.hasTabAudio) {
          state.capturing = false;
          resetNoTabAudioButtons();
          showScreen(Screen.NO_TAB_AUDIO);
          return;
        }
        proceedToMicrophone();
      })
      .catch(function () {
        // 画面共有がキャンセルされた場合など。
        state.capturing = false;
        el.btnCaptureContinue.disabled = false;
        showScreen(Screen.IDLE);
        showIdleError('画面共有がキャンセルされました。もう一度お試しください。');
      });
  } catch (err) {
    // getDisplayMedia が同期的に例外を投げる非対応環境向けの保険。
    state.capturing = false;
    el.btnCaptureContinue.disabled = false;
    showScreen(Screen.IDLE);
    showIdleError('画面共有を開始できませんでした。もう一度お試しください。');
  }
}

el.btnRetryShare.addEventListener('click', function () {
  if (state.capturing) {
    return;
  }
  el.btnRetryShare.disabled = true;
  el.btnMicOnly.disabled = true;
  stopStream(state.displayStream);
  state.displayStream = null;
  showScreen(Screen.CAPTURE_GUIDE);
});

el.btnMicOnly.addEventListener('click', function () {
  // タブ音声なしのまま、マイクのみで続行する。連打による二重セッション確立を防ぐ。
  if (state.capturing) {
    return;
  }
  state.capturing = true;
  el.btnMicOnly.disabled = true;
  el.btnRetryShare.disabled = true;
  proceedToMicrophone();
});

function proceedToMicrophone() {
  try {
    navigator.mediaDevices.getUserMedia({ audio: true })
      .then(function (stream) {
        state.micStream = stream;
        state.micDenied = false;
        startRecordingSession();
      })
      .catch(function () {
        state.micStream = null;
        state.micDenied = true;
        if (!state.hasTabAudio) {
          // タブ音声もマイクも無い場合は録音できる音源がない。
          state.capturing = false;
          resetNoTabAudioButtons();
          stopStream(state.displayStream);
          state.displayStream = null;
          showScreen(Screen.IDLE);
          showIdleError('マイクにもタブ音声にもアクセスできなかったため、録音できませんでした。');
          return;
        }
        startRecordingSession();
      });
  } catch (err) {
    // getUserMedia が同期的に例外を投げる非対応環境向けの保険。
    state.capturing = false;
    resetNoTabAudioButtons();
    stopStream(state.displayStream);
    state.displayStream = null;
    showScreen(Screen.IDLE);
    showIdleError('マイクを取得できませんでした。もう一度お試しください。');
  }
}

// ---- 録音の開始 ----

function pickMimeType() {
  var candidates = ['audio/webm;codecs=opus', 'audio/webm'];
  if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) {
    return '';
  }
  for (var i = 0; i < candidates.length; i++) {
    if (MediaRecorder.isTypeSupported(candidates[i])) {
      return candidates[i];
    }
  }
  return '';
}

function createMixAudioContext() {
  var AudioContextCtor = window.AudioContext || window.webkitAudioContext;
  // MP3 側の想定サンプルレートに合わせて 44100 を希望するが、
  // 環境によっては拒否されることがあるため、その場合は既定値にフォールバックする。
  try {
    return new AudioContextCtor({ sampleRate: 44100 });
  } catch (err) {
    return new AudioContextCtor();
  }
}

function startRecordingSession() {
  var audioContext = createMixAudioContext();
  var destination = audioContext.createMediaStreamDestination();
  // ミックス結果を MediaRecorder（WebM）用の destination と、
  // MP3 逐次エンコード用の AudioWorklet の両方へ分配するための中間ノード。
  var mixNode = audioContext.createGain();
  mixNode.gain.value = 1;
  mixNode.connect(destination);

  // タブ音声・マイクの双方を素通しで混ぜると、音量が重なってクリッピング
  // （音割れ）しやすいため、それぞれ MIX_SOURCE_GAIN 倍の GainNode を経由させてから混ぜる。
  if (state.hasTabAudio && state.displayStream) {
    var tabAudioTracks = state.displayStream.getAudioTracks();
    if (tabAudioTracks.length > 0) {
      var tabAudioStream = new MediaStream(tabAudioTracks);
      var tabGain = audioContext.createGain();
      tabGain.gain.value = MIX_SOURCE_GAIN;
      audioContext.createMediaStreamSource(tabAudioStream).connect(tabGain).connect(mixNode);
    }
  }
  if (state.micStream) {
    var micGain = audioContext.createGain();
    micGain.gain.value = MIX_SOURCE_GAIN;
    audioContext.createMediaStreamSource(state.micStream).connect(micGain).connect(mixNode);
  }

  // 一部のブラウザではユーザー操作から少し離れた場所で AudioContext が
  // suspended のまま生成されることがある。resume() はベストエフォートで
  // 呼ぶだけとし、失敗しても録音自体は継続する。
  try {
    var resumeResult = audioContext.resume();
    if (resumeResult && typeof resumeResult.catch === 'function') {
      resumeResult.catch(function () {});
    }
  } catch (err) {
    // resume に失敗しても録音は続行する。
  }

  state.audioContext = audioContext;
  state.mixNode = mixNode;
  state.mimeType = pickMimeType();
  state.recordedChunks = [];

  var recorderOptions = state.mimeType ? { mimeType: state.mimeType } : undefined;
  var mediaRecorder;
  try {
    mediaRecorder = new MediaRecorder(destination.stream, recorderOptions);
  } catch (err) {
    mediaRecorder = new MediaRecorder(destination.stream);
  }

  mediaRecorder.ondataavailable = function (e) {
    if (e.data && e.data.size > 0) {
      state.recordedChunks.push(e.data);
    }
  };
  mediaRecorder.onstop = finalizeRecording;
  mediaRecorder.onerror = function () {
    // MediaRecorder が録音継続不能なエラーを起こした場合、録音を止めて
    // finalizeRecording 側でエラー表示に振り分ける。
    state.recordingError = '録音中にエラーが発生しました。';
    stopRecording();
  };
  state.mediaRecorder = mediaRecorder;

  // 動画トラックは録画しないが、共有停止の検知のために保持しておく。
  if (state.displayStream) {
    var videoTrack = state.displayStream.getVideoTracks()[0];
    if (videoTrack) {
      videoTrack.addEventListener('ended', handleShareEnded);
    }
  }

  el.recWarning.hidden = true;
  if (!state.hasTabAudio) {
    showRecWarning('タブの音声を共有していないため、マイクの音声のみを録音しています。');
  } else if (state.micDenied) {
    showRecWarning('マイクを取得できなかったため、タブの音声のみで録音しています。');
  }

  // WebM 録音の開始をブロックしないよう、MP3 の準備は非同期・ベストエフォートで行う。
  setupMp3Pipeline(audioContext, mixNode);

  // timeslice を指定し、一定間隔で ondataavailable を発火させる
  // （長時間録音時に単一の巨大な Blob 生成へ処理が偏らないようにするため）。
  mediaRecorder.start(5000);
  state.startedAt = new Date();
  state.capturing = false;
  el.btnStop.disabled = false;
  startTimer();
  window.addEventListener('beforeunload', onBeforeUnload);
  showScreen(Screen.RECORDING);
}

function showRecWarning(message) {
  el.recWarning.textContent = message;
  el.recWarning.hidden = false;
}

function handleShareEnded() {
  // ブラウザの共有停止バーで共有が止められた場合、録音を正常に停止する。
  stopRecording();
}

function onBeforeUnload(e) {
  e.preventDefault();
  e.returnValue = '';
  return '';
}

// ---- MP3 逐次エンコード ----

function setupMp3Pipeline(audioContext, mixNode) {
  state.mp3SampleRate = audioContext.sampleRate;

  if (typeof window.lamejs === 'undefined' || !window.lamejs.Mp3Encoder) {
    // lamejs が読み込めていない場合は MP3 生成をスキップする。
    state.mp3Failed = true;
    return;
  }
  if (!audioContext.audioWorklet || typeof audioContext.audioWorklet.addModule !== 'function') {
    // AudioWorklet 非対応環境では MP3 生成をスキップする。
    state.mp3Failed = true;
    return;
  }

  audioContext.audioWorklet.addModule(MP3_WORKLET_URL)
    .then(function () {
      // addModule 解決までの間に録音が停止・リセットされている場合は何もしない。
      if (state.audioContext !== audioContext || state.mp3Failed) {
        return;
      }
      try {
        var workletNode = new AudioWorkletNode(audioContext, 'pcm-capture-processor', {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          channelCount: 1,
          channelCountMode: 'explicit'
        });
        workletNode.port.onmessage = function (e) {
          handlePcmChunk(e.data);
        };
        mixNode.connect(workletNode);

        // 出力を持たないノードはブラウザによってはレンダリングから外され
        // process() が呼ばれなくなることがある。無音（gain 0）で出口へ
        // つないでおくことで、確実に処理され続けるようにする。
        // gain 0 のためスピーカーへは何も出ず、ハウリングも起きない。
        var silentGain = audioContext.createGain();
        silentGain.gain.value = 0;
        workletNode.connect(silentGain);
        silentGain.connect(audioContext.destination);

        state.mp3Encoder = new window.lamejs.Mp3Encoder(1, state.mp3SampleRate, MP3_BITRATE_KBPS);
        state.mp3WorkletNode = workletNode;
        state.mp3Ready = true;
      } catch (err) {
        state.mp3Failed = true;
      }
    })
    .catch(function () {
      state.mp3Failed = true;
    });
}

function handlePcmChunk(chunk) {
  if (!state.mp3Ready || state.mp3Failed) {
    return;
  }
  state.mp3PcmQueue.push(chunk);
  state.mp3PcmQueueLength += chunk.length;
  if (state.mp3PcmQueueLength >= PCM_FLUSH_SAMPLES) {
    flushPcmQueueToMp3();
  }
}

function flushPcmQueueToMp3() {
  if (state.mp3PcmQueueLength === 0 || !state.mp3Encoder) {
    return;
  }
  var merged = new Float32Array(state.mp3PcmQueueLength);
  var offset = 0;
  for (var i = 0; i < state.mp3PcmQueue.length; i++) {
    merged.set(state.mp3PcmQueue[i], offset);
    offset += state.mp3PcmQueue[i].length;
  }
  state.mp3PcmQueue = [];
  state.mp3PcmQueueLength = 0;

  try {
    var int16 = floatTo16BitPCM(merged);
    var mp3buf = state.mp3Encoder.encodeBuffer(int16);
    if (mp3buf && mp3buf.length > 0) {
      state.mp3Chunks.push(mp3buf);
    }
  } catch (err) {
    state.mp3Failed = true;
  }
}

function floatTo16BitPCM(floatSamples) {
  var int16 = new Int16Array(floatSamples.length);
  for (var i = 0; i < floatSamples.length; i++) {
    var s = Math.max(-1, Math.min(1, floatSamples[i]));
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return int16;
}

function finalizeMp3Encoding() {
  if (!state.mp3Ready || state.mp3Failed || !state.mp3Encoder) {
    return null;
  }
  try {
    flushPcmQueueToMp3();
    var endBuf = state.mp3Encoder.flush();
    if (endBuf && endBuf.length > 0) {
      state.mp3Chunks.push(endBuf);
    }
    if (state.mp3Chunks.length === 0) {
      return null;
    }
    return new Blob(state.mp3Chunks, { type: 'audio/mpeg' });
  } catch (err) {
    return null;
  }
}

function teardownMp3Pipeline() {
  if (state.mp3WorkletNode) {
    try {
      state.mp3WorkletNode.port.onmessage = null;
      state.mp3WorkletNode.disconnect();
    } catch (err) {
      // 切断時の例外は無視してよい。
    }
    state.mp3WorkletNode = null;
  }
}

// ---- タイマー ----

function startTimer() {
  state.elapsedSeconds = 0;
  updateTimerDisplay();
  state.timerId = window.setInterval(function () {
    state.elapsedSeconds += 1;
    updateTimerDisplay();
  }, 1000);
}

function stopTimer() {
  if (state.timerId !== null) {
    window.clearInterval(state.timerId);
    state.timerId = null;
  }
}

function updateTimerDisplay() {
  el.recTimer.textContent = formatDuration(state.elapsedSeconds);
}

function formatDuration(totalSeconds) {
  var h = Math.floor(totalSeconds / 3600);
  var m = Math.floor((totalSeconds % 3600) / 60);
  var s = totalSeconds % 60;
  return [h, m, s].map(function (v) {
    return String(v).padStart(2, '0');
  }).join(':');
}

// ---- 録音の停止 ----

el.btnStop.addEventListener('click', function () {
  // 連打で mediaRecorder.stop() / finalizeRecording が二重に走らないようにする。
  if (el.btnStop.disabled) {
    return;
  }
  el.btnStop.disabled = true;
  stopRecording();
});

function stopRecording() {
  if (state.mediaRecorder && state.mediaRecorder.state !== 'inactive') {
    state.mediaRecorder.stop();
  } else {
    finalizeRecording();
  }
}

function finalizeRecording() {
  // MediaRecorder.onerror 経由の停止と onstop 経由の停止が両方発火する
  // ケースなどに備えた冪等ガード。二重実行時は何もしない。
  if (state.finalized) {
    return;
  }
  state.finalized = true;

  state.endedAt = new Date();
  stopTimer();

  stopStream(state.displayStream);
  stopStream(state.micStream);
  teardownMp3Pipeline();
  if (state.audioContext && state.audioContext.state !== 'closed') {
    state.audioContext.close();
  }

  var blobType = state.mimeType || 'audio/webm';
  state.audioBlob = new Blob(state.recordedChunks, { type: blobType });
  var hasWebmData = state.audioBlob.size > 0;
  state.audioUrl = hasWebmData ? URL.createObjectURL(state.audioBlob) : null;

  state.mp3Blob = finalizeMp3Encoding();
  var hasMp3Data = !!state.mp3Blob;
  if (hasMp3Data) {
    state.mp3Url = URL.createObjectURL(state.mp3Blob);
  }

  // MediaRecorder が録音継続不能なエラーを起こしていた場合、または
  // WebM・MP3 のいずれにも有効なデータが無い場合は、結果画面には進まず
  // 開始画面へ戻してエラーを案内する（「録音が完了しました」とは出さない）。
  if (state.recordingError || (!hasWebmData && !hasMp3Data)) {
    if (state.audioUrl) {
      URL.revokeObjectURL(state.audioUrl);
      state.audioUrl = null;
    }
    if (state.mp3Url) {
      URL.revokeObjectURL(state.mp3Url);
      state.mp3Url = null;
    }
    window.removeEventListener('beforeunload', onBeforeUnload);
    showScreen(Screen.IDLE);
    showIdleError(state.recordingError || '録音データを取得できませんでした。');
    return;
  }

  if (hasMp3Data) {
    state.finalFormat = 'mp3';
  } else {
    state.finalFormat = 'webm';
  }

  // 保存名の基準は録音開始時刻（§4-2）。停止時刻ではない。
  // 以降の3か所（Drive・音声ダウンロード・記録情報）が同じ時刻を見るように、
  // ここで state.startedAt を確定させてから初期値を作る
  // （startRecordingSession を通らずにここへ来る経路は無いはずだが、
  //   null のままだと保存のたびに違う名前になってしまうため保険を置く）。
  if (!state.startedAt) {
    state.startedAt = state.endedAt;
  }
  refreshDefaultFileName();

  el.playback.src = state.finalFormat === 'mp3' ? state.mp3Url : state.audioUrl;
  el.consentInfo.textContent = '同意確認: ' + formatTimestampForDisplay(state.consentConfirmedAt);
  updateDoneScreenForFormat();

  // beforeunload の警告は、録音が Drive かこの端末のどちらかへ保存される、
  // または新しい録音を開始するまで維持する。
  showScreen(Screen.DONE);
}

function updateDoneScreenForFormat() {
  if (state.finalFormat === 'mp3') {
    el.mp3FallbackNote.hidden = true;
    el.btnDownloadAudio.textContent = '音声をダウンロード（MP3）';
    el.btnDownloadWebmOriginal.hidden = false;
  } else {
    el.mp3FallbackNote.hidden = false;
    el.btnDownloadAudio.textContent = '音声をダウンロード';
    el.btnDownloadWebmOriginal.hidden = true;
  }
  prepareDrivePanel();
}

function stopStream(stream) {
  if (!stream) {
    return;
  }
  stream.getTracks().forEach(function (track) {
    track.stop();
  });
}

// ---- Google ドライブ保存（v1.1。仕様書 §4） ----

// 画面へ入れる文字はすべて textContent、要素は createElement で作る。
// ファイル名・フォルダ名・URL・アカウント名は Google の応答であり、
// 外から来た値として扱う（voice-recorder/app.js 冒頭の約束と同じ）。

/* 保存名の2つの入力欄をまとめて開け閉めする（v1.2）。 */
function setNameFieldsDisabled(disabled) {
  el.inputPartner.disabled = disabled;
  el.inputFileName.disabled = disabled;
}

function showDriveHint(text) {
  el.driveHint.textContent = text;
  el.driveHint.hidden = text === '';
}

function showDriveError(text) {
  el.driveError.textContent = text;
  el.driveError.hidden = text === '';
}

function clearDriveError() {
  showDriveError('');
  el.driveRetryActions.replaceChildren();
  el.driveRetryActions.hidden = true;
}

/*
 * 生の例外はコンソールへ残す（voice-recorder/app.js の reportError と同じ判断）。
 * describeError は知らないコードを既定文言へ丸めるため、実装のバグまで
 * 「保存に失敗しました」に化けて原因が見えなくなる。
 * トークンは例外に入れていないので、ここから漏れることはない。
 */
function reportDriveError(error) {
  console.error('[interview-recorder]', error);
  showDriveError(describeError(error));
}

/* 失敗時の再試行導線。録音は画面に残っているので、押せば同じ手順をやり直せる。 */
function showDriveRetry(label, handler) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn btn-secondary';
  button.textContent = label;
  button.addEventListener('click', handler);

  el.driveRetryActions.replaceChildren(button);
  el.driveRetryActions.hidden = false;
}

function setDriveProgress(stage, ratio) {
  el.driveProgressPanel.hidden = false;
  el.driveProgressTitle.textContent = stage;

  const percent = typeof ratio === 'number' ? Math.round(ratio * 100) : 0;
  el.driveProgress.setAttribute('aria-valuenow', String(percent));
  el.driveProgressBar.style.width = percent + '%';
  el.driveProgressText.textContent = percent + '%';
}

/*
 * 結果画面を開いた時点の Drive パネルの状態を決める。
 *
 * ここで押せないようにするのは次の2つ。
 *   - MP3 が作れなかった場合（WebM 安全網）。**WebM は Drive へ上げない。**
 *     同じフォルダを文字起こしアプリが読みに来るため、あの場所には
 *     voice-recorder と同じ MP3 だけを置く（§4 / §5）。
 *   - クライアントIDが未設定の場合。連携しようがないため、
 *     押せる状態のまま失敗させず、ここで理由を出す。
 */
function prepareDrivePanel() {
  clearDriveError();
  el.driveProgressPanel.hidden = true;
  el.driveResultPanel.hidden = true;
  el.driveFolder.textContent =
    '保存先: ' + formatFolderPath(DRIVE_NAMES.root, DRIVE_NAMES.app);

  if (state.finalFormat !== 'mp3') {
    el.btnSaveDrive.disabled = true;
    showDriveHint('MP3 を作成できなかったため、Googleドライブへは保存できません。'
      + '下の「音声をダウンロード」でこの端末へ保存してください。');
    return;
  }

  if (!isOauthConfigured()) {
    el.btnSaveDrive.disabled = true;
    showDriveHint(describeError(new AppError(ErrorCode.OAUTH_NOT_CONFIGURED)));
    return;
  }

  el.btnSaveDrive.disabled = false;
  showDriveHint('保存を押すと、Googleアカウントとの連携画面が開きます'
    + '（連携済みの場合は開きません）。');
}

function showDriveResult(result, account) {
  el.driveResultName.textContent = result.name;
  el.driveResultFolder.textContent = formatFolderPath(DRIVE_NAMES.root, DRIVE_NAMES.app);
  el.driveResultAccount.textContent = account;

  el.driveResultLink.replaceChildren();

  if (result.url) {
    const link = document.createElement('a');
    link.href = result.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = 'Driveで開く';
    el.driveResultLink.append(link);
  } else {
    el.driveResultLink.textContent = '（リンクを取得できませんでした）';
  }

  el.driveResultPanel.hidden = false;
}

/*
 * Drive へ保存する。
 *
 * ------------------------------------------------------------------
 * 連携は「保存を押した時点」で行う（voice-recorder と作法を変えた点）
 * ------------------------------------------------------------------
 * voice-recorder は録音前の「利用の準備」で連携を済ませる作りだが、
 * こちらは結果画面のこのボタンからまとめて行う。
 *
 * アクセストークンの寿命は約1時間で、**面談の長さより短いことが普通**である。
 * 先に連携させても停止した頃には切れており、voice-recorder 自身が
 * 「連携済みと出ているのに保存だけ押せない」問題を踏んでいる
 * （voice-recorder/app.js の refreshOauthState のコメント）。
 * 録音前に増える操作の分だけ損をして、期限切れは避けられない。
 *
 * ポップアップはこの押下（利用者の操作）から開くためブロックされない。
 * 「アプリを開いただけでは認可を要求しない」も満たす。
 * ------------------------------------------------------------------
 *
 * ------------------------------------------------------------------
 * 送信中に state が差し替わりうる
 * ------------------------------------------------------------------
 * resetToIdle() は `state = createInitialState()` で状態そのものを作り直す。
 * 90分ぶんのアップロード中に「新しい録音を開始」が押されると、この関数の
 * 続きが**次の録音の状態**へ結果を書き込み、次の保存が「保存済み」と
 * みなされて押せなくなる。
 *
 * 対策は2つ重ねてある。
 *   1. 送信中は「新しい録音を開始」を押せなくする（voice-recorder が
 *      保存中に「破棄」を無効化しているのと同じ考え）
 *   2. 開始時の state を控え、差し替わっていたら結果を捨てる
 * 1だけでは、将来ほかの場所から resetToIdle が呼ばれたときに同じ穴が開く。
 * ------------------------------------------------------------------
 */
async function saveToDrive() {
  // 連打と、保存済みの再送信を防ぐ。
  if (state.driveSaving || state.driveSaved) {
    return;
  }

  // WebM 安全網のときはここへ来ない（ボタンが無効）。念のための二重防御。
  if (state.finalFormat !== 'mp3' || !state.mp3Blob) {
    return;
  }

  // この保存が「どの録音のものか」を控える（上の注記）。
  var session = state;

  state.driveSaving = true;
  el.btnSaveDrive.disabled = true;
  el.btnRestart.disabled = true;
  /*
   * 送信中は名前を動かせないようにする（§4-2）。
   * 送信の途中で欄を書き換えられると、Drive に入った名前と画面に見えている
   * 名前が食い違う。失敗して再試行できるよう、finally で戻す。
   */
  setNameFieldsDisabled(true);
  clearDriveError();
  showDriveHint('');

  try {
    setDriveProgress(PROGRESS.PREPARING, 0);

    /*
     * 未連携・期限切れならここで認可を取り直す。
     * 有効なトークンがあるときは何も表示せずに通る。
     */
    if (!hasValidToken()) {
      setDriveProgress(PROGRESS.CONNECTING, 0);
      await requestAccess();
    }

    /* トークンは呼び出しの直前に取り出し、変数へ写さない。 */
    const auth = { accessToken: currentToken() };

    setDriveProgress(PROGRESS.RESOLVING_FOLDER, 0);
    const folderId = await resolveTargetFolder(auth);

    /*
     * 保存名は「音声をダウンロード」と同じもの（§4-2）。
     * 利用者が「ファイル名」欄を編集していればその値、空なら初期値。
     * 同名が保存先にあれば pickAvailableName が _2, _3… を付ける
     * （編集した名前でも同じように効く）。
     */
    const desired = currentFileName();
    const finalName = await pickAvailableName(desired, folderId, auth);

    setDriveProgress(PROGRESS.UPLOADING, 0);
    const result = await uploadResumable({
      file: state.mp3Blob,
      name: finalName,
      folderId: folderId,
      onProgress: function (sent, total) {
        setDriveProgress(PROGRESS.UPLOADING, sent / total);
      }
    }, auth);

    setDriveProgress(PROGRESS.FINISHING, 1);

    /* 表示のためだけの情報。取れなくても保存は成立している（drive.js の注記）。 */
    const email = await fetchAccountEmail(auth);

    /*
     * ここまでの間に「新しい録音を開始」が通っていたら、この結果を
     * 画面にも次の録音の状態にも反映しない（Drive への保存自体は済んでいる）。
     */
    if (state !== session) {
      return;
    }

    state.driveSaved = true;
    markRecordingSaved();

    el.driveProgressPanel.hidden = true;
    showDriveHint('');
    showDriveResult(result, email || '連携済みのアカウント');
  } catch (error) {
    if (state !== session) {
      /* 次の録音の画面へエラーを出さない。原因はコンソールにだけ残す。 */
      console.error('[interview-recorder]', error);
      return;
    }

    el.driveProgressPanel.hidden = true;
    reportDriveError(error);

    /*
     * 期限切れは連携からやり直す必要がある。トークンを捨てておくと、
     * 次の saveToDrive() が requestAccess() から始まる。
     * それ以外は同じ手順の再試行でよい。
     */
    if (error instanceof AppError && error.code === ErrorCode.OAUTH_EXPIRED) {
      forgetToken();
      showDriveRetry('連携しなおして保存', saveToDrive);
    } else {
      showDriveRetry('保存をやり直す', saveToDrive);
    }
  } finally {
    /* 差し替わっている場合は、古い保存の後始末で新しい状態を触らない。 */
    session.driveSaving = false;

    if (state === session) {
      el.btnRestart.disabled = false;
      /* 保存できたらボタンは押せないままにする（同じ録音を二重に上げない）。 */
      el.btnSaveDrive.disabled = state.driveSaved;
      /*
       * 保存が済んだら名前も確定させる。Drive にある名前と、このあとの
       * ローカルダウンロードの名前を食い違わせないため（§4-2）。
       * 失敗したときは編集できる状態へ戻し、名前を変えて再試行できるようにする。
       */
      setNameFieldsDisabled(state.driveSaved);
    }
  }
}

// ---- 結果画面 ----

// 録音が Drive かこの端末のどちらかへ保存されるまでは、
// 離脱確認（beforeunload）を維持する。
// v1.0 では「ダウンロードしたか」だけを見ていたが、Drive 保存も
// 「録音を失わない状態になった」ことに変わりないため、こちらへ寄せた。
function markRecordingSaved() {
  if (state.preserved) {
    return;
  }
  state.preserved = true;
  window.removeEventListener('beforeunload', onBeforeUnload);
}

/*
 * 保存名の初期値を作り直し、「ファイル名」欄へ反映する（§4-2。v1.2）。
 *
 * 停止直後（finalizeRecording）と、「面談相手名」欄を打つたびに呼ぶ。
 * voice-recorder と同じく、**欄を編集済みかどうかは判定せず**に上書きする。
 * 判定しようとすると「利用者が消した」と「こちらが書いた」の区別が要り、
 * 仕組みが増えるわりに間違いやすい。相手名は名前を組み立てるための欄で、
 * 打った結果がその場で見えるほうが分かりやすい。
 */
function refreshDefaultFileName() {
  state.defaultFileName = buildDefaultFileName(
    state.startedAt || new Date(),
    el.inputPartner.value,
  );
  el.inputFileName.value = state.defaultFileName;
  el.inputFileName.placeholder = state.defaultFileName;
}

/*
 * いま保存すべき MP3 の名前（§4-2）。
 * 入力欄が空・空白だけ・使えない文字だけ、のときは初期値へ戻す。
 * 拡張子が無ければ .mp3 を付ける（resolveFileName の中の ensureExtension）。
 */
function currentFileName() {
  return resolveFileName(el.inputFileName.value, state.defaultFileName);
}

/*
 * ローカル保存のファイル名も Drive と同じ名前にそろえる（§4-2）。
 * **編集後の名前**から拡張子だけを差し替えるので、利用者が名前を変えれば
 * WebM も JSON も一緒に変わる。同じ録音の3ファイルが名前で並ぶ。
 */
function localFileName(extension) {
  return withExtension(currentFileName(), extension);
}

el.inputPartner.addEventListener('input', function () {
  refreshDefaultFileName();
});

el.btnDownloadAudio.addEventListener('click', function () {
  if (state.finalFormat === 'mp3' && state.mp3Url) {
    triggerDownload(state.mp3Url, currentFileName());
    markRecordingSaved();
    return;
  }
  if (!state.audioUrl) {
    return;
  }
  triggerDownload(state.audioUrl, localFileName(WEBM_EXTENSION));
  markRecordingSaved();
});

el.btnDownloadWebmOriginal.addEventListener('click', function () {
  if (!state.audioUrl) {
    return;
  }
  triggerDownload(state.audioUrl, localFileName(WEBM_EXTENSION));
  markRecordingSaved();
});

el.btnDownloadJson.addEventListener('click', function () {
  var durationSec = state.startedAt && state.endedAt
    ? Math.round((state.endedAt.getTime() - state.startedAt.getTime()) / 1000)
    : 0;
  var record = {
    startedAt: state.startedAt ? state.startedAt.toISOString() : null,
    endedAt: state.endedAt ? state.endedAt.toISOString() : null,
    durationSec: durationSec,
    consentConfirmedAt: state.consentConfirmedAt,
    consentStatement: '使用者は録音開始前に、面談相手へ録音を通告し同意を得たことを確認した。',
    audioFormat: state.finalFormat,
    sampleRate: state.mp3SampleRate || null,
    // どの音声ファイルの記録かを示す（v1.1）。音声が Drive 側に、
    // この JSON が端末側に分かれて残るため、名前で対応を追えるようにする。
    audioFileName: state.finalFormat === 'mp3'
      ? currentFileName()
      : localFileName(WEBM_EXTENSION),
    // Drive へ保存した場合の保存先。ローカルのみの場合は null。
    driveFolder: state.driveSaved ? formatFolderPath(DRIVE_NAMES.root, DRIVE_NAMES.app) : null
  };
  if (state.finalFormat === 'mp3') {
    record.bitrateKbps = MP3_BITRATE_KBPS;
  }
  var json = JSON.stringify(record, null, 2);
  var blob = new Blob([json], { type: 'application/json' });
  var url = URL.createObjectURL(blob);
  triggerDownload(url, localFileName(JSON_EXTENSION));
  // ダウンロード用に生成した一時 URL は用が済んだら解放する。
  window.setTimeout(function () {
    URL.revokeObjectURL(url);
  }, 1000);
});

function triggerDownload(url, filename) {
  var a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

el.btnRestart.addEventListener('click', function () {
  resetToIdle();
});

// Drive 保存。ポップアップ（認可画面）を開くため、必ずこの押下から呼ぶ。
el.btnSaveDrive.addEventListener('click', function () {
  saveToDrive();
});

function resetToIdle() {
  stopTimer();
  window.removeEventListener('beforeunload', onBeforeUnload);
  stopStream(state.displayStream);
  stopStream(state.micStream);
  teardownMp3Pipeline();
  if (state.audioContext && state.audioContext.state !== 'closed') {
    state.audioContext.close();
  }
  if (state.audioUrl) {
    URL.revokeObjectURL(state.audioUrl);
  }
  if (state.mp3Url) {
    URL.revokeObjectURL(state.mp3Url);
  }
  if (el.playback) {
    el.playback.removeAttribute('src');
    el.playback.load();
  }
  el.recWarning.hidden = true;
  el.btnCaptureContinue.disabled = false;
  el.btnRetryShare.disabled = false;
  el.btnMicOnly.disabled = false;
  el.btnStop.disabled = false;
  el.btnConsentYes.disabled = false;
  el.mp3FallbackNote.hidden = true;
  el.btnDownloadWebmOriginal.hidden = true;
  el.btnDownloadAudio.textContent = '音声をダウンロード';

  // 保存名の欄は次の録音へ持ち越さない（v1.2）。
  // 相手名は面談ごとに変わるうえ、前の相手の名前が残っていると
  // 気づかないまま別の面談のファイル名に混ざる。
  setNameFieldsDisabled(false);
  el.inputPartner.value = '';
  el.inputFileName.value = '';
  el.inputFileName.placeholder = '';

  // Drive パネルも前回の結果を残さない。**トークンは捨てない。**
  // 続けてもう1件録る場合に、連携をやり直させないためである
  // （トークンはメモリ上にしかなく、ページを離れれば消える）。
  clearDriveError();
  el.driveProgressPanel.hidden = true;
  el.driveResultPanel.hidden = true;
  el.driveResultLink.replaceChildren();
  showDriveHint('');
  el.btnSaveDrive.disabled = false;
  // 保存中に（別経路で）ここへ来た場合に、押せないまま残さない。
  el.btnRestart.disabled = false;

  state = createInitialState();
  showIdleError('');
  showScreen(Screen.IDLE);
}

// ---- ユーティリティ ----

function pad2(n) {
  return String(n).padStart(2, '0');
}

/*
 * v1.0 にあった formatTimestampForFilename は削除した。
 * ファイル名の組み立ては filename.js（voice-recorder からの複製）へ移し、
 * 日時部分の書式を voice-recorder と1か所で揃えるためである（§4）。
 */

function formatTimestampForDisplay(isoString) {
  if (!isoString) {
    return '不明';
  }
  var d = new Date(isoString);
  return (
    d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
    ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds())
  );
}

// ---- 起動 ----

async function init() {
  var user = await guardPage();

  if (!user) {
    // すでにログイン画面へ遷移している。ここで描画を止める。
    return;
  }

  el.authLoading.hidden = true;
  el.appMain.hidden = false;

  // ---- 初期表示（開始画面の機能検出表示） ----
  if (!isBrowserSupported()) {
    el.btnStart.disabled = true;
    showIdleError('このアプリはデスクトップ版の Chrome / Edge でご利用ください。');
  }
  showScreen(Screen.IDLE);
}

init();

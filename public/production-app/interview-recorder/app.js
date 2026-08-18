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
 */

import { guardPage } from '../../auth/session.js';
import { setScreenDepth } from '../../auth/config.js';
import {
  SCREEN_DEPTH,
  MP3_BITRATE_KBPS,
  MP3_WORKLET_URL,
  PCM_FLUSH_SAMPLES,
  MIX_SOURCE_GAIN,
} from './config.js';

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
    // 連打・二重実行対策
    capturing: false, // 音声キャプチャ開始～録音セッション確立までの再入防止フラグ
    finalized: false, // finalizeRecording() の冪等ガード
    downloaded: false, // 音声（MP3/WebM）を1回以上ダウンロードしたか
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

  el.playback.src = state.finalFormat === 'mp3' ? state.mp3Url : state.audioUrl;
  el.consentInfo.textContent = '同意確認: ' + formatTimestampForDisplay(state.consentConfirmedAt);
  updateDoneScreenForFormat();

  // beforeunload の警告は、音声（MP3/WebM）が1回以上ダウンロードされる、
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
}

function stopStream(stream) {
  if (!stream) {
    return;
  }
  stream.getTracks().forEach(function (track) {
    track.stop();
  });
}

// ---- 結果画面 ----

// 音声（MP3 または WebM）のダウンロードが1回以上行われるまでは、
// 離脱確認（beforeunload）を維持する。
function markAudioDownloaded() {
  if (state.downloaded) {
    return;
  }
  state.downloaded = true;
  window.removeEventListener('beforeunload', onBeforeUnload);
}

el.btnDownloadAudio.addEventListener('click', function () {
  if (state.finalFormat === 'mp3' && state.mp3Url) {
    var mp3Filename = '面談録音_' + formatTimestampForFilename(state.startedAt) + '.mp3';
    triggerDownload(state.mp3Url, mp3Filename);
    markAudioDownloaded();
    return;
  }
  if (!state.audioUrl) {
    return;
  }
  var webmFilename = '面談録音_' + formatTimestampForFilename(state.startedAt) + '.webm';
  triggerDownload(state.audioUrl, webmFilename);
  markAudioDownloaded();
});

el.btnDownloadWebmOriginal.addEventListener('click', function () {
  if (!state.audioUrl) {
    return;
  }
  var filename = '面談録音_' + formatTimestampForFilename(state.startedAt) + '.webm';
  triggerDownload(state.audioUrl, filename);
  markAudioDownloaded();
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
    sampleRate: state.mp3SampleRate || null
  };
  if (state.finalFormat === 'mp3') {
    record.bitrateKbps = MP3_BITRATE_KBPS;
  }
  var json = JSON.stringify(record, null, 2);
  var blob = new Blob([json], { type: 'application/json' });
  var url = URL.createObjectURL(blob);
  var filename = '面談録音_' + formatTimestampForFilename(state.startedAt) + '.json';
  triggerDownload(url, filename);
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

  state = createInitialState();
  showIdleError('');
  showScreen(Screen.IDLE);
}

// ---- ユーティリティ ----

function pad2(n) {
  return String(n).padStart(2, '0');
}

function formatTimestampForFilename(date) {
  var d = date || new Date();
  return (
    d.getFullYear() +
    pad2(d.getMonth() + 1) +
    pad2(d.getDate()) +
    '_' +
    pad2(d.getHours()) +
    pad2(d.getMinutes()) +
    pad2(d.getSeconds())
  );
}

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

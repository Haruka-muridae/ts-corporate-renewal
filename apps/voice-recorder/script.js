/*
 * UI層。
 * 状態遷移、DOM更新、支援技術への通知、各層の呼び出しを担当する。
 * 録音は recorder.js、MP3変換は encoder.js、保存は saver.js が担う。
 *
 * このファイルは以下のUI状態を管理する:
 *   idle / requesting / recording / paused / stopped
 *   decoding / encoding / completed / conversion-error
 * recorder が扱うのは stopped までで、以降は変換の状態。
 */

import {
  MAX_RECORDING_SECONDS,
  Recorder,
  RecorderErrorCode,
  RecorderState,
  isRecordingSupported,
  isSecureContextAvailable,
} from './recorder.js';

import {
  Mp3Converter,
  ConversionErrorCode,
} from './encoder.js';

import {
  SAVE_TARGETS,
  SaveError,
  buildFileName,
} from './saver.js';

/* 録音のエラー文言。内部エラーは表示せず、コンソールへ記録する。 */
const RECORDER_ERROR_MESSAGES = {
  [RecorderErrorCode.UNSUPPORTED]:
    'このブラウザは録音に対応していません。Chrome、Edge、Safari の最新版をお試しください。',
  [RecorderErrorCode.INSECURE_CONTEXT]:
    '安全な接続（HTTPS）でないため録音できません。',
  [RecorderErrorCode.PERMISSION_DENIED]:
    'マイクの使用が許可されていません。ブラウザの設定から許可してください。',
  [RecorderErrorCode.NO_DEVICE]:
    'マイクが見つかりません。接続をご確認ください。',
  [RecorderErrorCode.DEVICE_BUSY]:
    'マイクが他のアプリで使用中の可能性があります。他のアプリを終了してお試しください。',
  [RecorderErrorCode.NO_SUPPORTED_MIME]:
    'このブラウザでは対応する録音形式が見つかりませんでした。',
  [RecorderErrorCode.RECORDING_FAILED]:
    '録音を開始できませんでした。ページを再読み込みしてお試しください。',
};

/* 変換のエラー文言。内部スタックやパスは出さない。 */
const CONVERSION_ERROR_MESSAGES = {
  [ConversionErrorCode.ARRAY_BUFFER_FAILED]:
    '録音データを読み取れませんでした。もう一度お試しください。',
  [ConversionErrorCode.DECODE_FAILED]:
    '録音データを読み取れませんでした。もう一度録音してください。',
  [ConversionErrorCode.EMPTY_AUDIO]:
    '録音データが空でした。もう一度録音してください。',
  [ConversionErrorCode.PCM_ALLOCATION_FAILED]:
    '端末のメモリが不足しています。録音時間を短くしてお試しください。',
  [ConversionErrorCode.RESAMPLE_FAILED]:
    '録音データを変換できませんでした。もう一度お試しください。',
  [ConversionErrorCode.WORKER_CREATE_FAILED]:
    'MP3変換を開始できませんでした。ページを再読み込みしてお試しください。',
  [ConversionErrorCode.WORKER_LOAD_FAILED]:
    'MP3変換に必要な部品を読み込めませんでした。ページを再読み込みしてお試しください。',
  [ConversionErrorCode.ENCODER_INIT_FAILED]:
    'MP3変換を初期化できませんでした。もう一度お試しください。',
  [ConversionErrorCode.ENCODE_FAILED]:
    'MP3への変換に失敗しました。録音時間を短くしてお試しください。',
  [ConversionErrorCode.WORKER_CRASHED]:
    'MP3変換が中断されました。もう一度お試しください。',
  [ConversionErrorCode.EMPTY_MP3]:
    'MP3を生成できませんでした。もう一度録音してください。',
};

const CONVERSION_FALLBACK_MESSAGE = 'MP3への変換に失敗しました。もう一度お試しください。';
const SAVE_ERROR_MESSAGE = '保存に失敗しました。もう一度お試しください。';

const STATUS_MESSAGES = {
  ready: '録音の準備ができています。',
  requesting: 'マイクの使用を許可してください。',
  recording: '録音しています。',
  paused: '一時停止しています。',
  stoppedManual: '録音を停止しました。内容を確認できます。',
  stoppedLimit: '録音上限に達したため停止しました。内容を確認できます。',
  decoding: '録音データを読み取っています。',
  encoding: 'MP3に変換しています。',
  completed: 'MP3に変換しました。保存できます。',
  conversionError: '変換でエラーが発生しました。',
};

const AppState = {
  IDLE: 'idle',
  REQUESTING: 'requesting',
  RECORDING: 'recording',
  PAUSED: 'paused',
  STOPPED: 'stopped',
  DECODING: 'decoding',
  ENCODING: 'encoding',
  COMPLETED: 'completed',
  CONVERSION_ERROR: 'conversion-error',
};

function formatDuration(totalSeconds) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function formatSize(bytes) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(0)} KB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function logDeveloperError(context, error) {
  console.error('[voice-recorder]', context, error);
}

document.addEventListener('DOMContentLoaded', () => {
  const el = {
    app: document.getElementById('recorder-app'),
    status: document.getElementById('recorder-status'),
    time: document.getElementById('recorder-time'),
    limit: document.getElementById('recorder-limit'),
    indicator: document.getElementById('recorder-indicator'),
    indicatorLabel: document.getElementById('recorder-indicator-label'),
    notice: document.getElementById('recorder-notice'),
    error: document.getElementById('recorder-error'),
    // 停止後（元音声）
    result: document.getElementById('recorder-result'),
    player: document.getElementById('recorder-player'),
    meta: document.getElementById('recorder-meta'),
    convert: document.getElementById('recorder-convert'),
    reset: document.getElementById('recorder-reset'),
    // 変換中
    conversion: document.getElementById('recorder-conversion'),
    conversionTitle: document.getElementById('recorder-conversion-title'),
    progress: document.getElementById('recorder-progress'),
    progressBar: document.getElementById('recorder-progress-bar'),
    progressText: document.getElementById('recorder-progress-text'),
    // 変換後（MP3）
    completed: document.getElementById('recorder-completed'),
    mp3Player: document.getElementById('recorder-mp3-player'),
    mp3Meta: document.getElementById('recorder-mp3-meta'),
    saveGroup: document.getElementById('recorder-save-group'),
    saveNote: document.getElementById('recorder-save-note'),
    resetCompleted: document.getElementById('recorder-reset-completed'),
    // 録音操作
    start: document.getElementById('recorder-start'),
    pause: document.getElementById('recorder-pause'),
    resume: document.getElementById('recorder-resume'),
    stop: document.getElementById('recorder-stop'),
  };

  if (!el.app) {
    return;
  }

  let appState = AppState.IDLE;
  let originalUrl = null;
  let mp3Url = null;

  /* 停止後の録音（元形式）と、変換結果のMP3 */
  let recording = null;
  let mp3Result = null;

  /* 直近の停止が上限到達によるものか（表示用） */
  let stoppedByLimit = false;

  /* 進行中の変換と、その世代。世代が変わると古い結果は破棄する。 */
  let converter = null;
  let generation = 0;
  let lastAnnouncedPercent = -1;

  const recorder = new Recorder({
    onStateChange: () => {
      /* 録音層の状態はUI状態へ写す（stopped までは1対1）。 */
      syncRecorderState();
    },
    onTick: (elapsed) => {
      el.time.textContent = formatDuration(elapsed);
    },
    onWarning: () => {
      showNotice(`まもなく録音上限（${formatDuration(MAX_RECORDING_SECONDS)}）です。`);
    },
    onStop: handleStop,
    onError: (error) => {
      logDeveloperError('recording', error.cause ?? error);
      showError(RECORDER_ERROR_MESSAGES[error.code] ?? RECORDER_ERROR_MESSAGES[RecorderErrorCode.RECORDING_FAILED]);
      setAppState(AppState.IDLE);
    },
  });

  el.limit.textContent = `上限 ${formatDuration(MAX_RECORDING_SECONDS)}`;

  /* ---------- URL / 通知ヘルパ ---------- */

  function releaseOriginal() {
    if (originalUrl) {
      URL.revokeObjectURL(originalUrl);
      originalUrl = null;
    }
    el.player.removeAttribute('src');
    el.player.load();
  }

  function releaseMp3() {
    if (mp3Url) {
      URL.revokeObjectURL(mp3Url);
      mp3Url = null;
    }
    el.mp3Player.removeAttribute('src');
    el.mp3Player.load();
  }

  function showNotice(message) {
    el.notice.textContent = message;
    el.notice.hidden = false;
  }

  function clearNotice() {
    el.notice.textContent = '';
    el.notice.hidden = true;
  }

  function showError(message) {
    el.error.textContent = message;
    el.error.hidden = false;
  }

  function clearError() {
    el.error.textContent = '';
    el.error.hidden = true;
  }

  /* ---------- 状態遷移 ---------- */

  function setAppState(next) {
    appState = next;
    render();
  }

  function syncRecorderState() {
    switch (recorder.state) {
      case RecorderState.REQUESTING:
        setAppState(AppState.REQUESTING);
        break;
      case RecorderState.RECORDING:
        setAppState(AppState.RECORDING);
        break;
      case RecorderState.PAUSED:
        setAppState(AppState.PAUSED);
        break;
      case RecorderState.IDLE:
        /* 変換系の状態にいるときは、録音層のidle化で上書きしない。 */
        if ([AppState.RECORDING, AppState.PAUSED, AppState.REQUESTING].includes(appState)) {
          setAppState(AppState.IDLE);
        }
        break;
      default:
        break;
    }
  }

  function handleStop(result, reason) {
    stoppedByLimit = reason === 'limit';

    /* データが無い録音は完了扱いしない。 */
    if (!result.blob || result.blob.size === 0) {
      logDeveloperError('empty-recording', {
        size: result.blob?.size ?? null,
        duration: result.durationSeconds,
      });
      recorder.dispose();
      el.time.textContent = formatDuration(0);
      showError('録音データを取得できませんでした。もう一度お試しください。');
      setAppState(AppState.IDLE);
      return;
    }

    recording = result;
    releaseOriginal();
    originalUrl = URL.createObjectURL(result.blob);
    el.player.src = originalUrl;

    el.meta.textContent = [
      `長さ ${formatDuration(result.durationSeconds)}`,
      `サイズ ${formatSize(result.blob.size)}`,
      `形式 ${result.mimeType ?? '不明'}`,
    ].join(' ／ ');

    if (reason === 'limit') {
      showNotice(`録音上限（${formatDuration(MAX_RECORDING_SECONDS)}）に達したため、自動的に停止しました。`);
    } else {
      clearNotice();
    }

    setAppState(AppState.STOPPED);
  }

  /* ---------- MP3変換 ---------- */

  async function startConversion() {
    /* 二重起動防止：停止直後以外は無視する。 */
    if (appState !== AppState.STOPPED || !recording) {
      return;
    }

    clearError();
    clearNotice();

    /* 世代を進め、以前の変換からの遅延メッセージを無効化する。 */
    generation += 1;
    const myGeneration = generation;
    lastAnnouncedPercent = -1;
    updateProgress(0);

    converter = new Mp3Converter();
    setAppState(AppState.DECODING);

    try {
      const result = await converter.convert(recording.blob, {
        onStatus: (phase) => {
          if (myGeneration !== generation) {
            return;
          }
          if (phase === 'decoding') {
            setAppState(AppState.DECODING);
          } else if (phase === 'encoding') {
            setAppState(AppState.ENCODING);
          }
        },
        onProgress: (ratio) => {
          if (myGeneration !== generation) {
            return;
          }
          updateProgress(ratio);
        },
      });

      /* 途中でやり直し等が起きていれば結果を破棄する。 */
      if (myGeneration !== generation) {
        return;
      }

      finishConversion(result);
    } catch (error) {
      /* キャンセルや世代ずれは無視。 */
      if (error?.code === ConversionErrorCode.CANCELLED || myGeneration !== generation) {
        return;
      }

      logDeveloperError('conversion', error.cause ?? error);
      showError(CONVERSION_ERROR_MESSAGES[error?.code] ?? CONVERSION_FALLBACK_MESSAGE);
      setAppState(AppState.CONVERSION_ERROR);
    } finally {
      if (myGeneration === generation) {
        converter = null;
      }
    }
  }

  function finishConversion(result) {
    const fileName = buildFileName('mp3');

    mp3Result = { ...result, fileName };
    releaseMp3();
    mp3Url = URL.createObjectURL(result.blob);
    el.mp3Player.src = mp3Url;

    el.mp3Meta.textContent = [
      `ファイル名 ${fileName}`,
      `サイズ ${formatSize(result.blob.size)}`,
      `${result.sampleRate / 1000}kHz モノラル`,
    ].join(' ／ ');

    setAppState(AppState.COMPLETED);
  }

  function updateProgress(ratio) {
    const percent = Math.round(Math.min(Math.max(ratio, 0), 1) * 100);
    /* バーとテキストは視覚のみ。毎回更新して滑らかに見せる。 */
    el.progressBar.style.width = `${percent}%`;
    el.progressText.textContent = `${percent}%`;

    /* 支援技術向けの値は10%刻みでのみ更新し、読み上げ過多を避ける。 */
    const announced = Math.floor(percent / 10) * 10;
    if (announced !== lastAnnouncedPercent) {
      lastAnnouncedPercent = announced;
      el.progress.setAttribute('aria-valuenow', String(announced));
    }
  }

  /* ---------- やり直し / 破棄 ---------- */

  function resetAll() {
    /* 進行中の変換があれば世代を進めてWorkerを止める。 */
    generation += 1;
    if (converter) {
      converter.cancel();
      converter = null;
    }

    releaseOriginal();
    releaseMp3();
    recording = null;
    mp3Result = null;

    clearNotice();
    clearError();
    el.time.textContent = formatDuration(0);
    updateProgress(0);

    recorder.dispose();
    setAppState(AppState.IDLE);
    el.start.focus();
  }

  /* ---------- 描画 ---------- */

  function render() {
    el.app.dataset.state = appState;

    const isRecording = appState === AppState.RECORDING;
    const isPaused = appState === AppState.PAUSED;
    const isConverting = appState === AppState.DECODING || appState === AppState.ENCODING;

    el.start.hidden = appState !== AppState.IDLE;
    el.pause.hidden = !isRecording || !recorder.canPause;
    el.resume.hidden = !isPaused;
    el.stop.hidden = !isRecording && !isPaused;

    el.result.hidden = appState !== AppState.STOPPED;
    el.conversion.hidden = !isConverting;
    el.completed.hidden = appState !== AppState.COMPLETED;

    /* 変換中は変換ボタンを無効化（二重起動防止）。 */
    el.convert.disabled = isConverting;

    el.indicator.hidden = !isRecording && !isPaused;
    el.indicatorLabel.textContent = isPaused ? '一時停止中' : '録音中';

    switch (appState) {
      case AppState.REQUESTING:
        el.status.textContent = STATUS_MESSAGES.requesting;
        break;
      case AppState.RECORDING:
        el.status.textContent = STATUS_MESSAGES.recording;
        break;
      case AppState.PAUSED:
        el.status.textContent = STATUS_MESSAGES.paused;
        break;
      case AppState.STOPPED:
        el.status.textContent = stoppedByLimit ? STATUS_MESSAGES.stoppedLimit : STATUS_MESSAGES.stoppedManual;
        break;
      case AppState.DECODING:
        el.status.textContent = STATUS_MESSAGES.decoding;
        el.conversionTitle.textContent = '録音データを読み取っています';
        break;
      case AppState.ENCODING:
        el.status.textContent = STATUS_MESSAGES.encoding;
        el.conversionTitle.textContent = 'MP3に変換しています';
        break;
      case AppState.COMPLETED:
        el.status.textContent = STATUS_MESSAGES.completed;
        break;
      case AppState.CONVERSION_ERROR:
        el.status.textContent = STATUS_MESSAGES.conversionError;
        break;
      case AppState.IDLE:
      default:
        el.status.textContent = STATUS_MESSAGES.ready;
        break;
    }
  }

  /* ---------- 保存ボタン（レジストリから生成） ---------- */

  SAVE_TARGETS.forEach((target) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn recorder__save';
    button.classList.add(target.available ? 'btn--primary' : 'btn--secondary');
    button.textContent = target.available ? target.label : `${target.label}（準備中）`;
    button.dataset.saveTarget = target.id;
    /* 準備中の保存先は disabled にせず、押下時に準備中を通知する。
       disabled だとキーボードでフォーカスできず案内が届かないため。 */
    if (!target.available) {
      button.setAttribute('aria-disabled', 'true');
    }
    button.addEventListener('click', () => handleSave(target));
    el.saveGroup.append(button);
  });

  el.saveNote.textContent = '保存した音声は端末内に残ります。外部へは送信されません。';

  function handleSave(target) {
    if (!target.available || typeof target.save !== 'function') {
      showNotice(`${target.label}は現在準備中です。`);
      return;
    }

    if (!mp3Result) {
      return;
    }

    try {
      target.save(mp3Result.blob, mp3Result.fileName);
    } catch (error) {
      logDeveloperError('save', error instanceof SaveError ? (error.cause ?? error) : error);
      showError(SAVE_ERROR_MESSAGE);
    }
  }

  /* ---------- イベント ---------- */

  el.start.addEventListener('click', async () => {
    /* 変換中の録音開始は無効。 */
    if (appState === AppState.DECODING || appState === AppState.ENCODING) {
      return;
    }

    clearError();
    clearNotice();
    releaseOriginal();
    releaseMp3();
    recording = null;
    mp3Result = null;
    stoppedByLimit = false;
    el.time.textContent = formatDuration(0);

    try {
      await recorder.start();
    } catch (error) {
      logDeveloperError('start', error.cause ?? error);
      showError(RECORDER_ERROR_MESSAGES[error.code] ?? RECORDER_ERROR_MESSAGES[RecorderErrorCode.RECORDING_FAILED]);
      setAppState(AppState.IDLE);
    }
  });

  el.pause.addEventListener('click', () => recorder.pause());
  el.resume.addEventListener('click', () => recorder.resume());

  el.stop.addEventListener('click', () => {
    recorder.stop('manual');
  });

  el.convert.addEventListener('click', () => {
    startConversion();
  });

  el.reset.addEventListener('click', resetAll);
  el.resetCompleted.addEventListener('click', resetAll);

  /* ページ離脱時にマイクとWorkerを解放する。 */
  window.addEventListener('pagehide', () => {
    generation += 1;
    if (converter) {
      converter.cancel();
      converter = null;
    }
    recorder.dispose();
    releaseOriginal();
    releaseMp3();
  });

  /* ---------- 起動時チェック ---------- */

  if (!isSecureContextAvailable()) {
    showError(RECORDER_ERROR_MESSAGES[RecorderErrorCode.INSECURE_CONTEXT]);
    el.start.disabled = true;
  } else if (!isRecordingSupported()) {
    showError(RECORDER_ERROR_MESSAGES[RecorderErrorCode.UNSUPPORTED]);
    el.start.disabled = true;
  }

  el.time.textContent = formatDuration(0);
  setAppState(AppState.IDLE);
});

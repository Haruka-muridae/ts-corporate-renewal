/*
 * UI層。
 * 状態遷移、DOM更新、支援技術への通知、各層の呼び出しを担当する。
 * 録音の実処理は recorder.js、保存の実処理は saver.js が持つ。
 *
 * Phase 1〜2 の範囲。MP3変換（Phase 3）は未実装で、
 * 保存ボタンは無効状態で表示している。
 */

import {
  MAX_RECORDING_SECONDS,
  Recorder,
  RecorderErrorCode,
  RecorderState,
  isRecordingSupported,
  isSecureContextAvailable,
} from './recorder.js';

import { SAVE_TARGETS } from './saver.js';

/* 利用者向けの文言。内部エラーはここに出さず、コンソールへ記録する。 */
const ERROR_MESSAGES = {
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

const STATUS_MESSAGES = {
  ready: '録音の準備ができています。',
  requesting: 'マイクの使用を許可してください。',
  recording: '録音しています。',
  paused: '一時停止しています。',
  stoppedManual: '録音を停止しました。内容を確認できます。',
  stoppedLimit: '録音上限に達したため停止しました。内容を確認できます。',
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
  /* 利用者には見せず、開発者向けにのみ残す。 */
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
    result: document.getElementById('recorder-result'),
    player: document.getElementById('recorder-player'),
    meta: document.getElementById('recorder-meta'),
    saveGroup: document.getElementById('recorder-save-group'),
    saveNote: document.getElementById('recorder-save-note'),
    start: document.getElementById('recorder-start'),
    pause: document.getElementById('recorder-pause'),
    resume: document.getElementById('recorder-resume'),
    stop: document.getElementById('recorder-stop'),
    reset: document.getElementById('recorder-reset'),
  };

  if (!el.app) {
    return;
  }

  let previewUrl = null;

  const recorder = new Recorder({
    onStateChange: render,
    onTick: (elapsed) => {
      el.time.textContent = formatDuration(elapsed);
    },
    onWarning: () => {
      showNotice(`まもなく録音上限（${formatDuration(MAX_RECORDING_SECONDS)}）です。`);
    },
    onStop: handleStop,
    onError: (error) => {
      logDeveloperError('recording', error.cause ?? error);
      showError(error.code);
      render();
    },
  });

  /* 上限値は定数から描画する。HTML側に数値を重複させない。 */
  el.limit.textContent = `上限 ${formatDuration(MAX_RECORDING_SECONDS)}`;

  function releasePreview() {
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
      previewUrl = null;
    }

    el.player.removeAttribute('src');
    el.player.load();
  }

  function showNotice(message) {
    el.notice.textContent = message;
    el.notice.hidden = false;
  }

  function clearNotice() {
    el.notice.textContent = '';
    el.notice.hidden = true;
  }

  function showError(code) {
    el.error.textContent = ERROR_MESSAGES[code] ?? ERROR_MESSAGES[RecorderErrorCode.RECORDING_FAILED];
    el.error.hidden = false;
  }

  function clearError() {
    el.error.textContent = '';
    el.error.hidden = true;
  }

  function handleStop(result, reason) {
    /*
     * データが1バイトも無い録音は「完了」として扱わない。
     * 開始直後の停止などで発生しうる。プレイヤーを空で出さず、
     * idle へ戻して案内する。
     */
    if (!result.blob || result.blob.size === 0) {
      logDeveloperError('empty-recording', {
        size: result.blob?.size ?? null,
        duration: result.durationSeconds,
      });
      recorder.dispose();
      el.time.textContent = formatDuration(0);
      el.error.textContent = '録音データを取得できませんでした。もう一度お試しください。';
      el.error.hidden = false;
      render();
      return;
    }

    releasePreview();

    previewUrl = URL.createObjectURL(result.blob);
    el.player.src = previewUrl;

    el.meta.textContent = [
      `長さ ${formatDuration(result.durationSeconds)}`,
      `サイズ ${formatSize(result.blob.size)}`,
      `形式 ${result.mimeType ?? '不明'}`,
    ].join(' ／ ');

    el.status.textContent = reason === 'limit'
      ? STATUS_MESSAGES.stoppedLimit
      : STATUS_MESSAGES.stoppedManual;

    if (reason === 'limit') {
      showNotice(`録音上限（${formatDuration(MAX_RECORDING_SECONDS)}）に達したため、自動的に停止しました。`);
    } else {
      clearNotice();
    }

    render();
  }

  function render() {
    const state = recorder.state;
    const isRecording = state === RecorderState.RECORDING;
    const isPaused = state === RecorderState.PAUSED;
    const isStopped = state === RecorderState.STOPPED;
    const isRequesting = state === RecorderState.REQUESTING;

    el.app.dataset.state = state;

    el.start.hidden = isRecording || isPaused || isStopped;
    el.start.disabled = isRequesting;
    /* 一時停止に対応しない環境ではボタン自体を出さない。 */
    el.pause.hidden = !isRecording || !recorder.canPause;
    el.resume.hidden = !isPaused;
    el.stop.hidden = !isRecording && !isPaused;
    el.result.hidden = !isStopped;

    el.indicator.hidden = !isRecording && !isPaused;
    el.indicatorLabel.textContent = isPaused ? '一時停止中' : '録音中';

    if (isRequesting) {
      el.status.textContent = STATUS_MESSAGES.requesting;
    } else if (isRecording) {
      el.status.textContent = STATUS_MESSAGES.recording;
    } else if (isPaused) {
      el.status.textContent = STATUS_MESSAGES.paused;
    } else if (state === RecorderState.IDLE) {
      el.status.textContent = STATUS_MESSAGES.ready;
    }
  }

  el.start.addEventListener('click', async () => {
    clearError();
    clearNotice();
    releasePreview();
    el.time.textContent = formatDuration(0);

    try {
      await recorder.start();
    } catch (error) {
      logDeveloperError('start', error.cause ?? error);
      showError(error.code);
    }

    render();
  });

  el.pause.addEventListener('click', () => {
    recorder.pause();
  });

  el.resume.addEventListener('click', () => {
    recorder.resume();
  });

  el.stop.addEventListener('click', () => {
    recorder.stop('manual');
  });

  el.reset.addEventListener('click', () => {
    releasePreview();
    clearNotice();
    clearError();
    el.time.textContent = formatDuration(0);
    recorder.dispose();
    render();
    el.start.focus();
  });

  /*
   * 保存先ボタンは saver.js の一覧から生成する。
   * Google Drive を追加するときは saver.js へ登録するだけでよい。
   * Phase 3 で MP3 変換を実装するまでは、すべて無効状態で表示する。
   */
  SAVE_TARGETS.forEach((target) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn btn--primary recorder__save';
    button.textContent = `${target.label}（MP3）`;
    button.disabled = true;
    button.dataset.saveTarget = target.id;
    el.saveGroup.append(button);
  });

  el.saveNote.textContent = 'MP3への変換と保存は、次の工程で実装します。';

  /* ページ離脱時にマイクを確実に解放する。 */
  window.addEventListener('pagehide', () => {
    recorder.dispose();
    releasePreview();
  });

  /* 起動時の前提条件を確認する。 */
  if (!isSecureContextAvailable()) {
    showError(RecorderErrorCode.INSECURE_CONTEXT);
    el.start.disabled = true;
  } else if (!isRecordingSupported()) {
    showError(RecorderErrorCode.UNSUPPORTED);
    el.start.disabled = true;
  }

  el.time.textContent = formatDuration(0);
  render();
});

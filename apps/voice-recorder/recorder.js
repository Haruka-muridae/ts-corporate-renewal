/*
 * 録音層。
 * MediaRecorder による録音のみを担当する。
 * DOM操作、MP3変換、ファイル保存は行わない。
 *
 * 将来 AudioWorklet 方式へ移行する場合は、このファイルだけを差し替える。
 * 呼び出し側（script.js）が依存するのは、下記の公開APIと通知イベントのみ。
 */

/* 録音時間の上限。ここだけを変更すれば通知と自動停止の両方に反映される。 */
export const MAX_RECORDING_SECONDS = 5 * 60;
export const WARNING_RECORDING_SECONDS = 4 * 60;

/*
 * MIMEタイプは固定せず、実行環境ごとに選択する。
 * 上から順に isTypeSupported() で評価し、最初に対応したものを使う。
 */
const MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/mp4',
];

/* エラーは種別コードへ正規化する。利用者向け文言はUI層が持つ。 */
export const RecorderErrorCode = {
  UNSUPPORTED: 'UNSUPPORTED',
  INSECURE_CONTEXT: 'INSECURE_CONTEXT',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  NO_DEVICE: 'NO_DEVICE',
  DEVICE_BUSY: 'DEVICE_BUSY',
  NO_SUPPORTED_MIME: 'NO_SUPPORTED_MIME',
  RECORDING_FAILED: 'RECORDING_FAILED',
};

export class RecorderError extends Error {
  constructor(code, cause) {
    super(code);
    this.name = 'RecorderError';
    this.code = code;
    /* 内部例外は利用者へ表示せず、開発者ログ用に保持する。 */
    this.cause = cause ?? null;
  }
}

export function isRecordingSupported() {
  return Boolean(
    typeof MediaRecorder !== 'undefined'
    && navigator.mediaDevices
    && typeof navigator.mediaDevices.getUserMedia === 'function',
  );
}

export function isSecureContextAvailable() {
  return window.isSecureContext === true;
}

/* 対応するMIMEタイプを返す。いずれも非対応なら null。 */
export function pickMimeType() {
  if (typeof MediaRecorder === 'undefined'
    || typeof MediaRecorder.isTypeSupported !== 'function') {
    return null;
  }

  return MIME_CANDIDATES.find((type) => MediaRecorder.isTypeSupported(type)) ?? null;
}

function toRecorderError(error) {
  const name = error?.name;

  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return new RecorderError(RecorderErrorCode.PERMISSION_DENIED, error);
  }

  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return new RecorderError(RecorderErrorCode.NO_DEVICE, error);
  }

  if (name === 'NotReadableError' || name === 'AbortError') {
    return new RecorderError(RecorderErrorCode.DEVICE_BUSY, error);
  }

  return new RecorderError(RecorderErrorCode.RECORDING_FAILED, error);
}

export const RecorderState = {
  IDLE: 'idle',
  REQUESTING: 'requesting',
  RECORDING: 'recording',
  PAUSED: 'paused',
  STOPPED: 'stopped',
};

export class Recorder {
  /*
   * options:
   *   onStateChange(state)          状態が変わったとき
   *   onTick(elapsedSeconds)        経過時間の更新（約250ms間隔）
   *   onWarning(remainingSeconds)   上限接近時に一度だけ
   *   onStop(result, reason)        停止時。reason は 'manual' | 'limit'
   *   onError(recorderError)        録音中の異常終了
   */
  constructor(options = {}) {
    this.options = options;
    this.state = RecorderState.IDLE;
    this.mimeType = null;

    this.stream = null;
    this.recorder = null;
    this.chunks = [];

    this.accumulatedMs = 0;
    this.segmentStartedAt = null;
    this.tickTimerId = null;
    this.warningNotified = false;
    this.stopReason = 'manual';
  }

  get elapsedSeconds() {
    const running = this.segmentStartedAt === null ? 0 : Date.now() - this.segmentStartedAt;
    return Math.floor((this.accumulatedMs + running) / 1000);
  }

  /* 一時停止に対応しない環境ではUI側でボタンを隠すため公開する。 */
  get canPause() {
    return Boolean(this.recorder && typeof this.recorder.pause === 'function');
  }

  setState(next) {
    if (this.state === next) {
      return;
    }

    this.state = next;
    this.options.onStateChange?.(next);
  }

  async start() {
    if (!isSecureContextAvailable()) {
      throw new RecorderError(RecorderErrorCode.INSECURE_CONTEXT);
    }

    if (!isRecordingSupported()) {
      throw new RecorderError(RecorderErrorCode.UNSUPPORTED);
    }

    this.setState(RecorderState.REQUESTING);

    let stream;

    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      this.setState(RecorderState.IDLE);
      throw toRecorderError(error);
    }

    this.stream = stream;
    this.mimeType = pickMimeType();
    this.chunks = [];
    this.accumulatedMs = 0;
    this.warningNotified = false;
    this.stopReason = 'manual';

    try {
      /*
       * 候補が全滅した場合も、ブラウザ既定の形式で録音を試みる。
       * それも失敗したときに初めて非対応として扱う。
       */
      this.recorder = this.mimeType
        ? new MediaRecorder(stream, { mimeType: this.mimeType })
        : new MediaRecorder(stream);

      /* 既定形式になった場合は実際の値を採用する。 */
      if (!this.mimeType) {
        this.mimeType = this.recorder.mimeType || null;
      }
    } catch (error) {
      this.releaseStream();
      this.setState(RecorderState.IDLE);
      throw new RecorderError(RecorderErrorCode.NO_SUPPORTED_MIME, error);
    }

    this.recorder.addEventListener('dataavailable', (event) => {
      if (event.data && event.data.size > 0) {
        this.chunks.push(event.data);
      }
    });

    this.recorder.addEventListener('error', (event) => {
      this.teardownTimer();
      this.releaseStream();
      this.setState(RecorderState.IDLE);
      this.options.onError?.(
        new RecorderError(RecorderErrorCode.RECORDING_FAILED, event.error ?? event),
      );
    });

    this.recorder.addEventListener('stop', () => {
      this.handleStopped();
    });

    try {
      /* 1秒ごとにチャンクを受け取る。停止時の一括取得より復旧余地がある。 */
      this.recorder.start(1000);
    } catch (error) {
      this.releaseStream();
      this.setState(RecorderState.IDLE);
      throw new RecorderError(RecorderErrorCode.RECORDING_FAILED, error);
    }

    this.segmentStartedAt = Date.now();
    this.setState(RecorderState.RECORDING);
    this.startTimer();
  }

  pause() {
    if (this.state !== RecorderState.RECORDING || !this.canPause) {
      return;
    }

    this.recorder.pause();
    this.accumulatedMs += Date.now() - this.segmentStartedAt;
    this.segmentStartedAt = null;
    this.setState(RecorderState.PAUSED);
  }

  resume() {
    if (this.state !== RecorderState.PAUSED) {
      return;
    }

    this.recorder.resume();
    this.segmentStartedAt = Date.now();
    this.setState(RecorderState.RECORDING);
  }

  stop(reason = 'manual') {
    if (this.state !== RecorderState.RECORDING && this.state !== RecorderState.PAUSED) {
      return;
    }

    this.stopReason = reason;

    if (this.segmentStartedAt !== null) {
      this.accumulatedMs += Date.now() - this.segmentStartedAt;
      this.segmentStartedAt = null;
    }

    this.teardownTimer();
    this.recorder.stop();
  }

  handleStopped() {
    /* マイクのインジケータを確実に消すため、停止直後に必ずトラックを止める。 */
    this.releaseStream();

    const durationSeconds = Math.floor(this.accumulatedMs / 1000);
    const blob = new Blob(this.chunks, this.mimeType ? { type: this.mimeType } : undefined);

    this.chunks = [];
    this.setState(RecorderState.STOPPED);

    this.options.onStop?.({
      blob,
      mimeType: this.mimeType,
      durationSeconds,
    }, this.stopReason);
  }

  startTimer() {
    this.teardownTimer();

    this.tickTimerId = window.setInterval(() => {
      const elapsed = this.elapsedSeconds;
      this.options.onTick?.(elapsed);

      if (!this.warningNotified && elapsed >= WARNING_RECORDING_SECONDS
        && elapsed < MAX_RECORDING_SECONDS) {
        this.warningNotified = true;
        this.options.onWarning?.(MAX_RECORDING_SECONDS - elapsed);
      }

      if (elapsed >= MAX_RECORDING_SECONDS) {
        this.stop('limit');
      }
    }, 250);
  }

  teardownTimer() {
    if (this.tickTimerId !== null) {
      window.clearInterval(this.tickTimerId);
      this.tickTimerId = null;
    }
  }

  releaseStream() {
    if (!this.stream) {
      return;
    }

    this.stream.getTracks().forEach((track) => track.stop());
    this.stream = null;
  }

  /* ページ離脱時やリセット時に呼ぶ。 */
  dispose() {
    this.teardownTimer();

    if (this.recorder && this.recorder.state !== 'inactive') {
      try {
        this.recorder.stop();
      } catch {
        /* 停止済みの場合は無視してよい。 */
      }
    }

    this.releaseStream();
    this.recorder = null;
    this.chunks = [];
    this.accumulatedMs = 0;
    this.segmentStartedAt = null;
    this.setState(RecorderState.IDLE);
  }
}

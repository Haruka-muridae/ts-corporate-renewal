/*
 * 録音のオーケストレーション（メインスレッド）。要件書 §FR-04 / §FR-06 / §8.2。
 * AudioWorklet で PCM を取得し、Worker へ渡して逐次 MP3 化・OPFS 保存する。
 * 録音全体の PCM/MP3 はメモリに保持しない。
 *
 * ------------------------------------------------------------------
 * このファイルは画面を知らない
 * ------------------------------------------------------------------
 * DOM操作・文言・エラー表示をここに書かないこと。
 * 状態と結果はコールバック（options）で外へ渡し、画面の判断は app.js が持つ。
 * エラーもコード（RecorderErrorCode）だけを返し、文言への変換は errors.js が行う。
 * ------------------------------------------------------------------
 *
 * public/apps/voice-recorder/long-recorder.js からの複製。
 * 複製元との違い:
 *   - 上限・警告・空き容量・ビットレートを ../config.js から取る（60分→90分ほか）
 *   - 「長時間モード」という区別が無いため Long 接頭辞を外した
 *   - MVPでは復旧機能を持たない点は複製元と同じ（§2.2 / §10-14）
 */

import {
  BITRATE_KBPS,
  MAX_SECONDS,
  MIN_FREE_BYTES,
  SAFE_MIN_BYTES,
  WARNING_SECONDS,
} from '../config.js';

import {
  checkFreeSpace,
  detectSupport,
  isSupportedSampleRate,
} from './capabilities.js';

import {
  RECORDINGS_DIR,
  buildPartName,
  deleteRecording,
  getRecordingFile,
  probeSyncAccessSupport,
} from './opfs-storage.js';

export const RecorderState = {
  IDLE: 'idle',
  PREPARING: 'preparing',
  RECORDING: 'recording',
  STOPPING: 'stopping',
  FINALIZED: 'finalized',
  ERROR: 'error',
};

export const RecorderErrorCode = {
  UNSUPPORTED: 'UNSUPPORTED',
  INSUFFICIENT_STORAGE: 'INSUFFICIENT_STORAGE',
  SYNC_ACCESS_UNSUPPORTED: 'SYNC_ACCESS_UNSUPPORTED',
  UNSUPPORTED_SAMPLE_RATE: 'UNSUPPORTED_SAMPLE_RATE',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  NO_DEVICE: 'NO_DEVICE',
  DEVICE_BUSY: 'DEVICE_BUSY',
  WORKLET_FAILED: 'WORKLET_FAILED',
  WORKER_FAILED: 'WORKER_FAILED',
  OPFS_FAILED: 'OPFS_FAILED',
  ENCODE_FAILED: 'ENCODE_FAILED',
  FINALIZE_FAILED: 'FINALIZE_FAILED',
};

/*
 * バックプレッシャ（未処理秒数）の閾値（§8.2）。
 * Worker がエンコードに追いつかないまま録音を続けると、
 * 送出済み PCM がメモリに溜まり「メモリ一定」の前提が崩れる。
 */
const BACKPRESSURE_WARN_SECONDS = 5;
const BACKPRESSURE_STOP_SECONDS = 10;

/* 録音中に空き容量を監視する間隔（§FR-04）。 */
const CAPACITY_CHECK_INTERVAL_MS = 15000;

function toStartErrorCode(error) {
  const name = error?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') return RecorderErrorCode.PERMISSION_DENIED;
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return RecorderErrorCode.NO_DEVICE;
  if (name === 'NotReadableError' || name === 'AbortError') return RecorderErrorCode.DEVICE_BUSY;
  return RecorderErrorCode.WORKLET_FAILED;
}

export class Recorder {
  /*
   * options:
   *   onStateChange(state)
   *   onTick(elapsedSeconds, bytesWritten)
   *   onWarning(kind)      'limit-approaching' | 'backpressure' | 'capacity-low' | 'hidden' | 'interrupted'
   *   onStopped(reason)    'manual' | 'limit' | 'backpressure' | 'capacity' | 'mic-ended' | 'interrupted'
   *   onFinalized(result)  { file, fileName, sizeBytes, durationSeconds }
   *   onError(code)
   */
  constructor(options = {}) {
    this.options = options;
    this.state = RecorderState.IDLE;

    this.stream = null;
    this.ownsStream = false;
    this.audioContext = null;
    this.sourceNode = null;
    this.workletNode = null;
    this.gainNode = null;
    this.worker = null;

    this.partName = null;
    this.startedAt = null;
    this.tickTimer = null;
    this.capacityTimer = null;

    this.sentSeconds = 0;
    this.encodedSeconds = 0;
    this.bytesWritten = 0;
    this.sampleRate = 0;

    this.limitWarned = false;
    this.backpressureWarned = false;
    this.stopReason = 'manual';
    this.finalizing = false;

    this.boundVisibility = () => this.handleVisibilityChange();
  }

  setState(next) {
    if (this.state === next) return;
    this.state = next;
    this.options.onStateChange?.(next);
  }

  /* 開始前チェック：対応環境と空き容量。画面の初期表示で使う。 */
  static async preflight() {
    const support = detectSupport();
    if (!support.supported) {
      return { ok: false, code: RecorderErrorCode.UNSUPPORTED, support };
    }
    const space = await checkFreeSpace(MIN_FREE_BYTES);
    if (!space.ok) {
      return { ok: false, code: RecorderErrorCode.INSUFFICIENT_STORAGE, space };
    }
    return { ok: true, support, space };
  }

  async start({ stream } = {}) {
    const support = detectSupport();
    if (!support.supported) {
      throw this.fail(RecorderErrorCode.UNSUPPORTED);
    }

    const space = await checkFreeSpace(MIN_FREE_BYTES);
    if (!space.ok) {
      throw this.fail(RecorderErrorCode.INSUFFICIENT_STORAGE);
    }

    /*
     * SyncAccessHandle の実対応を Worker 内で確認する。
     * ここで先に検証しておけば、非対応時にマイクを要求せずに済む。
     */
    const probe = await probeSyncAccessSupport();
    if (!probe.supported) {
      throw this.fail(RecorderErrorCode.SYNC_ACCESS_UNSUPPORTED, probe.error);
    }

    this.setState(RecorderState.PREPARING);

    /* 外部ストリーム（オンラインミックス）か、マイク取得。 */
    try {
      if (stream) {
        this.stream = stream;
        this.ownsStream = false;
      } else {
        this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        this.ownsStream = true;
      }
    } catch (error) {
      this.setState(RecorderState.IDLE);
      throw this.fail(toStartErrorCode(error), error);
    }

    /* AudioContext とサンプルレート確認（44100/48000 のみ）。 */
    try {
      this.audioContext = new AudioContext();
    } catch (error) {
      this.teardownStream();
      this.setState(RecorderState.IDLE);
      throw this.fail(RecorderErrorCode.WORKLET_FAILED, error);
    }

    /*
     * iOS Safari 等では、操作から時間が経ってから作った AudioContext が
     * suspended のまま始まり、無音のまま録音が進む。明示的に resume する。
     * 失敗しても後段の onstatechange で検出できるため、ここでは止めない。
     */
    if (this.audioContext.state !== 'running') {
      try { await this.audioContext.resume(); } catch { /* onstatechange で扱う */ }
    }

    this.sampleRate = this.audioContext.sampleRate;
    if (!isSupportedSampleRate(this.sampleRate)) {
      await this.teardownAudio();
      this.teardownStream();
      this.setState(RecorderState.IDLE);
      throw this.fail(RecorderErrorCode.UNSUPPORTED_SAMPLE_RATE);
    }

    /* AudioWorklet 登録とグラフ構築。 */
    try {
      await this.audioContext.audioWorklet.addModule(new URL('./pcm-worklet.js', import.meta.url));
      this.sourceNode = this.audioContext.createMediaStreamSource(this.stream);
      this.workletNode = new AudioWorkletNode(this.audioContext, 'pcm-worklet');
      /* 出力させないため gain 0 を挟んで destination へ繋ぎ、process を回す。 */
      this.gainNode = this.audioContext.createGain();
      this.gainNode.gain.value = 0;
      this.sourceNode.connect(this.workletNode);
      this.workletNode.connect(this.gainNode);
      this.gainNode.connect(this.audioContext.destination);
    } catch (error) {
      await this.teardownAudio();
      this.teardownStream();
      this.setState(RecorderState.IDLE);
      throw this.fail(RecorderErrorCode.WORKLET_FAILED, error);
    }

    /* Worker 起動と初期化を待つ。 */
    try {
      await this.startWorker();
    } catch (error) {
      await this.teardownAudio();
      this.teardownStream();
      /* 初期化中に作りかけた一時ファイルがあれば削除する。 */
      if (this.partName) {
        await deleteRecording(this.partName);
        this.partName = null;
      }
      this.setState(RecorderState.IDLE);
      throw (error instanceof Error && error.code) ? error : this.fail(RecorderErrorCode.WORKER_FAILED, error);
    }

    /* Worklet → main → Worker の PCM 中継を開始。 */
    this.workletNode.port.onmessage = (event) => this.handlePcm(event.data);

    /* 監視類。 */
    this.audioContext.onstatechange = () => this.handleAudioStateChange();
    this.stream.getTracks().forEach((track) => {
      track.addEventListener('ended', () => this.stop('mic-ended'));
    });
    document.addEventListener('visibilitychange', this.boundVisibility);

    this.startedAt = Date.now();
    this.limitWarned = false;
    this.backpressureWarned = false;
    this.setState(RecorderState.RECORDING);
    this.startTimers();
  }

  startWorker() {
    return new Promise((resolve, reject) => {
      let worker;
      try {
        worker = new Worker(new URL('./encoder-worker.js', import.meta.url));
      } catch (error) {
        reject(this.fail(RecorderErrorCode.WORKER_FAILED, error));
        return;
      }
      this.worker = worker;

      const onReady = (event) => {
        const m = event.data;
        if (m?.type === 'ready') {
          worker.removeEventListener('message', onReady);
          worker.onmessage = (e) => this.handleWorkerMessage(e.data);
          resolve();
        } else if (m?.type === 'error') {
          worker.removeEventListener('message', onReady);
          reject(this.fail(this.mapWorkerError(m.code), m.detail));
        }
      };
      worker.addEventListener('message', onReady);
      worker.onerror = (event) => reject(this.fail(RecorderErrorCode.WORKER_FAILED, event.message ?? event));

      const now = new Date();
      /* 乱数は多重起動の衝突回避のみが目的。時刻はローカル時刻。 */
      const token = Math.floor((Date.now() % 100000)).toString(36) + this.sampleRate.toString(36);
      this.partName = buildPartName(now, token);

      worker.postMessage({
        type: 'init',
        sampleRate: this.sampleRate,
        bitrateKbps: BITRATE_KBPS,
        dirName: RECORDINGS_DIR,
        fileName: this.partName,
      });
    });
  }

  handlePcm(pcm) {
    if (this.state !== RecorderState.RECORDING || !this.worker) {
      return;
    }
    /* 送出した音声秒数を積算（バックプレッシャ計測に使う）。 */
    this.sentSeconds += pcm.length / this.sampleRate;
    /* Float32 の buffer を transfer。以後このチャンクは参照しない。 */
    this.worker.postMessage({ type: 'pcm', pcm }, [pcm.buffer]);
  }

  handleWorkerMessage(message) {
    switch (message?.type) {
      case 'progress':
        this.encodedSeconds = message.encodedSeconds ?? this.encodedSeconds;
        this.bytesWritten = message.bytesWritten ?? this.bytesWritten;
        this.checkBackpressure();
        break;
      case 'finalized':
        this.completeFinalize(message);
        break;
      case 'aborted':
        this.teardownWorker();
        break;
      case 'error':
        this.handleWorkerError(this.mapWorkerError(message.code));
        break;
      default:
        break;
    }
  }

  checkBackpressure() {
    const backlog = this.sentSeconds - this.encodedSeconds;
    if (backlog >= BACKPRESSURE_STOP_SECONDS) {
      this.stop('backpressure');
    } else if (backlog >= BACKPRESSURE_WARN_SECONDS && !this.backpressureWarned) {
      this.backpressureWarned = true;
      this.options.onWarning?.('backpressure');
    }
  }

  get elapsedSeconds() {
    return this.startedAt === null ? 0 : Math.floor((Date.now() - this.startedAt) / 1000);
  }

  startTimers() {
    this.teardownTimers();
    this.tickTimer = window.setInterval(() => {
      const elapsed = this.elapsedSeconds;
      this.options.onTick?.(elapsed, this.bytesWritten);

      /* 残り5分の予告（§FR-04）。一度だけ出す。 */
      if (!this.limitWarned && elapsed >= WARNING_SECONDS && elapsed < MAX_SECONDS) {
        this.limitWarned = true;
        this.options.onWarning?.('limit-approaching');
      }
      /* 上限到達で自動停止（§FR-04）。 */
      if (elapsed >= MAX_SECONDS) {
        this.stop('limit');
      }
    }, 500);

    this.capacityTimer = window.setInterval(async () => {
      const space = await checkFreeSpace(SAFE_MIN_BYTES);
      if (!space.ok && space.reason === 'insufficient') {
        this.options.onWarning?.('capacity-low');
        this.stop('capacity');
      }
    }, CAPACITY_CHECK_INTERVAL_MS);
  }

  teardownTimers() {
    if (this.tickTimer !== null) { window.clearInterval(this.tickTimer); this.tickTimer = null; }
    if (this.capacityTimer !== null) { window.clearInterval(this.capacityTimer); this.capacityTimer = null; }
  }

  handleAudioStateChange() {
    const s = this.audioContext?.state;
    /* 着信・画面ロック等で suspended/interrupted になる。自動再開に頼らず確定する。 */
    if ((s === 'suspended' || s === 'interrupted') && this.state === RecorderState.RECORDING) {
      this.options.onWarning?.('interrupted');
      this.stop('interrupted');
    }
  }

  handleVisibilityChange() {
    if (document.hidden && this.state === RecorderState.RECORDING) {
      /*
       * タブ非表示。デスクトップでは録音は継続するため即停止はしないが、
       * 中断リスクを警告する。実際に音声が止まる場合は onstatechange が
       * suspended/interrupted を発火し、そちらで確定・停止する。
       */
      this.options.onWarning?.('hidden');
    }
  }

  /* 停止して確定する。reason は表示用。 */
  stop(reason = 'manual') {
    if (this.state !== RecorderState.RECORDING || this.finalizing) {
      return;
    }
    this.finalizing = true;
    this.stopReason = reason;
    this.setState(RecorderState.STOPPING);

    this.teardownTimers();
    document.removeEventListener('visibilitychange', this.boundVisibility);

    /* Worklet に端数の送出を促してから音声グラフを止める。 */
    try { this.workletNode?.port.postMessage('stop'); } catch { /* noop */ }

    /* 音声取り込みを止める（マイクのインジケータを消す）。 */
    this.teardownStream();
    this.teardownAudioSoon();

    /* Worker に確定を依頼。finalized を待つ。 */
    try {
      this.worker?.postMessage({ type: 'stop' });
    } catch (error) {
      this.handleWorkerError(RecorderErrorCode.FINALIZE_FAILED, error);
    }
  }

  async completeFinalize(message) {
    this.teardownWorker();

    let file = null;
    try {
      file = await getRecordingFile(message.fileName);
    } catch (error) {
      console.warn('[voice-recorder] 確定ファイルの取得に失敗', error);
    }

    this.setState(RecorderState.FINALIZED);
    this.options.onStopped?.(this.stopReason);
    this.options.onFinalized?.({
      file,
      fileName: message.fileName,
      sizeBytes: message.bytesWritten ?? (file ? file.size : 0),
      durationSeconds: message.durationSeconds ?? this.encodedSeconds,
    });
  }

  /* 破棄：一時ファイルを削除して初期状態へ戻す（§FR-05）。 */
  async discard() {
    this.teardownTimers();
    document.removeEventListener('visibilitychange', this.boundVisibility);
    this.teardownStream();
    this.teardownAudioSoon();

    if (this.worker) {
      try { this.worker.postMessage({ type: 'abort' }); } catch { /* noop */ }
      /* aborted を待たずに参照は残し、メッセージ受信で teardown する。保険で遅延破棄。 */
      window.setTimeout(() => this.teardownWorker(), 3000);
    }

    /* Worker 側の削除に失敗した場合に備え、メイン側でも削除を試みる。 */
    if (this.partName) {
      await deleteRecording(this.partName);
    }

    this.resetCounters();
    this.finalizing = false;
    this.setState(RecorderState.IDLE);
  }

  handleWorkerError(code) {
    this.teardownTimers();
    document.removeEventListener('visibilitychange', this.boundVisibility);
    this.teardownStream();
    this.teardownAudioSoon();
    this.teardownWorker();
    this.setState(RecorderState.ERROR);
    this.options.onError?.(code ?? RecorderErrorCode.ENCODE_FAILED);
  }

  mapWorkerError(code) {
    switch (code) {
      case 'WORKER_LOAD_FAILED': return RecorderErrorCode.WORKER_FAILED;
      case 'ENCODER_INIT_FAILED': return RecorderErrorCode.ENCODE_FAILED;
      case 'OPFS_OPEN_FAILED': return RecorderErrorCode.OPFS_FAILED;
      case 'OPFS_WRITE_FAILED': return RecorderErrorCode.OPFS_FAILED;
      case 'FINALIZE_FAILED': return RecorderErrorCode.FINALIZE_FAILED;
      default: return RecorderErrorCode.ENCODE_FAILED;
    }
  }

  fail(code, cause) {
    const err = new Error(code);
    err.code = code;
    err.cause = cause ?? null;
    return err;
  }

  /* ---- リソース解放 ---- */

  teardownStream() {
    if (this.stream) {
      if (this.ownsStream) {
        this.stream.getTracks().forEach((t) => t.stop());
      }
      this.stream = null;
      this.ownsStream = false;
    }
  }

  async teardownAudio() {
    try { this.sourceNode?.disconnect(); } catch { /* noop */ }
    try { this.workletNode?.disconnect(); } catch { /* noop */ }
    try { this.gainNode?.disconnect(); } catch { /* noop */ }
    this.sourceNode = null;
    this.workletNode = null;
    this.gainNode = null;
    if (this.audioContext) {
      try { await this.audioContext.close(); } catch { /* noop */ }
      this.audioContext = null;
    }
  }

  /* 停止直後は finalize と競合しないよう、非同期でオーディオを閉じる。 */
  teardownAudioSoon() {
    try { this.sourceNode?.disconnect(); } catch { /* noop */ }
    try { this.workletNode?.disconnect(); } catch { /* noop */ }
    try { this.gainNode?.disconnect(); } catch { /* noop */ }
    this.sourceNode = null;
    this.workletNode = null;
    this.gainNode = null;
    const ctx = this.audioContext;
    this.audioContext = null;
    if (ctx) {
      ctx.close().catch(() => {});
    }
  }

  teardownWorker() {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
  }

  resetCounters() {
    this.sentSeconds = 0;
    this.encodedSeconds = 0;
    this.bytesWritten = 0;
    this.startedAt = null;
    this.partName = null;
  }

  /* ページ離脱時。録音中なら一時ファイルは残す（次回起動時に自動削除される）。 */
  dispose() {
    this.teardownTimers();
    document.removeEventListener('visibilitychange', this.boundVisibility);
    this.teardownStream();
    this.teardownAudioSoon();
    this.teardownWorker();
  }
}

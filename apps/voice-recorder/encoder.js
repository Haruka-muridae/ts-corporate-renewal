/*
 * 変換層（メインスレッド側）。
 * 録音Blobをデコードし、モノラル化・必要時のリサンプリング・Int16化を行い、
 * Web Worker へ PCM を渡して MP3 を受け取る。
 * DOM操作、録音、保存は行わない。
 *
 * lamejs 本体は worker.js から importScripts で読み込む。
 * このファイルは lamejs を直接参照しない。
 */

export const MP3_BITRATE_KBPS = 96;

/*
 * MP3（MPEG-1/2/2.5 Layer III）が規格上サポートするサンプルレート。
 * lamejs はこれ以外の値も例外を出さずに受理してしまうため、
 * 出力の正当性を保証できるこの集合だけを許可する。
 */
const MP3_SAMPLE_RATES = [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000];

function isValidMp3Rate(rate) {
  return MP3_SAMPLE_RATES.includes(rate);
}

/* 入力レートに最も近い、規格上有効なMP3サンプルレートを選ぶ。 */
function nearestMp3Rate(rate) {
  return MP3_SAMPLE_RATES.reduce((best, candidate) => (
    Math.abs(candidate - rate) < Math.abs(best - rate) ? candidate : best
  ), MP3_SAMPLE_RATES[0]);
}

export const ConversionErrorCode = {
  ARRAY_BUFFER_FAILED: 'ARRAY_BUFFER_FAILED',
  DECODE_FAILED: 'DECODE_FAILED',
  EMPTY_AUDIO: 'EMPTY_AUDIO',
  PCM_ALLOCATION_FAILED: 'PCM_ALLOCATION_FAILED',
  RESAMPLE_FAILED: 'RESAMPLE_FAILED',
  WORKER_CREATE_FAILED: 'WORKER_CREATE_FAILED',
  WORKER_LOAD_FAILED: 'WORKER_LOAD_FAILED',
  ENCODER_INIT_FAILED: 'ENCODER_INIT_FAILED',
  ENCODE_FAILED: 'ENCODE_FAILED',
  WORKER_CRASHED: 'WORKER_CRASHED',
  EMPTY_MP3: 'EMPTY_MP3',
  CANCELLED: 'CANCELLED',
};

export class ConversionError extends Error {
  constructor(code, cause) {
    super(code);
    this.name = 'ConversionError';
    this.code = code;
    this.cause = cause ?? null;
  }
}

const AudioContextClass = typeof AudioContext !== 'undefined'
  ? AudioContext
  : (typeof webkitAudioContext !== 'undefined' ? webkitAudioContext : null);

const OfflineAudioContextClass = typeof OfflineAudioContext !== 'undefined'
  ? OfflineAudioContext
  : (typeof webkitOfflineAudioContext !== 'undefined' ? webkitOfflineAudioContext : null);

/* 複数チャンネルを単純平均でモノラルへ落とす。 */
function downmixToMono(audioBuffer) {
  const channels = audioBuffer.numberOfChannels;
  const length = audioBuffer.length;

  if (channels === 1) {
    /* すでにモノラル。呼び出し側が保持しないビューをそのまま返す。 */
    return audioBuffer.getChannelData(0);
  }

  const mixed = new Float32Array(length);

  for (let ch = 0; ch < channels; ch += 1) {
    const data = audioBuffer.getChannelData(ch);
    for (let i = 0; i < length; i += 1) {
      mixed[i] += data[i] / channels;
    }
  }

  return mixed;
}

/*
 * 規格外レートのときだけ、ブラウザ内蔵の高品質リサンプラー
 * （OfflineAudioContext）でモノラル・目標レートへ変換する。
 * 単純な間引きは行わない。
 */
async function resampleToMono(audioBuffer, targetRate) {
  if (!OfflineAudioContextClass) {
    throw new ConversionError(ConversionErrorCode.RESAMPLE_FAILED);
  }

  const frameCount = Math.max(1, Math.ceil(audioBuffer.duration * targetRate));

  let offline;
  try {
    offline = new OfflineAudioContextClass(1, frameCount, targetRate);
  } catch (error) {
    throw new ConversionError(ConversionErrorCode.RESAMPLE_FAILED, error);
  }

  const source = offline.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(offline.destination);
  source.start();

  const rendered = await offline.startRendering();
  return rendered.getChannelData(0);
}

/* Float32(-1..1) を Int16 PCM の独立配列へ変換する。 */
function floatToInt16(float32) {
  const length = float32.length;
  let int16;

  try {
    int16 = new Int16Array(length);
  } catch (error) {
    throw new ConversionError(ConversionErrorCode.PCM_ALLOCATION_FAILED, error);
  }

  for (let i = 0; i < length; i += 1) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }

  return int16;
}

/*
 * MP3変換を1回実行する。
 * 二重起動防止と世代管理は UI 層（script.js）が担う。
 * このクラスは1回のconvertにつき1つのWorkerを持ち、cancelで破棄する。
 */
export class Mp3Converter {
  constructor() {
    this.worker = null;
    this.cancelled = false;
  }

  cancel() {
    this.cancelled = true;
    this.terminateWorker();
  }

  terminateWorker() {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
  }

  /*
   * blob: MediaRecorder が出力した元形式の音声
   * callbacks: { onStatus(state), onProgress(ratio0to1) }
   * 戻り値: { blob(MP3), sampleRate, channels, durationSeconds }
   */
  async convert(blob, callbacks = {}) {
    const { onStatus, onProgress } = callbacks;

    if (!AudioContextClass) {
      throw new ConversionError(ConversionErrorCode.DECODE_FAILED);
    }

    onStatus?.('decoding');

    let arrayBuffer;
    try {
      arrayBuffer = await blob.arrayBuffer();
    } catch (error) {
      throw new ConversionError(ConversionErrorCode.ARRAY_BUFFER_FAILED, error);
    }

    this.throwIfCancelled();

    const audioContext = new AudioContextClass();
    let audioBuffer;
    try {
      audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
    } catch (error) {
      throw new ConversionError(ConversionErrorCode.DECODE_FAILED, error);
    } finally {
      /* デコード専用のContextは即座に閉じ、リソースを返す。 */
      audioContext.close().catch(() => {});
    }

    this.throwIfCancelled();

    if (!audioBuffer || audioBuffer.length === 0) {
      throw new ConversionError(ConversionErrorCode.EMPTY_AUDIO);
    }

    const inputRate = audioBuffer.sampleRate;
    const inputChannels = audioBuffer.numberOfChannels;

    /*
     * サンプルレート方針:
     *  - 44100/48000 など規格内はそのまま維持（リサンプリングしない）
     *  - 規格外のときだけ、最も近い有効レートへ高品質変換する
     */
    let monoFloat;
    let outputRate;

    if (isValidMp3Rate(inputRate)) {
      outputRate = inputRate;
      monoFloat = downmixToMono(audioBuffer);
    } else {
      outputRate = nearestMp3Rate(inputRate);
      monoFloat = await resampleToMono(audioBuffer, outputRate);
    }

    this.throwIfCancelled();

    const durationSeconds = Math.round(audioBuffer.duration);
    const int16 = floatToInt16(monoFloat);
    /* Float32側の参照を手放し、GC対象にする。 */
    monoFloat = null;
    audioBuffer = null;

    onStatus?.('encoding');
    onProgress?.(0);

    const mp3Buffer = await this.encodeInWorker(int16, outputRate, onProgress);

    if (!mp3Buffer || mp3Buffer.byteLength === 0) {
      throw new ConversionError(ConversionErrorCode.EMPTY_MP3);
    }

    const mp3Blob = new Blob([mp3Buffer], { type: 'audio/mpeg' });

    return {
      blob: mp3Blob,
      sampleRate: outputRate,
      inputRate,
      inputChannels,
      durationSeconds,
    };
  }

  encodeInWorker(int16, sampleRate, onProgress) {
    return new Promise((resolve, reject) => {
      let worker;
      try {
        /* import.meta.url 基準で解決するため、サブパス配信でも壊れない。 */
        worker = new Worker(new URL('./worker.js', import.meta.url));
      } catch (error) {
        reject(new ConversionError(ConversionErrorCode.WORKER_CREATE_FAILED, error));
        return;
      }

      this.worker = worker;

      worker.onmessage = (event) => {
        const message = event.data;

        if (this.cancelled) {
          return;
        }

        switch (message?.type) {
          case 'progress':
            onProgress?.(message.ratio);
            break;
          case 'complete':
            this.terminateWorker();
            resolve(message.buffer);
            break;
          case 'error':
            this.terminateWorker();
            reject(new ConversionError(
              message.code ?? ConversionErrorCode.ENCODE_FAILED,
              message.detail ?? null,
            ));
            break;
          default:
            break;
        }
      };

      worker.onerror = (event) => {
        this.terminateWorker();
        if (!this.cancelled) {
          /* Worker本体やimportScriptsの読み込み失敗を含む。 */
          reject(new ConversionError(ConversionErrorCode.WORKER_LOAD_FAILED, event.message ?? event));
        }
      };

      /* Int16 の buffer だけを transfer する。以後メイン側は int16 を触らない。 */
      worker.postMessage(
        { type: 'encode', pcm: int16, sampleRate, bitrate: MP3_BITRATE_KBPS },
        [int16.buffer],
      );
    });
  }

  throwIfCancelled() {
    if (this.cancelled) {
      throw new ConversionError(ConversionErrorCode.CANCELLED);
    }
  }
}

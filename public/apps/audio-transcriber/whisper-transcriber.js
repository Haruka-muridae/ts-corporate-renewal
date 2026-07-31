/*
 * 端末内文字起こしの窓口（UIスレッド側）。
 *
 * whisper-worker.js との通信、区間の分割と結果の連結、キャンセルを担当する。
 * DOM操作と画面文言はここに置かない。進捗は onProgress で呼び出し側へ返す。
 *
 * 音声は外部へ一切送信しない。通信が発生するのは
 * 「Hugging Face からのモデルのダウンロード」と「ライブラリ本体の取得」だけである。
 */

import { WHISPER } from './config.js';
import { decodeToPcm, splitPcm, AudioError, AudioErrorCode } from './audio-loader.js';

export const WhisperErrorCode = {
  WORKER_FAILED: 'WORKER_FAILED',
  /*
   * WebGPU での初期化に失敗した。内部でのみ使うコードで、利用者には見せない。
   * transcribeBlob が Worker を作り直して WASM で再挑戦する。
   */
  WEBGPU_FAILED: 'WEBGPU_FAILED',
  MODEL_LOAD_FAILED: 'MODEL_LOAD_FAILED',
  MODEL_RUN_FAILED: 'MODEL_RUN_FAILED',
  OUT_OF_MEMORY: 'OUT_OF_MEMORY',
  CANCELLED: 'CANCELLED',
  UNKNOWN: 'UNKNOWN',
};

export class WhisperError extends Error {
  constructor(code, detail = null) {
    super(code);
    this.name = 'WhisperError';
    this.code = code;
    this.detail = detail;
  }
}

/* ---------- Worker の生成と破棄 ---------- */

let worker = null;
/* 区間ごとの通し番号。応答をどの要求のものか見分けるために使う。 */
let requestSeq = 0;

function createWorker() {
  /*
   * type: 'module' は必須。
   * whisper-worker.js が CDN から import しており、
   * クラシックワーカーでは import 文が使えない。
   */
  return new Worker(new URL('./whisper-worker.js', import.meta.url), { type: 'module' });
}

function ensureWorker() {
  if (!worker) {
    worker = createWorker();
  }

  return worker;
}

/*
 * Worker を捨てる。
 *
 * 推論の途中で確実に止める方法は terminate しかない
 * （WASM/WebGPU の実行中は cancel メッセージが読まれないため）。
 * 代償として、次回はモデルを読み直すことになる。
 * ただしモデルのファイル自体はブラウザのキャッシュに残るので、
 * 再ダウンロードは発生せず、待ち時間は初回よりずっと短い。
 */
export function disposeWorker() {
  if (worker) {
    worker.terminate();
    worker = null;
  }
}

/* ---------- 区間1つぶんの実行 ---------- */

function transcribeSegment({ pcm, modelId, language, returnTimestamps, offsetSec, signal, onProgress, forceDevice }) {
  return new Promise((resolve, reject) => {
    const active = ensureWorker();
    const id = (requestSeq += 1);

    const cleanup = () => {
      active.removeEventListener('message', onMessage);
      active.removeEventListener('error', onWorkerError);
      signal?.removeEventListener('abort', onAbort);
    };

    function onAbort() {
      cleanup();
      /* 実行中の推論は terminate でしか止まらない。 */
      disposeWorker();
      reject(new WhisperError(WhisperErrorCode.CANCELLED, 'aborted'));
    }

    function onWorkerError(event) {
      cleanup();
      /*
       * import に失敗した場合などはここへ来る。
       * 壊れた Worker は再利用しない。
       */
      disposeWorker();
      reject(new WhisperError(WhisperErrorCode.WORKER_FAILED, event?.message ? 'worker_error' : 'unknown'));
    }

    function onMessage(event) {
      const message = event.data ?? {};

      switch (message.type) {
        case 'model-loading':
          onProgress?.({ phase: 'loading-model', device: message.device, ratio: null });
          return;

        case 'model-progress':
          onProgress?.({
            phase: 'loading-model',
            file: message.file,
            loaded: message.loaded,
            total: message.total,
            ratio: message.ratio,
          });
          return;

        case 'model-fallback':
          onProgress?.({ phase: 'model-fallback', from: message.from, ratio: null });
          return;

        case 'model-ready':
          onProgress?.({ phase: 'model-ready', device: message.device, reused: message.reused, ratio: null });
          return;

        case 'result':
          if (message.id !== id) {
            return;
          }

          cleanup();
          resolve({ text: message.text, chunks: message.chunks ?? [] });
          return;

        case 'cancelled':
          cleanup();
          reject(new WhisperError(WhisperErrorCode.CANCELLED, 'worker_cancelled'));
          return;

        case 'error': {
          if (message.id !== null && message.id !== id) {
            return;
          }

          cleanup();
          const code = Object.hasOwn(WhisperErrorCode, message.code)
            ? message.code
            : WhisperErrorCode.UNKNOWN;
          reject(new WhisperError(code, message.detail ?? null));
          return;
        }

        default:
          /* 未知の通知は無視する。将来 Worker 側が増やしても壊れないようにする。 */
      }
    }

    if (signal?.aborted) {
      reject(new WhisperError(WhisperErrorCode.CANCELLED, 'aborted'));
      return;
    }

    active.addEventListener('message', onMessage);
    active.addEventListener('error', onWorkerError);
    signal?.addEventListener('abort', onAbort, { once: true });

    active.postMessage({
      type: 'transcribe',
      id,
      /*
       * subarray のビューをそのまま渡すと、構造化複製で元のバッファ全体が
       * コピーされる実装があるため、区間ぶんだけを切り出して渡す。
       */
      pcm: pcm.slice(),
      modelId,
      dtype: WHISPER.dtype,
      wasmSessionOptions: WHISPER.wasmSessionOptions,
      /* 'wasm' を指定したときだけ、Worker 側の自動判定を上書きする。 */
      forceDevice,
      language,
      returnTimestamps,
      chunkSeconds: WHISPER.chunkSeconds,
      strideSeconds: WHISPER.chunkOverlapSeconds,
      offsetSec,
    });
  });
}

/* ---------- 全体の実行 ---------- */

/*
 * Blob を文字起こしする。
 *
 * options:
 *   modelId          … config.js の WHISPER.models のいずれか
 *   language         … 'ja' | 'en' | 'auto'
 *   returnTimestamps … タイムスタンプを取得するか
 *   signal           … AbortSignal。中断すると Worker を落とす
 *   onProgress       … { phase, ratio, index, total, ... } を受け取る
 *
 * 戻り値: { text, chunks, device }
 */
export async function transcribeBlob(blob, {
  modelId = WHISPER.defaultModelId,
  language = 'ja',
  returnTimestamps = true,
  signal,
  onProgress,
} = {}) {
  onProgress?.({ phase: 'decoding', ratio: null });

  let decoded;

  try {
    decoded = await decodeToPcm(blob, { signal });
  } catch (error) {
    if (error instanceof AudioError && error.code === AudioErrorCode.CANCELLED) {
      throw new WhisperError(WhisperErrorCode.CANCELLED, 'aborted');
    }

    /* デコードの失敗は音声側の問題なので、そのまま上へ渡す。 */
    throw error;
  }

  const segments = splitPcm(decoded.pcm, decoded.sampleRate, WHISPER.segmentSeconds);
  const texts = [];
  const allChunks = [];
  let device = null;

  /*
   * WebGPU が駄目だと分かったら、以降の区間はすべて WASM で処理する。
   * 区間ごとに WebGPU を試し直すと、そのたびに失敗して時間を捨てることになる。
   */
  let forceDevice;

  for (let index = 0; index < segments.length; index += 1) {
    if (signal?.aborted) {
      throw new WhisperError(WhisperErrorCode.CANCELLED, 'aborted');
    }

    const segment = segments[index];

    const runSegment = () => transcribeSegment({
      pcm: segment.pcm,
      modelId,
      language,
      returnTimestamps,
      offsetSec: segment.startSec,
      signal,
      forceDevice,
      onProgress: (progress) => {
        if (progress.phase === 'model-ready') {
          device = progress.device;
        }

        onProgress?.({ ...progress, index, total: segments.length });

        /*
         * モデルの準備が終わってから区間の推論が終わるまでの間、
         * Worker からは何も届かない。そのままだと画面が
         * 「WebGPUで実行します。」のまま何分も止まって見えるため、
         * ここで「何区間目を処理中か」へ表示を進めておく。
         */
        if (progress.phase === 'model-ready') {
          onProgress?.({
            phase: 'transcribing',
            index: index + 1,
            total: segments.length,
            ratio: index / segments.length,
          });
        }
      },
    });

    let result;

    try {
      result = await runSegment();
    } catch (error) {
      if (!(error instanceof WhisperError) || error.code !== WhisperErrorCode.WEBGPU_FAILED) {
        throw error;
      }

      /*
       * WebGPU の初期化に失敗した。
       *
       * 同じ Worker で device だけ変えても ONNX Runtime が最初に解決した
       * バックエンドを使い続けるため（実ブラウザで確認済み）、
       * Worker ごと捨てて作り直し、WASM で最初からやり直す。
       * モデルのファイルはブラウザのキャッシュに残っているので再取得は起きない。
       */
      onProgress?.({ phase: 'model-fallback', from: 'webgpu', ratio: null, index, total: segments.length });
      disposeWorker();
      forceDevice = 'wasm';
      result = await runSegment();
    }

    texts.push(result.text.trim());
    allChunks.push(...result.chunks);

    onProgress?.({
      phase: 'transcribing',
      index: index + 1,
      total: segments.length,
      ratio: (index + 1) / segments.length,
    });
  }

  return {
    /* 区間の境目は改行で継ぐ。空の区間（無音）は捨てる。 */
    text: texts.filter((text) => text !== '').join('\n'),
    chunks: allChunks,
    device,
    durationSec: decoded.durationSec,
  };
}

/*
 * 端末内文字起こしの実行役（Web Worker）。
 *
 * このファイルは UI スレッドから切り離されている。
 * DOM へは一切触れない。進捗も結果も postMessage で返す。
 * モデルの読み込みと推論は数十秒〜数分かかるため、
 * ここを Worker に置かないと画面が固まる（それが Worker を使う唯一の理由）。
 *
 * 音声は「16kHz モノラルの Float32Array」で受け取る。
 * 変換は audio-loader.js の担当で、ここではやらない。
 *
 * ------------------------------------------------------------------
 * 実行環境の選択（実ブラウザでの検証を踏まえた設計）
 * ------------------------------------------------------------------
 * navigator.gpu の有無だけでは判定できない。
 * Chrome は GPU が使えない環境でも navigator.gpu を生やしたままにするため、
 * requestAdapter() が null を返して初めて分かる。そこで実際にアダプタを要求する。
 *
 * さらに重要な制約として、**同じ Worker の中で device を変えて
 * pipeline() を作り直しても効かない**。ONNX Runtime が最初に解決した
 * バックエンドを保持するため、2回目に device:'wasm' を渡しても
 * 「no available backend found. ERR: [webgpu]」で失敗する（実測）。
 *
 * したがってこの Worker は1回に1つの device しか試さない。
 * WebGPU で失敗したときは WEBGPU_FAILED を返し、
 * whisper-transcriber.js が Worker ごと作り直して WASM で再挑戦する。
 * Worker を作り直せばモジュールの状態も初期化されるので、確実に切り替わる。
 *
 * 失敗してもエラーを返すだけで、アプリ全体は止めない。
 * ------------------------------------------------------------------
 */

import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0/dist/transformers.min.js';

/*
 * ローカルのモデルファイルは持たないので、探しに行かせない。
 * これを false にしないと、毎回 404 になるリクエストが1往復ぶん無駄に出る。
 */
env.allowLocalModels = false;

/*
 * ブラウザのキャッシュを使う。
 * 2回目以降は Hugging Face から再ダウンロードせず、キャッシュから読む。
 */
env.useBrowserCache = true;

/* ---------- 状態 ---------- */

/* 生成済みのパイプライン。モデルIDが同じ間は作り直さない。 */
let transcriber = null;
let loadedModelId = null;
let loadedDevice = null;

/* 進行中の処理を止めるための印。terminate と併用する。 */
let cancelled = false;

/* ---------- 送信 ---------- */

function post(message) {
  self.postMessage(message);
}

function postError(id, code, detail) {
  /* detail は種別だけ。音声の内容やモデルの生の例外文は載せない。 */
  post({ type: 'error', id, code, detail: detail ? String(detail).slice(0, 120) : null });
}

/* ---------- モデルの読み込み ---------- */

/*
 * WebGPU が本当に使えるかを、アダプタを取得して確かめる。
 *
 * typeof navigator.gpu の判定では足りない。GPU が無効な環境でも
 * navigator.gpu は存在し、requestAdapter() が null を返す。
 * ここで弾いておけば、無駄なモデル読み込みと作り直しを避けられる。
 */
async function resolveDevice() {
  const gpu = self.navigator?.gpu;

  if (typeof gpu?.requestAdapter !== 'function') {
    return 'wasm';
  }

  try {
    const adapter = await gpu.requestAdapter();
    return adapter ? 'webgpu' : 'wasm';
  } catch {
    return 'wasm';
  }
}

/*
 * 進捗コールバック。
 * ライブラリからは file / loaded / total / progress / status が来る。
 * ファイル名は公開モデルのファイル名なので、そのまま画面へ出してよい。
 */
function onProgress(event) {
  if (event?.status !== 'progress' && event?.status !== 'download' && event?.status !== 'done') {
    return;
  }

  post({
    type: 'model-progress',
    file: typeof event.file === 'string' ? event.file : null,
    loaded: Number(event.loaded) || 0,
    total: Number(event.total) || 0,
    ratio: Number.isFinite(event.progress) ? Math.min(1, Math.max(0, event.progress / 100)) : null,
  });
}

async function createPipeline(modelId, device, dtype, wasmSessionOptions) {
  const options = {
    device,
    dtype,
    progress_callback: onProgress,
  };

  /*
   * WASM のときだけグラフ最適化を下げる。理由は config.js の
   * wasmSessionOptions のコメントに書いてある（ONNX Runtime の不具合回避）。
   * WebGPU は既定のままで動くため、余計な設定を渡さない。
   */
  if (device === 'wasm' && wasmSessionOptions) {
    options.session_options = wasmSessionOptions;
  }

  return pipeline('automatic-speech-recognition', modelId, options);
}

/*
 * モデルを用意する。
 * 同じモデルIDが読み込み済みならそのまま使い回す（再ダウンロードも再構築もしない）。
 */
async function ensureModel(modelId, dtype, forceDevice, wasmSessionOptions) {
  if (transcriber && loadedModelId === modelId) {
    return { device: loadedDevice, reused: true };
  }

  /* 別モデルへ切り替えるときは、前のものを明示的に解放する。 */
  if (transcriber) {
    try {
      await transcriber.dispose?.();
    } catch {
      /* 解放に失敗しても続行する。次の生成を妨げない。 */
    }

    transcriber = null;
    loadedModelId = null;
    loadedDevice = null;
  }

  /*
   * device はここで1つに決める。この Worker では作り直さない
   * （理由はファイル冒頭のとおり。切り替えは呼び出し側が Worker ごと行う）。
   */
  const device = forceDevice === 'wasm' ? 'wasm' : await resolveDevice();

  post({ type: 'model-loading', device });

  try {
    transcriber = await createPipeline(modelId, device, dtype, wasmSessionOptions);
    loadedModelId = modelId;
    loadedDevice = device;

    return { device, reused: false };
  } catch (error) {
    const detail = error?.name ?? 'pipeline_failed';

    /*
     * WebGPU で落ちた場合だけは、呼び出し側が WASM で再挑戦できるよう
     * 専用のコードで知らせる。WASM で落ちたならもう手がない。
     */
    throw Object.assign(new Error('MODEL_LOAD_FAILED'), {
      code: device === 'webgpu' ? 'WEBGPU_FAILED' : 'MODEL_LOAD_FAILED',
      detail,
    });
  }
}

/* ---------- 推論 ---------- */

/*
 * 1区間ぶんを文字起こしする。
 *
 * chunk_length_s / stride_length_s は、ライブラリが内部で 30 秒ごとに切って
 * 前後を重ねながら流すための設定。長い音声を一度に渡してもメモリが破裂しないのは
 * この仕組みのおかげだが、それでも入力の Float32Array 自体は全部メモリに載るため、
 * 呼び出し側でさらに大きな単位（segmentSeconds）に分けて渡している。
 */
async function runTranscribe({ id, pcm, language, returnTimestamps, chunkSeconds, strideSeconds, offsetSec }) {
  const options = {
    chunk_length_s: chunkSeconds,
    stride_length_s: strideSeconds,
    return_timestamps: Boolean(returnTimestamps),
  };

  /*
   * 'auto' のときは language を渡さない。
   * Whisper は language 未指定なら自ら言語を判定する。
   */
  if (language && language !== 'auto') {
    options.language = language;
    options.task = 'transcribe';
  }

  const output = await transcriber(pcm, options);

  if (cancelled) {
    return;
  }

  const text = typeof output?.text === 'string' ? output.text : '';
  const rawChunks = Array.isArray(output?.chunks) ? output.chunks : [];

  /*
   * タイムスタンプは区間内の相対時刻なので、区間の開始秒を足して全体の時刻へ直す。
   * 値が取れなかった要素は null のまま返し、表示側で扱いを決める。
   */
  const chunks = rawChunks.map((chunk) => {
    const [start, end] = Array.isArray(chunk?.timestamp) ? chunk.timestamp : [null, null];

    return {
      text: typeof chunk?.text === 'string' ? chunk.text : '',
      start: Number.isFinite(start) ? start + offsetSec : null,
      end: Number.isFinite(end) ? end + offsetSec : null,
    };
  });

  post({ type: 'result', id, text, chunks });
}

/* ---------- 受信 ---------- */

self.addEventListener('message', async (event) => {
  const message = event.data ?? {};

  if (message.type === 'cancel') {
    cancelled = true;
    return;
  }

  if (message.type === 'transcribe') {
    cancelled = false;

    try {
      const { device, reused } = await ensureModel(message.modelId, message.dtype, message.forceDevice, message.wasmSessionOptions);
      post({ type: 'model-ready', device, reused });

      if (cancelled) {
        post({ type: 'cancelled', id: message.id });
        return;
      }

      await runTranscribe(message);

      if (cancelled) {
        post({ type: 'cancelled', id: message.id });
      }
    } catch (error) {
      if (cancelled) {
        post({ type: 'cancelled', id: message.id });
        return;
      }

      const code = error?.code
        ?? (/out of memory|allocation/i.test(String(error?.message ?? '')) ? 'OUT_OF_MEMORY' : 'MODEL_RUN_FAILED');

      postError(message.id, code, error?.detail ?? error?.name);
    }

    return;
  }

  postError(message.id ?? null, 'UNKNOWN_COMMAND', message.type);
});

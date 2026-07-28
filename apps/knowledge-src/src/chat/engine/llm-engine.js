/*
 * ブラウザ内LLMの実行層。
 *
 * ------------------------------------------------------------------
 * 差し替え可能にしてある理由
 * ------------------------------------------------------------------
 * 実モデルは 1.4GB 以上あり、テストのたびに取得するのは現実的でない。
 * そこで「エンジン」を1つのインターフェースに閉じ込め、
 * テストでは setEngineFactory() で偽物へ差し替えられるようにしてある。
 *
 * インターフェース:
 *   create({ modelId, onProgress, signal }) -> engine
 *   engine.chat({ messages, options, onToken, signal }) -> Promise<string>
 *   engine.dispose() -> Promise<void>
 *   engine.info -> { modelId, contextLen, ... }
 *
 * 本番実装（WebLLM）は動的 import する。
 * これによりチャット画面を開いただけではライブラリ本体を読み込まず、
 * 「モデルを準備する」を押すまで通信もメモリ確保も起きない。
 * ------------------------------------------------------------------
 */

import { AppError, toAppError } from '../../core/errors.js';
import { ChatErrorCode } from './errors.js';
import { logger } from '../../core/logger.js';

let engineFactory = null;
let current = null;
let currentModelId = null;

/* テスト用の差し替え口。null に戻すと本番実装へ戻る。 */
export function setEngineFactory(factory) {
  engineFactory = factory;
}

export function getLoadedModelId() {
  return currentModelId;
}

export function isEngineReady() {
  return current !== null;
}

/*
 * モデルを用意する。
 *
 * onProgress({ phase, ratio, text, loadedBytes, totalBytes, file })
 *   phase: 'downloading' | 'initializing'
 */
export async function prepareEngine({ modelId, onProgress, signal } = {}) {
  if (!modelId) {
    throw new AppError(ChatErrorCode.MODEL_INIT_FAILED, 'no_model_id');
  }

  /* 同じモデルが既に載っていれば作り直さない。 */
  if (current && currentModelId === modelId) {
    return current;
  }

  await disposeEngine();

  const factory = engineFactory ?? defaultFactory;

  const startedAt = Date.now();

  try {
    current = await factory({ modelId, onProgress, signal });
    currentModelId = modelId;

    /*
     * 準備にかかった時間を残す。
     * 「2回目以降は速い（キャッシュが効いている）」ことを画面で示すために使う。
     */
    const initMs = Date.now() - startedAt;
    current.info = { ...(current.info ?? {}), modelId, initMs, readyAt: new Date().toISOString() };

    logger.info('chat:engine-ready', { modelId, initMs });
    return current;
  } catch (error) {
    current = null;
    currentModelId = null;
    throw normalizeEngineError(error);
  }
}

export function getEngine() {
  return current;
}

export async function disposeEngine() {
  if (!current) {
    return;
  }

  const engine = current;
  current = null;
  currentModelId = null;

  try {
    await engine.dispose?.();
  } catch (error) {
    logger.warn('chat:engine-dispose-failed', { name: error?.name ?? 'unknown' });
  }
}

/*
 * 本番実装。@mlc-ai/web-llm を動的に読み込む。
 *
 * ここが唯一 WebLLM に触れる場所。
 * 送信するのは「モデルファイルの取得（GET）」だけで、
 * 質問文・資料本文・回答は外部へ出ない（すべてローカルの WebGPU 上で処理される）。
 */
async function defaultFactory({ modelId, onProgress, signal }) {
  const webllm = await import('@mlc-ai/web-llm');

  if (signal?.aborted) {
    throw new AppError(ChatErrorCode.CANCELLED_BY_USER, 'aborted_before_start');
  }

  /* 実際に配布されている model_id かを、ライブラリ側の一覧で確認する。 */
  const supported = (webllm.prebuiltAppConfig?.model_list ?? []).map((m) => m.model_id);

  if (supported.length > 0 && !supported.includes(modelId)) {
    throw new AppError(ChatErrorCode.MODEL_NOT_SUPPORTED, modelId);
  }

  const engine = await webllm.CreateMLCEngine(modelId, {
    initProgressCallback: (report) => {
      onProgress?.(normalizeProgress(report));
    },
    /* ログをコンソールへ垂れ流さない（質問や資料が出ることは無いが、静かにする）。 */
    logLevel: 'WARN',
  });

  const config = webllm.prebuiltAppConfig?.model_list?.find((m) => m.model_id === modelId) ?? null;

  return {
    info: {
      modelId,
      contextLen: config?.overrides?.context_window_size ?? null,
      vramMB: config?.vram_required_MB ?? null,
      lib: 'web-llm',
      libVersion: webllm.modelVersion ?? '',
    },

    async chat({ messages, options = {}, onToken, signal: chatSignal }) {
      let text = '';

      const stream = await engine.chat.completions.create({
        stream: true,
        messages,
        temperature: options.temperature,
        top_p: options.topP,
        max_tokens: options.maxTokens,
      });

      try {
        for await (const part of stream) {
          if (chatSignal?.aborted) {
            /* 生成を止める。ここまでの出力は保持して返す。 */
            await engine.interruptGenerate?.();
            break;
          }

          const delta = part?.choices?.[0]?.delta?.content ?? '';

          if (delta) {
            text += delta;
            onToken?.(delta, text);
          }
        }
      } catch (error) {
        if (chatSignal?.aborted) {
          return text;
        }
        throw normalizeEngineError(error);
      }

      return text;
    },

    async interrupt() {
      await engine.interruptGenerate?.();
    },

    async dispose() {
      await engine.unload?.();
    },
  };
}

/*
 * WebLLM の進捗レポートを、画面で使う形へそろえる。
 *
 * report.text は「Fetching param cache[12/50]: 300MB fetched. 24% completed」
 * のような英語の1行。数値だけ取り出し、表示は日本語で組み立てる。
 */
export function normalizeProgress(report) {
  const text = String(report?.text ?? '');
  const ratio = Number(report?.progress ?? 0);

  const fetched = /(\d+(?:\.\d+)?)\s*MB\s+fetched/i.exec(text);
  const shard = /\[(\d+)\/(\d+)\]/.exec(text);
  const initializing = /shader|initializ|compil|loading model|GPU/i.test(text) && !/fetch/i.test(text);

  return {
    phase: initializing ? 'initializing' : 'downloading',
    ratio: Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 0,
    loadedMB: fetched ? Number(fetched[1]) : null,
    fileIndex: shard ? Number(shard[1]) : null,
    fileTotal: shard ? Number(shard[2]) : null,
    /* 原文も持つが、画面には日本語の要約を出す。 */
    raw: text.slice(0, 200),
  };
}

/* エンジン由来の例外を、利用者向けコードへ写像する。 */
export function normalizeEngineError(error) {
  if (error instanceof AppError) {
    return error;
  }

  const name = String(error?.name ?? '');
  const message = String(error?.message ?? error ?? '');

  if (name === 'AbortError' || /abort/i.test(message)) {
    return new AppError(ChatErrorCode.CANCELLED_BY_USER, name || 'abort');
  }

  if (/device.*lost|GPUDevice|device lost/i.test(message)) {
    return new AppError(ChatErrorCode.GPU_DEVICE_LOST, message.slice(0, 120));
  }

  if (/out of memory|OOM|allocat/i.test(message)) {
    return new AppError(ChatErrorCode.OUT_OF_MEMORY, message.slice(0, 120));
  }

  if (/quota|storage/i.test(message)) {
    return new AppError(ChatErrorCode.CACHE_QUOTA_EXCEEDED, message.slice(0, 120));
  }

  if (/fetch|network|Failed to fetch|ERR_/i.test(message)) {
    return new AppError(ChatErrorCode.MODEL_DOWNLOAD_FAILED, message.slice(0, 120));
  }

  if (/WebGPU|adapter|gpu/i.test(message)) {
    return new AppError(ChatErrorCode.WEBGPU_UNAVAILABLE, message.slice(0, 120));
  }

  if (/wasm|WebAssembly|compil/i.test(message)) {
    return new AppError(ChatErrorCode.MODEL_INIT_FAILED, message.slice(0, 120));
  }

  return toAppError(error, ChatErrorCode.MODEL_INIT_FAILED);
}

/*
 * ブラウザに保存されたモデルのキャッシュを消す。
 *
 * ナレッジ管理アプリのデータ（IndexedDB の tsam-knowledge）には触れない。
 * モデルは Cache Storage と、WebLLM 専用の IndexedDB に置かれる。
 */
export async function clearModelCache() {
  await disposeEngine();

  const removed = { caches: [], databases: [] };

  if (typeof globalThis.caches !== 'undefined') {
    const keys = await caches.keys();

    for (const key of keys) {
      /* ナレッジ側は Cache Storage を使っていないが、念のため名前で絞る。 */
      if (/webllm|mlc|tvm/i.test(key)) {
        /* eslint-disable-next-line no-await-in-loop */
        await caches.delete(key);
        removed.caches.push(key);
      }
    }
  }

  if (typeof indexedDB?.databases === 'function') {
    const dbs = await indexedDB.databases().catch(() => []);

    for (const info of dbs) {
      const name = String(info?.name ?? '');

      /* tsam-knowledge（ナレッジ本体）は絶対に消さない。 */
      if (name === 'tsam-knowledge' || name === '') {
        continue;
      }

      if (/webllm|mlc|tvm/i.test(name)) {
        /* eslint-disable-next-line no-await-in-loop */
        await new Promise((resolve) => {
          const request = indexedDB.deleteDatabase(name);
          request.onsuccess = () => resolve();
          request.onerror = () => resolve();
          request.onblocked = () => resolve();
        });
        removed.databases.push(name);
      }
    }
  }

  logger.info('chat:model-cache-cleared', {
    caches: removed.caches.length, databases: removed.databases.length,
  });

  return removed;
}

/*
 * キャッシュ済みモデルの実サイズを測る。
 *
 * navigator.storage.estimate() はサイト全体の合計しか返さないため、
 * 「モデルがどれだけ場所を取っているか」を出すにはこちらで数える。
 * Content-Length ヘッダの合計なので、本体は読み出さない（速い）。
 */
export async function measureModelCacheBytes() {
  if (typeof globalThis.caches === 'undefined') {
    return null;
  }

  const keys = (await caches.keys().catch(() => [])).filter((key) => /webllm|mlc|tvm/i.test(key));

  let bytes = 0;
  let entries = 0;

  for (const key of keys) {
    /* eslint-disable-next-line no-await-in-loop */
    const cache = await caches.open(key).catch(() => null);

    if (!cache) {
      continue;
    }

    /* eslint-disable-next-line no-await-in-loop */
    const requests = await cache.keys().catch(() => []);

    /* eslint-disable-next-line no-await-in-loop */
    const responses = await Promise.all(requests.map((request) => cache.match(request).catch(() => null)));

    responses.forEach((response) => {
      if (!response) {
        return;
      }

      entries += 1;

      const length = Number(response.headers?.get?.('content-length') ?? 0);

      if (Number.isFinite(length) && length > 0) {
        bytes += length;
      }
    });
  }

  return { bytes, entries, cacheNames: keys };
}

/* モデルがキャッシュ済みかの目安（Cache Storage のキー有無で判定）。 */
export async function hasCachedModel() {
  if (typeof globalThis.caches === 'undefined') {
    return false;
  }

  const keys = await caches.keys().catch(() => []);
  return keys.some((key) => /webllm|mlc|tvm/i.test(key));
}

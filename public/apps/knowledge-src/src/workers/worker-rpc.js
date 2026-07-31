/*
 * Web Worker との最小RPC。
 *
 * メッセージ形式（メイン → Worker）
 *   { ns, id, type, payload }
 * メッセージ形式（Worker → メイン）
 *   { ns, id, ok: true,  result }
 *   { ns, id, ok: false, error: { code, detail } }
 *   { ns, id, progress: {...} }        … 途中経過（解決しない）
 *
 * ------------------------------------------------------------------
 * ns（名前空間）が必要な理由
 * ------------------------------------------------------------------
 * PDF.js は Worker の中で動かすと、自分用のWorkerを作れず
 * 「フェイクワーカー」へ切り替わる（内部で window を参照するため）。
 * このとき PDF.js は **同じ self のメッセージチャネル** を使うので、
 * 解析ワーカーの通信路に PDF.js の内部メッセージが混ざる。
 *
 * どちらも相手のメッセージを無視できるよう、こちらのメッセージには
 * 必ず ns を付け、ns が一致しないものは読み飛ばす。
 * ------------------------------------------------------------------
 *
 * 重要な設計:
 *   - Worker が異常終了しても、待機中の呼び出しをすべて reject する。
 *     放置すると UI が「解析中」のまま固まる。
 *   - 次回呼び出し時にWorkerを作り直す（自己修復）。
 */

import { AppError, ErrorCode } from '../core/errors.js';
import { logger } from '../core/logger.js';

const DEFAULT_TIMEOUT_MS = 120000;

/* このRPCのメッセージであることを示す印。他ライブラリの通信と混ざらないようにする。 */
export const RPC_NAMESPACE = 'tsam-knowledge-rpc';

export function createWorkerClient(factory, { name = 'worker', defaultTimeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  let worker = null;
  let nextId = 1;
  const pending = new Map();

  const rejectAll = (error) => {
    pending.forEach(({ reject, timer }) => {
      clearTimeout(timer);
      reject(error);
    });
    pending.clear();
  };

  const dispose = () => {
    if (worker) {
      try {
        worker.terminate();
      } catch {
        /* 既に終了している場合は無視する。 */
      }
      worker = null;
    }
  };

  const ensureWorker = () => {
    if (worker) {
      return worker;
    }

    worker = factory();

    worker.addEventListener('message', (event) => {
      const data = event.data;

      /* 他ライブラリ（PDF.js のフェイクワーカー等）のメッセージは読み飛ばす。 */
      if (!data || data.ns !== RPC_NAMESPACE || typeof data.id !== 'number') {
        return;
      }

      const entry = pending.get(data.id);

      if (!entry) {
        return;
      }

      if (data.progress) {
        entry.onProgress?.(data.progress);
        return;
      }

      clearTimeout(entry.timer);
      pending.delete(data.id);

      if (data.ok) {
        entry.resolve(data.result);
        return;
      }

      const code = data.error?.code ?? ErrorCode.UNKNOWN;
      entry.reject(new AppError(code, data.error?.detail ?? null));
    });

    /*
     * error は「Worker内で捕捉されなかった例外」。
     * messageerror は「構造化クローンできない値を受け取った」場合。
     * どちらもWorkerを作り直す。
     */
    worker.addEventListener('error', (event) => {
      logger.error('worker:crashed', {
        name,
        message: event?.message ?? 'unknown',
        filename: event?.filename ?? '',
        lineno: event?.lineno ?? 0,
      }, { code: ErrorCode.WORKER_CRASHED });

      rejectAll(new AppError(ErrorCode.WORKER_CRASHED, name));
      dispose();
    });

    worker.addEventListener('messageerror', () => {
      logger.error('worker:message-error', { name }, { code: ErrorCode.WORKER_CRASHED });
      rejectAll(new AppError(ErrorCode.WORKER_CRASHED, `${name}:messageerror`));
      dispose();
    });

    return worker;
  };

  return {
    call(type, payload, { transfer = [], timeoutMs = defaultTimeoutMs, onProgress, signal } = {}) {
      return new Promise((resolve, reject) => {
        let instance;

        try {
          instance = ensureWorker();
        } catch (error) {
          reject(new AppError(ErrorCode.WORKER_CRASHED, error?.message ?? 'spawn_failed', error));
          return;
        }

        const id = nextId;
        nextId += 1;

        const timer = setTimeout(() => {
          pending.delete(id);
          logger.error('worker:timeout', { name, type, timeoutMs }, { code: ErrorCode.WORKER_TIMEOUT });
          /* 応答が返らないWorkerは信用できないので作り直す。 */
          dispose();
          reject(new AppError(ErrorCode.WORKER_TIMEOUT, `${name}:${type}`));
        }, timeoutMs);

        pending.set(id, { resolve, reject, timer, onProgress });

        if (signal) {
          signal.addEventListener('abort', () => {
            const entry = pending.get(id);
            if (entry) {
              clearTimeout(entry.timer);
              pending.delete(id);
              reject(new AppError(ErrorCode.CANCELLED, `${name}:${type}`));
            }
          }, { once: true });
        }

        try {
          instance.postMessage({ ns: RPC_NAMESPACE, id, type, payload }, transfer);
        } catch (error) {
          clearTimeout(timer);
          pending.delete(id);
          reject(new AppError(ErrorCode.WORKER_CRASHED, error?.message ?? 'post_failed', error));
        }
      });
    },

    /* 明示的な破棄（全キャッシュ削除やページ離脱時）。 */
    terminate() {
      rejectAll(new AppError(ErrorCode.CANCELLED, `${name}:terminated`));
      dispose();
    },

    isRunning() {
      return worker !== null;
    },
  };
}

/*
 * Worker 側で使う共通ハンドラ。
 * 例外を必ず捕まえて { ok:false } で返す。捕まえ損ねると
 * メイン側は WORKER_CRASHED として扱うことになる。
 */
export function serveWorker(handlers) {
  self.addEventListener('message', async (event) => {
    const { ns, id, type, payload } = event.data ?? {};

    /* 自分宛て以外（PDF.js の内部メッセージなど）は無視する。 */
    if (ns !== RPC_NAMESPACE || typeof id !== 'number') {
      return;
    }

    const handler = handlers[type];

    if (!handler) {
      self.postMessage({ ns: RPC_NAMESPACE, id, ok: false, error: { code: 'UNKNOWN', detail: `no_handler:${type}` } });
      return;
    }

    const progress = (info) => self.postMessage({ ns: RPC_NAMESPACE, id, progress: info });

    try {
      const result = await handler(payload, { progress });
      self.postMessage({ ns: RPC_NAMESPACE, id, ok: true, result: result === undefined ? null : result });
    } catch (error) {
      self.postMessage({
        ns: RPC_NAMESPACE,
        id,
        ok: false,
        error: {
          code: typeof error?.code === 'string' ? error.code : 'UNKNOWN',
          detail: String(error?.detail ?? error?.message ?? error).slice(0, 500),
        },
      });
    }
  });
}

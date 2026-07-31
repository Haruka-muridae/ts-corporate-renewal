/*
 * ローカルLLMの偽エンジン。
 *
 * 本物のモデルは 1.4GB 以上あり、テストのたびに取得するのは現実的でない。
 * llm-engine.js の setEngineFactory() へこれを差し込むことで、
 *   - ダウンロードの進捗
 *   - 初期化
 *   - ストリーミング生成
 *   - 停止
 *   - 各種エラー
 * を実コードのまま通せるようにする。
 *
 * 本番コードには一切テスト用の分岐を入れていない。
 */

export function createFakeEngineFactory(options = {}) {
  const state = {
    created: 0,
    disposed: 0,
    interrupted: 0,
    /* chat() が呼ばれた回数。「モデルを動かしていない」ことの確認に使う。 */
    chats: 0,
    lastMessages: null,
    lastOptions: null,
    progressReports: [],
    /* 'ok' | 'download-fail' | 'init-fail' | 'oom' | 'gpu-lost' | 'slow' */
    mode: options.mode ?? 'ok',
    /* 応答文。関数なら messages を受け取って組み立てる。 */
    answer: options.answer ?? 'これはテスト回答です。[1]\n\n参照した資料\n[1] test.txt',
    tokenDelayMs: options.tokenDelayMs ?? 0,
    downloadSteps: options.downloadSteps ?? 4,
  };

  const factory = async ({ modelId, onProgress, signal }) => {
    state.created += 1;

    /* ダウンロード進捗を模す。 */
    for (let i = 1; i <= state.downloadSteps; i += 1) {
      if (signal?.aborted) {
        const error = new Error('aborted');
        error.name = 'AbortError';
        throw error;
      }

      const report = {
        phase: 'downloading',
        ratio: i / (state.downloadSteps + 1),
        loadedMB: i * 100,
        fileIndex: i,
        fileTotal: state.downloadSteps,
        raw: `Fetching param cache[${i}/${state.downloadSteps}]`,
      };

      state.progressReports.push(report);
      onProgress?.(report);

      if (state.mode === 'download-fail' && i === 2) {
        throw new TypeError('Failed to fetch');
      }

      /* eslint-disable-next-line no-await-in-loop */
      await new Promise((r) => setTimeout(r, 1));
    }

    const initReport = { phase: 'initializing', ratio: 0.95, raw: 'Loading model to GPU' };
    state.progressReports.push(initReport);
    onProgress?.(initReport);

    if (state.mode === 'init-fail') {
      throw new Error('WebAssembly compile failed');
    }

    if (state.mode === 'oom') {
      throw new Error('Device out of memory');
    }

    return {
      info: { modelId, contextLen: 4096, lib: 'fake' },

      async chat({ messages, options: chatOptions, onToken, signal: chatSignal }) {
        state.chats += 1;
        state.lastMessages = messages;
        state.lastOptions = chatOptions;

        if (state.mode === 'gpu-lost') {
          throw new Error('GPUDevice was lost');
        }

        const answer = typeof state.answer === 'function' ? state.answer(messages) : state.answer;
        let text = '';

        /* 1文字ずつ流す（ストリーミング表示の確認用）。 */
        for (const char of answer) {
          if (chatSignal?.aborted) {
            state.interrupted += 1;
            break;
          }

          text += char;
          onToken?.(char, text);

          if (state.tokenDelayMs > 0) {
            /* eslint-disable-next-line no-await-in-loop */
            await new Promise((r) => setTimeout(r, state.tokenDelayMs));
          }
        }

        return text;
      },

      async interrupt() {
        state.interrupted += 1;
      },

      async dispose() {
        state.disposed += 1;
      },
    };
  };

  return { factory, state };
}

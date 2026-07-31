/*
 * 画面から呼ばれる操作をまとめる。
 *
 * ここが「副作用のある場所」で、他のモジュールは純粋な部品として保つ。
 *   検索   → src/search/search-service.js（既存をそのまま使う）
 *   資料選定 → src/chat/rag/retrieve.js（純粋）
 *   プロンプト → src/chat/rag/prompt.js（純粋）
 *   推論   → src/chat/engine/llm-engine.js（差し替え可能）
 */

import { search, probeIndex } from '../search/search-service.js';
import { logger } from '../core/logger.js';
import { AppError, toAppError } from '../core/errors.js';

import { ChatErrorCode } from './engine/errors.js';
import {
  prepareEngine, getEngine, disposeEngine, clearModelCache, hasCachedModel, isEngineReady,
  measureModelCacheBytes,
} from './engine/llm-engine.js';
import { resolveModel, filterSupported, MODEL_CATALOG, DEFAULT_MODEL_ID } from './engine/model-catalog.js';
import { selectSources, expandWithNeighbors, normalizeQuestion } from './rag/retrieve.js';
import {
  assessGrounding, validateCitations, UNANSWERABLE_MESSAGE, GroundingLevel,
} from './rag/grounding.js';
import { buildMessages, estimatePromptChars, stripReasoning } from './rag/prompt.js';
import { ModelState, ChatState, canSubmit, canStop, nextMessageId, normalizeSettings } from './state/chat-state.js';
import { loadKnowledgeSummary, loadNeighborChunks } from './knowledge-source.js';
import { runDiagnostics } from './diagnostics.js';
import {
  loadChatSettings, saveChatSettings, saveConversation, listConversations,
  getConversation, deleteConversation, clearConversations, newConversationId, makeTitle,
} from './state/history-repo.js';

/* 質問の長さの上限（プロンプト全体が壊れない範囲）。 */
const MAX_QUESTION_CHARS = 2000;

/*
 * ストリーミング表示の更新間隔（ミリ秒）。
 *
 * トークンごとに再描画すると、1回の回答で数百回の描画が起き、
 * 長い回答ほど目に見えて重くなる。人の目には 80ms 以下の差は分からないため、
 * まとめて反映する。最後の1回は必ず反映する。
 */
const STREAM_FLUSH_MS = 80;

export function createActions({ store, ui }) {
  /* 生成中の中断用。1本しか走らせない。 */
  let generationController = null;
  let prepareController = null;

  const setError = (error, event) => {
    const appError = toAppError(error);
    logger.error(event, appError, { code: appError.code });
    store.patch({ lastError: { code: appError.code, message: appError.userMessage } });
    return appError;
  };

  const actions = {
    /* ---------- 設定 ---------- */

    async restoreSettings() {
      try {
        const saved = await loadChatSettings();
        const supported = filterSupported(MODEL_CATALOG.map((m) => m.id));

        store.patch({
          modelId: saved.modelId,
          settings: saved.settings,
          mode: saved.mode,
          availableModels: supported.models,
          conversations: await listConversations(),
        });
      } catch (error) {
        logger.warn('chat:settings-restore-failed', { code: error?.code ?? 'unknown' });
        store.patch({ modelId: DEFAULT_MODEL_ID, availableModels: [...MODEL_CATALOG] });
      }
    },

    async updateSettings(partial) {
      const next = normalizeSettings({ ...store.get().settings, ...partial });
      store.patch({ settings: next });

      try {
        await saveChatSettings({ modelId: store.get().modelId, settings: next, mode: store.get().mode });
      } catch (error) {
        logger.warn('chat:settings-save-failed', { code: error?.code ?? 'unknown' });
      }
    },

    async selectModel(modelId) {
      const model = resolveModel(modelId);
      store.patch({ modelId: model.id });

      /* 既に別のモデルが載っていれば降ろす（VRAMを掴んだままにしない）。 */
      if (isEngineReady()) {
        await disposeEngine();
        store.setModelState(ModelState.IDLE);
        store.patch({ modelInfo: null, notice: 'モデルを切り替えました。もう一度「モデルを準備する」を押してください。' });
      }

      await saveChatSettings({ modelId: model.id, settings: store.get().settings, mode: store.get().mode })
        .catch(() => { /* 保存できなくても操作は続けられる。 */ });
    },

    setMode(mode) {
      const next = mode === 'general' ? 'general' : 'knowledge';
      store.patch({ mode: next });
      saveChatSettings({ modelId: store.get().modelId, settings: store.get().settings, mode: next })
        .catch(() => {});
    },

    setDraft(text) {
      store.patch({ draft: String(text ?? '') });
    },

    dismissNotice() {
      store.patch({ notice: null, lastError: null });
    },

    /* ---------- モデルの準備 ---------- */

    async prepareModel() {
      const state = store.get();

      if (state.modelState === ModelState.DOWNLOADING || state.modelState === ModelState.INITIALIZING) {
        return null;
      }

      const environment = state.environment;

      if (environment && !environment.usable) {
        store.setModelState(ModelState.UNSUPPORTED);
        setError(new AppError(ChatErrorCode.WEBGPU_UNAVAILABLE, environment.gpu), 'chat:unsupported');
        return null;
      }

      /* オフラインで未取得なら、通信を試みる前に止める。 */
      if (environment && !environment.online && !(await hasCachedModel())) {
        setError(new AppError(ChatErrorCode.OFFLINE_NO_MODEL), 'chat:offline');
        store.setModelState(ModelState.ERROR);
        return null;
      }

      const model = resolveModel(state.modelId);

      prepareController = new AbortController();
      store.patch({ lastError: null, notice: null, modelProgress: { phase: 'downloading', ratio: 0 } });
      store.setModelState(ModelState.DOWNLOADING);

      try {
        const engine = await prepareEngine({
          modelId: model.id,
          signal: prepareController.signal,
          onProgress: (progress) => {
            if (progress.phase === 'initializing' && store.get().modelState !== ModelState.INITIALIZING) {
              store.setModelState(ModelState.INITIALIZING);
            }
            store.patch({ modelProgress: progress });
          },
        });

        store.patch({ modelInfo: engine.info ?? { modelId: model.id }, modelProgress: null });
        store.setModelState(ModelState.READY);
        logger.info('chat:model-ready', { modelId: model.id });

        return engine;
      } catch (error) {
        const appError = setError(error, 'chat:model-prepare-failed');
        store.patch({ modelProgress: null });
        store.setModelState(
          appError.code === ChatErrorCode.CANCELLED_BY_USER ? ModelState.IDLE : ModelState.ERROR,
        );
        return null;
      } finally {
        prepareController = null;
      }
    },

    cancelPrepare() {
      prepareController?.abort();
      store.patch({ notice: 'モデルの準備を中止しました。取得済みの分は次回に再利用されます。' });
    },

    async unloadModel() {
      await disposeEngine();
      store.setModelState(ModelState.IDLE);
      store.patch({ modelInfo: null, modelProgress: null, notice: 'モデルをメモリから解放しました。' });
    },

    /*
     * モデルのキャッシュを削除する。
     * ナレッジ管理アプリのデータ（tsam-knowledge）には触れない。
     */
    async clearModelCache() {
      try {
        const removed = await clearModelCache();
        store.setModelState(ModelState.IDLE);
        store.patch({
          modelInfo: null,
          notice: `モデルのキャッシュを削除しました（保存領域 ${removed.caches.length} 件 / データベース ${removed.databases.length} 件）。`
            + 'ナレッジのデータは削除していません。',
        });
        return removed;
      } catch (error) {
        setError(error, 'chat:model-cache-clear-failed');
        return null;
      }
    },

    /* キャッシュ済みモデルの容量を測って表示に出す。 */
    async refreshModelCache() {
      try {
        const [cached, measured] = await Promise.all([hasCachedModel(), measureModelCacheBytes()]);
        store.patch({ modelCache: { cached, ...(measured ?? {}) } });
        return store.get().modelCache;
      } catch (error) {
        logger.warn('chat:model-cache-measure-failed', { code: error?.code ?? 'unknown' });
        return null;
      }
    },

    async refreshKnowledge() {
      store.patch({ knowledge: await loadKnowledgeSummary() });
    },

    /* ---------- 診断 ---------- */

    async runDiagnostics() {
      if (store.get().diagnosticsRunning) {
        return null;
      }

      store.patch({ diagnosticsRunning: true });

      try {
        const result = await runDiagnostics({
          state: store.get(),
          deps: {
            hasCachedModel,
            /* 索引に一時データを入れて実際に引く（終わったら必ず取り除かれる）。 */
            runSearch: async () => {
              const probe = await probeIndex();
              return {
                ok: probe.found === true,
                count: probe.documentCount ?? 0,
                message: probe.found ? '' : '一時データを索引から引けませんでした。',
              };
            },
          },
        });

        store.patch({
          diagnostics: result,
          diagnosticsAt: new Date().toISOString(),
          diagnosticsRunning: false,
        });

        logger.info('chat:diagnostics', { ...result.summary });
        return result;
      } catch (error) {
        store.patch({ diagnosticsRunning: false });
        setError(error, 'chat:diagnostics-failed');
        return null;
      }
    },

    /* ---------- 質問と回答 ---------- */

    async submit(rawQuestion) {
      const state = store.get();
      const question = String(rawQuestion ?? state.draft ?? '').trim();

      const verdict = canSubmit({ ...state, draft: question });

      if (!verdict.ok) {
        store.patch({ notice: verdict.message });
        return null;
      }

      if (question.length > MAX_QUESTION_CHARS) {
        setError(new AppError(ChatErrorCode.QUESTION_TOO_LONG, String(question.length)), 'chat:question-too-long');
        return null;
      }

      const engine = getEngine();

      if (!engine) {
        setError(new AppError(ChatErrorCode.MODEL_NOT_READY), 'chat:model-not-ready');
        return null;
      }

      /* 二重送信の防止。ここから finally までが1回分。 */
      generationController = new AbortController();
      const signal = generationController.signal;

      const userMessage = {
        id: nextMessageId('u'),
        role: 'user',
        text: question,
        at: new Date().toISOString(),
      };

      const answerMessage = {
        id: nextMessageId('a'),
        role: 'assistant',
        text: '',
        sources: [],
        at: new Date().toISOString(),
        streaming: true,
      };

      store.patch({ draft: '', lastError: null, notice: null });
      store.addMessage(userMessage);
      store.addMessage(answerMessage);
      store.setChatState(ChatState.RETRIEVING);

      try {
        /* 1. 既存の全文検索（ブラウザ内・外部通信なし） */
        let sources = [];
        let searchInfo = null;
        let grounding = null;

        if (state.mode === 'knowledge') {
          const settings = state.settings;

          /*
           * 自然文の質問をそのまま AND 検索すると、ほぼ確実に0件になる。
           * 質問特有の言い回しを落としたうえで、OR 結合で関連度順に拾う。
           * 検索画面の既定（AND）は変えていない。
           */
          const searchQuery = normalizeQuestion(question);
          const found = await search(searchQuery, {
            limit: Math.max(settings.topK * 4, 20),
            searchOptions: { combineWith: 'OR' },
          });

          const selected = selectSources(found.hits, { ...settings, question });

          if (settings.neighborChunks > 0 && selected.sources.length > 0) {
            /*
             * 前後チャンクの取得は資料ごとに独立している。
             * 直列に await すると資料数だけ待ち時間が積み上がるため、まとめて投げる。
             */
            const loaded = await Promise.all(selected.sources.map((source) => loadNeighborChunks(
              source.fileId,
              source.chunkIndex,
              {
                before: settings.neighborChunks,
                after: settings.neighborChunks + Number(source.chunkIndexEnd ?? source.chunkIndex) - Number(source.chunkIndex),
              },
            )));

            const map = new Map(selected.sources.map((source, index) => [source.chunkId, loaded[index]]));

            sources = expandWithNeighbors(selected.sources, map, settings);
          } else {
            sources = selected.sources;
          }

          /*
           * 「資料にどれだけ支えられているか」を、モデルへ渡す前に測る。
           * 弱すぎる場合は生成させない（作り話を防ぐ最も確実な方法）。
           */
          grounding = assessGrounding({
            question,
            sources,
            minLevel: settings.minGroundingLevel ?? GroundingLevel.LOW,
          });

          /* 引用元に「一致率」を出せるようにする。 */
          const ratioById = new Map(grounding.perSource.map((entry) => [entry.id, entry.ratio]));
          sources = sources.map((source) => ({ ...source, matchRatio: ratioById.get(source.id) ?? 0 }));

          searchInfo = {
            total: found.total,
            reason: selected.reason,
            dropped: selected.dropped.length,
            terms: found.terms,
            query: searchQuery,
            grounding: {
              level: grounding.level,
              stars: grounding.stars,
              label: grounding.label,
              coverage: grounding.coverage,
              answerable: grounding.answerable,
            },
          };

          store.updateMessage(answerMessage.id, { sources, searchInfo, grounding });

          if (!grounding.answerable) {
            store.updateMessage(answerMessage.id, {
              text: UNANSWERABLE_MESSAGE,
              streaming: false,
              refused: true,
              sources,
              searchInfo,
              grounding,
            });

            store.setChatState(ChatState.IDLE);
            logger.info('chat:refused', {
              level: grounding.level,
              sources: sources.length,
              reason: grounding.reason,
            });

            await actions.persistCurrentConversation(question);
            return null;
          }
        }

        if (signal.aborted) {
          throw new AppError(ChatErrorCode.CANCELLED_BY_USER, 'aborted_before_generate');
        }

        /* 2. プロンプト構築 */
        const history = store.get().messages
          .filter((m) => m.id !== userMessage.id && m.id !== answerMessage.id && !m.error)
          .map((m) => ({ role: m.role, text: m.text }));

        const messages = buildMessages({
          question,
          sources,
          history,
          historyTurns: state.settings.historyTurns,
          mode: state.mode,
        });

        const promptChars = estimatePromptChars(messages);
        const model = resolveModel(state.modelId);

        /* コンテキスト長（トークン）の概算。日本語は1トークン≒1文字強で見る。 */
        if (model.contextLen && promptChars > model.contextLen * 2.5) {
          throw new AppError(ChatErrorCode.CONTEXT_TOO_LONG, String(promptChars));
        }

        /* 3. 生成（ストリーミング） */
        store.setChatState(ChatState.GENERATING);

        /* 描画をまとめる。最新の全文だけを持ち、一定間隔で反映する。 */
        let pendingText = null;
        let flushTimer = null;

        const flush = () => {
          flushTimer = null;

          if (pendingText === null) {
            return;
          }

          store.updateMessage(answerMessage.id, { text: stripReasoning(pendingText) });
          pendingText = null;
        };

        let text;

        try {
          text = await engine.chat({
            messages,
            signal,
            options: {
              temperature: state.settings.temperature,
              topP: state.settings.topP,
              maxTokens: state.settings.maxTokens,
            },
            onToken: (_delta, full) => {
              pendingText = full;

              if (flushTimer === null) {
                flushTimer = setTimeout(flush, STREAM_FLUSH_MS);
              }
            },
          });
        } finally {
          if (flushTimer !== null) {
            clearTimeout(flushTimer);
            flushTimer = null;
          }
        }

        const finalText = stripReasoning(text).trim();
        const stopped = signal.aborted;

        /*
         * モデルが渡していない資料番号を書くことがある。
         * 画面で注意を出せるよう、ここで突き合わせておく。
         */
        const citations = validateCitations(finalText, sources);

        store.updateMessage(answerMessage.id, {
          text: finalText === '' && stopped ? '（停止しました）' : finalText,
          streaming: false,
          stopped,
          citations,
        });

        store.setChatState(ChatState.IDLE);
        await actions.persistCurrentConversation(question);

        logger.info('chat:answered', {
          sources: sources.length,
          chars: finalText.length,
          stopped,
          mode: state.mode,
          grounding: grounding?.level ?? null,
          unknownCitations: citations.unknown.length,
        });

        return finalText;
      } catch (error) {
        const appError = toAppError(error, ChatErrorCode.GENERATION_FAILED);
        const cancelled = appError.code === ChatErrorCode.CANCELLED_BY_USER;

        store.updateMessage(answerMessage.id, {
          streaming: false,
          stopped: cancelled,
          error: cancelled ? null : { code: appError.code, message: appError.userMessage },
          text: store.get().messages.find((m) => m.id === answerMessage.id)?.text || (cancelled ? '（停止しました）' : ''),
        });

        if (!cancelled) {
          setError(appError, 'chat:generation-failed');
          store.setChatState(ChatState.ERROR);
        } else {
          store.setChatState(ChatState.IDLE);
        }

        return null;
      } finally {
        generationController = null;
      }
    },

    stop() {
      if (!canStop(store.get())) {
        return;
      }

      store.setChatState(ChatState.STOPPING);
      generationController?.abort();
      getEngine()?.interrupt?.().catch(() => { /* 停止要求の失敗は致命的でない。 */ });
    },

    /* 直前の質問をもう一度実行する。 */
    async regenerate() {
      const messages = store.get().messages;
      const lastUser = [...messages].reverse().find((m) => m.role === 'user');

      if (!lastUser) {
        return null;
      }

      /* 直前の回答を取り除いてから作り直す。 */
      const kept = [];
      let removed = false;

      for (let i = messages.length - 1; i >= 0; i -= 1) {
        if (!removed && messages[i].role === 'assistant') {
          removed = true;
          continue;
        }
        if (messages[i].id === lastUser.id) {
          continue;
        }
        kept.unshift(messages[i]);
      }

      store.patch({ messages: kept });
      return actions.submit(lastUser.text);
    },

    /* ---------- 会話 ---------- */

    newConversation() {
      store.clearMessages();
      store.patch({ notice: null, lastError: null });
      store.setChatState(ChatState.IDLE);
    },

    async persistCurrentConversation(firstQuestion) {
      const state = store.get();

      if (!state.settings.saveHistory) {
        return null;
      }

      const id = state.conversationId ?? newConversationId();

      try {
        await saveConversation({
          id,
          title: makeTitle(state.messages.find((m) => m.role === 'user')?.text ?? firstQuestion),
          messages: state.messages,
          modelId: state.modelId,
          createdAt: state.conversationCreatedAt ?? new Date().toISOString(),
        });

        store.patch({ conversationId: id, conversations: await listConversations() });
        return id;
      } catch (error) {
        logger.warn('chat:history-save-failed', { code: error?.code ?? 'unknown' });
        store.patch({ notice: '会話履歴を保存できませんでした。会話は続けられますが、再読み込みで消えます。' });
        return null;
      }
    },

    async openConversation(id) {
      const row = await getConversation(id);

      if (!row) {
        return;
      }

      store.patch({
        conversationId: row.id,
        messages: (row.messages ?? []).map((m, index) => ({
          id: nextMessageId(m.role === 'assistant' ? 'a' : 'u'),
          role: m.role,
          text: m.text,
          at: m.at,
          /* 参照はIDのみ保存しているため、表示用に復元する。 */
          sourceRefs: m.sourceRefs ?? [],
          sources: [],
          restored: true,
          order: index,
        })),
      });
    },

    async deleteConversation(id) {
      await deleteConversation(id);

      if (store.get().conversationId === id) {
        store.clearMessages();
      }

      store.patch({ conversations: await listConversations() });
    },

    async clearAllConversations() {
      await clearConversations();
      store.clearMessages();
      store.patch({ conversations: [], notice: '会話履歴をすべて削除しました。' });
    },
  };

  return actions;
}

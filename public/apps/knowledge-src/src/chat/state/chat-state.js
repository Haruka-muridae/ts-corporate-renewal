/*
 * チャット画面の状態機械（純粋ロジック）。
 *
 * 画面は状態を購読して描画するだけにする。
 * 「今どの段階か」をUI側で推測しない。
 */

import { logger } from '../../core/logger.js';

/* モデルの状態。ダウンロードと初期化を分けて持つ。 */
export const ModelState = Object.freeze({
  IDLE: 'idle',                 // 未読込（初回説明を出す）
  UNSUPPORTED: 'unsupported',   // 実行環境が要件を満たさない
  DOWNLOADING: 'downloading',   // モデルファイル取得中
  INITIALIZING: 'initializing', // GPUへの読み込み・コンパイル中
  READY: 'ready',               // 質問できる
  ERROR: 'error',               // 準備に失敗
});

export const MODEL_STATE_LABEL_JA = Object.freeze({
  [ModelState.IDLE]: 'モデル未読込',
  [ModelState.UNSUPPORTED]: '利用できません',
  [ModelState.DOWNLOADING]: 'ダウンロード中',
  [ModelState.INITIALIZING]: '初期化中',
  [ModelState.READY]: '利用可能',
  [ModelState.ERROR]: 'エラー',
});

/* 会話の状態。 */
export const ChatState = Object.freeze({
  IDLE: 'idle',           // 入力待ち
  RETRIEVING: 'retrieving', // ナレッジ検索中
  GENERATING: 'generating', // 生成中
  STOPPING: 'stopping',   // 停止要求済み
  ERROR: 'error',
});

export const CHAT_STATE_LABEL_JA = Object.freeze({
  [ChatState.IDLE]: '待機中',
  [ChatState.RETRIEVING]: '資料を検索中',
  [ChatState.GENERATING]: '生成中',
  [ChatState.STOPPING]: '停止中',
  [ChatState.ERROR]: 'エラー',
});

/*
 * モデル状態の遷移表。
 * ここに無い遷移は不正として記録する（画面は壊さない）。
 */
const MODEL_TRANSITIONS = Object.freeze({
  [ModelState.IDLE]: [ModelState.DOWNLOADING, ModelState.INITIALIZING, ModelState.UNSUPPORTED, ModelState.ERROR],
  [ModelState.UNSUPPORTED]: [ModelState.IDLE, ModelState.DOWNLOADING, ModelState.ERROR],
  [ModelState.DOWNLOADING]: [ModelState.INITIALIZING, ModelState.READY, ModelState.IDLE, ModelState.ERROR],
  [ModelState.INITIALIZING]: [ModelState.READY, ModelState.IDLE, ModelState.ERROR],
  [ModelState.READY]: [ModelState.IDLE, ModelState.DOWNLOADING, ModelState.INITIALIZING, ModelState.ERROR],
  [ModelState.ERROR]: [ModelState.IDLE, ModelState.DOWNLOADING, ModelState.INITIALIZING, ModelState.UNSUPPORTED],
});

export function canTransitionModel(from, to) {
  if (from === to) {
    return true;
  }
  return (MODEL_TRANSITIONS[from] ?? []).includes(to);
}

/* 質問を送れるか。理由も返す（画面へそのまま出す）。 */
export function canSubmit(state) {
  if (state.modelState !== ModelState.READY) {
    return { ok: false, reason: 'model-not-ready', message: 'AIモデルの準備が終わってから質問できます。' };
  }

  if (state.chatState === ChatState.GENERATING || state.chatState === ChatState.RETRIEVING) {
    return { ok: false, reason: 'busy', message: '前の回答を生成しています。完了するか停止してからお試しください。' };
  }

  if (state.chatState === ChatState.STOPPING) {
    return { ok: false, reason: 'stopping', message: '停止処理中です。' };
  }

  if (String(state.draft ?? '').trim() === '') {
    return { ok: false, reason: 'empty', message: '質問を入力してください。' };
  }

  if (!state.knowledge?.hasKnowledge && state.mode === 'knowledge') {
    return { ok: false, reason: 'no-knowledge', message: '同期済みのナレッジがありません。先にナレッジ管理画面でGoogle Driveを同期してください。' };
  }

  return { ok: true, reason: null, message: '' };
}

/* 生成を止められるか。 */
export function canStop(state) {
  return state.chatState === ChatState.GENERATING || state.chatState === ChatState.RETRIEVING;
}

export const DEFAULT_SETTINGS = Object.freeze({
  /* 生成 */
  temperature: 0.3,
  topP: 0.9,
  maxTokens: 800,
  /* 検索（RAG） */
  topK: 5,
  maxChunksPerFile: 2,
  maxContextChars: 6000,
  neighborChunks: 1,
  minScoreRatio: 0.2,
  /*
   * 回答を作る最低ライン（根拠レベル 0〜5）。
   * これを下回ると、モデルを呼ばずに「回答できませんでした」と答える。
   * 0 にすると、根拠が薄くても必ず生成する（推奨しない）。
   */
  minGroundingLevel: 2,
  /* 会話 */
  saveHistory: true,
  historyTurns: 4,
});

export function createChatStore(initial = {}) {
  let value = {
    booted: false,
    dbReady: false,

    environment: null,          // probeEnvironment() の結果
    knowledge: null,            // loadKnowledgeSummary() の結果

    modelId: null,
    modelState: ModelState.IDLE,
    modelProgress: null,        // { phase, ratio, loadedBytes, totalBytes, file, text }
    modelInfo: null,            // 初期化後のモデル情報（initMs を含む）
    modelCache: null,           // { cached, bytes, entries, cacheNames }
    availableModels: [],

    chatState: ChatState.IDLE,
    messages: [],               // { id, role, text, sources, at, error, stopped }
    draft: '',
    mode: 'knowledge',          // 'knowledge' | 'general'

    settings: { ...DEFAULT_SETTINGS },
    conversationId: null,
    conversations: [],

    diagnostics: null,          // runDiagnostics() の結果 { rows, summary }
    diagnosticsAt: null,
    diagnosticsRunning: false,

    lastError: null,            // { code, message }
    notice: null,               // 画面上部の一時メッセージ

    ...initial,
  };

  const listeners = new Set();

  const notify = () => {
    listeners.forEach((listener) => {
      try {
        listener(value);
      } catch {
        /* 1つの購読者の例外で他を止めない。 */
      }
    });
  };

  return {
    get() {
      return value;
    },

    subscribe(listener) {
      listeners.add(listener);
      listener(value);
      return () => listeners.delete(listener);
    },

    patch(partial) {
      value = { ...value, ...partial };
      notify();
    },

    setModelState(next) {
      const current = value.modelState;

      if (!canTransitionModel(current, next)) {
        logger.warn('chat:unexpected-model-transition', { from: current, to: next });
      }

      value = { ...value, modelState: next };
      notify();
    },

    setChatState(next) {
      value = { ...value, chatState: next };
      notify();
    },

    /* メッセージを1件追加する。 */
    addMessage(message) {
      value = { ...value, messages: [...value.messages, message] };
      notify();
      return message;
    },

    /*
     * 生成中の1件を更新する。
     * ストリーミングで頻繁に呼ばれるため、配列全体は作り直すが本文は差し替えるだけにする。
     */
    updateMessage(id, partial) {
      value = {
        ...value,
        messages: value.messages.map((m) => (m.id === id ? { ...m, ...partial } : m)),
      };
      notify();
    },

    clearMessages() {
      value = { ...value, messages: [], conversationId: null };
      notify();
    },
  };
}

/*
 * 設定値を安全な範囲へ丸める。
 * 画面から来る値も、保存済みの値も、必ずここを通す。
 */
export function normalizeSettings(input = {}) {
  const clamp = (v, min, max, fallback) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  };

  return {
    temperature: clamp(input.temperature, 0, 1.5, DEFAULT_SETTINGS.temperature),
    topP: clamp(input.topP, 0.05, 1, DEFAULT_SETTINGS.topP),
    maxTokens: Math.round(clamp(input.maxTokens, 64, 2048, DEFAULT_SETTINGS.maxTokens)),
    topK: Math.round(clamp(input.topK, 1, 20, DEFAULT_SETTINGS.topK)),
    maxChunksPerFile: Math.round(clamp(input.maxChunksPerFile, 1, 5, DEFAULT_SETTINGS.maxChunksPerFile)),
    maxContextChars: Math.round(clamp(input.maxContextChars, 1000, 12000, DEFAULT_SETTINGS.maxContextChars)),
    neighborChunks: Math.round(clamp(input.neighborChunks, 0, 2, DEFAULT_SETTINGS.neighborChunks)),
    minScoreRatio: clamp(input.minScoreRatio, 0, 1, DEFAULT_SETTINGS.minScoreRatio),
    minGroundingLevel: Math.round(clamp(input.minGroundingLevel, 0, 5, DEFAULT_SETTINGS.minGroundingLevel)),
    saveHistory: input.saveHistory !== false,
    historyTurns: Math.round(clamp(input.historyTurns, 0, 10, DEFAULT_SETTINGS.historyTurns)),
  };
}

/* 連番のメッセージID。暗号強度は不要だが衝突しないこと。 */
let messageSeq = 0;

export function nextMessageId(prefix = 'm') {
  messageSeq += 1;
  return `${prefix}-${messageSeq}`;
}

export function resetMessageSeq() {
  messageSeq = 0;
}

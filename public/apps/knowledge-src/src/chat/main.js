/*
 * AIナレッジチャットのエントリポイント。
 *
 * ------------------------------------------------------------------
 * 起動時に外部通信を一切行わない
 * ------------------------------------------------------------------
 * モデルの取得は、利用者が「モデルを準備する」を押したときに初めて始まる。
 * それまでに行うのは
 *   - 実行環境の診断（navigator.gpu の確認）
 *   - IndexedDB からナレッジ件数の読み出し
 * だけで、ネットワークへは出ない。
 * ------------------------------------------------------------------
 */

import '../styles.css';
import './chat.css';

import { openDb } from '../db/db.js';
import { logger } from '../core/logger.js';
import { toAppError, ErrorCode } from '../core/errors.js';

import { probeEnvironment } from './engine/environment.js';
import { loadKnowledgeSummary } from './knowledge-source.js';
import { createChatStore } from './state/chat-state.js';
import { mountChat } from './ui/chat-app.js';
import { createActions } from './actions.js';

const store = createChatStore();

async function bootstrap() {
  const ui = mountChat({ store, actions: null });

  /* actions は store と ui の両方を必要とするため、後から差し込む。 */
  const actions = createActions({ store, ui });
  ui.setActions(actions);

  /* 1. 実行環境（外部通信なし） */
  try {
    store.patch({ environment: await probeEnvironment() });
  } catch (error) {
    logger.error('chat:environment-probe-failed', toAppError(error));
  }

  /* 2. 既存ナレッジ（IndexedDB の読み出しのみ） */
  try {
    await openDb();
    store.patch({ dbReady: true, knowledge: await loadKnowledgeSummary() });
  } catch (error) {
    const appError = toAppError(error, ErrorCode.DB_OPEN_FAILED);
    store.patch({
      dbReady: false,
      lastError: { code: appError.code, message: appError.userMessage },
    });
    logger.error('chat:db-open-failed', appError, { code: appError.code });
  }

  /* 3. 保存済みの設定と会話（あれば） */
  await actions.restoreSettings();

  store.patch({ booted: true });

  /*
   * 4. 取得済みモデルの有無（Cache Storage を読むだけ。通信しない）。
   *    起動を待たせないよう、画面を出したあとで確認する。
   */
  actions.refreshModelCache().catch(() => { /* 表示が増えないだけなので握りつぶす。 */ });

  logger.info('chat:ready', {
    gpu: store.get().environment?.gpu ?? 'unknown',
    chunks: store.get().knowledge?.chunkCount ?? 0,
  });
}

/* 想定外の例外も日本語で拾う（画面が無反応になるのを防ぐ）。 */
window.addEventListener('unhandledrejection', (event) => {
  const appError = toAppError(event.reason);

  if (appError.code === ErrorCode.CANCELLED) {
    return;
  }

  logger.error('chat:unhandled-rejection', appError, { code: appError.code });
});

window.addEventListener('error', (event) => {
  logger.error('chat:uncaught-error', {
    message: String(event.message ?? '').slice(0, 300),
    source: String(event.filename ?? '').slice(0, 200),
  });
});

/* ページ離脱時に推論を止める（GPUを掴んだままにしない）。 */
window.addEventListener('pagehide', () => {
  import('./engine/llm-engine.js')
    .then((mod) => mod.disposeEngine())
    .catch(() => { /* 未読込なら何もしない。 */ });
});

bootstrap().catch((error) => {
  const appError = toAppError(error);
  logger.error('chat:bootstrap-failed', appError, { code: appError.code });
  store.patch({ booted: true, lastError: { code: appError.code, message: appError.userMessage } });
});

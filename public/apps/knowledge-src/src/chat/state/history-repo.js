/*
 * 会話履歴と設定の保存（IndexedDB のみ）。
 *
 * ------------------------------------------------------------------
 * 保存してよいもの / いけないもの
 * ------------------------------------------------------------------
 * 保存する: 質問文 / 回答文 / 参照したチャンクID / モデルID / 日時
 * 保存しない: ナレッジ本文の複製 / アクセストークン / OAuth情報 /
 *             Drive のファイル本体
 *
 * 参照元はチャンクIDだけを持ち、表示時に chunks テーブルから引き直す。
 * こうすると資料の実体が二重に増えず、ナレッジを削除すれば参照も消える。
 *
 * localStorage は使わない（本文を平文で置かないため）。
 * ------------------------------------------------------------------
 */

import { db, runWrite, SettingKey } from '../../db/db.js';
import { getSetting, setSetting } from '../../db/repo.js';
import { normalizeSettings, DEFAULT_SETTINGS } from './chat-state.js';
import { DEFAULT_MODEL_ID } from '../engine/model-catalog.js';
import { logger } from '../../core/logger.js';

/* 保存する会話数の上限。超えた分は古いものから消す。 */
export const MAX_CONVERSATIONS = 30;
/* 1会話あたりのメッセージ上限。 */
export const MAX_MESSAGES_PER_CONVERSATION = 100;
/* 1メッセージあたりの保存文字数上限。 */
export const MAX_TEXT_CHARS = 8000;

let conversationSeq = 0;

export function newConversationId() {
  conversationSeq += 1;
  return `c-${Date.now().toString(36)}-${conversationSeq}`;
}

/*
 * 保存用の形へ整える。
 * ここを必ず通すことで、本文の複製やトークンの混入を防ぐ。
 */
export function toStoredConversation({ id, title, messages, modelId, createdAt, updatedAt }) {
  const list = Array.isArray(messages) ? messages : [];
  const trimmed = list.slice(-MAX_MESSAGES_PER_CONVERSATION);

  return {
    id: String(id),
    title: String(title ?? '').slice(0, 120),
    modelId: String(modelId ?? ''),
    createdAt: createdAt ?? new Date().toISOString(),
    updatedAt: updatedAt ?? new Date().toISOString(),
    messages: trimmed.map((message) => ({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      text: String(message.text ?? '').slice(0, MAX_TEXT_CHARS),
      at: message.at ?? new Date().toISOString(),
      /* 資料は本文を持たず、IDだけを残す。 */
      sourceRefs: Array.isArray(message.sources)
        ? message.sources.map((s) => String(s.chunkId)).slice(0, 20)
        : [],
      stopped: message.stopped === true,
      errorCode: message.error?.code ? String(message.error.code) : null,
    })),
  };
}

export async function saveConversation(conversation) {
  const record = toStoredConversation(conversation);

  try {
    await runWrite('conversations:put', () => db.conversations.put(record));
    await trimConversations();
    return record;
  } catch (error) {
    logger.warn('chat:history-save-failed', { code: error?.code ?? 'unknown' });
    throw error;
  }
}

export async function listConversations(limit = MAX_CONVERSATIONS) {
  try {
    const rows = await db.conversations.orderBy('updatedAt').reverse().limit(limit).toArray();

    return rows.map((row) => ({
      id: row.id,
      title: row.title ?? '',
      modelId: row.modelId ?? '',
      updatedAt: row.updatedAt ?? '',
      messageCount: Array.isArray(row.messages) ? row.messages.length : 0,
    }));
  } catch (error) {
    logger.warn('chat:history-list-failed', { code: error?.name ?? 'unknown' });
    return [];
  }
}

export async function getConversation(id) {
  try {
    return (await db.conversations.get(id)) ?? null;
  } catch {
    return null;
  }
}

export async function deleteConversation(id) {
  return runWrite('conversations:delete', () => db.conversations.delete(id));
}

export async function clearConversations() {
  return runWrite('conversations:clear', () => db.conversations.clear());
}

/* 上限を超えた古い会話を消す。 */
export async function trimConversations(limit = MAX_CONVERSATIONS) {
  const count = await db.conversations.count();

  if (count <= limit) {
    return 0;
  }

  const old = await db.conversations.orderBy('updatedAt').limit(count - limit).primaryKeys();

  if (old.length === 0) {
    return 0;
  }

  await runWrite('conversations:trim', () => db.conversations.bulkDelete(old));
  logger.info('chat:history-trimmed', { removed: old.length });

  return old.length;
}

/* 会話の題名を最初の質問から作る。 */
export function makeTitle(firstQuestion) {
  const text = String(firstQuestion ?? '').replace(/\s+/g, ' ').trim();
  return text.length > 40 ? `${text.slice(0, 40)}…` : (text || '新しい会話');
}

/* ---------- 設定 ---------- */

export async function loadChatSettings() {
  const saved = await getSetting(SettingKey.CHAT_SETTINGS, null);

  return {
    modelId: typeof saved?.modelId === 'string' && saved.modelId !== '' ? saved.modelId : DEFAULT_MODEL_ID,
    settings: normalizeSettings({ ...DEFAULT_SETTINGS, ...(saved?.settings ?? {}) }),
    mode: saved?.mode === 'general' ? 'general' : 'knowledge',
  };
}

export async function saveChatSettings({ modelId, settings, mode }) {
  return setSetting(SettingKey.CHAT_SETTINGS, {
    modelId: String(modelId ?? DEFAULT_MODEL_ID),
    settings: normalizeSettings(settings),
    mode: mode === 'general' ? 'general' : 'knowledge',
  });
}

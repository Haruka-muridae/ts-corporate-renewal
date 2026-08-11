/*
 * 投稿文の検証（280ウェイト）・intent リンクの組み立て・端末内保存。
 *
 * 保存は端末内（localStorage）のみ。当社サーバーへは何も送らない
 * （Threads 版 ../threads-post/post.js と同じ原則。共有モジュール化は
 * しない方針 docs/repository-structure.md §4-1 に従い、複製している）。
 */

import { X_INTENT_BASE, WEIGHT_LIMIT, STORAGE_KEY, HISTORY_LIMIT } from './config.js';

/* ---------- 検証と intent リンク ---------- */

/*
 * 1コードポイントの重み。twitter-text の既定レンジに合わせる:
 * 次の範囲が 1、それ以外（日本語・絵文字を含む）は 2。
 *   U+0000–U+10FF / U+2000–U+200D / U+2010–U+201F / U+2032–U+2037
 */
function weightOf(codePoint) {
  if (
    (codePoint >= 0x0000 && codePoint <= 0x10ff)
    || (codePoint >= 0x2000 && codePoint <= 0x200d)
    || (codePoint >= 0x2010 && codePoint <= 0x201f)
    || (codePoint >= 0x2032 && codePoint <= 0x2037)
  ) {
    return 1;
  }

  return 2;
}

/* 本文の合計ウェイト。画面のカウント表示と検証の両方が使う。 */
export function countWeight(text) {
  let total = 0;

  for (const char of String(text ?? '')) {
    total += weightOf(char.codePointAt(0));
  }

  return total;
}

/* 本文の検証。戻り値はエラーメッセージ（問題なければ null）。 */
export function validatePostText(text) {
  const value = String(text ?? '');

  if (!value.trim()) {
    return '本文が空です';
  }

  if (countWeight(value) > WEIGHT_LIMIT) {
    return `本文が上限（${WEIGHT_LIMIT}ウェイト・日本語なら約${WEIGHT_LIMIT / 2}字）を超えています`;
  }

  return null;
}

/* 本文入りの投稿画面を開く URL。 */
export function buildIntentUrl(text) {
  return `${X_INTENT_BASE}?text=${encodeURIComponent(String(text ?? ''))}`;
}

/* ---------- 端末内保存（Threads 版と同じ実装） ---------- */

export function isStorageAvailable(storage = globalThis.localStorage) {
  try {
    const probe = `${STORAGE_KEY}-probe`;
    storage.setItem(probe, '1');
    storage.removeItem(probe);
    return true;
  } catch {
    return false;
  }
}

function readState(storage) {
  try {
    const raw = storage.getItem(STORAGE_KEY);

    if (!raw) {
      return { drafts: [], history: [] };
    }

    const parsed = JSON.parse(raw);

    return {
      drafts: Array.isArray(parsed?.drafts) ? parsed.drafts : [],
      history: Array.isArray(parsed?.history) ? parsed.history : [],
    };
  } catch {
    /* 壊れた保存データは読み捨てる（次の保存で作り直される）。 */
    return { drafts: [], history: [] };
  }
}

function writeState(storage, state) {
  storage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function makeId() {
  return globalThis.crypto?.randomUUID?.()
    ?? `id-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function saveDraft(text, { storage = globalThis.localStorage, now = Date.now() } = {}) {
  const value = String(text ?? '');

  if (!value.trim()) {
    throw new Error('本文が空です');
  }

  const state = readState(storage);
  const draft = { id: makeId(), text: value, createdAt: now };

  state.drafts.push(draft);
  writeState(storage, state);
  return draft;
}

export function listDrafts({ storage = globalThis.localStorage } = {}) {
  return readState(storage).drafts.slice().reverse();
}

export function deleteDraft(id, { storage = globalThis.localStorage } = {}) {
  const state = readState(storage);
  state.drafts = state.drafts.filter((draft) => draft.id !== id);
  writeState(storage, state);
}

export function recordHistory(kind, text, { storage = globalThis.localStorage, now = Date.now() } = {}) {
  const state = readState(storage);

  state.history.push({ id: makeId(), at: now, kind, text: String(text ?? '') });

  if (state.history.length > HISTORY_LIMIT) {
    state.history = state.history.slice(state.history.length - HISTORY_LIMIT);
  }

  writeState(storage, state);
}

export function listHistory({ storage = globalThis.localStorage } = {}) {
  return readState(storage).history.slice().reverse();
}

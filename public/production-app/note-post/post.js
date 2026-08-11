/*
 * 記事本文の検証・作成画面の URL・端末内保存（下書き・履歴）。
 *
 * ==================================================================
 * 保存は端末内（localStorage）のみ
 * ==================================================================
 * 当社サーバーへは何も送らない（名刺OCR・領収書スキャナと同じ原則）。
 * したがって下書き・履歴は「この端末の、このブラウザだけ」に残る。
 * 端末をまたいだ共有が要る、となった時点で Drive 保存を検討する
 * （docs/specs/threads-mvp-requirements-v1.md §9）。
 * ==================================================================
 */

import { NOTE_NEW_URL, TEXT_LIMIT, STORAGE_KEY, HISTORY_LIMIT } from './config.js';

/* ---------- 検証と作成画面の URL ---------- */

/* 文字数はコードポイントで数える（Threads 版と同じ基準）。 */
export function countText(text) {
  return Array.from(String(text ?? '')).length;
}

/*
 * 本文の検証。戻り値はエラーメッセージ（問題なければ null）。
 * 例外ではなくメッセージで返すのは、画面がそのまま表示に使うため。
 */
export function validatePostText(text) {
  const value = String(text ?? '');

  if (!value.trim()) {
    return '本文が空です';
  }

  if (countText(value) > TEXT_LIMIT) {
    return `本文が ${TEXT_LIMIT} 文字を超えています`;
  }

  return null;
}

/*
 * note の新規作成画面の URL。本文プリフィルの URL は存在しないため
 * （config.js の注記）、本文はコピーして貼り付ける。
 */
export function buildEditorUrl() {
  return NOTE_NEW_URL;
}

/* ---------- 端末内保存 ---------- */

/*
 * localStorage が使えない環境（プライベートモードの一部など）でも
 * アプリ自体は動かす。保存だけが効かない旨は画面側が案内する。
 */
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
      return { drafts: [], history: [], stylePrompt: '' };
    }

    const parsed = JSON.parse(raw);

    return {
      drafts: Array.isArray(parsed?.drafts) ? parsed.drafts : [],
      history: Array.isArray(parsed?.history) ? parsed.history : [],
      stylePrompt: typeof parsed?.stylePrompt === 'string' ? parsed.stylePrompt : '',
    };
  } catch {
    /* 壊れた保存データは読み捨てる（次の保存で作り直される）。 */
    return { drafts: [], history: [], stylePrompt: '' };
  }
}

function writeState(storage, state) {
  storage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function makeId() {
  return globalThis.crypto?.randomUUID?.()
    ?? `id-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/* 下書きを保存する。戻り値は保存した1件。 */
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
  /* 新しい順。 */
  return readState(storage).drafts.slice().reverse();
}

export function deleteDraft(id, { storage = globalThis.localStorage } = {}) {
  const state = readState(storage);
  state.drafts = state.drafts.filter((draft) => draft.id !== id);
  writeState(storage, state);
}

/*
 * 履歴へ1件記録する。note 側で本当に公開されたかは観測できないため、
 * 記録するのは「作成画面を開いた」という事実まで。
 */
export function recordHistory(kind, text, { storage = globalThis.localStorage, now = Date.now() } = {}) {
  const state = readState(storage);

  state.history.push({ id: makeId(), at: now, kind, text: String(text ?? '') });

  /* 増え続けないよう古い順に捨てる。 */
  if (state.history.length > HISTORY_LIMIT) {
    state.history = state.history.slice(state.history.length - HISTORY_LIMIT);
  }

  writeState(storage, state);
}

export function listHistory({ storage = globalThis.localStorage } = {}) {
  /* 新しい順。 */
  return readState(storage).history.slice().reverse();
}

/* ---------- 書き方の調整（利用者設定） ---------- */

/*
 * 調整プロンプトは端末内に保存し、消さない限り生成のたびに使われる。
 * 下書き・履歴と同じ保存場所（STORAGE_KEY）に持つため、
 * ブラウザのサイトデータを消さない限り残る。
 */
export function saveStylePrompt(text, { storage = globalThis.localStorage } = {}) {
  const state = readState(storage);
  state.stylePrompt = String(text ?? '');
  writeState(storage, state);
}

export function loadStylePrompt({ storage = globalThis.localStorage } = {}) {
  return readState(storage).stylePrompt ?? '';
}

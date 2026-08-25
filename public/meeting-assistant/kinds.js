/*
 * 対応種別の端末内マスタ。localStorage のみ。外部サービスは使わない。
 * 初期値は初回のみ使い、以降は保存済み一覧を正とする。
 */

export const KINDS_STORAGE_KEY = 'meeting-assistant-kinds';

export const DEFAULT_KINDS = Object.freeze([
  '商談',
  '面談',
  '打ち合わせ',
  '定例会議',
  '採用面談',
  'ヒアリング',
]);

function getStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function normalizeKind(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function uniqueNormalized(values) {
  const seen = new Set();
  const out = [];

  for (const value of values) {
    const name = normalizeKind(value);

    if (name === '' || seen.has(name)) {
      continue;
    }

    seen.add(name);
    out.push(name);
  }

  return out;
}

function saveKinds(list, storage) {
  if (!storage) {
    return false;
  }

  try {
    storage.setItem(KINDS_STORAGE_KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

export function loadKinds(storage = getStorage()) {
  if (!storage) {
    return [...DEFAULT_KINDS];
  }

  const raw = storage.getItem(KINDS_STORAGE_KEY);

  if (raw === null || raw === undefined || raw === '') {
    return [...DEFAULT_KINDS];
  }

  try {
    const parsed = JSON.parse(raw);

    if (!Array.isArray(parsed)) {
      return [...DEFAULT_KINDS];
    }

    return uniqueNormalized(parsed);
  } catch {
    return [...DEFAULT_KINDS];
  }
}

export function addKind(value, storage = getStorage()) {
  const name = normalizeKind(value);

  if (name === '') {
    return { ok: false, reason: 'empty', list: loadKinds(storage) };
  }

  const list = loadKinds(storage);

  if (list.some((item) => normalizeKind(item) === name)) {
    return { ok: false, reason: 'duplicate', list };
  }

  const next = [...list, name];
  saveKinds(next, storage);
  return { ok: true, reason: null, list: next };
}

export function removeKind(value, storage = getStorage()) {
  const name = normalizeKind(value);
  const next = loadKinds(storage).filter((item) => normalizeKind(item) !== name);
  saveKinds(next, storage);
  return next;
}

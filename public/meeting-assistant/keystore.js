/*
 * Gemini APIキーの端末内保管。portal の KeyStore には依存しない。
 * 値は localStorage のみ。サーバーへ送らない。画面へ平文再表示しない。
 */

export const KEYSTORE_STORAGE_KEY = 'meeting-assistant-keys';
export const PROVIDERS = Object.freeze({ gemini: 'gemini' });

function getStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function isKeyStoreAvailable() {
  return getStorage() !== null;
}

function readAll() {
  const storage = getStorage();

  if (!storage) {
    return {};
  }

  try {
    const raw = storage.getItem(KEYSTORE_STORAGE_KEY);

    if (typeof raw !== 'string' || raw === '') {
      return {};
    }

    const parsed = JSON.parse(raw);

    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }

    return parsed;
  } catch {
    return {};
  }
}

function writeAll(all) {
  const storage = getStorage();

  if (!storage) {
    return false;
  }

  try {
    if (Object.keys(all).length === 0) {
      storage.removeItem(KEYSTORE_STORAGE_KEY);
      return true;
    }

    storage.setItem(KEYSTORE_STORAGE_KEY, JSON.stringify(all));
    return true;
  } catch {
    return false;
  }
}

export const KeyStore = Object.freeze({
  get(provider) {
    const name = String(provider ?? '').trim();

    if (name === '') {
      return null;
    }

    const value = readAll()[name];
    return typeof value === 'string' && value !== '' ? value : null;
  },

  set(provider, value) {
    const name = String(provider ?? '').trim();
    const key = String(value ?? '').trim();

    if (name === '' || key === '') {
      return false;
    }

    const all = readAll();
    all[name] = key;
    return writeAll(all);
  },

  remove(provider) {
    const name = String(provider ?? '').trim();

    if (name === '') {
      return false;
    }

    const all = readAll();
    delete all[name];
    return writeAll(all);
  },

  has(provider) {
    return KeyStore.get(provider) !== null;
  },
});

/*
 * ブラウザ録音の「保存待ち」台帳。
 *
 * ------------------------------------------------------------------
 * 録音ファイルは OPFS、状態はこの台帳
 * ------------------------------------------------------------------
 * 録音停止後、Drive へ上げ終わるまで OPFS の確定ファイルを消さない。
 * どのファイルが誰の録音で、Drive へ上がったかどうかは localStorage の
 * この台帳に持つ（ネイティブ版の Checkpoint と同じ形。recording-checkpoint.js）。
 *
 * 台帳に載っていない OPFS のファイルは「異常終了の名残」として起動時に消される
 * （opfs-storage.js の cleanupStaleFiles に keep を渡す）。
 *
 * ここは DOM / Drive / OPFS を触らない。純粋な読み書きだけ。
 * 音声データやトークンは入れない。
 * ------------------------------------------------------------------
 */

import {
  DriveUploadState,
  RecordingState,
  createCheckpoint,
} from './recording-checkpoint.js';

export const PENDING_STORAGE_KEY = 'meeting-assistant-pending';
export const BROWSER_SOURCE = 'browser';
export const NATIVE_SOURCE = 'native';

/* 台帳に載せてよい最大件数。古いものから落とす（OPFS の肥大化を防ぐ保険）。 */
export const MAX_PENDING_ENTRIES = 20;

function getStorage(storage) {
  if (storage !== undefined) {
    return storage;
  }

  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function readAll(storage) {
  if (!storage) {
    return [];
  }

  try {
    const raw = storage.getItem(PENDING_STORAGE_KEY);

    if (typeof raw !== 'string' || raw === '') {
      return [];
    }

    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isEntry) : [];
  } catch {
    return [];
  }
}

function writeAll(storage, entries) {
  if (!storage) {
    return false;
  }

  try {
    if (entries.length === 0) {
      storage.removeItem(PENDING_STORAGE_KEY);
      return true;
    }

    storage.setItem(PENDING_STORAGE_KEY, JSON.stringify(entries));
    return true;
  } catch {
    return false;
  }
}

function isEntry(value) {
  return value !== null
    && typeof value === 'object'
    && typeof value.recordingId === 'string'
    && value.recordingId !== ''
    && typeof value.localPath === 'string'
    && value.localPath !== '';
}

/*
 * ブラウザ録音の確定結果から台帳の 1 行を作る。
 * localPath には OPFS 上のファイル名を入れる（ネイティブのパスと同じ扱い）。
 */
export function createBrowserEntry({
  recordingId,
  fileName,
  localPath,
  sizeBytes = 0,
  durationSeconds = 0,
  mimeType = 'audio/mpeg',
  method = 'offline',
  organization = '',
  personName = '',
  kind = '',
  startedAt,
} = {}) {
  const base = createCheckpoint({
    recordingId,
    startedAt,
    state: RecordingState.SAVED_LOCAL,
    localPath,
    fileName,
    organization,
    personName,
    kind,
    driveUploadState: DriveUploadState.PENDING,
    sizeBytes,
    durationSeconds,
  });

  return {
    ...base,
    source: BROWSER_SOURCE,
    mimeType: String(mimeType || 'audio/mpeg'),
    method: method === 'online' ? 'online' : 'offline',
  };
}

export function isBrowserEntry(entry) {
  return entry?.source === BROWSER_SOURCE;
}

export function createPendingStore(storage) {
  const store = getStorage(storage);

  return {
    available: store !== null,

    list() {
      return readAll(store);
    },

    get(recordingId) {
      return readAll(store).find((entry) => entry.recordingId === recordingId) ?? null;
    },

    /* 同じ recordingId があれば置き換える。新しいものを末尾に置く。 */
    put(entry) {
      if (!isEntry(entry)) {
        return false;
      }

      const others = readAll(store).filter((item) => item.recordingId !== entry.recordingId);
      const next = [...others, entry];

      while (next.length > MAX_PENDING_ENTRIES) {
        next.shift();
      }

      return writeAll(store, next);
    },

    remove(recordingId) {
      const entries = readAll(store);
      const next = entries.filter((item) => item.recordingId !== recordingId);

      if (next.length === entries.length) {
        return false;
      }

      return writeAll(store, next);
    },

    /* 起動時の OPFS 掃除で残すファイル名。 */
    keepFileNames() {
      return new Set(readAll(store).filter(isBrowserEntry).map((entry) => entry.localPath));
    },
  };
}

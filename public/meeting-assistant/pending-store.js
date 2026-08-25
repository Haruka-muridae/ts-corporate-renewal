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
 * 録音開始の時点で「録音中」の行を載せる（createBrowserEntry の state）。
 * 録音中にページが落ちても、次回起動時に行が残っていれば OPFS の途中ファイル
 * （10 秒ごとに flush 済み）は掃除されず、Drive へ保存できる。
 *
 * localStorage に書けない環境（プライベートウィンドウ・容量超過）でも、
 * このページを開いている間はメモリ上の一覧で「Driveへ保存」を押せるようにする。
 * 永続化は常に「できれば」であり、メモリ上の一覧が正。
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

/*
 * 件数の上限は設けない。
 * 上限で古い行を黙って落とすと、その録音は次回起動の掃除で消える。
 * 容量は録音開始前の空き容量確認（recorder/capabilities.js）が守る。
 */

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
  state = RecordingState.SAVED_LOCAL,
} = {}) {
  const finalized = state !== RecordingState.RECORDING;
  const base = createCheckpoint({
    recordingId,
    startedAt,
    state,
    localPath,
    fileName,
    organization,
    personName,
    kind,
    driveUploadState: finalized ? DriveUploadState.PENDING : DriveUploadState.NONE,
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

  /* メモリ上の一覧が正。localStorage は「できれば」の永続化。 */
  let entries = readAll(store);
  let persisted = true;

  function sync(next) {
    entries = next;
    persisted = writeAll(store, next);
    return persisted;
  }

  return {
    /* 直近の書き込みが永続化できたか。false なら「この端末では保持できない」と案内する。 */
    get persisted() {
      return store !== null && persisted;
    },

    available: store !== null,

    list() {
      return entries.slice();
    },

    get(recordingId) {
      return entries.find((entry) => entry.recordingId === recordingId) ?? null;
    },

    /*
     * 同じ recordingId があれば置き換える。新しいものを末尾に置く。
     * 戻り値は「永続化できたか」。false でもメモリ上には載っている。
     */
    put(entry) {
      if (!isEntry(entry)) {
        return false;
      }

      const others = entries.filter((item) => item.recordingId !== entry.recordingId);
      return sync([...others, entry]);
    },

    remove(recordingId) {
      const next = entries.filter((item) => item.recordingId !== recordingId);

      if (next.length === entries.length) {
        return false;
      }

      sync(next);
      return true;
    },

    /* 起動時の OPFS 掃除で残すファイル名（録音中の行も含む）。 */
    keepFileNames() {
      return new Set(entries.filter(isBrowserEntry).map((entry) => entry.localPath));
    },
  };
}

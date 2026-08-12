/*
 * 端末内ドラフトの保存（要件書 §4-14）。
 *
 * ==================================================================
 * IndexedDB を使う理由
 * ==================================================================
 * ドラフトには入力原文（長い文字起こし）を含む。localStorage は
 * 容量が小さく同期APIのため、大容量の原文はIndexedDBを優先するという
 * 要件書の指示に従う。
 *
 * ドラフトは常に1件（複数ドラフトの管理はMVPに含めない。要件書 §2-3）。
 * APIキー・認証セッションはここで扱わない（KeyStore / auth/session.js の
 * 管轄であり、本アプリの削除操作の対象にも含めない）。
 * ==================================================================
 *
 * idbFactory を注入できるのはテスト用（tests/helpers/fake-indexeddb.mjs で
 * globalThis.indexedDB を差し替える構成にも、明示的に渡す構成にも対応する）。
 */

import { DRAFT_DB_NAME, DRAFT_DB_VERSION, DRAFT_STORE_NAME, DRAFT_RECORD_KEY } from './config.js';

/* 保存容量不足時の文言。§9-2 の表現をそのまま使う。 */
export const DRAFT_SAVE_ERROR = '端末に下書きを保存できませんでした。不要なデータを削除してください。';

/*
 * 保存済みドラフトの中身が壊れていて復元できなかった場合の文言。
 * §9-1「○○ができませんでした。××をご確認ください。」の基本文型に従う。
 */
export const DRAFT_RESTORE_ERROR = '下書きを復元できませんでした。新しく入力してください。';

function getIndexedDb(idbFactory) {
  if (idbFactory) {
    return idbFactory;
  }

  try {
    return globalThis.indexedDB ?? null;
  } catch {
    return null;
  }
}

/* IndexedDBが使えない環境（要件書 §10-3）。falseなら保存機能を無効化して説明する。 */
export function isDraftStorageAvailable(idbFactory = undefined) {
  return getIndexedDb(idbFactory) !== null;
}

function openDb(idbFactory) {
  const idb = getIndexedDb(idbFactory);

  if (!idb) {
    return Promise.reject(new Error('indexeddb_unavailable'));
  }

  return new Promise((resolve, reject) => {
    const request = idb.open(DRAFT_DB_NAME, DRAFT_DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains(DRAFT_STORE_NAME)) {
        db.createObjectStore(DRAFT_STORE_NAME);
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/*
 * ドラフトの形。原文・会議情報・選択テンプレート・生成結果・編集内容を持つ。
 * meetingInfo はフォーム入力の生の値（テキスト）をそのまま持ち、
 * minutes.js の正規化・照合はここでは行わない（保存はUIの状態そのままでよい）。
 */
export function createEmptyDraftRecord() {
  return {
    transcript: '',
    meetingInfo: {
      title: '', date: '', startTime: '', endTime: '', participants: '', purpose: '', notes: '',
    },
    templateId: null,
    /* 生成結果（編集済みを含む）。minutes.js の正規化済みの形、または null。 */
    minutes: null,
    updatedAt: null,
  };
}

/*
 * ドラフトを保存する。
 * 容量超過・書き込み禁止で失敗した場合は Error を投げる
 * （呼び出し側は DRAFT_SAVE_ERROR を表示する）。
 */
export async function saveDraft(record, { idbFactory = undefined, now = new Date() } = {}) {
  let db;

  try {
    db = await openDb(idbFactory);
  } catch {
    throw new Error('draft_open_failed');
  }

  try {
    await new Promise((resolve, reject) => {
      const store = db.transaction(DRAFT_STORE_NAME, 'readwrite').objectStore(DRAFT_STORE_NAME);
      const payload = { ...createEmptyDraftRecord(), ...record, updatedAt: now.toISOString() };
      const request = store.put(payload, DRAFT_RECORD_KEY);

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  } catch {
    throw new Error('draft_save_failed');
  } finally {
    db.close();
  }
}

/* 保存済みドラフトを読む。無ければ null。 */
export async function loadDraft({ idbFactory = undefined } = {}) {
  let db;

  try {
    db = await openDb(idbFactory);
  } catch {
    return null;
  }

  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction(DRAFT_STORE_NAME, 'readonly')
        .objectStore(DRAFT_STORE_NAME)
        .get(DRAFT_RECORD_KEY);

      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => reject(request.error);
    });
  } catch {
    return null;
  } finally {
    db.close();
  }
}

/*
 * ドラフトを消す。「端末内の作業データを削除」から呼ぶ（要件書 §4-14）。
 * 本アプリのドラフトだけを消し、APIキー・認証セッションには触れない。
 */
export async function clearDraft({ idbFactory = undefined } = {}) {
  let db;

  try {
    db = await openDb(idbFactory);
  } catch {
    return;
  }

  try {
    await new Promise((resolve, reject) => {
      const request = db.transaction(DRAFT_STORE_NAME, 'readwrite')
        .objectStore(DRAFT_STORE_NAME)
        .delete(DRAFT_RECORD_KEY);

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  } catch {
    /* 消せなくても、次に保存すれば上書きされる。致命的ではない。 */
  } finally {
    db.close();
  }
}

/* ドラフトが「復元候補を出すに値する中身」を持つか（要件書 §3-3）。 */
export function hasMeaningfulContent(record) {
  if (!record || typeof record !== 'object') {
    return false;
  }

  const hasTranscript = typeof record.transcript === 'string' && record.transcript.trim() !== '';
  const hasMinutes = record.minutes !== null && record.minutes !== undefined;

  return hasTranscript || hasMinutes;
}

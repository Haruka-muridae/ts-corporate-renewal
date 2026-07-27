/*
 * IndexedDB スキーマ定義（Dexie.js）。
 *
 * ------------------------------------------------------------------
 * 保存方針（重要）
 * ------------------------------------------------------------------
 * Google Drive の容量を消費しないため、以下は **すべてブラウザ内のみ** に置く。
 *   抽出テキスト / チャンク / 検索インデックス / （将来の）Embedding
 * Drive へは一切書き戻さない。Drive API は読み取りのみを呼ぶ。
 * ------------------------------------------------------------------
 *
 * バージョンアップの手順:
 *   1. 下の VERSIONS に新しい version() ブロックを追加する（既存ブロックは編集しない）。
 *   2. インデックスの増減だけなら stores() の差分を書く。
 *   3. データ移行が必要なら .upgrade() を書く。
 *   4. DB_VERSION を上げる。
 * 既存ブロックを書き換えると、旧バージョンの利用者の移行が壊れる。
 */

import Dexie from 'dexie';
import { logger } from '../core/logger.js';
import { AppError, ErrorCode, toAppError } from '../core/errors.js';

export const DB_NAME = 'tsam-knowledge';
export const DB_VERSION = 2;

export const db = new Dexie(DB_NAME);

/*
 * v1: 初期スキーマ。
 *
 * settings    key            : 単一値の設定（選択フォルダ、チャンク設定など）
 * files       fileId         : Drive のファイル1件 = 1行（同期状態の正本）
 * documents   fileId         : 抽出済みプレーンテキスト（1ファイル1件）
 * chunks      chunkId        : 分割済みチャンク
 * searchIndex id             : MiniSearch のシリアライズ済みインデックス
 * syncLogs    ++id           : 開発者向けログの永続化
 */
db.version(1).stores({
  settings: 'key',
  files: 'fileId, name, mimeType, modifiedTime, syncState, folderId, isKnowledge, lastSyncedAt',
  documents: 'fileId, updatedAt, charCount',
  chunks: 'chunkId, fileId, chunkIndex, [fileId+chunkIndex], updatedTime',
  searchIndex: 'id, builtAt',
  syncLogs: '++id, at, level, fileId, code',
});

/*
 * v2: 検索対象にフォルダ名を含めるため folderName を追加し、
 *     ファイル一覧の絞り込み用に errorCode を索引化する。
 *
 * 既存行には folderName が無いので、upgrade() で空文字を補う。
 * インデックス対象フィールドが undefined の行は、そのインデックスに載らないため、
 * 明示的に埋めておく。
 */
db.version(2).stores({
  settings: 'key',
  files: 'fileId, name, mimeType, modifiedTime, syncState, folderId, folderName, isKnowledge, lastSyncedAt, errorCode',
  documents: 'fileId, updatedAt, charCount',
  chunks: 'chunkId, fileId, chunkIndex, [fileId+chunkIndex], updatedTime',
  searchIndex: 'id, builtAt',
  syncLogs: '++id, at, level, fileId, code',
}).upgrade(async (tx) => {
  await tx.table('files').toCollection().modify((file) => {
    if (typeof file.folderName !== 'string') {
      file.folderName = '';
    }
    if (typeof file.errorCode !== 'string') {
      file.errorCode = '';
    }
  });
});

/* settings テーブルのキー。文字列を直書きしない。 */
export const SettingKey = Object.freeze({
  SELECTED_FOLDER: 'selectedFolder',
  CHUNK_OPTIONS: 'chunkOptions',
  SYNC_OPTIONS: 'syncOptions',
  LAST_SYNC_AT: 'lastSyncAt',
  SCHEMA_VERSION: 'schemaVersion',
  UI_PREFERENCES: 'uiPreferences',
});

export const SEARCH_INDEX_ID = 'main';

let openPromise = null;

/*
 * DBを開く。多重呼び出しは同じ Promise を返す。
 * 失敗はアプリ共通のエラーコードへ変換する（プライベートモード等）。
 */
export function openDb() {
  if (openPromise) {
    return openPromise;
  }

  openPromise = db.open()
    .then(async (instance) => {
      await db.settings.put({ key: SettingKey.SCHEMA_VERSION, value: DB_VERSION, updatedAt: new Date().toISOString() });
      logger.info('db:opened', { version: db.verno });
      return instance;
    })
    .catch((error) => {
      openPromise = null;
      logger.error('db:open-failed', error);

      if (error?.name === 'QuotaExceededError') {
        throw new AppError(ErrorCode.DB_QUOTA_EXCEEDED, error.name, error);
      }

      throw new AppError(ErrorCode.DB_OPEN_FAILED, error?.name ?? 'open_failed', error);
    });

  return openPromise;
}

/*
 * 書き込みの共通ラッパー。
 * 容量不足を専用コードへ変換し、それ以外は DB_WRITE_FAILED に倒す。
 */
export async function runWrite(label, fn) {
  try {
    return await fn();
  } catch (error) {
    const normalized = error?.name === 'QuotaExceededError'
      || error?.inner?.name === 'QuotaExceededError'
      ? new AppError(ErrorCode.DB_QUOTA_EXCEEDED, label, error)
      : new AppError(ErrorCode.DB_WRITE_FAILED, label, error);

    logger.error('db:write-failed', normalized, { code: normalized.code });
    throw normalized;
  }
}

/*
 * logger の永続化先を接続する。
 * 循環参照を避けるため、logger 側は sink を知らない設計にしてある。
 */
logger.setPersistSink(async (entry) => {
  if (!db.isOpen()) {
    return;
  }

  await db.syncLogs.add({
    at: entry.at,
    level: entry.level,
    event: entry.event,
    detail: entry.detail === null ? null : JSON.stringify(entry.detail).slice(0, 2000),
    fileId: entry.fileId,
    code: entry.code,
  });
});

/* 例外を握りつぶさずコードだけ整えるためのユーティリティ。 */
export { toAppError };

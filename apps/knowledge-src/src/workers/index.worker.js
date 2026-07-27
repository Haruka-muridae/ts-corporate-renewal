/*
 * 検索インデックスワーカー（MiniSearch）。
 *
 * インデックスの構築・検索・シリアライズをメインスレッド外で行う。
 * チャンクはメインスレッドから分割して渡される（IndexedDB はここでは触らない）。
 *
 * 検索対象フィールド:
 *   fileName / heading / text / folderName
 *
 * トークナイザと検索設定は search/tokenizer.js に集約している
 * （インデックス作成時と読み込み時で設定が食い違うと検索できなくなるため）。
 */

import MiniSearch from 'minisearch';
import { serveWorker } from './worker-rpc.js';
import { MINISEARCH_OPTIONS } from '../search/tokenizer.js';

class WorkerError extends Error {
  constructor(code, detail) {
    super(code);
    this.code = code;
    this.detail = detail ?? null;
  }
}

let index = null;

function ensureIndex() {
  if (!index) {
    throw new WorkerError('SEARCH_FAILED', 'index_not_ready');
  }
  return index;
}

serveWorker({
  /* 新しいインデックスを作り始める。 */
  reset: async () => {
    index = new MiniSearch(MINISEARCH_OPTIONS);
    return { ok: true };
  },

  /* チャンクを追加する（バッチ単位で呼ばれる）。 */
  add: async (payload) => {
    const chunks = Array.isArray(payload?.chunks) ? payload.chunks : [];

    if (!index) {
      index = new MiniSearch(MINISEARCH_OPTIONS);
    }

    /* 同じIDを二重に入れると MiniSearch が例外を出すため、先に外す。 */
    chunks.forEach((chunk) => {
      if (index.has(chunk.chunkId)) {
        index.discard(chunk.chunkId);
      }
    });

    index.addAll(chunks);
    return { count: index.documentCount };
  },

  /* ファイル単位の削除。chunkId の一覧を受け取る。 */
  remove: async (payload) => {
    const ids = Array.isArray(payload?.chunkIds) ? payload.chunkIds : [];

    if (!index) {
      return { count: 0 };
    }

    ids.forEach((id) => {
      if (index.has(id)) {
        index.discard(id);
      }
    });

    return { count: index.documentCount };
  },

  /* 保存済みインデックスの復元。 */
  load: async (payload) => {
    const serialized = payload?.serialized;

    if (typeof serialized !== 'string' || serialized === '') {
      throw new WorkerError('INDEX_BUILD_FAILED', 'empty_serialized');
    }

    try {
      index = MiniSearch.loadJSON(serialized, MINISEARCH_OPTIONS);
    } catch (error) {
      throw new WorkerError('INDEX_BUILD_FAILED', error?.message?.slice(0, 200) ?? 'load_failed');
    }

    return { count: index.documentCount };
  },

  /* IndexedDB へ保存するためのシリアライズ。 */
  serialize: async () => {
    const current = ensureIndex();
    return { serialized: JSON.stringify(current), count: current.documentCount };
  },

  search: async (payload) => {
    const query = String(payload?.query ?? '').trim();

    if (query === '') {
      return { hits: [], terms: [], total: 0 };
    }

    const current = ensureIndex();
    const limit = Math.min(Math.max(Number(payload?.limit) || 30, 1), 200);

    let results;

    try {
      results = current.search(query, payload?.searchOptions ?? undefined);
    } catch (error) {
      throw new WorkerError('SEARCH_FAILED', error?.message?.slice(0, 200) ?? 'search_failed');
    }

    /*
     * ハイライト用の語。日本語は bigram へ分解されるため、
     * 元の入力を空白で割ったものも併せて返す。
     */
    const rawTerms = query.split(/\s+/).filter((term) => term !== '');

    return {
      total: results.length,
      terms: Array.from(new Set([...rawTerms, ...results.flatMap((r) => r.terms ?? [])])).slice(0, 40),
      hits: results.slice(0, limit).map((result) => ({
        chunkId: result.id,
        score: result.score,
        fileId: result.fileId,
        fileName: result.fileName,
        heading: result.heading,
        chunkIndex: result.chunkIndex,
        updatedTime: result.updatedTime,
        driveUrl: result.driveUrl,
        text: result.text,
      })),
    };
  },

  stats: async () => ({ count: index ? index.documentCount : 0, ready: index !== null }),
});

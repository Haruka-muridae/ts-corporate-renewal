/*
 * ストアポートのメモリ実装。
 *
 * ==================================================================
 * なぜ存在するか
 * ==================================================================
 * IndexedDB は Node に無い。`fake-indexeddb` のような外部パッケージは
 * 入れられない（外部SDK追加禁止・実装指示書 §1）。
 *
 * そこで **IndexedDB そのものを模す代わりに、ポートを2実装持つ**。
 *   - indexeddb.mjs … ブラウザ用。IndexedDB を触る唯一の場所
 *   - memory.mjs    … テスト用。Map で同じ振る舞いを返す
 *
 * projects.mjs 以下のロジックはポートに対して書くため、
 * **テストは実ブラウザ無しで全部通る。**
 *
 * 「IndexedDB の薄いラッパを作り、下にメモリ実装を差す」という当初案より、
 * ポートを細くしたほうが模造すべき面が小さくなる（トランザクション・
 * カーソル・リクエストの模造が要らなくなる）。
 * ==================================================================
 *
 * ポートの契約（indexeddb.mjs も同じ形を返す）:
 *   get(store, key)                  → レコード | null
 *   getAll(store)                    → レコードの配列
 *   getAllBy(store, index, value)    → 索引に一致するレコードの配列
 *   put(store, record)               → 書いたレコード
 *   putAll(store, records)           → 書いたレコードの配列
 *   remove(store, key)               → void
 *   removeAll(store, keys)           → void
 *   clearAll()                       → 全ストアを空にする
 *   close()                          → void
 */

import { STORES_V1 } from './schema.mjs';

/** 索引定義を名前で引けるようにしておく。 */
function indexMap() {
  const map = new Map();

  for (const store of STORES_V1) {
    const byName = new Map();

    for (const index of store.indexes) {
      byName.set(index.name, index.keyPath);
    }

    map.set(store.name, { keyPath: store.keyPath, indexes: byName });
  }

  return map;
}

/**
 * 索引のキーを取り出す。複合索引はキーパスが配列。
 *
 * IndexedDB は複合キーを配列として比較するため、ここでは
 * JSON 文字列にして等値比較する（順序と型を保ったまま比べられる）。
 */
function indexKeyOf(record, keyPath) {
  const value = Array.isArray(keyPath)
    ? keyPath.map((path) => record[path])
    : record[keyPath];

  return JSON.stringify(value);
}

/**
 * メモリ実装を作る。
 *
 * @returns {import('./port.d.mts').Store}
 */
export function createMemoryStore() {
  const defs = indexMap();
  /** @type {Map<string, Map<unknown, object>>} */
  const data = new Map();

  for (const store of STORES_V1) {
    data.set(store.name, new Map());
  }

  function tableOf(storeName) {
    const table = data.get(storeName);

    if (table === undefined) {
      throw new Error(`未定義のストアです: ${storeName}`);
    }

    return table;
  }

  /*
   * 返す値は必ず複製する。
   *
   * IndexedDB は構造化複製で値を返すため、呼び出し側が受け取った
   * オブジェクトを書き換えても保存内容は変わらない。メモリ実装が
   * 参照を返すと、そこだけ振る舞いが違ってテストが本番を保証しなくなる。
   */
  function clone(record) {
    return record === undefined ? null : structuredClone(record);
  }

  return {
    async get(storeName, key) {
      return clone(tableOf(storeName).get(key));
    },

    async getAll(storeName) {
      return [...tableOf(storeName).values()].map((record) => structuredClone(record));
    },

    async getAllBy(storeName, indexName, value) {
      const def = defs.get(storeName);
      const keyPath = def?.indexes.get(indexName);

      if (keyPath === undefined) {
        throw new Error(`未定義の索引です: ${storeName}.${indexName}`);
      }

      const wanted = JSON.stringify(value);

      return [...tableOf(storeName).values()]
        .filter((record) => indexKeyOf(record, keyPath) === wanted)
        .map((record) => structuredClone(record));
    },

    async put(storeName, record) {
      const def = defs.get(storeName);
      const key = record[def.keyPath];

      if (key === undefined || key === null) {
        throw new Error(`主キー ${def.keyPath} がありません: ${storeName}`);
      }

      tableOf(storeName).set(key, structuredClone(record));

      return structuredClone(record);
    },

    async putAll(storeName, records) {
      const written = [];

      for (const record of records) {
        written.push(await this.put(storeName, record));
      }

      return written;
    },

    async remove(storeName, key) {
      tableOf(storeName).delete(key);
    },

    async removeAll(storeName, keys) {
      for (const key of keys) {
        tableOf(storeName).delete(key);
      }
    },

    async clearAll() {
      for (const table of data.values()) {
        table.clear();
      }
    },

    close() {
      /* メモリ実装に閉じるものは無い。ポートの形を揃えるためだけに置く。 */
    },
  };
}

/*
 * ストアポートの IndexedDB 実装。
 *
 * ==================================================================
 * このファイルだけが IndexedDB を触る
 * ==================================================================
 * projects.mjs 以下はポート（memory.mjs 冒頭の契約）に対して書く。
 * IndexedDB 固有の作法（onupgradeneeded・IDBRequest・トランザクションの
 * 自動コミット）をここに閉じ込めることで、上のロジックが Node で
 * そのままテストできる。
 *
 * **ブラウザ専用。** サーバーコンポーネントから import しない
 * （実装指示書 §2-2 のとおり、一想の画面はすべてクライアント）。
 * ==================================================================
 */

import { DB_NAME, DB_VERSION, MIGRATIONS } from './schema.mjs';

/** IDBRequest を Promise にする。IndexedDB は Promise を返さない。 */
function toPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB の操作に失敗しました'));
  });
}

/**
 * DB を開く。必要なら作成・移行する。
 *
 * @param {{ factory?: IDBFactory }} [options]
 */
export function openDatabase(options = {}) {
  const factory = options.factory ?? globalThis.indexedDB;

  if (factory === undefined || factory === null) {
    /*
     * プライベートモードや古い環境で起こりうる。
     * ここで落として、呼び出し側が「保存できない」旨を案内できるようにする。
     * 黙ってメモリ実装へ落とすと、利用者は保存されたつもりで全部失う。
     */
    return Promise.reject(new Error('このブラウザでは IndexedDB を利用できません。'));
  }

  return new Promise((resolve, reject) => {
    const request = factory.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = request.result;
      const from = event.oldVersion;

      /*
       * oldVersion 以降の手順だけを順に流す。
       * **既存データを消す手順は書かない。** 利用者のブラウザにしか
       * 無いデータなので、消したら復旧手段が無い。
       */
      for (const step of MIGRATIONS) {
        if (step.from < from) {
          continue;
        }

        for (const store of step.createStores ?? []) {
          if (db.objectStoreNames.contains(store.name)) {
            continue;
          }

          const created = db.createObjectStore(store.name, { keyPath: store.keyPath });

          for (const index of store.indexes) {
            created.createIndex(index.name, index.keyPath, index.options ?? {});
          }
        }
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('DB を開けませんでした'));
    request.onblocked = () => reject(
      new Error('他のタブが古い版の一想を開いています。すべて閉じてから再読み込みしてください。'),
    );
  });
}

/**
 * IndexedDB 実装のポートを作る。
 *
 * @param {IDBDatabase} db `openDatabase()` の戻り
 * @returns {import('./port.d.mts').Store}
 */
export function createIndexedDbStore(db) {
  function storeIn(storeName, mode) {
    return db.transaction(storeName, mode).objectStore(storeName);
  }

  return {
    async get(storeName, key) {
      const result = await toPromise(storeIn(storeName, 'readonly').get(key));
      return result ?? null;
    },

    async getAll(storeName) {
      return toPromise(storeIn(storeName, 'readonly').getAll());
    },

    async getAllBy(storeName, indexName, value) {
      const index = storeIn(storeName, 'readonly').index(indexName);
      return toPromise(index.getAll(value));
    },

    async put(storeName, record) {
      await toPromise(storeIn(storeName, 'readwrite').put(record));
      return record;
    },

    async putAll(storeName, records) {
      /*
       * 1トランザクションでまとめて書く。
       *
       * **await を挟んで put を出すと、IndexedDB のトランザクションは
       * 自動コミットされて次の put が InvalidStateError になる。**
       * そのため、まず全部の put を同期的に発行してから、
       * トランザクションの完了だけを待つ。
       */
      if (records.length === 0) {
        return [];
      }

      const tx = db.transaction(storeName, 'readwrite');
      const objectStore = tx.objectStore(storeName);

      for (const record of records) {
        objectStore.put(record);
      }

      await new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error('まとめ書きに失敗しました'));
        tx.onabort = () => reject(tx.error ?? new Error('まとめ書きが中断されました'));
      });

      return records;
    },

    async remove(storeName, key) {
      await toPromise(storeIn(storeName, 'readwrite').delete(key));
    },

    async removeAll(storeName, keys) {
      if (keys.length === 0) {
        return;
      }

      /* putAll と同じ理由で、同期的に発行してから完了を待つ。 */
      const tx = db.transaction(storeName, 'readwrite');
      const objectStore = tx.objectStore(storeName);

      for (const key of keys) {
        objectStore.delete(key);
      }

      await new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error('まとめ削除に失敗しました'));
        tx.onabort = () => reject(tx.error ?? new Error('まとめ削除が中断されました'));
      });
    },

    async clearAll() {
      const names = [...db.objectStoreNames];

      if (names.length === 0) {
        return;
      }

      const tx = db.transaction(names, 'readwrite');

      for (const name of names) {
        tx.objectStore(name).clear();
      }

      await new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error('全消去に失敗しました'));
        tx.onabort = () => reject(tx.error ?? new Error('全消去が中断されました'));
      });
    },

    close() {
      db.close();
    },
  };
}

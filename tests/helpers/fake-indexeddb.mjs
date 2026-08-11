/*
 * IndexedDB の最小の偽物。
 *
 * ==================================================================
 * なぜ自作するのか
 * ==================================================================
 * 実機で「手動入力した接続情報が永続化されず、リロードすると古い値へ戻る」
 * という壊れ方をした（2026-08-11）。画面に見えている値と、実際に使われた
 * 値が食い違い、その後の切り分けを何時間も誤らせた。
 *
 * **これは「保存したものが読み戻せる」ことを実際に通さないと固定できない。**
 * ソースの文字列監視では「writeConnection を呼んでいる」ことしか見えず、
 * 呼ばれない経路があることを捕まえられない。
 *
 * 外部ライブラリ（fake-indexeddb）を足す案もあったが、
 * notifier-config.js が使うのは open / transaction / objectStore /
 * get / put / delete だけである。その範囲なら自作のほうが、
 * 依存を増やさずに済み、挙動も読める（AGENTS.md の外部依存の扱い）。
 * ==================================================================
 *
 * 再現していないもの（このテストに要らないため）:
 *   - 索引・カーソル・キー範囲
 *   - トランザクションの分離とロールバック
 *   - 非同期の順序（本物はイベントループをまたぐ。ここは即時に解決する）
 */

class FakeRequest {
  constructor() {
    this.result = undefined;
    this.error = null;
    this.onsuccess = null;
    this.onerror = null;
    this.onupgradeneeded = null;
  }

  /* 本物と同じく「ハンドラを付けたあとに発火する」順にする。 */
  settle(result) {
    this.result = result;
    queueMicrotask(() => this.onsuccess?.({ target: this }));
  }

  fail(error) {
    this.error = error;
    queueMicrotask(() => this.onerror?.({ target: this }));
  }
}

class FakeObjectStore {
  constructor(store, transaction) {
    this.store = store;
    this.transaction = transaction;
  }

  get(key) {
    const request = new FakeRequest();

    request.settle(this.store.has(key) ? this.store.get(key) : undefined);
    this.transaction.track(request);

    return request;
  }

  put(value, key) {
    const request = new FakeRequest();

    /*
     * **構造化複製を模す。** 参照をそのまま持つと、呼び出し側が
     * あとからオブジェクトを書き換えたときに保存済みの値まで変わり、
     * 「保存されている」ように見えてしまう。
     */
    this.store.set(key, structuredClone(value));
    request.settle(key);
    this.transaction.track(request);

    return request;
  }

  delete(key) {
    const request = new FakeRequest();

    this.store.delete(key);
    request.settle(undefined);
    this.transaction.track(request);

    return request;
  }
}

class FakeTransaction {
  constructor(db, storeName) {
    this.db = db;
    this.storeName = storeName;
    this.pending = 0;
    this.oncomplete = null;
    this.onerror = null;
    this.error = null;
    this.completed = false;
  }

  objectStore(name) {
    if (name !== this.storeName) {
      throw new Error(`NotFoundError: ${name}`);
    }

    return new FakeObjectStore(this.db.stores.get(name), this);
  }

  track() {
    this.pending += 1;

    queueMicrotask(() => {
      this.pending -= 1;

      if (this.pending === 0 && !this.completed) {
        this.completed = true;
        queueMicrotask(() => this.oncomplete?.());
      }
    });
  }
}

class FakeDatabase {
  constructor(name) {
    this.name = name;
    this.stores = new Map();
    this.objectStoreNames = {
      contains: (storeName) => this.stores.has(storeName),
    };
    this.closed = false;
  }

  createObjectStore(storeName) {
    this.stores.set(storeName, new Map());
    return storeName;
  }

  transaction(storeName) {
    if (this.closed) {
      throw new Error('InvalidStateError: database is closed');
    }

    return new FakeTransaction(this, storeName);
  }

  close() {
    /*
     * **閉じても中身は消えない。** ここが本物と同じであることが肝心で、
     * 「保存 → close → 開き直して読む」（＝リロード）を再現できる。
     */
    this.closed = true;
  }
}

/**
 * `globalThis.indexedDB` を偽物にする。
 *
 * 戻り値の `reset()` で中身を消す（別の利用者として開き直す想定）。
 * データはこのモジュールの外へ出さない（テストは公開API経由で確かめる）。
 */
export function installFakeIndexedDb() {
  const databases = new Map();

  globalThis.indexedDB = {
    open(name) {
      const request = new FakeRequest();
      const existing = databases.get(name);
      const db = existing ?? new FakeDatabase(name);

      if (!existing) {
        databases.set(name, db);
      }

      /* 開き直すたびに新しいハンドルを渡す（close 済みのものを使い回さない）。 */
      const handle = Object.create(db);

      handle.closed = false;
      handle.close = () => { handle.closed = true; };

      queueMicrotask(() => {
        if (!existing) {
          request.result = handle;
          request.onupgradeneeded?.({ target: request });
        }

        request.settle(handle);
      });

      return request;
    },
  };

  return {
    reset() {
      databases.clear();
    },
  };
}

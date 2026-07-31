/*
 * 外部AIサービスのAPIキーの保管庫。
 *
 * ==================================================================
 * サーバーへ送らない
 * ==================================================================
 * ここで扱うキーは **利用者本人が発行し、本人が課金される資格情報** である。
 * 当社のサーバー（GAS）へ送らないし、預からない。
 * 保管場所はその端末の localStorage だけとする。
 *
 * したがって、このファイルの外に localStorage を直接触る箇所を作らないこと。
 * 触る場所が増えるほど「どこかで GAS へ送っていないか」を
 * 確かめる手間が増える。入口をここ1つに閉じておけば、
 * 「KeyStore の外にキーは出ない」を読むだけで確かめられる。
 *
 * キーを console へ出す・ログへ残す・URLへ載せるコードも書かないこと。
 * ==================================================================
 *
 * ------------------------------------------------------------------
 * 保存の形
 * ------------------------------------------------------------------
 * localStorage に JSON を1件だけ置く。
 * プロバイダー名をキーにしたオブジェクトにする。
 *
 *   tsam-api-keys: {"gemini":"AIza..."}
 *
 * プロバイダーごとに localStorage のキーを分けない。
 * 2社目が増えたときに保存キーが増えていくと、消し忘れが起きる。
 * 1件の JSON なら、消すときも移すときも対象が1つで済む。
 * ------------------------------------------------------------------
 *
 * ------------------------------------------------------------------
 * ログアウトでは消さない
 * ------------------------------------------------------------------
 * auth/session.js の signOut() / clearSessionToken() は、この保存キーを
 * 掃除の対象にしない。**意図的にそうしている。**
 *
 * セッショントークンは当社が発行した認証情報なので、ログアウトで捨てる。
 * APIキーは端末の持ち主の資産であり、当社が預かっているものではない。
 * ログアウトのたびに消すと、再ログインのたびに取得し直しになる。
 *
 * 消すのは利用者が明示的に削除したときだけとする（/portal/ の削除ボタン）。
 * 詳細は docs/specs/keystore-spec-v1.md。
 * ------------------------------------------------------------------
 */

/* 保存キー。値を変えると既存端末のキーが読めなくなるため、変えない。 */
export const KEYSTORE_STORAGE_KEY = 'tsam-api-keys';

/* いま扱うプロバイダー。増やすときは docs/specs/keystore-spec-v1.md §6 を読むこと。 */
export const PROVIDERS = Object.freeze({
  gemini: 'gemini',
});

/* 保存先が使えない環境（プライベートモード等）でも画面は壊さない。 */
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

/*
 * 保存済みの全体を読む。
 *
 * 壊れた JSON・配列・文字列が入っていても空として扱い、例外を投げない。
 * 手で書き換えられた値のせいで画面が開かなくなるほうが困る。
 */
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
    /* 中身が空になったら、キーごと消す。空の JSON を残さない。 */
    if (Object.keys(all).length === 0) {
      storage.removeItem(KEYSTORE_STORAGE_KEY);
      return true;
    }

    storage.setItem(KEYSTORE_STORAGE_KEY, JSON.stringify(all));
    return true;
  } catch {
    /* 容量超過・書き込み禁止。保存できなかったことを呼び出し側へ返す。 */
    return false;
  }
}

function normalizeProvider(provider) {
  const name = String(provider ?? '').trim();

  return name !== '' ? name : null;
}

/*
 * 公開API。
 *
 * 画面も将来のアプリも、キーにはこの4つだけで触る。
 * localStorage を直接読み書きしない。
 */
export const KeyStore = Object.freeze({
  /* 保存済みのキーを返す。無ければ null。 */
  get(provider) {
    const name = normalizeProvider(provider);

    if (name === null) {
      return null;
    }

    const value = readAll()[name];

    return typeof value === 'string' && value !== '' ? value : null;
  },

  /*
   * 保存する。保存できたかどうかを返す。
   *
   * 空文字は受け付けない。消したいときは remove() を使う。
   * 「空文字で上書き＝削除」を許すと、入力欄の初期化ミスで
   * 気づかないうちにキーが消える。
   */
  set(provider, value) {
    const name = normalizeProvider(provider);
    const key = String(value ?? '').trim();

    if (name === null || key === '') {
      return false;
    }

    const all = readAll();
    all[name] = key;

    return writeAll(all);
  },

  /* 削除する。元から無くても true を返す（結果として無い状態になるため）。 */
  remove(provider) {
    const name = normalizeProvider(provider);

    if (name === null) {
      return false;
    }

    const all = readAll();

    if (!Object.hasOwn(all, name)) {
      return true;
    }

    delete all[name];

    return writeAll(all);
  },

  /* 保存済みかどうか。値そのものを取り出さずに判定したいときに使う。 */
  has(provider) {
    return KeyStore.get(provider) !== null;
  },
});

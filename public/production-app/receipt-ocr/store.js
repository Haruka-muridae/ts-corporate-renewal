/*
 * 保存先IDの記憶（仕様書 §9.2-1 / §9.2-5）。
 *
 * ==================================================================
 * localStorage を直接触ってよいのは、このファイルだけ
 * ==================================================================
 * 規約上、localStorage の直接操作は「保存先IDの記憶」に限る。
 * Gemini APIキーは Portal の KeyStore が持ち、こちらでは扱わない（§13）。
 * OAuth のアクセストークンはメモリだけに置く（§4-2）。
 *
 * **このファイルへキーやトークンを入れないこと。**
 * 入れてよいのは Drive のファイルID（秘密情報ではない）だけである。
 * ==================================================================
 *
 * ------------------------------------------------------------------
 * ここは正本ではなくキャッシュ
 * ------------------------------------------------------------------
 * 正本は利用者のドライブ上の実体であり、ここにあるのは
 * 「前回そこにあった」という手がかりに過ぎない。
 *
 * したがって、消えていても壊れていても動かなければならない。
 * §9.2-3 の名前検索が復旧経路であり、§15.2 の最終項
 * 「localStorage 消去後、drive.file 検索で既存の保存先を再発見できる」を
 * 成立させるために、ここが空でも作成へ直行しないこと。
 * ------------------------------------------------------------------
 */

const STORAGE_KEY = 'tsam-receipt-ocr-locations';

/* プライベートモード等では参照そのものが例外を投げる。 */
function getStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function isStoreAvailable() {
  return getStorage() !== null;
}

function isFileId(value) {
  /* Drive のファイルIDに使われる文字だけを通す。長さは将来変わりうるので緩く見る。 */
  return typeof value === 'string' && /^[A-Za-z0-9_-]{10,200}$/.test(value);
}

/*
 * 記憶している保存先ID。
 * 壊れた値・手で書き換えられた値が入っていても例外を投げず、null として返す。
 */
export function readLocations() {
  const storage = getStorage();
  const empty = { rootFolderId: null, appFolderId: null, originalsFolderId: null, spreadsheetId: null };

  if (!storage) {
    return empty;
  }

  try {
    const raw = storage.getItem(STORAGE_KEY);

    if (typeof raw !== 'string' || raw === '') {
      return empty;
    }

    const parsed = JSON.parse(raw);

    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return empty;
    }

    const result = { ...empty };

    for (const name of Object.keys(empty)) {
      if (isFileId(parsed[name])) {
        result[name] = parsed[name];
      }
    }

    return result;
  } catch {
    return empty;
  }
}

/*
 * 保存先IDを覚える。書けたかどうかを返す。
 * 書けなくても処理は続けてよい（次回また名前検索で見つかる）。
 */
export function writeLocations(locations) {
  const storage = getStorage();

  if (!storage) {
    return false;
  }

  const current = readLocations();
  const next = { ...current };

  for (const name of Object.keys(current)) {
    const value = locations?.[name];

    if (isFileId(value)) {
      next[name] = value;
    }
  }

  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(next));
    return true;
  } catch {
    return false;
  }
}

/* 記憶を捨てる。ID が無効だと分かったときに呼ぶ（§9.2-3 へ進む）。 */
export function clearLocations() {
  const storage = getStorage();

  if (!storage) {
    return false;
  }

  try {
    storage.removeItem(STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

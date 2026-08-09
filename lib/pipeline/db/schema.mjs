/*
 * 一想（ISSO）のローカルDBスキーマ。
 *
 * ==================================================================
 * 方針
 * ==================================================================
 *   - 実データは**利用者のブラウザにしか無い**（実装指示書 v0.6 §2）。
 *     したがってマイグレーションの失敗は、そのまま利用者のデータ消失になる。
 *     壊れたら作り直す、という復旧はできない。
 *   - ストア定義とマイグレーションを**この1ファイルに集約**する。
 *     IndexedDB 実装（indexeddb.mjs）とメモリ実装（memory.mjs）の
 *     両方がここを読むため、定義が2か所に分かれない。
 *   - **バージョンを上げるときは STORES を書き換えず、MIGRATIONS に足す。**
 *     既存の利用者の端末では、古いバージョンから順に適用される。
 * ==================================================================
 */

/** DB名。変えると既存端末のデータが読めなくなるため、変えない。 */
export const DB_NAME = 'isso';

/** 現在のスキーマ版。ストアを足したら上げ、MIGRATIONS に手順を書く。 */
export const DB_VERSION = 1;

/** ストア名。文字列を直接書かず、必ずここを参照する。 */
export const STORE = Object.freeze({
  PROJECTS: 'projects',
  VERSIONS: 'versions',
  SCENES: 'scenes',
  SETTINGS: 'settings',
  META: 'meta',
});

/**
 * v1 で作るストアと索引。
 *
 * `keyPath` は主キー。`indexes` は [索引名, キーパス, オプション] の並び。
 * 複合索引はキーパスを配列で書く（IndexedDB の仕様）。
 */
export const STORES_V1 = Object.freeze([
  {
    name: STORE.PROJECTS,
    keyPath: 'id',
    indexes: [
      /* ホームの「新しい順」一覧に使う。 */
      { name: 'byUpdatedAt', keyPath: 'updatedAt' },
    ],
  },
  {
    name: STORE.VERSIONS,
    keyPath: 'id',
    indexes: [
      { name: 'byProject', keyPath: 'projectId' },
      /*
       * 段階ごとの版を引く主経路。採用版の取得もここを通る。
       * 複合にしておかないと、projectId で引いてから stage で絞ることになり、
       * テーマが増えるほど無駄が増える。
       */
      { name: 'byProjectStage', keyPath: ['projectId', 'stage'] },
      { name: 'byParent', keyPath: 'parentVersionId' },
    ],
  },
  {
    name: STORE.SCENES,
    keyPath: 'id',
    indexes: [
      { name: 'byVersion', keyPath: 'versionId' },
      /* 並び順つきで引く。台本の表示は必ず order 順。 */
      { name: 'byVersionOrder', keyPath: ['versionId', 'order'] },
    ],
  },
  { name: STORE.SETTINGS, keyPath: 'key', indexes: [] },
  { name: STORE.META, keyPath: 'key', indexes: [] },
]);

/**
 * バージョンごとの適用手順。
 *
 * `from` は「このバージョンから上げるとき」を指す。0 は新規作成。
 * IndexedDB の onupgradeneeded は oldVersion を渡してくるので、
 * from >= oldVersion のものを順に流す。
 *
 * **既に適用済みのステップを書き換えない。** 書き換えると、
 * まだ上げていない端末だけが違う結果になる。
 */
export const MIGRATIONS = Object.freeze([
  { from: 0, to: 1, createStores: STORES_V1 },
]);

/** 生成物のID接頭辞。どのストアの値かを見ただけで分かるようにする。 */
export const ID_PREFIX = Object.freeze({
  [STORE.PROJECTS]: 'prj',
  [STORE.VERSIONS]: 'ver',
  [STORE.SCENES]: 'scn',
});

/** 段階。要件7.2〜7.5 に対応する。順序に意味がある（前段→次段）。 */
export const STAGES = Object.freeze(['threads', 'x', 'note', 'script', 'metadata']);

/**
 * 段階の並びで「1つ前」を返す。null は最初の段階。
 *
 * `metadata` は台本の付随物であり、パイプラインの一段ではない。
 * 前段は `script` とする。
 */
export function previousStage(stage) {
  if (stage === 'threads') {
    return null;
  }

  if (stage === 'metadata') {
    return 'script';
  }

  const index = STAGES.indexOf(stage);

  return index > 0 ? STAGES[index - 1] : null;
}

/**
 * IDを作る。
 *
 * `crypto.randomUUID` はブラウザでも Node 18+ でも使える。
 * 使えない環境向けの代替は持たない（対応環境を絞るほうが、
 * 弱い乱数で衝突するより安全）。
 *
 * @param {string} storeName
 * @param {{ randomUUID?: () => string }} [cryptoImpl] テストで固定値を差す口
 */
export function makeId(storeName, cryptoImpl) {
  const prefix = ID_PREFIX[storeName];

  if (prefix === undefined) {
    throw new Error(`IDの接頭辞が未定義のストアです: ${storeName}`);
  }

  const impl = cryptoImpl ?? globalThis.crypto;

  if (impl === undefined || typeof impl.randomUUID !== 'function') {
    throw new Error('crypto.randomUUID が使えません。対応ブラウザで開いてください。');
  }

  return `${prefix}_${impl.randomUUID()}`;
}

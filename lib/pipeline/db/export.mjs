/*
 * エクスポート／インポート（実装指示書 §2-2 で **Must**）。
 *
 * ==================================================================
 * なぜ Must なのか
 * ==================================================================
 * データは利用者のブラウザにしか無い。**ブラウザのデータを消せば消える。
 * PC とスマートフォンでも同期しない。** 唯一の持ち出し手段がこれである。
 *
 * したがって、この機能が壊れていることは「バックアップが取れない」に
 * 等しい。テストで固定する対象として最優先に置く。
 * ==================================================================
 *
 * 形式は JSON 1ファイル。**APIキーは含めない**（キーは localStorage 側で
 * 管理し、そもそも IndexedDB に入れていない。設計 §3-6）。
 */

import { STORE } from './schema.mjs';

/** 書き出す形式の版。読み込み側が互換を判断するために使う。 */
export const EXPORT_FORMAT = 'isso-export-1';

/**
 * すべて書き出す。
 *
 * `meta` は含めない。「初回説明を見た」を他端末へ持ち込むと、
 * その端末の利用者が説明を読まないまま使い始めることになる。
 *
 * @param {import('./port.d.mts').Store} store
 */
export async function exportAll(store, deps = {}) {
  const at = (deps.now ?? (() => new Date().toISOString()))();

  return {
    format: EXPORT_FORMAT,
    exportedAt: at,
    projects: await store.getAll(STORE.PROJECTS),
    versions: await store.getAll(STORE.VERSIONS),
    scenes: await store.getAll(STORE.SCENES),
    settings: await store.getAll(STORE.SETTINGS),
  };
}

/**
 * 読み込む。
 *
 * `mode` は 'merge'（既定）か 'replace'。
 *   merge   … 同じIDがあれば上書き、無ければ足す
 *   replace … 全消去してから入れる
 *
 * **既定を merge にしてある。** replace を既定にすると、
 * 取り違えたファイルを1回読ませただけで手元の全データが消える。
 */
export async function importAll(store, payload, { mode = 'merge' } = {}) {
  if (payload === null || typeof payload !== 'object') {
    throw new Error('読み込めるファイルではありません。');
  }

  if (payload.format !== EXPORT_FORMAT) {
    /*
     * 版が違うものを黙って読むと、欠けた列が undefined のまま入り、
     * あとから原因の分からない不具合になる。ここで止める。
     */
    throw new Error(
      `対応していない形式です（${String(payload.format ?? '不明')}）。`
      + `このアプリが読めるのは ${EXPORT_FORMAT} です。`,
    );
  }

  if (mode === 'replace') {
    await store.clearAll();
  }

  const counts = {
    projects: (payload.projects ?? []).length,
    versions: (payload.versions ?? []).length,
    scenes: (payload.scenes ?? []).length,
    settings: (payload.settings ?? []).length,
  };

  await store.putAll(STORE.PROJECTS, payload.projects ?? []);
  await store.putAll(STORE.VERSIONS, payload.versions ?? []);
  await store.putAll(STORE.SCENES, payload.scenes ?? []);
  await store.putAll(STORE.SETTINGS, payload.settings ?? []);

  return counts;
}

/**
 * すべて消す（`/pipeline/data/` の「データを全消去」）。
 *
 * **Meta へ提出するデータ削除案内が指す操作がこれ**
 * （docs/pipeline/legal/data-deletion-page-outline.md §3）。
 * 案内に書いた操作が実在しない、という状態を作らないこと。
 */
export async function clearEverything(store) {
  await store.clearAll();
}

/*
 * projects の読み書き（ContentProject 相当・要件10章）。
 *
 * ポートに対して書く。IndexedDB は知らない（indexeddb.mjs の責務）。
 */

import { STORE, makeId } from './schema.mjs';

/** 日時。テストで固定できるよう引数で受ける。 */
function nowIso(now) {
  return (now ?? (() => new Date().toISOString()))();
}

/**
 * テーマを作る。
 *
 * @param {import('./port.d.mts').Store} store
 * @param {{ sourceText: string, title?: string, audience?: string, note?: string }} input
 * @param {{ now?: () => string, cryptoImpl?: { randomUUID: () => string } }} [deps]
 */
export async function createProject(store, input, deps = {}) {
  const source = String(input.sourceText ?? '').trim();

  if (source === '') {
    /* 着想が無いとパイプラインが始まらない（FR-001）。空で作らせない。 */
    throw new Error('着想を入力してください。');
  }

  const at = nowIso(deps.now);

  const project = {
    id: makeId(STORE.PROJECTS, deps.cryptoImpl),
    sourceText: source,
    title: String(input.title ?? '').trim(),
    audience: String(input.audience ?? '').trim(),
    note: String(input.note ?? '').trim(),
    status: 'draft',
    createdAt: at,
    updatedAt: at,
  };

  return store.put(STORE.PROJECTS, project);
}

/** @param {import('./port.d.mts').Store} store */
export async function getProject(store, id) {
  return store.get(STORE.PROJECTS, id);
}

/**
 * 更新する。`updatedAt` は必ずこちらで打つ。
 *
 * 呼び出し側に任せると、更新順に並べたときの一覧が壊れる。
 */
export async function updateProject(store, id, patch, deps = {}) {
  const current = await store.get(STORE.PROJECTS, id);

  if (current === null) {
    throw new Error(`テーマが見つかりません: ${id}`);
  }

  /*
   * id・createdAt・updatedAt は patch から受け付けない。
   * 書き換えられると、そのテーマの来歴が追えなくなる。
   *
   * 分割代入で捨てると未使用変数の警告になるため、明示的に許可列を選ぶ。
   * 許可制にしてあるので、列を足したときはここにも足す必要がある
   * （足し忘れても「保存されない」で済み、壊れた値が入るより安全）。
   */
  const ALLOWED = ['sourceText', 'title', 'audience', 'note', 'status'];
  const allowed = {};

  for (const key of ALLOWED) {
    if (Object.hasOwn(patch, key)) {
      allowed[key] = patch[key];
    }
  }

  return store.put(STORE.PROJECTS, {
    ...current,
    ...allowed,
    updatedAt: nowIso(deps.now),
  });
}

/**
 * 一覧。**更新の新しい順**（ホームの並び）。
 *
 * 索引は昇順でしか返さないため、ここで反転する。件数が数百までの
 * 想定なので、カーソルを逆順に回すより読みやすさを採る。
 */
export async function listProjects(store, { includeArchived = false } = {}) {
  const all = await store.getAll(STORE.PROJECTS);

  return all
    .filter((project) => (includeArchived ? true : project.status !== 'archived'))
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
}

/**
 * テーマを消す。**ぶら下がる版とシーンも一緒に消す。**
 *
 * IndexedDB に外部キー制約は無い。ここで消し漏らすと、
 * どこからも参照されない版が端末に残り続ける。
 */
export async function deleteProject(store, id) {
  const versions = await store.getAllBy(STORE.VERSIONS, 'byProject', id);

  for (const version of versions) {
    const scenes = await store.getAllBy(STORE.SCENES, 'byVersion', version.id);
    await store.removeAll(STORE.SCENES, scenes.map((scene) => scene.id));
  }

  await store.removeAll(STORE.VERSIONS, versions.map((version) => version.id));
  await store.remove(STORE.PROJECTS, id);
}

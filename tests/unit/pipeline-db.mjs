/*
 * 一想（ISSO）のローカルDB層のテスト。
 *
 * ==================================================================
 * 実ブラウザを使わない理由
 * ==================================================================
 * IndexedDB は Node に無く、`fake-indexeddb` のような外部パッケージは
 * 入れられない（外部SDK追加禁止）。
 *
 * そこで lib/pipeline/db/ は**ポート**（memory.mjs 冒頭の契約）に対して
 * 書いてある。IndexedDB 固有の作法は indexeddb.mjs だけが知っており、
 * ロジックはメモリ実装で全部確かめられる。
 *
 * **indexeddb.mjs 自体はここでは検証していない。** そこは実ブラウザでしか
 * 確かめられないため、Phase 1 の画面ができた時点で tests/browser/ へ足す。
 * 「ポートの契約に合っているか」までが、この層で保証できる範囲である。
 * ==================================================================
 */

import { createMemoryStore } from '../../lib/pipeline/db/memory.mjs';
import { STORE, makeId, previousStage } from '../../lib/pipeline/db/schema.mjs';
import {
  createProject, getProject, updateProject, listProjects, deleteProject,
} from '../../lib/pipeline/db/projects.mjs';
import {
  createVersion, listVersions, getAdopted, adoptVersion,
  editVersionBody, collectUpstream, canGenerate,
} from '../../lib/pipeline/db/versions.mjs';
import { validateScenes, replaceScenes, listScenes } from '../../lib/pipeline/db/scenes.mjs';
import {
  getSetting, setSetting, getAllSettings, hasSeenWelcome, markWelcomeSeen,
} from '../../lib/pipeline/db/settings.mjs';
import {
  exportAll, importAll, clearEverything, EXPORT_FORMAT,
} from '../../lib/pipeline/db/export.mjs';

let pass = 0;
let fail = 0;

function check(label, condition, detail) {
  if (condition) {
    pass += 1;
  } else {
    fail += 1;
    console.error(`  NG  ${label}${detail === undefined ? '' : ` — ${detail}`}`);
  }
}

function section(title) {
  console.log(`\n--- ${title} ---`);
}

async function throws(fn) {
  try {
    await fn();
    return null;
  } catch (error) {
    return error;
  }
}

/* IDと日時を固定する。テストが実行ごとに変わらないようにする。 */
function fixedDeps(prefix) {
  let n = 0;
  let t = 0;

  return {
    cryptoImpl: { randomUUID: () => `${prefix}${(n += 1)}` },
    /* 更新順の検証で差が要るため、呼ぶたびに1秒進める。 */
    now: () => new Date(Date.UTC(2026, 7, 7, 0, 0, (t += 1))).toISOString(),
  };
}

/* ================================================================
 * schema
 * ================================================================ */
section('schema');
{
  check('段階の前後（threads は最初）', previousStage('threads') === null);
  check('段階の前後（x の前は threads）', previousStage('x') === 'threads');
  check('段階の前後（note の前は x）', previousStage('note') === 'x');
  check('段階の前後（script の前は note）', previousStage('script') === 'note');
  check('metadata の前は script（並びの末尾ではなく台本の付随物）',
    previousStage('metadata') === 'script');

  const id = makeId(STORE.PROJECTS, { randomUUID: () => 'abc' });
  check('IDに接頭辞が付く', id === 'prj_abc', id);

  const err = await throws(async () => makeId('unknown', { randomUUID: () => 'x' }));
  check('未定義ストアのIDは作れない', err instanceof Error);
}

/* ================================================================
 * projects
 * ================================================================ */
section('projects');
{
  const store = createMemoryStore();
  const deps = fixedDeps('p');

  const project = await createProject(store, { sourceText: '  着想メモ  ' }, deps);
  check('作成できる', project.id === 'prj_p1', project.id);
  check('前後の空白を落とす', project.sourceText === '着想メモ');
  check('初期状態は draft', project.status === 'draft');
  check('createdAt と updatedAt が入る',
    typeof project.createdAt === 'string' && typeof project.updatedAt === 'string');

  const empty = await throws(() => createProject(store, { sourceText: '   ' }, deps));
  check('空の着想では作れない（FR-001）', empty instanceof Error);

  const found = await getProject(store, project.id);
  check('IDで引ける', found?.sourceText === '着想メモ');
  check('存在しないIDは null', (await getProject(store, 'prj_none')) === null);

  const updated = await updateProject(store, project.id, { title: '題名' }, deps);
  check('更新できる', updated.title === '題名');
  check('updatedAt が進む', updated.updatedAt > project.updatedAt,
    `${project.updatedAt} → ${updated.updatedAt}`);
  check('createdAt は変わらない', updated.createdAt === project.createdAt);

  const tampered = await updateProject(
    store, project.id, { id: 'prj_hack', createdAt: '1999-01-01T00:00:00.000Z' }, deps,
  );
  check('patch では id を書き換えられない', tampered.id === project.id);
  check('patch では createdAt を書き換えられない', tampered.createdAt === project.createdAt);

  /* 返り値を書き換えても保存内容が変わらないこと（構造化複製と同じ振る舞い）。 */
  const snapshot = await getProject(store, project.id);
  snapshot.title = '書き換え';
  check('返り値の変更が保存へ波及しない',
    (await getProject(store, project.id)).title === '題名');

  const second = await createProject(store, { sourceText: '2つ目' }, deps);
  const list = await listProjects(store);
  check('一覧は更新の新しい順', list[0].id === second.id, list.map((p) => p.id).join(','));

  await updateProject(store, project.id, { status: 'archived' }, deps);
  check('archived は既定で一覧に出ない', (await listProjects(store)).length === 1);
  check('includeArchived で出る',
    (await listProjects(store, { includeArchived: true })).length === 2);
}

/* ================================================================
 * versions — 採用と派生（要件15章・10章）
 * ================================================================ */
section('versions');
{
  const store = createMemoryStore();
  const deps = fixedDeps('v');
  const project = await createProject(store, { sourceText: '着想' }, deps);

  const a = await createVersion(store, { projectId: project.id, stage: 'threads', body: '案A' }, deps);
  const b = await createVersion(store, { projectId: project.id, stage: 'threads', body: '案B' }, deps);
  const c = await createVersion(store, { projectId: project.id, stage: 'threads', body: '案C' }, deps);

  check('versionNo が連番になる', a.versionNo === 1 && b.versionNo === 2 && c.versionNo === 3);
  check('初期は未採用', a.adopted === false);
  check('複数案が同じストアに入る（FR-013）',
    (await listVersions(store, project.id, 'threads')).length === 3);
  check('一覧は新しい順',
    (await listVersions(store, project.id, 'threads'))[0].id === c.id);

  check('採用前は null', (await getAdopted(store, project.id, 'threads')) === null);

  await adoptVersion(store, b.id);
  check('採用できる', (await getAdopted(store, project.id, 'threads'))?.id === b.id);

  await adoptVersion(store, c.id);
  const adoptedRows = (await listVersions(store, project.id, 'threads'))
    .filter((row) => row.adopted);
  check('採用は高々1件（切り替えで旧採用が落ちる）', adoptedRows.length === 1,
    `${adoptedRows.length}件`);
  check('新しい採用が有効', adoptedRows[0].id === c.id);

  const missing = await throws(() => adoptVersion(store, 'ver_none'));
  check('存在しない版は採用できない', missing instanceof Error);

  /* 段階の進行制御（設計 §2-3 のタブ活性） */
  check('最初の段階は常に生成できる', (await canGenerate(store, project.id, 'threads')) === true);
  check('前段が採用済みなら次段へ進める', (await canGenerate(store, project.id, 'x')) === true);
  check('前々段が採用済みでも直前が未採用なら進めない',
    (await canGenerate(store, project.id, 'note')) === false);

  /* 編集の記録（要件15章） */
  const edited = await editVersionBody(store, c.id, '手直しした案C');
  check('本文を編集できる', edited.body === '手直しした案C');
  check('編集の事実が残る', edited.editedByUser === true);
  check('編集しても採用は外れない', edited.adopted === true);

  /* 上流の収集 */
  const x = await createVersion(
    store, { projectId: project.id, stage: 'x', body: 'X案', parentVersionId: c.id }, deps,
  );
  await adoptVersion(store, x.id);
  check('派生元を記録できる（要件10章）', x.parentVersionId === c.id);

  const upstream = await collectUpstream(store, project.id, 'note');
  check('上流を前段から順に集める', upstream.map((u) => u.stage).join(',') === 'threads,x',
    upstream.map((u) => u.stage).join(','));
  check('採用版の本文を渡す', upstream[0].body === '手直しした案C');
  check('編集済みかどうかを伝える', upstream[0].editedByUser === true);

  /* 未採用の案が混ざらないこと（要件15章の要） */
  await createVersion(store, { projectId: project.id, stage: 'threads', body: '不採用案' }, deps);
  const again = await collectUpstream(store, project.id, 'note');
  check('未採用の案は上流に含まれない',
    again.filter((u) => u.body === '不採用案').length === 0);
}

/* ================================================================
 * scenes — AC-09
 * ================================================================ */
section('scenes（AC-09）');
{
  check('配列でなければ不合格', validateScenes(null).ok === false);
  check('0件は不合格', validateScenes([]).ok === false);
  check('1件は不合格（「複数」を満たさない）',
    validateScenes([{ narration: 'あ', visualPrompt: 'い' }]).ok === false);

  const noNarration = validateScenes([
    { narration: '', visualPrompt: 'い' },
    { narration: 'う', visualPrompt: 'え' },
  ]);
  check('ナレーションが空なら不合格', noNarration.ok === false);
  check('何番目かを理由に含める', noNarration.reason.includes('1番目'), noNarration.reason);

  check('映像指示が空なら不合格', validateScenes([
    { narration: 'あ', visualPrompt: '   ' },
    { narration: 'う', visualPrompt: 'え' },
  ]).ok === false);

  check('全角空白だけも空とみなす', validateScenes([
    { narration: '　　', visualPrompt: 'い' },
    { narration: 'う', visualPrompt: 'え' },
  ]).ok === false);

  check('2件そろえば合格', validateScenes([
    { narration: 'あ', visualPrompt: 'い' },
    { narration: 'う', visualPrompt: 'え' },
  ]).ok === true);

  const store = createMemoryStore();
  const deps = fixedDeps('s');
  const project = await createProject(store, { sourceText: '着想' }, deps);
  const script = await createVersion(
    store, { projectId: project.id, stage: 'script', body: '台本' }, deps,
  );

  const bad = await throws(() => replaceScenes(store, script.id, [
    { narration: 'あ', visualPrompt: '' },
    { narration: 'う', visualPrompt: 'え' },
  ], deps));
  check('検証を通らないシーンは保存されない', bad instanceof Error);
  check('保存されていない', (await listScenes(store, script.id)).length === 0);

  await replaceScenes(store, script.id, [
    { narration: 'ナレ1', visualPrompt: '映像1' },
    { narration: 'ナレ2', visualPrompt: '映像2', subtitle: '字幕2' },
  ], deps);

  const saved = await listScenes(store, script.id);
  check('シーンを保存できる', saved.length === 2);
  check('order が順に振られる', saved[0].order === 0 && saved[1].order === 1);
  check('order 順で返る', saved[0].narration === 'ナレ1');
  check('字幕は任意（既定 null）', saved[0].subtitle === null);
  check('字幕を持てる', saved[1].subtitle === '字幕2');

  /* 再生成で古いシーンが残らないこと */
  await replaceScenes(store, script.id, [
    { narration: '新1', visualPrompt: '新映像1' },
    { narration: '新2', visualPrompt: '新映像2' },
    { narration: '新3', visualPrompt: '新映像3' },
  ], deps);

  const replaced = await listScenes(store, script.id);
  check('入れ替えで古いシーンが消える', replaced.length === 3, `${replaced.length}件`);
  check('中身が入れ替わっている', replaced[0].narration === '新1');
}

/* ================================================================
 * settings / meta
 * ================================================================ */
section('settings / meta');
{
  const store = createMemoryStore();

  check('既定値を返す', (await getSetting(store, 'threads.lengthHint')) === '50〜150字');
  check('未知のキーは null', (await getSetting(store, 'nope')) === null);

  await setSetting(store, 'tone', 'ですます');
  check('保存した値が優先される', (await getSetting(store, 'tone')) === 'ですます');

  const all = await getAllSettings(store);
  check('既定値に保存済みが重なる', all.tone === 'ですます' && all['x.lengthHint'] === '150〜300字');

  check('初回は未読', (await hasSeenWelcome(store)) === false);
  await markWelcomeSeen(store);
  check('既読にできる', (await hasSeenWelcome(store)) === true);
}

/* ================================================================
 * export / import
 * ================================================================ */
section('export / import');
{
  const store = createMemoryStore();
  const deps = fixedDeps('e');
  const project = await createProject(store, { sourceText: '着想' }, deps);
  const version = await createVersion(
    store, { projectId: project.id, stage: 'script', body: '台本' }, deps,
  );
  await replaceScenes(store, version.id, [
    { narration: 'ナレ1', visualPrompt: '映像1' },
    { narration: 'ナレ2', visualPrompt: '映像2' },
  ], deps);
  await setSetting(store, 'tone', 'ですます');
  await markWelcomeSeen(store);

  const dump = await exportAll(store, deps);
  check('形式の版が入る', dump.format === EXPORT_FORMAT);
  check('テーマが入る', dump.projects.length === 1);
  check('版が入る', dump.versions.length === 1);
  check('シーンが入る', dump.scenes.length === 2);
  check('設定が入る', dump.settings.length === 1);
  check('meta は書き出さない（既読を他端末へ持ち込まない）', dump.meta === undefined);
  check('JSON にできる', typeof JSON.stringify(dump) === 'string');

  /* 別の端末を模す */
  const other = createMemoryStore();
  const counts = await importAll(other, JSON.parse(JSON.stringify(dump)));
  check('読み込める', counts.projects === 1 && counts.scenes === 2);
  check('テーマが復元される', (await listProjects(other)).length === 1);
  check('シーンが復元される', (await listScenes(other, version.id)).length === 2);
  check('設定が復元される', (await getSetting(other, 'tone')) === 'ですます');
  check('既読は引き継がれない（説明画面を必ず通す）',
    (await hasSeenWelcome(other)) === false);

  const badFormat = await throws(() => importAll(other, { format: 'other-1' }));
  check('形式が違えば読まない', badFormat instanceof Error);
  const notObject = await throws(() => importAll(other, 'ただの文字列'));
  check('オブジェクトでなければ読まない', notObject instanceof Error);

  /* 既定は merge。取り違えたファイル1つで全部消えることがないように。 */
  const extra = createMemoryStore();
  await createProject(extra, { sourceText: '元からあるもの' }, fixedDeps('x'));
  await importAll(extra, JSON.parse(JSON.stringify(dump)));
  check('既定は merge（既存が残る）', (await listProjects(extra)).length === 2);

  await importAll(extra, JSON.parse(JSON.stringify(dump)), { mode: 'replace' });
  check('replace は入れ替える', (await listProjects(extra)).length === 1);

  await clearEverything(store);
  check('全消去できる', (await listProjects(store)).length === 0);
  check('シーンも消える', (await listScenes(store, version.id)).length === 0);
  /*
   * 全消去後は「値が無くなる」のではなく**既定値に戻る**。
   * getSetting は保存が無ければ DEFAULT_SETTINGS を返すため。
   * 画面が空を掴まないので、これが望ましい挙動。
   */
  check('設定は既定値に戻る（null にはならない）', (await getSetting(store, 'tone')) === '');
  check('保存済みの設定行は消えている', (await exportAll(store, deps)).settings.length === 0);
}

/* ================================================================
 * 参照の後始末
 * ================================================================ */
section('削除時の後始末');
{
  const store = createMemoryStore();
  const deps = fixedDeps('d');
  const project = await createProject(store, { sourceText: '着想' }, deps);
  const version = await createVersion(
    store, { projectId: project.id, stage: 'script', body: '台本' }, deps,
  );
  await replaceScenes(store, version.id, [
    { narration: 'ナレ1', visualPrompt: '映像1' },
    { narration: 'ナレ2', visualPrompt: '映像2' },
  ], deps);

  await deleteProject(store, project.id);

  check('テーマが消える', (await getProject(store, project.id)) === null);
  check('ぶら下がる版も消える',
    (await listVersions(store, project.id, 'script')).length === 0);
  check('ぶら下がるシーンも消える（外部キー制約が無いため手で消す）',
    (await listScenes(store, version.id)).length === 0);
}

console.log(`\nTESTRESULT ${pass} ${fail}`);
process.exit(fail === 0 ? 0 : 1);

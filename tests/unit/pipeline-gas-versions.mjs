/*
 * Themes.gs / Versions.gs の検証。
 *
 * ==================================================================
 * ここで守っている要件
 * ==================================================================
 *   要件10章 … parent_version_id による派生追跡（「体験の中核」）
 *   要件15章 … 前段の**採用版**を次段の主要入力とする
 *   要件15章 … 利用者が編集した表現を AI 原案より優先する
 *   FR-001  … 着想が空では始められない
 *   FR-013  … 複数案を持ち、1つを採用する
 *
 * 実シートには一切書き込まない（メモリ実装を差している）。
 * ==================================================================
 */

import { check, section, finish } from '../../public/apps/tests/helpers/assert.mjs';
import { loadIssoGas, createIssoStore } from '../helpers/isso-gas-harness.mjs';

function throws(fn) {
  try {
    fn();
    return null;
  } catch (error) {
    return error;
  }
}

/** ID と時刻を固定する。テストが実行ごとに変わらないようにする。 */
function fixedDeps(prefix) {
  let n = 0;
  let t = 0;

  return {
    uuid: () => `${prefix}${(n += 1)}`,
    now: () => new Date(Date.UTC(2026, 7, 8, 0, 0, (t += 1))).toISOString(),
  };
}

const gas = loadIssoGas({ properties: { ISSO_SPREADSHEET_ID: 'sheet-abc' } });

/* ================================================================ */
section('テーマ');

{
  const { store } = createIssoStore(gas);
  const deps = fixedDeps('t');

  const theme = gas.IssoThemes_create(store, { source_text: '  着想メモ  ' }, deps);

  check('作れる', theme.theme_id === 'thm_t1', theme.theme_id);
  check('前後の空白を落とす', theme.source_text === '着想メモ');
  check('初期状態は draft', theme.status === gas.ISSO_STATUS.THEME_DRAFT);
  check('作成日時と更新日時が入る',
    theme.created_at !== '' && theme.updated_at === theme.created_at);

  check('**着想が空では作れない**（FR-001）',
    throws(() => gas.IssoThemes_create(store, { source_text: '   ' }, deps)) instanceof Error);

  check('IDで引ける', gas.IssoThemes_get(store, theme.theme_id).source_text === '着想メモ');
  check('無いIDは null', gas.IssoThemes_get(store, 'thm_none') === null);

  const updated = gas.IssoThemes_update(store, theme.theme_id, { title: '題名' }, deps);

  check('更新できる', updated.title === '題名');
  check('**更新日時が進む**', updated.updated_at > theme.updated_at,
    `${theme.updated_at} → ${updated.updated_at}`);
  check('作成日時は変わらない', updated.created_at === theme.created_at);

  const tampered = gas.IssoThemes_update(
    store, theme.theme_id, { theme_id: 'thm_hack', created_at: '1999-01-01' }, deps,
  );

  check('**主キーは書き換えられない**', tampered.theme_id === theme.theme_id);
  check('**作成日時も書き換えられない**', tampered.created_at === theme.created_at);

  const second = gas.IssoThemes_create(store, { source_text: '2つ目' }, deps);

  check('一覧は更新の新しい順',
    gas.IssoThemes_list(store)[0].theme_id === second.theme_id,
    gas.IssoThemes_list(store).map((t) => t.theme_id).join(','));

  gas.IssoThemes_update(store, theme.theme_id, { status: gas.ISSO_STATUS.THEME_ARCHIVED }, deps);

  check('archived は既定で出ない', gas.IssoThemes_list(store).length === 1);
  check('includeArchived で出る',
    gas.IssoThemes_list(store, { includeArchived: true }).length === 2);
}

/* ================================================================ */
section('版の作成と一覧');

{
  const { store } = createIssoStore(gas);
  const deps = fixedDeps('v');
  const theme = gas.IssoThemes_create(store, { source_text: '着想' }, deps);

  const a = gas.IssoVersions_create(store, { theme_id: theme.theme_id, stage: 'threads', body: '案A' }, deps);
  const b = gas.IssoVersions_create(store, { theme_id: theme.theme_id, stage: 'threads', body: '案B' }, deps);
  const c = gas.IssoVersions_create(store, { theme_id: theme.theme_id, stage: 'threads', body: '案C' }, deps);

  check('版番号が連番になる',
    a.version_no === 1 && b.version_no === 2 && c.version_no === 3);
  check('初期は未採用', a.adopted === false);
  check('**複数案が同じシートに入る**（FR-013）',
    gas.IssoVersions_list(store, theme.theme_id, 'threads').length === 3);
  check('一覧は新しい順',
    gas.IssoVersions_list(store, theme.theme_id, 'threads')[0].version_id === c.version_id);

  check('theme_id が無ければ落ちる',
    throws(() => gas.IssoVersions_create(store, { stage: 'threads' }, deps)) instanceof Error);
  check('**定義に無い段階は作れない**',
    throws(() => gas.IssoVersions_create(
      store, { theme_id: theme.theme_id, stage: 'nope' }, deps,
    )) instanceof Error);

  /* 別テーマの版が混ざらないこと */
  const other = gas.IssoThemes_create(store, { source_text: '別の着想' }, deps);
  gas.IssoVersions_create(store, { theme_id: other.theme_id, stage: 'threads', body: '別' }, deps);

  check('テーマをまたいで混ざらない',
    gas.IssoVersions_list(store, theme.theme_id, 'threads').length === 3);
}

/* ================================================================ */
section('採用（同一段階で高々1件）');

{
  const { store } = createIssoStore(gas);
  const deps = fixedDeps('a');
  const theme = gas.IssoThemes_create(store, { source_text: '着想' }, deps);

  const a = gas.IssoVersions_create(store, { theme_id: theme.theme_id, stage: 'threads', body: '案A' }, deps);
  const b = gas.IssoVersions_create(store, { theme_id: theme.theme_id, stage: 'threads', body: '案B' }, deps);
  const c = gas.IssoVersions_create(store, { theme_id: theme.theme_id, stage: 'threads', body: '案C' }, deps);

  check('採用前は null', gas.IssoVersions_getAdopted(store, theme.theme_id, 'threads') === null);

  gas.IssoVersions_adopt(store, b.version_id);
  check('採用できる',
    gas.IssoVersions_getAdopted(store, theme.theme_id, 'threads').version_id === b.version_id);

  gas.IssoVersions_adopt(store, c.version_id);

  const adoptedRows = gas.IssoVersions_list(store, theme.theme_id, 'threads')
    .filter((row) => row.adopted === true);

  check('**採用は高々1件**（切り替えで旧採用が落ちる）', adoptedRows.length === 1,
    `${adoptedRows.length}件`);
  check('新しい採用が有効', adoptedRows[0].version_id === c.version_id);
  check('採用していない案は false', gas.IssoVersions_list(store, theme.theme_id, 'threads')
    .filter((r) => r.version_id === a.version_id)[0].adopted === false);

  check('無い版は採用できない',
    throws(() => gas.IssoVersions_adopt(store, 'ver_none')) instanceof Error);

  /*
   * 手でシートを直して採用が2件になった状態からの自己修復。
   * 画面が固まるより、決定的に1件へ寄せるほうがよい。
   */
  store.update(gas.ISSO_SHEET.VERSIONS, a.version_id, { adopted: true });

  check('**採用が2件でも決定的に1件を返す**（版番号が最大）',
    gas.IssoVersions_getAdopted(store, theme.theme_id, 'threads').version_id === c.version_id,
    gas.IssoVersions_getAdopted(store, theme.theme_id, 'threads').version_id);

  gas.IssoVersions_adopt(store, a.version_id);

  check('採用し直すと1件に戻る',
    gas.IssoVersions_list(store, theme.theme_id, 'threads')
      .filter((r) => r.adopted === true).length === 1);
}

/* ================================================================ */
section('手直し（要件15章）');

{
  const { store } = createIssoStore(gas);
  const deps = fixedDeps('e');
  const theme = gas.IssoThemes_create(store, { source_text: '着想' }, deps);
  const v = gas.IssoVersions_create(store, { theme_id: theme.theme_id, stage: 'threads', body: '原案' }, deps);

  gas.IssoVersions_adopt(store, v.version_id);

  const edited = gas.IssoVersions_editBody(store, v.version_id, '手直しした本文');

  check('本文を編集できる', edited.body === '手直しした本文');
  check('**編集の事実が残る**', edited.edited_by_user === true);
  check('編集しても採用は外れない', edited.adopted === true);
  check('版は増えない', gas.IssoVersions_list(store, theme.theme_id, 'threads').length === 1);

  check('無い版は編集できない',
    throws(() => gas.IssoVersions_editBody(store, 'ver_none', 'x')) instanceof Error);
}

/* ================================================================ */
section('上流の収集（要件15章）');

{
  const { store } = createIssoStore(gas);
  const deps = fixedDeps('u');
  const theme = gas.IssoThemes_create(store, { source_text: '着想' }, deps);

  const t1 = gas.IssoVersions_create(store, { theme_id: theme.theme_id, stage: 'threads', body: '採用案' }, deps);
  gas.IssoVersions_create(store, { theme_id: theme.theme_id, stage: 'threads', body: '不採用案' }, deps);
  gas.IssoVersions_adopt(store, t1.version_id);
  gas.IssoVersions_editBody(store, t1.version_id, '手直しした採用案');

  const x1 = gas.IssoVersions_create(store, {
    theme_id: theme.theme_id, stage: 'x', body: 'X案',
    parent_version_id: t1.version_id,
  }, deps);
  gas.IssoVersions_adopt(store, x1.version_id);

  const upstream = gas.IssoVersions_collectUpstream(store, theme.theme_id, 'note');

  check('**宣言された上流の順で集める**',
    upstream.map((u) => u.stage).join(',') === 'threads,x',
    upstream.map((u) => u.stage).join(','));
  check('採用版の本文を渡す', upstream[0].body === '手直しした採用案');
  check('**表示名が付く**（プロンプトの見出しになる）', upstream[0].label === 'Threads');
  check('**手直し済みかどうかを伝える**（要件15章）', upstream[0].editedByUser === true);
  check('手直しでない版は false', upstream[1].editedByUser === false);

  check('**未採用の案は含まれない**',
    upstream.filter((u) => u.body === '不採用案').length === 0);

  check('threads の上流は空', gas.IssoVersions_collectUpstream(store, theme.theme_id, 'threads').length === 0);
  check('未定義の段階は落ちる',
    throws(() => gas.IssoVersions_collectUpstream(store, theme.theme_id, 'nope')) instanceof Error);

  /* プロンプト組み立てへそのまま渡せる形であること */
  const prompt = gas.issoBuildPrompt('note', {
    source: theme.source_text,
    upstream: upstream,
  });

  check('**issoBuildPrompt へそのまま渡せる**', prompt.includes('手直しした採用案'));
  check('手直しの印がプロンプトに出る', prompt.includes('利用者が手直しした版'));
}

/* ================================================================ */
section('生成してよいかの判定');

{
  const { store } = createIssoStore(gas);
  const deps = fixedDeps('g');
  const theme = gas.IssoThemes_create(store, { source_text: '着想' }, deps);

  check('最初の段階は常に生成できる',
    gas.IssoVersions_canGenerate(store, theme.theme_id, 'threads') === true);
  check('前段が未採用なら進めない',
    gas.IssoVersions_canGenerate(store, theme.theme_id, 'x') === false);

  const t1 = gas.IssoVersions_create(store, { theme_id: theme.theme_id, stage: 'threads', body: 'T' }, deps);
  gas.IssoVersions_adopt(store, t1.version_id);

  check('前段が採用済みなら進める',
    gas.IssoVersions_canGenerate(store, theme.theme_id, 'x') === true);
  check('**上流が1つ欠けていれば進めない**（note の上流は threads と x）',
    gas.IssoVersions_canGenerate(store, theme.theme_id, 'note') === false);

  const x1 = gas.IssoVersions_create(store, { theme_id: theme.theme_id, stage: 'x', body: 'X' }, deps);
  gas.IssoVersions_adopt(store, x1.version_id);

  check('上流がそろえば進める',
    gas.IssoVersions_canGenerate(store, theme.theme_id, 'note') === true);

  /*
   * 第2段（db/versions.mjs）は「直前の1段だけ」を見ており、ここと違う。
   * その差が実際に出る状況を固定しておく（両方の注記の裏づけ）。
   */
  store.update(gas.ISSO_SHEET.VERSIONS, t1.version_id, { adopted: false });

  check('**上流の採用を後から外すと進めなくなる**（第1段の規則）',
    gas.IssoVersions_canGenerate(store, theme.theme_id, 'note') === false);
}

/* ================================================================ */
section('派生（要件10章）');

{
  const { store } = createIssoStore(gas);
  const deps = fixedDeps('p');
  const theme = gas.IssoThemes_create(store, { source_text: '着想' }, deps);

  check('上流が無ければ派生元も無い',
    gas.IssoVersions_defaultParent(store, theme.theme_id, 'threads') === '');

  const t1 = gas.IssoVersions_create(store, { theme_id: theme.theme_id, stage: 'threads', body: 'T' }, deps);
  gas.IssoVersions_adopt(store, t1.version_id);

  check('**直前の採用版が派生元になる**',
    gas.IssoVersions_defaultParent(store, theme.theme_id, 'x') === t1.version_id);

  const x1 = gas.IssoVersions_create(store, {
    theme_id: theme.theme_id, stage: 'x', body: 'X',
    parent_version_id: gas.IssoVersions_defaultParent(store, theme.theme_id, 'x'),
  }, deps);
  gas.IssoVersions_adopt(store, x1.version_id);

  const n1 = gas.IssoVersions_create(store, {
    theme_id: theme.theme_id, stage: 'note', body: 'N',
    parent_version_id: gas.IssoVersions_defaultParent(store, theme.theme_id, 'note'),
  }, deps);

  check('note の派生元は x（上流の末尾）', n1.parent_version_id === x1.version_id);

  const lineage = gas.IssoVersions_lineage(store, n1.version_id);

  check('**系譜を遡れる**（要件10章）',
    lineage.map((v) => v.stage).join(',') === 'note,x,threads',
    lineage.map((v) => v.stage).join(','));

  /* 手でシートを直して親子が輪になった場合に固まらないこと */
  store.update(gas.ISSO_SHEET.VERSIONS, t1.version_id, { parent_version_id: n1.version_id });

  const looped = gas.IssoVersions_lineage(store, n1.version_id);

  check('**循環していても止まる**（手編集で輪になっても固まらない）',
    looped.length === 3, String(looped.length));

  /* 親が消えていても止まること */
  store.update(gas.ISSO_SHEET.VERSIONS, t1.version_id, { parent_version_id: 'ver_missing' });

  check('親が見つからなくても止まる',
    gas.IssoVersions_lineage(store, n1.version_id).length === 3);
}

/* ================================================================ */
section('テーマ削除の後始末');

{
  const { store } = createIssoStore(gas);
  const deps = fixedDeps('d');
  const theme = gas.IssoThemes_create(store, { source_text: '着想' }, deps);
  const other = gas.IssoThemes_create(store, { source_text: '別の着想' }, deps);

  const script = gas.IssoVersions_create(store, { theme_id: theme.theme_id, stage: 'script', body: '台本' }, deps);
  const keep = gas.IssoVersions_create(store, { theme_id: other.theme_id, stage: 'script', body: '残る台本' }, deps);

  for (let i = 0; i < 2; i += 1) {
    store.insert(gas.ISSO_SHEET.SCENES, {
      scene_id: `scn_${i}`, version_id: script.version_id, order: i,
      narration: `ナレ${i}`, visual_prompt: `映像${i}`, subtitle: '',
    });
  }

  store.insert(gas.ISSO_SHEET.SCENES, {
    scene_id: 'scn_keep', version_id: keep.version_id, order: 0,
    narration: '残る', visual_prompt: '残る映像', subtitle: '',
  });

  gas.IssoThemes_remove(store, theme.theme_id);

  check('テーマが消える', gas.IssoThemes_get(store, theme.theme_id) === null);
  check('**ぶら下がる版も消える**',
    gas.IssoVersions_list(store, theme.theme_id, 'script').length === 0);
  check('**ぶら下がるシーンも消える**（Sheets に外部キー制約が無いため手で消す）',
    store.findBy(gas.ISSO_SHEET.SCENES, 'version_id', script.version_id).length === 0);

  check('別テーマの版は残る',
    gas.IssoVersions_list(store, other.theme_id, 'script').length === 1);
  check('別テーマのシーンも残る',
    store.findBy(gas.ISSO_SHEET.SCENES, 'version_id', keep.version_id).length === 1);
}

finish();

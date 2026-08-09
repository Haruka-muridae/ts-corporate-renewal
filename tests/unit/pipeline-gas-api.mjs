/*
 * Api.gs の検証（画面が呼ぶ処理）。
 *
 * ==================================================================
 * 画面そのものは検証していない
 * ==================================================================
 * `Index.html` / `Script.html` は google.script.run と HTML Service に
 * 依存するため、Node では動かせない。実機（手順書 §G の通し確認）で見る。
 *
 * ここで守るのは**画面が頼っている約束**である。
 *   - 返す値が google.script.run で渡せる形か（関数・Date を混ぜない）
 *   - タブの活性・状態表示に要る情報がそろっているか
 *   - 依頼 → 手で貼る → 取り込み → 採用 が1本で通るか
 * ==================================================================
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { check, section, finish } from '../../public/apps/tests/helpers/assert.mjs';
import { loadIssoGas, createIssoStore } from '../helpers/isso-gas-harness.mjs';

const gasDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'gas-isso');

function throws(fn) {
  try {
    fn();
    return null;
  } catch (error) {
    return error;
  }
}

function fixedDeps(prefix) {
  let n = 0;
  let t = 0;

  return {
    uuid: () => `${prefix}${(n += 1)}`,
    now: () => new Date(Date.UTC(2026, 7, 8, 0, 0, (t += 1))).toISOString(),
  };
}

/** google.script.run が渡せる形か。関数・Date・undefined を弾く。 */
function isTransferable(value, path, problems) {
  path = path || '$';
  problems = problems || [];

  if (value === null) {
    return problems;
  }

  const type = typeof value;

  if (type === 'function' || type === 'undefined' || type === 'symbol') {
    problems.push(`${path}: ${type}`);
    return problems;
  }

  if (value instanceof Date) {
    problems.push(`${path}: Date`);
    return problems;
  }

  if (Array.isArray(value)) {
    value.forEach((item, i) => isTransferable(item, `${path}[${i}]`, problems));
    return problems;
  }

  if (type === 'object') {
    Object.keys(value).forEach((key) => isTransferable(value[key], `${path}.${key}`, problems));
  }

  return problems;
}

const gas = loadIssoGas({ properties: { ISSO_SPREADSHEET_ID: 'sheet-abc' } });

/* ================================================================ */
section('起動');

{
  const { store } = createIssoStore(gas, {});
  const deps = fixedDeps('b');

  /* seed を空にしてあるので、シートは1枚も無い状態から始まる。 */
  const data = gas.IssoApi_bootstrap(store);

  check('**シートが無くても起動できる**（ensureSheets を通す）',
    Array.isArray(data.themes) && data.themes.length === 0);
  check('設定の既定値が入る', data.settings['threads.lengthHint'] === '50〜150字');
  check('段階の並びが入る', data.stages.length === 5);
  check('段階に表示名がある', data.stages[0].label === 'Threads');
  check('段階に案の数がある', data.stages[0].candidates === 3);

  check('**google.script.run で渡せる形**',
    isTransferable(data).length === 0, isTransferable(data).join(', '));

  /* 2回目も落ちないこと（画面を開き直すたびに通る） */
  gas.IssoApi_createTheme(store, { source_text: '着想' }, deps);
  const again = gas.IssoApi_bootstrap(store);

  check('再起動でデータが消えない', again.themes.length === 1);
}

/* ================================================================ */
section('ワークスペースの状態');

{
  const { store } = createIssoStore(gas);
  const deps = fixedDeps('w');
  const theme = gas.IssoApi_createTheme(store, { source_text: '着想メモ', title: '題名' }, deps);

  const ws = gas.IssoApi_workspace(store, theme.theme_id);

  check('テーマが入る', ws.theme.title === '題名');
  check('段階がそろう', ws.stages.length === 5);
  check('設定も一度に返る', typeof ws.settings === 'object');
  check('**google.script.run で渡せる形**',
    isTransferable(ws).length === 0, isTransferable(ws).join(', '));

  const threads = ws.stages[0];
  const x = ws.stages[1];

  check('最初の段階は生成できる', threads.canGenerate === true);
  check('**前段が未採用なら生成できない**（タブを押せなくする根拠）',
    x.canGenerate === false);
  check('版は空', threads.versions.length === 0);
  check('採用はまだ無い', threads.adoptedId === '');
  check('依頼もまだ無い', threads.request === null);

  check('無いテーマは落ちる',
    throws(() => gas.IssoApi_workspace(store, 'thm_none')) instanceof Error);
}

/* ================================================================ */
section('通し：依頼 → 手で貼る → 取り込み → 採用');

{
  const { store } = createIssoStore(gas);
  const deps = fixedDeps('f');
  const theme = gas.IssoApi_createTheme(store, { source_text: '着想メモ' }, deps);

  /* 1. 依頼 */
  const request = gas.IssoApi_requestGeneration(store, theme.theme_id, 'threads', deps);

  check('依頼できる', request.status === gas.ISSO_STATUS.QUEUE_WAITING);
  check('**プロンプトを返す**（手で Studio へ貼るため）',
    request.prompt.includes('着想メモ'));

  let ws = gas.IssoApi_workspace(store, theme.theme_id);

  check('依頼中が画面に出る', ws.stages[0].request.status === gas.ISSO_STATUS.QUEUE_WAITING);
  check('**プロンプトは一覧に含めない**（長いので往復を重くしない）',
    ws.stages[0].request.prompt === undefined);

  /* 2. まだ結果が無いうちに更新を押しても壊れない */
  const early = gas.IssoApi_refresh(store, request.request_id, deps);

  check('結果が無ければ取り込まない', early.ingested === false);
  check('いまの状態を返す', early.status === gas.ISSO_STATUS.QUEUE_WAITING);

  /* 3. 手で結果を貼る（Flow 抜き） */
  const submitted = gas.IssoApi_submitResult(
    store, request.request_id, '=== 案1 ===\nA\n=== 案2 ===\nB\n=== 案3 ===\nC', deps,
  );

  check('**貼ったらそのまま取り込まれる**', submitted.ingested === true);
  check('3案が作られる', submitted.created === 3, String(submitted.created));

  ws = gas.IssoApi_workspace(store, theme.theme_id);

  check('版が画面に出る', ws.stages[0].versions.length === 3);
  check('依頼は消える（取込済のため）', ws.stages[0].request === null);
  check('採用はまだ無い', ws.stages[0].adoptedId === '');

  /* 4. 採用 */
  const target = ws.stages[0].versions[0];

  gas.IssoApi_adopt(store, target.version_id);
  ws = gas.IssoApi_workspace(store, theme.theme_id);

  check('採用が反映される', ws.stages[0].adoptedId === target.version_id);
  check('**次の段階が開く**', ws.stages[1].canGenerate === true);

  /* 5. 手直し */
  gas.IssoApi_editBody(store, target.version_id, '手直しした本文');
  ws = gas.IssoApi_workspace(store, theme.theme_id);

  const edited = ws.stages[0].versions.filter((v) => v.version_id === target.version_id)[0];

  check('手直しが保存される', edited.body === '手直しした本文');
  check('**手直しの印が付く**（画面のチップになる）', edited.edited_by_user === true);
  check('採用は外れない', edited.adopted === true);
}

/* ================================================================ */
section('取り込みの失敗が画面に出る');

{
  const { store } = createIssoStore(gas);
  const deps = fixedDeps('x');
  const theme = gas.IssoApi_createTheme(store, { source_text: '着想' }, deps);

  /* note まで採用して台本を依頼する */
  ['threads', 'x', 'note'].forEach((stage) => {
    const v = gas.IssoVersions_create(
      store, { theme_id: theme.theme_id, stage, body: stage }, deps,
    );
    gas.IssoVersions_adopt(store, v.version_id);
  });

  const request = gas.IssoApi_requestGeneration(store, theme.theme_id, 'script', deps);

  const error = throws(() => gas.IssoApi_submitResult(
    store, request.request_id, '=== シーン1 ===\nナレーション: A\n映像: a', deps,
  ));

  check('**AC-09 を満たさなければ例外**（画面がそのまま出す）', error instanceof Error);

  const ws = gas.IssoApi_workspace(store, theme.theme_id);
  const script = ws.stages.filter((s) => s.id === 'script')[0];

  check('版は作られない', script.versions.length === 0);
  check('**依頼が残り、理由が画面に出る**',
    script.request === null || script.request.error !== '');

  /* 失敗した依頼は pending から外れ、再依頼できる */
  check('再依頼できる',
    throws(() => gas.IssoApi_requestGeneration(store, theme.theme_id, 'script', deps)) === null);
}

/* ================================================================ */
section('設定');

{
  const { store } = createIssoStore(gas);

  const saved = gas.IssoApi_saveSettings(store, { tone: 'ですます', 'note.lengthHint': '' });

  check('保存できる', saved.tone === 'ですます');
  check('**空にすると既定へ戻る**', saved['note.lengthHint'] === '1,500〜3,000字');
  check('渡していない値は変わらない', saved['threads.lengthHint'] === '50〜150字');
  check('google.script.run で渡せる形', isTransferable(saved).length === 0);
}

/* ================================================================ */
section('テーマの削除');

{
  const { store } = createIssoStore(gas);
  const deps = fixedDeps('d');
  const theme = gas.IssoApi_createTheme(store, { source_text: '着想' }, deps);

  gas.IssoVersions_create(store, { theme_id: theme.theme_id, stage: 'threads', body: 'A' }, deps);

  const remaining = gas.IssoApi_removeTheme(store, theme.theme_id);

  check('一覧が返る', Array.isArray(remaining) && remaining.length === 0);
  check('版も消える', gas.IssoVersions_list(store, theme.theme_id, 'threads').length === 0);
}

/* ================================================================ */
section('画面ファイルと include の対応');

{
  /*
   * `include('Style')` が参照する名前と実ファイルがそろっていること。
   * ここがずれると**実機で初めて白い画面になる**（Node では気づけない）。
   */
  const index = readFileSync(resolve(gasDir, 'Index.html'), 'utf8');
  const referenced = [...index.matchAll(/include\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]);

  check('include を使っている', referenced.length >= 2, referenced.join(','));

  for (const name of referenced) {
    check(`include('${name}') に対応する ${name}.html がある`,
      existsSync(resolve(gasDir, `${name}.html`)));
  }

  /* doGet が読むテンプレート名も実在すること。 */
  const main = readFileSync(resolve(gasDir, 'Main.gs'), 'utf8');
  const template = main.match(/createTemplateFromFile\(\s*'([^']+)'\s*\)/);

  check('doGet がテンプレートを指定している', template !== null);
  check('そのテンプレートが実在する',
    template !== null && existsSync(resolve(gasDir, `${template[1]}.html`)),
    template ? template[1] : '');

  /*
   * 画面が呼ぶ入口が Main.gs にそろっていること。
   * Script.html の call('issoXxx', …) と突き合わせる。
   */
  const script = readFileSync(resolve(gasDir, 'Script.html'), 'utf8');
  const called = [...new Set(
    [...script.matchAll(/call\(\s*'(isso[A-Za-z]+)'/g)].map((m) => m[1]),
  )];

  check('画面がサーバーを呼んでいる', called.length >= 5, called.join(','));

  for (const name of called) {
    check(`Main.gs に ${name}() がある`,
      new RegExp(`function\\s+${name}\\s*\\(`).test(main));
  }
}

finish();

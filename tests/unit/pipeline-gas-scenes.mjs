/*
 * Scenes.gs の検証（FR-043 / AC-09）。
 *
 * ==================================================================
 * ここが AC-09 の置き場
 * ==================================================================
 * 「note記事からYouTube台本を生成でき、台本が**複数の**シーンに分割され、
 *   **各シーンがナレーションと映像指示を持つ**」
 *
 * 検証は当初 Generation.gs にあったが、手直し（Api.gs）でも同じ規則が
 * 要るため Scenes.gs へ移した。テストも一緒に移してある。
 *
 * ==================================================================
 * body と scenes の関係も、ここで固定する
 * ==================================================================
 * `versions.body` が原本で、`scenes` はそこから読み取った構造。
 * **本文を手直ししたらシーンも読み直される**——これが崩れると、
 * 画面のシーン一覧と本文が食い違う。
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

function fixedDeps(prefix) {
  let n = 0;
  let t = 0;

  return {
    uuid: () => `${prefix}${(n += 1)}`,
    now: () => new Date(Date.UTC(2026, 7, 9, 0, 0, (t += 1))).toISOString(),
  };
}

const gas = loadIssoGas({ properties: { ISSO_SPREADSHEET_ID: 'sheet-abc' } });

const SCRIPT_TEXT = [
  '=== シーン1 ===',
  'ナレーション: はじめに',
  '映像: 机の上',
  '=== シーン2 ===',
  'ナレーション: つぎに',
  '映像: 窓の外',
].join('\n');

/** 台本の版を1つ持つテーマを用意する。 */
function themeWithScript(deps, body) {
  const { store } = createIssoStore(gas);
  const theme = gas.IssoThemes_create(store, { source_text: '着想' }, deps);

  ['threads', 'x', 'note'].forEach((stage) => {
    const v = gas.IssoVersions_create(
      store, { theme_id: theme.theme_id, stage, body: stage }, deps,
    );
    gas.IssoVersions_adopt(store, v.version_id);
  });

  const version = gas.IssoVersions_create(
    store,
    { theme_id: theme.theme_id, stage: 'script', body: body === undefined ? SCRIPT_TEXT : body },
    deps,
  );

  return { store, theme, version };
}

/* ================================================================ */
section('AC-09 の検証');

check('2件そろえば合格', gas.IssoScenes_validate([
  { narration: 'A', visual_prompt: 'a' },
  { narration: 'B', visual_prompt: 'b' },
]).ok === true);

check('0件は不合格', gas.IssoScenes_validate([]).ok === false);
check('null も不合格', gas.IssoScenes_validate(null).ok === false);

check('**1件は不合格**（「複数」を満たさない）',
  gas.IssoScenes_validate([{ narration: 'A', visual_prompt: 'a' }]).ok === false);

check('下限は定数で持つ', gas.ISSO_MIN_SCENES === 2);

{
  const noNarration = gas.IssoScenes_validate([
    { narration: '', visual_prompt: 'a' },
    { narration: 'B', visual_prompt: 'b' },
  ]);

  check('ナレーションが空なら不合格', noNarration.ok === false);
  check('何番目かを理由に含める', noNarration.reason.includes('1番目'), noNarration.reason);
}

{
  const noVisual = gas.IssoScenes_validate([
    { narration: 'A', visual_prompt: 'a' },
    { narration: 'B', visual_prompt: '   ' },
  ]);

  check('映像指示が空なら不合格', noVisual.ok === false);
  check('何番目かを理由に含める', noVisual.reason.includes('2番目'), noVisual.reason);
}

check('**全角空白だけも空とみなす**', gas.IssoScenes_validate([
  { narration: '　　', visual_prompt: 'a' },
  { narration: 'B', visual_prompt: 'b' },
]).ok === false);

check('合格のときは理由が空', gas.IssoScenes_validate([
  { narration: 'A', visual_prompt: 'a' },
  { narration: 'B', visual_prompt: 'b' },
]).reason === '');

/* ================================================================ */
section('保存と読み出し');

{
  const deps = fixedDeps('s');
  const { store, version } = themeWithScript(deps);

  const rows = gas.IssoScenes_replace(store, version.version_id, [
    { narration: 'A', visual_prompt: 'a', subtitle: '字幕A' },
    { narration: 'B', visual_prompt: 'b' },
  ], deps);

  check('2件保存される', rows.length === 2);
  check('ID が振られる', rows[0].scene_id.indexOf('scn_') === 0, rows[0].scene_id);
  check('版に結び付く', rows[0].version_id === version.version_id);
  check('字幕は省略できる', rows[1].subtitle === '');

  const listed = gas.IssoScenes_list(store, version.version_id);

  check('読み出せる', listed.length === 2);
  check('order 順に返る', listed[0].order === 0 && listed[1].order === 1);
  check('中身が保たれる', listed[0].narration === 'A' && listed[1].visual_prompt === 'b');
  check('order が数値で返る', typeof listed[0].order === 'number');
}

{
  /*
   * モデルが「シーン1・シーン3・シーン2」のように番号を振ってきても、
   * **並びは渡された順で振り直す。**
   */
  const deps = fixedDeps('o');
  const { store, version } = themeWithScript(deps);

  const rows = gas.IssoScenes_replace(store, version.version_id, [
    { narration: 'A', visual_prompt: 'a', order: 7 },
    { narration: 'B', visual_prompt: 'b', order: 3 },
  ], deps);

  check('**モデルの申告する番号を使わない**', rows[0].order === 0 && rows[1].order === 1);
}

{
  const deps = fixedDeps('r');
  const { store, version } = themeWithScript(deps);

  gas.IssoScenes_replace(store, version.version_id, [
    { narration: 'A', visual_prompt: 'a' },
    { narration: 'B', visual_prompt: 'b' },
    { narration: 'C', visual_prompt: 'c' },
  ], deps);

  gas.IssoScenes_replace(store, version.version_id, [
    { narration: 'X', visual_prompt: 'x' },
    { narration: 'Y', visual_prompt: 'y' },
  ], deps);

  const listed = gas.IssoScenes_list(store, version.version_id);

  check('**入れ替えなので古いシーンが残らない**', listed.length === 2, String(listed.length));
  check('新しい中身になる', listed[0].narration === 'X');
}

{
  const deps = fixedDeps('v');
  const { store, version } = themeWithScript(deps);

  const error = throws(() => gas.IssoScenes_replace(store, version.version_id, [
    { narration: 'A', visual_prompt: '' },
    { narration: 'B', visual_prompt: 'b' },
  ], deps));

  check('**検証を通らないものは保存しない**', error instanceof Error);
  check('1件も入っていない', gas.IssoScenes_list(store, version.version_id).length === 0);
}

{
  const deps = fixedDeps('d');
  const { store, version } = themeWithScript(deps);

  gas.IssoScenes_replace(store, version.version_id, [
    { narration: 'A', visual_prompt: 'a' },
    { narration: 'B', visual_prompt: 'b' },
  ], deps);

  gas.IssoScenes_remove(store, version.version_id);

  check('消せる', gas.IssoScenes_list(store, version.version_id).length === 0);
}

{
  /* 別の版のシーンを巻き込まないこと。 */
  const deps = fixedDeps('i');
  const { store, theme, version } = themeWithScript(deps);
  const other = gas.IssoVersions_create(
    store, { theme_id: theme.theme_id, stage: 'script', body: SCRIPT_TEXT }, deps,
  );

  gas.IssoScenes_replace(store, version.version_id, [
    { narration: 'A', visual_prompt: 'a' },
    { narration: 'B', visual_prompt: 'b' },
  ], deps);

  gas.IssoScenes_replace(store, other.version_id, [
    { narration: 'X', visual_prompt: 'x' },
    { narration: 'Y', visual_prompt: 'y' },
  ], deps);

  gas.IssoScenes_remove(store, other.version_id);

  check('**版ごとに独立している**', gas.IssoScenes_list(store, version.version_id).length === 2);
}

/* ================================================================ */
section('本文から読み直す');

{
  const parsed = gas.IssoScenes_fromBody(SCRIPT_TEXT);

  check('読める', parsed.ok === true);
  check('シーンを返す', parsed.scenes.length === 2);
  check('中身が取れる', parsed.scenes[0].narration === 'はじめに');
  check('理由は空', parsed.reason === '');
}

{
  const parsed = gas.IssoScenes_fromBody('=== シーン1 ===\nナレーション: A\n映像: a');

  check('1件なら読めない', parsed.ok === false);
  check('**直し方まで理由に含める**',
    parsed.reason.includes('ナレーション:') && parsed.reason.includes('映像:'),
    parsed.reason);
  check('区切り記号は定義から取る',
    parsed.reason.includes(gas.ISSO_PROMPT_DELIMITER.SCENE), parsed.reason);
}

check('区切りを壊すと読めない',
  gas.IssoScenes_fromBody('ただの文章です。').ok === false);

/* ================================================================ */
section('取り込みでシーンが保存される');

{
  const deps = fixedDeps('g');
  const { store } = createIssoStore(gas);
  const theme = gas.IssoThemes_create(store, { source_text: '着想' }, deps);

  ['threads', 'x', 'note'].forEach((stage) => {
    const v = gas.IssoVersions_create(
      store, { theme_id: theme.theme_id, stage, body: stage }, deps,
    );
    gas.IssoVersions_adopt(store, v.version_id);
  });

  const request = gas.IssoGeneration_request(store, theme.theme_id, 'script', deps);

  gas.IssoGeneration_complete(store, request.request_id, SCRIPT_TEXT, deps);

  const result = gas.IssoGeneration_ingest(store, request.request_id, deps);

  check('版ができる', result.versions.length === 1);
  check('**シーンが保存される**',
    gas.IssoScenes_list(store, result.versions[0].version_id).length === 2);
  check('返り値も保存後のシーン', result.scenes[0].scene_id !== undefined);
}

{
  /* 台本以外の段階ではシーンを作らない。 */
  const deps = fixedDeps('n');
  const { store } = createIssoStore(gas);
  const theme = gas.IssoThemes_create(store, { source_text: '着想' }, deps);
  const request = gas.IssoGeneration_request(store, theme.theme_id, 'threads', deps);

  gas.IssoGeneration_complete(store, request.request_id, '=== 案1 ===\nA\n=== 案2 ===\nB', deps);

  const result = gas.IssoGeneration_ingest(store, request.request_id, deps);

  check('**threads はシーンを持たない**', result.scenes.length === 0);
  check('シート上にも無い',
    store.getAll(gas.ISSO_SHEET.SCENES).length === 0);
}

/* ================================================================ */
section('本文の手直しでシーンが追随する');

{
  const deps = fixedDeps('e');
  const { store, version } = themeWithScript(deps);

  gas.IssoScenes_replace(store, version.version_id, [
    { narration: 'はじめに', visual_prompt: '机の上' },
    { narration: 'つぎに', visual_prompt: '窓の外' },
  ], deps);

  const next = [
    '=== シーン1 ===',
    'ナレーション: 書き直した導入',
    '映像: 朝の景色',
    '=== シーン2 ===',
    'ナレーション: つぎに',
    '映像: 窓の外',
    '=== シーン3 ===',
    'ナレーション: まとめ',
    '映像: 手元',
  ].join('\n');

  gas.IssoApi_editBody(store, version.version_id, next, deps);

  const listed = gas.IssoScenes_list(store, version.version_id);

  check('**シーンも読み直される**', listed.length === 3, String(listed.length));
  check('直した中身が反映される', listed[0].narration === '書き直した導入');
  check('足したシーンも入る', listed[2].narration === 'まとめ');

  const saved = store.findById(gas.ISSO_SHEET.VERSIONS, version.version_id);

  check('本文も保存される', saved.body === next);
  check('手直しの印が付く', saved.edited_by_user === true);
}

{
  const deps = fixedDeps('b');
  const { store, version } = themeWithScript(deps);

  gas.IssoScenes_replace(store, version.version_id, [
    { narration: 'はじめに', visual_prompt: '机の上' },
    { narration: 'つぎに', visual_prompt: '窓の外' },
  ], deps);

  const error = throws(() => gas.IssoApi_editBody(store, version.version_id, 'ただの文章', deps));

  check('**読み直せない手直しは受け付けない**', error instanceof Error);
  check('直し方が分かる', String(error.message).includes('ナレーション:'), String(error?.message));

  const saved = store.findById(gas.ISSO_SHEET.VERSIONS, version.version_id);

  check('**本文も元のまま**（AC-09 を満たさない台本を残さない）',
    saved.body === SCRIPT_TEXT);
  check('シーンも元のまま',
    gas.IssoScenes_list(store, version.version_id).length === 2);
  check('手直しの印も付かない', saved.edited_by_user === false);
}

{
  /* 台本以外は今までどおり、何を書いても保存できる。 */
  const deps = fixedDeps('t');
  const { store, theme } = themeWithScript(deps);
  const threads = gas.IssoVersions_list(store, theme.theme_id, 'threads')[0];

  gas.IssoApi_editBody(store, threads.version_id, 'ただの文章', deps);

  check('**threads は構造を問われない**',
    store.findById(gas.ISSO_SHEET.VERSIONS, threads.version_id).body === 'ただの文章');
}

check('無い版は落ちる',
  throws(() => {
    const { store } = createIssoStore(gas);
    gas.IssoApi_editBody(store, 'ver_none', 'x');
  }) instanceof Error);

/* ================================================================ */
section('画面へ渡す形');

{
  const deps = fixedDeps('w');
  const { store, theme, version } = themeWithScript(deps);

  gas.IssoScenes_replace(store, version.version_id, [
    { narration: 'A', visual_prompt: 'a' },
    { narration: 'B', visual_prompt: 'b' },
  ], deps);

  const ws = gas.IssoApi_workspace(store, theme.theme_id);
  const script = ws.stages.filter((s) => s.id === 'script')[0];
  const threads = ws.stages.filter((s) => s.id === 'threads')[0];

  check('**台本の版にシーンが添う**', script.versions[0].scenes.length === 2);
  check('順序も保たれる', script.versions[0].scenes[0].narration === 'A');
  check('**他の段階には付けない**（画面の判定を鈍らせない）',
    threads.versions[0].scenes === undefined);
}

/* ================================================================ */
section('テーマを消すとシーンも消える');

{
  const deps = fixedDeps('c');
  const { store, theme, version } = themeWithScript(deps);

  gas.IssoScenes_replace(store, version.version_id, [
    { narration: 'A', visual_prompt: 'a' },
    { narration: 'B', visual_prompt: 'b' },
  ], deps);

  gas.IssoThemes_remove(store, theme.theme_id);

  check('**シーンが残らない**（Sheets に外部キー制約は無い）',
    store.getAll(gas.ISSO_SHEET.SCENES).length === 0);
}

finish();

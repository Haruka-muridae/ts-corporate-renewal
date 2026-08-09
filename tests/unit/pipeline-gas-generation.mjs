/*
 * Generation.gs / Settings.gs の検証。
 *
 * ==================================================================
 * ここで守っているもの
 * ==================================================================
 *   - 依頼が二重に並ばないこと
 *   - **同じ結果から版が二重に作られないこと**（更新を2回押しても平気）
 *   - **AC-09 を満たさない台本を取り込まないこと**
 *   - responseSchema が使えない前提での解析の頑健さ
 *     （コードフェンス・区切りの欠落・折り返し）
 *   - 目安が空でも既定へ戻り、プロンプトの指示行が落ちないこと
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
    now: () => new Date(Date.UTC(2026, 7, 8, 0, 0, (t += 1))).toISOString(),
  };
}

const gas = loadIssoGas({ properties: { ISSO_SPREADSHEET_ID: 'sheet-abc' } });

/** threads を採用済みにしたテーマを用意する。 */
function themeWithThreads(deps) {
  const { store } = createIssoStore(gas);
  const theme = gas.IssoThemes_create(store, { source_text: '着想メモ' }, deps);
  const v = gas.IssoVersions_create(
    store, { theme_id: theme.theme_id, stage: 'threads', body: '採用案' }, deps,
  );

  gas.IssoVersions_adopt(store, v.version_id);

  return { store, theme, threads: v };
}

/* ================================================================ */
section('設定');

{
  const { store } = createIssoStore(gas);

  check('既定値を返す', gas.IssoSettings_get(store, 'threads.lengthHint') === '50〜150字');
  check('未知のキーは空文字', gas.IssoSettings_get(store, 'nope') === '');

  gas.IssoSettings_set(store, 'tone', 'ですます');
  check('保存した値が優先される', gas.IssoSettings_get(store, 'tone') === 'ですます');

  gas.IssoSettings_set(store, 'tone', 'である');
  check('上書きできる（行が増えない）',
    store.getAll(gas.ISSO_SHEET.SETTINGS).length === 1);
  check('上書きが効く', gas.IssoSettings_get(store, 'tone') === 'である');

  gas.IssoSettings_set(store, 'threads.lengthHint', '   ');
  check('**空白だけなら既定へ戻る**（プロンプトの指示行を落とさない）',
    gas.IssoSettings_get(store, 'threads.lengthHint') === '50〜150字');

  check('段階から目安を引ける',
    gas.IssoSettings_lengthFor(store, 'note') === '1,500〜3,000字');
  check('未定義の段階は空', gas.IssoSettings_lengthFor(store, 'nope') === '');

  const all = gas.IssoSettings_all(store);
  check('既定に保存済みが重なる',
    all.tone === 'である' && all['x.lengthHint'] === '150〜300字');
}

/* ================================================================ */
section('コードフェンスの除去');

check('前後の ``` を外す',
  gas.IssoGeneration_stripFences('```\n本文\n```') === '本文');
check('言語つきでも外す',
  gas.IssoGeneration_stripFences('```markdown\n本文\n```') === '本文');
check('無ければそのまま', gas.IssoGeneration_stripFences('本文') === '本文');
check('途中の ``` は残す（本文の一部かもしれない）',
  gas.IssoGeneration_stripFences('前\n```\n後').includes('```'));

/* ================================================================ */
section('複数案の解析');

{
  const parsed = gas.IssoGeneration_parseCandidates(
    '=== 案1 ===\n一つ目\n=== 案2 ===\n二つ目\n=== 案3 ===\n三つ目',
  );

  check('3案に分かれる', parsed.length === 3, String(parsed.length));
  check('本文だけになる', parsed[0] === '一つ目');
  check('区切り行は捨てる', !parsed.join('').includes('==='));

  check('**区切りが無ければ全体を1案として扱う**（形式を無視されたとき）',
    gas.IssoGeneration_parseCandidates('区切りなしの本文').length === 1);
  check('空は0件', gas.IssoGeneration_parseCandidates('   ').length === 0);
  check('コードフェンスごしでも読める',
    gas.IssoGeneration_parseCandidates('```\n=== 案1 ===\nA\n=== 案2 ===\nB\n```').length === 2);
  check('空のブロックは落とす',
    gas.IssoGeneration_parseCandidates('=== 案1 ===\n\n=== 案2 ===\nB').length === 1);
}

/* ================================================================ */
section('note の解析（タイトル候補を捨てない）');

{
  const parsed = gas.IssoGeneration_parseNote(
    '=== タイトル候補 ===\n1. 題名A\n2. 題名B\n題名C\n=== 本文 ===\n## 見出し\n本文です。',
  );

  check('タイトル候補を取れる', parsed.titles.length === 3, String(parsed.titles.length));
  check('**番号を落とす**', parsed.titles[0] === '題名A', parsed.titles[0]);
  check('番号なしも取れる', parsed.titles[2] === '題名C');
  check('本文が取れる', parsed.body.startsWith('## 見出し'));
  check('本文にタイトル候補が混ざらない', !parsed.body.includes('題名A'));
  check('区切りを認識した', parsed.structured === true);

  const plain = gas.IssoGeneration_parseNote('区切りのない本文');

  check('区切りが無ければ全体を本文にする', plain.body === '区切りのない本文');
  check('タイトル候補は空', plain.titles.length === 0);
  check('**形式を無視されたことが分かる**', plain.structured === false);
}

/* ================================================================ */
section('台本の解析');

{
  const scenes = gas.IssoGeneration_parseScenes(
    '=== シーン1 ===\nナレーション: こんにちは\n映像: 手元の資料\n'
    + '=== シーン2 ===\nナレーション: 続きです\n映像: street の風景',
  );

  check('2シーンに分かれる', scenes.length === 2, String(scenes.length));
  check('順序が振られる', scenes[0].order === 0 && scenes[1].order === 1);
  check('ナレーションを取れる', scenes[0].narration === 'こんにちは');
  check('映像指示を取れる', scenes[0].visual_prompt === '手元の資料');

  const wrapped = gas.IssoGeneration_parseScenes(
    '=== シーン1 ===\nナレーション: 1行目\n2行目も続き\n映像: 映像です\n'
    + '=== シーン2 ===\nナレーション: A\n映像: B',
  );

  check('**折り返した行は直前のラベルの続きにする**',
    wrapped[0].narration === '1行目\n2行目も続き', JSON.stringify(wrapped[0].narration));
  check('折り返しても映像指示は分かれる', wrapped[0].visual_prompt === '映像です');
}

/*
 * AC-09 の検証（IssoScenes_validate）は pipeline-gas-scenes.mjs にある。
 * 規則を Scenes.gs へ移したので、テストも一緒に移した。
 */

/* ================================================================ */
section('依頼');

{
  const deps = fixedDeps('r');
  const { store, theme } = themeWithThreads(deps);

  const request = gas.IssoGeneration_request(store, theme.theme_id, 'x', deps);

  check('依頼できる', request.status === gas.ISSO_STATUS.QUEUE_WAITING);
  check('**完全なプロンプトが入る**', request.prompt.includes('着想メモ'));
  check('上流の採用文が入る', request.prompt.includes('採用案'));
  check('段階の指示が入る', request.prompt.includes('# 今回の段階: X'));
  check('結果は空', request.result === '');

  check('**二重に依頼できない**',
    throws(() => gas.IssoGeneration_request(store, theme.theme_id, 'x', deps)) instanceof Error);

  check('**上流が未採用なら依頼できない**',
    throws(() => gas.IssoGeneration_request(store, theme.theme_id, 'note', deps)) instanceof Error);
  check('未定義の段階は依頼できない',
    throws(() => gas.IssoGeneration_request(store, theme.theme_id, 'nope', deps)) instanceof Error);
  check('無いテーマは依頼できない',
    throws(() => gas.IssoGeneration_request(store, 'thm_none', 'x', deps)) instanceof Error);

  check('待機一覧に出る', gas.IssoGeneration_listWaiting(store).length === 1);
}

/* ================================================================ */
section('取り込み（threads は複数案）');

{
  const deps = fixedDeps('i');
  const { store } = createIssoStore(gas);
  const theme = gas.IssoThemes_create(store, { source_text: '着想メモ' }, deps);

  const request = gas.IssoGeneration_request(store, theme.theme_id, 'threads', deps);

  check('取り込みは完了前にはできない',
    throws(() => gas.IssoGeneration_ingest(store, request.request_id, deps)) instanceof Error);

  gas.IssoGeneration_complete(
    store, request.request_id, '=== 案1 ===\nA\n=== 案2 ===\nB\n=== 案3 ===\nC', deps,
  );

  const result = gas.IssoGeneration_ingest(store, request.request_id, deps);

  check('**3案が3つの版になる**', result.versions.length === 3, String(result.versions.length));
  check('版がシートに入る',
    gas.IssoVersions_list(store, theme.theme_id, 'threads').length === 3);
  check('本文が入る', result.versions[0].body === 'A');
  check('版番号が振られる', result.versions[2].version_no === 3);

  check('依頼が取込済になる',
    store.findById(gas.ISSO_SHEET.QUEUE, request.request_id).status
    === gas.ISSO_STATUS.QUEUE_INGESTED);

  check('**二重に取り込めない**（更新を2回押しても版が増えない）',
    throws(() => gas.IssoGeneration_ingest(store, request.request_id, deps)) instanceof Error);
  check('版が増えていない',
    gas.IssoVersions_list(store, theme.theme_id, 'threads').length === 3);

  /* 取込済になったので、同じ段階を再依頼できる */
  check('取込済なら再依頼できる',
    throws(() => gas.IssoGeneration_request(store, theme.theme_id, 'threads', deps)) === null);
}

/* ================================================================ */
section('取り込み（単一出力）');

{
  const deps = fixedDeps('s');
  const { store, theme, threads } = themeWithThreads(deps);

  const request = gas.IssoGeneration_request(store, theme.theme_id, 'x', deps);
  gas.IssoGeneration_complete(store, request.request_id, 'X の本文です。', deps);

  const result = gas.IssoGeneration_ingest(store, request.request_id, deps);

  check('1つの版になる', result.versions.length === 1);
  check('本文が入る', result.versions[0].body === 'X の本文です。');
  check('**派生元が入る**（要件10章）', result.versions[0].parent_version_id === threads.version_id);
  check('シーンは空', result.scenes.length === 0);
}

/* ================================================================ */
section('取り込み（台本・AC-09）');

{
  const deps = fixedDeps('c');
  const { store, theme } = themeWithThreads(deps);

  /* note まで採用してから台本を依頼する */
  const x = gas.IssoVersions_create(store, { theme_id: theme.theme_id, stage: 'x', body: 'X' }, deps);
  gas.IssoVersions_adopt(store, x.version_id);
  const n = gas.IssoVersions_create(store, { theme_id: theme.theme_id, stage: 'note', body: 'N' }, deps);
  gas.IssoVersions_adopt(store, n.version_id);

  const bad = gas.IssoGeneration_request(store, theme.theme_id, 'script', deps);
  gas.IssoGeneration_complete(
    store, bad.request_id, '=== シーン1 ===\nナレーション: A\n映像: a', deps,
  );

  const error = throws(() => gas.IssoGeneration_ingest(store, bad.request_id, deps));

  check('**AC-09 を満たさない台本は取り込まない**', error instanceof Error);
  check('理由が分かる', String(error.message).includes('2件以上'), String(error?.message));
  check('版が作られていない',
    gas.IssoVersions_list(store, theme.theme_id, 'script').length === 0);

  const failed = store.findById(gas.ISSO_SHEET.QUEUE, bad.request_id);

  check('依頼が失敗になる', failed.status === gas.ISSO_STATUS.QUEUE_FAILED);
  check('理由が記録される', failed.error.includes('2件以上'));
  check('**結果は消さない**（あとで原因を追える）', failed.result !== '');

  /* 失敗したので再依頼できる */
  const good = gas.IssoGeneration_request(store, theme.theme_id, 'script', deps);
  gas.IssoGeneration_complete(
    store, good.request_id,
    '=== シーン1 ===\nナレーション: A\n映像: a\n=== シーン2 ===\nナレーション: B\n映像: b',
    deps,
  );

  const result = gas.IssoGeneration_ingest(store, good.request_id, deps);

  check('満たせば取り込める', result.versions.length === 1);
  check('**シーンも保存される**', result.scenes.length === 2);
  check('シーンの中身', result.scenes[0].narration === 'A' && result.scenes[1].visual_prompt === 'b');
  check('版の本文は台本そのもの', result.versions[0].body.includes('=== シーン1 ==='));

  const saved = gas.IssoScenes_list(store, result.versions[0].version_id);

  check('**シートから読み直しても残っている**', saved.length === 2);
  check('版に結び付いている', saved[0].version_id === result.versions[0].version_id);
}

/* ================================================================ */
section('結果が空のとき');

{
  const deps = fixedDeps('e');
  const { store, theme } = themeWithThreads(deps);

  const request = gas.IssoGeneration_request(store, theme.theme_id, 'x', deps);
  gas.IssoGeneration_complete(store, request.request_id, '   ', deps);

  check('空の結果は取り込まない',
    throws(() => gas.IssoGeneration_ingest(store, request.request_id, deps)) instanceof Error);
  check('依頼が失敗になる',
    store.findById(gas.ISSO_SHEET.QUEUE, request.request_id).status
    === gas.ISSO_STATUS.QUEUE_FAILED);
  check('版は作られない', gas.IssoVersions_list(store, theme.theme_id, 'x').length === 0);
}

finish();

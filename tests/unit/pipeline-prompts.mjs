/*
 * 段階別プロンプト（単一ソース）のテスト。
 *
 * ==================================================================
 * このスイートが守っているもの
 * ==================================================================
 * 1. 定義そのもの（段階の並び・FR-033 の常時付与・AC-09 の指示）
 * 2. 組み立ての規則（空の差し込み口で行と見出しが落ちる、など）
 * 3. **生成された GAS 版が Node 版と同じ出力になること**
 * 4. **生成物が最新であること**（definitions.mjs を直したのに
 *    作り直し忘れると落ちる）
 *
 * 3 が要になる。GAS 側の組み立てを手で書くと Node 側とずれ、
 * 「テストは通るのに実機のプロンプトが違う」という追いにくい壊れ方をする。
 * ここで**実際に GAS のコードを評価して突き合わせる。**
 * ==================================================================
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  COMMON_RULES, DELIMITER, PLACEHOLDER, STAGES, STAGE_IDS, findStage,
} from '../../lib/pipeline/prompts/definitions.mjs';
import {
  buildTemplate, render, formatUpstream, buildPrompt,
} from '../../lib/pipeline/prompts/render.mjs';
import { buildFlowText, buildAllFlowTexts } from '../../lib/pipeline/prompts/flow-text.mjs';
import { buildGasSource } from '../../lib/pipeline/prompts/gas-source.mjs';
import { diff } from '../../lib/pipeline/prompts/build.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

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

function throws(fn) {
  try {
    fn();
    return null;
  } catch (error) {
    return error;
  }
}

/* ================================================================
 * 1. 定義
 * ================================================================ */
section('定義');
{
  check('段階は5つ', STAGES.length === 5, String(STAGES.length));
  check('並びが要件どおり',
    STAGE_IDS.join(',') === 'threads,x,note,script,metadata', STAGE_IDS.join(','));

  check('FR-033（捏造禁止）が共通ルールにある',
    COMMON_RULES.includes('入力に無い数字・固有名詞・具体エピソードを決して創作しない'));
  check('要件15章（ユーザー編集の優先）が共通ルールにある',
    COMMON_RULES.includes('利用者が編集した表現をAI原案より優先'));

  check('threads は3案（FR-013）', findStage('threads').candidates === 3);
  check('他の段階は単一出力',
    STAGES.filter((s) => s.id !== 'threads').every((s) => s.candidates === 1));

  check('threads に前段は無い', findStage('threads').upstreamStages.length === 0);
  check('x の前段は threads', findStage('x').upstreamStages.join(',') === 'threads');
  check('note の前段は threads,x', findStage('note').upstreamStages.join(',') === 'threads,x');
  check('script の前段は note', findStage('script').upstreamStages.join(',') === 'note');

  check('未定義の段階は null', findStage('nope') === null);

  /* 目安が空だと出力形式の指示行ごと落ちるため、既定値を持つこと。 */
  const usesLength = STAGES.filter((s) =>
    s.outputSpec.some((line) => line.includes(PLACEHOLDER.LENGTH)));
  check('目安を使う段階には既定値がある',
    usesLength.every((s) => s.defaultLength !== ''),
    usesLength.filter((s) => s.defaultLength === '').map((s) => s.id).join(','));
}

/* ================================================================
 * 2. AC-09（台本のシーン構造）
 * ================================================================ */
section('AC-09（シーン構造の指示）');
{
  const script = findStage('script');
  const all = [...script.instructions, ...script.outputSpec].join('\n');

  check('ナレーションの指示がある', all.includes(DELIMITER.NARRATION));
  check('映像指示の指示がある', all.includes(DELIMITER.VISUAL));
  check('シーン区切りの指示がある', all.includes(DELIMITER.SCENE));
  check('2つ以上を明示している', all.includes('2つ以上'));
  check('どちらも空にしないと明示している', all.includes('空にしない'));

  /*
   * 区切り記号は解析側（GAS）と共有する。プロンプト側にだけ現れて
   * 定義に無い、という状態を作らない。
   */
  check('区切り記号が定義から来ている',
    script.outputSpec.some((line) => line.includes(DELIMITER.NARRATION))
    && script.outputSpec.some((line) => line.includes(DELIMITER.VISUAL)));
}

/* ================================================================
 * 3. 組み立て
 * ================================================================ */
section('組み立て');
{
  const template = buildTemplate('threads');

  check('共通ルールが先頭にある', template.startsWith(COMMON_RULES));
  check('差し込み口が残っている', template.includes(PLACEHOLDER.SOURCE));
  check('前段の無い段階に前段の見出しが出ない',
    !template.includes('前段までの採用文'));
  check('前段のある段階には前段の見出しが出る',
    buildTemplate('note').includes('前段までの採用文'));

  check('未定義の段階は例外', throws(() => buildTemplate('nope')) instanceof Error);

  /* 空の差し込み口は行ごと落ち、直前の見出しも落ちる。 */
  const rendered = render('## 口調\n{{口調}}\n\n## 着想\n{{着想}}', {
    TONE: '', SOURCE: '着想メモ',
  });
  check('空の差し込み口は行ごと落ちる', !rendered.includes(PLACEHOLDER.TONE));
  check('中身の無い見出しも落ちる', !rendered.includes('## 口調'), rendered);
  check('中身のある見出しは残る', rendered.includes('## 着想'));
  check('値が入る', rendered.includes('着想メモ'));

  check('空行が3行以上続かない',
    !render('a\n\n\n\n\nb', {}).includes('\n\n\n'));
}

/* ================================================================
 * 4. 前段の整形（要件15章）
 * ================================================================ */
section('前段の整形');
{
  check('空なら空文字', formatUpstream([]) === '');
  check('配列でなくても落ちない', formatUpstream(null) === '');

  const text = formatUpstream([
    { stage: 'threads', label: 'Threads', body: '案A', editedByUser: true },
    { stage: 'x', label: 'X', body: 'X案' },
  ]);

  check('段階ごとに見出しが付く', text.includes('### Threads') && text.includes('### X'));
  check('本文が入る', text.includes('案A') && text.includes('X案'));
  check('**手直し版はその旨が付く**（要件15章）',
    text.includes('利用者が手直しした版'));
  check('手直しでない版には付かない',
    text.split('### X')[1].includes('利用者が手直しした版') === false);
}

/* ================================================================
 * 5. buildPrompt の穴（実装中に見つけた2件）
 * ================================================================ */
section('buildPrompt の防御');
{
  const ok = buildPrompt('threads', { source: '着想メモ' });
  check('組み立てられる', ok.includes('着想メモ'));
  check('既定の目安が入る', ok.includes(findStage('threads').defaultLength));

  const empty = throws(() => buildPrompt('threads', { source: '   ' }));
  check('**着想が空なら例外**（何も指示していないプロンプトを作らない）',
    empty instanceof Error, String(empty));

  /*
   * 目安が空文字で渡ると、差し込み口が行の途中にあるため
   * **出力形式の指示行ごと落ちる。** 既定値へ戻ることを固定する。
   */
  const blankLength = buildPrompt('threads', { source: '着想', length: '  ' });
  check('**目安が空なら既定値へ戻る**（指示行を落とさない）',
    blankLength.includes(findStage('threads').defaultLength), blankLength);
  check('案を3つ書く指示が残っている', blankLength.includes('案を3つ書く'));

  const withTone = buildPrompt('threads', { source: '着想', tone: 'ですます' });
  check('口調を指定すると入る', withTone.includes('ですます'));
  check('口調を指定しなければ見出しごと消える',
    !buildPrompt('threads', { source: '着想' }).includes('## 口調'));

  const withUpstream = buildPrompt('note', {
    source: '着想',
    upstream: [{ stage: 'threads', label: 'Threads', body: '採用案' }],
  });
  check('前段が入る', withUpstream.includes('採用案'));
}

/* ================================================================
 * 6. Flow 用テキスト
 * ================================================================ */
section('Flow 用テキスト');
{
  const text = buildFlowText('threads');

  check('手で編集しない旨がある', text.includes('手で編集しないでください'));
  check('作り直し方が書いてある', text.includes('build.mjs'));
  check('**差し込み口が残っている**（Flow 側が埋めるため）',
    text.includes(PLACEHOLDER.SOURCE) && text.includes(PLACEHOLDER.UPSTREAM));
  check('共通ルールが入っている', text.includes('決して創作しない'));

  const all = buildAllFlowTexts();
  check('全段階ぶん出る', all.length === STAGES.length);
  check('ファイル名は段階ID', all[0].fileName === 'threads.txt');
}

/* ================================================================
 * 7. **生成された GAS 版が Node 版と一致するか**
 * ================================================================ */
section('GAS 版と Node 版の一致');
{
  const source = buildGasSource();

  check('手で編集しない旨がある', source.includes('このファイルは生成物です'));
  check('区切り記号を持つ', source.includes('ISSO_PROMPT_DELIMITER'));
  check('テンプレートを持つ', source.includes('ISSO_PROMPT_TEMPLATES'));

  /*
   * 生成された GAS コードをこの場で評価し、同じ入力で同じ出力になるかを見る。
   * GAS の関数は var 宣言なので、Function で包めばそのまま動く。
   */
  const gas = new Function(`${source}\nreturn { issoBuildPrompt: issoBuildPrompt, ISSO_PROMPT_TEMPLATES: ISSO_PROMPT_TEMPLATES, ISSO_STAGE_IDS: ISSO_STAGE_IDS };`)();

  check('GAS 側の段階の並びが一致',
    gas.ISSO_STAGE_IDS.join(',') === STAGE_IDS.join(','));

  const cases = [
    { stage: 'threads', input: { source: '着想メモ' } },
    { stage: 'threads', input: { source: '着想メモ', tone: 'ですます' } },
    { stage: 'threads', input: { source: '着想', length: '' } },
    { stage: 'x', input: { source: '着想', upstream: [{ stage: 'threads', label: 'Threads', body: '案A' }] } },
    {
      stage: 'note',
      input: {
        source: '着想',
        tone: 'である',
        upstream: [
          { stage: 'threads', label: 'Threads', body: '案A', editedByUser: true },
          { stage: 'x', label: 'X', body: 'X案' },
        ],
      },
    },
    { stage: 'script', input: { source: '着想', upstream: [{ stage: 'note', label: 'note', body: '記事' }] } },
    { stage: 'metadata', input: { source: '着想', upstream: [{ stage: 'script', label: '台本', body: '台本本文' }] } },
  ];

  for (const { stage, input } of cases) {
    const fromNode = buildPrompt(stage, input);
    const fromGas = gas.issoBuildPrompt(stage, input);
    const label = `${stage}（${Object.keys(input).join('+')}）`;

    check(`一致: ${label}`, fromNode === fromGas,
      fromNode === fromGas ? '' : `\n--- Node ---\n${fromNode}\n--- GAS ---\n${fromGas}`);
  }

  /* 例外の条件もそろっていること。 */
  check('GAS 版も着想が空なら例外',
    throws(() => gas.issoBuildPrompt('threads', { source: ' ' })) instanceof Error);
  check('GAS 版も未定義の段階で例外',
    throws(() => gas.issoBuildPrompt('nope', { source: 'x' })) instanceof Error);
}

/* ================================================================
 * 8. 生成物が最新か
 * ================================================================ */
section('生成物の鮮度');
{
  const stale = diff();

  check('**生成物が最新**（古ければ node lib/pipeline/prompts/build.mjs）',
    stale.length === 0,
    stale.map((f) => f.path.slice(repoRoot.length + 1)).join(', '));

  /* 生成物の中身も一応確かめる（書き出し先を間違えていないか）。 */
  if (stale.length === 0) {
    const gasFile = resolve(repoRoot, 'gas-isso', 'Prompts.gs');
    check('Prompts.gs が置かれている',
      readFileSync(gasFile, 'utf8').includes('ISSO_PROMPT_TEMPLATES'));
  }
}

console.log(`\nTESTRESULT ${pass} ${fail}`);
process.exit(fail === 0 ? 0 : 1);

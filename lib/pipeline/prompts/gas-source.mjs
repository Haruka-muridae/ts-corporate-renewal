/*
 * `gas-isso/Prompts.gs` の生成。
 *
 * ==================================================================
 * 生成するもの
 * ==================================================================
 *   ISSO_PROMPT_TEMPLATES   段階ID → 固定部分（差し込み口が残った文字列）
 *   ISSO_PROMPT_DELIMITER   出力の区切り記号（**解析側と共有する**）
 *   ISSO_STAGE_IDS          段階の並び
 *   issoRenderPrompt()      差し込み口を埋める（render.mjs と同じ振る舞い）
 *   issoFormatUpstream()    前段の採用文の整形（formatUpstream と同じ振る舞い）
 *
 * ==================================================================
 * なぜ関数まで生成するのか
 * ==================================================================
 * テンプレートだけを生成し、埋める処理を GAS 側に手で書くと、
 * **Node 側（render.mjs）と GAS 側で振る舞いがずれる。**
 * 「空なら行ごと落とす」のような細かい規則ほどずれやすく、
 * ずれると「Node のテストは通るのに実機のプロンプトが違う」という
 * 追いにくい壊れ方をする。
 *
 * そこで**埋める処理も生成物に含める。** 生成される関数は
 * render.mjs の写しであり、`tests/unit/pipeline-prompts.mjs` が
 * **両者が同じ出力になることを実際に突き合わせて確かめる。**
 * ==================================================================
 */

import { DELIMITER, PLACEHOLDER, STAGES } from './definitions.mjs';
import { buildTemplate } from './render.mjs';

/** GAS（ES5相当）の文字列リテラルへ落とす。 */
function toGasString(value) {
  return JSON.stringify(String(value));
}

/**
 * 差し込みと整形の実装。**render.mjs と同じ規則。**
 *
 * ここを直したら render.mjs も直すこと。ずれはテストが検出する。
 */
const RUNTIME = `
/**
 * 差し込み口を埋める。値が空の行は落とし、直前の見出しも一緒に落とす。
 * lib/pipeline/prompts/render.mjs の render() と同じ規則。
 */
function issoRenderPrompt(template, values) {
  var lines = String(template).split('\\n');
  var out = [];
  var names = Object.keys(ISSO_PROMPT_PLACEHOLDER);

  for (var i = 0; i < lines.length; i++) {
    var rendered = lines[i];
    var emptied = false;

    for (var j = 0; j < names.length; j++) {
      var placeholder = ISSO_PROMPT_PLACEHOLDER[names[j]];

      if (rendered.indexOf(placeholder) === -1) {
        continue;
      }

      var value = values[names[j]];
      value = (value === undefined || value === null) ? '' : String(value);

      if (value.replace(/^\\s+|\\s+$/g, '') === '') {
        emptied = true;
        break;
      }

      rendered = rendered.replace(placeholder, value);
    }

    if (emptied) {
      if (out.length > 0 && out[out.length - 1].indexOf('## ') === 0) {
        out.pop();
      }
      continue;
    }

    out.push(rendered);
  }

  return out.join('\\n').replace(/\\n{3,}/g, '\\n\\n').replace(/\\s+$/, '');
}

/**
 * 前段までの採用文を整形する。
 * lib/pipeline/prompts/render.mjs の formatUpstream() と同じ規則。
 */
function issoFormatUpstream(upstream) {
  if (!upstream || !upstream.length) {
    return '';
  }

  var blocks = [];

  for (var i = 0; i < upstream.length; i++) {
    var item = upstream[i];
    var label = item.label || item.stage;
    var mark = item.editedByUser === true
      ? '（利用者が手直しした版。表現を尊重すること）'
      : '';

    blocks.push('### ' + label + mark + '\\n' + item.body);
  }

  return blocks.join('\\n\\n');
}

/**
 * 段階のプロンプトを最後まで組み立てる。Generation.gs はこれを呼ぶ。
 * lib/pipeline/prompts/render.mjs の buildPrompt() と同じ規則。
 */
function issoBuildPrompt(stageId, input) {
  var template = ISSO_PROMPT_TEMPLATES[stageId];

  if (!template) {
    throw new Error('未定義の段階です: ' + stageId);
  }

  var source = String((input && input.source) || '').replace(/^\\s+|\\s+$/g, '');

  if (source === '') {
    throw new Error('着想が空です。プロンプトを組み立てられません。');
  }

  var length = String((input && input.length) || '').replace(/^\\s+|\\s+$/g, '');

  if (length === '') {
    length = ISSO_STAGE_DEFAULT_LENGTH[stageId];
  }

  return issoRenderPrompt(template, {
    SOURCE: source,
    UPSTREAM: issoFormatUpstream((input && input.upstream) || []),
    LENGTH: length,
    TONE: (input && input.tone) || ''
  });
}
`.trim();

/**
 * `Prompts.gs` の中身を返す。
 *
 * @returns {string}
 */
export function buildGasSource() {
  const lines = [
    '/*',
    ' * Prompts.gs — 段階別プロンプトの定義と組み立て',
    ' *',
    ' * ==================================================================',
    ' * **このファイルは生成物です。手で編集しないでください。**',
    ' * ==================================================================',
    ' * 出どころ: lib/pipeline/prompts/definitions.mjs（単一ソース）',
    ' * 作り直し: node lib/pipeline/prompts/build.mjs',
    ' *',
    ' * ここを手で直すと、第2段（会員向け）の LlmClient と食い違います。',
    ' * 直すのは definitions.mjs です。',
    ' * ==================================================================',
    ' */',
    '',
    '/* 差し込み口。issoRenderPrompt が参照する。 */',
    `var ISSO_PROMPT_PLACEHOLDER = ${JSON.stringify(PLACEHOLDER, null, 2)};`,
    '',
    '/* 出力の区切り記号。**解析側（Generation.gs）はここを見る。** */',
    `var ISSO_PROMPT_DELIMITER = ${JSON.stringify(DELIMITER, null, 2)};`,
    '',
    '/* 段階の並び。前段→次段の順。 */',
    `var ISSO_STAGE_IDS = ${JSON.stringify(STAGES.map((s) => s.id))};`,
    '',
    '/* 段階の表示名。 */',
    `var ISSO_STAGE_LABELS = ${JSON.stringify(
      Object.fromEntries(STAGES.map((s) => [s.id, s.label])),
      null,
      2,
    )};`,
    '',
    '/* 生成する案の数（FR-013）。 */',
    `var ISSO_STAGE_CANDIDATES = ${JSON.stringify(
      Object.fromEntries(STAGES.map((s) => [s.id, s.candidates])),
      null,
      2,
    )};`,
    '',
    '/* 前段として渡す段階。要件15章「前段の採用版を主要入力とする」。 */',
    `var ISSO_STAGE_UPSTREAM = ${JSON.stringify(
      Object.fromEntries(STAGES.map((s) => [s.id, s.upstreamStages])),
      null,
      2,
    )};`,
    '',
    '/* settings が空のときに使う目安。 */',
    `var ISSO_STAGE_DEFAULT_LENGTH = ${JSON.stringify(
      Object.fromEntries(STAGES.map((s) => [s.id, s.defaultLength])),
      null,
      2,
    )};`,
    '',
    '/* settings のキー。 */',
    `var ISSO_STAGE_SETTING_KEY = ${JSON.stringify(
      Object.fromEntries(STAGES.map((s) => [s.id, s.settingKey])),
      null,
      2,
    )};`,
    '',
    '/* 段階ごとの固定部分。差し込み口（{{…}}）が残っている。 */',
    'var ISSO_PROMPT_TEMPLATES = {',
    ...STAGES.map((stage, index) => {
      const comma = index === STAGES.length - 1 ? '' : ',';
      return `  ${JSON.stringify(stage.id)}: ${toGasString(buildTemplate(stage.id))}${comma}`;
    }),
    '};',
    '',
    RUNTIME,
    '',
  ];

  return lines.join('\n');
}

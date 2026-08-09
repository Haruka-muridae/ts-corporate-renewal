/*
 * Workspace Studio の Flow へ貼るテキストの生成。
 *
 * ==================================================================
 * これは保険である
 * ==================================================================
 * 第1段の本命は `gas-isso/Prompts.gs`（gas-source.mjs）で、GAS が
 * 完全なプロンプトを組み立てて generation_queue へ渡す。その形なら
 * Flow は「H列を読む → Gemini → I列に書く」だけの1本で済む。
 *
 * ただし **Workspace Studio Flows が Sheets の行を読んで同じ行へ
 * 書き戻せるかは未確認**（v1.0-personal §9 確認事項1）。できない場合は
 * 段階ごとに Flow を作り、ここで生成したテキストを貼る運用になる。
 *
 * **どちらに転んでも単一ソースは保たれる。** それがこのファイルの目的。
 * ==================================================================
 */

import { PLACEHOLDER, STAGES, findStage } from './definitions.mjs';
import { buildTemplate } from './render.mjs';

/** 貼り付け先で迷わないための説明。**テキストの先頭に付ける。** */
function header(stage) {
  return [
    '───────────────────────────────────────────────',
    `一想（ISSO） 段階: ${stage.label}（${stage.id}）`,
    '',
    '**このテキストは生成物です。手で編集しないでください。**',
    '直すときは lib/pipeline/prompts/definitions.mjs を直し、',
    '`node lib/pipeline/prompts/build.mjs` で作り直して貼り直します。',
    '',
    '差し込み口（{{…}}）は Flow 側の変数へ対応させてください:',
    ...Object.values(PLACEHOLDER).map((p) => `  ${p}`),
    '───────────────────────────────────────────────',
    '',
  ].join('\n');
}

/**
 * 1段階ぶんの貼り付けテキスト。
 *
 * @param {string} stageId
 * @returns {string}
 */
export function buildFlowText(stageId) {
  const stage = findStage(stageId);

  if (stage === null) {
    throw new Error(`未定義の段階です: ${stageId}`);
  }

  /*
   * 差し込み口を残したまま返す。**render を通さない。**
   * Flow 側が値を入れるため、ここで埋めてしまうと使えない。
   */
  return `${header(stage)}${buildTemplate(stageId)}\n`;
}

/**
 * 全段階ぶんを [ファイル名, 中身] の並びで返す。
 *
 * @returns {Array<{ fileName: string, content: string }>}
 */
export function buildAllFlowTexts() {
  return STAGES.map((stage) => ({
    fileName: `${stage.id}.txt`,
    content: buildFlowText(stage.id),
  }));
}

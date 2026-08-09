/*
 * プロンプトの組み立て。
 *
 * ==================================================================
 * 組み立ては「テンプレート＋差し込み」の2段にしてある
 * ==================================================================
 *   buildTemplate(stageId)      … 段階の固定部分。差し込み口が残った文字列
 *   render(template, values)    … 差し込み口を埋める（**5行で書ける単純な置換**）
 *
 * 2段にしている理由:
 *   - 第1段（GAS）は buildTemplate の結果を Prompts.gs へ埋め込み、
 *     GAS 側で render 相当を行う。**render が単純だから移植できる。**
 *   - Flow へ手で貼る運用では、buildTemplate の結果をそのまま貼り、
 *     差し込み口を Flow 側の変数に対応させる。
 *   - 第2段（JS）は本ファイルをそのまま使う。
 *
 * **render を賢くしない。** 条件分岐やループを持たせると、
 * GAS 側と挙動を揃えるのが難しくなり、単一ソースの意味が薄れる。
 * ==================================================================
 */

import { COMMON_RULES, PLACEHOLDER, findStage } from './definitions.mjs';

/**
 * 段階の固定部分を組み立てる。差し込み口（{{…}}）は残る。
 *
 * @param {string} stageId
 * @returns {string}
 */
export function buildTemplate(stageId) {
  const stage = findStage(stageId);

  if (stage === null) {
    throw new Error(`未定義の段階です: ${stageId}`);
  }

  const parts = [COMMON_RULES, '', `# 今回の段階: ${stage.label}`, '', stage.role, ''];

  if (stage.instructions.length > 0) {
    parts.push('## 書き方', ...stage.instructions.map((line) => `- ${line}`), '');
  }

  parts.push('## 出力の形', ...stage.outputSpec.map((line) => `- ${line}`), '');

  /*
   * 口調は任意。空のときに「口調: 」だけが残ると、モデルが
   * 「指定が無い」ではなく「空にせよ」と読むことがある。
   * **空なら行ごと消える**ように、差し込み側で制御する（render の EMPTY_LINE）。
   */
  parts.push('## 口調', PLACEHOLDER.TONE, '');

  if (stage.upstreamStages.length > 0) {
    parts.push(
      '## 前段までの採用文（これを主要入力とする）',
      PLACEHOLDER.UPSTREAM,
      '',
    );
  }

  parts.push('## 着想', PLACEHOLDER.SOURCE, '');

  return parts.join('\n').trimEnd();
}

/**
 * 差し込み口を埋める。
 *
 * **値が空文字なら、その差し込み口を含む行ごと落とす。**
 * 見出しだけが残って中身が無い状態を作らないため。
 *
 * @param {string} template
 * @param {Record<string, string>} values `{{…}}` を除いたキー名で渡す
 * @returns {string}
 */
export function render(template, values) {
  const lines = template.split('\n');
  /** @type {string[]} */
  const out = [];

  for (const line of lines) {
    let rendered = line;
    let emptied = false;

    for (const [name, placeholder] of Object.entries(PLACEHOLDER)) {
      if (!rendered.includes(placeholder)) {
        continue;
      }

      const value = values[name] ?? '';

      if (String(value).trim() === '') {
        emptied = true;
        break;
      }

      rendered = rendered.replace(placeholder, String(value));
    }

    if (emptied) {
      /*
       * 差し込み口が空だった行は落とす。直前が見出し行なら、
       * その見出しも一緒に落とす（中身の無い見出しを残さない）。
       */
      if (out.length > 0 && out[out.length - 1].startsWith('## ')) {
        out.pop();
      }

      continue;
    }

    out.push(rendered);
  }

  /* 落とした結果、空行が連続することがある。2行以上は1行に詰める。 */
  return out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd();
}

/**
 * 前段までの採用文を、プロンプトへ差し込める形へ整える。
 *
 * **利用者が手直しした版は、その旨を添える**（要件15章
 * 「利用者が編集した表現をAI原案より優先する」を効かせるため）。
 *
 * @param {Array<{ stage: string, label?: string, body: string, editedByUser?: boolean }>} upstream
 * @returns {string}
 */
export function formatUpstream(upstream) {
  if (!Array.isArray(upstream) || upstream.length === 0) {
    return '';
  }

  return upstream
    .map((item) => {
      const label = item.label ?? item.stage;
      const mark = item.editedByUser === true ? '（利用者が手直しした版。表現を尊重すること）' : '';

      return `### ${label}${mark}\n${item.body}`;
    })
    .join('\n\n');
}

/**
 * 段階のプロンプトを最後まで組み立てる。第2段の `LlmClient` はこれを呼ぶ。
 *
 * @param {string} stageId
 * @param {{ source: string, upstream?: Array<object>, length?: string, tone?: string }} input
 * @returns {string}
 */
export function buildPrompt(stageId, input) {
  const stage = findStage(stageId);

  if (stage === null) {
    throw new Error(`未定義の段階です: ${stageId}`);
  }

  const source = String(input.source ?? '').trim();

  if (source === '') {
    /*
     * 着想が空のまま組み立てると、render が「## 着想」ごと落とし、
     * **何も指示していないプロンプトが出来上がる。**
     * 生成は成功して中身が的外れになるため、気づくのが遅れる。ここで止める。
     */
    throw new Error('着想が空です。プロンプトを組み立てられません。');
  }

  /*
   * 目安は settings の値を優先し、空なら定義の既定値へ戻す。
   *
   * `??` だけだと空文字が素通りし、render が「目安」を含む**出力形式の指示行
   * ごと落としてしまう**（差し込み口が行の途中にあるため）。
   * 指示が1行消えたことは出力を見ても分かりにくいので、ここで防ぐ。
   */
  const length = String(input.length ?? '').trim() === ''
    ? stage.defaultLength
    : String(input.length);

  return render(buildTemplate(stageId), {
    SOURCE: source,
    UPSTREAM: formatUpstream(input.upstream ?? []),
    LENGTH: length,
    TONE: input.tone ?? '',
  });
}

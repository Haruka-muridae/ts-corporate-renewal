/*
 * Gemini へ渡す指示と構造化出力の定義。
 *
 * ==================================================================
 * 方針
 * ==================================================================
 * 名刺OCR（../card-ocr/prompt.js）と同じく、指示・スキーマ・リクエスト組み立てを
 * この1本に閉じる。**他アプリから import しない**（docs/repository-structure.md §4-1）。
 *
 * 台本は「分類」ではなく「創作」なので、名刺OCRと違い temperature を上げる。
 * ただし出力の**形**は構造化スキーマで固定し、後段（音声・字幕・動画）が
 * そのまま食える JSON にする。
 * ==================================================================
 */
import { MAX_OUTPUT_TOKENS } from './config.js';

/* プロンプトの版。変えたら config.js の APP_VERSION も上げる。 */
export const PROMPT_VERSION = 'short-script-1';

/* 1シーンの秒数の下限・上限。モデルの返り値をここへ丸める（prompt だけに頼らない）。 */
export const SCENE_SECONDS_MIN = 2;
export const SCENE_SECONDS_MAX = 20;

/* 1シーンのナレーション最大文字数。字幕は最大2行に収める前提（後段の subtitle 側と揃える）。 */
export const SCENE_TEXT_MAX_LENGTH = 60;

/*
 * 構造化出力の定義。
 *
 * **type は大文字。** responseSchema は proto の列挙型で、小文字だと
 * サーバーに 400 で弾かれる（名刺OCR prompt.js の注記と同じ）。
 */
export const SCRIPT_SCHEMA = Object.freeze({
  type: 'OBJECT',
  properties: {
    title: { type: 'STRING' },
    scenes: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          seconds: { type: 'NUMBER' },
          text: { type: 'STRING' },
        },
        required: ['seconds', 'text'],
      },
    },
  },
  required: ['title', 'scenes'],
});

/*
 * 尺ごとのシーン数の目安。
 *
 * 30秒は3〜4、60秒は5〜7。**合計秒数が指定尺に近づくよう**にだけ誘導し、
 * 厳密な一致は求めない。最終尺は後段で実際のナレーション音声の長さに
 * 同期させるため、ここでの秒数はあくまで割り付けの目安である。
 */
function sceneCountHint(durationSec) {
  return durationSec <= 30 ? '3〜4' : '5〜7';
}

/*
 * 指示文。
 *
 * 「聞いてすぐ分かる話し言葉」「最初はフック・最後は行動喚起」を明記する。
 * ショート動画は冒頭数秒で離脱が決まるため、フックの指示を先に置く。
 */
export function buildSystemInstruction(durationSec) {
  return [
    'あなたは日本語のショート動画（縦型）の構成作家です。',
    'テーマに沿って、視聴者が最後まで見たくなる短い台本を作ります。',
    '',
    '守ること:',
    `1. シーン数は${sceneCountHint(durationSec)}個にすること。`,
    `2. 各シーンの seconds の合計が、およそ${durationSec}秒になること。`,
    `3. 各シーンの text はナレーション原稿。1シーン最大${SCENE_TEXT_MAX_LENGTH}文字。`,
    '   話し言葉で、聞いてすぐ理解できる短い文にすること。',
    '4. 最初のシーンは視聴者を引き込むフックにすること。',
    '   最後のシーンは短いまとめ、または次の行動をうながす一言にすること。',
    '5. 誇大な表現や、事実か分からない断定を避けること。',
    '6. title は動画のタイトル。テーマが一目で分かる短い言葉にすること。',
  ].join('\n');
}

/*
 * リクエスト本体を組み立てる。
 *
 * 履歴は持たせない（1テーマ1リクエスト）。temperature は 0.8。
 * 台本は毎回同じである必要はなく、多少の揺れがあってよい。
 * ただし responseSchema で**形**は固定する。
 */
export function buildScriptRequest(theme, durationSec, { maxOutputTokens = MAX_OUTPUT_TOKENS } = {}) {
  const userText = `テーマ: ${String(theme ?? '').trim()}\n尺: ${durationSec}秒`;

  return {
    systemInstruction: {
      parts: [{ text: buildSystemInstruction(durationSec) }],
    },
    contents: [
      {
        role: 'user',
        parts: [{ text: userText }],
      },
    ],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: SCRIPT_SCHEMA,
      maxOutputTokens,
      temperature: 0.8,
    },
  };
}

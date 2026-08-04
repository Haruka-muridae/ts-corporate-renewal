/*
 * 案C：Gemini への画像直接投入（仕様書 §0.2 / §5-⑤）。
 *
 * 案A（ocr-drive.js）と同じ形の窓口を持ち、config.js の OCR_ENGINE で
 * 差し替えられる。§16 フェーズ0 の実測比較は、この2つを切り替えて行う。
 *
 * ------------------------------------------------------------------
 * キーが要る（§4 末尾）
 * ------------------------------------------------------------------
 * このエンジンを選ぶと、Gemini APIキーが必須になる。未設定の利用者は
 * 利用できない（§0.2 の表）。KEY-001 で Portal へ誘導する。
 * ------------------------------------------------------------------
 *
 * ------------------------------------------------------------------
 * 無料枠の明示（§0.4）
 * ------------------------------------------------------------------
 * このエンジンは領収書の画像そのものを Google へ送る。無料枠のキーでは
 * 画像が Google 側で利用され得ることを、画面で必ず示すこと（index.html）。
 * ------------------------------------------------------------------
 */

import { AppError, PROGRESS } from './errors.js';
import { generate, textOf } from './gemini-client.js';

export const ENGINE_ID = 'gemini';

export const requiresApiKey = true;

/*
 * 文字起こしだけを頼む。
 *
 * ここでは項目の抽出をさせない。読み取った文字をそのまま返させる。
 * 項目への振り分けは、この後のルール抽出とフェーズ3の補完が担当し、
 * 役割を混ぜない（§7 の独立抽出の考え方に揃える）。
 */
const PROMPT = [
  'この画像は日本の領収書またはレシートです。',
  '書かれている文字を、上から順にそのまま書き出してください。',
  '推測で補ったり、要約したり、項目名を付け直したりしないでください。',
  '読めない文字は「?」としてください。',
].join('\n');

/* Blob を base64 へ。Gemini の inlineData はバイト列を base64 で受け取る。 */
async function toBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';

  /* 一度に渡すと引数の上限に当たるため、小分けにする。 */
  const chunk = 0x8000;

  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }

  return globalThis.btoa(binary);
}

export async function recognize({ blob, apiKey, signal } = {}) {
  if (!blob) {
    throw new AppError('OCR-001', { progress: PROGRESS.ORIGINAL_SAVED, detail: 'no_blob' });
  }

  const body = {
    contents: [{
      role: 'user',
      parts: [
        { text: PROMPT },
        { inlineData: { mimeType: blob.type || 'image/jpeg', data: await toBase64(blob) } },
      ],
    }],
    generationConfig: { temperature: 0 },
  };

  const { result } = await generate({ apiKey, body, signal, progress: PROGRESS.ORIGINAL_SAVED });

  return { engine: ENGINE_ID, text: textOf(result) };
}

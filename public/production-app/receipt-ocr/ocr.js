/*
 * OCRエンジンの差し替え口（仕様書 §0.2 / §6）。
 *
 * ------------------------------------------------------------------
 * なぜ差し替えられる形にするか
 * ------------------------------------------------------------------
 * §0.2 は「OCR方式はフェーズ0で決定」としており、案A（Drive OCR）と
 * 案C（Gemini画像直接）を実測比較したうえで選ぶことになっている。
 * 比較のたびに呼び出し側を書き換えるのでは、条件を揃えた比較にならない。
 *
 * どちらのエンジンも同じ形（recognize / requiresApiKey）を持ち、
 * 切り替えは config.js の OCR_ENGINE 1か所だけで済ませる。
 * ------------------------------------------------------------------
 *
 * エンジンが返すのは「読み取った文字列」までとする。
 * 項目への振り分けはルール抽出の仕事であり、ここでは行わない。
 */

import { OCR_ENGINE } from './config.js';
import { AppError, PROGRESS } from './errors.js';
import * as driveEngine from './ocr-drive.js';
import * as geminiEngine from './ocr-gemini.js';

export const ENGINES = Object.freeze({
  [driveEngine.ENGINE_ID]: driveEngine,
  [geminiEngine.ENGINE_ID]: geminiEngine,
});

/* いま選ばれているエンジン。設定が壊れていたら例外にせず案Aへ落とす。 */
export function activeEngine(id = OCR_ENGINE) {
  return ENGINES[id] ?? driveEngine;
}

/* このエンジンで Gemini APIキーが必須か（§4 末尾）。 */
export function requiresApiKey(id = OCR_ENGINE) {
  return activeEngine(id).requiresApiKey === true;
}

/*
 * 消し損ねた中間生成物を回収する（§9.5・findings #6）。
 *
 * エンジンによっては中間生成物を作らない（案C）。
 * その場合は何もしないで 0 件を返す。画面側で分岐させないため、
 * **窓口の形はどちらのエンジンでも同じにしておく。**
 */
export async function collectOrphans({ accessToken, signal, engineId = OCR_ENGINE } = {}) {
  const engine = activeEngine(engineId);

  if (typeof engine.collectOrphanTempDocs !== 'function') {
    return { found: 0, deleted: 0, skipped: 0 };
  }

  return engine.collectOrphanTempDocs({ accessToken, signal });
}

/*
 * 読み取る。
 *
 * キーが要るエンジンで、キーが無ければ KEY-001 で止める。
 * 会社のキーへは落とさない（§13）。
 *
 * 文字が取れなかった場合も OCR-001 とし、
 * 「要確認として保存するか」を利用者に選ばせる（§12 OCR-001）。
 */
export async function recognize({ blob, accessToken, apiKey = null, displayName, signal, engineId = OCR_ENGINE } = {}) {
  const engine = activeEngine(engineId);

  if (engine.requiresApiKey && String(apiKey ?? '').trim() === '') {
    throw new AppError('KEY-001', { progress: PROGRESS.ORIGINAL_SAVED, detail: 'engine_requires_key' });
  }

  const result = await engine.recognize({ blob, accessToken, apiKey, displayName, signal });
  const text = String(result?.text ?? '').trim();

  /*
   * deleted は「中間生成物を残していないか」（案Aのみ意味を持つ）。
   * 案Cは一時ドキュメントを作らないので、報告が無ければ true とする。
   * false のときは次回起動時の孤児回収に任せる（§9.5・findings #6）。
   */
  return {
    engine: engine.ENGINE_ID,
    text,
    empty: text === '',
    deleted: result?.deleted !== false,
  };
}

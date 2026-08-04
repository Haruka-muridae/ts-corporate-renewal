/*
 * Gemini API のクライアント（仕様書 §6 / §13）。
 *
 * ==================================================================
 * キーの扱い
 * ==================================================================
 * キーは呼び出しのたびに引数で受け取り、**このモジュールに残さない。**
 * 保持しているのは Portal の KeyStore（利用者の端末）だけである。
 *
 * キーは URL ではなくヘッダー（x-goog-api-key）へ載せる。
 * クエリ文字列に置くと、開発者ツールの履歴や拡張機能から拾える場所が1つ増える。
 *
 * 会社のキーへフォールバックしない。キーが無ければ、無いまま止める（§3.2 / §13）。
 * ==================================================================
 *
 * 応答本文には、キーやプロジェクト情報が混じることがある。
 * このファイルが外へ渡すのはコードだけにし、本文をそのまま画面へ出さない。
 */

import { GEMINI } from './config.js';
import { AppError, PROGRESS } from './errors.js';

/*
 * 応答からエラーコードを決める（§12）。
 *
 * 400/403 はキーの問題（KEY-002）、429 はクォータ（AI-002）。
 * 404 はモデルが無い場合で、呼び出し側が1回だけ別モデルへ落とす（§6）。
 */
export function mapGeminiError(status) {
  if (status === 400 || status === 401 || status === 403) {
    return 'KEY-002';
  }

  if (status === 429) {
    return 'AI-002';
  }

  if (status === 404) {
    return 'MODEL-404';
  }

  return 'OCR-001';
}

async function callModel(model, { apiKey, body, signal, progress }) {
  const url = `${GEMINI.apiBase}/${GEMINI.apiVersion}/models/${encodeURIComponent(model)}:generateContent`;

  let response;

  try {
    response = await globalThis.fetch(url, {
      method: 'POST',
      headers: {
        'x-goog-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch {
    throw new AppError('OCR-001', { progress, detail: 'network' });
  }

  if (!response.ok) {
    const code = mapGeminiError(response.status);

    if (code === 'MODEL-404') {
      const error = new Error('model_not_found');
      error.modelNotFound = true;
      throw error;
    }

    throw new AppError(code, { progress, detail: `http_${response.status}` });
  }

  try {
    return await response.json();
  } catch {
    throw new AppError('OCR-001', { progress, detail: 'bad_json' });
  }
}

/*
 * 生成を1回行う。
 *
 * モデルは静的設定を使い、**404 のときだけ1回フォールバックする**（§6）。
 * 何度も試すと、利用者のクォータを黙って消費する。
 */
export async function generate({ apiKey, body, signal, progress = PROGRESS.ORIGINAL_SAVED } = {}) {
  const key = String(apiKey ?? '').trim();

  if (key === '') {
    /* 会社のキーへ落とさない。キーが無いことを、そのまま伝える。 */
    throw new AppError('KEY-001', { progress, detail: 'empty_key' });
  }

  try {
    const result = await callModel(GEMINI.model, { apiKey: key, body, signal, progress });
    return { model: GEMINI.model, result };
  } catch (error) {
    if (!error?.modelNotFound) {
      throw error;
    }
  }

  try {
    const result = await callModel(GEMINI.fallbackModel, { apiKey: key, body, signal, progress });
    return { model: GEMINI.fallbackModel, result };
  } catch (error) {
    if (error?.modelNotFound) {
      throw new AppError('OCR-001', { progress, detail: 'model_not_found' });
    }

    throw error;
  }
}

/* 応答から本文テキストだけを取り出す。無ければ空文字。 */
export function textOf(result) {
  const parts = result?.candidates?.[0]?.content?.parts;

  if (!Array.isArray(parts)) {
    return '';
  }

  return parts.map((part) => String(part?.text ?? '')).join('');
}

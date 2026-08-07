/*
 * Gemini API の呼び出し（台本生成）。
 *
 * ==================================================================
 * 方針（名刺OCR ../card-ocr/gemini.js と同じ）
 * ==================================================================
 *   - キーは `x-goog-api-key` ヘッダーに載せる。**URLへ載せない。**
 *   - キーを引数で受け取り、このモジュール内で保持しない。
 *   - 例外にキーを含めない。console にも出さない。
 *   - 外部SDKを使わず fetch で REST を直接叩く。
 *
 * **import はしない**方針（docs/repository-structure.md §4-1）に従い、
 * エラー分類は名刺OCRから**複製**している。共有モジュール化は、
 * 2本目以降のアプリが増えて重複が実害になった時点で検討する。
 * ==================================================================
 */

import { buildScriptRequest, SCENE_SECONDS_MIN, SCENE_SECONDS_MAX, SCENE_TEXT_MAX_LENGTH } from './prompt.js';
import {
  DEFAULT_MODEL,
  FALLBACK_MODEL,
  GEMINI_ENDPOINT_BASE,
  GEMINI_HOST,
  MAX_OUTPUT_TOKENS,
} from './config.js';

export { GEMINI_HOST, DEFAULT_MODEL, FALLBACK_MODEL };

export const GeminiErrorCode = {
  KEY_MISSING: 'KEY_MISSING',
  KEY_REJECTED: 'KEY_REJECTED',
  BAD_REQUEST: 'BAD_REQUEST',
  RATE_LIMITED: 'RATE_LIMITED',
  MODEL_NOT_FOUND: 'MODEL_NOT_FOUND',
  BAD_JSON: 'BAD_JSON',
  MISSING_FIELDS: 'MISSING_FIELDS',
  NETWORK: 'NETWORK',
  SERVER_ERROR: 'SERVER_ERROR',
  UNKNOWN: 'UNKNOWN',
};

export class GeminiError extends Error {
  constructor(code, status = 0, detail = '') {
    /* メッセージにキーを含めない。コードと状態だけで足りる。 */
    super(`gemini:${code}`);
    this.name = 'GeminiError';
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

/*
 * エラー応答から原因の要約を取り出す。
 * Gemini は失敗時に { error: { code, status, message } } を返す。
 * キーは本文に出ないため、そのまま表示してよい。
 */
export function summarizeErrorBody(body, status) {
  const error = body?.error;
  const parts = [];

  if (typeof error?.status === 'string' && error.status !== '') {
    parts.push(error.status);
  }

  if (typeof error?.message === 'string' && error.message !== '') {
    parts.push(error.message);
  }

  if (parts.length === 0) {
    return `HTTP ${status}`;
  }

  const text = `HTTP ${status} ${parts.join(': ')}`;

  return text.length > 300 ? `${text.slice(0, 297)}…` : text;
}

/*
 * 画面に出す言葉。
 * **detail を必ず返す。** 「不明なエラー」だけでは切り分けができない。
 */
export function describeGeminiError(error) {
  const isKnown = error instanceof GeminiError;
  const code = isKnown ? error.code : GeminiErrorCode.UNKNOWN;
  const detail = isKnown
    ? String(error.detail ?? '')
    : `${error?.name ?? 'Error'}: ${error?.message ?? String(error)}`;

  const described = (text, errorCode) => ({ text, errorCode, detail });

  switch (code) {
    case GeminiErrorCode.KEY_MISSING:
      return described('Gemini APIキーが設定されていません。ポータルで設定してください。', 'KEY-001');
    case GeminiErrorCode.KEY_REJECTED:
      return described('このAPIキーでは接続できませんでした。', 'KEY-002');
    case GeminiErrorCode.BAD_REQUEST:
      return described('リクエストの形式が不正です（キーの問題ではありません）。', 'AI-003');
    case GeminiErrorCode.RATE_LIMITED:
      return described('利用上限に達しています。無料枠の場合は時間をおいてお試しください。', 'AI-002');
    case GeminiErrorCode.MODEL_NOT_FOUND:
      return described('モデルが利用できませんでした。', 'AI-005');
    case GeminiErrorCode.BAD_JSON:
      return described('応答の形式が不正でした。もう一度お試しください。', 'AI-003');
    case GeminiErrorCode.MISSING_FIELDS:
      return described('台本の必要な項目が揃いませんでした。もう一度お試しください。', 'AI-004');
    case GeminiErrorCode.NETWORK:
      return described('通信に失敗しました。', 'AI-001');
    case GeminiErrorCode.SERVER_ERROR:
      return described(
        error?.status === 503
          ? 'Gemini が混雑しています。時間をおいてお試しください。'
          : 'Gemini 側でエラーが起きました。',
        'AI-001',
      );
    default:
      return described('不明なエラーが発生しました。', 'SYS-999');
  }
}

/*
 * HTTPステータスを分類する。
 * **400 をキーの問題にしない。** 400 はリクエストの形が不正なとき、
 * キーが悪いときは 401/403（名刺OCR gemini.js の注記と同じ）。
 */
export function mapStatus(status) {
  if (status === 400) {
    return GeminiErrorCode.BAD_REQUEST;
  }

  if (status === 401 || status === 403) {
    return GeminiErrorCode.KEY_REJECTED;
  }

  if (status === 429) {
    return GeminiErrorCode.RATE_LIMITED;
  }

  if (status === 404) {
    return GeminiErrorCode.MODEL_NOT_FOUND;
  }

  if (status >= 500) {
    return GeminiErrorCode.SERVER_ERROR;
  }

  return GeminiErrorCode.UNKNOWN;
}

/*
 * 応答から JSON を取り出す。
 * responseMimeType が application/json でも、本文は
 * candidates[].content.parts[].text に**文字列として**入る。
 */
export function extractJson(payload) {
  const text = payload?.candidates?.[0]?.content?.parts?.[0]?.text;

  if (typeof text !== 'string' || text.trim() === '') {
    throw new GeminiError(GeminiErrorCode.BAD_JSON, 0, 'empty_text');
  }

  let parsed = null;

  try {
    parsed = JSON.parse(text);
  } catch {
    throw new GeminiError(GeminiErrorCode.BAD_JSON, 0, 'parse_failed');
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new GeminiError(GeminiErrorCode.BAD_JSON, 0, 'not_object');
  }

  return parsed;
}

/* 秒数を下限・上限へ丸める。壊れた値（NaN・負数・文字列）は既定値へ寄せる。 */
function clampSeconds(value) {
  const n = Number(value);

  if (!Number.isFinite(n)) {
    return SCENE_SECONDS_MIN;
  }

  return Math.min(SCENE_SECONDS_MAX, Math.max(SCENE_SECONDS_MIN, Math.round(n)));
}

/*
 * 台本の形を整える。
 *
 * モデルは指示に反した値を返すことがある。**画面や後段へ渡す前に、
 * ここで確実に「使える形」へ寄せる**（prompt だけに頼らない）。
 *   - title が空なら BAD_JSON
 *   - scenes が空配列なら MISSING_FIELDS
 *   - 各シーンは text を trim、空なら落とす。seconds は範囲へ丸める。
 *   - text は最大文字数で切り詰める（字幕の折り返し前提を守る）。
 */
export function normalizeScript(parsed) {
  const title = typeof parsed.title === 'string' ? parsed.title.trim() : '';

  if (title === '') {
    throw new GeminiError(GeminiErrorCode.BAD_JSON, 0, 'no_title');
  }

  if (!Array.isArray(parsed.scenes)) {
    throw new GeminiError(GeminiErrorCode.MISSING_FIELDS, 0, 'scenes_not_array');
  }

  const scenes = parsed.scenes
    .map((scene) => ({
      seconds: clampSeconds(scene?.seconds),
      text: typeof scene?.text === 'string' ? scene.text.trim().slice(0, SCENE_TEXT_MAX_LENGTH) : '',
    }))
    .filter((scene) => scene.text !== '');

  if (scenes.length === 0) {
    throw new GeminiError(GeminiErrorCode.MISSING_FIELDS, 0, 'no_scenes');
  }

  return { title, scenes };
}

/*
 * 1回だけ呼ぶ。モデルの切り替えは呼び出し側（generateScript）の仕事。
 * fetchImpl を差し替えられるのはテストで実APIへ通信しないため。
 */
async function callOnce({ apiKey, model, theme, durationSec, fetchImpl, signal, maxOutputTokens }) {
  const url = `${GEMINI_ENDPOINT_BASE}/${encodeURIComponent(model)}:generateContent`;
  const impl = fetchImpl ?? globalThis.fetch;

  let response = null;

  try {
    response = await impl(url, {
      method: 'POST',
      headers: {
        /* キーはヘッダー。URLには載せない。 */
        'x-goog-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(buildScriptRequest(theme, durationSec, { maxOutputTokens })),
      signal,
    });
  } catch {
    throw new GeminiError(GeminiErrorCode.NETWORK, 0, 'fetch_failed');
  }

  if (!response?.ok) {
    const status = Number(response?.status) || 0;

    let body = null;

    try {
      body = await response.json();
    } catch {
      /* JSON で無いこともある。status だけで要約する。 */
    }

    throw new GeminiError(mapStatus(status), status, summarizeErrorBody(body, status));
  }

  let payload = null;

  try {
    payload = await response.json();
  } catch {
    throw new GeminiError(GeminiErrorCode.BAD_JSON, 200, 'body_not_json');
  }

  return normalizeScript(extractJson(payload));
}

/*
 * テーマから台本を生成する。
 *
 * 主モデルが 404 のときだけ、フォールバックモデルで1回試す。
 * それ以外のエラーでは再試行しない（401/403 を繰り返しても結果は
 * 変わらず、無料枠のクォータを削るだけ）。
 *
 * 戻り値: { title, scenes: [{ seconds, text }] }
 */
export async function generateScript(theme, durationSec, {
  apiKey,
  model = DEFAULT_MODEL,
  fallbackModel = FALLBACK_MODEL,
  fetchImpl,
  signal,
  maxOutputTokens = MAX_OUTPUT_TOKENS,
} = {}) {
  const key = String(apiKey ?? '').trim();

  if (key === '') {
    throw new GeminiError(GeminiErrorCode.KEY_MISSING, 0, 'no_key');
  }

  const args = { apiKey: key, theme, durationSec, fetchImpl, signal, maxOutputTokens };

  try {
    return await callOnce({ ...args, model });
  } catch (error) {
    const isModelMissing = error instanceof GeminiError
      && error.code === GeminiErrorCode.MODEL_NOT_FOUND;

    if (!isModelMissing || !fallbackModel || fallbackModel === model) {
      throw error;
    }

    return callOnce({ ...args, model: fallbackModel });
  }
}

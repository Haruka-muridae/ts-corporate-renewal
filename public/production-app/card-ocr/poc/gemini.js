/*
 * Gemini API の呼び出し（フェーズ0の検証用）。
 *
 * ==================================================================
 * 方針（要件定義書 §FR-11 / §FR-23 / §14.1）
 * ==================================================================
 *   - キーは `x-goog-api-key` ヘッダーに載せる。**URLへ載せない。**
 *     クエリ文字列に置くと、開発者ツールの履歴や拡張機能から
 *     拾える場所が1つ増える。
 *   - 送るのは**テキストだけ**。画像は送らない。
 *   - キーを引数で受け取り、このモジュール内で保持しない。
 *     どこにも溜めなければ、漏れる経路も作られない。
 *   - 例外にキーを含めない。console にも出さない。
 *   - 外部SDKを使わず fetch で REST を直接叩く（lib/event/ と同じ方針）。
 * ==================================================================
 */

import { buildGeminiRequest } from './prompt.js';

/* 要件定義書 §12 が許す3系統のうちの1つ。ここを変えないこと。 */
export const GEMINI_HOST = 'generativelanguage.googleapis.com';

const GEMINI_ENDPOINT_BASE = `https://${GEMINI_HOST}/v1beta/models`;

/* 初期設定モデル（要件定義書 §FR-11、§20）。 */
export const DEFAULT_MODEL = 'gemini-3.5-flash-lite';

/* 主モデルが404のときに1回だけ試すモデル。会社キーへは落とさない。 */
export const FALLBACK_MODEL = 'gemini-2.5-flash-lite';

export const GeminiErrorCode = {
  KEY_MISSING: 'KEY_MISSING',
  KEY_REJECTED: 'KEY_REJECTED',
  RATE_LIMITED: 'RATE_LIMITED',
  MODEL_NOT_FOUND: 'MODEL_NOT_FOUND',
  BAD_JSON: 'BAD_JSON',
  MISSING_FIELDS: 'MISSING_FIELDS',
  NETWORK: 'NETWORK',
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

/* 画面に出す言葉。エラーコードは要件定義書 §15 に対応する。 */
export function describeGeminiError(error) {
  const code = error instanceof GeminiError ? error.code : GeminiErrorCode.UNKNOWN;

  switch (code) {
    case GeminiErrorCode.KEY_MISSING:
      return { text: 'Gemini APIキーが設定されていません。', errorCode: 'KEY-001' };
    case GeminiErrorCode.KEY_REJECTED:
      return { text: 'このAPIキーでは接続できませんでした。', errorCode: 'KEY-002' };
    case GeminiErrorCode.RATE_LIMITED:
      return {
        text: '利用上限に達しています。無料枠の場合は時間をおいてお試しください。',
        errorCode: 'AI-002',
      };
    case GeminiErrorCode.MODEL_NOT_FOUND:
      return { text: 'モデルが利用できませんでした。', errorCode: 'AI-005' };
    case GeminiErrorCode.BAD_JSON:
      return { text: '応答の形式が不正でした。', errorCode: 'AI-003' };
    case GeminiErrorCode.MISSING_FIELDS:
      return { text: '応答に必要な項目がありませんでした。', errorCode: 'AI-004' };
    case GeminiErrorCode.NETWORK:
      return { text: '通信に失敗しました。', errorCode: 'AI-001' };
    default:
      return { text: '不明なエラーが発生しました。', errorCode: 'SYS-999' };
  }
}

function mapStatus(status) {
  if (status === 400 || status === 401 || status === 403) {
    return GeminiErrorCode.KEY_REJECTED;
  }

  if (status === 429) {
    return GeminiErrorCode.RATE_LIMITED;
  }

  if (status === 404) {
    return GeminiErrorCode.MODEL_NOT_FOUND;
  }

  return GeminiErrorCode.UNKNOWN;
}

/*
 * 応答から JSON を取り出す。
 *
 * responseMimeType に application/json を指定していても、本文は
 * candidates[].content.parts[].text に**文字列として**入る。
 * そのまま JSON.parse すると壊れた応答で例外になるため、包んで返す。
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

/* 必須項目（§FR-12）が揃っているか。欠けていたら AI-004 とする。 */
export function assertRequiredFields(result) {
  const required = ['companyName', 'fullName', 'email', 'phone', 'uncertainFields'];
  const missing = required.filter((key) => !(key in result));

  if (missing.length > 0) {
    throw new GeminiError(GeminiErrorCode.MISSING_FIELDS, 0, missing.join(','));
  }

  if (!Array.isArray(result.uncertainFields)) {
    throw new GeminiError(GeminiErrorCode.MISSING_FIELDS, 0, 'uncertainFields_not_array');
  }

  return result;
}

/*
 * 1回だけ呼ぶ。モデルの切り替えもリトライも呼び出し側の仕事にする。
 *
 * fetchImpl を差し替えられるようにしてあるのは、テストで実APIへ
 * 通信しないため（keystore-spec-v1.md §7 と同じ方針）。
 */
async function callOnce({ apiKey, model, text, fetchImpl, maxOutputTokens }) {
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
      body: JSON.stringify(buildGeminiRequest(text, { maxOutputTokens })),
    });
  } catch {
    /* 通信そのものが成立しなかった。原因の詳細は持たない。 */
    throw new GeminiError(GeminiErrorCode.NETWORK, 0, 'fetch_failed');
  }

  if (!response?.ok) {
    const status = Number(response?.status) || 0;
    throw new GeminiError(mapStatus(status), status, 'http_error');
  }

  let payload = null;

  try {
    payload = await response.json();
  } catch {
    throw new GeminiError(GeminiErrorCode.BAD_JSON, 200, 'body_not_json');
  }

  return assertRequiredFields(extractJson(payload));
}

/*
 * 名刺テキストを項目へ分類する。
 *
 * 主モデルが404のときだけ、フォールバックモデルで1回試す。
 * それ以外のエラーでは再試行しない。401/403 を繰り返し投げても
 * 結果は変わらず、無料枠のクォータを削るだけになる。
 */
export async function classifyCardText(text, {
  apiKey,
  model = DEFAULT_MODEL,
  fallbackModel = FALLBACK_MODEL,
  fetchImpl,
  maxOutputTokens = 400,
} = {}) {
  const key = String(apiKey ?? '').trim();

  if (key === '') {
    throw new GeminiError(GeminiErrorCode.KEY_MISSING, 0, 'no_key');
  }

  try {
    return await callOnce({ apiKey: key, model, text, fetchImpl, maxOutputTokens });
  } catch (error) {
    const isModelMissing = error instanceof GeminiError
      && error.code === GeminiErrorCode.MODEL_NOT_FOUND;

    if (!isModelMissing || !fallbackModel || fallbackModel === model) {
      throw error;
    }

    return callOnce({ apiKey: key, model: fallbackModel, text, fetchImpl, maxOutputTokens });
  }
}

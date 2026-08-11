/*
 * Gemini API の呼び出し（投稿文の生成）。
 *
 * ==================================================================
 * 方針（台本メーカー ../short-script/gemini.js と同じ）
 * ==================================================================
 *   - キーは `x-goog-api-key` ヘッダーに載せる。**URLへ載せない。**
 *   - キーを引数で受け取り、このモジュール内で保持しない。
 *   - 例外にキーを含めない。console にも出さない。
 *   - 外部SDKを使わず fetch で REST を直接叩く。
 *   - 主モデルが 404（廃止）のときだけフォールバックへ切り替える。
 *
 * **import はしない**方針（docs/repository-structure.md §4-1）に従い、
 * エラー分類は台本メーカーから**複製**している。共有モジュール化は、
 * 重複が実害になった時点で検討する。
 * ==================================================================
 */

import {
  DEFAULT_MODEL,
  FALLBACK_MODEL,
  GEMINI_ENDPOINT_BASE,
  GEMINI_HOST,
  MAX_OUTPUT_TOKENS,
  BODY_TARGET_MIN,
  BODY_TARGET_MAX,
  THEME_MAX_LENGTH,
} from './config.js';

export { GEMINI_HOST, DEFAULT_MODEL, FALLBACK_MODEL };

export const GeminiErrorCode = {
  KEY_MISSING: 'KEY_MISSING',
  KEY_REJECTED: 'KEY_REJECTED',
  BAD_REQUEST: 'BAD_REQUEST',
  RATE_LIMITED: 'RATE_LIMITED',
  MODEL_NOT_FOUND: 'MODEL_NOT_FOUND',
  EMPTY_TEXT: 'EMPTY_TEXT',
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
    case GeminiErrorCode.EMPTY_TEXT:
      return described('生成結果が空でした。テーマ・指示を変えてお試しください。', 'AI-004');
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
 * キーが悪いときは 401/403（台本メーカー gemini.js の注記と同じ）。
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
 * Gemini へ送る要求本文。
 * 事実の創作を防ぐ指示は、note 記事生成の既存実装（note-auto-fill-gas）から引き継ぐ。
 */
export function buildPostRequest(theme, { maxOutputTokens = MAX_OUTPUT_TOKENS } = {}) {
  const prompt = 'あなたは、note に投稿する記事を書く日本語のライターです。\n'
    + '以下のテーマ・指示をもとに、記事を1本作成してください。\n'
    + '\n'
    + '# 記事の方針\n'
    + `- 本文は ${BODY_TARGET_MIN}〜${BODY_TARGET_MAX} 文字程度にすること。\n`
    + '- 見出し（## 見出し）を適度に入れ、読みやすく構成すること。\n'
    + '- 過度に煽らないこと。「衝撃」のような誇張表現は使わないこと。\n'
    + '- テーマ・指示に無い数字・固有名詞・具体的なエピソードを追加しないこと（創作の禁止）。\n'
    + '- 未確認の情報を断定しないこと。一般論は「一般的には」と明示すること。\n'
    + '- 前置き・後書き・コードブロックを付けず、記事本文そのものだけを出力すること。\n'
    + '\n'
    + '# テーマ・指示\n'
    + String(theme ?? '').slice(0, THEME_MAX_LENGTH);

  return {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      /* 数値が小さいほど、事実に沿った落ち着いた文章になりやすい。 */
      temperature: 0.4,
      maxOutputTokens,
    },
  };
}

/*
 * 応答から本文を取り出す。コードフェンス（``` …```）や前後の空白は
 * 指示していても稀に付くため、剥がしておく。
 */
export function extractPostText(payload) {
  const text = payload?.candidates?.[0]?.content?.parts?.[0]?.text;

  if (typeof text !== 'string') {
    throw new GeminiError(GeminiErrorCode.EMPTY_TEXT, 0, 'no_text');
  }

  const cleaned = text
    .trim()
    .replace(/^```[a-z]*\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  if (cleaned === '') {
    throw new GeminiError(GeminiErrorCode.EMPTY_TEXT, 0, 'empty_text');
  }

  return cleaned;
}

/*
 * 1回だけ呼ぶ。モデルの切り替えは呼び出し側（generatePost）の仕事。
 * fetchImpl を差し替えられるのはテストで実APIへ通信しないため。
 */
async function callOnce({ apiKey, model, theme, fetchImpl, signal }) {
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
      body: JSON.stringify(buildPostRequest(theme)),
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
    throw new GeminiError(GeminiErrorCode.EMPTY_TEXT, 200, 'body_not_json');
  }

  return extractPostText(payload);
}

/*
 * テーマから投稿文を生成する。
 *
 * 主モデルが 404 のときだけ、フォールバックモデルで1回試す。
 * それ以外のエラーでは再試行しない（401/403 を繰り返しても結果は
 * 変わらず、無料枠のクォータを削るだけ）。
 */
export async function generatePost({ apiKey, theme, fetchImpl, signal }) {
  if (typeof apiKey !== 'string' || apiKey.trim() === '') {
    throw new GeminiError(GeminiErrorCode.KEY_MISSING, 0, 'no_key');
  }

  try {
    return await callOnce({ apiKey, model: DEFAULT_MODEL, theme, fetchImpl, signal });
  } catch (error) {
    if (error instanceof GeminiError && error.code === GeminiErrorCode.MODEL_NOT_FOUND) {
      return callOnce({ apiKey, model: FALLBACK_MODEL, theme, fetchImpl, signal });
    }

    throw error;
  }
}

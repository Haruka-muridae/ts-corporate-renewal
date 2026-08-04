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

/*
 * ==================================================================
 * ★ 切り分けのため、主モデルを一時的に入れ替えている（2026-08-04）
 * ==================================================================
 * `gemini-3.5-flash-lite` で 503 が出た。503 は「サービス利用不可」で、
 * Gemini では**モデルの混雑**で返ることが多い。リクエストの形の問題なら
 * 400 になるはずなので、形ではなく**そのモデルの空き具合**が原因である
 * 疑いが強い。
 *
 * それを実証するために、主とフォールバックを入れ替えてある。
 *
 *   `gemini-2.5-flash-lite` で通る  → 503 はモデル単位の混雑だった
 *   同じく 503 になる                → モデルによらない。キーや経路を疑う
 *
 * **これは恒久の設定ではない。** 要件定義書 §20 は初期設定モデルを
 * 「フェーズ0で確定」としており、この実験の結果をもって確定させる。
 * 結論が出たら、この注記ごと書き換えること。
 * ==================================================================
 */

/* 初期設定モデル（要件定義書 §FR-11、§20）。 */
export const DEFAULT_MODEL = 'gemini-2.5-flash-lite';

/*
 * 主モデルが404のときに1回だけ試すモデル。会社キーへは落とさない。
 *
 * **503 ではフォールバックしない。** 404（モデルが存在しない）だけを
 * 切り替えの条件にしている。混雑で別モデルへ逃がすかどうかは、
 * この実験の結果を見て決める（下の注記を参照）。
 */
export const FALLBACK_MODEL = 'gemini-3.5-flash-lite';

export const GeminiErrorCode = {
  KEY_MISSING: 'KEY_MISSING',
  KEY_REJECTED: 'KEY_REJECTED',
  /* リクエストの形が不正。**キーの問題と混ぜない。** */
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
    /*
     * サーバーが返した理由をそのまま持つ。
     * **画面とCSVへ出すのはこの値である。**「SYS-999」だけでは
     * 何が起きたのか分からず、切り分けができない。
     */
    this.detail = detail;
  }
}

/*
 * エラー応答から、原因の要約を取り出す。
 *
 * Gemini は失敗時に { error: { code, status, message } } を返す。
 * **message には原因がそのまま書かれている**（どのフィールドが不正か等）。
 * 長すぎると画面が壊れるので頭を切る。キーは本文に出ないため、
 * そのまま表示してよい。
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
 * 画面に出す言葉。エラーコードは要件定義書 §15 に対応する。
 *
 * **detail を必ず返す。** 「SYS-999 不明なエラー」だけを出す画面は、
 * 利用者にとっても開発者にとっても役に立たない。原因の要約を添える。
 *
 * GeminiError でない例外（こちらのコードの不具合）も、握りつぶさずに
 * 名前とメッセージを出す。**どこで壊れたのかが分からない状態を作らない。**
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
      return described('Gemini APIキーが設定されていません。', 'KEY-001');
    case GeminiErrorCode.KEY_REJECTED:
      return described('このAPIキーでは接続できませんでした。', 'KEY-002');
    case GeminiErrorCode.BAD_REQUEST:
      return described('リクエストの形式が不正です（キーの問題ではありません）。', 'AI-003');
    case GeminiErrorCode.RATE_LIMITED:
      return described('利用上限に達しています。無料枠の場合は時間をおいてお試しください。', 'AI-002');
    case GeminiErrorCode.MODEL_NOT_FOUND:
      return described('モデルが利用できませんでした。', 'AI-005');
    case GeminiErrorCode.BAD_JSON:
      return described('応答の形式が不正でした。', 'AI-003');
    case GeminiErrorCode.MISSING_FIELDS:
      return described('応答に必要な項目がありませんでした。', 'AI-004');
    case GeminiErrorCode.NETWORK:
      return described('通信に失敗しました。', 'AI-001');
    case GeminiErrorCode.SERVER_ERROR:
      /*
       * 503 は多くの場合「そのモデルが混んでいる」である。
       * 利用者の操作で直る種類のものではないので、待つよう案内する。
       */
      return described(
        error?.status === 503
          ? 'Gemini が混雑しています。時間をおくか、別のモデルをお試しください。'
          : 'Gemini 側でエラーが起きました。',
        'AI-001',
      );
    default:
      return described('不明なエラーが発生しました。', 'SYS-999');
  }
}

/*
 * HTTPステータスを分類する。
 *
 * **400 をキーの問題にしない**（2026-08-04 の修正）。
 * 400 はリクエストの形が不正なときに返る。キーが悪いときは 401/403 である。
 * 混ぜると、こちらの組み立て間違いを「キーを確認してください」と
 * 案内することになり、原因から遠ざかる。
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

    /*
     * **エラー本文を読んでから投げる。** ここを読み捨てると、
     * 「どのフィールドが不正か」をサーバーが教えてくれているのに
     * 画面には HTTP ステータスしか出ない。
     */
    let body = null;

    try {
      body = await response.json();
    } catch {
      /* JSON で無いこともある。その場合は status だけで要約する。 */
    }

    throw new GeminiError(mapStatus(status), status, summarizeErrorBody(body, status));
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

/*
 * このキーで使えるモデルの一覧を取る（GET）。
 *
 * ==================================================================
 * なぜ要るのか
 * ==================================================================
 * モデル名は要件定義書 §20 で「フェーズ0で確定」とされた**暫定値**である。
 * 名前が違えば 404 になるが、**404 を見ても正しい名前は分からない。**
 *
 * この一覧は Portal の疎通テストと同じ GET であり、実績のある呼び出しである。
 * 生成が失敗したときに「そもそもどのモデルが使えるのか」を、
 * 推測ではなく事実で確かめられるようにする。
 *
 * 戻り値: [{ name, displayName, supportsGenerate }]
 * ==================================================================
 */
export async function listModels({ apiKey, fetchImpl } = {}) {
  const key = String(apiKey ?? '').trim();

  if (key === '') {
    throw new GeminiError(GeminiErrorCode.KEY_MISSING, 0, 'no_key');
  }

  const impl = fetchImpl ?? globalThis.fetch;
  let response = null;

  try {
    response = await impl(GEMINI_ENDPOINT_BASE, {
      method: 'GET',
      headers: { 'x-goog-api-key': key },
    });
  } catch {
    throw new GeminiError(GeminiErrorCode.NETWORK, 0, 'fetch_failed');
  }

  if (!response?.ok) {
    const status = Number(response?.status) || 0;
    let body = null;

    try {
      body = await response.json();
    } catch { /* JSON で無いこともある */ }

    throw new GeminiError(mapStatus(status), status, summarizeErrorBody(body, status));
  }

  let payload = null;

  try {
    payload = await response.json();
  } catch {
    throw new GeminiError(GeminiErrorCode.BAD_JSON, 200, 'models_body_not_json');
  }

  const models = Array.isArray(payload?.models) ? payload.models : [];

  return models.map((model) => ({
    /* API は `models/xxx` の形で返す。呼び出しに使うのは後ろだけ。 */
    name: String(model?.name ?? '').replace(/^models\//, ''),
    displayName: String(model?.displayName ?? ''),
    supportsGenerate: Array.isArray(model?.supportedGenerationMethods)
      && model.supportedGenerationMethods.includes('generateContent'),
  }));
}

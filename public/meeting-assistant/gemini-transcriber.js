/*
 * Gemini API による文字起こし。
 *
 * ------------------------------------------------------------------
 * APIキーの扱い（このファイルで最も重要な点）
 * ------------------------------------------------------------------
 * APIキーは引数として受け取り、リクエストヘッダーへ載せる以外の用途に使わない。
 *
 *   保存しない … 変数へ溜め込まない。localStorage / sessionStorage / Cookie へ書かない
 *   出さない   … console へ出さない。エラーの detail へ入れない。URLへ入れない
 *   残さない   … 例外オブジェクトにも、返り値にも含めない
 *
 * Gemini の応答本文にも、キーやプロジェクト情報が混じることがある。
 * そのため応答のエラーメッセージを利用者へそのまま見せない。
 * このファイルが外へ渡すのはコード（GeminiErrorCode）だけである。
 * ------------------------------------------------------------------
 *
 * SDK（@google/genai）ではなく公式 REST を直接使う。
 * このアプリは npm ビルドを持たない素の ES Modules で構成されており、
 * SDK を入れるにはバンドラの導入が必要になる（既存構成を壊す）。
 * REST なら追加の依存なしで、同じ Files API / generateContent を叩ける。
 */

import { GEMINI, TRANSCRIPTION_PROMPT } from './config.js';

export const GeminiErrorCode = {
  API_KEY_MISSING: 'API_KEY_MISSING',
  API_KEY_INVALID: 'API_KEY_INVALID',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  QUOTA_EXCEEDED: 'QUOTA_EXCEEDED',
  MODEL_NOT_FOUND: 'MODEL_NOT_FOUND',
  AUDIO_NOT_SUPPORTED: 'AUDIO_NOT_SUPPORTED',
  UPLOAD_FAILED: 'UPLOAD_FAILED',
  FILE_PROCESSING_FAILED: 'FILE_PROCESSING_FAILED',
  FILE_TIMEOUT: 'FILE_TIMEOUT',
  GENERATION_FAILED: 'GENERATION_FAILED',
  EMPTY_RESULT: 'EMPTY_RESULT',
  NETWORK: 'NETWORK',
  SERVER_ERROR: 'SERVER_ERROR',
  CANCELLED: 'CANCELLED',
  UNKNOWN: 'UNKNOWN',
};

export class GeminiError extends Error {
  constructor(code, status = 0, detail = null) {
    super(code);
    this.name = 'GeminiError';
    this.code = code;
    this.status = status;
    /*
     * detail に入れてよいのは、こちらで用意した固定の識別子だけ。
     * APIの応答文やAPIキーは絶対に入れない。
     */
    this.detail = detail;
  }
}

/* ---------- 共通 ---------- */

const baseUrl = () => `${GEMINI.apiBase}/${GEMINI.apiVersion}`;

/*
 * APIキーは必ずヘッダーで送る。
 * クエリ文字列（?key=...）へ入れると、リファラーやブラウザの履歴、
 * 中継サーバーのアクセスログへ残る恐れがある。
 */
function authHeaders(apiKey) {
  return { 'x-goog-api-key': apiKey };
}

export function normalizeApiKey(value) {
  /*
   * 貼り付け時に混ざる前後の空白と改行だけを落とす。
   * 形式の検証はしない。キーの体系は Google の都合で変わるため、
   * こちらで正規表現を決め打ちすると、正しいキーを弾く事故が起きる。
   */
  return String(value ?? '').trim();
}

async function readJsonSafely(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/*
 * HTTPステータスと応答本文からコードを決める。
 *
 * 本文の message は分類にだけ使い、外へは出さない。
 * （割り当て超過の案内などにプロジェクトIDが含まれることがあるため）
 */
export function mapGeminiError(status, body) {
  const reason = String(body?.error?.status ?? '');
  const message = String(body?.error?.message ?? '');

  if (status === 400) {
    if (/API key not valid|API_KEY_INVALID/i.test(message) || reason === 'INVALID_ARGUMENT') {
      if (/API key/i.test(message)) {
        return GeminiErrorCode.API_KEY_INVALID;
      }

      /* 音声パートを受け付けないモデルはここへ来ることが多い。 */
      if (/audio|inline_data|file_data|not supported/i.test(message)) {
        return GeminiErrorCode.AUDIO_NOT_SUPPORTED;
      }
    }

    return GeminiErrorCode.GENERATION_FAILED;
  }

  if (status === 401) {
    return GeminiErrorCode.API_KEY_INVALID;
  }

  if (status === 403) {
    if (/quota|billing/i.test(message)) {
      return GeminiErrorCode.QUOTA_EXCEEDED;
    }

    return GeminiErrorCode.PERMISSION_DENIED;
  }

  if (status === 404) {
    return GeminiErrorCode.MODEL_NOT_FOUND;
  }

  if (status === 429) {
    return GeminiErrorCode.QUOTA_EXCEEDED;
  }

  if (status >= 500) {
    return GeminiErrorCode.SERVER_ERROR;
  }

  return GeminiErrorCode.UNKNOWN;
}

async function geminiFetch(url, { apiKey, method = 'GET', headers = {}, body = null, signal, label = 'fetch' }) {
  let response;

  try {
    response = await fetch(url, {
      method,
      headers: { ...authHeaders(apiKey), ...headers },
      body,
      signal,
    });
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new GeminiError(GeminiErrorCode.CANCELLED, 0, 'aborted');
    }

    /*
     * detail は「どの通信で失敗したか」を表す固定の識別子だけにする。
     * error.name（TypeError 等）や応答本文は入れない（診断を画面に出すため、
     * 機密が混じらない語彙に限定する）。呼び出し側が label で箇所を指定する。
     */
    throw new GeminiError(GeminiErrorCode.NETWORK, 0, label);
  }

  if (!response.ok) {
    const errorBody = await readJsonSafely(response);
    /* 第3引数はこちらで決めた識別子のみ。応答本文は渡さない。 */
    throw new GeminiError(mapGeminiError(response.status, errorBody), response.status, 'http_error');
  }

  return response;
}

/* ---------- モデルの選択 ---------- */

/*
 * 利用者のキーで実際に使えるモデルを調べる。
 *
 * モデル名を古い知識で決め打ちしないための仕組み。
 * 一覧が取れなければ null を返し、呼び出し側は config.js の候補を順に試す。
 */
export async function listUsableModels({ apiKey, signal }) {
  try {
    const collected = [];
    let pageToken = '';

    /*
     * 一覧はページ分割される。
     * 目的のモデルが2ページ目以降にあると取りこぼすため、最後までたどる。
     * 暴走を防ぐためページ数には上限を置く。
     */
    for (let page = 0; page < 10; page += 1) {
      const params = new URLSearchParams({ pageSize: '200' });

      if (pageToken) {
        params.set('pageToken', pageToken);
      }

      const response = await geminiFetch(`${baseUrl()}/models?${params}`, { apiKey, signal, label: 'models-list' });
      const body = await readJsonSafely(response);

      if (Array.isArray(body?.models)) {
        collected.push(...body.models);
      }

      pageToken = typeof body?.nextPageToken === 'string' ? body.nextPageToken : '';

      if (!pageToken) {
        break;
      }
    }

    return collected
      .filter((model) => Array.isArray(model?.supportedGenerationMethods)
        && model.supportedGenerationMethods.includes('generateContent'))
      .map((model) => String(model?.name ?? '').replace(/^models\//, ''))
      .filter((id) => id !== '');
  } catch (error) {
    if (error instanceof GeminiError && error.code === GeminiErrorCode.CANCELLED) {
      throw error;
    }

    /* 一覧が取れないこと自体は失敗にしない。候補の総当たりへ落とす。 */
    return null;
  }
}

/*
 * 実際に使うモデルの順序を決める。
 *
 *   1. 利用者が明示的に選んだモデルがあれば、それを先頭に置く
 *   2. models.list が取れていれば、そこに存在する候補だけを残す
 *   3. どちらも無ければ config.js の候補をそのままの順で使う
 */
export function resolveModelOrder({ preferredId, availableIds }) {
  const configured = GEMINI.models.map((model) => model.id);
  const ordered = [];

  if (preferredId && preferredId !== 'auto') {
    ordered.push(preferredId);
  }

  configured.forEach((id) => {
    if (!ordered.includes(id)) {
      ordered.push(id);
    }
  });

  if (!Array.isArray(availableIds) || availableIds.length === 0) {
    return ordered;
  }

  const usable = ordered.filter((id) => availableIds.includes(id));

  /*
   * 候補がどれも一覧に無い場合（新しいモデルへ入れ替わった直後など）は、
   * 一覧側から拾って救済する。
   *
   * ここへ来る時点で availableIds は
   * 「generateContent に対応するモデル」だけに絞り込んである。
   * ただし v1beta の models.list は入力モダリティを返さないため、
   * 「音声を受け付けるか」はこの一覧からは判定できない。
   * 名前で当たりを付けたうえで、音声を扱えないことが名前から明らかなもの
   * （画像生成・読み上げ・埋め込み・音声対話専用）を除く。
   *
   * それでも外れる可能性は残るので、最終的な可否は generateContent の
   * 応答で判断する（AUDIO_NOT_SUPPORTED なら次の候補へ落とす）。
   */
  if (usable.length > 0) {
    return usable;
  }

  return availableIds.filter((id) => (
    /flash/i.test(id) && !/live|image|imagen|tts|audio-dialog|embedding|aqa/i.test(id)
  ));
}

/*
 * 画面の「Gemini API：接続済み / 未設定 / 接続エラー」表示のための軽量な疎通確認。
 *
 * listUsableModels と同じ GET /models を使うが、あちらは「使えるモデルの
 * 絞り込み」が目的でページを最後まで辿り、失敗も握りつぶして null を返す。
 * こちらは画面表示用の ok/ng だけが欲しいので、1件だけ取得して即座に判定する
 * （pageSize=1。生成系 generateContent は使わない＝押しただけで課金は発生しない。
 * keystore-spec-v1.md §8-2 の疎通テストと同じ判断）。
 *
 * 新しい fetch 経路は作らず、このファイル内の geminiFetch をそのまま使う
 * （Gemini 呼び出しを二重化しない）。
 *
 * APIキーは引数で受け取って使うだけで、ここにも保持しない。
 * 例外は投げない（呼び出し側の状態表示を止めないため）。
 *
 * ------------------------------------------------------------------
 * 失敗の理由を捨てない
 * ------------------------------------------------------------------
 * 以前は ok だけを返していた。geminiFetch は HTTP ステータスを持つ
 * GeminiError を投げているのに、それをここで握り潰していたため、
 * 画面は「接続エラー」としか言えず、キーが無効なのか・権限が無いのか・
 * 利用上限なのか・そもそも通信できていないのかを、利用者も開発者も
 * 判別できなかった（実際にその状態の問い合わせが起きた）。
 *
 * detail（応答本文）は返さない。GeminiError.detail はこちらで決めた
 * 固定の識別子だけを持つ約束だが、ここでは code と status しか要らない。
 * ------------------------------------------------------------------
 *
 * 戻り値: { ok: boolean, code: string|null, status: number }
 *   code   … GeminiErrorCode のいずれか（成功時は null）
 *   status … HTTP ステータス。通信自体が届かなかったときは 0
 */
export async function checkGeminiConnection({ apiKey, signal } = {}) {
  const key = normalizeApiKey(apiKey);

  if (key === '') {
    return { ok: false, code: GeminiErrorCode.API_KEY_MISSING, status: 0 };
  }

  try {
    await geminiFetch(`${baseUrl()}/models?pageSize=1`, { apiKey: key, signal, label: 'connection' });
    return { ok: true, code: null, status: 200 };
  } catch (error) {
    if (error instanceof GeminiError && error.code === GeminiErrorCode.CANCELLED) {
      throw error;
    }

    if (error instanceof GeminiError) {
      return { ok: false, code: error.code, status: error.status };
    }

    return { ok: false, code: GeminiErrorCode.UNKNOWN, status: 0 };
  }
}

/* ---------- Files API ---------- */

/*
 * 音声を Files API へアップロードする（resumable プロトコル）。
 *
 * Drive から取得した音声もここを通る。
 * Drive の URL を Gemini へ渡すことはしない（Google 側に読む権限が無いため）。
 *
 * 戻り値: { uri, name, mimeType }
 */
export async function uploadAudio({ apiKey, blob, displayName, signal, onProgress }) {
  const mimeType = blob.type || 'audio/mpeg';
  const numBytes = String(blob.size);

  onProgress?.({ phase: 'uploading', ratio: 0 });

  const startResponse = await geminiFetch(`${GEMINI.apiBase}/upload/${GEMINI.apiVersion}/files`, {
    apiKey,
    signal,
    label: 'upload-start',
    method: 'POST',
    headers: {
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': numBytes,
      'X-Goog-Upload-Header-Content-Type': mimeType,
      'Content-Type': 'application/json',
    },
    /* 表示名はファイル名。Google側の管理画面に出るだけで、内容には影響しない。 */
    body: JSON.stringify({ file: { display_name: displayName } }),
  });

  const uploadUrl = startResponse.headers.get('x-goog-upload-url');

  if (!uploadUrl) {
    throw new GeminiError(GeminiErrorCode.UPLOAD_FAILED, 0, 'upload_url_missing');
  }

  onProgress?.({ phase: 'uploading', ratio: 0.1 });

  /*
   * 本体の送信。
   * この URL は開始応答で発行された一時的なもので、キーは不要（付けても害はないが送らない）。
   * fetch では送信の進捗を取れないため、段階的な目安だけを返す。
   */
  let uploadResponse;

  try {
    uploadResponse = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        /*
         * Content-Length は付けない。
         * ブラウザでは設定禁止のヘッダーで、指定しても無視される。
         * body が Blob なので、ブラウザが実際の長さを自動で付ける。
         */
        'X-Goog-Upload-Offset': '0',
        'X-Goog-Upload-Command': 'upload, finalize',
      },
      body: blob,
      signal,
    });
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new GeminiError(GeminiErrorCode.CANCELLED, 0, 'aborted');
    }

    throw new GeminiError(GeminiErrorCode.NETWORK, 0, 'upload-body');
  }

  if (!uploadResponse.ok) {
    const errorBody = await readJsonSafely(uploadResponse);
    throw new GeminiError(mapGeminiError(uploadResponse.status, errorBody), uploadResponse.status, 'upload_http_error');
  }

  const body = await readJsonSafely(uploadResponse);
  const file = body?.file;

  if (!file?.uri || !file?.name) {
    throw new GeminiError(GeminiErrorCode.UPLOAD_FAILED, 0, 'file_uri_missing');
  }

  onProgress?.({ phase: 'uploading', ratio: 0.9 });

  return {
    uri: String(file.uri),
    name: String(file.name),
    mimeType: String(file.mimeType ?? mimeType),
    state: String(file.state ?? 'PROCESSING'),
  };
}

/*
 * アップロード直後のファイルは PROCESSING のことがある。
 * ACTIVE になるまで待ってから生成を呼ぶ。
 */
export async function waitUntilActive({ apiKey, fileName, initialState, signal, onProgress }) {
  if (initialState === 'ACTIVE') {
    return;
  }

  const deadline = Date.now() + GEMINI.pollTimeoutMs;

  for (;;) {
    if (signal?.aborted) {
      throw new GeminiError(GeminiErrorCode.CANCELLED, 0, 'aborted');
    }

    const response = await geminiFetch(`${baseUrl()}/${fileName}`, { apiKey, signal, label: 'upload-poll' });
    const body = await readJsonSafely(response);
    const state = String(body?.state ?? '');

    if (state === 'ACTIVE') {
      onProgress?.({ phase: 'uploading', ratio: 1 });
      return;
    }

    if (state === 'FAILED') {
      throw new GeminiError(GeminiErrorCode.FILE_PROCESSING_FAILED, 0, 'state_failed');
    }

    if (Date.now() >= deadline) {
      throw new GeminiError(GeminiErrorCode.FILE_TIMEOUT, 0, 'poll_timeout');
    }

    onProgress?.({ phase: 'uploading', ratio: null });

    await new Promise((resolve) => {
      window.setTimeout(resolve, GEMINI.pollIntervalMs);
    });
  }
}

/*
 * 不要になったファイルを削除する。
 *
 * 放置しても48時間で自動的に消えるが、利用者の音声を必要以上に
 * Google 側へ置いておく理由は無いので、終わったら消す。
 * 削除の失敗は全体の失敗にしない（文字起こしは既に取れているため）。
 */
export async function deleteUploadedFile({ apiKey, fileName }) {
  try {
    await geminiFetch(`${baseUrl()}/${fileName}`, { apiKey, method: 'DELETE', label: 'delete-file' });
    return true;
  } catch {
    return false;
  }
}

/* ---------- 生成 ---------- */

/*
 * 応答に混ざる Markdown のコードブロックを外す。
 * 「本文のみ返せ」と指示していても、囲って返してくることがある。
 */
export function stripCodeFence(text) {
  const trimmed = String(text ?? '').trim();
  const fenced = /^```[^\n]*\n([\s\S]*?)\n?```$/.exec(trimmed);

  return fenced ? fenced[1].trim() : trimmed;
}

function buildPrompt({ language, withTimestamps }) {
  const lines = [TRANSCRIPTION_PROMPT];

  if (language === 'en') {
    lines.push('', '注記: この音声は英語です。英語のまま文字起こししてください。');
  } else if (language === 'auto') {
    lines.push('', '注記: 話されている言語を判定し、その言語のまま文字起こししてください。');
  }

  if (!withTimestamps) {
    lines.push('', '注記: タイムスタンプは付けないでください。');
  }

  return lines.join('\n');
}

function extractText(body) {
  const parts = body?.candidates?.[0]?.content?.parts;

  if (!Array.isArray(parts)) {
    return '';
  }

  return parts
    .map((part) => (typeof part?.text === 'string' ? part.text : ''))
    .join('')
    .trim();
}

/*
 * アップロード済みのファイルを指定して文字起こしを生成する。
 * モデルは順に試し、そのモデル固有の失敗なら次へ落とす。
 *
 * 戻り値: { text, modelId }
 */
export async function generateTranscript({ apiKey, fileUri, mimeType, modelOrder, language, withTimestamps, signal, onProgress }) {
  const prompt = buildPrompt({ language, withTimestamps });
  let lastError = null;

  for (const modelId of modelOrder) {
    if (signal?.aborted) {
      throw new GeminiError(GeminiErrorCode.CANCELLED, 0, 'aborted');
    }

    onProgress?.({ phase: 'transcribing', modelId, ratio: null });

    const requestBody = JSON.stringify({
      contents: [{
        role: 'user',
        parts: [
          { text: prompt },
          { file_data: { mime_type: mimeType, file_uri: fileUri } },
        ],
      }],
      generationConfig: {
        /* 聞こえたとおりに書き起こさせたいので、ゆらぎは最小にする。 */
        temperature: 0,
      },
    });

    try {
      const response = await geminiFetch(
        `${baseUrl()}/models/${encodeURIComponent(modelId)}:generateContent`,
        {
          apiKey,
          signal,
          label: 'generate',
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: requestBody,
        },
      );

      const body = await readJsonSafely(response);
      const text = stripCodeFence(extractText(body));

      if (text === '') {
        lastError = new GeminiError(GeminiErrorCode.EMPTY_RESULT, 0, 'empty_text');
        continue;
      }

      return { text, modelId };
    } catch (error) {
      if (!(error instanceof GeminiError)) {
        throw error;
      }

      lastError = error;

      /*
       * モデル固有の失敗だけ次の候補へ回す。
       * キーの不正や割り当て超過は、どのモデルでも同じ結果になるので即座に止める。
       */
      const retriable = error.code === GeminiErrorCode.MODEL_NOT_FOUND
        || error.code === GeminiErrorCode.AUDIO_NOT_SUPPORTED
        || error.code === GeminiErrorCode.SERVER_ERROR;

      if (!retriable) {
        throw error;
      }
    }
  }

  throw lastError ?? new GeminiError(GeminiErrorCode.GENERATION_FAILED, 0, 'no_model');
}

/* ---------- 全体の流れ ---------- */

/*
 * Blob を Gemini で文字起こしする。
 *
 *   モデルの確認 → Files API へアップロード → ACTIVE を待つ
 *     → generateContent → アップロードしたファイルを削除
 *
 * apiKey は呼び出しのたびに引数で受け取り、このモジュールには残さない。
 *
 * 戻り値: { text, modelId }
 */
export async function transcribeWithGemini(blob, {
  apiKey,
  displayName,
  preferredModelId = GEMINI.defaultModelId,
  language = 'ja',
  withTimestamps = true,
  signal,
  onProgress,
} = {}) {
  const key = normalizeApiKey(apiKey);

  if (key === '') {
    throw new GeminiError(GeminiErrorCode.API_KEY_MISSING, 0, 'empty_key');
  }

  /*
   * モデル一覧 API（models.list）は呼ばない。
   * 一覧取得は Gemini への実リクエストであり、接続確認と同じく
   * 利用制限を消費する。候補順は config.js の GEMINI.models に固定する。
   */
  onProgress?.({ phase: 'checking-model', ratio: null });

  const modelOrder = resolveModelOrder({
    preferredId: preferredModelId === 'auto' ? GEMINI.defaultModelId : preferredModelId,
    availableIds: null,
  });

  if (modelOrder.length === 0) {
    throw new GeminiError(GeminiErrorCode.MODEL_NOT_FOUND, 0, 'no_candidate');
  }

  const uploaded = await uploadAudio({ apiKey: key, blob, displayName, signal, onProgress });

  try {
    await waitUntilActive({
      apiKey: key,
      fileName: uploaded.name,
      initialState: uploaded.state,
      signal,
      onProgress,
    });

    return await generateTranscript({
      apiKey: key,
      fileUri: uploaded.uri,
      mimeType: uploaded.mimeType,
      modelOrder,
      language,
      withTimestamps,
      signal,
      onProgress,
    });
  } finally {
    /* 成功・失敗・中断のいずれでも、置きっぱなしにしない。 */
    await deleteUploadedFile({ apiKey: key, fileName: uploaded.name });
  }
}

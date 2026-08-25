/*
 * 開発者向けの診断ログ（console）。
 *
 * ------------------------------------------------------------------
 * 出してよいもの・出さないもの
 * ------------------------------------------------------------------
 * 出す   … 処理段階、エラーの name / code / HTTP status、こちらで決めた固定の detail、
 *          録音の識別子・バイト数・MIME・秒数
 * 出さない … 音声データ、APIキー、アクセストークン、Google / Gemini の応答本文、
 *          利用者が入力した所属・氏名（ファイル名にも含まれるため出さない）
 *
 * GeminiError.detail は gemini-transcriber.js / gemini-minutes.js が
 * 「固定の識別子だけを入れる」と約束している値。AppError.message も
 * 'http_401' のような開発者向けの短い識別子。これらはそのまま出す。
 * それ以外の例外（DOMException・TypeError 等）の message はブラウザが作る
 * 文で秘密情報を含まないため、長さだけ制限して出す。
 * ------------------------------------------------------------------
 */

const PREFIX = '[meeting-assistant]';
const MAX_MESSAGE_CHARS = 200;

function isSafeCodedError(error) {
  return error?.name === 'AppError' || error?.name === 'GeminiError';
}

/* 例外から、ログに載せてよい情報だけを取り出す。 */
export function summarizeError(error) {
  if (!error || typeof error !== 'object') {
    return { name: 'Error', message: String(error ?? '').slice(0, MAX_MESSAGE_CHARS) };
  }

  const summary = { name: String(error.name ?? 'Error') };

  if (error.code !== undefined) {
    summary.code = String(error.code);
  }

  if (Number.isFinite(error.status) && error.status !== 0) {
    summary.status = error.status;
  }

  if (isSafeCodedError(error)) {
    /* detail / message は固定の識別子だけという約束の値。 */
    if (error.detail !== undefined && error.detail !== null && error.detail !== '') {
      summary.detail = String(error.detail).slice(0, MAX_MESSAGE_CHARS);
    }

    if (typeof error.message === 'string' && error.message !== '' && error.message !== summary.code) {
      summary.detail = summary.detail ?? error.message.slice(0, MAX_MESSAGE_CHARS);
    }
  } else if (typeof error.message === 'string' && error.message !== '') {
    summary.message = error.message.slice(0, MAX_MESSAGE_CHARS);
  }

  /* 原因の例外（AppError.cause）も同じ規則で 1 段だけ添える。 */
  if (error.cause && typeof error.cause === 'object') {
    const cause = error.cause;
    summary.cause = {
      name: String(cause.name ?? 'Error'),
      ...(cause.code !== undefined ? { code: String(cause.code) } : {}),
      ...(typeof cause.message === 'string' && !isSafeCodedError(cause)
        ? { message: cause.message.slice(0, MAX_MESSAGE_CHARS) }
        : {}),
    };
  }

  return summary;
}

/* 録音の識別に必要な最小限（個人名を含むファイル名は出さない）。 */
export function summarizeRecording(entry) {
  if (!entry) {
    return {};
  }

  return {
    recordingId: String(entry.recordingId ?? ''),
    state: String(entry.state ?? ''),
    sizeBytes: Number(entry.sizeBytes) || 0,
    durationSeconds: Number(entry.durationSeconds) || 0,
    mimeType: String(entry.mimeType ?? ''),
    driveSaved: String(entry.driveFileId ?? '') !== '',
  };
}

export function createDiagnostics(console_ = globalThis.console) {
  const target = console_ ?? null;

  return {
    stage(stage, info = {}) {
      target?.info?.(PREFIX, 'stage', stage, info);
    },
    failure(stage, error, info = {}) {
      target?.error?.(PREFIX, 'failed', stage, { ...info, error: summarizeError(error) });
    },
  };
}

export const diagnostics = createDiagnostics();

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

/*
 * 直近 1 件の失敗を、画面に出してよい 4 項目（stage / code / status / detail）だけ
 * sessionStorage に残す。iPhone のように DevTools を開けない実機で、
 * console を見なくても失敗箇所を確認できるようにするため。
 *
 * 音声・APIキー・トークン・氏名・Gemini 応答本文・URL 全文は入れない。
 * code / status / detail は summarizeError が固定の識別子だけに絞った値。
 * stage は 'gemini:uploading' のような段階名。いずれも機密を含まない。
 */
export const DIAGNOSTIC_KEY = 'meeting-assistant-diagnostic';

function getSessionStorage(storage) {
  if (storage !== undefined) {
    return storage;
  }

  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

/* 保存・表示してよい形に絞る。ここを通さない値は画面へ出さない。 */
export function toDiagnostic(stage, error) {
  const summary = summarizeError(error);
  return {
    stage: String(stage ?? ''),
    code: summary.code ? String(summary.code) : '',
    status: Number.isFinite(summary.status) ? summary.status : 0,
    detail: summary.detail ? String(summary.detail) : '',
  };
}

export function createDiagnostics(console_ = globalThis.console, storage_ = undefined) {
  const target = console_ ?? null;
  const storage = getSessionStorage(storage_);
  /* 直近に記録した段階。失敗時に「どの段階で落ちたか」を添えるために覚える。 */
  let lastStage = '';
  /*
   * この読み込み（ページ）の中で失敗を記録したか。true のときだけ画面へ診断を出す。
   * sessionStorage には残すが、ページを再読み込みすると fresh は false に戻るので、
   * リロード後の無関係なエラー表示に古い診断が紛れ込まない。
   */
  let fresh = false;

  function save(record) {
    if (!storage) {
      return;
    }

    try {
      storage.setItem(DIAGNOSTIC_KEY, JSON.stringify(record));
    } catch {
      /* プライベートモード等。診断が残らないだけで通常動作は続ける。 */
    }
  }

  return {
    stage(stage, info = {}) {
      lastStage = String(stage ?? '');
      target?.info?.(PREFIX, 'stage', stage, info);
    },
    failure(stage, error, info = {}) {
      target?.error?.(PREFIX, 'failed', stage, { ...info, error: summarizeError(error) });
      /* 段階は、より細かい直近の stage（gemini:uploading 等）を優先して残す。 */
      fresh = true;
      save(toDiagnostic(lastStage || stage, error));
    },
    /* save-flow を経由しない経路（Drive 画面からの処理）から直接記録する。 */
    recordFailure(error, stage) {
      fresh = true;
      save(toDiagnostic(stage ?? lastStage, error));
    },
    /* 画面へ出すのはこちら。この読み込みで記録した失敗のときだけ返す。 */
    readFreshFailure() {
      return fresh ? this.readFailure() : null;
    },
    readFailure() {
      if (!storage) {
        return null;
      }

      try {
        const raw = storage.getItem(DIAGNOSTIC_KEY);
        const parsed = raw ? JSON.parse(raw) : null;

        if (!parsed || typeof parsed !== 'object') {
          return null;
        }

        return {
          stage: String(parsed.stage ?? ''),
          code: String(parsed.code ?? ''),
          status: Number.isFinite(parsed.status) ? parsed.status : 0,
          detail: String(parsed.detail ?? ''),
        };
      } catch {
        return null;
      }
    },
    clearFailure() {
      fresh = false;

      if (!storage) {
        return;
      }

      try {
        storage.removeItem(DIAGNOSTIC_KEY);
      } catch {
        /* noop */
      }
    },
  };
}

export const diagnostics = createDiagnostics();

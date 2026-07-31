/*
 * 開発者向けログ。
 *
 * 役割の分離:
 *   - 利用者向けの日本語文言 … errors.js
 *   - 技術的詳細（コード、ステータス、件数、所要時間） … このファイル
 *
 * 出力先:
 *   1. メモリ上のリングバッファ（エラーログ画面が購読する）
 *   2. IndexedDB の syncLogs テーブル（sink を注入。db.js との循環参照を避ける）
 *   3. console（開発時のみ）
 *
 * 記録してはならないもの:
 *   アクセストークン / IDトークン / 本文全体 / 認証ヘッダー。
 *   値は sanitize() で機械的に落とす。
 */

const MAX_BUFFER = 500;

export const LogLevel = Object.freeze({
  DEBUG: 'debug',
  INFO: 'info',
  WARN: 'warn',
  ERROR: 'error',
});

const LEVEL_ORDER = { debug: 10, info: 20, warn: 30, error: 40 };

const buffer = [];
const listeners = new Set();

let persistSink = null;
let minLevel = LogLevel.INFO;
let consoleEnabled = import.meta.env?.DEV === true;

/* トークン等が紛れ込む可能性のあるキー。値は残さず伏せる。 */
const REDACT_KEYS = /token|authorization|secret|password|credential|apikey|api_key|bearer/i;

function sanitizeValue(value, depth = 0) {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === 'string') {
    /* 長い文字列は本文の可能性があるため切り詰める。 */
    return value.length > 300 ? `${value.slice(0, 300)}…(${value.length}文字)` : value;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (depth >= 3) {
    return '[depth]';
  }

  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => sanitizeValue(item, depth + 1));
  }

  if (typeof value === 'object') {
    const out = {};
    Object.keys(value).slice(0, 30).forEach((key) => {
      out[key] = REDACT_KEYS.test(key) ? '[redacted]' : sanitizeValue(value[key], depth + 1);
    });
    return out;
  }

  return String(value);
}

function push(entry) {
  buffer.push(entry);

  if (buffer.length > MAX_BUFFER) {
    buffer.splice(0, buffer.length - MAX_BUFFER);
  }

  listeners.forEach((listener) => {
    try {
      listener(entry);
    } catch {
      /* 購読者の例外でログ経路を壊さない。 */
    }
  });

  if (persistSink && LEVEL_ORDER[entry.level] >= LEVEL_ORDER[LogLevel.INFO]) {
    /*
     * 保存の失敗でアプリを止めない。
     * ここで await しない（ログのためにUIを待たせない）。
     */
    Promise.resolve()
      .then(() => persistSink(entry))
      .catch(() => {});
  }

  if (consoleEnabled) {
    const method = entry.level === LogLevel.ERROR
      ? 'error'
      : entry.level === LogLevel.WARN ? 'warn' : 'log';
    /* eslint-disable-next-line no-console */
    console[method](`[knowledge] ${entry.event}`, entry.detail ?? '');
  }
}

function log(level, event, detail, extra = {}) {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) {
    return;
  }

  push({
    at: new Date().toISOString(),
    level,
    event: String(event),
    detail: detail === undefined ? null : sanitizeValue(detail),
    fileId: typeof extra.fileId === 'string' ? extra.fileId : null,
    code: typeof extra.code === 'string' ? extra.code : null,
  });
}

export const logger = {
  debug: (event, detail, extra) => log(LogLevel.DEBUG, event, detail, extra),
  info: (event, detail, extra) => log(LogLevel.INFO, event, detail, extra),
  warn: (event, detail, extra) => log(LogLevel.WARN, event, detail, extra),

  /*
   * error は AppError を受け取ってもよい。
   * その場合 code を自動で取り出し、detail には安全化した情報だけを残す。
   */
  error(event, errorOrDetail, extra = {}) {
    const isError = errorOrDetail instanceof Error;
    const code = extra.code ?? (isError ? errorOrDetail.code : undefined);

    const detail = isError
      ? {
        name: errorOrDetail.name,
        message: errorOrDetail.message,
        detail: errorOrDetail.detail ?? null,
        /* スタックは開発時のみ。保存もしない。 */
        stack: import.meta.env?.DEV ? String(errorOrDetail.stack ?? '').slice(0, 800) : undefined,
      }
      : errorOrDetail;

    log(LogLevel.ERROR, event, detail, { ...extra, code });
  },

  /* 直近のログをすべて返す（新しい順）。 */
  snapshot() {
    return buffer.slice().reverse();
  },

  clearBuffer() {
    buffer.length = 0;
    listeners.forEach((listener) => {
      try {
        listener(null);
      } catch {
        /* 通知失敗は無視する。 */
      }
    });
  },

  subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },

  /* IndexedDB への保存経路を注入する（db.js 側から呼ぶ）。 */
  setPersistSink(sink) {
    persistSink = typeof sink === 'function' ? sink : null;
  },

  setMinLevel(level) {
    if (LEVEL_ORDER[level]) {
      minLevel = level;
    }
  },

  setConsoleEnabled(enabled) {
    consoleEnabled = Boolean(enabled);
  },

  getConsoleEnabled() {
    return consoleEnabled;
  },
};

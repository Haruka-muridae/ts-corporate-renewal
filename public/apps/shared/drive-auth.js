/*
 * Google APIのアクセストークン取得（OAuth 2.0 Token Model）。
 * /apps/ 配下の全アプリが共有する認可層。
 *
 * ------------------------------------------------------------------
 * ログインと認可の分離（重要）
 * ------------------------------------------------------------------
 * /apps/ のGoogleログイン（apps/google-auth.js）が扱うのは **IDトークン** で、
 * 「誰がログインしているか」を画面に表示するためだけのもの。
 *
 * このファイルが扱うのは **アクセストークン** で、Drive API などを呼ぶための
 * 認可情報。両者はまったく別物であり、混同してはならない。
 *
 *   IDトークン      … google.accounts.id      / ログイン時に取得 / 表示専用
 *   アクセストークン … google.accounts.oauth2 / 利用者の操作時のみ取得
 *
 * アプリ起動時に権限を要求しない。利用者がボタンを押した時だけ要求する。
 * ------------------------------------------------------------------
 *
 * 保存方針:
 *   アクセストークンは **メモリ上だけ** で保持する。
 *   sessionStorage / localStorage / cookie / URL / ログ / 外部送信のいずれにも残さない。
 *   ページを再読み込みすれば消え、再認可が必要になる（意図した挙動）。
 *
 * 既定スコープは drive.file のみ。
 * これはこのアプリが作成した、または利用者が明示的に選んだファイルだけを
 * 対象とする権限で、Drive全体を読み書きする権限ではない。
 * スコープを増やす場合は呼び出し側が明示的に渡す（既定値は変えない）。
 *
 * client secret / refresh token / APIキーは使用しない（静的サイトのため置けない）。
 *
 * ------------------------------------------------------------------
 * 出自
 * ------------------------------------------------------------------
 * apps/voice-recorder/drive-auth.js と
 * apps/knowledge-src/src/auth/google-auth.js のほぼ同一だった2実装を統合した。
 *   voice-recorder 側から … login_hint によるアカウント選択の誘導
 *   knowledge 側から     … 応答が返らない場合のタイムアウト
 *   本ファイルで追加     … スコープごとのトークン管理 / withAccessToken()
 *
 * Phase 1 の時点では、この共通版はまだどのアプリからも使われていない。
 * 既存2実装は従来どおり独立して動作する（Phase 2 で移行する）。
 * ------------------------------------------------------------------
 */

import { GOOGLE_AUTH_CONFIG, isClientIdConfigured } from '../auth-config.js';
import { loadGisScript } from '../gis-loader.js';
import { loadProfile } from '../auth-session.js';

/*
 * このアプリが作成した、または利用者が明示的に選んだファイルだけを対象とするスコープ。
 * 既定はこれ1つ。安易に増やさないこと（機密スコープの追加は審査対象になり得る）。
 */
export const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

export const DriveAuthErrorCode = Object.freeze({
  CLIENT_ID_MISSING: 'CLIENT_ID_MISSING',
  GIS_LOAD_FAILED: 'GIS_LOAD_FAILED',
  POPUP_CLOSED: 'POPUP_CLOSED',
  POPUP_BLOCKED: 'POPUP_BLOCKED',
  ACCESS_DENIED: 'ACCESS_DENIED',
  SCOPE_NOT_GRANTED: 'SCOPE_NOT_GRANTED',
  TIMEOUT: 'TIMEOUT',
  REQUEST_IN_FLIGHT: 'REQUEST_IN_FLIGHT',
  UNKNOWN: 'UNKNOWN',
});

export class DriveAuthError extends Error {
  constructor(code, detail) {
    super(code);
    this.name = 'DriveAuthError';
    this.code = code;
    /*
     * detail には利用者へ出さない補助情報だけを入れる。
     * アクセストークンは絶対に入れない。
     */
    this.detail = detail ?? null;
  }
}

/* 期限ぎりぎりでの401を避けるための余裕。 */
const EXPIRY_MARGIN_MS = 60 * 1000;

/*
 * 認可ポップアップの応答待ちの上限。
 *
 * GIS は「利用者が同意画面を開いたまま放置した」場合に何も返さない。
 * 上限を設けないと Promise が永久に解決せず、呼び出し側の画面が
 * 「実行中」のまま固まる。必ず有限時間で失敗させる。
 */
const RESPONSE_TIMEOUT_MS = 180 * 1000;

/* expires_in が読めなかった場合の既定の有効期間。 */
const DEFAULT_LIFETIME_MS = 3600 * 1000;

/* ---------- メモリ上の状態（Storageへは書かない） ---------- */

/* scopeKey -> { token, expiresAt } */
const tokens = new Map();

/* scopeKey -> { client, hint } */
const clients = new Map();

/* scopeKey -> { resolve, reject, timer } */
const pending = new Map();

/* ---------- スコープの正規化 ---------- */

/*
 * スコープを比較可能な1つのキーへ揃える。
 * 文字列でも配列でも受け取り、重複を除いて並び順を固定する。
 * 「同じ権限の組み合わせなら同じキャッシュを使う」ことを保証するため。
 */
export function normalizeScope(scope = DRIVE_FILE_SCOPE) {
  const list = Array.isArray(scope) ? scope : String(scope ?? '').split(/\s+/);

  const cleaned = list
    .map((item) => String(item ?? '').trim())
    .filter((item) => item !== '');

  const unique = [...new Set(cleaned)].sort();

  return unique.join(' ');
}

/* ---------- トークンの参照 ---------- */

export function getCachedAccessToken(scope = DRIVE_FILE_SCOPE) {
  const entry = tokens.get(normalizeScope(scope));

  if (!entry || Date.now() >= entry.expiresAt) {
    return null;
  }

  return entry.token;
}

export function hasValidAccessToken(scope = DRIVE_FILE_SCOPE) {
  return getCachedAccessToken(scope) !== null;
}

/*
 * 401を受けたときや、明示的に権限を切りたいときに呼ぶ。
 * scope を省略すると、保持しているすべてのトークンを捨てる。
 */
export function clearAccessToken(scope) {
  if (scope === undefined) {
    tokens.clear();
    return;
  }

  tokens.delete(normalizeScope(scope));
}

/* ログイン状態（IDトークン由来の表示用プロフィール）を返す。 */
export function getSignedInProfile() {
  return loadProfile();
}

/* ---------- トークン取得 ---------- */

function toAuthError(response) {
  const reason = response?.error ?? response?.type ?? '';

  switch (reason) {
    case 'popup_closed':
    case 'popup_closed_by_user':
      return new DriveAuthError(DriveAuthErrorCode.POPUP_CLOSED, reason);
    case 'popup_failed_to_open':
      return new DriveAuthError(DriveAuthErrorCode.POPUP_BLOCKED, reason);
    case 'access_denied':
      return new DriveAuthError(DriveAuthErrorCode.ACCESS_DENIED, reason);
    default:
      return new DriveAuthError(DriveAuthErrorCode.UNKNOWN, reason || 'unknown');
  }
}

/*
 * 要求したスコープがすべて付与されたかを確認する。
 * GIS の hasGrantedAllScopes があればそれを使い、無ければ scope 文字列で判定する。
 */
function hasAllScopes(response, scopeKey) {
  const required = scopeKey.split(' ').filter((item) => item !== '');
  const oauth2 = globalThis.google?.accounts?.oauth2;

  if (typeof oauth2?.hasGrantedAllScopes === 'function') {
    try {
      return oauth2.hasGrantedAllScopes(response, ...required);
    } catch {
      /* 判定できない場合は下の文字列判定へ落とす。 */
    }
  }

  const granted = typeof response?.scope === 'string' ? response.scope.split(/\s+/) : [];
  return required.every((item) => granted.includes(item));
}

/*
 * 現在のログイン表示から login_hint に使うメールを得る。
 * プロフィールが無ければ undefined（＝アカウント選択画面を出す）。
 *
 * ここでの「ログイン」はあくまで表示用であり、認可の前提条件ではない。
 * hint はアカウント選択の初期値を寄せるだけの補助で、
 * 認可の可否はGoogle側が判断する。これで権限が変わることはない。
 */
function resolveHint() {
  const profile = loadProfile();
  const email = profile?.email;
  return typeof email === 'string' && email.includes('@') ? email : undefined;
}

function settlePending(scopeKey, settle) {
  const request = pending.get(scopeKey);

  if (!request) {
    return null;
  }

  pending.delete(scopeKey);
  clearTimeout(request.timer);
  settle(request);
  return request;
}

function createTokenClient(scopeKey, hint) {
  const oauth2 = globalThis.google?.accounts?.oauth2;

  if (!oauth2 || typeof oauth2.initTokenClient !== 'function') {
    throw new DriveAuthError(DriveAuthErrorCode.GIS_LOAD_FAILED, 'oauth2_unavailable');
  }

  return oauth2.initTokenClient({
    client_id: GOOGLE_AUTH_CONFIG.clientId,
    scope: scopeKey,
    hint,

    callback: (response) => {
      settlePending(scopeKey, (request) => {
        if (response?.error) {
          request.reject(toAuthError(response));
          return;
        }

        const token = response?.access_token;

        if (typeof token !== 'string' || token === '') {
          request.reject(new DriveAuthError(DriveAuthErrorCode.UNKNOWN, 'empty_token'));
          return;
        }

        if (!hasAllScopes(response, scopeKey)) {
          request.reject(new DriveAuthError(DriveAuthErrorCode.SCOPE_NOT_GRANTED, 'scope_missing'));
          return;
        }

        const lifetimeSeconds = Number(response.expires_in);
        const lifetimeMs = Number.isFinite(lifetimeSeconds) && lifetimeSeconds > 0
          ? lifetimeSeconds * 1000
          : DEFAULT_LIFETIME_MS;

        /* ここでのみトークンを保持する。Storageへは書かない。 */
        tokens.set(scopeKey, {
          token,
          expiresAt: Date.now() + Math.max(0, lifetimeMs - EXPIRY_MARGIN_MS),
        });

        request.resolve(token);
      });
    },

    error_callback: (error) => {
      settlePending(scopeKey, (request) => {
        request.reject(toAuthError(error));
      });
    },
  });
}

/*
 * アクセストークンを用意する。
 *
 * options:
 *   scope        … 要求するスコープ（文字列 / 配列）。既定は drive.file
 *   forceConsent … true なら同意画面を必ず出す（401後の再認可などで使う）
 *
 * **利用者の操作（ボタン押下）から呼ぶこと。**
 * ポップアップブロックを避けるため、押下から離れた非同期処理の後には呼ばない。
 */
export async function ensureAccessToken({ scope = DRIVE_FILE_SCOPE, forceConsent = false } = {}) {
  const scopeKey = normalizeScope(scope);

  if (scopeKey === '') {
    throw new DriveAuthError(DriveAuthErrorCode.UNKNOWN, 'empty_scope');
  }

  if (!forceConsent) {
    const cached = getCachedAccessToken(scopeKey);

    if (cached) {
      return cached;
    }
  }

  if (!isClientIdConfigured()) {
    throw new DriveAuthError(DriveAuthErrorCode.CLIENT_ID_MISSING);
  }

  /*
   * ここで /apps/ のログイン表示（sessionStorage プロフィール）の有無は問わない。
   * 長時間の操作の途中でプロフィールが期限切れになっていても、
   * その場で認可を開始できるようにする。
   */

  try {
    await loadGisScript();
  } catch (error) {
    throw new DriveAuthError(DriveAuthErrorCode.GIS_LOAD_FAILED, error?.message ?? 'load_failed');
  }

  /*
   * login_hint は現在のプロフィールから毎回求める。
   * プロフィールが消えた／現れたなど hint が変わった場合は、
   * その値でトークンクライアントを作り直す。
   */
  const hint = resolveHint();
  const existing = clients.get(scopeKey);

  if (!existing || existing.hint !== hint) {
    clients.set(scopeKey, { client: createTokenClient(scopeKey, hint), hint });
  }

  /* 同じスコープのポップアップを二重に開かない。 */
  if (pending.has(scopeKey)) {
    throw new DriveAuthError(DriveAuthErrorCode.REQUEST_IN_FLIGHT, 'request_in_flight');
  }

  const { client } = clients.get(scopeKey);

  return new Promise((resolve, reject) => {
    /* 応答が無いまま放置されたら、必ず失敗させる（画面を固まらせない）。 */
    const timer = setTimeout(() => {
      settlePending(scopeKey, (request) => {
        request.reject(new DriveAuthError(DriveAuthErrorCode.TIMEOUT, 'no_response'));
      });
    }, RESPONSE_TIMEOUT_MS);

    pending.set(scopeKey, { resolve, reject, timer });

    try {
      client.requestAccessToken({
        /*
         * '' … 既に許可済みなら同意画面を出さずに再発行する
         * 'consent' … 必ず同意画面を出す（再認可）
         */
        prompt: forceConsent ? 'consent' : '',
      });
    } catch (error) {
      settlePending(scopeKey, (request) => {
        request.reject(new DriveAuthError(DriveAuthErrorCode.UNKNOWN, error?.name ?? 'request_failed'));
      });
    }
  });
}

/*
 * 401（認可切れ）を1回だけ自動で取り直す共通ラッパー。
 *
 *   const files = await withAccessToken((token) => listFiles({ token }));
 *
 * options:
 *   scope        … 要求するスコープ。既定は drive.file
 *   shouldReauth … 再認可すべきエラーかを判定する述語。
 *                  既定は HTTP 401 / code === 'UNAUTHORIZED'。
 *                  drive-files.js の DriveError をそのまま判定できるよう
 *                  ダックタイピングにしてあり、こちらからは import しない。
 *
 * ------------------------------------------------------------------
 * 注意: 再取得もポップアップを伴いうる
 * ------------------------------------------------------------------
 * 2回目の ensureAccessToken() は利用者操作から離れた時点で走るため、
 * ブラウザにポップアップをブロックされることがある。
 * 呼び出し側は失敗時に「再接続」ボタンを提示する設計にすること。
 * ------------------------------------------------------------------
 */
export async function withAccessToken(run, { scope = DRIVE_FILE_SCOPE, shouldReauth } = {}) {
  if (typeof run !== 'function') {
    throw new DriveAuthError(DriveAuthErrorCode.UNKNOWN, 'run_not_function');
  }

  const isReauthTarget = typeof shouldReauth === 'function'
    ? shouldReauth
    : (error) => error?.status === 401 || error?.code === 'UNAUTHORIZED';

  const token = await ensureAccessToken({ scope });

  try {
    return await run(token);
  } catch (error) {
    if (!isReauthTarget(error)) {
      throw error;
    }

    clearAccessToken(scope);

    /* 許可済みなら同意画面は出ない。出る場合はブロックされうる（上記の注意）。 */
    const retryToken = await ensureAccessToken({ scope });
    return run(retryToken);
  }
}

/*
 * テスト・リセット用。
 * トークン、クライアント、進行中の要求をすべて捨てる。
 */
export function resetDriveAuth() {
  tokens.clear();
  clients.clear();

  pending.forEach((request) => {
    clearTimeout(request.timer);
  });

  pending.clear();
}

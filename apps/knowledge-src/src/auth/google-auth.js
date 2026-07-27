/*
 * Google Drive 用のアクセストークン取得（OAuth 2.0 Token Model / PKCEなしの暗黙付与）。
 *
 * ------------------------------------------------------------------
 * 保存方針（重要）
 * ------------------------------------------------------------------
 * アクセストークンは **メモリ上だけ** で保持する。
 *   localStorage / sessionStorage / cookie / URL / ログ / IndexedDB
 *   のいずれにも書かない。
 * ページを再読み込みすれば消え、再認可が必要になる（意図した挙動）。
 *
 * client secret / refresh token / APIキー（Picker用を除く）は使用しない。
 * 静的サイトのため、そもそも安全に置ける場所が無い。
 * ------------------------------------------------------------------
 *
 * 要求スコープは config.js の SCOPE_MODE で決まる読み取り専用スコープ1つだけ。
 * 書き込みスコープ（drive / drive.appdata の書き込み用途）は追加しない。
 */

import { AUTH_CONFIG, getDriveScope, isClientIdConfigured } from '../config.js';
import { loadGis } from './script-loader.js';
import { AppError, ErrorCode } from '../core/errors.js';
import { logger } from '../core/logger.js';

/* 期限ぎりぎりでの401を避けるための余裕。 */
const EXPIRY_MARGIN_MS = 60 * 1000;

/*
 * 認可ポップアップの応答待ちの上限。
 *
 * GIS は「利用者が同意画面を開いたまま放置した」場合に何も返さない。
 * 上限を設けないと Promise が永久に解決せず、同期や接続診断が
 * 「実行中」のまま固まる。必ず有限時間で失敗させる。
 */
const AUTH_RESPONSE_TIMEOUT_MS = 180 * 1000;

let accessToken = null;
let tokenExpiresAt = 0;
let tokenClient = null;
let pendingRequest = null;
let cachedProfile = null;

const listeners = new Set();

function notify() {
  const snapshot = { signedIn: hasValidAccessToken(), profile: cachedProfile };
  listeners.forEach((listener) => {
    try {
      listener(snapshot);
    } catch {
      /* 購読者の例外で認証経路を壊さない。 */
    }
  });
}

export function subscribeAuth(listener) {
  listeners.add(listener);
  listener({ signedIn: hasValidAccessToken(), profile: cachedProfile });
  return () => listeners.delete(listener);
}

export function getCachedAccessToken() {
  if (!accessToken || Date.now() >= tokenExpiresAt) {
    return null;
  }
  return accessToken;
}

export function hasValidAccessToken() {
  return getCachedAccessToken() !== null;
}

export function getProfile() {
  return cachedProfile;
}

/* 401を受けたとき、または利用者がログアウトしたときに呼ぶ。 */
export function clearAccessToken() {
  accessToken = null;
  tokenExpiresAt = 0;
  notify();
}

export function signOut() {
  const token = accessToken;

  clearAccessToken();
  cachedProfile = null;

  /*
   * Google側の付与も取り消す。失敗しても画面は進める
   * （手元のトークンは既に破棄しているため）。
   */
  if (token && globalThis.google?.accounts?.oauth2?.revoke) {
    try {
      globalThis.google.accounts.oauth2.revoke(token, () => {});
    } catch {
      /* revoke の失敗は致命的ではない。 */
    }
  }

  logger.info('auth:signed-out');
  notify();
}

function toAuthError(response) {
  const reason = response?.error ?? response?.type ?? '';

  switch (reason) {
    case 'popup_closed':
    case 'popup_closed_by_user':
      return new AppError(ErrorCode.AUTH_POPUP_CLOSED, reason);
    case 'popup_failed_to_open':
      return new AppError(ErrorCode.AUTH_POPUP_BLOCKED, reason);
    case 'access_denied':
      return new AppError(ErrorCode.AUTH_ACCESS_DENIED, reason);
    default:
      return new AppError(ErrorCode.AUTH_FAILED, reason || 'unknown');
  }
}

function hasRequiredScope(response) {
  const scope = getDriveScope();
  const oauth2 = globalThis.google?.accounts?.oauth2;

  if (typeof oauth2?.hasGrantedAllScopes === 'function') {
    try {
      return oauth2.hasGrantedAllScopes(response, scope);
    } catch {
      /* 判定できない場合は下の文字列判定へ落とす。 */
    }
  }

  const granted = typeof response?.scope === 'string' ? response.scope.split(/\s+/) : [];
  return granted.includes(scope);
}

function createTokenClient() {
  const oauth2 = globalThis.google?.accounts?.oauth2;

  if (!oauth2 || typeof oauth2.initTokenClient !== 'function') {
    throw new AppError(ErrorCode.GIS_LOAD_FAILED, 'oauth2_unavailable');
  }

  return oauth2.initTokenClient({
    client_id: AUTH_CONFIG.clientId,
    scope: getDriveScope(),

    callback: (response) => {
      const request = pendingRequest;
      pendingRequest = null;

      if (!request) {
        return;
      }

      if (response?.error) {
        request.reject(toAuthError(response));
        return;
      }

      const token = response?.access_token;

      if (typeof token !== 'string' || token === '') {
        request.reject(new AppError(ErrorCode.AUTH_FAILED, 'empty_token'));
        return;
      }

      if (!hasRequiredScope(response)) {
        request.reject(new AppError(ErrorCode.AUTH_SCOPE_NOT_GRANTED, 'scope_missing'));
        return;
      }

      const lifetimeSeconds = Number(response.expires_in);
      const lifetimeMs = Number.isFinite(lifetimeSeconds) && lifetimeSeconds > 0
        ? lifetimeSeconds * 1000
        : 3600 * 1000;

      /* ここでのみトークンを保持する。永続化はしない。 */
      accessToken = token;
      tokenExpiresAt = Date.now() + Math.max(0, lifetimeMs - EXPIRY_MARGIN_MS);

      /* トークン本体は絶対に記録しない。有効秒数だけ残す。 */
      logger.info('auth:token-acquired', { expiresInSec: Math.round(lifetimeMs / 1000) });
      notify();
      request.resolve(token);
    },

    error_callback: (error) => {
      const request = pendingRequest;
      pendingRequest = null;
      logger.warn('auth:error-callback', { type: error?.type ?? 'unknown' });
      request?.reject(toAuthError(error));
    },
  });
}

/*
 * アクセストークンを用意する。
 *
 * options.forceConsent … true なら同意画面を必ず出す（401後の再認可など）
 *
 * **利用者の操作（ボタン押下）から同期的に呼ぶこと。**
 * 押下から離れた非同期処理の後に呼ぶと、ポップアップブロックの対象になる。
 */
export async function ensureAccessToken({ forceConsent = false } = {}) {
  if (!forceConsent) {
    const cached = getCachedAccessToken();
    if (cached) {
      return cached;
    }
  }

  if (!isClientIdConfigured()) {
    throw new AppError(ErrorCode.CLIENT_ID_MISSING);
  }

  await loadGis();

  if (!tokenClient) {
    tokenClient = createTokenClient();
  }

  if (pendingRequest) {
    throw new AppError(ErrorCode.AUTH_FAILED, 'request_in_flight');
  }

  return new Promise((resolve, reject) => {
    /* 応答が無いまま放置されたら、必ず失敗させる（画面を固まらせない）。 */
    const timer = setTimeout(() => {
      if (pendingRequest?.timer === timer) {
        pendingRequest = null;
        logger.warn('auth:response-timeout', { timeoutMs: AUTH_RESPONSE_TIMEOUT_MS });
        reject(new AppError(ErrorCode.AUTH_TIMEOUT, 'no_response'));
      }
    }, AUTH_RESPONSE_TIMEOUT_MS);

    pendingRequest = {
      timer,
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    };

    try {
      tokenClient.requestAccessToken({
        /* '' … 許可済みなら同意画面を出さずに再発行 / 'consent' … 必ず出す */
        prompt: forceConsent ? 'consent' : '',
      });
    } catch (error) {
      clearTimeout(timer);
      pendingRequest = null;
      reject(new AppError(ErrorCode.AUTH_FAILED, error?.name ?? 'request_failed'));
    }
  });
}

/*
 * 表示用プロフィールを覚える。
 * 取得元は Drive API の about.get（追加スコープ不要）。drive-client.js から渡される。
 *
 * ------------------------------------------------------------------
 * この値をアクセス制御に使わないこと。
 * サーバーが存在しないため本人確認は成立しない。表示専用である。
 * ------------------------------------------------------------------
 */
export function setProfile(profile) {
  cachedProfile = profile ?? null;
  notify();
}

/* テスト・リセット用。 */
export function resetAuth() {
  accessToken = null;
  tokenExpiresAt = 0;
  tokenClient = null;

  if (pendingRequest?.timer) {
    clearTimeout(pendingRequest.timer);
  }

  pendingRequest = null;
  cachedProfile = null;
  notify();
}

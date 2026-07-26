/*
 * Google Drive 用のアクセストークン取得（OAuth 2.0 Token Model）。
 *
 * ------------------------------------------------------------------
 * ログインと認可の分離（重要）
 * ------------------------------------------------------------------
 * /apps/ のGoogleログイン（google-auth.js）が扱うのは **IDトークン** で、
 * 「誰がログインしているか」を画面に表示するためだけのもの。
 *
 * このファイルが扱うのは **アクセストークン** で、Drive API を呼ぶための
 * 認可情報。両者はまったく別物であり、混同してはならない。
 *
 *   IDトークン      … google.accounts.id      / ログイン時に取得 / 表示専用
 *   アクセストークン … google.accounts.oauth2 / 保存ボタン押下時のみ取得
 *
 * アプリ起動時にDrive権限は要求しない。利用者が「Google Driveへ保存」を
 * 押した時だけポップアップを出す。
 * ------------------------------------------------------------------
 *
 * 保存方針:
 *   アクセストークンは **メモリ上だけ** で保持する。
 *   sessionStorage / localStorage / cookie / URL / ログ / 外部送信のいずれにも残さない。
 *   ページを再読み込みすれば消え、再認可が必要になる（意図した挙動）。
 *
 * 要求スコープは drive.file のみ。
 * これはこのアプリが作成した、または利用者が明示的に選んだファイルだけを
 * 対象とする権限で、Drive全体を読み書きする権限ではない。
 *
 * client secret / refresh token / APIキーは使用しない（静的サイトのため置けない）。
 */

import { GOOGLE_AUTH_CONFIG, isClientIdConfigured } from '../auth-config.js';
import { loadGisScript } from '../gis-loader.js';
import { loadProfile } from '../auth-session.js';
import { debugLog } from './debug-log.js';

/* 要求するスコープはこの1つだけ。増やさないこと。 */
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

export const DriveAuthErrorCode = {
  CLIENT_ID_MISSING: 'CLIENT_ID_MISSING',
  /*
   * NOT_SIGNED_IN は「/apps/ のログイン表示が消えているとDrive保存を拒否する」
   * という旧仕様の名残。Drive保存はログイン表示に依存しないため、通常は使わない。
   * 後方互換のためコードは残すが、ensureAccessToken では投げない。
   */
  NOT_SIGNED_IN: 'NOT_SIGNED_IN',
  GIS_LOAD_FAILED: 'GIS_LOAD_FAILED',
  POPUP_CLOSED: 'POPUP_CLOSED',
  POPUP_BLOCKED: 'POPUP_BLOCKED',
  ACCESS_DENIED: 'ACCESS_DENIED',
  SCOPE_NOT_GRANTED: 'SCOPE_NOT_GRANTED',
  UNKNOWN: 'UNKNOWN',
};

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

/* ---------- メモリ上のトークン（Storageへは書かない） ---------- */

let accessToken = null;
let tokenExpiresAt = 0;
let tokenClient = null;
/* tokenClient を作ったときの login_hint。プロフィールの有無が変わったら作り直す。 */
let tokenClientHint = undefined;
let pendingRequest = null;

/* 期限ぎりぎりでの401を避けるための余裕。 */
const EXPIRY_MARGIN_MS = 60 * 1000;

export function getCachedAccessToken() {
  if (!accessToken || Date.now() >= tokenExpiresAt) {
    return null;
  }

  return accessToken;
}

export function hasValidAccessToken() {
  return getCachedAccessToken() !== null;
}

/* 401を受けたときや、明示的に権限を切りたいときに呼ぶ。 */
export function clearAccessToken() {
  accessToken = null;
  tokenExpiresAt = 0;
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
 * 付与されたスコープに drive.file が含まれるかを確認する。
 * GIS の hasGrantedAllScopes があればそれを使い、無ければ scope 文字列で判定する。
 */
function hasDriveScope(response) {
  const oauth2 = globalThis.google?.accounts?.oauth2;

  if (typeof oauth2?.hasGrantedAllScopes === 'function') {
    try {
      return oauth2.hasGrantedAllScopes(response, DRIVE_SCOPE);
    } catch {
      /* 判定できない場合は下の文字列判定へ落とす。 */
    }
  }

  const granted = typeof response?.scope === 'string' ? response.scope.split(/\s+/) : [];
  return granted.includes(DRIVE_SCOPE);
}

/*
 * 現在のログイン表示から login_hint に使うメールを得る。
 * プロフィールが無ければ undefined（＝アカウント選択画面を出す）。
 * ここでの「ログイン」はあくまで表示用であり、Drive認可の前提条件ではない。
 */
function resolveHint() {
  const profile = loadProfile();
  const email = profile?.email;
  return typeof email === 'string' && email.includes('@') ? email : undefined;
}

function createTokenClient(hint) {
  const oauth2 = globalThis.google?.accounts?.oauth2;

  if (!oauth2 || typeof oauth2.initTokenClient !== 'function') {
    throw new DriveAuthError(DriveAuthErrorCode.GIS_LOAD_FAILED, 'oauth2_unavailable');
  }

  return oauth2.initTokenClient({
    client_id: GOOGLE_AUTH_CONFIG.clientId,
    scope: DRIVE_SCOPE,
    /*
     * hint はアカウント選択の初期値を寄せるだけの補助。
     * プロフィールが無ければ渡さず、Googleのアカウント選択画面に任せる。
     * 認可の可否はGoogle側が判断するため、これで権限が変わることはない。
     */
    hint,
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
        request.reject(new DriveAuthError(DriveAuthErrorCode.UNKNOWN, 'empty_token'));
        return;
      }

      if (!hasDriveScope(response)) {
        request.reject(new DriveAuthError(DriveAuthErrorCode.SCOPE_NOT_GRANTED, 'scope_missing'));
        return;
      }

      const lifetimeSeconds = Number(response.expires_in);
      const lifetimeMs = Number.isFinite(lifetimeSeconds) && lifetimeSeconds > 0
        ? lifetimeSeconds * 1000
        : 3600 * 1000;

      /* ここでのみトークンを保持する。Storageへは書かない。 */
      accessToken = token;
      tokenExpiresAt = Date.now() + Math.max(0, lifetimeMs - EXPIRY_MARGIN_MS);

      /* トークン本体・メールは出さない。有効秒数だけ。 */
      debugLog('auth:token-acquired', { tokenPresent: true, expiresInSec: Math.round(lifetimeMs / 1000) });
      request.resolve(token);
    },
    error_callback: (error) => {
      const request = pendingRequest;
      pendingRequest = null;
      /* エラー種別のみ。OAuthレスポンス全体は出さない。 */
      debugLog('auth:error-callback', { type: error?.type ?? 'unknown' });
      request?.reject(toAuthError(error));
    },
  });
}

/*
 * アクセストークンを用意する。
 *
 * options:
 *   forceConsent … true なら同意画面を必ず出す（401後の再認可などで使う）
 *
 * 利用者の操作（ボタン押下）から呼ぶこと。
 * ポップアップブロックを避けるため、押下から離れた非同期処理の後には呼ばない。
 */
export async function ensureAccessToken({ forceConsent = false } = {}) {
  debugLog('auth:ensure', {
    forceConsent,
    hasValidToken: hasValidAccessToken(),
    hasProfile: Boolean(loadProfile()),
  });

  if (!forceConsent) {
    const cached = getCachedAccessToken();

    if (cached) {
      return cached;
    }
  }

  if (!isClientIdConfigured()) {
    throw new DriveAuthError(DriveAuthErrorCode.CLIENT_ID_MISSING);
  }

  /*
   * ここで /apps/ のログイン表示（sessionStorage プロフィール）の有無は問わない。
   * 長時間録音の途中でプロフィールが期限切れになっていても、保存操作の中で
   * OAuth Token Model を開始できるようにする（これが今回の主目的）。
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

  if (!tokenClient || tokenClientHint !== hint) {
    /* hint の有無だけを出す。メールアドレスは出さない。 */
    debugLog('auth:token-client', { hintPresent: hint !== undefined });
    tokenClient = createTokenClient(hint);
    tokenClientHint = hint;
  }

  /* ポップアップを二重に開かない。 */
  if (pendingRequest) {
    throw new DriveAuthError(DriveAuthErrorCode.UNKNOWN, 'request_in_flight');
  }

  return new Promise((resolve, reject) => {
    pendingRequest = { resolve, reject };

    try {
      tokenClient.requestAccessToken({
        /*
         * '' … 既に許可済みなら同意画面を出さずに再発行する
         * 'consent' … 必ず同意画面を出す（再認可）
         */
        prompt: forceConsent ? 'consent' : '',
      });
    } catch (error) {
      pendingRequest = null;
      reject(new DriveAuthError(DriveAuthErrorCode.UNKNOWN, error?.name ?? 'request_failed'));
    }
  });
}

/*
 * テスト・リセット用。
 * トークン、クライアント、進行中の要求をすべて捨てる。
 */
export function resetDriveAuth() {
  clearAccessToken();
  tokenClient = null;
  tokenClientHint = undefined;
  pendingRequest = null;
}

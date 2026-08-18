/*
 * Google OAuth（Drive アクセストークンの取得）。
 *
 * public/production-app/audio-transcriber/oauth.js からの複製（2026-08-18。
 * 本番アプリ間で共通層を作らず複製する … docs/repository-structure.md §4）。
 * ロジックは複製元と同一で、参照する定数（./config.js の OAUTH）だけが
 * このアプリのものになっている。
 *
 * ==================================================================
 * トークンはメモリだけ
 * ==================================================================
 * アクセストークンを localStorage / sessionStorage / Cookie / URL / ログへ
 * 書かないこと。このモジュールのクロージャ変数だけに置き、
 * ページを離れれば消える（再認可が必要になるのは意図した挙動）。
 *
 * refresh token は受け取らない（暗黙フローのため発行されない）。
 * client secret も使わない。静的サイトに秘密は置けないためである。
 *
 * スコープは drive.file のみ。ドライブ全体を読むスコープを要求しない。
 * ==================================================================
 *
 * Google Identity Services のスクリプトは Google のドメインから読む。
 * 第三者CDNではなく、認可そのものの提供元であるため許容する。
 */

import { OAUTH, isOauthConfigured } from './config.js';

const GIS_SRC = 'https://accounts.google.com/gsi/client';

export const DriveAuthErrorCode = {
  CLIENT_ID_MISSING: 'CLIENT_ID_MISSING',
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

/* **この2つを外へ出さないこと。** 参照を返す getter も作らない。 */
let accessToken = null;
let tokenExpiresAt = 0;

let pendingRequest = null;
let gisPromise = null;

/* 期限ぎりぎりでの401を避けるための余裕。 */
const EXPIRY_MARGIN_MS = 60 * 1000;

export function hasValidAccessToken() {
  return typeof accessToken === 'string' && accessToken !== '' && Date.now() < tokenExpiresAt;
}

/* 401を受けたときや、明示的に権限を切りたいときに呼ぶ。 */
export function clearAccessToken() {
  accessToken = null;
  tokenExpiresAt = 0;
}

/* ---------- GIS の読み込み ---------- */

function loadGis() {
  if (gisPromise) {
    return gisPromise;
  }

  gisPromise = new Promise((resolve, reject) => {
    if (globalThis.google?.accounts?.oauth2) {
      resolve();
      return;
    }

    const script = document.createElement('script');
    script.src = GIS_SRC;
    script.async = true;
    script.defer = true;
    script.addEventListener('load', () => resolve());
    script.addEventListener('error', () => {
      /* 次回の押下でやり直せるよう、失敗した Promise を残さない。 */
      gisPromise = null;
      reject(new DriveAuthError(DriveAuthErrorCode.GIS_LOAD_FAILED, 'gis_load_failed'));
    });
    document.head.append(script);
  });

  return gisPromise;
}

/* ---------- エラー分類 ---------- */

/*
 * GIS の callback / error_callback が返す理由を画面のコードへ写す。
 *
 * ------------------------------------------------------------------
 * オリジン未登録は「見分けられない」
 * ------------------------------------------------------------------
 * 「承認済みの JavaScript 生成元」に現在のオリジンが無い場合、Google は
 * ポップアップの中で 400 エラーを表示する。error_callback には専用の
 * type が来ず、利用者がその画面を閉じた時点で popup_closed になる。
 * つまり「利用者が自分で閉じた」場合と区別がつかない。
 * 文言側で両方の可能性を案内する（app.js の DRIVE_AUTH_ERROR_MESSAGES）。
 * ------------------------------------------------------------------
 */
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
      return oauth2.hasGrantedAllScopes(response, OAUTH.scope);
    } catch {
      /* 判定できない場合は下の文字列判定へ落とす。 */
    }
  }

  const granted = typeof response?.scope === 'string' ? response.scope.split(/\s+/) : [];
  return granted.includes(OAUTH.scope);
}

/* ---------- トークン取得 ---------- */

/*
 * アクセストークンを用意する。
 *
 * options:
 *   forceConsent … true なら同意画面を必ず出す（401後の再認可などで使う）
 *
 * 利用者の操作（ボタン押下）から呼ぶこと。
 * ポップアップを開くため、押下から離れた非同期処理の後には呼ばない。
 * アプリを開いただけでは呼ばない（認可はボタンを押した時だけ）。
 */
export async function ensureAccessToken({ forceConsent = false } = {}) {
  if (!forceConsent && hasValidAccessToken()) {
    return accessToken;
  }

  if (!isOauthConfigured()) {
    throw new DriveAuthError(DriveAuthErrorCode.CLIENT_ID_MISSING);
  }

  await loadGis();

  const oauth2 = globalThis.google?.accounts?.oauth2;

  if (!oauth2 || typeof oauth2.initTokenClient !== 'function') {
    throw new DriveAuthError(DriveAuthErrorCode.GIS_LOAD_FAILED, 'oauth2_unavailable');
  }

  /* ポップアップを二重に開かない。 */
  if (pendingRequest) {
    throw new DriveAuthError(DriveAuthErrorCode.UNKNOWN, 'request_in_flight');
  }

  return new Promise((resolve, reject) => {
    pendingRequest = { resolve, reject };

    /*
     * トークンクライアントは毎回作る。
     * 使い回しても動くが、pendingRequest の対応付けが単純になるほうを取った
     * （このアプリで認可を求める頻度は低く、生成コストは問題にならない）。
     */
    const client = oauth2.initTokenClient({
      client_id: OAUTH.clientId,
      scope: OAUTH.scope,
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

        request.resolve(token);
      },
      error_callback: (error) => {
        const request = pendingRequest;
        pendingRequest = null;
        request?.reject(toAuthError(error));
      },
    });

    try {
      client.requestAccessToken({
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

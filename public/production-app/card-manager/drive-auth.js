/*
 * Google OAuth の認可（トークンモデル）。
 *
 * ==================================================================
 * 複製元
 * ==================================================================
 * ../card-ocr/drive-auth.js を複製（2026-08-20）。**import はしない。**
 * （docs/repository-structure.md §4-1）
 * ==================================================================
 *
 * ==================================================================
 * 方針（card-ocr §FR-02 の2、§FR-24 と同じ）
 * ==================================================================
 *   - 要求するスコープは drive.file のみ。**増やさない。**
 *   - トークンは**メモリ上にだけ**持つ。localStorage にも
 *     sessionStorage にも書かない。タブを閉じれば消える。
 *   - トークンを console へ出さない・画面へ出さない・URLへ載せない。
 *   - 当社サーバーへ送らない。
 *   - クライアントシークレットも refresh token も使わない。
 *     静的サイトに置けないため。
 *   - **付与されたスコープを必ず検証する。** 同意画面で利用者が
 *     チェックを外してもトークンは発行される。検証しないと、最初の
 *     Drive 呼び出しで 403 になって原因が分かりにくくなる。
 * ==================================================================
 */

import {
  DRIVE_SCOPE,
  GOOGLE_CLIENT_ID,
  TOKEN_EXPIRY_MARGIN_MS,
  isClientIdConfigured,
} from './config.js';
import { loadGisScript } from './gis-loader.js';

export const DriveAuthErrorCode = {
  CLIENT_ID_MISSING: 'CLIENT_ID_MISSING',
  GIS_LOAD_FAILED: 'GIS_LOAD_FAILED',
  POPUP_BLOCKED: 'POPUP_BLOCKED',
  POPUP_CLOSED: 'POPUP_CLOSED',
  ACCESS_DENIED: 'ACCESS_DENIED',
  SCOPE_NOT_GRANTED: 'SCOPE_NOT_GRANTED',
  ALREADY_PENDING: 'ALREADY_PENDING',
  ABORTED: 'ABORTED',
  UNKNOWN: 'UNKNOWN',
};

export class DriveAuthError extends Error {
  constructor(code, detail = '') {
    /* メッセージにトークンや応答本体を含めない。コードだけで足りる。 */
    super(`drive-auth:${code}`);
    this.name = 'DriveAuthError';
    this.code = code;
    this.detail = detail;
  }
}

/* 画面に出す言葉。 */
export function describeDriveAuthError(error) {
  const code = error instanceof DriveAuthError ? error.code : DriveAuthErrorCode.UNKNOWN;

  switch (code) {
    case DriveAuthErrorCode.CLIENT_ID_MISSING:
      return {
        text: 'Google連携の設定が未完了です（クライアントID未設定）。',
        errorCode: 'OAUTH-001',
      };
    case DriveAuthErrorCode.GIS_LOAD_FAILED:
      return { text: 'Googleの読み込みに失敗しました。', errorCode: 'OAUTH-001' };
    case DriveAuthErrorCode.POPUP_BLOCKED:
      /* 文言は本番アプリ共通（card-ocr / card-mail と同じ文）。 */
      return {
        text: 'Googleの認証画面を開けませんでした。ブラウザのポップアップブロックを解除して、もう一度お試しください。',
        errorCode: 'OAUTH-001',
      };
    case DriveAuthErrorCode.POPUP_CLOSED:
      return { text: '連携の画面が閉じられました。', errorCode: 'OAUTH-001' };
    case DriveAuthErrorCode.ACCESS_DENIED:
      return { text: '連携が許可されませんでした。', errorCode: 'OAUTH-001' };
    case DriveAuthErrorCode.SCOPE_NOT_GRANTED:
      return {
        text: 'ドライブへのアクセスが許可されませんでした。チェックを外さずに許可してください。',
        errorCode: 'OAUTH-001',
      };
    case DriveAuthErrorCode.ALREADY_PENDING:
      return { text: '連携の画面を開いています。', errorCode: 'OAUTH-001' };
    case DriveAuthErrorCode.ABORTED:
      return { text: '処理を中断しました。', errorCode: 'OAUTH-001' };
    default:
      return { text: 'Google連携に失敗しました。', errorCode: 'OAUTH-001' };
  }
}

/* ---------- トークンの保持（メモリのみ） ---------- */

let accessToken = null;
let tokenExpiresAt = 0;

export function getCachedAccessToken() {
  if (accessToken === null) {
    return null;
  }

  if (Date.now() >= tokenExpiresAt) {
    accessToken = null;
    tokenExpiresAt = 0;
    return null;
  }

  return accessToken;
}

export function hasValidAccessToken() {
  return getCachedAccessToken() !== null;
}

/*
 * 明示的に捨てる。
 *
 * **401（期限切れ）でのみ呼ぶこと。** 403 で呼んではならない。
 * Drive はレート制限を 403 で返すため、403 で捨てると
 * 「待てば直る問題」を「再連携しても直らない問題」に変えてしまう。
 */
export function clearAccessToken() {
  accessToken = null;
  tokenExpiresAt = 0;
}

/* ---------- 応答の解釈 ---------- */

export function toAuthError(response) {
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
 *
 * 利用者は同意画面でチェックを外せる。**外されたまま進むと、
 * あとで 403 になって原因が分かりにくい。**ここで弾く。
 *
 * GIS の hasGrantedAllScopes があればそれを使い、無ければ scope 文字列で判定する。
 */
export function hasDriveScope(response) {
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

/* ---------- トークン取得 ---------- */

let pendingRequest = null;

/* テスト用。ポップアップ中の状態を捨てる。 */
export function resetPendingRequest() {
  pendingRequest = null;
}

/*
 * アクセストークンを用意する。
 *
 * **利用者の操作（ボタン押下）から呼ぶこと。** ポップアップブロックを
 * 避けるため、押下から離れた非同期処理のあとには呼ばない。
 *
 * options:
 *   forceConsent … true なら同意画面を必ず出す（401後の再認可などで使う）
 *   clientId     … 既定は config.js の値。テストから差し替える口
 *   signal       … 中断（画面を離れた・利用者が取りやめた）
 */
export async function ensureAccessToken({
  forceConsent = false,
  clientId = GOOGLE_CLIENT_ID,
  signal = null,
} = {}) {
  if (signal?.aborted) {
    throw new DriveAuthError(DriveAuthErrorCode.ABORTED, 'aborted_before_start');
  }

  if (!forceConsent) {
    const cached = getCachedAccessToken();

    if (cached) {
      return cached;
    }
  }

  /*
   * 設定の確認を先に行う。
   * 未設定のまま GIS を読み込むと、使えないと分かっている外部通信を
   * 発生させることになる（docs/external-dependency-approvals.md）。
   */
  if (!isClientIdConfigured(clientId)) {
    throw new DriveAuthError(DriveAuthErrorCode.CLIENT_ID_MISSING);
  }

  try {
    await loadGisScript();
  } catch (error) {
    throw new DriveAuthError(DriveAuthErrorCode.GIS_LOAD_FAILED, error?.message ?? 'load_failed');
  }

  const oauth2 = globalThis.google?.accounts?.oauth2;

  if (typeof oauth2?.initTokenClient !== 'function') {
    throw new DriveAuthError(DriveAuthErrorCode.GIS_LOAD_FAILED, 'oauth2_unavailable');
  }

  /* ポップアップを二重に開かない。 */
  if (pendingRequest) {
    throw new DriveAuthError(DriveAuthErrorCode.ALREADY_PENDING);
  }

  return new Promise((resolve, reject) => {
    const settle = (fn, value) => {
      pendingRequest = null;
      signal?.removeEventListener?.('abort', onAbort);
      fn(value);
    };

    /*
     * 中断してもポップアップ自体は閉じられない（GIS に閉じる口が無い）。
     * ここでできるのは「結果を待つのをやめる」ことだけである。
     */
    function onAbort() {
      settle(reject, new DriveAuthError(DriveAuthErrorCode.ABORTED, 'aborted_while_pending'));
    }

    signal?.addEventListener?.('abort', onAbort, { once: true });

    pendingRequest = { resolve, reject };

    let client;

    try {
      client = oauth2.initTokenClient({
        client_id: clientId,
        scope: DRIVE_SCOPE,
        callback: (response) => {
          if (response?.error) {
            settle(reject, toAuthError(response));
            return;
          }

          const token = response?.access_token;

          if (typeof token !== 'string' || token === '') {
            settle(reject, new DriveAuthError(DriveAuthErrorCode.UNKNOWN, 'empty_token'));
            return;
          }

          if (!hasDriveScope(response)) {
            settle(reject, new DriveAuthError(DriveAuthErrorCode.SCOPE_NOT_GRANTED, 'scope_missing'));
            return;
          }

          const lifetimeSeconds = Number(response.expires_in);
          const lifetimeMs = Number.isFinite(lifetimeSeconds) && lifetimeSeconds > 0
            ? lifetimeSeconds * 1000
            : 3600 * 1000;

          /* ここでのみトークンを保持する。Storage へは書かない。 */
          accessToken = token;
          tokenExpiresAt = Date.now() + Math.max(0, lifetimeMs - TOKEN_EXPIRY_MARGIN_MS);

          settle(resolve, token);
        },
        error_callback: (error) => {
          settle(reject, toAuthError(error));
        },
      });
    } catch (error) {
      settle(reject, new DriveAuthError(DriveAuthErrorCode.UNKNOWN, error?.message ?? 'init_failed'));
      return;
    }

    try {
      client.requestAccessToken(forceConsent ? { prompt: 'consent' } : {});
    } catch (error) {
      settle(reject, new DriveAuthError(DriveAuthErrorCode.UNKNOWN, error?.message ?? 'request_failed'));
    }
  });
}

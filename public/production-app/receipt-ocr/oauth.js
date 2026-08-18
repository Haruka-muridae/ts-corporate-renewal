/*
 * Google OAuth（仕様書 §4-2 / §13）。
 *
 * ==================================================================
 * トークンはメモリだけ
 * ==================================================================
 * アクセストークンを localStorage / sessionStorage / Cookie / URL へ
 * 書かないこと。このモジュールのクロージャ変数 accessToken だけに置き、
 * ページを離れれば消える。
 *
 * refresh token は受け取らない（暗黙フローのため発行されない）。
 * client secret も使わない。静的サイトに秘密は置けないためである。
 *
 * スコープは drive.file のみ。ドライブ全体を読むスコープを要求しない。
 * ==================================================================
 *
 * Google Identity Services のスクリプトは Google のドメインから読む。
 * 第三者CDNではなく、認可そのものの提供元であるため許容する（§13）。
 *
 * ==================================================================
 * 2026-08-18 の修正（findings #1・#4）
 * ==================================================================
 * 複製元: public/production-app/card-ocr/gis-loader.js（読み込み）と
 * 同 drive-auth.js（スコープ検証・二重起動の抑止）。複製日 2026-08-18。
 * **import はしない**（docs/repository-structure.md §4-1）。
 *
 * 直したのは2点。
 *
 * 1. **失敗した Promise を握り続けない。** 読み込みの Promise を使い回すのは
 *    通信を1回で済ませるためだが、reject した Promise を残すと、その
 *    ページを開いているあいだ連携が二度と成功しない。案内は「もう一度
 *    お試しください」なので、**そのとおりにしても直らない**状態になっていた。
 *    あわせて時間制限を置く（<script> は応答が返らないと load も error も
 *    発火しないため、これが無いと待ち続ける）。
 *
 * 2. **付与されたスコープを確かめる。** 同意画面では要求したスコープを
 *    利用者が個別に外せる。外してもトークン自体は発行されるため、
 *    access_token の有無だけを見ていると、最初の Drive 呼び出し（保存先の
 *    作成）まで進んでから 403 で落ちる。「連携はできたのに保存先が作れない」
 *    という分かりにくい失敗になっていた。
 * ==================================================================
 */

import { OAUTH, isOauthConfigured } from './config.js';
import { AppError } from './errors.js';

const GIS_SRC = 'https://accounts.google.com/gsi/client';

/* 読み込みの時間制限。card-ocr の GIS_LOAD_TIMEOUT_MS と同じ値。 */
export const GIS_LOAD_TIMEOUT_MS = 10000;

/* **この2つを外へ出さないこと。** 参照を返す getter も作らない。 */
let accessToken = null;
let expiresAt = 0;

let gisPromise = null;

/* GIS が使える状態か（accounts 名前空間の存在で判定する）。 */
export function isGisLoaded() {
  return Boolean(globalThis.google?.accounts?.oauth2);
}

/* テスト用。読み込み済みキャッシュを捨てる。 */
export function resetGisLoader() {
  gisPromise = null;
}

function loadGis(timeoutMs = GIS_LOAD_TIMEOUT_MS) {
  if (isGisLoaded()) {
    return Promise.resolve();
  }

  if (gisPromise) {
    return gisPromise;
  }

  gisPromise = new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;

    const finish = (error) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);

      if (error) {
        reject(error);
        return;
      }

      resolve();
    };

    timer = setTimeout(
      () => finish(new AppError('OAUTH-001', { detail: 'gis_timeout' })),
      timeoutMs,
    );

    if (typeof document === 'undefined') {
      finish(new AppError('OAUTH-001', { detail: 'no_document' }));
      return;
    }

    const script = document.createElement('script');

    script.src = GIS_SRC;
    script.async = true;
    script.defer = true;

    /* 読み込めても google.accounts.oauth2 が無い場合がある。 */
    script.addEventListener('load', () => finish(
      isGisLoaded() ? null : new AppError('OAUTH-001', { detail: 'gis_unavailable' }),
    ));

    script.addEventListener('error', () => finish(
      new AppError('OAUTH-001', { detail: 'gis_load_failed' }),
    ));

    (document.head ?? document.body)?.append(script);
  });

  /*
   * **失敗をキャッシュしない。** 握りつぶさず、次回の呼び出しで
   * もう一度読み込めるように参照だけ捨てる。
   */
  gisPromise.catch(() => {
    gisPromise = null;
  });

  return gisPromise;
}

export function hasValidToken() {
  return typeof accessToken === 'string' && accessToken !== '' && Date.now() < expiresAt;
}

/*
 * 明示的に捨てる。ログアウト時と、401 を受けたときに呼ぶ。
 *
 * **403 で呼ばないこと。** Drive はレート制限を 403 で返すため、
 * 捨てると「待てば直る問題」を「再連携しても直らない問題」に変える
 * （findings #2。errors.js の mapGoogleError が 403 を OAUTH-001 から
 * 切り離してあるので、通常の経路ではここへ来ない）。
 */
export function forgetToken() {
  accessToken = null;
  expiresAt = 0;
}

/*
 * 付与されたスコープに drive.file が含まれるか（findings #4）。
 *
 * GIS の hasGrantedAllScopes があればそれを使い、
 * 無ければ応答の scope 文字列で判定する。
 *
 * **判定できないときは true を返す。** ここで false に倒すと、
 * GIS の実装が変わったときに、正しく許可した利用者まで弾いてしまう。
 * その場合は従来どおり最初の Drive 呼び出しで 403 になる。
 */
export function hasRequiredScope(response, scope = OAUTH.scope) {
  const oauth2 = globalThis.google?.accounts?.oauth2;

  if (typeof oauth2?.hasGrantedAllScopes === 'function') {
    try {
      return oauth2.hasGrantedAllScopes(response, scope) === true;
    } catch {
      /* 判定できない場合は下の文字列判定へ落とす。 */
    }
  }

  if (typeof response?.scope !== 'string' || response.scope.trim() === '') {
    return true;
  }

  return response.scope.split(/\s+/).includes(scope);
}

/* ポップアップの二重起動を防ぐ（card-ocr の pendingRequest と同じ）。 */
let pending = false;

/* テスト用。ポップアップ待ちの状態を捨てる。 */
export function resetPendingRequest() {
  pending = false;
}

/*
 * 認可を求める。
 *
 * 利用者の操作（ボタン押下）から呼ぶこと。
 * ポップアップを開くため、読み込み直後に自動で呼ぶとブロックされる。
 */
export async function requestAccess({ prompt = '' } = {}) {
  if (!isOauthConfigured()) {
    throw new AppError('OAUTH-001', { detail: 'client_id_missing' });
  }

  await loadGis();

  if (typeof globalThis.google?.accounts?.oauth2?.initTokenClient !== 'function') {
    throw new AppError('OAUTH-001', { detail: 'gis_unavailable' });
  }

  if (pending) {
    /* 押し直しでポップアップを重ねない。前のポップアップの結果を待つ。 */
    throw new AppError('OAUTH-001', { detail: 'already_pending' });
  }

  pending = true;

  try {
    return await new Promise((resolve, reject) => {
      const settle = (fn, value) => {
        pending = false;
        fn(value);
      };

      const client = globalThis.google.accounts.oauth2.initTokenClient({
        client_id: OAUTH.clientId,
        scope: OAUTH.scope,
        prompt,
        callback: (response) => {
          if (!response?.access_token) {
            settle(reject, new AppError('OAUTH-001', { detail: 'no_access_token' }));
            return;
          }

          /*
           * **スコープを外されたまま進めない**（findings #4）。
           * ここで止めれば、失敗する場所が「連携の直後」になり、
           * 案内も具体的にできる（OAUTH-002）。
           */
          if (!hasRequiredScope(response)) {
            settle(reject, new AppError('OAUTH-002', { detail: 'scope_not_granted' }));
            return;
          }

          accessToken = response.access_token;

          /* 期限は少し手前で切る。境目で 401 を踏まないため。 */
          const lifetime = Number(response.expires_in) || 3600;
          expiresAt = Date.now() + (lifetime - 60) * 1000;

          settle(resolve, true);
        },
        error_callback: () => {
          settle(reject, new AppError('OAUTH-001', { detail: 'consent_failed' }));
        },
      });

      try {
        client.requestAccessToken();
      } catch {
        settle(reject, new AppError('OAUTH-001', { detail: 'request_failed' }));
      }
    });
  } catch (error) {
    /* initTokenClient 自体が投げた場合も、待ち状態を残さない。 */
    pending = false;
    throw error;
  }
}

/*
 * 通信のたびにトークンを取り出す口。
 *
 * 呼び出し側はこれを引数として渡すだけで、保持しない。
 * 期限切れなら OAUTH-001 を投げ、画面が再連携を案内する（§12）。
 */
export function currentToken() {
  if (!hasValidToken()) {
    throw new AppError('OAUTH-001', { detail: 'expired' });
  }

  return accessToken;
}

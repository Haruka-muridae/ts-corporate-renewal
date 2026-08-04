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
 */

import { OAUTH, isOauthConfigured } from './config.js';
import { AppError } from './errors.js';

const GIS_SRC = 'https://accounts.google.com/gsi/client';

/* **この2つを外へ出さないこと。** 参照を返す getter も作らない。 */
let accessToken = null;
let expiresAt = 0;

let gisPromise = null;

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
    script.addEventListener('error', () => reject(new AppError('OAUTH-001', { detail: 'gis_load_failed' })));
    document.head.append(script);
  });

  return gisPromise;
}

export function hasValidToken() {
  return typeof accessToken === 'string' && accessToken !== '' && Date.now() < expiresAt;
}

/* 明示的に捨てる。ログアウト時と、401 を受けたときに呼ぶ。 */
export function forgetToken() {
  accessToken = null;
  expiresAt = 0;
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

  return new Promise((resolve, reject) => {
    const client = globalThis.google.accounts.oauth2.initTokenClient({
      client_id: OAUTH.clientId,
      scope: OAUTH.scope,
      prompt,
      callback: (response) => {
        if (!response?.access_token) {
          reject(new AppError('OAUTH-001', { detail: 'no_access_token' }));
          return;
        }

        accessToken = response.access_token;

        /* 期限は少し手前で切る。境目で 401 を踏まないため。 */
        const lifetime = Number(response.expires_in) || 3600;
        expiresAt = Date.now() + (lifetime - 60) * 1000;

        resolve(true);
      },
      error_callback: () => {
        reject(new AppError('OAUTH-001', { detail: 'consent_failed' }));
      },
    });

    client.requestAccessToken();
  });
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

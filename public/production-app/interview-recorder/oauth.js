/*
 * Google OAuth（仕様書 §4 / §5）。
 *
 * ------------------------------------------------------------------
 * 移植元と複製の理由
 * ------------------------------------------------------------------
 * public/production-app/voice-recorder/oauth.js からの複製（2026-08-19）。
 * 同じ Drive フォルダへ、同じクライアントID・同じスコープで書き込むため、
 * 認可のやり方まで揃えてある。
 *
 * import ではなく複製にしているのは、本番アプリ同士を相互参照しないという
 * 流儀（voice-recorder/config.js の DRIVE_NAMES コメント、
 * docs/repository-structure.md §1）による。
 *
 * 複製元との違いは prompt 引数を削った点だけである。本アプリは
 * 「保存を押した時点で必要なら認可する」の1経路しか持たず、
 * アカウント選択画面を明示的に出し分ける場面が無いため
 * （既定の '' で、未連携なら選択画面・連携済みなら無音で通る）。
 * ------------------------------------------------------------------
 *
 * ==================================================================
 * トークンはメモリだけ
 * ==================================================================
 * アクセストークンを localStorage / sessionStorage / Cookie / URL / ログへ
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
 * 第三者CDNではなく、認可そのものの提供元であるため許容する
 * （index.html の CSP で script-src / frame-src に accounts.google.com を許可）。
 */

import { OAUTH, isOauthConfigured } from './config.js';
import { AppError, ErrorCode } from './errors.js';

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
    script.addEventListener('error', () => {
      /* 次回の押下でやり直せるよう、失敗した Promise を残さない。 */
      gisPromise = null;
      reject(new AppError(ErrorCode.OAUTH_SCRIPT_FAILED, 'gis_load_failed'));
    });
    document.head.append(script);
  });

  return gisPromise;
}

export function hasValidToken() {
  return typeof accessToken === 'string' && accessToken !== '' && Date.now() < expiresAt;
}

/* 明示的に捨てる。401 を受けたときと、再連携の前に呼ぶ。 */
export function forgetToken() {
  accessToken = null;
  expiresAt = 0;
}

/*
 * GIS の error_callback が返す type を、画面のエラーコードへ写す。
 *
 * ------------------------------------------------------------------
 * オリジン未登録は「見分けられない」
 * ------------------------------------------------------------------
 * 「承認済みの JavaScript 生成元」に現在のオリジンが無い場合、Google は
 * **ポップアップの中で** 400 エラーを表示する。トークンクライアントの
 * error_callback には専用の type が来ず、利用者がその画面を閉じた時点で
 * popup_closed（あるいは unknown）になる。
 *
 * つまり「利用者が自分でポップアップを閉じた」場合と区別がつかない。
 * そこで両方を1つのコードにまとめ、**文言の側で両方の可能性を案内する**
 * （errors.js の OAUTH_POPUP_CLOSED）。
 * ------------------------------------------------------------------
 */
function toErrorCode(type) {
  if (type === 'popup_failed_to_open') {
    return ErrorCode.OAUTH_POPUP_BLOCKED;
  }

  /* popup_closed / unknown / それ以外。オリジン未登録もここへ落ちる。 */
  return ErrorCode.OAUTH_POPUP_CLOSED;
}

/*
 * 認可を求める。
 *
 * 利用者の操作（ボタン押下）から呼ぶこと。
 * ポップアップを開くため、読み込み直後に自動で呼ぶとブロックされる
 * （アプリを開いただけでは認可を要求しない、という方針でもある）。
 */
export async function requestAccess() {
  if (!isOauthConfigured()) {
    throw new AppError(ErrorCode.OAUTH_NOT_CONFIGURED, 'client_id_missing');
  }

  await loadGis();

  return new Promise((resolve, reject) => {
    const client = globalThis.google.accounts.oauth2.initTokenClient({
      client_id: OAUTH.clientId,
      scope: OAUTH.scope,
      prompt: '',
      callback: (response) => {
        if (!response?.access_token) {
          reject(new AppError(ErrorCode.OAUTH_POPUP_CLOSED, 'no_access_token'));
          return;
        }

        accessToken = response.access_token;

        /* 期限は少し手前で切る。境目で 401 を踏まないため。 */
        const lifetime = Number(response.expires_in) || 3600;
        expiresAt = Date.now() + (lifetime - 60) * 1000;

        resolve(true);
      },
      error_callback: (error) => {
        reject(new AppError(toErrorCode(error?.type), `gis_${error?.type ?? 'unknown'}`));
      },
    });

    client.requestAccessToken();
  });
}

/*
 * 通信のたびにトークンを取り出す口。
 *
 * 呼び出し側はこれを引数として渡すだけで、保持しない。
 * 期限切れなら OAUTH_EXPIRED を投げ、画面が再連携を案内する。
 */
export function currentToken() {
  if (!hasValidToken()) {
    throw new AppError(ErrorCode.OAUTH_EXPIRED, 'expired');
  }

  return accessToken;
}

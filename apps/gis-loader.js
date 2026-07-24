/*
 * Google Identity Services（GIS）公式スクリプトの読み込み。
 *
 * /apps/ のログイン（google-auth.js）と、音声レコーダーの Drive 保存
 * （voice-recorder/drive-auth.js）の両方から使うため、独立させている。
 * 同じスクリプトを二重に読み込まないよう、Promise を1つだけ保持する。
 *
 * 読み込み元は公式配信のみ。自己ホスト・npm化・非公式ライブラリへの
 * 差し替えは行わない。
 *
 * 注意: クライアントID未設定のときは呼ばないこと。
 * 不要な外部通信を発生させないため、判定は呼び出し側で行う。
 */

import { GIS_SCRIPT_URL, GIS_LOAD_TIMEOUT_MS } from './auth-config.js';

let loadPromise = null;

/* GIS が利用可能かどうか（accounts 名前空間の存在で判定する）。 */
export function isGisLoaded() {
  return Boolean(globalThis.google?.accounts);
}

/*
 * GIS を読み込む。
 * 成功後は解決済みの Promise を返し続ける。
 * 失敗した場合はキャッシュを捨て、次回の呼び出しで再試行できるようにする。
 */
export function loadGisScript(timeoutMs = GIS_LOAD_TIMEOUT_MS) {
  if (isGisLoaded()) {
    return Promise.resolve();
  }

  if (loadPromise) {
    return loadPromise;
  }

  loadPromise = new Promise((resolve, reject) => {
    let settled = false;

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

    const timer = setTimeout(() => finish(new Error('GIS_TIMEOUT')), timeoutMs);

    if (typeof document === 'undefined') {
      finish(new Error('GIS_NO_DOCUMENT'));
      return;
    }

    let script;

    try {
      script = document.createElement('script');
    } catch (error) {
      finish(error);
      return;
    }

    script.src = GIS_SCRIPT_URL;
    script.async = true;
    script.defer = true;

    script.addEventListener('load', () => {
      /* 読み込めても google.accounts が無い場合がある。 */
      finish(isGisLoaded() ? null : new Error('GIS_UNAVAILABLE'));
    });

    script.addEventListener('error', () => finish(new Error('GIS_LOAD_FAILED')));

    (document.head ?? document.body)?.append(script);
  });

  /* 失敗を握りつぶさず、再試行できるようにキャッシュだけ捨てる。 */
  loadPromise.catch(() => {
    loadPromise = null;
  });

  return loadPromise;
}

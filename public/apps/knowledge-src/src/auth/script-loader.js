/*
 * 外部スクリプト（Google Identity Services / Google API Client）の読み込み。
 *
 * 読み込み元は Google 公式配信のみ。自己ホストや非公式SDKへの差し替えは行わない。
 * URLは config.js に集約し、ここでは受け取った値をそのまま使う。
 *
 * 注意: クライアントID未設定のときは呼ばないこと。
 * 不要な外部通信を発生させないため、判定は呼び出し側で行う。
 */

import { GIS_SCRIPT_URL, GAPI_SCRIPT_URL, SCRIPT_LOAD_TIMEOUT_MS } from '../config.js';
import { AppError, ErrorCode } from '../core/errors.js';

const promises = new Map();

function loadScript(url, isReady, timeoutMs) {
  if (isReady()) {
    return Promise.resolve();
  }

  const cached = promises.get(url);

  if (cached) {
    return cached;
  }

  const promise = new Promise((resolve, reject) => {
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

    const timer = setTimeout(
      () => finish(new AppError(ErrorCode.GIS_LOAD_FAILED, 'timeout')),
      timeoutMs,
    );

    const script = document.createElement('script');
    script.src = url;
    script.async = true;
    script.defer = true;

    script.addEventListener('load', () => {
      finish(isReady() ? null : new AppError(ErrorCode.GIS_LOAD_FAILED, 'namespace_missing'));
    });

    script.addEventListener('error', () => {
      finish(new AppError(ErrorCode.GIS_LOAD_FAILED, 'network'));
    });

    (document.head ?? document.body).append(script);
  });

  /* 失敗を握りつぶさず、キャッシュだけ捨てて再試行できるようにする。 */
  promise.catch(() => promises.delete(url));
  promises.set(url, promise);

  return promise;
}

export function isGisLoaded() {
  return Boolean(globalThis.google?.accounts?.oauth2);
}

export function loadGis(timeoutMs = SCRIPT_LOAD_TIMEOUT_MS) {
  return loadScript(GIS_SCRIPT_URL, isGisLoaded, timeoutMs);
}

export function isGapiLoaded() {
  return Boolean(globalThis.gapi?.load);
}

export function loadGapi(timeoutMs = SCRIPT_LOAD_TIMEOUT_MS) {
  return loadScript(GAPI_SCRIPT_URL, isGapiLoaded, timeoutMs);
}

/* gapi の名前空間（picker など）を読み込む。 */
export function loadGapiModule(name, timeoutMs = SCRIPT_LOAD_TIMEOUT_MS) {
  return loadGapi(timeoutMs).then(() => new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new AppError(ErrorCode.GIS_LOAD_FAILED, `gapi_${name}_timeout`)),
      timeoutMs,
    );

    try {
      globalThis.gapi.load(name, {
        callback: () => {
          clearTimeout(timer);
          resolve();
        },
        onerror: () => {
          clearTimeout(timer);
          reject(new AppError(ErrorCode.GIS_LOAD_FAILED, `gapi_${name}_failed`));
        },
      });
    } catch (error) {
      clearTimeout(timer);
      reject(new AppError(ErrorCode.GIS_LOAD_FAILED, error?.message ?? `gapi_${name}_throw`));
    }
  }));
}

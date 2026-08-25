/*
 * Google Identity Services（GIS）公式スクリプトの読み込み。
 *
 * ==================================================================
 * 複製元
 * ==================================================================
 * ../card-ocr/gis-loader.js を複製（2026-08-20）。**import はしない。**
 *
 * 本番アプリどうしでも共通層を作らず複製する（docs/repository-structure.md
 * §4-1）。構造（Promise を1つだけ持つ、失敗時にキャッシュを捨てる）は同じ。
 * ==================================================================
 *
 * ==================================================================
 * 失敗したキャッシュを残さないこと
 * ==================================================================
 * 読み込みの Promise を使い回すのは通信を1回で済ませるためだが、
 * **reject した Promise を残すと、そのページを開いているあいだ
 * 連携が二度と成功しない。**
 * ==================================================================
 *
 * 読み込み元は公式配信のみ。自己ホスト・npm化・非公式ライブラリへの
 * 差し替えは行わない（docs/external-dependency-approvals.md）。
 *
 * **クライアントID未設定のときは呼ばないこと。**
 * 不要な外部通信を発生させないため、判定は呼び出し側で行う。
 */

import { GIS_SCRIPT_URL, GIS_LOAD_TIMEOUT_MS } from './config.js';

let loadPromise = null;

/* GIS が利用可能かどうか（accounts 名前空間の存在で判定する）。 */
export function isGisLoaded() {
  return Boolean(globalThis.google?.accounts);
}

/* テスト用。読み込み済みキャッシュを捨てる。 */
export function resetGisLoader() {
  loadPromise = null;
}

/*
 * GIS を読み込む。
 *
 * 既に読み込まれていれば何もしない。したがってテストでは
 * `globalThis.google` を差し替えておけば、実際の通信は発生しない。
 *
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

    /*
     * 時間制限を置く。<script> は応答が返らない場合に load も error も
     * 発火しないため、これが無いと画面が固まったままになる。
     */
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

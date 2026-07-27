/*
 * Google Picker の読み込みと表示。
 *
 * ------------------------------------------------------------------
 * 現在このモジュールは使われていない（重要）
 * ------------------------------------------------------------------
 * このアプリの音声取得元は、次の2つに限定されている。
 *
 *   1. 端末のファイル選択
 *   2. マイドライブ ＞ TSAM AI ＞ Voice Recorder（固定フォルダ）
 *
 * Drive 側は drive-client.js が Drive API で固定フォルダだけを読む。
 * ドライブ全体から選ばせる Picker は経路から外してあり、
 * script.js からは import していない。
 *
 * 将来ドライブ全体から選ばせたくなったときのために残してある。
 * 再び使う場合は index.html の CSP に次を戻すこと（今は外してある）。
 *
 *   script-src / connect-src … https://apis.google.com
 *   frame-src                … https://docs.google.com
 *                              https://content-drive.googleapis.com
 * ------------------------------------------------------------------
 *
 * ------------------------------------------------------------------
 * なぜ「使えるときだけ使う」形にしているか
 * ------------------------------------------------------------------
 * Picker は Drive 上の任意のファイルを選ばせる唯一の正規の方法で、
 * 選ばれたファイルは drive.file スコープの対象になる。
 * つまりスコープを広げずに「利用者の音声を1つだけ読む」ことができる。
 *
 * ただし Picker はブラウザ用の API キー（developerKey）を要求する。
 * このリポジトリの方針では、追跡されるファイルにキーを置かない。
 * 実キーは picker-key.local.js（.gitignore 済み）にだけ置き、
 * ここから動的 import で読む（名刺スキャナと同じ方式）。
 *
 * そこで:
 *   picker-key.local.js があってキーが入っていれば … Picker を使う
 *   無い、または空なら                            … Drive API の一覧へ切り替える
 *
 * 一覧方式でも voice-recorder が保存した録音は選べるので、
 * キー未設定でも機能そのものは成立する。差は「選べる範囲」だけである。
 * ------------------------------------------------------------------
 *
 * developerKey は公開情報だが、無制限のキーではない。
 * README に書いたとおり、必ず HTTP リファラー制限と API 制限を掛けること。
 */

import { AUDIO_MIME_TYPES, DRIVE } from './config.js';

const GAPI_SCRIPT_URL = 'https://apis.google.com/js/api.js';
const LOAD_TIMEOUT_MS = 15000;

export const PickerErrorCode = {
  UNAVAILABLE: 'UNAVAILABLE',
  LOAD_FAILED: 'LOAD_FAILED',
  CANCELLED: 'CANCELLED',
  UNKNOWN: 'UNKNOWN',
};

export class PickerError extends Error {
  constructor(code, detail = null) {
    super(code);
    this.name = 'PickerError';
    this.code = code;
    this.detail = detail;
  }
}

/* ---------- APIキーの読み込み ---------- */

/* ローカル設定の置き場所。存在しなくてよい。 */
const LOCAL_KEY_MODULE = './picker-key.local.js';

let developerKey = '';
let keyLoaded = false;
let keyLoadPromise = null;

/*
 * ローカル設定を読み込む。
 *
 * picker-key.local.js が無い場合、動的 import は失敗する。
 * これは異常ではなく既定の状態なので、握りつぶして「未設定」として扱う
 * （404 はネットワークタブに出るが、それでよい）。
 *
 * 何度呼んでも読み込みは1回だけ。
 * isPickerConfigured() を見る前に必ず await すること。
 */
export function loadPickerConfig() {
  if (keyLoaded) {
    return Promise.resolve(developerKey !== '');
  }

  if (keyLoadPromise) {
    return keyLoadPromise;
  }

  keyLoadPromise = (async () => {
    try {
      const local = await import(LOCAL_KEY_MODULE);
      const value = local?.PICKER_API_KEY;
      developerKey = typeof value === 'string' ? value.trim() : '';
    } catch {
      /* 未配置。想定内なので何も出さない。 */
      developerKey = '';
    }

    keyLoaded = true;
    return developerKey !== '';
  })();

  return keyLoadPromise;
}

/*
 * キーが設定されているか。UIはこれを見て導線を切り替える。
 * loadPickerConfig() を待つ前に呼ぶと、常に false を返す点に注意する。
 */
export function isPickerConfigured() {
  return keyLoaded && developerKey !== '';
}

/* ---------- スクリプトの読み込み ---------- */

let loadPromise = null;

function loadGapiScript() {
  if (globalThis.gapi?.load) {
    return Promise.resolve(globalThis.gapi);
  }

  const existing = document.querySelector(`script[src="${GAPI_SCRIPT_URL}"]`);

  if (existing) {
    /*
     * 別の経路で読み込み済み。onload はもう発火しないかもしれないので、
     * gapi が生えるのを待つ（下のポーリングで拾う）。
     */
    return waitForGapi();
  }

  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = GAPI_SCRIPT_URL;
    script.async = true;
    script.defer = true;
    script.addEventListener('load', () => resolve(waitForGapi()));
    script.addEventListener('error', () => {
      reject(new PickerError(PickerErrorCode.LOAD_FAILED, 'script_error'));
    });
    document.head.append(script);
  });
}

function waitForGapi() {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + LOAD_TIMEOUT_MS;

    const check = () => {
      if (globalThis.gapi?.load) {
        resolve(globalThis.gapi);
        return;
      }

      if (Date.now() >= deadline) {
        reject(new PickerError(PickerErrorCode.LOAD_FAILED, 'timeout'));
        return;
      }

      window.setTimeout(check, 100);
    };

    check();
  });
}

/* gapi.load('picker') は同じモジュールを二重に読み込まないので、そのまま呼んでよい。 */
function loadPickerModule(gapi) {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      reject(new PickerError(PickerErrorCode.LOAD_FAILED, 'picker_timeout'));
    }, LOAD_TIMEOUT_MS);

    gapi.load('picker', {
      callback: () => {
        window.clearTimeout(timer);

        if (globalThis.google?.picker) {
          resolve(globalThis.google.picker);
          return;
        }

        reject(new PickerError(PickerErrorCode.LOAD_FAILED, 'picker_missing'));
      },
      onerror: () => {
        window.clearTimeout(timer);
        reject(new PickerError(PickerErrorCode.LOAD_FAILED, 'picker_load_error'));
      },
    });
  });
}

/* 読み込みは1回だけ行い、以降は同じ Promise を返す。 */
export function ensurePicker() {
  if (!isPickerConfigured()) {
    return Promise.reject(new PickerError(PickerErrorCode.UNAVAILABLE, 'api_key_missing'));
  }

  if (!loadPromise) {
    loadPromise = loadGapiScript()
      .then(loadPickerModule)
      .catch((error) => {
        /* 失敗したら次回やり直せるようにする。 */
        loadPromise = null;
        throw error instanceof PickerError
          ? error
          : new PickerError(PickerErrorCode.LOAD_FAILED, error?.name ?? 'unknown');
      });
  }

  return loadPromise;
}

/* ---------- 表示 ---------- */

/*
 * Picker を開き、選ばれた1件を返す。
 *
 * 戻り値: { id, name, mimeType, sizeBytes } または null（利用者が閉じた）
 * token は ../drive-auth.js の ensureAccessToken() で得たもの。
 */
export async function pickAudioFile({ token }) {
  const picker = await ensurePicker();

  return new Promise((resolve, reject) => {
    let view;

    try {
      view = new picker.DocsView(picker.ViewId.DOCS)
        .setIncludeFolders(true)
        .setSelectFolderEnabled(false)
        .setMimeTypes(AUDIO_MIME_TYPES.join(','));
    } catch (error) {
      reject(new PickerError(PickerErrorCode.UNKNOWN, error?.name ?? 'view_failed'));
      return;
    }

    let dialog;

    try {
      dialog = new picker.PickerBuilder()
        .setOAuthToken(token)
        .setDeveloperKey(developerKey)
        /* appId が無いと、選択直後は読めても次回以降 403 になることがある。 */
        .setAppId(DRIVE.pickerAppId)
        .setTitle('文字起こしする音声ファイルを選択')
        .setLocale('ja')
        .addView(view)
        .setCallback((data) => {
          const action = data?.[picker.Response.ACTION];

          if (action === picker.Action.CANCEL) {
            resolve(null);
            return;
          }

          if (action !== picker.Action.PICKED) {
            /* LOADED など、まだ選択が確定していない通知は無視する。 */
            return;
          }

          const doc = data?.[picker.Response.DOCUMENTS]?.[0];

          if (!doc?.[picker.Document.ID]) {
            resolve(null);
            return;
          }

          resolve({
            id: String(doc[picker.Document.ID]),
            /* 表示名・MIMEは外部入力。DOMへは textContent 経由でしか出さない。 */
            name: String(doc[picker.Document.NAME] ?? 'audio'),
            mimeType: String(doc[picker.Document.MIME_TYPE] ?? ''),
            sizeBytes: Number(doc.sizeBytes ?? 0) || null,
          });
        })
        .build();
    } catch (error) {
      reject(new PickerError(PickerErrorCode.UNKNOWN, error?.name ?? 'build_failed'));
      return;
    }

    dialog.setVisible(true);
  });
}

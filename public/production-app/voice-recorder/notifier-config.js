/*
 * カレンダー通知の静的設定と、GAS 接続情報の保管。
 *
 * ------------------------------------------------------------------
 * Service Worker とは import で共有できない
 * ------------------------------------------------------------------
 * sw.js は**旧式（クラシック）の Service Worker** として登録している。
 * `type: 'module'` の Service Worker は未対応のブラウザで登録そのものが
 * 失敗するためで、旧式である以上 import は使えない。
 *
 * そのため、下の DB 定義と読み出し（openDb / readConnection 相当）は
 * **sw.js 側に複製してある。** 片方だけ変えないこと。
 * 対になっているのは sw.js の「notifier-config.js からの複製」節。
 * ------------------------------------------------------------------
 *
 * ------------------------------------------------------------------
 * 保管場所の名前を /apps/ と衝突させない
 * ------------------------------------------------------------------
 * `/apps/`（テスト環境）と `/production-app/`（本番）は**同一オリジン**で、
 * IndexedDB と localStorage を共有する。名前が同じだと、テスト環境で
 * 接続先を差し替えた結果が本番の Service Worker に見える。
 * 将来テスト環境側にも実装する場合は `-apps` 接尾辞で分離すること。
 * ------------------------------------------------------------------
 */

/* 接続情報の保管先（IndexedDB）。Service Worker は localStorage を読めない。 */
export const DB_NAME = 'tsam-vr-notifier';
export const DB_VERSION = 1;
export const STORE_NAME = 'config';
export const CONNECTION_KEY = 'connection';

/* 設定の表示キャッシュ（localStorage）。正はGAS側にある（FR-08）。 */
export const SETTINGS_CACHE_KEY = 'tsam-vr-notifier-settings';

/*
 * カレンダー通知のライセンスゲート（Cloudflare Workers）のオリジン。
 *
 * ------------------------------------------------------------------
 * ここに直書きせず、必ずこの定数を使うこと
 * ------------------------------------------------------------------
 * 同じURLが Workers の設定・利用者の Apps Script・この定数・index.html の
 * CSP（connect-src）の4か所に現れる。実行環境が違うため import では
 * 共有できないので、**正本を1つ決めてテストで一致を見張る**形にしてある。
 *
 * 正本は workers/notifier-gate/origin.mjs の NOTIFIER_GATE_ORIGIN。
 * 値を変えるときは、そちらを直してから
 * `node tests/run.mjs notifier-gate` の指示に従って全部を揃える。
 *
 * 独自ドメインへ移しても、この workers.dev のURLは並行して有効なままなので、
 * 既にセットアップ済みの利用者に再設定を求める必要はない
 * （workers/notifier-gate/README.md §8）。
 * ------------------------------------------------------------------
 */
export const NOTIFIER_GATE_ORIGIN = 'https://notifier-gate.potenitas-lp.workers.dev';

/*
 * テンプレートシートのコピーURL。
 * 開くとコピー画面になる（`/copy` 付き）。作り方は gas-notifier/README.md §1。
 */
export const TEMPLATE_COPY_URL =
  'https://docs.google.com/spreadsheets/d/1weeur2CAR6YmeY6dqXyfAJdPj4di5oAfircsytoa3XM/copy';

/* 通知タイミング（FR-10）。値は「何分前か」。0 は開始時刻ちょうど。 */
export const TIMING_OPTIONS = Object.freeze([
  Object.freeze({ value: 0, label: '開始時刻' }),
  Object.freeze({ value: 5, label: '5分前' }),
  Object.freeze({ value: 10, label: '10分前' }),
  Object.freeze({ value: 15, label: '15分前' }),
]);

/*
 * 既定値（FR-06 / FR-07 / FR-11）。
 * GAS 側（gas-notifier/Store.gs の DEFAULT_SETTINGS）と同じ値にすること。
 * 画面が先に描かれてから GAS の応答で上書きされるため、ここがずれていると
 * 一瞬だけ違う状態が見える。
 */
export const DEFAULT_SETTINGS = Object.freeze({
  accepted: true,
  tentative: true,
  needsAction: true,
  declined: false,
  timedOnly: true,
  timing: 5,
});

/* 出欠フィルタの表示名（FR-05）。順序はそのまま画面の並び順。 */
export const RESPONSE_FILTERS = Object.freeze([
  Object.freeze({ key: 'accepted', label: '参加予定' }),
  Object.freeze({ key: 'tentative', label: '仮参加' }),
  Object.freeze({ key: 'needsAction', label: '未回答' }),
  Object.freeze({ key: 'declined', label: '辞退' }),
]);

/* ---------- 接続情報（IndexedDB） ---------- */

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/*
 * 接続情報 { url, key } を読む。未設定なら null。
 *
 * **接続キーは秘密である。** ここから読んだ値をログや画面へそのまま出さない
 * （設定画面では入力欄にだけ入れ、確認は「接続テスト」の結果で行う）。
 */
export async function readConnection() {
  const db = await openDb();

  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction(STORE_NAME, 'readonly')
        .objectStore(STORE_NAME)
        .get(CONNECTION_KEY);

      request.onsuccess = () => {
        const value = request.result;

        if (!value || typeof value.url !== 'string' || typeof value.key !== 'string') {
          resolve(null);
          return;
        }

        resolve({ url: value.url, key: value.key });
      };

      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

export async function writeConnection({ url, key }) {
  const db = await openDb();

  try {
    await new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');

      transaction.objectStore(STORE_NAME).put({ url, key }, CONNECTION_KEY);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}

export async function clearConnection() {
  const db = await openDb();

  try {
    await new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');

      transaction.objectStore(STORE_NAME).delete(CONNECTION_KEY);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}

/*
 * 貼り付けられた GAS の URL を整える。
 * 末尾の空白と、コピー時に付きがちな `?...` を落として `/exec` までにする。
 */
export function normalizeGasUrl(input) {
  const text = String(input ?? '').trim();

  if (text === '') {
    return '';
  }

  const withoutQuery = text.split('#')[0].split('?')[0];

  return withoutQuery.replace(/\/+$/, '');
}

/* 形として GAS の Web アプリURLか。判定であって、到達確認ではない。 */
export function isGasUrl(input) {
  const url = normalizeGasUrl(input);

  return /^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(url);
}

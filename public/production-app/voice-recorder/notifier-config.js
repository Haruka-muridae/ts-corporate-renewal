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

/*
 * ライセンスキーの保管先。接続情報と同じストアの別キーにする。
 *
 * **Service Worker はこれを読まない。** ライセンスの検証は GAS とゲートの間で
 * 行われ、ブラウザ側は「セットアップの途中で預かって GAS へ渡す」だけである。
 */
export const LICENSE_KEY_NAME = 'license';

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
  'https://docs.google.com/spreadsheets/d/1rSLxEvuhfP_1d8w61t8J_hkhV_ysmmR74JwXVC6hMA8/copy';

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

/* ---------- ライセンスキー ---------- */

/**
 * ライセンスキーを読む。未設定なら ''。
 *
 * **画面へ出さない。** これは「通知を受け取る権利」そのもので、
 * 接続キーと同じ扱いにする（ログにも例外にも入れない）。
 */
export async function readLicenseKey() {
  const db = await openDb();

  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction(STORE_NAME, 'readonly')
        .objectStore(STORE_NAME)
        .get(LICENSE_KEY_NAME);

      request.onsuccess = () => {
        const value = request.result;
        resolve(typeof value === 'string' ? value : '');
      };

      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

export async function writeLicenseKey(licenseKey) {
  const db = await openDb();

  try {
    await new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');

      transaction.objectStore(STORE_NAME).put(String(licenseKey), LICENSE_KEY_NAME);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}

export async function clearLicenseKey() {
  const db = await openDb();

  try {
    await new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');

      transaction.objectStore(STORE_NAME).delete(LICENSE_KEY_NAME);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}

/** ライセンスキーの形（base64url の22〜128文字）。GAS 側の検証と同じ。 */
export function isLicenseKeyShaped(value) {
  return /^[A-Za-z0-9_-]{22,128}$/.test(String(value ?? '').trim());
}

/* ---------- セットアップの引き継ぎ（#setup=） ---------- */

/**
 * ウィザードが作ったリンクの `#setup=` を読む。
 *
 * ------------------------------------------------------------------
 * 検証してから使う
 * ------------------------------------------------------------------
 * このリンクはURLであり、**誰でも作れる。** 中身をそのまま信じると、
 * 攻撃者の用意したサーバーを「接続先」として保存させられる。
 * そうなると、以後この端末の Service Worker が予定の内容を
 * その相手へ取りに行くことになる。
 *
 * したがって execUrl は **script.google.com の /exec だけ**を許す。
 * 形が違えば黙って捨てる（利用者が直せる類の問題ではない）。
 * ------------------------------------------------------------------
 *
 * 戻り値は { url, key } または null。
 */
export function parseSetupFragment(hash) {
  const text = String(hash ?? '');
  const marker = text.indexOf('#setup=');

  if (marker === -1) {
    return null;
  }

  const encoded = text.slice(marker + '#setup='.length).split('&')[0];

  if (encoded === '') {
    return null;
  }

  let payload = null;

  try {
    const normalized = encoded.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);

    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }

    payload = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }

  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const url = normalizeGasUrl(payload.execUrl);
  const key = String(payload.connectKey ?? '').trim();

  if (!isGasUrl(url) || key === '') {
    return null;
  }

  return { url, key };
}

/*
 * 貼り付けられた GAS の URL を整える。
 *
 * ------------------------------------------------------------------
 * ドメイン付きの形を素の形へ寄せる
 * ------------------------------------------------------------------
 * Google Workspace のアカウントでは、デプロイURLが
 * `https://script.google.com/a/macros/<ドメイン>/s/<ID>/exec` の形で返る。
 * この形は**そのドメインでのログインを求められることがある**ため、匿名で叩く
 * Service Worker からは使えない場合がある。同じデプロイは
 * `/macros/s/<ID>/exec` でも開けるので、そちらへ寄せる。
 *
 * 実機では、この形のURLが引き継ぎリンクに載って接続できなかった（2026-08-11）。
 * **拒否ではなく正規化にしているのは、Workspace の利用者を締め出さないため。**
 * GAS 側（Setup.gs の normalizeExecUrl_）にも同じ変換がある。
 * ------------------------------------------------------------------
 *
 * 末尾の空白と、コピー時に付きがちな `?...` `#...` も落とす。
 */
export function normalizeGasUrl(input) {
  const text = String(input ?? '').trim();

  if (text === '') {
    return '';
  }

  const withoutQuery = text.split('#')[0].split('?')[0].replace(/\/+$/, '');

  const domainForm = withoutQuery.match(
    /^https:\/\/script\.google\.com\/a\/macros\/[^/]+\/s\/([\w-]+)\/exec$/,
  );

  if (domainForm) {
    return `https://script.google.com/macros/s/${domainForm[1]}/exec`;
  }

  return withoutQuery;
}

/* 形として GAS の Web アプリURLか。判定であって、到達確認ではない。 */
export function isGasUrl(input) {
  const url = normalizeGasUrl(input);

  return /^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(url);
}

/**
 * URL の指紋（SHA-256 の先頭12文字）。
 *
 * GAS 側（Setup.gs の execUrlDigest_）と**同じ計算**にしてある。
 * health が返す値と突き合わせて、「シートが公開したデプロイ」と
 * 「いま自分が繋いでいる先」が同じかを見る。
 * 実機では3種類のURLが食い違っていたのに、それを知る手段が無かった。
 */
export async function execUrlDigest(url) {
  const text = String(url ?? '').trim();

  if (text === '' || !globalThis.crypto?.subtle) {
    return '';
  }

  const bytes = new Uint8Array(
    await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)),
  );

  let hex = '';

  for (let i = 0; i < bytes.length && hex.length < 12; i += 1) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }

  return hex.slice(0, 12);
}

/*
 * カレンダーURL通知アプリ。
 *
 * 仕様は docs/specs/calendar-url-notifier-requirements-v1.md。
 *
 * ==================================================================
 * この画面がすること
 * ==================================================================
 *   1. guardPage() が利用者を返すまで中身を出さない
 *   2. 引き継ぎリンク（#setup=）から接続先を受け取って保存する
 *   3. この端末を Push に登録する
 *   4. 設定（通知の分数・出欠・URL通知の ON/OFF）を GAS へ保存する
 *   5. 直近の通知予定を出す／テスト通知を送る
 *
 * 通知そのものを出すのは Service Worker（sw.js）である。
 * ==================================================================
 *
 * ==================================================================
 * テスト環境（public/apps/voice-recorder/）から import しない
 * ==================================================================
 * 同じ GAS と話す実装がテスト環境にあるが、本番がそこへ依存すると
 * 向きが逆になる（CLAUDE.md）。必要な部分は写して持っている。
 * ==================================================================
 */

import { guardPage } from '../../auth/session.js';

/* ---------- 接続情報の置き場（sw.js と同じ定義。片方だけ変えない） ---------- */

const DB_NAME = 'tsam-curl-notifier';
const DB_VERSION = 1;
const STORE_NAME = 'config';
const CONNECTION_KEY = 'connection';

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

function withStore(mode, run) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const store = db.transaction(STORE_NAME, mode).objectStore(STORE_NAME);
    const request = run(store);

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }).finally(() => db.close()));
}

function readConnection() {
  return withStore('readonly', (store) => store.get(CONNECTION_KEY)).then((value) => {
    if (!value || typeof value.url !== 'string' || typeof value.key !== 'string') {
      return null;
    }

    return { url: value.url, key: value.key };
  }).catch(() => null);
}

function writeConnection(connection) {
  return withStore('readwrite', (store) => store.put(connection, CONNECTION_KEY));
}

/* ---------- 引き継ぎリンク（#setup=） ---------- */

/**
 * ウィザードが出すリンクから接続先を取り出す。
 *
 * 値はフラグメントで渡る。**クエリにしない。**
 * フラグメントはサーバーへ送られないため、接続キーが配信ログに残らない。
 */
function parseSetupFragment(hash) {
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

  const url = String(payload.execUrl ?? '').trim();
  const key = String(payload.connectKey ?? '').trim();

  /* 宛先は Apps Script のウェブアプリに限る。任意のURLを保存しない。 */
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec$/.test(url) || key === '') {
    return null;
  }

  return { url, key };
}

/* ---------- GAS との通信 ---------- */

async function gasGet(connection, action, params = {}) {
  const query = new URLSearchParams({ action, key: connection.key, ...params });
  const response = await fetch(`${connection.url}?${query.toString()}`, { redirect: 'follow' });

  if (!response.ok) {
    throw new Error(`GAS への要求が失敗しました: ${response.status}`);
  }

  const payload = await response.json();

  if (!payload || payload.ok !== true) {
    throw new Error(payload?.error?.code ?? 'UNKNOWN');
  }

  return payload.data ?? {};
}

async function gasPost(connection, action, body = {}) {
  /* text/plain にしているのはプリフライトを避けるため（GAS は OPTIONS を返せない）。 */
  const response = await fetch(connection.url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action, key: connection.key, ...body }),
    redirect: 'follow',
  });

  if (!response.ok) {
    throw new Error(`GAS への要求が失敗しました: ${response.status}`);
  }

  const payload = await response.json();

  if (!payload || payload.ok !== true) {
    throw new Error(payload?.error?.code ?? 'UNKNOWN');
  }

  return payload.data ?? {};
}

/* ---------- 画面 ---------- */

const el = (id) => document.getElementById(id);

let connection = null;

function setMessage(text, kind = 'info') {
  const box = el('cun-message');

  box.textContent = text;
  box.dataset.kind = kind;
  box.hidden = text === '';
}

function setConnectionState(text) {
  el('cun-connection-state').textContent = text;
}

function showSection(id, visible) {
  el(id).hidden = !visible;
}

/** 通知の分数と出欠は GAS が正。画面はその写しにする。 */
function renderSettings(settings) {
  el('cun-timing').value = String(settings.timing ?? 5);
  el('cun-enabled').checked = settings.openUrlEnabled === true;

  for (const status of ['accepted', 'tentative', 'needsAction', 'declined']) {
    el(`cun-${status}`).checked = settings[status] === true;
  }
}

function renderUpcoming(all) {
  const list = el('cun-upcoming-list');

  /*
   * 1つの通知シートで録音通知（calendar）と URL通知（openurl）が動く。
   * この画面は自分の機能ぶんだけを出す。混ぜると、録音アプリ側の予定を
   * 「URL が開く通知」として読んでしまう。
   */
  const items = (all ?? []).filter((item) => String(item?.feature ?? '') === 'openurl');

  list.textContent = '';

  if (items.length === 0) {
    el('cun-upcoming-empty').hidden = false;
    return;
  }

  el('cun-upcoming-empty').hidden = true;

  for (const item of items) {
    const row = document.createElement('li');
    const when = new Date(item.notifyAt);
    const time = isNaN(when.getTime())
      ? ''
      : `${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`;

    /* 予定名も URL も利用者のものである。textContent で入れる（innerHTML を使わない）。 */
    row.textContent = time === '' ? String(item.title ?? '') : `${time}　${item.title ?? ''}`;
    list.appendChild(row);
  }
}

async function refreshState() {
  if (!connection) {
    setConnectionState('未接続');
    showSection('cun-configured', false);
    showSection('cun-setup', true);
    return;
  }

  setConnectionState('確認中…');

  try {
    const settings = await gasGet(connection, 'getSettings');

    renderSettings(settings.settings ?? {});
    setConnectionState('接続済み');
    showSection('cun-configured', true);
    showSection('cun-setup', false);

    const upcoming = await gasGet(connection, 'upcoming');

    renderUpcoming(upcoming.upcoming ?? []);
  } catch (error) {
    setConnectionState('接続できません');
    setMessage(`通知シートへ接続できませんでした（${error.message}）。引き継ぎリンクをもう一度お試しください。`, 'error');
  }
}

/* ---------- Push の登録 ---------- */

/**
 * この端末を Push に登録する。
 *
 * 通知の許可は**利用者が押したときに求める**。読み込みと同時に出すと、
 * 何のための許可なのか分からないまま拒否され、やり直しが効かなくなる。
 */
async function subscribeThisDevice() {
  if (!('serviceWorker' in navigator) || !('PushManager' in globalThis)) {
    setMessage('このブラウザは Web Push に対応していません。', 'error');
    return;
  }

  const permission = await Notification.requestPermission();

  if (permission !== 'granted') {
    setMessage('通知が許可されませんでした。ブラウザの設定から許可すると受け取れます。', 'error');
    return;
  }

  const registration = await navigator.serviceWorker.register('./sw.js');
  const ready = await navigator.serviceWorker.ready.then(() => registration);
  const { publicKey } = await gasGet(connection, 'publicKey');

  const subscription = await ready.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: base64UrlToUint8Array(publicKey),
  });

  await gasPost(connection, 'saveSubscription', { subscription: subscription.toJSON() });

  setMessage('この端末を登録しました。', 'success');
}

function base64UrlToUint8Array(text) {
  const padded = String(text).replace(/-/g, '+').replace(/_/g, '/');
  const padding = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4));
  const binary = atob(padded + padding);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes;
}

/* ---------- 操作 ---------- */

function currentSettingsFromForm() {
  return {
    openUrlEnabled: el('cun-enabled').checked,
    timing: Number(el('cun-timing').value),
    accepted: el('cun-accepted').checked,
    tentative: el('cun-tentative').checked,
    needsAction: el('cun-needsAction').checked,
    declined: el('cun-declined').checked,
  };
}

function bindEvents() {
  el('cun-save').addEventListener('click', async () => {
    try {
      const saved = await gasPost(connection, 'saveSettings', { settings: currentSettingsFromForm() });

      renderSettings(saved.settings ?? {});
      setMessage('設定を保存しました。次の判定から反映されます。', 'success');
    } catch (error) {
      setMessage(`設定を保存できませんでした（${error.message}）。`, 'error');
    }
  });

  el('cun-subscribe').addEventListener('click', async () => {
    try {
      await subscribeThisDevice();
    } catch (error) {
      setMessage(`この端末を登録できませんでした（${error.message}）。`, 'error');
    }
  });

  el('cun-test').addEventListener('click', async () => {
    try {
      await gasPost(connection, 'sendTestNotification', {});
      setMessage('テスト通知を送りました。届かない場合は端末の通知設定をご確認ください。', 'success');
    } catch (error) {
      setMessage(`テスト通知を送れませんでした（${error.message}）。`, 'error');
    }
  });

  el('cun-sync').addEventListener('click', async () => {
    try {
      await gasPost(connection, 'syncNow', {});
      setMessage('カレンダーを読み直しました。', 'success');

      const upcoming = await gasGet(connection, 'upcoming');

      renderUpcoming(upcoming.items ?? []);
    } catch (error) {
      setMessage(`読み直せませんでした（${error.message}）。`, 'error');
    }
  });
}

/* ---------- 起動 ---------- */

async function main() {
  /*
   * ポータル認証の確認。共通実装の guardPage() を使う（独自実装は禁止）。
   *
   * 静的配信のため、この画面の HTML と JS の取得自体は防げない。
   * 守られているのは通知シートの中身であり、それを守るのは接続キーである
   * （SECURITY_NOTES.md / docs/notifier-design-notes.md §7）。
   */
  const user = await guardPage();

  if (!user) {
    return;
  }

  el('cun-loading').hidden = true;
  el('cun-content').hidden = false;

  const handoff = parseSetupFragment(globalThis.location?.hash ?? '');

  if (handoff) {
    await writeConnection(handoff);

    /*
     * 受け取ったら消す。履歴や共有されたURLに接続キーを残さない。
     * replaceState なので戻る操作でも復活しない。
     */
    history.replaceState(null, '', globalThis.location.pathname + globalThis.location.search);
    setMessage('通知シートと接続しました。', 'success');
  }

  connection = await readConnection();

  bindEvents();
  await refreshState();
}

main().catch((error) => {
  console.error('[calendar-url-notifier]', error);
  setMessage('画面を読み込めませんでした。時間をおいて開き直してください。', 'error');
});

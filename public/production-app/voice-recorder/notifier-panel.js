/*
 * 「Googleカレンダー連携」の画面制御（要件書 5.1 / FR-05〜FR-11 / NFR-05）。
 *
 * ==================================================================
 * ここに録音のコードを書かない
 * ==================================================================
 * 通知の受信やクリックで録音を始めてはならない（FR-20 / NFR-06）。
 * このファイルに getUserMedia / MediaRecorder / recorder.start が
 * 現れないことを、自動テストが文字列として見張っている。
 * ==================================================================
 *
 * ==================================================================
 * 呼ぶのは guardPage() を通ったあと
 * ==================================================================
 * app.js の main() から、ログイン済みが確定してから mountNotifier() を呼ぶ。
 * 未ログインの画面で Service Worker を登録したり通知許可を求めたりしない。
 * ==================================================================
 *
 * innerHTML は使わない（app.js と同じ理由）。予定名は Google の応答であり、
 * 外から来た値として扱う。文字は textContent、要素は createElement で作る。
 *
 * 接続キーは入力欄の中だけで扱う。**console にも例外にも出さない。**
 */

import {
  DEFAULT_SETTINGS,
  RESPONSE_FILTERS,
  SETTINGS_CACHE_KEY,
  TEMPLATE_COPY_URL,
  TIMING_OPTIONS,
  clearConnection,
  isGasUrl,
  normalizeGasUrl,
  readConnection,
  writeConnection,
} from './notifier-config.js';

import {
  NotifierError,
  NotifierErrorCode,
  describeNotifierError,
  fetchEvent,
  fetchHealth,
  fetchPublicKey,
  fetchSettings,
  saveSettings,
  saveSubscription,
} from './notifier-client.js';

import { formatEventBanner } from './notifier-messages.js';

/* ---------- 要素 ---------- */

const el = {};

const ELEMENT_IDS = [
  'vr-notifier-panel',
  'vr-nf-state-health', 'vr-nf-state-key', 'vr-nf-state-permission',
  'vr-nf-state-subscription', 'vr-nf-state-trigger',
  'vr-nf-hint-health', 'vr-nf-hint-key', 'vr-nf-hint-permission',
  'vr-nf-hint-subscription', 'vr-nf-hint-trigger',
  'vr-nf-permission',
  'vr-nf-template', 'vr-nf-url', 'vr-nf-key', 'vr-nf-connect', 'vr-nf-disconnect',
  'vr-nf-connection', 'vr-nf-settings-form',
  'vr-nf-timedOnly', 'vr-nf-timing', 'vr-nf-save', 'vr-nf-recheck',
  'vr-nf-message', 'vr-event-banner',
];

/* 出欠フィルタのチェックボックスは RESPONSE_FILTERS から引く。 */
function filterInput(key) {
  return el[`vr-nf-${key}`];
}

/* ---------- 状態 ---------- */

/*
 * 接続情報。**画面の状態にキーを写さない**ため、ここには持つが
 * 表示のたびに参照するだけにして、DOM へは入れない。
 */
let connection = null;

/* 二重送信の防止。接続テストは通信が5往復あり、連打で状態表示が乱れる。 */
let busy = false;

/* ---------- 表示 ---------- */

function setStep(name, text, kind, hint = '') {
  const state = el[`vr-nf-state-${name}`];
  const hintNode = el[`vr-nf-hint-${name}`];

  if (state) {
    state.textContent = text;
    state.dataset.kind = kind;
  }

  if (hintNode) {
    hintNode.textContent = hint;
    hintNode.hidden = hint === '';
  }
}

function showMessage(text, kind = '') {
  el['vr-nf-message'].textContent = text;
  el['vr-nf-message'].dataset.kind = kind;
  el['vr-nf-message'].hidden = text === '';
}

/*
 * 例外を画面文言に変える。生の例外はコンソールへ残す（app.js と同じ方針）。
 * 接続キーは例外に入れていないため、ここから漏れることはない。
 */
function reportError(error) {
  console.error('[voice-recorder:notifier]', error);
  showMessage(describeNotifierError(error), 'error');
}

/* ---------- セットアップ状態チェッカー ---------- */

/*
 * 5段階を順に確かめる（要件書 5.1 の「接続テスト」の実体）。
 *   1. health が返るか（URLが正しいか）
 *   2. publicKey が取れるか（接続キーとGAS側セットアップ）
 *   3. ブラウザの通知許可（NFR-05）
 *   4. この端末のPush購読とGASへの登録
 *   5. GAS側の毎分トリガーが動いているか（health の triggerActive）
 *
 * 前段が × のときは後段を「確認できません」にする。
 * 通信できていないのに「鍵が無い」と出すと、直す場所を誤らせる。
 */
async function runChecks() {
  if (!connection) {
    setStep('health', '未接続', 'error', '下の「接続の設定」からGASのURLと接続キーを貼り付けてください。');
    setStep('key', '確認できません', '');
    setStep('permission', permissionLabel(), permissionKind());
    setStep('subscription', '確認できません', '');
    setStep('trigger', '確認できません', '');
    return false;
  }

  let health = null;

  try {
    health = await fetchHealth(connection);
    setStep('health', '接続できました', 'ok');
  } catch (error) {
    setStep('health', '接続できません', 'error', describeNotifierError(error));
    setStep('key', '確認できません', '');
    setStep('subscription', '確認できません', '');
    setStep('trigger', '確認できません', '');
    return false;
  }

  let publicKey = '';

  try {
    publicKey = await fetchPublicKey(connection);
    setStep('key', '設定済み', 'ok');
  } catch (error) {
    setStep('key', '未設定', 'error', describeNotifierError(error));
    setStep('subscription', '確認できません', '');
    setStep('trigger', health.triggerActive ? '動いています' : '停止しています', health.triggerActive ? 'ok' : 'error');
    return false;
  }

  setStep('permission', permissionLabel(), permissionKind(), permissionHint());

  if (Notification.permission !== 'granted') {
    setStep('subscription', '確認できません', '');
  } else {
    try {
      await ensureSubscription(publicKey);
      setStep('subscription', '登録済み', 'ok');
    } catch (error) {
      setStep('subscription', '登録できません', 'error', describeNotifierError(error));
    }
  }

  if (health.triggerActive) {
    setStep('trigger', '動いています', 'ok');
  } else {
    setStep(
      'trigger',
      '停止しています',
      'error',
      'スプレッドシートのメニュー「録音通知」→「セットアップを開始」→「セットアップを実行」で、毎分トリガーを作り直してください。',
    );
  }

  return true;
}

function permissionLabel() {
  if (!('Notification' in globalThis)) {
    return 'このブラウザは通知に対応していません';
  }

  switch (Notification.permission) {
    case 'granted':
      return '許可されています';
    case 'denied':
      return 'ブロックされています';
    default:
      return '未許可';
  }
}

function permissionKind() {
  if (!('Notification' in globalThis)) {
    return 'error';
  }

  return Notification.permission === 'granted' ? 'ok' : 'error';
}

function permissionHint() {
  if (!('Notification' in globalThis)) {
    return 'パソコンの Google Chrome / Edge / Firefox の最新版でお試しください。';
  }

  if (Notification.permission === 'denied') {
    return 'ブラウザのアドレスバーのアイコンから、このサイトの通知を「許可」に変更してください。'
      + '一度ブロックすると、ページ側からは再度お願いできません。';
  }

  if (Notification.permission === 'default') {
    return '右の「許可する」を押して、ブラウザの確認に「許可」と答えてください。';
  }

  return '';
}

/* ---------- Service Worker と Push 購読 ---------- */

/*
 * Service Worker を登録する。
 *
 * パスは import.meta.url からの相対で作る。**直書きしない。**
 * 登録スコープはこのファイルが置かれたディレクトリになり、
 * sw.js 側もそこから開く先を組み立てる（sw.js の冒頭）。
 */
async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) {
    throw new NotifierError(NotifierErrorCode.NOT_CONFIGURED, 'serviceWorker unavailable');
  }

  await navigator.serviceWorker.register(new URL('./sw.js', import.meta.url), {
    scope: new URL('./', import.meta.url).pathname,
  });

  return navigator.serviceWorker.ready;
}

/*
 * この端末の Push 購読を作り、GAS へ登録する。
 *
 * すでに購読があっても、**GAS の公開鍵と一致しているか確かめる。**
 * GAS 側で鍵を作り直すと、古い購読は残ったまま通知だけ届かなくなる。
 * その状態は「登録済み」に見えてしまい、原因が分からない。
 */
async function ensureSubscription(publicKey) {
  const registration = await registerServiceWorker();
  const existing = await registration.pushManager.getSubscription();

  if (existing) {
    if (toBase64Url(existing.options?.applicationServerKey) === publicKey) {
      await saveSubscription(connection, existing.toJSON());
      return existing;
    }

    await existing.unsubscribe();
  }

  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: base64UrlToUint8Array(publicKey),
  });

  await saveSubscription(connection, subscription.toJSON());

  return subscription;
}

/* base64url の公開鍵を Uint8Array にする（sw.js にも同じものがある）。 */
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

/* ArrayBuffer を base64url にする。購読の鍵とGASの公開鍵の突き合わせに使う。 */
function toBase64Url(buffer) {
  if (!buffer) {
    return '';
  }

  const bytes = new Uint8Array(buffer);
  let binary = '';

  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }

  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/* ---------- 設定（FR-05〜FR-11） ---------- */

function renderSettings(settings) {
  for (const filter of RESPONSE_FILTERS) {
    const input = filterInput(filter.key);

    if (input) {
      input.checked = settings[filter.key] === true;
    }
  }

  el['vr-nf-timedOnly'].checked = settings.timedOnly === true;
  el['vr-nf-timing'].value = String(settings.timing);
}

function collectSettings() {
  const settings = {};

  for (const filter of RESPONSE_FILTERS) {
    const input = filterInput(filter.key);
    settings[filter.key] = input ? input.checked : DEFAULT_SETTINGS[filter.key];
  }

  settings.timedOnly = el['vr-nf-timedOnly'].checked;
  settings.timing = Number(el['vr-nf-timing'].value);

  return settings;
}

/*
 * 表示キャッシュ。**正はGAS側**（FR-08）。
 * ここに置くのは、通信が終わるまでの一瞬に前回値を出すためだけである。
 */
function readCachedSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_CACHE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;

    return parsed && typeof parsed === 'object' ? { ...DEFAULT_SETTINGS, ...parsed } : { ...DEFAULT_SETTINGS };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function writeCachedSettings(settings) {
  try {
    localStorage.setItem(SETTINGS_CACHE_KEY, JSON.stringify(settings));
  } catch {
    /* プライベートウィンドウ等で失敗する。表示キャッシュなので黙って諦めてよい。 */
  }
}

async function loadSettings() {
  if (!connection) {
    renderSettings(readCachedSettings());
    return;
  }

  try {
    const settings = await fetchSettings(connection);

    if (settings) {
      renderSettings(settings);
      writeCachedSettings(settings);
    }
  } catch (error) {
    /* 設定が読めなくても画面は出す。理由はチェッカーの行に出ている。 */
    console.warn('[voice-recorder:notifier] 設定を取得できませんでした', error);
  }
}

async function handleSaveSettings(event) {
  event.preventDefault();

  if (busy || !connection) {
    if (!connection) {
      showMessage('先にGASへ接続してください。', 'error');
    }
    return;
  }

  busy = true;
  el['vr-nf-save'].disabled = true;
  showMessage('保存しています…');

  try {
    const saved = await saveSettings(connection, collectSettings());

    if (saved) {
      renderSettings(saved);
      writeCachedSettings(saved);
    }

    /* AC-09。いつ効くのかを必ず添える（最大5分の同期間隔があるため）。 */
    showMessage('設定を保存しました。次回の判定から反映されます。', 'ok');
  } catch (error) {
    reportError(error);
  } finally {
    busy = false;
    el['vr-nf-save'].disabled = false;
  }
}

/* ---------- 接続 ---------- */

async function handleConnect() {
  if (busy) {
    return;
  }

  const url = normalizeGasUrl(el['vr-nf-url'].value);
  const key = String(el['vr-nf-key'].value ?? '').trim();

  if (!isGasUrl(url)) {
    showMessage('GASのURLの形式が違います。末尾が /exec のURLを貼り付けてください。', 'error');
    return;
  }

  if (key === '') {
    showMessage('接続キーを貼り付けてください。', 'error');
    return;
  }

  busy = true;
  el['vr-nf-connect'].disabled = true;
  showMessage('接続しています…');

  try {
    connection = { url, key };

    /* 保存する前に、この組み合わせで実際に読めることを確かめる。 */
    await fetchPublicKey(connection);
    await writeConnection(connection);

    el['vr-nf-url'].value = url;
    el['vr-nf-key'].value = '';
    el['vr-nf-connection'].open = false;

    await runChecks();
    await loadSettings();

    showMessage('接続しました。', 'ok');
  } catch (error) {
    connection = null;
    reportError(error);
    await runChecks();
  } finally {
    busy = false;
    el['vr-nf-connect'].disabled = false;
  }
}

async function handleDisconnect() {
  if (busy) {
    return;
  }

  busy = true;

  try {
    /*
     * 購読も外す。接続だけ消して購読を残すと、GAS側からは通知が飛び続け、
     * この端末は内容を取りに行けず、汎用通知だけが出る状態になる。
     */
    if ('serviceWorker' in navigator) {
      const registration = await navigator.serviceWorker.getRegistration(new URL('./', import.meta.url).pathname);
      const subscription = await registration?.pushManager.getSubscription();

      await subscription?.unsubscribe();
    }

    await clearConnection();
    connection = null;

    el['vr-nf-url'].value = '';
    el['vr-nf-key'].value = '';
    el['vr-nf-connection'].open = true;

    await runChecks();
    showMessage('接続を解除しました。', 'ok');
  } catch (error) {
    reportError(error);
  } finally {
    busy = false;
  }
}

async function handlePermission() {
  if (!('Notification' in globalThis)) {
    return;
  }

  if (Notification.permission === 'denied') {
    setStep('permission', permissionLabel(), permissionKind(), permissionHint());
    return;
  }

  await Notification.requestPermission();
  await handleRecheck();
}

async function handleRecheck() {
  if (busy) {
    return;
  }

  busy = true;
  el['vr-nf-recheck'].disabled = true;
  showMessage('確認しています…');

  try {
    const ok = await runChecks();
    showMessage(ok ? '確認しました。' : '', ok ? 'ok' : '');
  } catch (error) {
    reportError(error);
  } finally {
    busy = false;
    el['vr-nf-recheck'].disabled = false;
  }
}

/* ---------- 通知から開いたとき（要件書 5.3 / FR-17〜19） ---------- */

/*
 * 表示するだけで、**録音は始めない**（AC-07）。
 * 開始は従来どおり「録音開始」ボタンの操作に限る。
 */
async function showEvent(eventId) {
  const banner = el['vr-event-banner'];
  const id = String(eventId ?? '').trim();

  if (!banner || id === '') {
    return;
  }

  if (!connection) {
    return;
  }

  try {
    const event = await fetchEvent(connection, id);
    const text = formatEventBanner(event);

    if (text === '') {
      return;
    }

    banner.textContent = text;
    banner.hidden = false;
  } catch (error) {
    console.warn('[voice-recorder:notifier] 予定を取得できませんでした', error);
  }
}

function currentEventIdFromUrl() {
  return new URLSearchParams(globalThis.location?.search ?? '').get('eventId') ?? '';
}

/* ---------- 組み立て ---------- */

function buildTimingOptions() {
  const select = el['vr-nf-timing'];

  select.replaceChildren();

  for (const option of TIMING_OPTIONS) {
    const node = document.createElement('option');

    node.value = String(option.value);
    node.textContent = option.label;
    select.append(node);
  }
}

/**
 * 通知UIを組み立てる。**guardPage() を通ってから呼ぶこと。**
 * 失敗しても録音機能には影響させない（呼び出し側で握りつぶす）。
 */
export async function mountNotifier() {
  for (const id of ELEMENT_IDS) {
    el[id] = document.getElementById(id);
  }

  for (const filter of RESPONSE_FILTERS) {
    el[`vr-nf-${filter.key}`] = document.getElementById(`vr-nf-${filter.key}`);
  }

  if (!el['vr-notifier-panel']) {
    return;
  }

  el['vr-nf-template'].href = TEMPLATE_COPY_URL;

  buildTimingOptions();
  renderSettings(readCachedSettings());

  el['vr-notifier-panel'].hidden = false;

  el['vr-nf-connect'].addEventListener('click', handleConnect);
  el['vr-nf-disconnect'].addEventListener('click', handleDisconnect);
  el['vr-nf-permission'].addEventListener('click', handlePermission);
  el['vr-nf-recheck'].addEventListener('click', handleRecheck);
  el['vr-nf-settings-form'].addEventListener('submit', handleSaveSettings);

  /*
   * 開いている画面へ Service Worker から届く通知クリック（FR-19）。
   * 登録より先に付けておく。あとから付けると、起動直後の1件を取りこぼす。
   */
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.data?.type === 'SHOW_EVENT') {
        showEvent(event.data.eventId);
      }
    });
  }

  connection = await readConnection();

  if (connection) {
    el['vr-nf-url'].value = connection.url;
    el['vr-nf-connection'].open = false;
  } else {
    el['vr-nf-connection'].open = true;
  }

  await runChecks();
  await loadSettings();
  await showEvent(currentEventIdFromUrl());
}

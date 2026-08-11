/*
 * 「Googleカレンダー連携」の画面制御（要件書 5.1 / FR-05〜FR-11 / NFR-05）。
 *
 * ==================================================================
 * ここに録音のコードを書かない
 * ==================================================================
 * 通知の受信やクリックで録音を始めてはならない（FR-20 / NFR-06）。
 *
 * マイクの取得・録音APIの生成・レコーダーの開始にあたる識別子が
 * このファイルに現れないことを、自動テスト
 * （tests/unit/voice-recorder-notifier.mjs の「配信物の見張り」）が
 * **文字列として**見ている。禁止語そのものは、そちらに書いてある。
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
  clearLicenseKey,
  execUrlDigest,
  isGasUrl,
  isLicenseKeyShaped,
  normalizeGasUrl,
  parseSetupFragment,
  readConnection,
  readLicenseKey,
  writeConnection,
  writeLicenseKey,
} from './notifier-config.js';

import {
  NotifierError,
  NotifierErrorCode,
  describeNotifierError,
  fetchEvent,
  fetchHealth,
  fetchPublicKey,
  fetchSettings,
  fetchUpcoming,
  gasGet,
  pingGas,
  saveLicense,
  saveSettings,
  saveSubscription,
  sendTestNotification,
} from './notifier-client.js';

import { formatEventBanner, formatClock } from './notifier-messages.js';

import { issueNotifierLicense } from '../../auth/api.js';
import { readSessionToken } from '../../auth/session.js';
import { screenPath } from '../../auth/config.js';

/* ---------- 要素 ---------- */

const el = {};

const ELEMENT_IDS = [
  'vr-notifier-panel',
  'vr-nf-state-health', 'vr-nf-state-key', 'vr-nf-state-permission',
  'vr-nf-state-subscription', 'vr-nf-state-trigger', 'vr-nf-state-license',
  'vr-nf-hint-health', 'vr-nf-hint-key', 'vr-nf-hint-permission',
  'vr-nf-hint-subscription', 'vr-nf-hint-trigger', 'vr-nf-hint-license',
  'vr-nf-permission',
  'vr-nf-setup', 'vr-nf-template', 'vr-nf-url', 'vr-nf-key', 'vr-nf-key-state',
  'vr-nf-connect', 'vr-nf-disconnect',
  'vr-nf-connection', 'vr-nf-settings-form',
  'vr-nf-timedOnly', 'vr-nf-timing', 'vr-nf-save', 'vr-nf-recheck',
  'vr-nf-test', 'vr-nf-upcoming', 'vr-nf-upcoming-empty',
  'vr-nf-license-state', 'vr-nf-license-link',
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

/**
 * 接続キー欄に「保存済みか」を出す。
 *
 * ------------------------------------------------------------------
 * 値そのものは入れない。**入れないからこそ、状態を出す。**
 * ------------------------------------------------------------------
 * 接続キーは秘密なので、復元しても入力欄へは戻さない（DOM に置かない）。
 * ところが URL は戻るため、画面上は「片方だけ復元された」ように見える。
 *
 * 実機の検証で、**保存されているのに「保存されていない」と判定された**
 * （2026-08-11）。IndexedDB には値があり、接続テストも保存済みの値で
 * 通っていたが、それを画面から確かめる方法が無かった。
 *
 * 復元できているかどうかは、利用者が知る必要のある情報である。出す。
 * ------------------------------------------------------------------
 */
function renderKeyState(saved) {
  const badge = el['vr-nf-key-state'];
  const input = el['vr-nf-key'];

  if (badge) {
    badge.textContent = saved ? '保存済み' : '';
    badge.hidden = !saved;
  }

  if (input) {
    input.placeholder = saved ? '保存済み（変更するときだけ入力）' : '';
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
    setStep('health', '未接続', 'error', '上の［通知をセットアップ］から始めてください。');
    setStep('key', '確認できません', '');
    setStep('permission', permissionLabel(), permissionKind());
    setStep('subscription', '確認できません', '');
    setStep('trigger', '確認できません', '');
    setStep('license', '確認できません', '');
    renderLicense(null);
    return false;
  }

  let health = null;

  try {
    health = await fetchHealth(connection);
  } catch (error) {
    setStep('health', '接続できません', 'error', describeNotifierError(error));
    setStep('key', '確認できません', '');
    setStep('subscription', '確認できません', '');
    setStep('trigger', '確認できません', '');
    setStep('license', '確認できません', '');
    renderLicense(null);
    return false;
  }

  /*
   * ------------------------------------------------------------------
   * GET が通っても、まだ安心できない
   * ------------------------------------------------------------------
   * 実機では、GET 系だけ成功して POST の新しい action が INVALID_ACTION に
   * なる状態が起きた（**古いデプロイに繋いでいた**）。health は V1 にも
   * あるため、これだけ見ていると「接続できました」と表示されてしまう。
   *
   * そこで POST の疎通も確かめ、あわせて
   * 「シートが公開したURL」と「いま繋いでいるURL」の指紋を突き合わせる。
   * ------------------------------------------------------------------
   */
  let identity = null;

  try {
    identity = await pingGas(connection);
  } catch (error) {
    setStep(
      'health',
      '古い版に接続しています',
      'error',
      '通知用シートで［公開する］をやり直すか、シートのメニューから引き継ぎリンクを取り直してください。',
    );
    setStep('key', '確認できません', '');
    setStep('subscription', '確認できません', '');
    setStep('trigger', '確認できません', '');
    setStep('license', '確認できません', '');
    renderLicense(null);
    console.warn('[voice-recorder:notifier] POST が通りません', error);
    return false;
  }

  const expected = String(identity.execUrlDigest ?? '');
  const actual = await execUrlDigest(connection.url);

  if (expected !== '' && actual !== '' && expected !== actual) {
    setStep(
      'health',
      '別のデプロイに接続しています',
      'error',
      'シートが公開したURLと、この端末の接続先が違います。'
      + 'シートのメニュー「録音通知」→「録音アプリへの引き継ぎリンクを表示」から接続し直してください。',
    );
    setStep('key', '確認できません', '');
    setStep('subscription', '確認できません', '');
    setStep('trigger', '確認できません', '');
    setStep('license', '確認できません', '');
    renderLicense(null);
    return false;
  }

  setStep('health', '接続できました', 'ok');

  let publicKey = '';

  try {
    publicKey = await fetchPublicKey(connection);
    setStep('key', '設定済み', 'ok');
  } catch (error) {
    /*
     * ライセンスがまだ GAS へ届いていないと、鍵は取れない（ゲートが発行しない）。
     * その場合に「セットアップが未完了」と出すと、直す場所を誤らせる。
     * **やり直すのはセットアップではなく、ライセンスの引き渡しである。**
     */
    const missingLicense = error instanceof NotifierError
      && error.code === NotifierErrorCode.NO_LICENSE;

    /*
     * 通知用シートが通知サーバーとやり取りできていない場合、その符号を添える。
     * 実機で「鍵が × のまま直らない」状態になったとき、**原因を持っている
     * 場所が誰からも見えなかった**（health には出ていなかった）。
     */
    const gateHint = health.lastGateError
      ? `通知サーバーとのやり取りに失敗しています（${health.lastGateError}）。`
      : '';

    setStep(
      'key',
      '未設定',
      'error',
      gateHint || (missingLicense
        ? 'ご契約の情報がまだ通知用シートへ渡っていません。［接続テスト］をもう一度押すと引き渡しをやり直します。'
        : describeNotifierError(error)),
    );
    setStep('subscription', '確認できません', '');
    setStep('trigger', health.triggerActive ? '動いています' : '停止しています', health.triggerActive ? 'ok' : 'error');

    /* ここで止めず、ご契約の行までは出す（何が足りないのかを見せる）。 */
    await refreshLicense();

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
      '通知用シートのメニュー「録音通知」→「セットアップを開く」→［セットアップを実行］で、毎分トリガーを作り直してください。',
    );
  }

  /*
   * 6項目め。**「キーがあるか」ではなく「使える契約か」を出す。**
   * 本当の状態を知っているのは運営のゲートだけなので、GAS が最後に
   * 受け取った結果（getSettings の license）を見る。
   */
  await refreshLicense();

  return true;
}

/* ---------- ライセンス（6項目め） ---------- */

/* 直近に GAS から受け取ったライセンスの状態。 */
let licenseSummary = null;

const LICENSE_VIEW = Object.freeze({
  active: { label: 'ご利用いただけます', kind: 'ok', hint: '' },
  grace: {
    label: '確認中（利用は継続しています）',
    kind: '',
    hint: 'ご契約の確認に一時的に失敗しています。通知は続きます。時間をおいて再度ご確認ください。',
  },
  expired: {
    label: 'ご契約を確認できません',
    kind: 'error',
    hint: 'ご契約が確認できないため、通知を停止しています。',
  },
  unknown: {
    label: '未確認',
    kind: '',
    hint: '次回の同期（最大5分）で確認されます。',
  },
});

function renderLicense(summary) {
  const node = el['vr-nf-license-state'];
  const link = el['vr-nf-license-link'];

  if (!summary || summary.present !== true) {
    setStep('license', '未設定', 'error', '上の［通知をセットアップ］からやり直してください。');

    if (node) {
      node.textContent = '未設定';
      node.dataset.kind = 'error';
    }

    if (link) {
      link.hidden = true;
    }

    return;
  }

  const view = LICENSE_VIEW[summary.state] ?? LICENSE_VIEW.unknown;

  setStep('license', view.label, view.kind, view.hint);

  if (node) {
    node.textContent = view.label;
    node.dataset.kind = view.kind;
  }

  /* 期限切れのときだけ料金ページへの導線を出す（それ以外では邪魔になる）。 */
  if (link) {
    link.hidden = summary.state !== 'expired';
  }
}

async function refreshLicense() {
  if (!connection) {
    renderLicense(null);
    return;
  }

  try {
    const data = await gasGet(connection, 'getSettings');

    licenseSummary = data.license ?? null;
    renderLicense(licenseSummary);
  } catch (error) {
    console.warn('[voice-recorder:notifier] ライセンスの状態を取得できませんでした', error);
    setStep('license', '確認できません', '', describeNotifierError(error));
  }
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
  const typed = String(el['vr-nf-key'].value ?? '').trim();

  /*
   * ------------------------------------------------------------------
   * 未入力は「いまのキーを保つ」とする
   * ------------------------------------------------------------------
   * 接続キーは復元しても入力欄へ戻さない（秘密を DOM に置かない）。
   * そのため、接続済みの状態でこの欄は必ず空に見える。
   *
   * ここで「空はエラー」にしていると、**接続が生きているのに
   * ［接続する］を押した時点で行き止まりになる。** V2 の利用者は
   * 接続キーを手元に控えていない（引き継ぎリンクで渡している）ため、
   * 自力で復帰できない。実機でここに嵌まった（2026-08-11）。
   *
   * 空のときは保存済みの値を使う。URL だけ直したい場合にも要る。
   * ------------------------------------------------------------------
   */
  const key = typed !== '' ? typed : String(connection?.key ?? '');

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
    /*
     * ------------------------------------------------------------------
     * 順序を変えた（2026-08-11）
     * ------------------------------------------------------------------
     * 以前は「読めることを確かめてから保存」していた。これが実機で
     * 2つの壊れ方を同時に起こした。
     *
     *   1. **手動入力が永続化されない。** 確認に失敗すると保存へ到達せず、
     *      さらに connection を捨てていたため、リロードで古い値へ戻った。
     *      画面に見えている値と、実際に使われた値が食い違った
     *   2. **鶏卵になる。** publicKey はゲートから鍵をもらう action で、
     *      ライセンスが GAS へ届いていないと失敗する。しかしライセンスを
     *      渡す saveLicense は接続が確立してからしか呼べない
     *
     * そこで「形が正しければまず保存する」へ改めた。保存してから
     * ライセンスを渡し、最後に確認する。**確認に失敗しても入力値は残る。**
     * 誤ったURLを保存する心配は、形の検証・チェッカーの ×・
     * ［接続を解除］の3つで受ける。
     * ------------------------------------------------------------------
     */
    connection = { url, key };

    await writeConnection(connection);

    el['vr-nf-url'].value = url;
    el['vr-nf-key'].value = '';
    el['vr-nf-connection'].open = false;

    /* 欄を空にした直後に「保存済み」を出す（空＝未保存に見せない）。 */
    renderKeyState(true);

    /* 預かっているライセンスを先に渡す（publicKey はこれが済んでいないと通らない）。 */
    await pushLicenseToGas();

    const ok = await runChecks();

    await loadSettings();
    await loadUpcoming();

    showMessage(
      ok
        ? '接続しました。'
        : '接続先を保存しました。確認できない項目があります。上の一覧をご確認ください。',
      ok ? 'ok' : 'error',
    );
  } catch (error) {
    /*
     * **connection を捨てない。** 保存は済んでいるので、捨てると
     * 画面の状態と保存内容が食い違う（上の 1 の再発）。
     */
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
    renderKeyState(false);

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
    /* 引き渡せていないライセンスがあれば、ここで再試行する。 */
    await pushLicenseToGas();

    const ok = await runChecks();

    await loadUpcoming();

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

/*
 * いまのURLの `?eventId=`。
 *
 * app.js が guardPage() へ渡すためにも使う（**認証より前に読む**）。
 * 未ログインで通知から開かれた場合、ログイン画面へ飛ぶ時点でこの値を
 * 渡しておかないと、戻ってきたときには消えている。
 */
export function currentEventIdFromUrl() {
  return new URLSearchParams(globalThis.location?.search ?? '').get('eventId') ?? '';
}

/* ---------- セットアップの引き継ぎ（#setup=） ---------- */

/**
 * 「通知をセットアップ」。
 *
 * ------------------------------------------------------------------
 * ここでライセンスキーを先に取っておく理由
 * ------------------------------------------------------------------
 * ライセンスキーを渡せるのは**ログイン済みの本人だけ**である。
 * テンプレートをコピーしたあとの画面はスプレッドシートであり、
 * そこから当社の認証系へは繋がらない。したがってこの時点で受け取り、
 * 接続が確立した直後に GAS へ預ける（docs/notifier-design-notes.md §8）。
 * ------------------------------------------------------------------
 *
 * 途中で失敗しても行き止まりにしない。ライセンスが取れなくても
 * テンプレートのコピーへは進める（契約後にやり直せば通知が始まる）。
 */
async function handleSetup() {
  if (busy) {
    return;
  }

  busy = true;
  el['vr-nf-setup'].disabled = true;
  showMessage('準備しています…');

  let guidance = '通知用シートのコピー画面を開きました。シートのサイドバーに従って進めてください。';
  let kind = 'ok';

  try {
    const sessionToken = readSessionToken();

    if (!sessionToken) {
      /* guardPage() を通っている以上、通常は起きない。 */
      showMessage('ログインの有効期限が切れています。ページを再読み込みしてログインし直してください。', 'error');
      return;
    }

    const result = await issueNotifierLicense(sessionToken);

    if (isLicenseKeyShaped(result.licenseKey)) {
      await writeLicenseKey(result.licenseKey);
    }

    if (result.entitled !== true) {
      guidance = 'ご契約では通知をご利用いただけません。設定は進められますが、'
        + '通知を受け取るにはご契約の追加が必要です。';
      kind = 'error';

      if (el['vr-nf-license-link']) {
        el['vr-nf-license-link'].hidden = false;
      }
    }
  } catch (error) {
    /*
     * 認証系へ届かなかった場合。**ここで止めない。**
     * 接続だけ先に済ませておけば、あとで［接続テスト］を押すだけで
     * ライセンスの受け渡しをやり直せる。
     */
    console.warn('[voice-recorder:notifier] ライセンスを取得できませんでした', error);
    guidance = 'ライセンスの取得に失敗しました。シートのセットアップを終えたあと、'
      + '［接続テスト］を押すと再試行します。';
    kind = 'error';
  } finally {
    busy = false;
    el['vr-nf-setup'].disabled = false;
  }

  showMessage(guidance, kind);
  globalThis.open(TEMPLATE_COPY_URL, '_blank', 'noopener');
}

/**
 * ウィザードの引き継ぎリンクで開かれたときの受け口。
 *
 * **読んだら即座にフラグメントを消す。** 接続キーが残ったURLのまま
 * 画面を共有・ブックマークされると、そのまま第三者へ渡ることになる。
 * （フラグメント自体はサーバーへ送信されないが、画面には残る。）
 *
 * 戻り値は「引き継ぎがあったか」。
 */
async function applySetupFragment() {
  const parsed = parseSetupFragment(globalThis.location?.hash ?? '');

  /*
   * 形が違うものは黙って捨てる。**ただしフラグメントは必ず消す。**
   * 残すと、読み込みのたびに同じ不正な値を処理し続けることになる。
   */
  const hadFragment = String(globalThis.location?.hash ?? '').includes('#setup=');

  if (hadFragment) {
    clearSetupFragment();
  }

  if (!parsed) {
    if (hadFragment) {
      showMessage('引き継ぎリンクの内容を確認できませんでした。シートのサイドバーからリンクを取り直してください。', 'error');
    }

    return false;
  }

  await writeConnection(parsed);
  connection = parsed;

  el['vr-nf-url'].value = parsed.url;
  el['vr-nf-connection'].open = false;
  renderKeyState(true);

  return true;
}

/* URL からフラグメントだけを落とす。履歴を1件増やさない。 */
function clearSetupFragment() {
  try {
    const url = new URL(globalThis.location.href);

    url.hash = '';
    globalThis.history.replaceState(null, '', url.toString());
  } catch {
    /* 履歴APIが使えない環境。表示上の問題にとどまるので黙って続ける。 */
  }
}

/**
 * 預かっているライセンスキーを GAS へ渡す。
 *
 * 接続が確立してから呼ぶ。渡し終えたらブラウザ側からは消す
 * （持ち続ける理由が無く、置いておくだけ漏れる先が増える）。
 */
async function pushLicenseToGas() {
  if (!connection) {
    return;
  }

  let licenseKey = '';

  try {
    licenseKey = await readLicenseKey();
  } catch {
    return;
  }

  if (!isLicenseKeyShaped(licenseKey)) {
    return;
  }

  try {
    await saveLicense(connection, licenseKey);
    await clearLicenseKey();
  } catch (error) {
    /*
     * 渡せなかった。**キーは消さない。**次の［接続テスト］で再試行する。
     * 消してしまうと、取り直すために認証系からの発行をやり直すことになる。
     */
    console.warn('[voice-recorder:notifier] ライセンスを引き渡せませんでした', error);
    showMessage(describeNotifierError(error), 'error');
  }
}

/* ---------- 直近の通知予定・テスト通知 ---------- */

function renderUpcoming(items) {
  const list = el['vr-nf-upcoming'];
  const empty = el['vr-nf-upcoming-empty'];

  if (!list) {
    return;
  }

  list.replaceChildren();

  if (!items || items.length === 0) {
    list.hidden = true;

    if (empty) {
      empty.hidden = false;
    }

    return;
  }

  for (const item of items) {
    const node = document.createElement('li');
    const clock = formatClock(item.notifyAt);
    const start = formatClock(item.startTime);

    /* 予定名は Google 由来の値。textContent 以外で入れない。 */
    node.textContent = clock === ''
      ? String(item.title ?? '')
      : `${clock} に通知 — ${String(item.title ?? '')}${start === '' ? '' : `（${start}開始）`}`;

    list.append(node);
  }

  list.hidden = false;

  if (empty) {
    empty.hidden = true;
  }
}

async function loadUpcoming() {
  if (!connection) {
    renderUpcoming([]);
    return;
  }

  try {
    renderUpcoming(await fetchUpcoming(connection));
  } catch (error) {
    console.warn('[voice-recorder:notifier] 直近の通知予定を取得できませんでした', error);
    renderUpcoming([]);
  }
}

async function handleTestNotification() {
  if (busy || !connection) {
    if (!connection) {
      showMessage('先に通知のセットアップを終えてください。', 'error');
    }

    return;
  }

  if (Notification.permission !== 'granted') {
    showMessage('先にブラウザの通知を許可してください。', 'error');
    return;
  }

  busy = true;
  el['vr-nf-test'].disabled = true;
  showMessage('テスト通知を送っています…');

  try {
    await sendTestNotification(connection);
    showMessage('テスト通知を送りました。数秒で届かない場合は、通知の許可とこの端末の登録をご確認ください。', 'ok');
  } catch (error) {
    reportError(error);
  } finally {
    busy = false;
    el['vr-nf-test'].disabled = false;
  }
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

  if (el['vr-nf-license-link']) {
    el['vr-nf-license-link'].href = screenPath('pricing');
  }

  buildTimingOptions();
  renderSettings(readCachedSettings());

  el['vr-notifier-panel'].hidden = false;

  el['vr-nf-setup'].addEventListener('click', handleSetup);
  el['vr-nf-connect'].addEventListener('click', handleConnect);
  el['vr-nf-disconnect'].addEventListener('click', handleDisconnect);
  el['vr-nf-permission'].addEventListener('click', handlePermission);
  el['vr-nf-recheck'].addEventListener('click', handleRecheck);
  el['vr-nf-test'].addEventListener('click', handleTestNotification);
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

  /*
   * ウィザードから引き継がれてきた場合は、保存済みの接続より優先する。
   * 端末を作り直した・接続キーを更新したときに、古い値が残っていても
   * リンク1つで直せるようにするため。
   */
  const handedOff = await applySetupFragment();

  /*
   * **接続キーは入力欄へ戻さない。** 代わりに「保存済み」を出す。
   * connection には URL とキーの両方が入っており、接続テストはこれを使う
   * （入力欄の値は見ない）。renderKeyState の説明を参照。
   */
  if (connection) {
    el['vr-nf-url'].value = connection.url;
    el['vr-nf-connection'].open = false;
  } else {
    el['vr-nf-connection'].open = true;
  }

  renderKeyState(Boolean(connection?.key));

  /* 引き継ぎ直後は、預かっているライセンスを渡してから状態を確かめる。 */
  await pushLicenseToGas();

  const ok = await runChecks();

  await loadSettings();
  await loadUpcoming();
  await showEvent(currentEventIdFromUrl());

  if (handedOff) {
    showMessage(
      ok
        ? '通知の設定が完了しました。ブラウザの通知を許可すると受け取れます。'
        : '接続しましたが、確認できない項目があります。上の一覧をご確認ください。',
      ok ? 'ok' : 'error',
    );
  }
}

/*
 * 名刺OCRアプリの画面制御（SC-00 まで）。
 *
 * ==================================================================
 * このページが守ること
 * ==================================================================
 *   - guardPage() を必ず通す。Portal の一覧に載せていなくても、
 *     URLを知っていれば開けるため。
 *   - キーは KeyStore の有無だけを見る。**値を読まない・画面へ出さない。**
 *     localStorage を直接触らない（keystore-spec-v1.md §2-1）。
 *   - innerHTML を使わない（要件定義書 §10.2）。
 *   - 外部通信は §12 の3系統のみ。この段階では Google の認可だけを使う。
 *   - テスト環境（public/apps/）と検証用PoC（poc/）から import しない。
 * ==================================================================
 *
 * 判別そのものは prerequisites.js にある。**ここは画面への反映だけ。**
 * DOM を持たない側にロジックを寄せておくと、テストで画面を組み立てずに
 * 済む。
 */

import { setScreenDepth, screenPath } from '../../auth/config.js';
import { guardPage } from '../../auth/session.js';
import { KeyStore, PROVIDERS, isKeyStoreAvailable } from '../../auth/keystore.js';

import { isClientIdConfigured } from './config.js';
import {
  clearAccessToken,
  describeDriveAuthError,
  ensureAccessToken,
  hasValidAccessToken,
} from './drive-auth.js';

import {
  Guidance,
  Prerequisite,
  buildStatusList,
  describePrerequisite,
  evaluatePrerequisites,
} from './prerequisites.js';

/* /production-app/card-ocr/ はサイトのルートから2階層下。 */
setScreenDepth(2);

const el = {};

for (const id of [
  'co-loading', 'co-content', 'co-status',
  'co-guidance', 'co-guidance-title', 'co-guidance-text',
  'co-login-link', 'co-portal-link', 'co-connect',
  'co-ready', 'co-disconnect', 'co-message',
]) {
  el[id] = document.getElementById(id);
}

/* guardPage() が返した利用者。未ログインならここへ来ない。 */
let signedIn = false;
/* 連携の処理中。ポップアップを二重に開かせない。 */
let connecting = false;

/* ---------- 表示の道具（innerHTML を使わない） ---------- */

function showMessage(text, kind = 'info') {
  el['co-message'].textContent = text;
  el['co-message'].dataset.kind = kind;
  el['co-message'].hidden = text === '';
}

function clearMessage() {
  showMessage('');
}

function renderStatus(list) {
  const target = el['co-status'];
  target.replaceChildren();

  for (const item of list) {
    const term = document.createElement('dt');
    term.className = 'co-status-label';
    term.textContent = item.label;

    const value = document.createElement('dd');
    value.className = 'co-status-value';
    value.dataset.ok = item.ok ? 'yes' : 'no';
    value.textContent = item.text;

    target.append(term, value);
  }
}

/* ---------- 前提の判別と反映 ---------- */

function collectFacts() {
  const keyStoreAvailable = isKeyStoreAvailable();

  return {
    signedIn,
    keyStoreAvailable,
    /*
     * **has() だけを呼ぶ。** 値そのものは、実際に Gemini を呼ぶ
     * 場面まで取り出さない。画面の描画に鍵の中身は要らない。
     */
    hasGeminiKey: keyStoreAvailable && KeyStore.has(PROVIDERS.gemini),
    clientIdConfigured: isClientIdConfigured(),
    googleLinked: hasValidAccessToken(),
  };
}

function render() {
  const facts = collectFacts();
  const state = evaluatePrerequisites(facts);
  const described = describePrerequisite(state);

  renderStatus(buildStatusList(facts));

  /* 誘導は毎回すべて隠してから、該当する1つだけを出す。 */
  el['co-login-link'].hidden = true;
  el['co-portal-link'].hidden = true;
  el['co-connect'].hidden = true;

  if (state === Prerequisite.READY) {
    el['co-guidance'].hidden = true;
    el['co-ready'].hidden = false;
    return state;
  }

  el['co-ready'].hidden = true;
  el['co-guidance'].hidden = false;
  el['co-guidance-title'].textContent = described.title;
  el['co-guidance-text'].textContent = described.text;

  switch (described.guidance) {
    case Guidance.LOGIN:
      el['co-login-link'].href = screenPath('login');
      el['co-login-link'].hidden = false;
      break;
    case Guidance.PORTAL:
      /*
       * 戻り先（next）を付けない。Portal 側に本アプリへ戻す仕組みが
       * 無く、付けると「戻ってくるはず」と読める導線になる。
       * 戻り方は文言で示している（FR-25 の3、prerequisites.js）。
       */
      el['co-portal-link'].href = screenPath('portal');
      el['co-portal-link'].hidden = false;
      break;
    case Guidance.CONNECT:
      el['co-connect'].hidden = false;
      break;
    default:
      break;
  }

  return state;
}

/* ---------- Google 連携 ---------- */

async function connect() {
  if (connecting) {
    return;
  }

  connecting = true;
  el['co-connect'].disabled = true;
  showMessage('Googleの画面を開いています…');

  try {
    /*
     * **利用者の押下から直接呼ぶ。** 非同期処理を挟んでから呼ぶと
     * ポップアップブロックに当たる（drive-auth.js）。
     */
    await ensureAccessToken();
    clearMessage();
  } catch (error) {
    const described = describeDriveAuthError(error);
    showMessage(`${described.text}（${described.errorCode}）`, 'error');
  } finally {
    connecting = false;
    el['co-connect'].disabled = false;
    render();
  }
}

function disconnect() {
  clearAccessToken();
  showMessage('連携を解除しました。');
  render();
}

/* ---------- 起動 ---------- */

async function start() {
  /*
   * 未ログインならここで /login/ へ飛ぶ。
   * 戻り先は自分自身ではなく Portal にしてある。SCREENS に本アプリの
   * 名前が無く、勝手に足すと apps-grid-spec の配置データと二重管理に
   * なるため（FR-25 の2）。ログイン後は Portal から入り直す。
   */
  const user = await guardPage({ next: 'portal' });

  if (!user) {
    return;
  }

  signedIn = true;

  el['co-loading'].hidden = true;
  el['co-content'].hidden = false;

  render();
}

el['co-connect'].addEventListener('click', () => { void connect(); });
el['co-disconnect'].addEventListener('click', disconnect);

/*
 * 画面を離れるときにトークンを捨てる。
 * メモリにしか持っていないので必須ではないが、bfcache で戻ったときに
 * 期限切れのトークンを掴んだままにしないため（領収書OCRから取り込み）。
 */
globalThis.addEventListener?.('pagehide', () => {
  clearAccessToken();
});

void start();

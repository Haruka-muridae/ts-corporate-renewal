/*
 * 個人ホームの制御。
 *
 * 責務はDOMの操作だけに限る。
 * ログイン状態の判定・セッションの破棄は shared/auth.js が持つ。
 *
 * ------------------------------------------------------------------
 * 未ログイン時の扱い
 * ------------------------------------------------------------------
 * requireAuth() がログイン画面へ差し替える。
 * これは「未ログインの人を迷わせない」導線であって、保護ではない。
 * このページのHTMLもJSも直接取得できる。
 *
 * したがって、このページには
 * 「ログインした人だけに見せたい情報」を置かないこと。
 * 表示しているのは利用者自身が入力した表示名だけである。
 * ------------------------------------------------------------------
 */

import {
  guardPage,
  getCurrentUser,
  logout,
  watchAuthState,
  isUsingDummyProvider,
} from '../shared/auth.js';

/* このページからの相対パス。サイト内絶対パスは使わない。 */
const LOGIN_URL = '../login/';

initialize();

/*
 * ------------------------------------------------------------------
 * 描画の順序（重要）
 * ------------------------------------------------------------------
 * 本文は hidden で始まり、**認証基盤への確認が終わるまで表示しない**。
 *
 * 写しだけを見て先に描画すると、写しを偽装しただけで
 * 個人向けの画面が（一瞬でも）表示されてしまう。
 * guardPage() が true を返すまで待つ。
 * ------------------------------------------------------------------
 */
async function initialize() {
  const el = {
    main: document.getElementById('main-content'),
    name: document.getElementById('home-user-name'),
    meta: document.getElementById('home-session-meta'),
    message: document.getElementById('home-message'),
    logout: document.getElementById('home-logout'),
  };

  if (!(await guardPage({ loginUrl: LOGIN_URL }))) {
    return;
  }

  render(el, getCurrentUser());

  if (el.main) {
    el.main.hidden = false;
  }

  bindLogout(el);
  watchSession(el);
}

/* 表示値は必ず textContent。innerHTML は使わない（XSS対策）。 */
function setText(element, text) {
  if (element) {
    element.textContent = text;
  }
}

function render(el, user) {
  setText(el.name, user?.displayName ?? 'ゲスト');
  setText(el.meta, describeSession(user));
}

/*
 * セッションの状況を1行で説明する。
 * ログインIDやユーザーIDは出さない（画面共有時に写り込むため）。
 */
function describeSession(user) {
  if (!user) {
    return '';
  }

  const parts = [];

  if (typeof user.expiresAt === 'number') {
    parts.push(`ログインの有効期限: ${formatDateTime(user.expiresAt)}`);
  }

  if (user.aal === 'aal2') {
    parts.push('二段階認証で確認済み');
  }

  if (isUsingDummyProvider()) {
    parts.push('現在は動作確認用の仮ログインです。');
  }

  return parts.join(' / ');
}

function formatDateTime(timestamp) {
  const date = new Date(timestamp);

  if (Number.isNaN(date.getTime())) {
    return '不明';
  }

  const pad = (value) => String(value).padStart(2, '0');

  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function setMessage(el, text, { alert = false } = {}) {
  if (!el.message) {
    return;
  }

  if (!text) {
    el.message.removeAttribute('role');
    el.message.textContent = '';
    el.message.hidden = true;
    return;
  }

  el.message.textContent = text;
  el.message.setAttribute('role', alert ? 'alert' : 'status');
  el.message.hidden = false;
}

function bindLogout(el) {
  if (!el.logout) {
    return;
  }

  el.logout.addEventListener('click', async () => {
    if (el.logout.disabled) {
      return;
    }

    el.logout.disabled = true;
    el.logout.setAttribute('aria-busy', 'true');
    el.logout.textContent = 'ログアウトしています…';

    try {
      await logout();
    } catch (error) {
      /*
       * logout() は手元のセッションを必ず破棄するため、
       * ここへ来ても未ログイン状態にはなっている。
       */
      console.warn('[tsam-home] ログアウト処理で例外が発生しました:', error?.name ?? 'Error');
    }

    /*
     * 戻るボタンでこの画面へ復帰しても未ログインになるよう、
     * 履歴を残さない replace で遷移する。
     */
    globalThis.location.replace(new URL(LOGIN_URL, globalThis.location.href).href);
  });
}

/*
 * この画面に残り続けないようにする。
 *
 * 拾うもの:
 *   別タブでのログアウト / 認証基盤側での失効 /
 *   「戻る」ボタンでの復元（bfcache）
 *
 * bfcache が重要。ログアウト後に「戻る」を押すと、
 * スクリプトを再実行せずに画面が丸ごと復元されることがある。
 * その場合でも個人情報を表示したままにしない。
 */
function watchSession(el) {
  watchAuthState({
    onSignedOut: () => {
      /* 本文を隠してから遷移する。復元直後の露出を最短にする。 */
      if (el.main) {
        el.main.hidden = true;
      }

      setMessage(el, 'ログアウトしました。ログイン画面へ戻ります。');
      globalThis.location.replace(new URL(LOGIN_URL, globalThis.location.href).href);
    },
  });
}

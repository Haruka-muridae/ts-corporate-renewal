/*
 * Portal。
 *
 * ------------------------------------------------------------------
 * 描画の順序（重要）
 * ------------------------------------------------------------------
 *   1. サーバーへセッションを問い合わせる
 *   2. 有効と答えたときだけ内容を描画する
 *
 * ローカルの値を見て先に描画すると、開発者ツールで値を書けば
 * 画面が開けてしまう。ここでは一切の先読み描画を行わない。
 *
 * ただし、静的ホスティングでは HTML と JS の取得そのものは防げない。
 * 守れるのはサーバー側のデータであって、このファイルの中身ではない。
 * 詳細は SECURITY_NOTES.md を参照。
 * ------------------------------------------------------------------
 */

import { setScreenDepth, rootPath } from '../auth/config.js';
import { guardPage, signOut, goToLogin } from '../auth/session.js';
import { PORTAL_APPS } from '../auth/apps.js';
import { createMessageArea, createSubmitButton } from '../auth/ui.js';

setScreenDepth(1);

const loadingElement = document.getElementById('portal-loading');
const contentElement = document.getElementById('portal-content');
const emailElement = document.getElementById('portal-user-email');
const badgeElement = document.getElementById('portal-user-badge');
const appsElement = document.getElementById('portal-apps');
const appsEmptyElement = document.getElementById('portal-apps-empty');
const accountEmailElement = document.getElementById('portal-account-email');
const accountSubscriptionElement = document.getElementById('portal-account-subscription');
const logoutButton = document.getElementById('portal-logout');
const messageElement = document.getElementById('portal-message');

const message = createMessageArea(messageElement);

/* 契約状態の表示。内部値をそのまま出さない。 */
const SUBSCRIPTION_LABELS = Object.freeze({
  active: 'ご利用中',
  trialing: '試用期間中',
  past_due: 'お支払いを確認できていません',
  canceled: '解約済み',
  unpaid: 'お支払いを確認できていません',
  incomplete: 'お手続きの途中です',
  incomplete_expired: 'お手続きが完了しませんでした',
  paused: '一時停止中',
  exempt: '決済不要（管理者）',
});

function describeSubscription(user) {
  if (user.paymentExempt === true) {
    return SUBSCRIPTION_LABELS.exempt;
  }

  return SUBSCRIPTION_LABELS[String(user.subscriptionStatus ?? '').toLowerCase()] ?? 'ご利用中';
}

/* アプリのカードを作る。文字列はすべて textContent で入れる。 */
function buildAppCard(app) {
  const item = document.createElement('li');
  item.className = 'auth-app-card';

  const name = document.createElement('h2');
  name.className = 'auth-app-card__name';
  name.textContent = app.name;
  item.append(name);

  if (app.description) {
    const description = document.createElement('p');
    description.className = 'auth-app-card__desc';
    description.textContent = app.description;
    item.append(description);
  }

  const link = document.createElement('a');
  link.className = 'auth-app-card__link';
  /* サイトのルートからの相対パスとして解決する。 */
  link.href = `${rootPath()}${app.path}`;
  link.textContent = `${app.name}を開く`;
  item.append(link);

  return item;
}

function renderApps() {
  if (PORTAL_APPS.length === 0) {
    appsEmptyElement.hidden = false;
    return;
  }

  PORTAL_APPS.forEach((app) => appsElement.append(buildAppCard(app)));
}

function render(user) {
  emailElement.textContent = user.email ?? '';
  accountEmailElement.textContent = user.email ?? '';
  accountSubscriptionElement.textContent = describeSubscription(user);

  /*
   * 管理者の表示はサーバーが返した role にもとづく。
   * メールアドレスで判定しない。
   * これは表示だけであり、権限そのものはサーバー側が持つ。
   */
  if (user.isAdmin === true) {
    badgeElement.textContent = '管理者';
    badgeElement.className = 'auth-badge';
    badgeElement.hidden = false;
  }

  renderApps();

  loadingElement.hidden = true;
  contentElement.hidden = false;
}

const logout = createSubmitButton(logoutButton, { busyLabel: 'ログアウトしています…' });

logoutButton.addEventListener('click', async () => {
  if (logout.isBusy()) {
    return;
  }

  logout.start();

  try {
    /* サーバー側のセッションを失効させてから、手元を消す。 */
    await signOut();
    goToLogin();
  } catch {
    logout.stop();
    message.show('ログアウトできませんでした。時間をおいて再度お試しください。', 'error');
    message.focus();
  }
});

async function init() {
  const user = await guardPage({ next: 'portal' });

  /* 未認証のときは、すでにログイン画面へ遷移している。何も描画しない。 */
  if (!user) {
    return;
  }

  render(user);
}

init();

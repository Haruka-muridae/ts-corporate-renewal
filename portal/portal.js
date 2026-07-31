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
const badgeElement = document.getElementById('portal-user-badge');
const appsElement = document.getElementById('portal-apps');
const appsEmptyElement = document.getElementById('portal-apps-empty');
const accountEmailElement = document.getElementById('portal-account-email');
const accountSubscriptionElement = document.getElementById('portal-account-subscription');
const accountToggle = document.getElementById('portal-account-toggle');
const accountPanel = document.getElementById('portal-account-panel');
const logoutButton = document.getElementById('portal-logout');
const messageElement = document.getElementById('portal-message');
const apiKeyBannerElement = document.getElementById('portal-api-key-banner');
const apiKeyLinkElement = document.getElementById('portal-api-key-link');

const message = createMessageArea(messageElement);

/*
 * ------------------------------------------------------------------
 * APIキー未設定バナー（今は出さない）
 * ------------------------------------------------------------------
 * キー管理画面が未実装のため、遷移先が無い。
 * 「未設定です」と言いながら設定できない画面は、利用者を行き止まりへ
 * 連れて行くだけなので、行き先が決まるまで出さない。
 *
 * 有効化の手順は2つだけ:
 *   1. キー管理画面を作り、そのパスを API_KEY_SETTINGS_PATH に入れる
 *   2. verifySession の応答に「キー設定済みか」を載せる
 *      （portal.js 側は user.geminiApiKeyConfigured を見る）
 *
 * パスが空のあいだは shouldShowApiKeyBanner() が必ず false を返すため、
 * フラグの消し忘れで行き先の無いリンクが出ることはない。
 * 詳細は docs/specs/portal-spec-v1.md §5。
 * ------------------------------------------------------------------
 */
const API_KEY_SETTINGS_PATH = '';

/**
 * バナーを出すかどうか。
 *
 * サーバーが「設定済みか」を答えられない段階では出さない。
 * 未設定と決めつけて警告すると、設定済みの利用者にも出てしまう。
 */
export function shouldShowApiKeyBanner(user) {
  /* 遷移先が無いうちは、どんな状態でも出さない。 */
  if (API_KEY_SETTINGS_PATH === '') {
    return false;
  }

  /* サーバーが答えていない（undefined）ときも出さない。 */
  return user?.geminiApiKeyConfigured === false;
}

function renderApiKeyBanner(user) {
  if (!shouldShowApiKeyBanner(user)) {
    return;
  }

  apiKeyLinkElement.href = `${rootPath()}${API_KEY_SETTINGS_PATH}`;
  apiKeyBannerElement.hidden = false;
}

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

/*
 * アイコンに出す文字。
 *
 * apps.js に icon が無ければアプリ名の1文字目を使う。
 * 名前があればアイコンは必ず作れるため、欠けた枠が並ぶことはない。
 */
function appIconText(app) {
  const icon = String(app.icon ?? '').trim();

  return icon !== '' ? icon : String(app.name ?? '').trim().slice(0, 1);
}

/*
 * アプリのカードを作る。文字列はすべて textContent で入れる。
 *
 * カード全体を1つのリンクにする。名前・説明・アイコンのどこを押しても
 * 同じ場所へ行くため、「開く」だけが当たり判定という状態を作らない。
 */
function buildAppCard(app) {
  const item = document.createElement('li');
  item.className = 'auth-app-card';

  const link = document.createElement('a');
  link.className = 'auth-app-card__link';
  /* サイトのルートからの相対パスとして解決する。 */
  link.href = `${rootPath()}${app.path}`;

  const icon = document.createElement('span');
  icon.className = 'auth-app-card__icon';
  icon.textContent = appIconText(app);
  /* 見出しの文字を絵にしただけなので、読み上げでは繰り返さない。 */
  icon.setAttribute('aria-hidden', 'true');
  link.append(icon);

  const name = document.createElement('h2');
  name.className = 'auth-app-card__name';
  name.textContent = app.name;
  link.append(name);

  if (app.description) {
    const description = document.createElement('p');
    description.className = 'auth-app-card__desc';
    description.textContent = app.description;
    link.append(description);
  }

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

/*
 * ------------------------------------------------------------------
 * アカウント情報パネルの開閉
 * ------------------------------------------------------------------
 * 状態を持つのは aria-expanded と hidden の2つだけで、
 * 見た目（逆三角の回転）は CSS が aria-expanded を見て決める。
 * JS 専用のクラスを別に持たないため、表示と支援技術がずれない。
 *
 * 開閉状態は保存しない。読み込むたびに閉じた状態から始める。
 * アカウント情報は普段見るものではなく、開いたままにしておく理由がない。
 * ------------------------------------------------------------------
 */
function setAccountPanelOpen(open) {
  accountToggle.setAttribute('aria-expanded', String(open));
  accountPanel.hidden = !open;
}

/*
 * button 要素なので Enter と Space は既定動作で click になる。
 * keydown を自前で拾うと二重に発火するため、click だけを見る。
 */
accountToggle.addEventListener('click', () => {
  setAccountPanelOpen(accountToggle.getAttribute('aria-expanded') !== 'true');
});

function render(user) {
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

  renderApiKeyBanner(user);
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

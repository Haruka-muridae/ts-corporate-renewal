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
import { APP_REGISTRY } from './app-registry.js';
import {
  pageCountFor,
  paginate,
  readStoredLayout,
  resolveAppOrder,
} from './app-layout.js';
import { KeyStore, PROVIDERS, isKeyStoreAvailable } from '../auth/keystore.js';
import { createMessageArea, createSubmitButton, attachPasswordToggle } from '../auth/ui.js';

setScreenDepth(1);

const loadingElement = document.getElementById('portal-loading');
const contentElement = document.getElementById('portal-content');
const badgeElement = document.getElementById('portal-user-badge');
const appsElement = document.getElementById('portal-apps');
const appsDotsElement = document.getElementById('portal-apps-dots');
const appsPrevButton = document.getElementById('portal-apps-prev');
const appsNextButton = document.getElementById('portal-apps-next');
const accountEmailElement = document.getElementById('portal-account-email');
const accountSubscriptionElement = document.getElementById('portal-account-subscription');
const accountToggle = document.getElementById('portal-account-toggle');
const accountPanel = document.getElementById('portal-account-panel');
const logoutButton = document.getElementById('portal-logout');
const messageElement = document.getElementById('portal-message');
const apiKeyBannerElement = document.getElementById('portal-api-key-banner');
const apiKeyActionElement = document.getElementById('portal-api-key-action');

const apiToggle = document.getElementById('portal-api-toggle');
const apiPanel = document.getElementById('portal-api-panel');
const apiFormElement = document.getElementById('portal-api-form');
const apiSavedElement = document.getElementById('portal-api-saved');
const apiInput = document.getElementById('portal-api-key');
const apiVisibilityButton = document.getElementById('portal-api-key-visibility');
const apiSaveButton = document.getElementById('portal-api-save');
const apiMaskedElement = document.getElementById('portal-api-masked');
const apiChangeButton = document.getElementById('portal-api-change');
const apiDeleteButton = document.getElementById('portal-api-delete');
const apiConfirmElement = document.getElementById('portal-api-confirm');
const apiDeleteConfirmButton = document.getElementById('portal-api-delete-confirm');
const apiDeleteCancelButton = document.getElementById('portal-api-delete-cancel');
const apiMessageElement = document.getElementById('portal-api-message');

const message = createMessageArea(messageElement);
const apiMessage = createMessageArea(apiMessageElement);

/*
 * ------------------------------------------------------------------
 * APIキー未設定バナー
 * ------------------------------------------------------------------
 * 判断の材料はこの端末の KeyStore だけにする。
 * サーバーへは一度も問い合わせない（キーを預けていないのだから、
 * サーバーは設定済みかどうかを知らないし、知る必要もない）。
 *
 * 押しても画面は移動しない。同じ画面のAPI設定パネルを開く。
 * 詳細は docs/specs/portal-spec-v1.md §5。
 * ------------------------------------------------------------------
 */

/**
 * バナーを出すかどうか。
 *
 * 保存済みなら出さない。それだけの条件にする。
 */
export function shouldShowApiKeyBanner() {
  return !KeyStore.has(PROVIDERS.gemini);
}

function renderApiKeyBanner() {
  apiKeyBannerElement.hidden = !shouldShowApiKeyBanner();
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
 * ------------------------------------------------------------------
 * アプリのページ式グリッド
 * ------------------------------------------------------------------
 * 2列×4行＝8枠で1ページ。ページ数は max(2, ceil(件数/8))。
 * アプリの入らない枠は「準備中」として描く。
 *
 * グリップ（移動ハンドル）・並べ替えの保存・「初期配置に戻す」は第2便。
 * ここでは配置データを **読むだけ** で、1バイトも書かない。
 * 詳細は docs/specs/apps-grid-spec-v1.md。
 * ------------------------------------------------------------------
 */

/* いま表示しているページ。保存しない（再読み込みで1ページ目へ戻る）。 */
let currentPage = 0;
let totalPages = 0;

/*
 * アプリのカードを作る。文字列はすべて textContent で入れる。
 *
 * カード全体を1つのリンクにする。名前・アイコンのどちらを押しても
 * 同じ場所へ行くため、「開く」だけが当たり判定という状態を作らない。
 */
function buildAppCard(app) {
  const item = document.createElement('li');
  item.className = 'auth-app-card';

  const link = document.createElement('a');
  link.className = 'auth-app-card__link';
  /* サイトのルートからの相対パスとして解決する。 */
  link.href = `${rootPath()}${app.href ?? ''}`;

  const icon = document.createElement('span');
  icon.className = 'auth-app-card__icon';
  icon.textContent = appIconText(app);
  /* 見出しの文字を絵にしただけなので、読み上げでは繰り返さない。 */
  icon.setAttribute('aria-hidden', 'true');
  link.append(icon);

  const name = document.createElement('span');
  name.className = 'auth-app-card__name';
  name.textContent = app.name ?? '';
  link.append(name);

  item.append(link);

  return item;
}

/*
 * 空き枠。
 *
 * **リンクにしない。** 行き先が無いものを押せる形にすると、
 * 押しても何も起きないという体験を作る。
 * 見た目（破線）だけでなく「準備中」の語でも伝える。
 */
function buildEmptySlot() {
  const item = document.createElement('li');
  item.className = 'auth-app-card auth-app-card--empty';

  const box = document.createElement('div');
  box.className = 'auth-app-card__placeholder';

  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('class', 'auth-app-card__plus');
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('width', '20');
  icon.setAttribute('height', '20');
  icon.setAttribute('fill', 'none');
  icon.setAttribute('stroke', 'currentColor');
  icon.setAttribute('stroke-width', '2');
  icon.setAttribute('stroke-linecap', 'round');
  icon.setAttribute('aria-hidden', 'true');
  icon.setAttribute('focusable', 'false');

  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M12 5v14M5 12h14');
  icon.append(path);
  box.append(icon);

  const label = document.createElement('span');
  label.className = 'auth-app-card__pending';
  label.textContent = '準備中';
  box.append(label);

  item.append(box);

  return item;
}

function buildPage(slots, pageIndex) {
  const list = document.createElement('ul');
  list.className = 'auth-apps__page';
  list.id = `portal-apps-page-${pageIndex + 1}`;
  list.setAttribute('aria-label', `${pageIndex + 1}ページ目`);

  slots.forEach((app) => {
    list.append(app ? buildAppCard(app) : buildEmptySlot());
  });

  return list;
}

/* 表示中のページだけを出す。ドットと矢印の状態も合わせる。 */
function showPage(pageIndex) {
  const clamped = Math.min(Math.max(pageIndex, 0), Math.max(totalPages - 1, 0));
  currentPage = clamped;

  [...appsElement.children].forEach((page, index) => {
    page.hidden = index !== clamped;
  });

  [...appsDotsElement.children].forEach((dot, index) => {
    if (index === clamped) {
      /* 表示中であることを、色だけでなく支援技術へも伝える。 */
      dot.setAttribute('aria-current', 'true');
    } else {
      dot.removeAttribute('aria-current');
    }
  });

  /*
   * 端では矢印を無効にする。
   * 巻き戻る（最後→最初）動きにすると、いま何ページ目なのかが
   * 押した結果から読み取れなくなる。
   */
  appsPrevButton.disabled = clamped === 0;
  appsNextButton.disabled = clamped >= totalPages - 1;
}

function buildDots() {
  const fragment = document.createDocumentFragment();

  for (let index = 0; index < totalPages; index += 1) {
    const dot = document.createElement('button');
    dot.className = 'auth-apps__dot';
    dot.type = 'button';
    dot.dataset.page = String(index);
    dot.setAttribute('aria-label', `${index + 1}ページ目を表示`);
    dot.setAttribute('aria-controls', `portal-apps-page-${index + 1}`);
    fragment.append(dot);
  }

  appsDotsElement.replaceChildren(fragment);
}

/**
 * グリッドを描き直す。
 *
 * registry を渡せる形にしてあるのは、テストから定義を差し込むため。
 * 画面からは引数なしで呼ぶ（既定は本物のレジストリと保存済み配置）。
 */
export function renderAppsGrid(registry = APP_REGISTRY, { stored } = {}) {
  const layout = stored === undefined ? readStoredLayout() : stored;
  const apps = resolveAppOrder(registry, layout);

  totalPages = pageCountFor(apps.length);

  const fragment = document.createDocumentFragment();

  paginate(apps, totalPages).forEach((slots, index) => {
    fragment.append(buildPage(slots, index));
  });

  appsElement.replaceChildren(fragment);
  buildDots();

  /* 描き直したら必ず1ページ目から。表示ページは保存しない。 */
  showPage(0);
}

appsDotsElement.addEventListener('click', (event) => {
  const dot = event.target.closest('.auth-apps__dot');

  if (dot) {
    showPage(Number(dot.dataset.page));
  }
});

appsPrevButton.addEventListener('click', () => showPage(currentPage - 1));
appsNextButton.addEventListener('click', () => showPage(currentPage + 1));

/*
 * ------------------------------------------------------------------
 * ヘッダーバー直下のパネル（アカウント情報／API設定）
 * ------------------------------------------------------------------
 * 状態を持つのは aria-expanded と hidden の2つだけで、
 * 見た目（逆三角の回転）は CSS が aria-expanded を見て決める。
 * JS 専用のクラスを別に持たないため、表示と支援技術がずれない。
 *
 * 2枚は排他とする。両方開くとヘッダーの下が渋滞し、
 * アプリの一覧が画面の外へ押し出される。
 *
 * 開閉状態は保存しない。読み込むたびに閉じた状態から始める。
 * ------------------------------------------------------------------
 */
const PANELS = [
  { toggle: accountToggle, panel: accountPanel },
  { toggle: apiToggle, panel: apiPanel },
];

function setPanelOpen(entry, open) {
  entry.toggle.setAttribute('aria-expanded', String(open));
  entry.panel.hidden = !open;

  if (!open) {
    return;
  }

  /* 開いたほうが勝つ。もう一方は閉じる。 */
  PANELS.filter((other) => other !== entry)
    .forEach((other) => setPanelOpen(other, false));
}

function isPanelOpen(entry) {
  return entry.toggle.getAttribute('aria-expanded') === 'true';
}

/*
 * button 要素なので Enter と Space は既定動作で click になる。
 * keydown を自前で拾うと二重に発火するため、click だけを見る。
 */
PANELS.forEach((entry) => {
  entry.toggle.addEventListener('click', () => {
    setPanelOpen(entry, !isPanelOpen(entry));
  });
});

const API_PANEL = PANELS[1];

/*
 * ------------------------------------------------------------------
 * Gemini APIキーの設定
 * ------------------------------------------------------------------
 * キーの読み書きは KeyStore だけが行う。ここで localStorage を直接触らない。
 * キーを当社サーバー（GAS）へ送らない。console にも出さない。
 * ------------------------------------------------------------------
 */

/* Google AI Studio が発行するキーの見た目。AIza ＋ 35文字で合計39文字。 */
const GEMINI_KEY_PATTERN = /^AIza[A-Za-z0-9_-]{35}$/;

/**
 * 一般的な Gemini APIキーの形に見えるか。
 *
 * **保存の可否には使わない。** 形が違っても保存はする。
 * Google 側が採番を変えたときに、こちらの正規表現のせいで
 * 正しいキーを保存できなくなるほうが困る。警告に留める。
 */
export function looksLikeGeminiApiKey(value) {
  return GEMINI_KEY_PATTERN.test(String(value ?? '').trim());
}

/**
 * 保存済みのキーの伏せ字表示。先頭4文字と末尾4文字だけ残す。
 *
 * 短すぎて前後が重なる値は、全部伏せる。
 * 「先頭4＋末尾4」を機械的に当てると、8文字なら全部見えてしまう。
 */
export function maskApiKey(value) {
  const key = String(value ?? '').trim();

  if (key === '') {
    return '';
  }

  if (key.length <= 12) {
    return '•'.repeat(key.length);
  }

  return `${key.slice(0, 4)}${'•'.repeat(key.length - 8)}${key.slice(-4)}`;
}

/*
 * 疎通テスト。
 *
 * モデル一覧の取得（GET）だけを使う。参照系なので、
 * 押し間違いで利用者の課金や保存済みデータに影響しない。
 *
 * キーは URL ではなくヘッダー（x-goog-api-key）へ載せる。
 * クエリ文字列に置くと、開発者ツールの履歴や拡張機能から
 * 拾える場所が1つ増える。
 */
const GEMINI_MODELS_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

/**
 * キーが通るかを1回だけ確かめる。
 *
 * 戻り値は { ok, status }。status 0 は「応答そのものが得られなかった」。
 * 例外は投げない。テストの失敗で保存が巻き戻ることを避けるため。
 */
export async function testGeminiApiKey(key) {
  try {
    const response = await globalThis.fetch(GEMINI_MODELS_URL, {
      method: 'GET',
      headers: { 'x-goog-api-key': String(key ?? '') },
    });

    return { ok: response.ok === true, status: Number(response.status) || 0 };
  } catch {
    /* 通信そのものが成立しなかった。キーの正否は判定できない。 */
    return { ok: false, status: 0 };
  }
}

/** 疎通テストの結果を、利用者に見せる言葉へ変える。 */
export function describeTestResult({ ok, status }) {
  if (ok) {
    return { text: '接続を確認しました。', kind: 'success' };
  }

  if (status === 400 || status === 401 || status === 403) {
    return {
      text: 'このAPIキーでは接続できませんでした。Google AI Studio で発行したキーをご確認ください。',
      kind: 'error',
    };
  }

  if (status === 429) {
    return {
      text: '利用上限に達している可能性があります。時間をおいて再度お試しください。',
      kind: 'error',
    };
  }

  if (status === 0) {
    return {
      text: '接続を確認できませんでした。通信環境をご確認ください。',
      kind: 'error',
    };
  }

  return { text: `接続を確認できませんでした（HTTP ${status}）。`, kind: 'error' };
}

/*
 * パネルの表示を、保存状態に合わせる。
 *
 * 保存済みなら伏せ字と「変更／削除」、未保存なら入力欄と「保存する」。
 * バナーの出し入れも同じ判断から作るため、ここで一緒に呼ぶ。
 */
function renderApiKeyState() {
  const saved = KeyStore.get(PROVIDERS.gemini);

  if (saved !== null) {
    apiMaskedElement.textContent = maskApiKey(saved);
    apiSavedElement.hidden = false;
    apiFormElement.hidden = true;
  } else {
    apiSavedElement.hidden = true;
    apiFormElement.hidden = false;
  }

  /* 確認は開いたままにしない。次に押すときは最初から。 */
  apiConfirmElement.hidden = true;

  renderApiKeyBanner();
}

/* 入力欄は毎回空にする。保存済みの値を書き戻さない（画面に平文を置かない）。 */
function showApiKeyForm() {
  apiInput.value = '';
  apiSavedElement.hidden = true;
  apiFormElement.hidden = false;
  apiConfirmElement.hidden = true;
  apiInput.focus();
}

attachPasswordToggle(apiVisibilityButton, apiInput);

const apiSave = createSubmitButton(apiSaveButton, { busyLabel: '確認しています…' });

apiSaveButton.addEventListener('click', async () => {
  if (apiSave.isBusy()) {
    return;
  }

  const value = apiInput.value.trim();

  if (value === '') {
    apiMessage.show('APIキーを入力してください。', 'error');
    apiMessage.focus();
    apiInput.focus();
    return;
  }

  if (!isKeyStoreAvailable() || !KeyStore.set(PROVIDERS.gemini, value)) {
    apiMessage.show(
      'このブラウザではAPIキーを保存できません。プライベートモードを解除してお試しください。',
      'error',
    );
    apiMessage.focus();
    return;
  }

  /*
   * 保存はここで確定している。疎通テストの結果によらず残す。
   * 「テストが通らないと保存されない」形にすると、
   * 一時的な通信不良のたびに入力し直しになる。
   */
  apiInput.value = '';
  renderApiKeyState();

  apiSave.start();

  const result = await testGeminiApiKey(value);

  apiSave.stop();

  const described = describeTestResult(result);

  /* 形式の警告は、保存を妨げずに添えるだけ。 */
  const warned = !looksLikeGeminiApiKey(value);
  const lines = ['保存しました。'];

  if (warned) {
    lines.push('一般的なGemini APIキーの形式と異なります。');
  }

  lines.push(described.text);

  /*
   * 通ったのに形式が違うときは success にしない。
   * 「完了」とだけ読み上げると、添えた警告が流される。
   */
  let kind = 'error';

  if (described.kind === 'success') {
    kind = warned ? 'info' : 'success';
  }

  apiMessage.show(lines.join(' '), kind);
});

apiChangeButton.addEventListener('click', () => {
  apiMessage.clear();
  showApiKeyForm();
});

apiDeleteButton.addEventListener('click', () => {
  apiMessage.clear();
  apiConfirmElement.hidden = false;
  apiDeleteConfirmButton.focus();
});

apiDeleteCancelButton.addEventListener('click', () => {
  apiConfirmElement.hidden = true;
  apiDeleteButton.focus();
});

apiDeleteConfirmButton.addEventListener('click', () => {
  KeyStore.remove(PROVIDERS.gemini);
  renderApiKeyState();
  apiMessage.show('APIキーをこの端末から削除しました。', 'info');
});

/* バナーの導線。ページを移動せず、同じ画面のパネルを開く。 */
apiKeyActionElement.addEventListener('click', () => {
  setPanelOpen(API_PANEL, true);
  apiInput.focus();
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

  renderApiKeyState();
  renderAppsGrid();

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

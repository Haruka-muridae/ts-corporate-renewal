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
import { fetchApps, readCachedApps, writeCachedApps } from './app-source.js';
import {
  CATALOG_PAGE_SIZE,
  PAGE_SIZE,
  catalogPageCount,
  clearStoredLayout,
  moveItem,
  pageCountFor,
  paginate,
  readStoredLayout,
  resolveCatalog,
  resolveFavorites,
  writeStoredLayout,
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
const appsLiveElement = document.getElementById('portal-apps-live');
const appsMessageElement = document.getElementById('portal-apps-message');
const appsResetButton = document.getElementById('portal-apps-reset');
const appsResetConfirm = document.getElementById('portal-apps-reset-confirm');
const appsResetYes = document.getElementById('portal-apps-reset-confirm-yes');
const appsResetNo = document.getElementById('portal-apps-reset-confirm-no');
const catalogElement = document.getElementById('portal-catalog');
const catalogEmptyElement = document.getElementById('portal-catalog-empty');
const catalogPagerElement = document.getElementById('portal-catalog-pager');
const catalogDotsElement = document.getElementById('portal-catalog-dots');
const catalogPrevButton = document.getElementById('portal-catalog-prev');
const catalogNextButton = document.getElementById('portal-catalog-next');
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
 * icon が無い（または画像URL）ならアプリ名の1文字目を使う。
 * 名前があればアイコンは必ず作れるため、欠けた枠が並ぶことはない。
 */
function appIconText(app) {
  const icon = String(app.icon ?? '').trim();

  if (icon === '' || isImageIcon(icon)) {
    return String(app.name ?? '').trim().slice(0, 1);
  }

  return icon;
}

/* icon が画像を指しているか。URLか、画像の拡張子で終わるか。 */
function isImageIcon(value) {
  const icon = String(value ?? '').trim();

  return /^https?:\/\//i.test(icon) || /\.(svg|png|jpe?g|webp|gif|avif)$/i.test(icon);
}

/* サイト外へのリンクか。絶対URLならサイト外として扱う。 */
function isExternalHref(value) {
  return /^https?:\/\//i.test(String(value ?? '').trim());
}

/*
 * アイコンの中身を作る。
 *
 * 画像URLなら img で読み込み、**失敗したら名前の1文字目へ落とす**。
 * 仮データのアイコンは localhost を指しており、本番の利用者の画面では
 * 必ず失敗する。つまり当面はこのフォールバックのほうが実際の表示になる
 * （docs/specs/apps-grid-spec-v1.md §13）。
 *
 * 代替は「色付きの角丸＋1文字」。読み込み中に枠が空で残らないよう、
 * 先に文字を置いてから画像を重ねる。
 */
function fillIcon(box, app) {
  const letter = document.createElement('span');
  letter.className = 'auth-app-card__icon-letter';
  letter.textContent = appIconText(app);
  letter.setAttribute('aria-hidden', 'true');
  box.append(letter);

  if (!isImageIcon(app.icon)) {
    return;
  }

  const image = document.createElement('img');
  image.className = 'auth-app-card__icon-image';
  image.src = String(app.icon).trim();
  image.alt = '';
  image.loading = 'lazy';
  image.decoding = 'async';

  /* 読めたら文字を隠す。読めなければ何もしない＝文字が残る。 */
  image.addEventListener('load', () => {
    box.classList.add('auth-app-card__icon--image-ready');
  });

  image.addEventListener('error', () => {
    image.remove();
  });

  box.append(image);
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

/* 現在の並び（アプリだけ。空き枠は含まない）。並べ替えはこれを書き換える。 */
let favoriteApps = [];

/* テストから注入された定義を覚えておく（「初期配置に戻す」で使う）。 */
let activeRegistry = APP_REGISTRY;

/*
 * ドラッグ中の状態。ドラッグしていないときは null。
 *
 *   appId      … 掴んでいるアプリの id
 *   original   … 掴む前の並び（Esc で戻すため）
 *   ghost      … ポインターに追従する半透明の複製
 *   pointerId  … setPointerCapture したポインター
 *   grip       … 掴んだグリップ（capture の解放先）
 */
let dragState = null;

/* キーボードの移動モード。入っていないときは null。 */
let keyboardMove = null;

function appIds(apps = favoriteApps) {
  return apps.map((app) => app.id);
}

function indexOfApp(appId) {
  return favoriteApps.findIndex((app) => app.id === appId);
}

/* 読み上げへ短く伝える。画面では位置が見えるが、キーボード操作では見えない。 */
function announce(text) {
  appsLiveElement.textContent = text;
}

/*
 * 並べ替えの結果を保存する。
 *
 * 保存に失敗しても画面上の並びは戻さない。
 * せっかく並べたものが操作のたびに消えるほうが困る。
 * 失敗したことだけを控えめに伝え、操作は続けさせる。
 */
function persistOrder() {
  if (writeStoredLayout(appIds())) {
    appsMessageElement.hidden = true;
    return true;
  }

  appsMessageElement.textContent = '並び順を保存できませんでした。この画面では並びは保たれますが、次に開いたときは元に戻ります。';
  appsMessageElement.hidden = false;
  return false;
}

/*
 * アプリのカードを作る。文字列はすべて textContent で入れる。
 *
 * リンクとグリップを兄弟として並べる。
 * グリップを `a` の内側へ入れられない（対話要素は入れ子にできない）ことと、
 * **本体からドラッグを始めない**という決めごとの両方に、この形が要る。
 */
function buildAppCard(app, index) {
  const item = document.createElement('li');
  item.className = 'auth-app-card';
  item.dataset.appId = app.id;
  item.dataset.index = String(index);

  item.append(buildAppLink(app));

  /*
   * お気に入りから外す。グリップと対称の位置（左上）へ置く。
   *
   * 確認は挟まない。押し間違えても、カタログから同じ1タップで戻せる。
   * 対称に戻せる操作へ確認を挟むと、日常の操作が重くなるだけになる。
   */
  const remove = document.createElement('button');
  remove.className = 'auth-app-card__remove';
  remove.type = 'button';
  remove.dataset.appId = app.id;
  remove.setAttribute('aria-label', `${app.name ?? ''} をお気に入りから外す`);

  const removeIcon = document.createElement('span');
  removeIcon.setAttribute('aria-hidden', 'true');
  removeIcon.textContent = '×';
  remove.append(removeIcon);

  item.append(remove);

  /*
   * グリップ。移動の始点はここだけにする。
   *
   * アイコン本体から始められるようにすると、開こうとしただけの指の
   * わずかな動きで移動が始まる。押し間違いの結果が「並びが変わった」
   * という気づきにくい形で残るため、始点を分けている。
   */
  const grip = document.createElement('button');
  grip.className = 'auth-app-card__grip';
  grip.type = 'button';
  grip.dataset.appId = app.id;
  grip.setAttribute('aria-label', `${app.name ?? ''} を移動`);

  const gripIcon = document.createElement('span');
  gripIcon.setAttribute('aria-hidden', 'true');
  gripIcon.textContent = '⠿';
  grip.append(gripIcon);

  item.append(grip);

  return item;
}

/*
 * カードの本体（リンク部分）。お気に入りとカタログで同じものを使う。
 *
 * サイト外の絶対URLは別タブで開き、rel="noopener noreferrer" を付ける。
 * サイト内はルートからの相対パスとして解決する。
 */
function buildAppLink(app) {
  const link = document.createElement('a');
  link.className = 'auth-app-card__link';

  if (isExternalHref(app.href)) {
    link.href = String(app.href).trim();
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
  } else {
    link.href = `${rootPath()}${app.href ?? ''}`;
  }

  const icon = document.createElement('span');
  icon.className = 'auth-app-card__icon';
  /* 名前の文字を絵にしただけなので、読み上げでは繰り返さない。 */
  icon.setAttribute('aria-hidden', 'true');
  fillIcon(icon, app);
  link.append(icon);

  const name = document.createElement('span');
  name.className = 'auth-app-card__name';
  name.textContent = app.name ?? '';
  link.append(name);

  return link;
}

/*
 * カタログのカード。
 *
 * グリップは付けない。カタログの並びは定義の順で、利用者が決めるものではない。
 * 代わりに「お気に入りに追加」を置く。
 */
function buildCatalogCard(app) {
  const item = document.createElement('li');
  item.className = 'auth-app-card auth-app-card--catalog';
  item.dataset.appId = app.id;

  item.append(buildAppLink(app));

  const add = document.createElement('button');
  add.className = 'auth-app-card__add';
  add.type = 'button';
  add.dataset.appId = app.id;
  add.setAttribute('aria-label', `${app.name ?? ''} をお気に入りに追加`);
  add.textContent = 'お気に入りに追加';

  item.append(add);

  return item;
}

/*
 * 空き枠。
 *
 * **リンクにしない。** 行き先が無いものを押せる形にすると、
 * 押しても何も起きないという体験を作る。
 * 見た目（破線）だけでなく「準備中」の語でも伝える。
 */
function buildEmptySlot(index) {
  const item = document.createElement('li');
  item.className = 'auth-app-card auth-app-card--empty';
  item.dataset.index = String(index);

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

  slots.forEach((app, slotIndex) => {
    const globalIndex = pageIndex * PAGE_SIZE + slotIndex;
    list.append(app ? buildAppCard(app, globalIndex) : buildEmptySlot(globalIndex));
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

/*
 * いまの favoriteApps でグリッドを描き直す。
 *
 * 表示中のページは保つ。並べ替えのたびに1ページ目へ飛ぶと、
 * 2ページ目で操作している人が毎回戻されることになる。
 */
function paintGrid() {
  const page = currentPage;

  totalPages = pageCountFor(favoriteApps.length);

  const fragment = document.createDocumentFragment();

  paginate(favoriteApps, totalPages).forEach((slots, index) => {
    fragment.append(buildPage(slots, index));
  });

  appsElement.replaceChildren(fragment);
  buildDots();
  showPage(page);

  /* ドラッグ中は、掴んでいるカードの位置に穴を開けたままにする。 */
  if (dragState) {
    markDragSource();
  }

  /* キーボード移動中は、動かしている枠を示し続ける。 */
  if (keyboardMove) {
    markKeyboardTarget();
  }
}

/**
 * グリッドを描き直す。
 *
 * registry を渡せる形にしてあるのは、テストから定義を差し込むため。
 * 画面からは引数なしで呼ぶ（既定は本物のレジストリと保存済み配置）。
 */
export function renderAppsGrid(registry = APP_REGISTRY, { stored } = {}) {
  const layout = stored === undefined ? readStoredLayout() : stored;

  activeRegistry = registry;
  favoriteApps = resolveFavorites(registry, layout);

  /* 描き直したら必ず1ページ目から。表示ページは保存しない。 */
  currentPage = 0;
  catalogPage = 0;
  appsMessageElement.hidden = true;
  paintGrid();
  paintCatalog();
}

/*
 * ------------------------------------------------------------------
 * アプリ一覧の取り込み（三段構え）
 * ------------------------------------------------------------------
 * 表示を止めない。取得を待ってから描くと、通信の分だけ画面が白くなる。
 *
 *   1. まず描く   … キャッシュがあればそれ、無ければ組み込みの一覧
 *   2. あとで直す … 取得できたら差し替え、キャッシュも更新する
 *   3. だめなら   … 1 のまま残し、控えめに知らせる
 *
 * お気に入りの解決規則は変えていない。シートから消えた ID は
 * 「未知 ID」になり、規則 c で自動的に外れる（§4）。
 * 消えたアプリを別途片付ける処理は要らない。
 * ------------------------------------------------------------------
 */
async function loadAppRegistry() {
  const cached = readCachedApps();

  /* 1. 待たずに描く。 */
  renderAppsGrid(cached.length > 0 ? cached : APP_REGISTRY);

  const result = await fetchApps();

  /* 2. 取れたら差し替える。 */
  if (result.ok) {
    writeCachedApps(result.apps);
    renderAppsGrid(result.apps);
    return;
  }

  /*
   * 3. 取れなかった。知らせるだけで、表示はそのまま残す。
   * 何が出ているのかが分かるよう、キャッシュか既定かを言い分ける。
   */
  appsMessageElement.textContent = cached.length > 0
    ? 'アプリ一覧を更新できませんでした。前回取得した内容を表示しています。'
    : 'アプリ一覧を取得できませんでした。既定の一覧を表示しています。';
  appsMessageElement.hidden = false;
}

/*
 * ------------------------------------------------------------------
 * 全アプリ一覧（カタログ）
 * ------------------------------------------------------------------
 * お気に入りに入っていないアプリだけを出す。
 * 埋め枠（準備中）は置かない。まだ選んでいないものの一覧であって、
 * 枠を並べて見せるものではない。
 *
 * グリップも付けない。並びは定義の順で、利用者が決めるものではない。
 * 詳細は docs/specs/apps-grid-spec-v1.md §12。
 * ------------------------------------------------------------------
 */

let catalogPage = 0;
let catalogTotalPages = 1;

function showCatalogPage(pageIndex) {
  const clamped = Math.min(Math.max(pageIndex, 0), Math.max(catalogTotalPages - 1, 0));
  catalogPage = clamped;

  [...catalogElement.children].forEach((page, index) => {
    page.hidden = index !== clamped;
  });

  [...catalogDotsElement.children].forEach((dot, index) => {
    if (index === clamped) {
      dot.setAttribute('aria-current', 'true');
    } else {
      dot.removeAttribute('aria-current');
    }
  });

  catalogPrevButton.disabled = clamped === 0;
  catalogNextButton.disabled = clamped >= catalogTotalPages - 1;
}

function paintCatalog() {
  const page = catalogPage;
  const catalog = resolveCatalog(activeRegistry, favoriteApps);

  catalogTotalPages = catalogPageCount(catalog.length);

  const fragment = document.createDocumentFragment();

  for (let index = 0; index < catalogTotalPages; index += 1) {
    const list = document.createElement('ul');
    list.className = 'auth-catalog__page';
    list.id = `portal-catalog-page-${index + 1}`;
    list.setAttribute('aria-label', `${index + 1}ページ目`);

    catalog
      .slice(index * CATALOG_PAGE_SIZE, (index + 1) * CATALOG_PAGE_SIZE)
      .forEach((app) => list.append(buildCatalogCard(app)));

    fragment.append(list);
  }

  catalogElement.replaceChildren(fragment);

  /* 0件なら枠を並べず、一文だけ出す。 */
  catalogEmptyElement.hidden = catalog.length > 0;
  catalogElement.hidden = catalog.length === 0;

  /* 1ページに収まるならページ送り自体を出さない。 */
  catalogPagerElement.hidden = catalogTotalPages <= 1;

  const dots = document.createDocumentFragment();

  for (let index = 0; index < catalogTotalPages; index += 1) {
    const dot = document.createElement('button');
    dot.className = 'auth-apps__dot';
    dot.type = 'button';
    dot.dataset.page = String(index);
    dot.setAttribute('aria-label', `${index + 1}ページ目を表示`);
    dot.setAttribute('aria-controls', `portal-catalog-page-${index + 1}`);
    dots.append(dot);
  }

  catalogDotsElement.replaceChildren(dots);
  showCatalogPage(page);
}

catalogDotsElement.addEventListener('click', (event) => {
  const dot = event.target.closest('.auth-apps__dot');

  if (dot) {
    showCatalogPage(Number(dot.dataset.page));
  }
});

catalogPrevButton.addEventListener('click', () => showCatalogPage(catalogPage - 1));
catalogNextButton.addEventListener('click', () => showCatalogPage(catalogPage + 1));

/*
 * ------------------------------------------------------------------
 * お気に入りへの追加と解除
 * ------------------------------------------------------------------
 * 追加はカタログの「お気に入りに追加」、解除はお気に入りの「×」。
 * どちらも1タップで、確認は挟まない。互いに戻せる対称の操作だから。
 * ------------------------------------------------------------------
 */

function addFavorite(appId) {
  const app = resolveCatalog(activeRegistry, favoriteApps).find((item) => item.id === appId);

  if (!app) {
    return;
  }

  /* 末尾へ足す。既存の並びの途中へ割り込ませない。 */
  favoriteApps = [...favoriteApps, app];

  paintGrid();
  paintCatalog();
  persistOrder();
  announce(`${app.name ?? ''} をお気に入りに追加しました。`);
}

function removeFavorite(appId) {
  const app = favoriteApps.find((item) => item.id === appId);

  if (!app) {
    return;
  }

  favoriteApps = favoriteApps.filter((item) => item.id !== appId);

  paintGrid();
  paintCatalog();
  persistOrder();
  announce(`${app.name ?? ''} をお気に入りから外しました。`);
}

catalogElement.addEventListener('click', (event) => {
  const add = event.target.closest('.auth-app-card__add');

  if (add) {
    addFavorite(add.dataset.appId);
  }
});

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
 * 並べ替え（第2便）
 * ------------------------------------------------------------------
 * 挿入位置の見せ方は「ライブ押しのけ」。
 * 挿入先が変わるたびに並びを組み替えて描き直すので、まわりのカードが
 * 実際に寄る／空く。掴んだカードの位置には穴（破線）が開き、
 * 本体は半透明のゴーストとしてポインターに追従する。
 *
 * 別に線を引く方式は採らない。線は「どの隙間か」しか示せないが、
 * 押しのけなら **落としたあとの並びそのもの** が見える。
 *
 * 詳細は docs/specs/apps-grid-spec-v1.md §10。
 * ------------------------------------------------------------------
 */

/* 掴んでいるカードに穴を開ける（本体はゴーストが持っている）。 */
function markDragSource() {
  appsElement.querySelectorAll('.auth-app-card--dragging')
    .forEach((card) => card.classList.remove('auth-app-card--dragging'));

  const card = appsElement.querySelector(`.auth-app-card[data-app-id="${dragState.appId}"]`);

  if (card) {
    card.classList.add('auth-app-card--dragging');
  }
}

function markKeyboardTarget() {
  appsElement.querySelectorAll('.auth-app-card--moving')
    .forEach((card) => card.classList.remove('auth-app-card--moving'));

  const card = appsElement.querySelector(`.auth-app-card[data-app-id="${keyboardMove.appId}"]`);

  if (card) {
    card.classList.add('auth-app-card--moving');
  }
}

/*
 * ポインターの下にある枠から、挿入先の位置を求める。
 *
 * アプリ数より後ろ（準備中の並び）を指していたら末尾へ丸める。
 * 丸め込み自体は moveItem() が行うので、ここでは素の値を返す。
 */
function targetIndexFromPoint(x, y) {
  const element = document.elementFromPoint(x, y);

  if (!element) {
    return null;
  }

  const card = element.closest('.auth-app-card');

  if (!card || !appsElement.contains(card)) {
    return null;
  }

  return Number(card.dataset.index);
}

/* ドラッグ中にページのドットへ重ねたら、そのページへ送る。 */
function maybeTurnPage(x, y) {
  const element = document.elementFromPoint(x, y);
  const dot = element?.closest('.auth-apps__dot');

  if (!dot) {
    return false;
  }

  const page = Number(dot.dataset.page);

  if (page === currentPage) {
    return false;
  }

  showPage(page);
  return true;
}

function createGhost(card, event) {
  const rect = card.getBoundingClientRect();
  const ghost = card.cloneNode(true);

  /* 複製の中の押せるものは、複製である以上いっさい押させない。 */
  ghost.querySelectorAll('a, button').forEach((el) => el.setAttribute('tabindex', '-1'));

  ghost.classList.add('auth-app-card--ghost');
  ghost.style.width = `${rect.width}px`;
  ghost.style.height = `${rect.height}px`;
  ghost.dataset.offsetX = String(event.clientX - rect.left);
  ghost.dataset.offsetY = String(event.clientY - rect.top);

  document.body.append(ghost);
  moveGhost(ghost, event.clientX, event.clientY);

  return ghost;
}

function moveGhost(ghost, x, y) {
  ghost.style.left = `${x - Number(ghost.dataset.offsetX)}px`;
  ghost.style.top = `${y - Number(ghost.dataset.offsetY)}px`;
}

function endDrag({ save }) {
  if (!dragState) {
    return;
  }

  const { ghost, grip, pointerId, original, appId } = dragState;

  ghost.remove();

  try {
    grip.releasePointerCapture(pointerId);
  } catch {
    /* すでに解放済み。 */
  }

  dragState = null;

  if (!save) {
    /* Esc。掴む前の並びへ戻す。保存もしない。 */
    favoriteApps = original;
  }

  paintGrid();

  appsElement.querySelectorAll('.auth-app-card--dragging')
    .forEach((card) => card.classList.remove('auth-app-card--dragging'));

  if (save) {
    persistOrder();
    announce(`${indexOfApp(appId) + 1}番目へ移動しました。`);
  } else {
    announce('移動を取り消しました。');
  }
}

function onGripPointerDown(event) {
  const grip = event.target.closest('.auth-app-card__grip');

  if (!grip || dragState || keyboardMove) {
    return;
  }

  /* 主ボタン以外（右クリック等）では始めない。 */
  if (event.button !== undefined && event.button !== 0) {
    return;
  }

  const card = grip.closest('.auth-app-card');
  const appId = grip.dataset.appId;

  if (!card || indexOfApp(appId) < 0) {
    return;
  }

  /*
   * 既定動作を止める。
   * タッチではこれとグリップの touch-action: none の両方が要る。
   * 片方だけだと、指を動かした瞬間に画面がスクロールする。
   */
  event.preventDefault();

  try {
    grip.setPointerCapture(event.pointerId);
  } catch {
    /* capture できなくても、document 側の listener で拾える。 */
  }

  dragState = {
    appId,
    original: [...favoriteApps],
    ghost: createGhost(card, event),
    pointerId: event.pointerId,
    grip,
  };

  markDragSource();
  announce(`${card.querySelector('.auth-app-card__name')?.textContent ?? ''} を移動しています。`);
}

function onPointerMove(event) {
  if (!dragState) {
    return;
  }

  event.preventDefault();
  moveGhost(dragState.ghost, event.clientX, event.clientY);

  /* まずページ送り。送った直後は、その位置の枠を次の移動で拾う。 */
  if (maybeTurnPage(event.clientX, event.clientY)) {
    return;
  }

  const target = targetIndexFromPoint(event.clientX, event.clientY);
  const from = indexOfApp(dragState.appId);

  if (target === null || from < 0) {
    return;
  }

  const next = moveItem(favoriteApps, from, target);

  /* 並びが変わらないなら描き直さない（毎フレームの再描画を避ける）。 */
  if (next.every((app, index) => app.id === favoriteApps[index].id)) {
    return;
  }

  favoriteApps = next;
  paintGrid();
}

function onPointerUp() {
  endDrag({ save: true });
}

appsElement.addEventListener('pointerdown', onGripPointerDown);
document.addEventListener('pointermove', onPointerMove, { passive: false });
document.addEventListener('pointerup', onPointerUp);
document.addEventListener('pointercancel', () => endDrag({ save: false }));

/*
 * ------------------------------------------------------------------
 * キーボードでの移動
 * ------------------------------------------------------------------
 * グリップは button なので、Enter と Space は既定動作で click になる。
 * 1回目の click で移動モードへ入り、2回目で確定する。
 * 矢印で動かし、Esc で取り消す。
 * ------------------------------------------------------------------
 */

function startKeyboardMove(grip) {
  const appId = grip.dataset.appId;

  if (indexOfApp(appId) < 0) {
    return;
  }

  keyboardMove = { appId, original: [...favoriteApps] };
  markKeyboardTarget();
  announce(`${indexOfApp(appId) + 1}番目。矢印キーで移動し、Enterで確定、Escで取消します。`);
}

/* 移動後もグリップに焦点を残す。描き直しで要素が作り直されるため。 */
function refocusGrip(appId) {
  const grip = appsElement.querySelector(`.auth-app-card__grip[data-app-id="${appId}"]`);
  grip?.focus();
}

function endKeyboardMove({ save }) {
  if (!keyboardMove) {
    return;
  }

  const { appId, original } = keyboardMove;

  if (!save) {
    favoriteApps = original;
  }

  keyboardMove = null;
  paintGrid();

  appsElement.querySelectorAll('.auth-app-card--moving')
    .forEach((card) => card.classList.remove('auth-app-card--moving'));

  if (save) {
    persistOrder();
    announce(`${indexOfApp(appId) + 1}番目に確定しました。`);
  } else {
    announce('移動を取り消しました。');
  }

  refocusGrip(appId);
}

function moveByKeyboard(step) {
  const from = indexOfApp(keyboardMove.appId);
  const to = from + step;

  if (from < 0 || to < 0 || to >= favoriteApps.length) {
    return;
  }

  favoriteApps = moveItem(favoriteApps, from, to);

  /* 移動先が別ページなら、そのページへ送る。 */
  showPage(Math.floor(to / PAGE_SIZE));
  paintGrid();
  refocusGrip(keyboardMove.appId);
  announce(`${to + 1}番目に移動`);
}

appsElement.addEventListener('click', (event) => {
  const remove = event.target.closest('.auth-app-card__remove');

  if (remove) {
    /* 移動モード中に外されると宙に浮くので、先に畳む。 */
    if (keyboardMove) {
      endKeyboardMove({ save: false });
    }

    removeFavorite(remove.dataset.appId);
    return;
  }

  const grip = event.target.closest('.auth-app-card__grip');

  if (!grip) {
    return;
  }

  if (keyboardMove) {
    endKeyboardMove({ save: true });
    return;
  }

  startKeyboardMove(grip);
});

appsElement.addEventListener('keydown', (event) => {
  if (!keyboardMove || !event.target.closest('.auth-app-card__grip')) {
    return;
  }

  /* 2列なので、上下は2つぶん動く。 */
  const steps = {
    ArrowLeft: -1, ArrowRight: 1, ArrowUp: -2, ArrowDown: 2,
  };

  if (Object.hasOwn(steps, event.key)) {
    event.preventDefault();
    moveByKeyboard(steps[event.key]);
    return;
  }

  if (event.key === 'Escape') {
    event.preventDefault();
    endKeyboardMove({ save: false });
  }
});

/* Esc は画面のどこにいても効く（ドラッグ中はポインターに焦点が無い）。 */
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') {
    return;
  }

  if (dragState) {
    event.preventDefault();
    endDrag({ save: false });
  }
});

/*
 * ------------------------------------------------------------------
 * 初期配置に戻す
 * ------------------------------------------------------------------
 * 保存キーを消すだけ。空の order を書かない。
 * 消えたあとは「保存が無い」状態＝定義の順（§4-d）へ戻る。
 * ------------------------------------------------------------------
 */

appsResetButton.addEventListener('click', () => {
  appsMessageElement.hidden = true;
  appsResetConfirm.hidden = false;
  appsResetYes.focus();
});

appsResetNo.addEventListener('click', () => {
  appsResetConfirm.hidden = true;
  appsResetButton.focus();
});

appsResetYes.addEventListener('click', () => {
  clearStoredLayout();
  renderAppsGrid(activeRegistry, { stored: null });
  appsResetConfirm.hidden = true;
  announce('初期配置に戻しました。');
  appsResetButton.focus();
});

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
  loadAppRegistry();

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

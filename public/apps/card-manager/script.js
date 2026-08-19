/*
 * 名刺管理のUI層。
 *
 * 担当するのは状態遷移・文言・DOM更新だけ。
 *   認可              … ../drive-auth.js
 *   台帳の特定・読み込み・更新 … ./manager-client.js
 *   検索・絞り込み       … ./search.js（純粋関数）
 *   行 ⇄ レコードの変換  … ./records.js（純粋関数、manager-client.js 経由）
 *   項目の定義          … ../card-scanner/fields.js（名刺スキャナと共通）
 *
 * 表示は必ず textContent で行う。台帳から読んだ文字列を innerHTML へ渡さない。
 *
 * 起動時にDrive権限は要求しない。利用者が「Googleドライブへ接続する」を
 * 押した時だけ認可を開始する。
 *
 * ------------------------------------------------------------------
 * ログに出さないもの
 * ------------------------------------------------------------------
 * アクセストークン / メールアドレス / 名刺の内容（氏名・会社名など）/
 * OCR の本文。出してよいのは件数・真偽値・エラーコードなどの要約だけ。
 * ------------------------------------------------------------------
 */

import {
  DriveAuthError,
  DriveAuthErrorCode,
  clearAccessToken,
  ensureAccessToken,
  hasValidAccessToken,
  setDriveAuthLogger,
} from '../drive-auth.js';

import {
  ManagerError,
  ManagerErrorCode,
  SheetsError,
  SheetsErrorCode,
  readAllRecords,
  resolveLedger,
  setManagerLogger,
  spreadsheetUrl,
  updateRecord,
} from './manager-client.js';

import {
  collectCompanyOptions,
  collectTagOptions,
  filterRecords,
} from './search.js';

import {
  FIELDS,
  FIELD_INPUT_TYPES,
  dedupeEmails,
  normalizeEmail,
} from '../card-scanner/fields.js';

/* ============================================================
   デバッグログ
   既定では何も出さない。?debug=1 で有効化する。
   ============================================================ */

let debugEnabled = false;

try {
  debugEnabled = new URLSearchParams(window.location.search).get('debug') === '1';
} catch {
  /* location が読めない環境。無効のままにする。 */
}

function debug(event, data) {
  if (!debugEnabled) {
    return;
  }

  try {
    if (data === undefined) {
      console.debug(`[cm] ${event}`);
    } else {
      console.debug(`[cm] ${event}`, data);
    }
  } catch {
    /* console が使えない環境。無視する。 */
  }
}

setDriveAuthLogger(debug);
setManagerLogger(debug);

/* ============================================================
   状態
   ============================================================ */

const CardManagerStatus = Object.freeze({
  IDLE: 'idle',
  CONNECTING: 'connecting',
  LOADING: 'loading',
  READY: 'ready',
  NOT_FOUND: 'not_found',
  CANCELLED: 'cancelled',
  FAILED: 'failed',
});

const STATUS_LABELS = Object.freeze({
  [CardManagerStatus.IDLE]: 'Googleドライブに接続していません',
  [CardManagerStatus.CONNECTING]: 'Googleドライブに接続しています',
  [CardManagerStatus.LOADING]: '台帳を読み込んでいます',
  [CardManagerStatus.READY]: '読み込みが完了しました',
  [CardManagerStatus.NOT_FOUND]: '台帳が見つかりません',
  [CardManagerStatus.CANCELLED]: '接続がキャンセルされました',
  [CardManagerStatus.FAILED]: '処理に失敗しました',
});

const CONNECT_MESSAGES = Object.freeze({
  FIRST: 'Googleドライブへの接続が必要です。認証画面で許可してください。',
  REAUTH: 'Googleドライブへ再接続しています。',
  CANCELLED: 'Googleドライブへの接続がキャンセルされました。',
});

const AUTH_ERROR_MESSAGES = Object.freeze({
  [DriveAuthErrorCode.CLIENT_ID_MISSING]:
    'このアプリは現在準備中です。設定が完了するまでお待ちください。',
  [DriveAuthErrorCode.NOT_SIGNED_IN]:
    'Googleドライブを使うには、Googleへのログインが必要です。',
  [DriveAuthErrorCode.GIS_LOAD_FAILED]:
    'Googleの認証機能を読み込めませんでした。通信環境をご確認のうえ、ページを再読み込みしてお試しください。',
  [DriveAuthErrorCode.POPUP_CLOSED]:
    '認証画面が閉じられたため、処理を中止しました。もう一度お試しください。',
  [DriveAuthErrorCode.POPUP_BLOCKED]:
    '認証画面を開けませんでした。ブラウザのポップアップブロックを解除してお試しください。',
  [DriveAuthErrorCode.ACCESS_DENIED]:
    'Googleドライブへのアクセスが許可されませんでした。読み取りには権限の許可が必要です。',
  [DriveAuthErrorCode.SCOPE_NOT_GRANTED]:
    'Googleドライブへの権限が許可されませんでした。権限の確認画面で「許可」を選んでください。',
  [DriveAuthErrorCode.UNKNOWN]:
    'Googleの認証に失敗しました。しばらく時間をおいてお試しください。',
});

const SHEETS_ERROR_MESSAGES = Object.freeze({
  [SheetsErrorCode.UNAUTHORIZED]:
    '認証の有効期限が切れました。もう一度お試しください。',
  [SheetsErrorCode.FORBIDDEN]:
    '台帳へのアクセスが許可されませんでした。アカウントの権限設定をご確認ください。',
  [SheetsErrorCode.API_DISABLED]:
    'スプレッドシートの機能が有効になっていません。管理者にお問い合わせください。',
  [SheetsErrorCode.RATE_LIMITED]:
    'アクセスが集中しています。しばらく時間をおいてからお試しください。',
  [SheetsErrorCode.NOT_FOUND]:
    '台帳が見つかりませんでした。もう一度お試しください。',
  [SheetsErrorCode.NETWORK]:
    '通信に失敗しました。ネットワーク接続をご確認のうえ、もう一度お試しください。',
  [SheetsErrorCode.SERVER_ERROR]:
    'Google側で問題が発生しています。しばらく時間をおいてからお試しください。',
  [SheetsErrorCode.UNKNOWN]:
    '処理に失敗しました。もう一度お試しください。',
});

const MANAGER_ERROR_MESSAGES = Object.freeze({
  [ManagerErrorCode.HEADER_MISMATCH]:
    '台帳の列構成が想定と異なるため読み込めませんでした。管理者にご確認ください。',
  [ManagerErrorCode.ROW_CONFLICT]:
    '台帳が変更されています。再読み込みしてください。',
});

const FALLBACK_ERROR_MESSAGE = '処理に失敗しました。もう一度お試しください。';
const META_EMPTY = '—';
const EMAIL_PRIMARY_NAME = 'cm-email-primary';
const EMAIL_LABEL = 'メールアドレス';
const EMAIL_EMPTY_TEXT = 'メールアドレスは登録されていません。';

function toUserMessage(error) {
  if (error instanceof DriveAuthError) {
    return AUTH_ERROR_MESSAGES[error.code] ?? AUTH_ERROR_MESSAGES[DriveAuthErrorCode.UNKNOWN];
  }

  if (error instanceof SheetsError) {
    return SHEETS_ERROR_MESSAGES[error.code] ?? SHEETS_ERROR_MESSAGES[SheetsErrorCode.UNKNOWN];
  }

  if (error instanceof ManagerError) {
    return MANAGER_ERROR_MESSAGES[error.code] ?? FALLBACK_ERROR_MESSAGE;
  }

  return FALLBACK_ERROR_MESSAGE;
}

function toStatus(error) {
  if (error instanceof DriveAuthError
    && (error.code === DriveAuthErrorCode.POPUP_CLOSED
      || error.code === DriveAuthErrorCode.POPUP_BLOCKED)) {
    return CardManagerStatus.CANCELLED;
  }

  return CardManagerStatus.FAILED;
}

function isUnauthorized(error) {
  return error instanceof SheetsError && error.code === SheetsErrorCode.UNAUTHORIZED;
}

/* ============================================================
   画面の部品
   ============================================================ */

const el = {
  status: document.getElementById('cm-status'),
  message: document.getElementById('cm-message'),
  connectButton: document.getElementById('cm-connect-button'),
  reloadButton: document.getElementById('cm-reload-button'),
  spreadsheetLink: document.getElementById('cm-spreadsheet-link'),

  notFound: document.getElementById('cm-not-found'),

  searchSection: document.getElementById('cm-search-section'),
  searchForm: document.getElementById('cm-search-form'),
  searchInput: document.getElementById('cm-search-input'),
  tagFilter: document.getElementById('cm-tag-filter'),
  companyFilter: document.getElementById('cm-company-filter'),
  resultCount: document.getElementById('cm-result-count'),
  listBody: document.getElementById('cm-list-body'),
  listEmpty: document.getElementById('cm-list-empty'),

  detail: document.getElementById('cm-detail'),
  editButton: document.getElementById('cm-edit-button'),
  saveButton: document.getElementById('cm-save-button'),
  cancelButton: document.getElementById('cm-cancel-button'),
  closeButton: document.getElementById('cm-close-button'),

  metaCardId: document.getElementById('cm-meta-card-id'),
  metaCompanyId: document.getElementById('cm-meta-company-id'),
  metaCreated: document.getElementById('cm-meta-created'),
  metaUpdated: document.getElementById('cm-meta-updated'),
  metaOcrAt: document.getElementById('cm-meta-ocr-at'),
  metaEngine: document.getElementById('cm-meta-engine'),
  metaConfidence: document.getElementById('cm-meta-confidence'),
  metaOrientation: document.getElementById('cm-meta-orientation'),
  metaLanguage: document.getElementById('cm-meta-language'),
  metaFrontImage: document.getElementById('cm-meta-front-image'),
  metaBackImage: document.getElementById('cm-meta-back-image'),
  metaDuplicateKey: document.getElementById('cm-meta-duplicate-key'),

  rawFront: document.getElementById('cm-raw-front'),
  rawBack: document.getElementById('cm-raw-back'),
  rawMerged: document.getElementById('cm-raw-merged'),

  form: document.getElementById('cm-form'),
};

/* 生成した入力欄。キー → { field, wrapper, input, linksEl } */
const inputs = new Map();

/* メールの行。{ row, input, radio, open, removeButton } の配列。 */
let emailRows = [];

const state = {
  status: CardManagerStatus.IDLE,
  busy: false,
  mode: 'view',

  spreadsheetId: '',
  records: [],
  filtered: [],
  selectedRecord: null,

  hasAuthedBefore: false,
};

/* ============================================================
   表示の基本部品
   ============================================================ */

function setStatus(next, text) {
  state.status = next;
  el.status.textContent = text ?? STATUS_LABELS[next] ?? STATUS_LABELS[CardManagerStatus.IDLE];
}

function showMessage(text, tone) {
  if (!text) {
    el.message.hidden = true;
    el.message.removeAttribute('role');
    el.message.removeAttribute('data-tone');
    el.message.textContent = '';
    return;
  }

  el.message.textContent = text;
  el.message.dataset.tone = tone ?? 'info';

  if (tone === 'error') {
    el.message.setAttribute('role', 'alert');
  } else {
    el.message.removeAttribute('role');
  }

  el.message.hidden = false;
}

function render() {
  const { busy } = state;

  el.connectButton.disabled = busy;
  el.reloadButton.disabled = busy;
  el.editButton.disabled = busy;
  el.saveButton.disabled = busy;
  el.cancelButton.disabled = busy;
  el.closeButton.disabled = busy;
}

function updateConnectVisibility() {
  const connected = hasValidAccessToken();
  el.connectButton.hidden = connected;
  el.reloadButton.hidden = !connected;
}

/* ============================================================
   URLの検証
   http/https 以外（javascript: 等）はリンクにしない。
   ============================================================ */

function isSafeHttpUrl(value) {
  try {
    const url = new URL(String(value ?? '').trim());
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/* ============================================================
   確認・編集フォームの生成
   fields.js の定義から作る。ここで項目を独自に増やさない。
   ============================================================ */

function createFieldRow(field) {
  const config = FIELD_INPUT_TYPES[field.key] ?? {};
  const inputId = `cm-input-${field.key}`;

  const wrapper = document.createElement('div');
  wrapper.className = 'cm-field';
  wrapper.dataset.field = field.key;

  if (config.multiline) {
    wrapper.dataset.span = 'full';
  }

  const head = document.createElement('div');
  head.className = 'cm-field__head';

  const label = document.createElement('label');
  label.className = 'cm-field__label';
  label.setAttribute('for', inputId);
  label.textContent = field.label;

  head.append(label);

  const input = config.multiline
    ? document.createElement('textarea')
    : document.createElement('input');

  input.className = 'cm-field__input';
  input.id = inputId;
  input.readOnly = true;

  if (config.multiline) {
    input.rows = field.key === 'address' || field.key === 'note' ? 3 : 2;
  } else {
    input.type = config.type ?? 'text';
  }

  if (config.inputMode) {
    input.inputMode = config.inputMode;
  }

  if (config.autocomplete) {
    input.autocomplete = config.autocomplete;
  }

  const linksEl = document.createElement('div');
  linksEl.className = 'cm-field__links';

  wrapper.append(head, input, linksEl);

  inputs.set(field.key, { field, wrapper, input, linksEl });

  return wrapper;
}

/* ------------------------------------------------------------
   メール欄
   ------------------------------------------------------------ */

function updateEmailOpenLink(entry) {
  const value = entry.input.value.trim();
  entry.open.hidden = value === '' || state.mode !== 'view';

  if (value !== '') {
    entry.open.href = `mailto:${value}`;
  } else {
    entry.open.removeAttribute('href');
  }
}

function updateEmailControls() {
  const editing = state.mode === 'edit';
  const only = emailRows.length === 1;

  emailRows.forEach((entry) => {
    entry.radio.disabled = !editing || only;
    entry.input.readOnly = !editing;
    entry.removeButton.hidden = !editing;

    if (only) {
      entry.radio.checked = true;
    }

    updateEmailOpenLink(entry);
  });

  el.emailEmpty.hidden = emailRows.length > 0;
  el.emailAdd.hidden = !editing;
}

function removeEmailRow(entry) {
  if (state.mode !== 'edit') {
    return;
  }

  const wasPrimary = entry.radio.checked;

  entry.row.remove();
  emailRows = emailRows.filter((item) => item !== entry);

  if (wasPrimary && emailRows.length > 0) {
    emailRows[0].radio.checked = true;
  }

  updateEmailControls();
}

function createEmailRow(value = '', primary = false) {
  const row = document.createElement('li');
  row.className = 'cm-email';

  const mainLabel = document.createElement('label');
  mainLabel.className = 'cm-email__main';

  const radio = document.createElement('input');
  radio.type = 'radio';
  radio.name = EMAIL_PRIMARY_NAME;
  radio.checked = primary;

  const mainText = document.createElement('span');
  mainText.textContent = 'メイン';

  mainLabel.append(radio, mainText);

  const input = document.createElement('input');
  input.type = 'email';
  input.inputMode = 'email';
  input.className = 'cm-field__input cm-email__input';
  input.value = value;
  input.setAttribute('aria-label', EMAIL_LABEL);
  input.readOnly = true;

  const open = document.createElement('a');
  open.className = 'cm-email__open';
  open.textContent = 'メールする';

  const removeButton = document.createElement('button');
  removeButton.type = 'button';
  removeButton.className = 'cm-email__remove';
  removeButton.textContent = '削除';
  removeButton.setAttribute('aria-label', 'このメールアドレスを削除する');
  removeButton.hidden = true;

  row.append(mainLabel, input, open, removeButton);

  const entry = { row, input, radio, open, removeButton };

  input.addEventListener('input', () => { updateEmailOpenLink(entry); });
  removeButton.addEventListener('click', () => { removeEmailRow(entry); });

  emailRows.push(entry);
  el.emailList.append(row);
  updateEmailOpenLink(entry);

  return entry;
}

function renderEmails(emails, primaryEmail) {
  emailRows = [];
  el.emailList.replaceChildren();

  const list = dedupeEmails(emails);
  const primary = normalizeEmail(primaryEmail);
  const primaryIndex = list.findIndex((item) => normalizeEmail(item) === primary);
  const chosen = primaryIndex >= 0 ? primaryIndex : 0;

  list.forEach((item, index) => { createEmailRow(item, index === chosen); });

  updateEmailControls();
}

function collectEmails() {
  const emails = [];
  let primaryEmail = '';

  emailRows.forEach((entry) => {
    const value = entry.input.value.trim();

    if (value === '') {
      return;
    }

    emails.push(value);

    if (entry.radio.checked && primaryEmail === '') {
      primaryEmail = value;
    }
  });

  const deduped = dedupeEmails(emails);

  if (primaryEmail === ''
    || !deduped.some((item) => normalizeEmail(item) === normalizeEmail(primaryEmail))) {
    primaryEmail = deduped[0] ?? '';
  }

  return { emails: deduped, primaryEmail };
}

function buildEmailBlock() {
  const wrapper = document.createElement('div');
  wrapper.className = 'cm-field cm-field--emails';
  wrapper.dataset.field = 'emails';
  wrapper.dataset.span = 'full';

  const head = document.createElement('div');
  head.className = 'cm-field__head';

  const label = document.createElement('span');
  label.className = 'cm-field__label';
  label.textContent = EMAIL_LABEL;

  head.append(label);

  const list = document.createElement('ul');
  list.className = 'cm-email-list';

  const empty = document.createElement('p');
  empty.className = 'cm-note';
  empty.textContent = EMAIL_EMPTY_TEXT;

  const addButton = document.createElement('button');
  addButton.type = 'button';
  addButton.className = 'btn cm-btn-quiet cm-email-add';
  addButton.textContent = 'メールアドレスを追加';
  addButton.hidden = true;

  wrapper.append(head, list, empty, addButton);

  el.emailList = list;
  el.emailEmpty = empty;
  el.emailAdd = addButton;

  addButton.addEventListener('click', () => {
    if (state.mode !== 'edit') {
      return;
    }

    const entry = createEmailRow('', emailRows.length === 0);
    updateEmailControls();
    entry.input.focus();
  });

  return wrapper;
}

function buildForm() {
  const fragment = document.createDocumentFragment();

  FIELDS.forEach((field) => {
    fragment.append(createFieldRow(field));

    /* メール欄は列定義と同じ位置（氏名かなの直後）に差し込む。 */
    if (field.key === 'nameKana') {
      fragment.append(buildEmailBlock());
    }
  });

  el.form.replaceChildren(fragment);
}

/* ------------------------------------------------------------
   値を開くリンク（メール以外）
   閲覧モードのときだけ、電話・Web・SNSにリンクを添える。
   ------------------------------------------------------------ */

function buildTelLinks(value) {
  const text = String(value ?? '').trim();

  if (text === '') {
    return [];
  }

  const link = document.createElement('a');
  link.href = `tel:${text.replace(/[^\d+#*]/g, '')}`;
  link.textContent = '電話をかける';

  return [link];
}

function buildWebLinks(value) {
  const lines = String(value ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');

  const links = [];

  lines.forEach((line, index) => {
    if (!isSafeHttpUrl(line)) {
      return;
    }

    const a = document.createElement('a');
    a.href = line;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = lines.length > 1 ? `開く (${index + 1})` : '開く';
    links.push(a);
  });

  return links;
}

const LINK_FIELD_BUILDERS = Object.freeze({
  tel: buildTelLinks,
  mobile: buildTelLinks,
  fax: buildTelLinks,
  website: buildWebLinks,
  socialUrl: buildWebLinks,
});

function renderFieldLinks() {
  inputs.forEach((entry, key) => {
    entry.linksEl.replaceChildren();

    const builder = LINK_FIELD_BUILDERS[key];

    if (!builder || state.mode !== 'view') {
      return;
    }

    builder(entry.input.value).forEach((link) => entry.linksEl.append(link));
  });
}

/* ------------------------------------------------------------
   値の読み書き
   ------------------------------------------------------------ */

function renderValues(values) {
  inputs.forEach((entry, key) => {
    entry.input.value = String(values?.[key] ?? '');
  });

  renderEmails(values?.emails, values?.primaryEmail);
  renderFieldLinks();
}

function collectFormValues() {
  const values = {};

  inputs.forEach((entry, key) => {
    values[key] = entry.input.value.trim();
  });

  const { emails, primaryEmail } = collectEmails();
  values.emails = emails;
  values.primaryEmail = primaryEmail;

  return values;
}

/* ============================================================
   自動項目（読み取り専用）の表示
   ============================================================ */

function renderImageLink(container, url, label) {
  container.replaceChildren();

  if (!url || !isSafeHttpUrl(url)) {
    container.textContent = META_EMPTY;
    return;
  }

  const link = document.createElement('a');
  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = label;
  container.append(link);
}

function renderMeta(record) {
  const auto = record.auto ?? {};

  el.metaCardId.textContent = record.cardId || META_EMPTY;
  el.metaCompanyId.textContent = auto.companyId || META_EMPTY;
  el.metaCreated.textContent = auto.createdAt || META_EMPTY;
  el.metaUpdated.textContent = auto.updatedAt || META_EMPTY;
  el.metaOcrAt.textContent = auto.ocrAt || META_EMPTY;
  el.metaEngine.textContent = auto.ocrEngine || META_EMPTY;
  el.metaConfidence.textContent = Number.isFinite(auto.ocrConfidence)
    ? `${auto.ocrConfidence} / 100`
    : META_EMPTY;
  el.metaOrientation.textContent = auto.orientation || META_EMPTY;
  el.metaLanguage.textContent = auto.language || META_EMPTY;
  el.metaDuplicateKey.textContent = auto.duplicateKey || META_EMPTY;

  renderImageLink(el.metaFrontImage, auto.frontImageUrl, '表面画像を開く');
  renderImageLink(el.metaBackImage, auto.backImageUrl, '裏面画像を開く');

  el.rawFront.textContent = auto.frontOcr || '';
  el.rawBack.textContent = auto.backOcr || '';
  el.rawMerged.textContent = auto.mergedOcr || '';
}

/* ============================================================
   詳細・編集パネル
   ============================================================ */

function setMode(mode) {
  state.mode = mode;

  const editing = mode === 'edit';

  inputs.forEach((entry) => { entry.input.readOnly = !editing; });
  updateEmailControls();
  renderFieldLinks();

  el.editButton.hidden = editing;
  el.saveButton.hidden = !editing;
  el.cancelButton.hidden = !editing;
}

function openDetail(record) {
  state.selectedRecord = record;
  /* 先に閲覧モードへ戻してから値を流し込む（別のカードを編集中でも安全にする）。 */
  state.mode = 'view';
  renderMeta(record);
  renderValues(record.values);
  setMode('view');
  showMessage('', 'info');

  el.detail.classList.remove('cm-is-hidden');
  el.detail.scrollIntoView({ block: 'start', behavior: 'auto' });
}

function closeDetail() {
  state.selectedRecord = null;
  el.detail.classList.add('cm-is-hidden');
  setMode('view');
}

/* ============================================================
   一覧・検索
   ============================================================ */

function fillSelect(select, options) {
  const current = select.value;

  select.replaceChildren();

  const allOption = document.createElement('option');
  allOption.value = '';
  allOption.textContent = 'すべて';
  select.append(allOption);

  options.forEach((option) => {
    const opt = document.createElement('option');
    opt.value = option;
    opt.textContent = option;
    select.append(opt);
  });

  if (options.includes(current)) {
    select.value = current;
  }
}

function renderFilters() {
  fillSelect(el.tagFilter, collectTagOptions(state.records));
  fillSelect(el.companyFilter, collectCompanyOptions(state.records));
}

function renderList() {
  el.listBody.replaceChildren();

  state.filtered.forEach((record) => {
    const tr = document.createElement('tr');

    const nameTd = document.createElement('td');
    const openButton = document.createElement('button');
    openButton.type = 'button';
    openButton.className = 'cm-table__open';
    openButton.textContent = record.values.name || '(氏名未入力)';
    openButton.addEventListener('click', () => { openDetail(record); });
    nameTd.append(openButton);

    const companyTd = document.createElement('td');
    companyTd.textContent = record.values.company || '';

    const titleTd = document.createElement('td');
    titleTd.textContent = record.values.title || '';

    const tagsTd = document.createElement('td');
    tagsTd.textContent = record.values.tags || '';

    const createdTd = document.createElement('td');
    createdTd.textContent = record.auto?.createdAt || '';

    tr.append(nameTd, companyTd, titleTd, tagsTd, createdTd);
    el.listBody.append(tr);
  });

  el.listEmpty.hidden = state.filtered.length > 0;
  el.listEmpty.textContent = state.records.length === 0
    ? '登録されている名刺がありません。'
    : '該当する名刺が見つかりません。';
}

function renderCount() {
  el.resultCount.textContent = `${state.filtered.length} 件を表示しています（全 ${state.records.length} 件）`;
}

function applyFilters() {
  state.filtered = filterRecords(state.records, {
    query: el.searchInput.value,
    tag: el.tagFilter.value,
    company: el.companyFilter.value,
  });

  renderList();
  renderCount();
}

/* ============================================================
   台帳が見つからない場合の案内
   ============================================================ */

function showNotFound() {
  el.notFound.classList.remove('cm-is-hidden');
  el.searchSection.classList.add('cm-is-hidden');
  el.spreadsheetLink.hidden = true;
  closeDetail();
}

function hideNotFound() {
  el.notFound.classList.add('cm-is-hidden');
}

/* 台帳をスプレッドシートで直接開けるようにする補助リンク。 */
function renderSpreadsheetLink(spreadsheetId) {
  el.spreadsheetLink.replaceChildren();

  if (!spreadsheetId) {
    el.spreadsheetLink.hidden = true;
    return;
  }

  const link = document.createElement('a');
  link.href = spreadsheetUrl(spreadsheetId);
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = '台帳をスプレッドシートで開く';

  el.spreadsheetLink.append(link);
  el.spreadsheetLink.hidden = false;
}

/* ============================================================
   認可
   ============================================================ */

async function ensureTokenForOperation({ forceConsent = false } = {}) {
  if (!forceConsent && hasValidAccessToken()) {
    return ensureAccessToken();
  }

  setStatus(CardManagerStatus.CONNECTING);
  const reconnect = state.hasAuthedBefore || forceConsent;
  showMessage(reconnect ? CONNECT_MESSAGES.REAUTH : CONNECT_MESSAGES.FIRST, 'info');
  debug('auth:connect', { reconnect, forceConsent });

  const token = await ensureAccessToken({ forceConsent });
  state.hasAuthedBefore = true;
  return token;
}

async function withReauth(operation) {
  const token = await ensureTokenForOperation();

  try {
    return await operation(token);
  } catch (error) {
    if (!isUnauthorized(error)) {
      throw error;
    }

    debug('auth:401-retry', { attempt: 2 });
    clearAccessToken();
    const retryToken = await ensureTokenForOperation({ forceConsent: true });
    return operation(retryToken);
  }
}

/* ============================================================
   読み込み
   ============================================================ */

async function runLoad() {
  if (state.busy) {
    return;
  }

  state.busy = true;
  showMessage('', 'info');
  closeDetail();
  render();

  try {
    await withReauth(async (token) => {
      setStatus(CardManagerStatus.LOADING);
      showMessage('', 'info');

      const { spreadsheetId, found } = await resolveLedger({ token });

      if (!found) {
        state.spreadsheetId = '';
        state.records = [];
        state.filtered = [];
        showNotFound();
        setStatus(CardManagerStatus.NOT_FOUND);
        return;
      }

      hideNotFound();
      state.spreadsheetId = spreadsheetId;
      renderSpreadsheetLink(spreadsheetId);

      const { records } = await readAllRecords({ token, spreadsheetId });
      state.records = records;

      renderFilters();
      applyFilters();
      el.searchSection.classList.remove('cm-is-hidden');
      setStatus(CardManagerStatus.READY, `${records.length} 件を読み込みました`);

      debug('load:success', { count: records.length });
    });
  } catch (error) {
    handleFailure(error, 'load');
  } finally {
    state.busy = false;
    updateConnectVisibility();
    render();
  }
}

/* ============================================================
   保存
   ============================================================ */

async function runSave() {
  if (state.busy || !state.selectedRecord) {
    return;
  }

  const record = state.selectedRecord;
  const values = collectFormValues();

  state.busy = true;
  showMessage('', 'info');
  render();

  try {
    const updated = await withReauth((token) => updateRecord({
      token,
      spreadsheetId: state.spreadsheetId,
      record,
      values,
    }));

    const index = state.records.findIndex((item) => item.rowNumber === updated.rowNumber);

    if (index >= 0) {
      state.records[index] = updated;
    }

    state.selectedRecord = updated;

    renderFilters();
    applyFilters();
    renderMeta(updated);
    renderValues(updated.values);
    setMode('view');
    showMessage('保存しました。', 'success');

    debug('save:success', { row: updated.rowNumber });
  } catch (error) {
    if (error instanceof ManagerError && error.code === ManagerErrorCode.ROW_CONFLICT) {
      showMessage(MANAGER_ERROR_MESSAGES[ManagerErrorCode.ROW_CONFLICT], 'error');
      debug('save:row-conflict', { row: record.rowNumber });
    } else {
      handleFailure(error, 'save');
    }
  } finally {
    state.busy = false;
    render();
  }
}

/* ============================================================
   失敗
   ============================================================ */

function handleFailure(error, phase) {
  const code = (error instanceof DriveAuthError
    || error instanceof SheetsError
    || error instanceof ManagerError)
    ? error.code
    : 'UNEXPECTED';

  debug(`${phase}:failed`, { code });

  if (isUnauthorized(error)) {
    clearAccessToken();
  }

  const next = toStatus(error);
  setStatus(next);

  if (next === CardManagerStatus.CANCELLED) {
    showMessage(CONNECT_MESSAGES.CANCELLED, 'info');
  } else {
    showMessage(toUserMessage(error), 'error');
  }
}

/* ============================================================
   起動
   ============================================================ */

function init() {
  buildForm();
  setStatus(CardManagerStatus.IDLE);
  updateConnectVisibility();

  el.connectButton.addEventListener('click', () => { runLoad(); });
  el.reloadButton.addEventListener('click', () => { runLoad(); });

  el.searchForm.addEventListener('submit', (event) => { event.preventDefault(); });
  el.searchInput.addEventListener('input', () => { applyFilters(); });
  el.tagFilter.addEventListener('change', () => { applyFilters(); });
  el.companyFilter.addEventListener('change', () => { applyFilters(); });

  el.editButton.addEventListener('click', () => { setMode('edit'); });

  el.cancelButton.addEventListener('click', () => {
    if (state.selectedRecord) {
      renderValues(state.selectedRecord.values);
    }

    setMode('view');
    showMessage('', 'info');
  });

  el.saveButton.addEventListener('click', () => { runSave(); });
  el.closeButton.addEventListener('click', () => { closeDetail(); });

  debug('init', { debugEnabled });
}

init();

/*
 * 名刺管理アプリの画面制御。
 *
 * ==================================================================
 * 複製元
 * ==================================================================
 * public/apps/card-manager/script.js（2026-08-20）。本番の流儀
 * （guardPage・CSP・テスト環境からの独立）を足し、台帳の対象を
 * card-ocr が作る本番台帳「名刺管理」へ変更している。
 *
 * テスト環境からの主な変更点:
 *   - guardPage() を必ず通す（card-mail / card-ocr と同じ）
 *   - 認可・台帳アクセスは ./drive-auth.js・./manager-client.js（自前実装）
 *   - メールは1件（複数メール管理・主メール選択は無い）
 *   - タグ列・OCR生テキスト列が台帳に無いため、それらのUIも無い
 *   - 台帳の列構成が最新版と一致しないとき（'upgrade'）は閲覧のみに
 *     切り替える（manager-client.js の writable）
 * ==================================================================
 *
 * ==================================================================
 * このページが守ること
 * ==================================================================
 *   - guardPage() を必ず通す。Portal の一覧に載せていなくても、
 *     URLを知っていれば開けるため。
 *   - innerHTML を使わない。画面の組み立ては textContent と要素生成のみ。
 *   - トークン・台帳の中身（氏名・会社名など）をログに出さない。
 *   - 外部通信は config.js のエンドポイント（Google 2系統）と
 *     TSAM AI 認証系のみ。
 *   - テスト環境（public/apps/）と他の本番アプリから import しない。
 * ==================================================================
 */

import { setScreenDepth } from '../../auth/config.js';
import { guardPage } from '../../auth/session.js';

import { isClientIdConfigured } from './config.js';
import {
  DriveAuthError,
  DriveAuthErrorCode,
  clearAccessToken,
  describeDriveAuthError,
  ensureAccessToken,
  hasValidAccessToken,
} from './drive-auth.js';

import {
  DriveError,
  DriveErrorCode,
  ManagerError,
  ManagerErrorCode,
  clearLedgerCache,
  readAllRecords,
  resolveLedger,
  setManagerLogger,
  spreadsheetUrl,
  updateRecord,
} from './manager-client.js';

import { describeDriveError } from './drive-api.js';

import { collectCompanyOptions, filterRecords } from './search.js';
import { CONTENT_FIELDS, META_FIELDS } from './records.js';

/* /production-app/card-manager/ はサイトのルートから2階層下。 */
setScreenDepth(2);

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

setManagerLogger(debug);

/* ============================================================
   要素
   ============================================================ */

const el = {};

for (const id of [
  'cm-loading', 'cm-content',
  'cm-status', 'cm-message',
  'cm-connect-button', 'cm-reload-button', 'cm-disconnect-button', 'cm-spreadsheet-link',
  'cm-not-found',
  'cm-search-section', 'cm-search-form', 'cm-search-input', 'cm-company-filter',
  'cm-result-count', 'cm-list-body', 'cm-list-empty',
  'cm-detail', 'cm-edit-button', 'cm-save-button', 'cm-cancel-button', 'cm-close-button',
  'cm-readonly-note', 'cm-meta', 'cm-form',
]) {
  el[id] = document.getElementById(id);
}

/* 生成した入力欄。キー → { field, wrapper, input, linksEl } */
const inputs = new Map();

/* 生成した自動項目の値要素。キー → dd要素 */
const metaValues = new Map();

/* ============================================================
   文言
   ============================================================ */

const CONNECT_MESSAGES = Object.freeze({
  FIRST: 'Googleドライブへの接続が必要です。認証画面で許可してください。',
  REAUTH: 'Googleドライブへ再接続しています。',
  CANCELLED: 'Googleドライブへの接続がキャンセルされました。',
});

const AUTH_ERROR_MESSAGES = Object.freeze({
  [DriveAuthErrorCode.CLIENT_ID_MISSING]:
    'このアプリは現在準備中です。設定が完了するまでお待ちください。',
  [DriveAuthErrorCode.GIS_LOAD_FAILED]:
    'Googleの認証機能を読み込めませんでした。通信環境をご確認のうえ、ページを再読み込みしてお試しください。',
  [DriveAuthErrorCode.POPUP_CLOSED]:
    '認証画面が閉じられたため、処理を中止しました。もう一度お試しください。',
  [DriveAuthErrorCode.POPUP_BLOCKED]:
    '認証画面を開けませんでした。ブラウザのポップアップブロックを解除してお試しください。',
  [DriveAuthErrorCode.ACCESS_DENIED]:
    'Googleドライブへのアクセスが許可されませんでした。読み書きには権限の許可が必要です。',
  [DriveAuthErrorCode.SCOPE_NOT_GRANTED]:
    'Googleドライブへの権限が許可されませんでした。権限の確認画面で「許可」を選んでください。',
});

const MANAGER_ERROR_MESSAGES = Object.freeze({
  [ManagerErrorCode.HEADER_MISMATCH]:
    '台帳の列構成が想定と異なるため読み込めませんでした。台帳を手編集していないかご確認ください。',
  [ManagerErrorCode.HEADER_OUTDATED]:
    '台帳の列構成が古いため編集できません。名刺OCRアプリで台帳を開くと自動的に更新されます。',
  [ManagerErrorCode.ROW_CONFLICT]:
    '台帳が別の場所で変更されています。一覧を読み込み直してください。',
});

const FALLBACK_ERROR_MESSAGE = '処理に失敗しました。もう一度お試しください。';

function toUserMessage(error) {
  if (error instanceof DriveAuthError) {
    return AUTH_ERROR_MESSAGES[error.code] ?? 'Google連携に失敗しました。';
  }

  if (error instanceof DriveError) {
    return describeDriveError(error).text;
  }

  if (error instanceof ManagerError) {
    return MANAGER_ERROR_MESSAGES[error.code] ?? FALLBACK_ERROR_MESSAGE;
  }

  return FALLBACK_ERROR_MESSAGE;
}

function isUnauthorized(error) {
  return error instanceof DriveError && error.code === DriveErrorCode.UNAUTHORIZED;
}

/* ============================================================
   状態
   ============================================================ */

const state = {
  busy: false,
  mode: 'view',

  spreadsheetId: '',
  records: [],
  filtered: [],
  selectedRecord: null,
  writable: false,

  hasAuthedBefore: false,
};

/* ============================================================
   表示の基本部品
   ============================================================ */

function showMessage(text, { isError = false } = {}) {
  el['cm-message'].textContent = text;
  el['cm-message'].hidden = text === '';
  el['cm-message'].classList.toggle('cm-message--error', isError);
}

function setStatus(text) {
  el['cm-status'].textContent = text;
}

function updateConnectVisibility() {
  const connected = hasValidAccessToken();
  el['cm-connect-button'].hidden = connected;
  el['cm-reload-button'].hidden = !connected;
  el['cm-disconnect-button'].hidden = !connected;
}

function render() {
  const { busy } = state;

  el['cm-connect-button'].disabled = busy;
  el['cm-reload-button'].disabled = busy;
  el['cm-disconnect-button'].disabled = busy;
  el['cm-edit-button'].disabled = busy;
  el['cm-save-button'].disabled = busy;
  el['cm-cancel-button'].disabled = busy;
  el['cm-close-button'].disabled = busy;
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
   編集フォームの生成（CONTENT_FIELDS から）
   ============================================================ */

function createFieldRow(field) {
  const inputId = `cm-input-${field.key}`;

  const wrapper = document.createElement('div');
  wrapper.className = 'cm-field';
  wrapper.dataset.field = field.key;

  if (field.multiline) {
    wrapper.dataset.span = 'full';
  }

  const label = document.createElement('label');
  label.className = 'cm-field__label';
  label.setAttribute('for', inputId);
  label.textContent = field.label;

  const input = field.multiline
    ? document.createElement('textarea')
    : document.createElement('input');

  input.className = 'cm-field__input';
  input.id = inputId;
  input.readOnly = true;

  /*
   * 保存時のサニタイズ上限（sanitize.js の escapeCellText /
   * escapeLongCellText）と揃える。揃えないと、画面では入力できたのに
   * 保存時に末尾が無警告で切り詰められる（records.js の maxLengthFor）。
   */
  if (field.maxLength) {
    input.maxLength = field.maxLength;
  }

  if (field.multiline) {
    input.rows = field.rows ?? 2;
  } else {
    input.type = field.type ?? 'text';
  }

  if (field.inputMode) {
    input.inputMode = field.inputMode;
  }

  if (field.autocomplete) {
    input.autocomplete = field.autocomplete;
  }

  const linksEl = document.createElement('div');
  linksEl.className = 'cm-field__links';

  wrapper.append(label, input, linksEl);

  inputs.set(field.key, { field, wrapper, input, linksEl });

  return wrapper;
}

function buildForm() {
  const fragment = document.createDocumentFragment();
  CONTENT_FIELDS.forEach((field) => { fragment.append(createFieldRow(field)); });
  el['cm-form'].replaceChildren(fragment);
}

/* ------------------------------------------------------------
   値を開くリンク（電話・メール・Web）
   閲覧モードのときだけ、電話・メール・Webにリンクを添える。
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

function buildMailLinks(value) {
  const text = String(value ?? '').trim();

  if (text === '') {
    return [];
  }

  const link = document.createElement('a');
  link.href = `mailto:${text}`;
  link.textContent = 'メールする';

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
  phone: buildTelLinks,
  mobile: buildTelLinks,
  email: buildMailLinks,
  url: buildWebLinks,
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

  renderFieldLinks();
}

function collectFormValues() {
  const values = {};

  inputs.forEach((entry, key) => {
    values[key] = entry.input.value.trim();
  });

  return values;
}

/* ============================================================
   自動項目（読み取り専用）の表示（META_FIELDS から）
   ============================================================ */

const META_EMPTY = '—';

function buildMetaPanel() {
  const fragment = document.createDocumentFragment();

  META_FIELDS.forEach((field) => {
    const item = document.createElement('div');
    item.className = 'cm-meta__item';

    const dt = document.createElement('dt');
    dt.className = 'cm-meta__label';
    dt.textContent = field.label;

    const dd = document.createElement('dd');
    dd.className = 'cm-meta__value';
    dd.textContent = META_EMPTY;

    item.append(dt, dd);
    fragment.append(item);
    metaValues.set(field.key, dd);
  });

  el['cm-meta'].replaceChildren(fragment);
}

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

  metaValues.forEach((dd, key) => {
    if (key === 'frontFileUrl') {
      renderImageLink(dd, auto.frontFileUrl, '表面画像を開く');
      return;
    }

    if (key === 'backFileUrl') {
      renderImageLink(dd, auto.backFileUrl, '裏面画像を開く');
      return;
    }

    if (key === 'hasBack') {
      dd.textContent = auto.hasBack ? 'あり' : 'なし';
      return;
    }

    const value = auto[key];
    dd.textContent = value === '' || value === null || value === undefined ? META_EMPTY : String(value);
  });
}

/* ============================================================
   詳細・編集パネル
   ============================================================ */

function setMode(mode) {
  state.mode = mode;

  const editing = mode === 'edit';

  inputs.forEach((entry) => { entry.input.readOnly = !editing; });
  renderFieldLinks();

  el['cm-edit-button'].hidden = editing || !state.writable;
  el['cm-save-button'].hidden = !editing;
  el['cm-cancel-button'].hidden = !editing;
}

function openDetail(record) {
  state.selectedRecord = record;
  /* 先に閲覧モードへ戻してから値を流し込む（別のカードを編集中でも安全にする）。 */
  state.mode = 'view';
  renderMeta(record);
  renderValues(record.values);
  setMode('view');
  el['cm-readonly-note'].hidden = state.writable;
  showMessage('');

  el['cm-detail'].hidden = false;
  el['cm-detail'].scrollIntoView({ block: 'start', behavior: 'auto' });
}

function closeDetail() {
  state.selectedRecord = null;
  el['cm-detail'].hidden = true;
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
  fillSelect(el['cm-company-filter'], collectCompanyOptions(state.records));
}

function renderList() {
  el['cm-list-body'].replaceChildren();

  state.filtered.forEach((record) => {
    const tr = document.createElement('tr');

    const nameTd = document.createElement('td');
    const openButton = document.createElement('button');
    openButton.type = 'button';
    openButton.className = 'cm-table__open';
    openButton.textContent = record.values.fullName || '(氏名未入力)';
    openButton.addEventListener('click', () => { openDetail(record); });
    nameTd.append(openButton);

    const companyTd = document.createElement('td');
    companyTd.textContent = record.values.companyName || '';

    const titleTd = document.createElement('td');
    titleTd.textContent = record.values.jobTitle || '';

    const createdTd = document.createElement('td');
    createdTd.textContent = record.auto?.registeredAt || '';

    tr.append(nameTd, companyTd, titleTd, createdTd);
    el['cm-list-body'].append(tr);
  });

  el['cm-list-empty'].hidden = state.filtered.length > 0;
  el['cm-list-empty'].textContent = state.records.length === 0
    ? '登録されている名刺がありません。'
    : '該当する名刺が見つかりません。';
}

function renderCount() {
  el['cm-result-count'].textContent = `${state.filtered.length} 件を表示しています（全 ${state.records.length} 件）`;
}

function applyFilters() {
  state.filtered = filterRecords(state.records, {
    query: el['cm-search-input'].value,
    company: el['cm-company-filter'].value,
  });

  renderList();
  renderCount();
}

/* ============================================================
   台帳が見つからない場合の案内
   ============================================================ */

function showNotFound() {
  el['cm-not-found'].hidden = false;
  el['cm-search-section'].hidden = true;
  el['cm-spreadsheet-link'].hidden = true;
  closeDetail();
}

function hideNotFound() {
  el['cm-not-found'].hidden = true;
}

/* 台帳をスプレッドシートで直接開けるようにする補助リンク。 */
function renderSpreadsheetLink(spreadsheetId) {
  el['cm-spreadsheet-link'].replaceChildren();

  if (!spreadsheetId) {
    el['cm-spreadsheet-link'].hidden = true;
    return;
  }

  const link = document.createElement('a');
  link.href = spreadsheetUrl(spreadsheetId);
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = '台帳をスプレッドシートで開く';

  el['cm-spreadsheet-link'].replaceChildren(link);
  el['cm-spreadsheet-link'].hidden = false;
}

/* ============================================================
   認可
   ============================================================ */

async function ensureTokenForOperation({ forceConsent = false } = {}) {
  if (!forceConsent && hasValidAccessToken()) {
    return ensureAccessToken();
  }

  const reconnect = state.hasAuthedBefore || forceConsent;
  showMessage(reconnect ? CONNECT_MESSAGES.REAUTH : CONNECT_MESSAGES.FIRST);
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
  showMessage('');
  closeDetail();
  render();

  try {
    await withReauth(async (token) => {
      setStatus('台帳を読み込んでいます');
      showMessage('');

      const { spreadsheetId, found } = await resolveLedger({ token });

      if (!found) {
        state.spreadsheetId = '';
        state.records = [];
        state.filtered = [];
        state.writable = false;
        showNotFound();
        setStatus('台帳が見つかりません');
        return;
      }

      hideNotFound();
      state.spreadsheetId = spreadsheetId;
      renderSpreadsheetLink(spreadsheetId);

      const { records, writable } = await readAllRecords({ token, spreadsheetId });
      state.records = records;
      state.writable = writable;

      renderFilters();
      applyFilters();
      el['cm-search-section'].hidden = false;
      setStatus(`${records.length} 件を読み込みました`);

      if (!writable) {
        showMessage(
          '台帳の列構成が名刺OCRの最新版と一致しないため、このセッションでは閲覧のみです。',
        );
      }

      debug('load:success', { count: records.length, writable });
    });
  } catch (error) {
    /*
     * **失敗した読み込みの結果を、古い一覧のまま残さない。**
     * HEADER_MISMATCH 等で再読み込みが失敗しても一覧・編集ボタンが
     * 前回の状態のまま残ると、利用者は「読み込み直しに失敗した」ことに
     * 気づけず、古い（もしかすると writable=true の）一覧を編集できる
     * ように見えてしまう。台帳が見つからない場合（showNotFound 経由）と
     * 同じ空の状態へ揃える。
     */
    state.records = [];
    state.filtered = [];
    state.writable = false;
    closeDetail();
    renderFilters();
    renderList();
    renderCount();
    el['cm-search-section'].hidden = true;

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
  showMessage('');
  render();

  try {
    const { record: updated, historyRecorded } = await withReauth((token) => updateRecord({
      token,
      spreadsheetId: state.spreadsheetId,
      record,
      values,
      writable: state.writable,
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

    showMessage(
      historyRecorded
        ? '保存しました。'
        : '保存しましたが、変更履歴への記録には失敗しました。',
      { isError: !historyRecorded },
    );

    debug('save:success', { row: updated.rowNumber, historyRecorded });
  } catch (error) {
    if (error instanceof ManagerError && error.code === ManagerErrorCode.ROW_CONFLICT) {
      showMessage(MANAGER_ERROR_MESSAGES[ManagerErrorCode.ROW_CONFLICT], { isError: true });
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
    || error instanceof DriveError
    || error instanceof ManagerError)
    ? error.code
    : 'UNEXPECTED';

  debug(`${phase}:failed`, { code });

  if (error instanceof DriveAuthError
    && (error.code === DriveAuthErrorCode.POPUP_CLOSED || error.code === DriveAuthErrorCode.POPUP_BLOCKED)) {
    setStatus('接続がキャンセルされました');
    showMessage(CONNECT_MESSAGES.CANCELLED);
    return;
  }

  if (isUnauthorized(error)) {
    clearAccessToken();
    updateConnectVisibility();
  }

  setStatus('処理に失敗しました');
  showMessage(toUserMessage(error), { isError: true });
}

/* ============================================================
   起動
   ============================================================ */

async function boot() {
  const user = await guardPage({ next: 'portal' });

  if (!user) {
    return; /* すでにログイン画面へ遷移している。 */
  }

  el['cm-loading'].hidden = true;
  el['cm-content'].hidden = false;

  buildForm();
  buildMetaPanel();
  updateConnectVisibility();

  if (!isClientIdConfigured()) {
    setStatus('このアプリは現在準備中です');
    showMessage('Google連携の設定が未完了です（クライアントID未設定）。', { isError: true });
    return;
  }

  el['cm-connect-button'].addEventListener('click', () => { runLoad(); });
  el['cm-reload-button'].addEventListener('click', () => { runLoad(); });

  el['cm-disconnect-button'].addEventListener('click', () => {
    if (state.busy) {
      return;
    }

    clearAccessToken();
    /*
     * 台帳の場所（localStorage のファイルID）のキャッシュも捨てる。
     * トークンだけ捨てて場所のキャッシュを残すと、次に連携したときに
     * 「本当にいまも同じ場所にあるか」を検証する手間を省いてしまう
     * （verifyCachedId 自体は毎回行うが、連携解除＝いったん白紙に戻す、
     * という利用者の意図に合わせる）。
     */
    clearLedgerCache();
    state.spreadsheetId = '';
    state.records = [];
    state.filtered = [];
    state.writable = false;
    closeDetail();
    hideNotFound();
    el['cm-search-section'].hidden = true;
    el['cm-spreadsheet-link'].hidden = true;
    setStatus('Googleドライブに接続していません');
    showMessage('連携を解除しました。');
    updateConnectVisibility();
  });

  el['cm-search-form'].addEventListener('submit', (event) => { event.preventDefault(); });
  el['cm-search-input'].addEventListener('input', () => { applyFilters(); });
  el['cm-company-filter'].addEventListener('change', () => { applyFilters(); });

  el['cm-edit-button'].addEventListener('click', () => { setMode('edit'); });

  el['cm-cancel-button'].addEventListener('click', () => {
    if (state.selectedRecord) {
      renderValues(state.selectedRecord.values);
    }

    setMode('view');
    showMessage('');
  });

  el['cm-save-button'].addEventListener('click', () => { runSave(); });
  el['cm-close-button'].addEventListener('click', () => { closeDetail(); });

  debug('init', { debugEnabled });
}

boot();

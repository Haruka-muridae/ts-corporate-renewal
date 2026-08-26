/*
 * Push Assistant の画面。
 *
 * 仕様は docs/specs/push-assistant-mvp-v1.md。
 *
 * ==================================================================
 * この画面がすること
 * ==================================================================
 *   1. GET ./api/me で状態を読み、Google Calendar 接続・通知設定を出す
 *   2. この端末を Web Push に登録する（許可 → Service Worker 登録 → 購読）
 *   3. 直近の予定と通知履歴を出す
 *
 * 通知そのものを出すのは Service Worker（sw.js）である。
 * ==================================================================
 *
 * ==================================================================
 * XSS（docs/specs/push-assistant-mvp-v1.md §10）
 * ==================================================================
 * innerHTML は一切使わない。DOM は createElement と textContent だけで組む。
 * href に外部由来の値を入れるのは http(s) のときだけ（isHttpUrl）。
 * ==================================================================
 */

/* ---------- ステータス文言 ---------- */

const NOTIFICATION_STATUS_LABEL = {
  planned: '予定',
  pending: '待機',
  sending: '送信中',
  sent: '送信済み',
  failed: '失敗',
  skipped: '見送り',
};

/* /api/*（コールバックのエラー遷移含む）が返しうるエラーコード（§7）。
 * 未知のコードはフォールバック文言にする。 */
const ERROR_MESSAGES = {
  UNAUTHORIZED: 'ログインが必要です。もう一度「接続する」からやり直してください。',
  FORBIDDEN_ORIGIN: '不正な要求として拒否されました。画面を開き直してください。',
  INVALID_REQUEST: '要求の内容が正しくありませんでした。',
  NOT_CONNECTED: 'Google カレンダーが未接続です。「接続する」からやり直してください。',
  TOKEN_INVALID: 'Google との接続が切れました。再接続してください。',
  CALENDAR_ERROR: 'Google カレンダーを取得できませんでした。時間をおいてお試しください。',
  NOT_CONFIGURED: 'サーバー側の設定が未完了です。しばらくしてからお試しください。',
  SERVER_ERROR: 'サーバーでエラーが発生しました。時間をおいてお試しください。',
  NOT_FOUND: '見つかりませんでした。',

  /*
   * ここから下は /api/auth/callback が `?error=` で返すコード。
   * **API の応答本文ではなく URL のクエリで来る**（コールバックは
   * ブラウザのトップレベル遷移なので、JSON を見せても利用者は読めない）。
   * 対応する送出箇所は workers/push-assistant/src/api.mjs の handleAuthCallback。
   */
  OAUTH_DENIED: 'Google の同意画面でキャンセルされました。もう一度「接続する」からやり直してください。',
  SESSION_EXPIRED: '接続の手続きが時間切れになりました。もう一度「接続する」からやり直してください。',
  OAUTH_FAILED: 'Google との接続に失敗しました。時間をおいてもう一度お試しください。',
  NO_REFRESH_TOKEN: 'Google が更新用のトークンを返しませんでした。Google アカウントの'
    + '「アプリとサイト」からこのアプリの連携を一度削除し、もう一度接続してください。',
  NOT_ALLOWED: 'このアカウントは利用を許可されていません。',
  SCOPE_NOT_GRANTED: 'カレンダーの読み取りが許可されませんでした。'
    + '同意画面でカレンダーのチェックを外さずに、もう一度お試しください。',
};

const el = (id) => document.getElementById(id);

/* ---------- 状態 ---------- */

let state = {
  loggedIn: false,
  user: null,
  calendarConnected: false,
  tokenInvalid: false,
  settings: { notifyEnabled: true, leadMinutes: [10], notifyTitle: '', notifyBody: '' },
  vapidPublicKey: '',
  subscriptionCount: 0,
  leadOptions: [],
};

/* ---------- 汎用 ---------- */

function setMessage(text, kind = 'info') {
  const box = el('pa-message');

  box.textContent = text;
  box.dataset.kind = kind;
  box.hidden = text === '';
}

function isHttpUrl(text) {
  if (typeof text !== 'string' || text === '') {
    return false;
  }

  try {
    const url = new URL(text);

    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/** 予定・通知履歴に載せる URL 表示。テキストは常に出し、href は http(s) のときだけ付ける。 */
function buildUrlNode(text) {
  const a = document.createElement('a');

  a.textContent = String(text ?? '');

  if (isHttpUrl(text)) {
    a.href = text;
  }

  return a;
}

/** 端末ローカル時刻。当日でなければ日付も付ける。 */
function formatWhen(iso, now = new Date()) {
  const date = new Date(iso);

  if (Number.isNaN(date.getTime())) {
    return '';
  }

  const time = new Intl.DateTimeFormat('ja-JP', { hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
  const sameDay = date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();

  if (sameDay) {
    return time;
  }

  const md = new Intl.DateTimeFormat('ja-JP', { month: 'numeric', day: 'numeric' }).format(date);

  return `${md} ${time}`;
}

function statusLabel(status) {
  return NOTIFICATION_STATUS_LABEL[status] ?? String(status ?? '');
}

/* ---------- API 呼び出し ---------- */

async function apiFetch(path, { method = 'GET', body } = {}) {
  const init = { method, credentials: 'same-origin' };

  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }

  let response;

  try {
    response = await fetch(path, init);
  } catch {
    return { networkError: true, status: 0, payload: null };
  }

  let payload = null;

  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  return { networkError: false, status: response.status, payload };
}

/**
 * API のエラー応答を画面へ反映する。UNAUTHORIZED はログアウト状態へ戻す
 * （§7・§5）。それ以外はメッセージだけ出す。
 */
function handleApiFailure({ networkError, payload }, fallbackMessage) {
  if (networkError) {
    setMessage('通信できませんでした。時間をおいてお試しください。', 'error');
    return;
  }

  const code = payload?.error?.code;

  if (code === 'UNAUTHORIZED') {
    state.loggedIn = false;
    state.calendarConnected = false;
    state.tokenInvalid = false;
    renderCalendarSection();
    renderSettingsSection();
    renderEventsList([]);
    renderHistoryList([]);
  }

  const message = payload?.error?.message || ERROR_MESSAGES[code] || fallbackMessage;

  setMessage(message, 'error');
}

/* ---------- ?error= の表示（§7 コールバック失敗時） ---------- */

function handleQueryError() {
  const params = new URLSearchParams(location.search);
  const code = params.get('error');

  if (!code) {
    return;
  }

  setMessage(ERROR_MESSAGES[code] || `接続に失敗しました（${code}）。`, 'error');
  params.delete('error');

  const query = params.toString();

  history.replaceState(null, '', location.pathname + (query ? `?${query}` : ''));
}

/* ---------- Google Calendar 欄 ---------- */

function renderCalendarSection() {
  const stateEl = el('pa-calendar-state');
  const connect = el('pa-connect');
  const disconnect = el('pa-disconnect');

  if (!state.loggedIn) {
    stateEl.textContent = '未接続';
    connect.hidden = false;
    disconnect.hidden = true;
    return;
  }

  if (state.tokenInvalid) {
    stateEl.textContent = '再接続が必要です';
    connect.hidden = false;
    disconnect.hidden = false;
    return;
  }

  if (state.calendarConnected) {
    stateEl.textContent = `接続済み（${state.user?.email ?? ''}）`;
    connect.hidden = true;
    disconnect.hidden = false;
    return;
  }

  stateEl.textContent = '未接続';
  connect.hidden = false;
  disconnect.hidden = true;
}

/* ---------- 通知設定 欄 ---------- */

function renderSettingsSection() {
  const panel = el('pa-settings-panel');

  if (!state.loggedIn) {
    panel.hidden = true;
    return;
  }

  panel.hidden = false;

  const select = el('pa-lead');

  select.textContent = '';

  for (const option of state.leadOptions) {
    const opt = document.createElement('option');

    opt.value = String(option.value);
    opt.textContent = option.label;
    select.appendChild(opt);
  }

  const currentLead = Array.isArray(state.settings.leadMinutes) ? state.settings.leadMinutes[0] : undefined;

  if (currentLead !== undefined) {
    select.value = String(currentLead);
  }

  el('pa-notify-enabled').checked = state.settings.notifyEnabled !== false;

  /* 通知テンプレート（グローバル）。 */
  el('pa-notify-title').value = String(state.settings.notifyTitle ?? '');
  el('pa-notify-body').value = String(state.settings.notifyBody ?? '');
}

async function saveSettings() {
  const body = {
    notifyEnabled: el('pa-notify-enabled').checked,
    leadMinutes: [Number(el('pa-lead').value)],
    notifyTitle: el('pa-notify-title').value,
    notifyBody: el('pa-notify-body').value,
  };

  const result = await apiFetch('./api/settings', { method: 'PUT', body });

  if (result.networkError || !result.payload || result.payload.ok !== true) {
    handleApiFailure(result, '設定を保存できませんでした。');
    return;
  }

  state.settings = result.payload.settings ?? state.settings;
  renderSettingsSection();
  setMessage('設定を保存しました。', 'success');
}

/* ---------- Google Calendar 接続/切断 ---------- */

async function disconnectCalendar() {
  const result = await apiFetch('./api/auth/disconnect', { method: 'POST' });

  if (result.networkError || !result.payload || result.payload.ok !== true) {
    handleApiFailure(result, '切断できませんでした。');
    return;
  }

  setMessage('Google Calendar との接続を解除しました。', 'success');
  await loadMe();
  await refreshLists();
}

/* ---------- 通知許可・購読 ---------- */

const IOS_UA_PATTERN = /iPhone|iPad|iPod/i;

function isIosDevice() {
  return IOS_UA_PATTERN.test(navigator.userAgent ?? '');
}

function isStandaloneDisplay() {
  if (navigator.standalone === true) {
    return true;
  }

  try {
    return globalThis.matchMedia?.('(display-mode: standalone)')?.matches === true;
  } catch {
    return false;
  }
}

function pushApiSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in globalThis && 'Notification' in globalThis;
}

/** ホーム画面に追加していない iOS Safari は Push API 自体が無い。案内だけ出す。 */
function needsIosHomeScreenAddition() {
  return isIosDevice() && !isStandaloneDisplay() && !pushApiSupported();
}

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

async function deviceSubscription() {
  if (!('serviceWorker' in navigator)) {
    return null;
  }

  const registration = await navigator.serviceWorker.getRegistration();

  if (!registration) {
    return null;
  }

  return registration.pushManager.getSubscription();
}

async function renderPermissionSection() {
  const stateEl = el('pa-permission-state');
  const requestButton = el('pa-request-permission');
  const testButton = el('pa-test-push');
  const iosNote = el('pa-ios-note');

  iosNote.hidden = !needsIosHomeScreenAddition();

  if (needsIosHomeScreenAddition()) {
    stateEl.textContent = '未対応（ホーム画面への追加が必要）';
    requestButton.hidden = true;
    testButton.hidden = true;
    return;
  }

  if (!pushApiSupported()) {
    stateEl.textContent = 'このブラウザは通知に対応していません';
    requestButton.hidden = true;
    testButton.hidden = true;
    return;
  }

  requestButton.hidden = false;

  const permission = Notification.permission;

  if (permission === 'denied') {
    stateEl.textContent = '拒否されています（ブラウザの設定から許可してください）';
    testButton.hidden = true;
    return;
  }

  if (permission === 'granted') {
    const subscription = await deviceSubscription().catch(() => null);

    stateEl.textContent = subscription ? '許可済み（この端末は登録済み）' : '許可済み（この端末は未登録）';
    testButton.hidden = !state.loggedIn;
    return;
  }

  stateEl.textContent = '未許可';
  testButton.hidden = true;
}

async function subscribeThisDevice() {
  if (!pushApiSupported()) {
    setMessage('このブラウザは Web Push に対応していません。', 'error');
    return;
  }

  const permission = await Notification.requestPermission();

  if (permission !== 'granted') {
    setMessage('通知が許可されませんでした。ブラウザの設定から許可すると受け取れます。', 'error');
    await renderPermissionSection();
    return;
  }

  if (!state.vapidPublicKey) {
    setMessage('通知の設定が完了していません。時間をおいてお試しください。', 'error');
    return;
  }

  const registration = await navigator.serviceWorker.register('./sw.js');

  await navigator.serviceWorker.ready;

  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: base64UrlToUint8Array(state.vapidPublicKey),
  });

  const result = await apiFetch('./api/subscriptions', {
    method: 'POST',
    body: { subscription: subscription.toJSON(), userAgent: navigator.userAgent },
  });

  if (result.networkError || !result.payload || result.payload.ok !== true) {
    handleApiFailure(result, 'この端末を登録できませんでした。');
    return;
  }

  setMessage('この端末を通知の宛先として登録しました。', 'success');
  await renderPermissionSection();
}

async function sendTestPush() {
  const result = await apiFetch('./api/push/test', { method: 'POST' });

  if (result.networkError || !result.payload || result.payload.ok !== true) {
    handleApiFailure(result, 'テスト通知を送れませんでした。');
    return;
  }

  const { sent = 0, failed = 0 } = result.payload;

  setMessage(`テスト通知を送りました（成功 ${sent} 件・失敗 ${failed} 件）。`, failed > 0 && sent === 0 ? 'error' : 'success');
}

/* ---------- 次回の予定 ---------- */

function renderEventsList(items) {
  const list = el('pa-events-list');
  const empty = el('pa-events-empty');

  list.textContent = '';

  if (!Array.isArray(items) || items.length === 0) {
    empty.hidden = false;
    return;
  }

  empty.hidden = true;

  for (const item of items) {
    const li = document.createElement('li');
    li.className = 'pa-event';

    const when = document.createElement('p');
    when.className = 'pa-event__when';
    when.textContent = `${formatWhen(item.start)}　${item.title ?? ''}`;
    li.appendChild(when);

    if (Array.isArray(item.notifications) && item.notifications.length > 0) {
      const notifyList = document.createElement('ul');
      notifyList.className = 'pa-event__notify-list';

      for (const notification of item.notifications) {
        const notifyItem = document.createElement('li');
        notifyItem.textContent = `通知予定 ${formatWhen(notification.notifyAt)}（${statusLabel(notification.status)}）`;
        notifyList.appendChild(notifyItem);
      }

      li.appendChild(notifyList);
    }

    const urlPara = document.createElement('p');
    urlPara.className = 'pa-event__url';
    urlPara.appendChild(buildUrlNode(item.openUrl));
    li.appendChild(urlPara);

    /*
     * 通知対象（allDay=false）の予定にだけ上書き欄を出す。終日予定は
     * 通知の対象外（§8-2）なので、文章もタイミングも効かない。出しても
     * 混乱するだけなので MVP では出さない（設計判断）。
     */
    if (item.allDay !== true) {
      li.appendChild(buildOverrideEditor(item));
    }

    list.appendChild(li);
  }
}

/**
 * 予定ごとの「通知に表示する文章」「タップで開く URL」の上書き欄。
 *
 * innerHTML は使わず createElement と textContent/value だけで組む（§10）。
 * label は input を包んで関連付ける（グローバル id を作らず衝突を避ける）。
 * 折りたたみは <details>/<summary>（JS 不要・prefers-reduced-motion に従う）。
 */
function buildOverrideEditor(item) {
  const details = document.createElement('details');
  details.className = 'pa-event__override';

  const summary = document.createElement('summary');
  summary.className = 'pa-event__override-toggle';
  summary.textContent = '通知の文章とリンクを設定';
  details.appendChild(summary);

  const bodyBox = document.createElement('div');
  bodyBox.className = 'pa-event__override-body';

  /* 通知に表示する文章。 */
  const titleField = document.createElement('label');
  titleField.className = 'pa-field';

  const titleLabel = document.createElement('span');
  titleLabel.textContent = '通知に表示する文章';
  titleField.appendChild(titleLabel);

  const titleInput = document.createElement('input');
  titleInput.type = 'text';
  titleInput.className = 'pa-event__override-input';
  titleInput.maxLength = 120;
  titleInput.value = String(item.customTitle ?? '');
  /* 未入力なら予定タイトルが使われることを見せる。 */
  titleInput.placeholder = String(item.title ?? '');
  titleField.appendChild(titleInput);
  bodyBox.appendChild(titleField);

  /* タップで開く URL。 */
  const urlField = document.createElement('label');
  urlField.className = 'pa-field';

  const urlLabel = document.createElement('span');
  urlLabel.textContent = 'タップで開く URL';
  urlField.appendChild(urlLabel);

  const urlInput = document.createElement('input');
  urlInput.type = 'text';
  urlInput.className = 'pa-event__override-input';
  urlInput.inputMode = 'url';
  urlInput.value = String(item.customUrl ?? '');
  /* 未入力なら自動で決まる現在の行き先を見せる。 */
  urlInput.placeholder = `自動: ${String(item.openUrl ?? '')}`;
  urlField.appendChild(urlInput);
  bodyBox.appendChild(urlField);

  const actions = document.createElement('p');
  actions.className = 'pa-actions';

  const saveButton = document.createElement('button');
  saveButton.type = 'button';
  saveButton.className = 'pa-button';
  saveButton.textContent = '保存';
  actions.appendChild(saveButton);
  bodyBox.appendChild(actions);

  const msg = document.createElement('p');
  msg.className = 'pa-event__override-msg';
  msg.setAttribute('role', 'status');
  msg.hidden = true;
  bodyBox.appendChild(msg);

  saveButton.addEventListener('click', async () => {
    saveButton.disabled = true;

    try {
      await saveEventOverride({ eventId: item.id, titleInput, urlInput, msg });
    } catch {
      setOverrideMessage(msg, '保存できませんでした。', 'error');
    } finally {
      saveButton.disabled = false;
    }
  });

  details.appendChild(bodyBox);

  return details;
}

function setOverrideMessage(msg, text, kind) {
  msg.textContent = text;
  msg.dataset.kind = kind;
  msg.hidden = text === '';
}

/**
 * 上書きを保存する。成功したら一覧を引き直して、実際に通知へ載る
 * openUrl/urlSource（サーバーが再計算した値）を画面へ反映する。
 */
async function saveEventOverride({ eventId, titleInput, urlInput, msg }) {
  const title = titleInput.value.trim();
  const url = urlInput.value.trim();

  /* サーバー側の検証が本体だが、UX のため空でない不正 URL は先に弾く。 */
  if (url !== '' && !isHttpUrl(url)) {
    setOverrideMessage(msg, 'http:// か https:// で始まる URL を入れてください。', 'error');
    return;
  }

  const result = await apiFetch('./api/events/override', {
    method: 'PUT',
    body: { eventId, title, url },
  });

  if (result.networkError || !result.payload || result.payload.ok !== true) {
    /* UNAUTHORIZED なら未ログイン表示へ戻る（handleApiFailure が面倒を見る）。 */
    handleApiFailure(result, '設定を保存できませんでした。');
    return;
  }

  setMessage('通知の設定を保存しました。', 'success');
  await loadEvents();
}

async function loadEvents() {
  if (!state.loggedIn || !state.calendarConnected || state.tokenInvalid) {
    renderEventsList([]);
    return;
  }

  const result = await apiFetch('./api/events');

  if (result.networkError || !result.payload || result.payload.ok !== true) {
    renderEventsList([]);
    /* CALENDAR_ERROR は 200 ではなく 502 で返る（§7）。画面の他の部分は描画し続ける。 */
    handleApiFailure(result, ERROR_MESSAGES.CALENDAR_ERROR);
    return;
  }

  renderEventsList(result.payload.items ?? []);
}

/* ---------- 通知履歴 ---------- */

function renderHistoryList(items) {
  const list = el('pa-history-list');
  const empty = el('pa-history-empty');

  list.textContent = '';

  if (!Array.isArray(items) || items.length === 0) {
    empty.hidden = false;
    return;
  }

  empty.hidden = true;

  for (const item of items) {
    const li = document.createElement('li');
    li.className = 'pa-history-item';

    const when = document.createElement('p');
    when.className = 'pa-history-item__when';
    when.textContent = `${formatWhen(item.notifyAt)}　${item.title ?? ''}　${statusLabel(item.status)}`;
    li.appendChild(when);

    const urlPara = document.createElement('p');
    urlPara.className = 'pa-history-item__url';
    urlPara.appendChild(buildUrlNode(item.openUrl));
    li.appendChild(urlPara);

    list.appendChild(li);
  }
}

async function loadHistory() {
  if (!state.loggedIn) {
    renderHistoryList([]);
    return;
  }

  const result = await apiFetch('./api/notifications');

  if (result.networkError || !result.payload || result.payload.ok !== true) {
    renderHistoryList([]);
    return;
  }

  renderHistoryList(result.payload.items ?? []);
}

async function refreshLists() {
  await Promise.all([loadEvents(), loadHistory()]);
}

/* ---------- 起動 ---------- */

async function loadMe() {
  const result = await apiFetch('./api/me');

  if (result.networkError || !result.payload || result.payload.ok !== true) {
    setMessage('状態を取得できませんでした。時間をおいて開き直してください。', 'error');
    return;
  }

  const payload = result.payload;

  state = {
    loggedIn: payload.loggedIn === true,
    user: payload.user ?? null,
    calendarConnected: payload.calendarConnected === true,
    tokenInvalid: payload.tokenInvalid === true,
    settings: payload.settings ?? { notifyEnabled: true, leadMinutes: [10], notifyTitle: '', notifyBody: '' },
    vapidPublicKey: payload.vapidPublicKey ?? '',
    subscriptionCount: Number(payload.subscriptionCount ?? 0),
    leadOptions: Array.isArray(payload.leadOptions) ? payload.leadOptions : [],
  };

  if (state.tokenInvalid) {
    setMessage(ERROR_MESSAGES.TOKEN_INVALID, 'error');
  }

  renderCalendarSection();
  renderSettingsSection();
}

function bindEvents() {
  el('pa-disconnect').addEventListener('click', async () => {
    try {
      await disconnectCalendar();
    } catch {
      setMessage('切断できませんでした。', 'error');
    }
  });

  el('pa-save-settings').addEventListener('click', async () => {
    try {
      await saveSettings();
    } catch {
      setMessage('設定を保存できませんでした。', 'error');
    }
  });

  el('pa-request-permission').addEventListener('click', async () => {
    try {
      await subscribeThisDevice();
    } catch {
      setMessage('この端末を登録できませんでした。', 'error');
    }
  });

  el('pa-test-push').addEventListener('click', async () => {
    try {
      await sendTestPush();
    } catch {
      setMessage('テスト通知を送れませんでした。', 'error');
    }
  });
}

async function main() {
  bindEvents();
  handleQueryError();

  await loadMe();
  await renderPermissionSection();
  await refreshLists();
}

main().catch((error) => {
  console.error('[push-assistant]', error);
  setMessage('画面を読み込めませんでした。時間をおいて開き直してください。', 'error');
});

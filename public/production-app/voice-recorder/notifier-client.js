/*
 * GAS（gas-notifier）との通信ラッパー。
 *
 * ------------------------------------------------------------------
 * GAS の Web アプリに合わせた3つの決まり
 * ------------------------------------------------------------------
 *   1. POST は `Content-Type: text/plain` にする。
 *      application/json にするとプリフライト（OPTIONS）が飛び、
 *      Apps Script はそれに応答しないので必ず失敗する。
 *   2. `redirect: 'follow'` にする。Apps Script は
 *      script.googleusercontent.com への302を返す。
 *   3. 応答は常に JSON。`{ ok: true, data }` か
 *      `{ ok: false, error: { code, message } }` のどちらか。
 * ------------------------------------------------------------------
 *
 * 接続キーは health 以外のすべての要求に載せる。
 * **ログへ出さない。** 例外メッセージにも入れないこと。
 */

/* この通信で投げる唯一の例外。code で分岐し、message は開発者向け。 */
export class NotifierError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'NotifierError';
    this.code = code;
  }
}

export const NotifierErrorCode = Object.freeze({
  NOT_CONNECTED: 'NOT_CONNECTED',
  NETWORK: 'NETWORK',
  BAD_RESPONSE: 'BAD_RESPONSE',
  UNAUTHORIZED: 'UNAUTHORIZED',
  NOT_CONFIGURED: 'NOT_CONFIGURED',
  NOT_FOUND: 'NOT_FOUND',
  INVALID_REQUEST: 'INVALID_REQUEST',
  /* 契約が確認できない（ゲートが expired と答えた）。 */
  NO_LICENSE: 'NO_LICENSE',
  /* 通知サーバー（ゲート）へ届かない。利用者にできることは待つことだけ。 */
  GATE_ERROR: 'GATE_ERROR',
  SERVER: 'SERVER',
});

/* 画面へ出す文言。errors.js と同じく、例外の message は使わない。 */
const GUIDE = Object.freeze({
  [NotifierErrorCode.NOT_CONNECTED]:
    '通知の接続情報がありません。「通知をセットアップ」からやり直してください。',
  [NotifierErrorCode.NETWORK]:
    'GASへ接続できませんでした。URLとネットワーク接続を確認して、もう一度お試しください。',
  [NotifierErrorCode.BAD_RESPONSE]:
    'GASの応答を解釈できませんでした。ウェブアプリとして公開（デプロイ）されているか確認してください。',
  [NotifierErrorCode.UNAUTHORIZED]:
    '接続キーが一致しません。通知用シートのメニュー「録音通知」→「録音アプリへの引き継ぎリンクを表示」からやり直してください。',
  [NotifierErrorCode.NOT_CONFIGURED]:
    '通知用シート側のセットアップが完了していません。シートのサイドバーで［セットアップを実行］を行ってください。',
  [NotifierErrorCode.NOT_FOUND]:
    '対象の予定が見つかりませんでした。予定が変更または削除された可能性があります。',
  [NotifierErrorCode.INVALID_REQUEST]:
    '要求の形式が正しくありませんでした。ページを再読み込みして、もう一度お試しください。',
  [NotifierErrorCode.NO_LICENSE]:
    'ご契約が確認できないため、通知を停止しています。ご契約の状態をご確認ください。',
  [NotifierErrorCode.GATE_ERROR]:
    '通知サーバーへ接続できませんでした。時間をおいて、もう一度お試しください。',
  [NotifierErrorCode.SERVER]:
    'GAS側でエラーが発生しました。時間をおいて、もう一度お試しください。',
});

const FALLBACK = 'カレンダー通知の処理に失敗しました。お手数ですが、もう一度お試しください。';

export function describeNotifierError(error) {
  const code = error instanceof NotifierError ? error.code : null;
  return (code && GUIDE[code]) || FALLBACK;
}

/* GAS の error.code を、こちらのコードへ写す。知らないものは SERVER 扱い。 */
function toClientCode(serverCode) {
  switch (serverCode) {
    case 'UNAUTHORIZED':
      return NotifierErrorCode.UNAUTHORIZED;
    case 'NOT_CONFIGURED':
      return NotifierErrorCode.NOT_CONFIGURED;
    case 'NOT_FOUND':
      return NotifierErrorCode.NOT_FOUND;
    case 'INVALID_REQUEST':
      return NotifierErrorCode.INVALID_REQUEST;
    case 'NO_LICENSE':
      return NotifierErrorCode.NO_LICENSE;
    case 'GATE_ERROR':
      return NotifierErrorCode.GATE_ERROR;
    default:
      return NotifierErrorCode.SERVER;
  }
}

async function readPayload(response) {
  if (!response.ok) {
    throw new NotifierError(NotifierErrorCode.NETWORK, `HTTP ${response.status}`);
  }

  let payload = null;

  try {
    payload = await response.json();
  } catch {
    /*
     * Apps Script は、未公開・権限不足のときに HTML のログイン画面を返す。
     * その場合ここへ来る。「公開されているか」を疑うべき状態である。
     */
    throw new NotifierError(NotifierErrorCode.BAD_RESPONSE);
  }

  if (!payload || typeof payload !== 'object') {
    throw new NotifierError(NotifierErrorCode.BAD_RESPONSE);
  }

  if (payload.ok !== true) {
    throw new NotifierError(toClientCode(payload.error?.code));
  }

  return payload.data ?? {};
}

async function request(url, init) {
  let response = null;

  try {
    response = await fetch(url, init);
  } catch {
    throw new NotifierError(NotifierErrorCode.NETWORK);
  }

  return readPayload(response);
}

/* ---------- 低レベル ---------- */

export function gasGet(connection, action, params = {}) {
  if (!connection || !connection.url) {
    throw new NotifierError(NotifierErrorCode.NOT_CONNECTED);
  }

  const query = new URLSearchParams({ action, ...params });

  /* health だけは接続キーを載せない（URLの正しさだけを見るため）。 */
  if (action !== 'health') {
    query.set('key', connection.key ?? '');
  }

  return request(`${connection.url}?${query.toString()}`, {
    method: 'GET',
    redirect: 'follow',
  });
}

export function gasPost(connection, action, body = {}) {
  if (!connection || !connection.url) {
    throw new NotifierError(NotifierErrorCode.NOT_CONNECTED);
  }

  return request(connection.url, {
    method: 'POST',
    /* text/plain にする理由はファイル冒頭の1番。 */
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action, key: connection.key ?? '', ...body }),
    redirect: 'follow',
  });
}

/* ---------- action ごとの入口 ---------- */

export function fetchHealth(connection) {
  return gasGet(connection, 'health');
}

export async function fetchPublicKey(connection) {
  const data = await gasGet(connection, 'publicKey');

  if (typeof data.publicKey !== 'string' || data.publicKey === '') {
    throw new NotifierError(NotifierErrorCode.NOT_CONFIGURED);
  }

  return data.publicKey;
}

export async function fetchSettings(connection) {
  const data = await gasGet(connection, 'getSettings');
  return data.settings ?? null;
}

export async function saveSettings(connection, settings) {
  const data = await gasPost(connection, 'saveSettings', { settings });
  return data.settings ?? null;
}

export function saveSubscription(connection, subscription) {
  return gasPost(connection, 'saveSubscription', { subscription });
}

export async function fetchEvent(connection, eventId) {
  const data = await gasGet(connection, 'event', { id: eventId });
  return data.event ?? null;
}

/*
 * ライセンスキーを GAS へ預ける。
 *
 * 引き継ぎの向きは「録音アプリ → GAS」である。**すでに確立した接続越しに渡す。**
 * リンクへ載せる案を採らなかった理由は docs/notifier-design-notes.md §8。
 */
export function saveLicense(connection, licenseKey) {
  return gasPost(connection, 'saveLicense', { licenseKey });
}

/** 直近の通知予定。設定画面の「次に届く通知」に出す。 */
export async function fetchUpcoming(connection) {
  const data = await gasGet(connection, 'upcoming');
  return Array.isArray(data.upcoming) ? data.upcoming : [];
}

/** テスト通知を1件送らせる。回数の制限はゲート側にある（1日1回）。 */
export function sendTestNotification(connection) {
  return gasPost(connection, 'sendTestNotification');
}

/*
 * その場で同期させる。
 *
 * 設定を変えた直後に「次の同期まで最大5分」を待たせないための入口で、
 * 利用者に Apps Script のエディタを開かせないための正式な代替でもある。
 */
export function syncNow(connection) {
  return gasPost(connection, 'syncNow');
}

/** 接続キーを作り直す。**いま繋がっている端末以外は接続し直しになる。** */
export function regenerateConnectKey(connection) {
  return gasPost(connection, 'regenerateConnectKey');
}

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
  SERVER: 'SERVER',
});

/* 画面へ出す文言。errors.js と同じく、例外の message は使わない。 */
const GUIDE = Object.freeze({
  [NotifierErrorCode.NOT_CONNECTED]:
    'GASの接続情報がありません。セットアップ手順に従って接続コードを貼り付けてください。',
  [NotifierErrorCode.NETWORK]:
    'GASへ接続できませんでした。URLとネットワーク接続を確認して、もう一度お試しください。',
  [NotifierErrorCode.BAD_RESPONSE]:
    'GASの応答を解釈できませんでした。ウェブアプリとして公開（デプロイ）されているか確認してください。',
  [NotifierErrorCode.UNAUTHORIZED]:
    '接続キーが一致しません。スプレッドシートのメニュー「録音通知」→「接続コードを表示」で確認してください。',
  [NotifierErrorCode.NOT_CONFIGURED]:
    'GAS側のセットアップが完了していません。スプレッドシートで「セットアップを実行」を行ってください。',
  [NotifierErrorCode.NOT_FOUND]:
    '対象の予定が見つかりませんでした。予定が変更または削除された可能性があります。',
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

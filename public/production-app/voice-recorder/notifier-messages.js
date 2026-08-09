/*
 * 通知の文言と、通知から開くURLの組み立て。
 *
 * ------------------------------------------------------------------
 * すべて純関数にしてある
 * ------------------------------------------------------------------
 * ここに DOM も fetch も入れない。Service Worker と画面の両方から
 * 同じ結果が要る部分だけを集めてあり、Node の自動テストはここを見る
 * （SW と Push の実行は自動テストでは再現できない）。
 * ------------------------------------------------------------------
 *
 * ------------------------------------------------------------------
 * sw.js に複製がある
 * ------------------------------------------------------------------
 * sw.js は旧式の Service Worker で import が使えないため、
 * この中の通知本文の整形は sw.js 側にも書いてある。**片方だけ変えないこと。**
 * 対になっているのは sw.js の「notifier-messages.js からの複製」節。
 * ------------------------------------------------------------------
 */

/* 通知の内容を取得できなかったときの表示（userVisibleOnly の約束を守る）。 */
export const FALLBACK_TITLE = '予定の通知';
export const FALLBACK_BODY = '通知の内容を取得できませんでした。録音アプリを開いて確認してください。';

/* 時刻を HH:MM にする。端末のタイムゾーンで出す（予定は利用者の時間で読む）。 */
export function formatClock(value) {
  const date = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(date.getTime())) {
    return '';
  }

  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');

  return `${hours}:${minutes}`;
}

/*
 * 通知1件の表示内容（FR-15 / FR-16）。
 *   title = 予定名
 *   body  = 「10:00から開始します。録音しますか？」
 *
 * 開始時刻が読めないときは本文から時刻を落とす。
 * 「NaN:NaNから開始します」と出すよりは、時刻抜きのほうが読める。
 */
export function buildNotification(item) {
  const source = item && typeof item === 'object' ? item : {};
  const title = String(source.title ?? '').trim();
  const clock = formatClock(source.startTime);

  return {
    title: title === '' ? FALLBACK_TITLE : title,
    body: clock === ''
      ? 'まもなく開始します。録音しますか？'
      : `${clock}から開始します。録音しますか？`,
    tag: notificationTag(source.eventId, source.timing),
    eventId: String(source.eventId ?? ''),
  };
}

export function buildFallbackNotification() {
  return {
    title: FALLBACK_TITLE,
    body: FALLBACK_BODY,
    tag: 'tsam-vr-notifier-fallback',
    eventId: '',
  };
}

/*
 * 通知の tag。同じ予定・同じタイミングの通知を重ねて出さないための識別子。
 * timing まで含めるのは、設定を変えた直後に「5分前」と「10分前」が
 * 別々に届いても、それぞれ1件として残るようにするため。
 */
export function notificationTag(eventId, timing) {
  const id = String(eventId ?? '').trim();

  if (id === '') {
    return 'tsam-vr-notifier';
  }

  return `${id}|${timing ?? ''}`;
}

/*
 * 通知から開くURL（FR-17/18）。
 *
 * **パスを直書きしない。** 呼び出し側は Service Worker の
 * `self.registration.scope`（登録スコープの絶対URL）を渡す。
 * `/apps/` へ複製したときや、配信構成が変わったときに、
 * ここだけ古いパスを指したままにならないようにするため。
 */
export function buildEventUrl(scope, eventId) {
  const base = String(scope ?? '');
  const id = String(eventId ?? '').trim();

  if (id === '') {
    return base;
  }

  return `${base}?eventId=${encodeURIComponent(id)}`;
}

/* この録音アプリの窓かどうか。scope の下にあるURLだけを自分の窓とみなす。 */
export function isAppClientUrl(clientUrl, scope) {
  const url = String(clientUrl ?? '');
  const base = String(scope ?? '');

  return base !== '' && url.indexOf(base) === 0;
}

/*
 * 通知から開いたときに録音画面の上へ出す一行（要件書 5.3）。
 * 例: 「対象: 株式会社ABC 定例MTG（10:00開始）」
 */
export function formatEventBanner(event) {
  const source = event && typeof event === 'object' ? event : {};
  const title = String(source.title ?? '').trim();

  if (title === '') {
    return '';
  }

  const clock = formatClock(source.startTime);

  return clock === '' ? `対象: ${title}` : `対象: ${title}（${clock}開始）`;
}

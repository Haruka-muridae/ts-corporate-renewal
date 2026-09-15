/**
 * 通知テンプレートの本文・タイトル生成（仕様書 §8）。純関数だけ。
 *
 * ==================================================================
 * なぜ独立モジュールにするか
 * ==================================================================
 * 通知の文言は tick（実通知）と api（テスト通知のプレビュー）の両方で
 * 作る。同じ式を 2 か所に書くと、片方だけ直したときに「テストでは
 * こう見えたのに本番では違う」が起きる。ここに 1 つ置いて両方が import する。
 *
 * D1 も fetch も時計も触らない。startMs / leadMinutes を引数で受けるので、
 * 時刻と入力を並べた表で全パターンを試験できる。
 * ==================================================================
 *
 * ==================================================================
 * テンプレートと event_overrides の優先関係（呼び出し側の責任）
 * ==================================================================
 * renderNotification は「渡された template を event より優先する」だけの
 * 素直な関数にしてある。**予定ごとの上書き（event_overrides）を
 * テンプレートより優先させるのは呼び出し側（tick.mjs）の仕事**で、
 * 上書きタイトルがある予定では template.title を空にして渡す。
 * こうすると event.title（＝上書き反映済みの notifications.title）が使われる。
 * 本文テンプレートは常に当たり、`{url}` には上書き後の URL が入る。
 * ==================================================================
 */

import { MAX_NOTIFY_BODY_LENGTH, MAX_TITLE_LENGTH } from './constants.mjs';

/**
 * JST の HH:MM を返す。無効な時刻は空文字。
 *
 * ------------------------------------------------------------------
 * Intl を使わずに JST を出す
 * ------------------------------------------------------------------
 * Worker の時計は UTC。`toLocaleString('ja-JP', { timeZone })` は
 * ランタイムの ICU に依存し、テスト環境で挙動が変わりうる。
 * 日本標準時は夏時間が無く UTC+9 で固定なので、9 時間足して UTC として
 * 読むだけで正しい。**利用者のタイムゾーンは持っていないので JST 決め打ち。**
 * ------------------------------------------------------------------
 */
export function formatJstTime(startMs) {
  if (!Number.isFinite(startMs)) {
    return '';
  }

  const jst = new Date(startMs + 9 * 60 * 60 * 1000);
  const hh = String(jst.getUTCHours()).padStart(2, '0');
  const mm = String(jst.getUTCMinutes()).padStart(2, '0');

  return `${hh}:${mm}`;
}

/**
 * テンプレート未設定のときの既定本文（従来の buildBody 相当）。
 *
 * 「開始時刻ちょうど」（lead=0）は「HH:MM 開始」、それ以外は
 * 「HH:MM 開始（あと N 分）」。開始時刻が読めなければ時刻を出さない。
 */
export function buildDefaultBody({ startMs, leadMinutes }) {
  const lead = Number(leadMinutes) || 0;
  const time = formatJstTime(startMs);

  if (time === '') {
    return lead > 0 ? `まもなく開始（${lead}分前）` : 'まもなく開始';
  }

  return lead > 0 ? `${time} 開始（あと${lead}分）` : `${time} 開始`;
}

/**
 * 通知のタイトルと本文を作る。
 *
 * @param {{ template?: { title?: string, body?: string },
 *           event?: { title?: string, url?: string, startMs?: number, leadMinutes?: number } }} input
 * @returns {{ title: string, body: string }}
 *
 * title:
 *   template.title が非空 → それ（前後空白除去・MAX_TITLE_LENGTH で切る）
 *   空                    → event.title（呼び出し側が上書き反映済みで渡す。同じく切る）
 *
 * body:
 *   template.body が非空 → プレースホルダを置換して MAX_NOTIFY_BODY_LENGTH で切る
 *                          {url}   → event.url
 *                          {title} → event.title
 *                          {time}  → JST の HH:MM（無効な時刻は空文字）
 *                          未知の {xxx} はそのまま残す（単純置換）
 *   空                    → buildDefaultBody（従来の既定文）
 */
export function renderNotification({ template = {}, event = {} } = {}) {
  const templateTitle = String(template?.title ?? '').trim();
  const templateBody = String(template?.body ?? '');

  const eventTitle = String(event?.title ?? '');
  const eventUrl = String(event?.url ?? '');
  const startMs = Number(event?.startMs);
  const leadMinutes = Number(event?.leadMinutes) || 0;

  const title = (templateTitle !== '' ? templateTitle : eventTitle).slice(0, MAX_TITLE_LENGTH);

  let body;

  if (templateBody !== '') {
    body = templateBody
      .replaceAll('{url}', eventUrl)
      .replaceAll('{title}', eventTitle)
      .replaceAll('{time}', formatJstTime(startMs))
      .slice(0, MAX_NOTIFY_BODY_LENGTH);
  } else {
    body = buildDefaultBody({ startMs, leadMinutes });
  }

  return { title, body };
}

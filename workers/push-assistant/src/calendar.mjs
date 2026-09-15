/**
 * Google Calendar から予定を取り、扱いやすい形に直す（仕様書 §4-4）。
 *
 * ==================================================================
 * fields で絞る
 * ==================================================================
 * 予定 1 件の生の JSON は参加者・添付・リマインダ設定まで含み、
 * 50 件だと数百 KB になる。Workers の CPU 時間（Free で 10ms）を
 * JSON.parse に使い切りたくないので、`fields` で必要な項目だけを
 * 返させる。**受け取らないものは漏らしようがない**（notifier-gate の
 * 「送られても受け取らない」と同じ考え方）。
 * ==================================================================
 *
 * ==================================================================
 * 401 だけを他と区別する
 * ==================================================================
 * 401 は「アクセストークンが無効」であり、取り直せば直る一時的な失敗。
 * 500 や通信断（CALENDAR_ERROR）と同じ扱いにすると、tick は再取得を
 * 試みず、次の分まで待つことになる。呼び出し側が判断できるよう、
 * コードを分けて返す。
 * ==================================================================
 */

import {
  CALENDAR_EVENTS_ENDPOINT,
  CALENDAR_MAX_RESULTS,
  MAX_TITLE_LENGTH,
} from './constants.mjs';
import { extractUrls } from './open-url.mjs';

/** 取得する項目（仕様書 §4-4 のとおり）。 */
const FIELDS = 'items(id,status,summary,description,location,start,end,htmlLink,hangoutLink,'
  + 'conferenceData(entryPoints(entryPointType,uri))),nextPageToken';

/** 予定名が無いときの表示。通知のタイトルが空になるのを防ぐ。 */
const UNTITLED = '(タイトルなし)';

/**
 * 生の予定 1 件を正規化する（仕様書 §4-4 の出力）。
 *
 * 取り消された予定は null を返す（呼び出し側が捨てる）。
 * 例外を投げないのは、1 件の壊れた予定で全体を落とさないため。
 */
export function normalizeEvent(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || raw.id === '') {
    return null;
  }

  if (raw.status === 'cancelled') {
    return null;
  }

  const startDateTime = raw.start?.dateTime;
  const endDateTime = raw.end?.dateTime;

  /*
   * dateTime が無く date だけなら終日予定。
   *
   * 終日予定の start は「その日の 00:00（利用者のタイムゾーン）」だが、
   * ここではタイムゾーンを持っていない。**通知対象外（§8-2）なので
   * 時刻の精度は要らない**ため、UTC の 00:00 として ISO にするに留める。
   * 画面は allDay を見て「終日」と出す。
   */
  const allDay = typeof startDateTime !== 'string' && typeof raw.start?.date === 'string';

  const start = toIso(allDay ? `${raw.start.date}T00:00:00Z` : startDateTime);
  const end = toIso(allDay ? `${raw.end?.date ?? raw.start.date}T00:00:00Z` : endDateTime);

  if (start === null) {
    return null;
  }

  const description = typeof raw.description === 'string' ? raw.description : '';

  return {
    id: raw.id,
    title: String(raw.summary ?? '').trim().slice(0, MAX_TITLE_LENGTH) || UNTITLED,
    start,
    end: end ?? start,
    allDay,
    description,
    location: typeof raw.location === 'string' ? raw.location : '',
    conferenceUrl: pickConferenceUrl(raw),
    htmlLink: typeof raw.htmlLink === 'string' ? raw.htmlLink : '',
    urls: extractUrls(description),
  };
}

/**
 * 会議 URL を選ぶ。
 *
 * entryPoints には電話番号（`phone`）や `sip` も並ぶ。**`video` だけを採る**
 * （tel: を通知の行き先にすると、タップで発信画面が開いてしまう）。
 * conferenceData が無い古い予定のために hangoutLink も見る。
 */
function pickConferenceUrl(raw) {
  const entryPoints = raw?.conferenceData?.entryPoints;

  if (Array.isArray(entryPoints)) {
    const video = entryPoints.find(
      (entry) => entry?.entryPointType === 'video' && typeof entry?.uri === 'string' && entry.uri !== '',
    );

    if (video) {
      return video.uri;
    }
  }

  return typeof raw?.hangoutLink === 'string' && raw.hangoutLink !== '' ? raw.hangoutLink : null;
}

/** ISO 文字列へ寄せる。読めなければ null（呼び出し側が捨てる）。 */
function toIso(value) {
  if (typeof value !== 'string' || value === '') {
    return null;
  }

  const ms = Date.parse(value);

  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * 窓の中の予定を取る（1 ページのみ。仕様書 §4-4）。
 *
 * 戻り値は必ず `{ ok }` を持つ形にしてある。**例外を投げない。**
 * 呼び出し側（tick.mjs）は 1 人の失敗で他の利用者を巻き込まないことが
 * 要件（試験 I）であり、try/catch より戻り値で扱うほうが取りこぼしにくい。
 */
export async function listUpcomingEvents({
  accessToken,
  timeMinMs,
  timeMaxMs,
  maxResults = CALENDAR_MAX_RESULTS,
  fetchImpl = fetch,
}) {
  const params = new URLSearchParams({
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: String(maxResults),
    timeMin: new Date(timeMinMs).toISOString(),
    timeMax: new Date(timeMaxMs).toISOString(),
    fields: FIELDS,
  });

  let response;

  try {
    response = await fetchImpl(`${CALENDAR_EVENTS_ENDPOINT}?${params.toString()}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch {
    /* 例外の文面には URL やヘッダの断片が混ざりうる。転記しない。 */
    return { ok: false, code: 'CALENDAR_ERROR', status: 0 };
  }

  if (response.status === 401) {
    return { ok: false, code: 'UNAUTHENTICATED', status: 401 };
  }

  if (!response.ok) {
    /* 本文には予定の内容が載りうる。**状態コードだけを外へ出す。** */
    return { ok: false, code: 'CALENDAR_ERROR', status: response.status };
  }

  let payload;

  try {
    payload = await response.json();
  } catch {
    return { ok: false, code: 'CALENDAR_ERROR', status: response.status };
  }

  const events = [];

  for (const item of payload?.items ?? []) {
    const normalized = normalizeEvent(item);

    if (normalized !== null) {
      events.push(normalized);
    }
  }

  return { ok: true, events };
}

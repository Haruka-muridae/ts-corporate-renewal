/*
 * Googleカレンダーからの開催日取り込み（lib/event/calendar-sync.mjs）。
 *
 * ==================================================================
 * 特に確かめること
 * ==================================================================
 *   - 対象の予定だけを取り込むこと（部分一致や終日予定を巻き込まない）
 *   - 前後30分のバッファを当てた結果、開催時間が残らない予定を作らないこと
 *   - 手で登録した既存の行を引き取り、同じ開催日の行を二重に作らないこと
 *   - 予定が消えた回の受付を止めること。支払済みがあるなら警告を残すこと
 *   - 何度実行しても結果が変わらないこと（冪等）
 *   - Google側の障害で画面表示まで巻き添えにしないこと
 *   - 例外の文言にトークンや資格情報が出ないこと
 * ==================================================================
 */

import { readFileSync } from 'node:fs';

import { check, section, finish, fatal } from '../../public/apps/tests/helpers/assert.mjs';

import {
  claimCalendarSync,
  countPaidApplicationsByEventIds,
  findUnlinkedEventByDate,
  insertEvent,
  listPublishedUpcomingEvents,
  updateCalendarSyncStatus,
} from '../../lib/event/db.mjs';

import {
  CALENDAR_EVENT_TITLE,
  DEFAULT_CAPACITY,
  SETUP_BUFFER_MINUTES,
  SYNC_TTL_MINUTES,
  SYNC_WINDOW_MONTHS,
  applyBuffer,
  fetchCalendarOccurrences,
  syncCalendarEvents,
  syncIfStale,
} from '../../lib/event/calendar-sync.mjs';

/* 判定の基準になる現在時刻。テスト中は固定する。 */
const NOW = new Date('2026-08-01T09:00:00+09:00');
const NOW_ISO = NOW.toISOString();

/* 資格情報の偽物。例外の文言に出ていないことを確かめるのに使う。 */
const REFRESH_TOKEN = 'refresh-token-must-not-leak';
const CLIENT_SECRET = 'client-secret-must-not-leak';
const ACCESS_TOKEN = 'access-token-must-not-leak';

const CALENDAR = {
  calendarId: 'primary',
  credentials: {
    clientId: 'client-id',
    clientSecret: CLIENT_SECRET,
    refreshToken: REFRESH_TOKEN,
  },
};

/* 8/30 14:00〜16:30 の会場予約 → バッファ後は 14:30〜16:00。 */
const BOOKING_START = '2026-08-30T14:00:00+09:00';
const BOOKING_END = '2026-08-30T16:30:00+09:00';
const EVENT_START_ISO = '2026-08-30T05:30:00.000Z';
const EVENT_END_ISO = '2026-08-30T07:00:00.000Z';

/*
 * 主催者自身が作った予定。Google は「このカレンダーの持ち主が主催者」のときだけ
 * organizer.self を付ける（他人の予定・招待では付かない）。
 */
function calendarItem(overrides = {}) {
  return {
    id: 'gcal-1',
    status: 'confirmed',
    summary: CALENDAR_EVENT_TITLE,
    organizer: { self: true },
    creator: { self: true },
    eventType: 'default',
    start: { dateTime: BOOKING_START },
    end: { dateTime: BOOKING_END },
    ...overrides,
  };
}

function makeRow(overrides = {}) {
  return {
    id: 'ev-1',
    name: 'TSAMビジネス&フレンド交流会',
    description: '新たな出会いを求めている方のための交流会です。',
    venue: 'CAFE&BAR ZERA\n東京都渋谷区道玄坂1丁目17-4 道玄坂ビル4F',
    capacity: null,
    base_price: 11000,
    min_price: 3300,
    event_date: '2026-08-30T14:30:00+09:00',
    event_end_at: '2026-08-30T16:00:00+09:00',
    apply_start_at: '2026-08-01T00:00:00+09:00',
    apply_end_at: '2026-08-30T14:30:00+09:00',
    is_published: false,
    cancel_policy_text: '参加者ご都合によるキャンセル・返金は、一切お受けしておりません。',
    policy_version: '1.0',
    google_calendar_event_id: null,
    synced_at: null,
    sync_warning: null,
    sync_warning_at: null,
    ...overrides,
  };
}

/*
 * DBの偽物。
 * PostgREST の応答と同じく、行はコピーを返す（呼び出し側が直接書き換えても
 * 保存されない）。何が書き込まれたかは state.updates / state.inserted で見る。
 */
function createFakeDb({ events = [], paid = {}, lastSyncedAt = '1970-01-01T00:00:00.000Z' } = {}) {
  const state = {
    events: events.map((row) => ({ ...row })),
    paid: { ...paid },
    syncState: { key: 'calendar', last_synced_at: lastSyncedAt, last_status: '' },
    updates: [],
    inserted: [],
    unlinkedLookups: [],
    /* 1回目の insert だけ一意制約に当てたい場合に使う。 */
    insertRaces: 0,
    nextId: 1,
  };

  return {
    state,

    async listEventsForAdmin() {
      return state.events
        .map((row) => ({ ...row }))
        .sort((a, b) => Date.parse(b.event_date) - Date.parse(a.event_date));
    },

    async findEventByCalendarEventId(_config, googleEventId) {
      const row = state.events.find((e) => e.google_calendar_event_id === googleEventId);
      return row ? { ...row } : null;
    },

    async findUnlinkedEventByDate(_config, eventDateIso, eventEndAtIso) {
      state.unlinkedLookups.push({ eventDateIso, eventEndAtIso });

      const row = state.events.find(
        (e) => e.google_calendar_event_id === null
          && Date.parse(e.event_date) === Date.parse(eventDateIso)
          /* 終了も一致する行だけを引き取る（db.mjs 側の条件と合わせる）。 */
          && (eventEndAtIso === undefined || eventEndAtIso === null
            || Date.parse(e.event_end_at) === Date.parse(eventEndAtIso)),
      );

      return row ? { ...row } : null;
    },

    async insertEvent(_config, row) {
      if (state.insertRaces > 0) {
        /* 別の同期が先に作った状態を再現する（行はできている）。 */
        state.insertRaces -= 1;
        state.events.push({ ...makeRow(), ...row, id: `ev-race-${state.nextId += 1}` });
        return { row: null, duplicate: true };
      }

      const conflict = state.events.some(
        (e) => e.google_calendar_event_id !== null
          && e.google_calendar_event_id === row.google_calendar_event_id,
      );

      if (conflict) {
        return { row: null, duplicate: true };
      }

      const created = { ...makeRow(), ...row, id: `ev-new-${state.nextId += 1}` };
      state.events.push(created);
      state.inserted.push(row);
      return { row: { ...created }, duplicate: false };
    },

    async updateEvent(_config, eventId, patch) {
      const row = state.events.find((e) => e.id === eventId);
      state.updates.push({ id: eventId, patch });

      if (row) {
        Object.assign(row, patch);
      }

      return row ? { ...row } : null;
    },

    async countPaidApplications(_config, eventId) {
      return state.paid[eventId] ?? 0;
    },

    async claimCalendarSync(_config, { nowIso, ttlMinutes }) {
      const threshold = Date.parse(nowIso) - ttlMinutes * 60_000;

      if (Date.parse(state.syncState.last_synced_at) < threshold) {
        state.syncState.last_synced_at = nowIso;
        return true;
      }

      return false;
    },

    async updateCalendarSyncStatus(_config, { statusText }) {
      state.syncState.last_status = statusText;
      return { ...state.syncState };
    },
  };
}

/* fetch の偽物。トークン取得とカレンダー取得の2種類を返し分ける。 */
function createFakeFetch({
  pages = [[]],
  tokenStatus = 200,
  calendarStatus = 200,
  throwNetwork = false,
  /* 何ページ読んでも続きがある応答（一覧が切り詰められる状況の再現）。 */
  alwaysMore = false,
} = {}) {
  const calls = [];

  async function fetchImpl(url, options = {}) {
    const href = String(url);
    calls.push({ url: href, options });

    if (href.startsWith('https://oauth2.googleapis.com/token')) {
      if (tokenStatus !== 200) {
        /* 応答本文に資格情報が載っていても、外へ出てはいけない。 */
        return {
          ok: false,
          status: tokenStatus,
          json: async () => ({ error: 'invalid_grant', refresh_token: REFRESH_TOKEN }),
        };
      }

      return { ok: true, status: 200, json: async () => ({ access_token: ACCESS_TOKEN }) };
    }

    if (throwNetwork) {
      throw new Error('カレンダーに接続できませんでした');
    }

    if (calendarStatus !== 200) {
      return {
        ok: false,
        status: calendarStatus,
        json: async () => ({ error: { message: ACCESS_TOKEN } }),
      };
    }

    const pageToken = new URL(href).searchParams.get('pageToken');
    const index = pageToken === null ? 0 : Number(pageToken.replace('page-', ''));
    const items = pages[index] ?? [];
    const hasNext = alwaysMore || index + 1 < pages.length;

    return {
      ok: true,
      status: 200,
      json: async () => (hasNext ? { items, nextPageToken: `page-${index + 1}` } : { items }),
    };
  }

  return { calls, fetchImpl };
}

function calendarCalls(calls) {
  return calls.filter((call) => call.url.includes('/calendar/v3/'));
}

try {
  /* ---------------------------------------------------------------- */
  section('設営・撤収のバッファ');

  check('前後30分を落とす', SETUP_BUFFER_MINUTES === 30);

  const window = applyBuffer(BOOKING_START, BOOKING_END);

  check('開始を30分遅らせる', window.startAt === EVENT_START_ISO, window.startAt);
  check('終了を30分早める', window.endAt === EVENT_END_ISO, window.endAt);

  check('ちょうど60分の予約は開催時間が残らない',
    applyBuffer('2026-08-30T14:00:00+09:00', '2026-08-30T15:00:00+09:00') === null);
  check('60分未満も同じ',
    applyBuffer('2026-08-30T14:00:00+09:00', '2026-08-30T14:59:00+09:00') === null);

  const oneMinute = applyBuffer('2026-08-30T14:00:00+09:00', '2026-08-30T15:01:00+09:00');

  check('61分なら1分だけ残る',
    oneMinute.startAt === '2026-08-30T05:30:00.000Z'
      && oneMinute.endAt === '2026-08-30T05:31:00.000Z',
    JSON.stringify(oneMinute));

  check('開始と終了が逆でも null',
    applyBuffer('2026-08-30T16:30:00+09:00', '2026-08-30T14:00:00+09:00') === null);
  check('日時として読めなければ null', applyBuffer('あした', BOOKING_END) === null);

  const noBuffer = applyBuffer(BOOKING_START, BOOKING_END, 0);

  check('バッファ0分なら予定そのまま',
    noBuffer.startAt === '2026-08-30T05:00:00.000Z'
      && noBuffer.endAt === '2026-08-30T07:30:00.000Z',
    JSON.stringify(noBuffer));

  /* ---------------------------------------------------------------- */
  section('カレンダーからの取得');

  const titleFetch = createFakeFetch({
    pages: [[
      calendarItem({ id: 'gcal-exact' }),
      calendarItem({ id: 'gcal-partial', summary: `${CALENDAR_EVENT_TITLE}（仮）` }),
      calendarItem({ id: 'gcal-prefix', summary: `打合せ ${CALENDAR_EVENT_TITLE}` }),
      calendarItem({ id: 'gcal-space', summary: ` ${CALENDAR_EVENT_TITLE}` }),
      calendarItem({ id: 'gcal-trail', summary: `${CALENDAR_EVENT_TITLE} ` }),
      calendarItem({ id: 'gcal-other', summary: '歯医者' }),
      calendarItem({ id: 'gcal-empty', summary: undefined }),
    ]],
  });

  const titleResult = await fetchCalendarOccurrences({
    ...CALENDAR, fetchImpl: titleFetch.fetchImpl, now: NOW,
  });

  check('タイトルが完全一致する予定だけを取る',
    titleResult.occurrences.length === 1
      && titleResult.occurrences[0].id === 'gcal-exact',
    titleResult.occurrences.map((o) => o.id).join(','));

  const allDayFetch = createFakeFetch({
    pages: [[
      calendarItem({ id: 'gcal-allday', start: { date: '2026-08-30' }, end: { date: '2026-08-31' } }),
      calendarItem({ id: 'gcal-timed' }),
    ]],
  });

  const allDayResult = await fetchCalendarOccurrences({
    ...CALENDAR, fetchImpl: allDayFetch.fetchImpl, now: NOW,
  });

  check('終日予定は取り込まない（開催時間を決められないため）',
    allDayResult.occurrences.length === 1
      && allDayResult.occurrences[0].id === 'gcal-timed',
    allDayResult.occurrences.map((o) => o.id).join(','));

  const pagedFetch = createFakeFetch({
    pages: [
      [calendarItem({ id: 'gcal-p1' })],
      [calendarItem({ id: 'gcal-p2', start: { dateTime: '2026-09-13T14:00:00+09:00' },
        end: { dateTime: '2026-09-13T16:30:00+09:00' } })],
    ],
  });

  const pagedResult = await fetchCalendarOccurrences({
    ...CALENDAR, fetchImpl: pagedFetch.fetchImpl, now: NOW,
  });

  check('nextPageToken を追って2ページ目も読む',
    pagedResult.occurrences.map((o) => o.id).join(',') === 'gcal-p1,gcal-p2',
    pagedResult.occurrences.map((o) => o.id).join(','));
  check('2ページ目の要求に pageToken を付ける',
    calendarCalls(pagedFetch.calls)[1].url.includes('pageToken=page-1'),
    calendarCalls(pagedFetch.calls)[1]?.url);
  check('トークンの取得は1回だけ',
    pagedFetch.calls.filter((c) => c.url.includes('oauth2')).length === 1);

  const cancelledFetch = createFakeFetch({
    pages: [[
      calendarItem({ id: 'gcal-live' }),
      calendarItem({ id: 'gcal-deleted', status: 'cancelled' }),
      /* 削除済みは summary を返さないことがある。IDだけで拾えること。 */
      { id: 'gcal-deleted-bare', status: 'cancelled' },
    ]],
  });

  const cancelledResult = await fetchCalendarOccurrences({
    ...CALENDAR, fetchImpl: cancelledFetch.fetchImpl, now: NOW,
  });

  check('生きている予定だけを occurrences に入れる',
    cancelledResult.occurrences.length === 1
      && cancelledResult.occurrences[0].id === 'gcal-live');
  check('削除済みは cancelledIds に分ける',
    cancelledResult.cancelledIds.join(',') === 'gcal-deleted,gcal-deleted-bare',
    cancelledResult.cancelledIds.join(','));

  /*
   * 「生きているが取り込まなかった」IDの一覧。
   * 受付を止めてよいかの判断に使うため、理由に関わらず全部そろえる
   * （一覧に居る＝取得は成功している、という証拠になる）。
   */
  const unmatchedFetch = createFakeFetch({
    pages: [[
      calendarItem({ id: 'gcal-target' }),
      calendarItem({ id: 'gcal-renamed', summary: '（中止）渋谷CAFEご予約' }),
      calendarItem({ id: 'gcal-guest', organizer: { email: 'x@example.com' }, creator: undefined }),
      calendarItem({ id: 'gcal-birthday2', eventType: 'birthday' }),
      calendarItem({ id: 'gcal-allday2', start: { date: '2026-08-30' }, end: { date: '2026-08-31' } }),
      calendarItem({ id: 'gcal-dropped', status: 'cancelled' }),
    ]],
  });

  const unmatchedResult = await fetchCalendarOccurrences({
    ...CALENDAR, fetchImpl: unmatchedFetch.fetchImpl, now: NOW,
  });

  check('取り込んだ予定は unmatchedActiveIds に入れない',
    !unmatchedResult.unmatchedActiveIds.includes('gcal-target'),
    unmatchedResult.unmatchedActiveIds.join(','));
  check('改題された予定を unmatchedActiveIds に入れる',
    unmatchedResult.unmatchedActiveIds.includes('gcal-renamed'),
    unmatchedResult.unmatchedActiveIds.join(','));
  check('主催者が他人の予定も入れる',
    unmatchedResult.unmatchedActiveIds.includes('gcal-guest'));
  check('eventType で外した予定も入れる',
    unmatchedResult.unmatchedActiveIds.includes('gcal-birthday2'));
  check('終日に変わった予定も入れる',
    unmatchedResult.unmatchedActiveIds.includes('gcal-allday2'));
  check('削除済みは cancelledIds 側だけに入れる',
    !unmatchedResult.unmatchedActiveIds.includes('gcal-dropped')
      && unmatchedResult.cancelledIds.includes('gcal-dropped'));

  const paramCall = calendarCalls(titleFetch.calls)[0];
  const params = new URL(paramCall.url).searchParams;

  check('繰り返し予定を展開させる', params.get('singleEvents') === 'true');
  check('削除済みも返させる', params.get('showDeleted') === 'true');
  check('開始時刻順に並べさせる', params.get('orderBy') === 'startTime');
  /*
   * 1ページ50件だと、対象外の予定（打合せ・個人の予定）が多い月に
   * 一覧が途中で切れやすい。API の上限（250）まで引き上げてある。
   */
  check('1ページの件数はAPIの上限まで取る', params.get('maxResults') === '250',
    params.get('maxResults'));
  check('取得の開始は現在時刻', params.get('timeMin') === NOW_ISO, params.get('timeMin'));
  check(`取得の終わりは${SYNC_WINDOW_MONTHS}ヶ月先`,
    params.get('timeMax') === '2026-11-01T00:00:00.000Z', params.get('timeMax'));

  check('アクセストークンはヘッダーで渡す',
    paramCall.options.headers.Authorization === `Bearer ${ACCESS_TOKEN}`);
  check('URLにトークンを載せない', !paramCall.url.includes(ACCESS_TOKEN));
  check('応答が遅いときのために中断できるようにする',
    typeof paramCall.options.signal === 'object' && paramCall.options.signal !== null);

  const encodedFetch = createFakeFetch({ pages: [[]] });

  await fetchCalendarOccurrences({
    calendarId: 'shibuya+cafe@example.com',
    credentials: CALENDAR.credentials,
    fetchImpl: encodedFetch.fetchImpl,
    now: NOW,
  });

  check('カレンダーIDをURLに埋め込む前に符号化する',
    calendarCalls(encodedFetch.calls)[0].url.includes('shibuya%2Bcafe%40example.com'),
    calendarCalls(encodedFetch.calls)[0].url);

  /* ---------------------------------------------------------------- */
  section('主催者自身の予定だけを取り込む');

  /*
   * タイトルだけを条件にすると、第三者が同じ題名の予定を作ってこのカレンダーへ
   * 招待するだけで、公開中の開催回を1つ増やせてしまう。
   */
  const organizerFetch = createFakeFetch({
    pages: [[
      calendarItem({ id: 'gcal-own' }),
      /* 招待で届いた予定（Google は自分が主催でないとき self を付けない）。 */
      calendarItem({
        id: 'gcal-invited',
        organizer: { email: 'stranger@example.com' },
        creator: { email: 'stranger@example.com' },
      }),
      /* self: false が明示された予定も同じ扱い。 */
      calendarItem({ id: 'gcal-not-self', organizer: { self: false }, creator: { self: true } }),
      /* organizer を返さない応答は creator で判断する。 */
      calendarItem({ id: 'gcal-creator-only', organizer: undefined, creator: { self: true } }),
      /* どちらも self を持たない応答は取り込まない（安全側に倒す）。 */
      calendarItem({ id: 'gcal-unknown', organizer: undefined, creator: undefined }),
    ]],
  });

  const organizerResult = await fetchCalendarOccurrences({
    ...CALENDAR, fetchImpl: organizerFetch.fetchImpl, now: NOW,
  });

  check('招待で届いた予定は取り込まない',
    !organizerResult.occurrences.some((o) => o.id === 'gcal-invited'),
    organizerResult.occurrences.map((o) => o.id).join(','));
  check('organizer.self が false の予定も取り込まない',
    !organizerResult.occurrences.some((o) => o.id === 'gcal-not-self'));
  check('organizer が無ければ creator.self で判断する',
    organizerResult.occurrences.some((o) => o.id === 'gcal-creator-only'));
  check('どちらも分からない予定は取り込まない',
    !organizerResult.occurrences.some((o) => o.id === 'gcal-unknown'));
  check('主催者自身の予定は取り込む',
    organizerResult.occurrences.some((o) => o.id === 'gcal-own'));

  const eventTypeFetch = createFakeFetch({
    pages: [[
      calendarItem({ id: 'gcal-default' }),
      calendarItem({ id: 'gcal-birthday', eventType: 'birthday' }),
      calendarItem({ id: 'gcal-ooo', eventType: 'outOfOffice' }),
      calendarItem({ id: 'gcal-focus', eventType: 'focusTime' }),
      /* eventType を返さない応答は通常の予定として扱う。 */
      calendarItem({ id: 'gcal-no-type', eventType: undefined }),
    ]],
  });

  const eventTypeResult = await fetchCalendarOccurrences({
    ...CALENDAR, fetchImpl: eventTypeFetch.fetchImpl, now: NOW,
  });

  check('自動生成される予定（誕生日・不在・集中時間）は取り込まない',
    eventTypeResult.occurrences.map((o) => o.id).join(',') === 'gcal-default,gcal-no-type',
    eventTypeResult.occurrences.map((o) => o.id).join(','));

  /* ---------------------------------------------------------------- */
  section('一覧が切り詰められた場合');

  /*
   * 上限まで読んでもまだ続きがある応答。取れた分だけで突き合わせると、
   * 載らなかった回が「カレンダーに無い」と判定されて黙って止まる。
   */
  const truncatedFetch = createFakeFetch({
    pages: [[calendarItem()]],
    alwaysMore: true,
  });

  let truncatedError = null;

  try {
    await fetchCalendarOccurrences({
      ...CALENDAR, fetchImpl: truncatedFetch.fetchImpl, now: NOW,
    });
  } catch (error) {
    truncatedError = error;
  }

  check('続きが残っていたら例外にする',
    truncatedError?.message.includes('上限'), truncatedError?.message);
  check('上限の件数を文言に書く',
    truncatedError?.message.includes('2500'), truncatedError?.message);
  check('無限には読まない（ページ数の上限で止まる）',
    calendarCalls(truncatedFetch.calls).length === 10,
    calendarCalls(truncatedFetch.calls).length);

  /* 同期としては失敗になり、既存の行は書き換えない。 */
  const truncatedDb = createFakeDb({
    events: [makeRow({ id: 'ev-live', google_calendar_event_id: 'gcal-live', is_published: true })],
  });

  const truncatedSync = await syncIfStale({
    config: {}, calendar: CALENDAR, db: truncatedDb,
    fetchImpl: createFakeFetch({ pages: [[calendarItem()]], alwaysMore: true }).fetchImpl,
    now: NOW,
  });

  check('切り詰めは同期の失敗として扱う',
    truncatedSync.synced === false && truncatedSync.error?.includes('上限'),
    JSON.stringify(truncatedSync));
  check('切り詰めたときは受付を止めない',
    truncatedDb.state.events[0].is_published === true);
  check('切り詰めたときは行を書き換えない', truncatedDb.state.updates.length === 0);

  /* ---------------------------------------------------------------- */
  section('取得全体の制限時間');

  /*
   * ページごとに制限時間を掛けると、最悪 ページ数×制限時間 まで伸びる。
   * トークン交換と全ページを1つの signal で括っていることを確かめる。
   */
  const signalFetch = createFakeFetch({
    pages: [[calendarItem({ id: 'gcal-s1' })], [calendarItem({ id: 'gcal-s2' })]],
  });

  await fetchCalendarOccurrences({
    ...CALENDAR, fetchImpl: signalFetch.fetchImpl, now: NOW,
  });

  const tokenCall = signalFetch.calls.find((call) => call.url.includes('oauth2'));
  const pageCalls = calendarCalls(signalFetch.calls);

  check('トークン交換にも中断の手段を渡す',
    tokenCall.options.signal instanceof AbortSignal, typeof tokenCall.options.signal);
  check('トークン交換と全ページで同じ制限時間を共有する',
    pageCalls.every((call) => call.options.signal === tokenCall.options.signal),
    pageCalls.length);
  check('制限時間つきの signal である（呼び出し時点では中断されていない）',
    tokenCall.options.signal.aborted === false);

  /*
   * 何秒で切るかは AbortSignal から読めない。値そのものは実装から確かめる
   * （ページごとに5秒だと、10ページで最悪50秒画面を待たせていた）。
   */
  const syncSource = readFileSync(
    new URL('../../lib/event/calendar-sync.mjs', import.meta.url), 'utf8');

  check('取得全体の制限時間は8秒',
    /REQUEST_TIMEOUT_MS = 8000/.test(syncSource));
  check('ページごとに制限時間を作り直さない',
    (syncSource.match(/AbortSignal\.timeout\(/g) ?? []).length === 1,
    (syncSource.match(/AbortSignal\.timeout\(/g) ?? []).length);

  /* 差し替えられること（呼び出し側が全体の制限時間を決められる）。 */
  const injected = AbortSignal.timeout(60_000);
  const injectedFetch = createFakeFetch({ pages: [[calendarItem()]] });

  await fetchCalendarOccurrences({
    ...CALENDAR, fetchImpl: injectedFetch.fetchImpl, now: NOW, signal: injected,
  });

  check('渡された signal をそのまま使う',
    injectedFetch.calls.every((call) => call.options.signal === injected));

  /* ---------------------------------------------------------------- */
  section('取得の失敗');

  const failFetch = createFakeFetch({ calendarStatus: 503 });
  let fetchError = null;

  try {
    await fetchCalendarOccurrences({ ...CALENDAR, fetchImpl: failFetch.fetchImpl, now: NOW });
  } catch (error) {
    fetchError = error;
  }

  check('HTTPの状態コードは出す', fetchError?.message.includes('HTTP 503'), fetchError?.message);
  check('応答本文は出さない', !fetchError.message.includes(ACCESS_TOKEN), fetchError.message);

  const tokenFailFetch = createFakeFetch({ tokenStatus: 401 });
  let tokenError = null;

  try {
    await fetchCalendarOccurrences({ ...CALENDAR, fetchImpl: tokenFailFetch.fetchImpl, now: NOW });
  } catch (error) {
    tokenError = error;
  }

  check('トークン取得の失敗も状態コードだけ',
    tokenError?.message.includes('HTTP 401'), tokenError?.message);
  check('リフレッシュトークンを出さない',
    !tokenError.message.includes(REFRESH_TOKEN), tokenError.message);
  check('トークン取得に失敗したらカレンダーを叩かない',
    calendarCalls(tokenFailFetch.calls).length === 0);

  let credentialError = null;

  try {
    await fetchCalendarOccurrences({
      calendarId: 'primary',
      credentials: { clientId: '', clientSecret: '', refreshToken: '' },
      fetchImpl: createFakeFetch().fetchImpl,
      now: NOW,
    });
  } catch (error) {
    credentialError = error;
  }

  check('資格情報が無ければ通信する前に止める',
    credentialError instanceof TypeError, credentialError?.message);

  /* ---------------------------------------------------------------- */
  section('新しい回の取り込み');

  /* ひな型になる過去回（すでにカレンダーと紐づいている）。 */
  const templateRow = makeRow({
    id: 'ev-template',
    event_date: '2026-06-14T14:30:00+09:00',
    event_end_at: '2026-06-14T16:00:00+09:00',
    google_calendar_event_id: 'gcal-past',
    is_published: true,
  });

  const createDb = createFakeDb({ events: [templateRow] });
  const createFetch = createFakeFetch({ pages: [[calendarItem()]] });

  const createResult = await syncCalendarEvents({
    config: {}, calendar: CALENDAR, db: createDb, fetchImpl: createFetch.fetchImpl, now: NOW,
  });

  check('1件作る', createResult.created === 1, JSON.stringify(createResult));

  const inserted = createDb.state.inserted[0];

  check('開催日時はバッファ後の時間',
    inserted.event_date === EVENT_START_ISO && inserted.event_end_at === EVENT_END_ISO,
    JSON.stringify([inserted.event_date, inserted.event_end_at]));
  check('定員は既定の30名', inserted.capacity === DEFAULT_CAPACITY, inserted.capacity);
  check('受付は同期した時点から始める', inserted.apply_start_at === NOW_ISO);
  check('受付は開催開始で終える', inserted.apply_end_at === EVENT_START_ISO);
  check('公開状態で作る', inserted.is_published === true);
  check('カレンダー予定のIDを控える', inserted.google_calendar_event_id === 'gcal-1');
  check('同期した時刻を控える', inserted.synced_at === NOW_ISO);
  check('名称をひな型から複製する', inserted.name === templateRow.name);
  check('説明をひな型から複製する', inserted.description === templateRow.description);
  check('会場をひな型から複製する', inserted.venue === templateRow.venue);
  check('価格をひな型から複製する',
    inserted.base_price === 11000 && inserted.min_price === 3300);
  check('キャンセルポリシーをひな型から複製する',
    inserted.cancel_policy_text === templateRow.cancel_policy_text);
  check('ポリシーの版をひな型から複製する', inserted.policy_version === '1.0');
  check('過去のひな型行は受付を止めない',
    createResult.unpublished === 0, JSON.stringify(createResult));

  /* 2回目は何も変えない（冪等）。 */
  const rerun = await syncCalendarEvents({
    config: {}, calendar: CALENDAR, db: createDb,
    fetchImpl: createFakeFetch({ pages: [[calendarItem()]] }).fetchImpl, now: NOW,
  });

  check('同じ内容で再実行しても行は増えない',
    rerun.created === 0 && createDb.state.events.length === 2,
    JSON.stringify(rerun));
  check('同じ内容で再実行しても更新として数えない', rerun.updated === 0);
  check('同じ内容で再実行しても受付は止めない', rerun.unpublished === 0);

  const lastPatch = createDb.state.updates.at(-1).patch;

  check('再実行で書き換わるのは同期時刻だけ',
    Object.keys(lastPatch).join(',') === 'synced_at', Object.keys(lastPatch).join(','));

  /* ---------------------------------------------------------------- */
  section('ひな型が1行も無い場合');

  const emptyDb = createFakeDb({ events: [] });

  const emptyResult = await syncCalendarEvents({
    config: {}, calendar: CALENDAR, db: emptyDb,
    fetchImpl: createFakeFetch({ pages: [[calendarItem()]] }).fetchImpl, now: NOW,
  });

  check('中身の分からない行は作らない',
    emptyResult.created === 0 && emptyDb.state.events.length === 0);
  check('見送りとして数える', emptyResult.skipped === 1);
  check('気づけるように警告を残す',
    emptyResult.warnings[0]?.message.includes('ひな型'), JSON.stringify(emptyResult.warnings));

  /* ---------------------------------------------------------------- */
  section('手で登録した行の引き取り');

  /* 初回イベントの行（未リンク・非公開）と、同じ日時のカレンダー予定。 */
  const adoptDb = createFakeDb({ events: [makeRow({ id: 'ev-seed' })] });

  const adoptResult = await syncCalendarEvents({
    config: {}, calendar: CALENDAR, db: adoptDb,
    fetchImpl: createFakeFetch({ pages: [[calendarItem()]] }).fetchImpl, now: NOW,
  });

  check('同じ開催日の行を作り直さない',
    adoptResult.created === 0 && adoptDb.state.events.length === 1,
    JSON.stringify(adoptResult));
  check('既存の行にカレンダー予定のIDを付ける',
    adoptDb.state.events[0].google_calendar_event_id === 'gcal-1');
  check('カレンダーにあるので公開する', adoptDb.state.events[0].is_published === true);
  check('更新として数える', adoptResult.updated === 1);

  /* ---------------------------------------------------------------- */
  section('開催日時の変更');

  const movedItem = calendarItem({
    start: { dateTime: '2026-08-30T15:00:00+09:00' },
    end: { dateTime: '2026-08-30T17:30:00+09:00' },
  });

  const movedDb = createFakeDb({
    events: [makeRow({ id: 'ev-linked', google_calendar_event_id: 'gcal-1', is_published: true })],
    paid: { 'ev-linked': 2 },
  });

  const movedResult = await syncCalendarEvents({
    config: {}, calendar: CALENDAR, db: movedDb,
    fetchImpl: createFakeFetch({ pages: [[movedItem]] }).fetchImpl, now: NOW,
  });

  const movedRow = movedDb.state.events[0];

  check('開催日時を上書きする',
    movedRow.event_date === '2026-08-30T06:30:00.000Z'
      && movedRow.event_end_at === '2026-08-30T08:00:00.000Z',
    JSON.stringify([movedRow.event_date, movedRow.event_end_at]));
  check('受付の締めも新しい開始に合わせる',
    movedRow.apply_end_at === '2026-08-30T06:30:00.000Z', movedRow.apply_end_at);
  check('更新として数える', movedResult.updated === 1);

  check('支払済みがあるので警告を残す',
    typeof movedRow.sync_warning === 'string' && movedRow.sync_warning !== '',
    movedRow.sync_warning);
  check('警告に旧い日時を日本語で書く',
    movedRow.sync_warning.includes('2026年8月30日（日）14:30〜16:00'), movedRow.sync_warning);
  check('警告に新しい日時を日本語で書く',
    movedRow.sync_warning.includes('2026年8月30日（日）15:30〜17:00'), movedRow.sync_warning);
  check('警告に支払済みの件数を書く',
    movedRow.sync_warning.includes('2件'), movedRow.sync_warning);
  check('警告の時刻を控える', movedRow.sync_warning_at === NOW_ISO);
  check('戻り値でも警告を返す',
    movedResult.warnings.length === 1 && movedResult.warnings[0].eventId === 'ev-linked',
    JSON.stringify(movedResult.warnings));

  const quietDb = createFakeDb({
    events: [makeRow({ id: 'ev-linked', google_calendar_event_id: 'gcal-1', is_published: true })],
  });

  const quietResult = await syncCalendarEvents({
    config: {}, calendar: CALENDAR, db: quietDb,
    fetchImpl: createFakeFetch({ pages: [[movedItem]] }).fetchImpl, now: NOW,
  });

  check('支払済みが無ければ日時を変えても警告しない',
    quietDb.state.events[0].sync_warning === null && quietResult.warnings.length === 0,
    JSON.stringify(quietResult.warnings));
  check('警告は無くても更新はする', quietResult.updated === 1);

  /* ---------------------------------------------------------------- */
  section('予定が消えた回');

  /*
   * 「消えた回」を止めるのは、対象の予定が取れている（＝一覧が信用できる）
   * ときだけ。ここでは生きている回（gcal-1 → ev-live）を1件混ぜてある。
   * 1件も取れなかった場合の扱いは後段の「安全弁」を参照。
   */
  const goneDb = createFakeDb({
    events: [
      makeRow({ id: 'ev-live', google_calendar_event_id: 'gcal-1', is_published: true }),
      makeRow({ id: 'ev-gone', google_calendar_event_id: 'gcal-gone', is_published: true }),
      makeRow({
        id: 'ev-manual',
        event_date: '2026-09-13T14:30:00+09:00',
        event_end_at: '2026-09-13T16:00:00+09:00',
        apply_end_at: '2026-09-13T14:30:00+09:00',
        is_published: true,
      }),
      makeRow({
        id: 'ev-past',
        event_date: '2026-06-14T14:30:00+09:00',
        event_end_at: '2026-06-14T16:00:00+09:00',
        apply_end_at: '2026-06-14T14:30:00+09:00',
        google_calendar_event_id: 'gcal-past',
        is_published: true,
      }),
    ],
    paid: { 'ev-gone': 3 },
  });

  const goneResult = await syncCalendarEvents({
    config: {}, calendar: CALENDAR, db: goneDb,
    fetchImpl: createFakeFetch({ pages: [[calendarItem()]] }).fetchImpl, now: NOW,
  });

  const goneRow = goneDb.state.events.find((e) => e.id === 'ev-gone');

  check('カレンダーに無い回の受付を止める', goneRow.is_published === false);
  check('カレンダーにある回はそのまま',
    goneDb.state.events.find((e) => e.id === 'ev-live').is_published === true);
  check('行そのものは消さない', goneDb.state.events.length === 4);
  check('止めた件数を返す', goneResult.unpublished === 1, JSON.stringify(goneResult));
  check('支払済みがあるので警告を残す',
    goneRow.sync_warning?.includes('3件'), goneRow.sync_warning);
  check('手で登録した行（未リンク）は止めない',
    goneDb.state.events.find((e) => e.id === 'ev-manual').is_published === true);
  check('過去回は触らない',
    goneDb.state.events.find((e) => e.id === 'ev-past').is_published === true);

  /*
   * 「次回開催が1回だけ」がこの交流会の通常状態。その1件を消した・改題した
   * ときに受付が止まらなければ、カレンダーが真実源という中核要件が
   * 最も多い場面で機能しない。取り込み対象が0件でも止まること。
   */
  const cancelledDb = createFakeDb({
    events: [makeRow({ id: 'ev-cancel', google_calendar_event_id: 'gcal-1', is_published: true })],
    paid: { 'ev-cancel': 1 },
  });

  const cancelledOnlyResult = await syncCalendarEvents({
    config: {}, calendar: CALENDAR, db: cancelledDb,
    fetchImpl: createFakeFetch({
      pages: [[calendarItem({ status: 'cancelled' })]],
    }).fetchImpl,
    now: NOW,
  });

  check('公開中の回が1件だけでも、削除されたら受付を止める',
    cancelledDb.state.events[0].is_published === false,
    JSON.stringify(cancelledOnlyResult));
  check('削除の証拠があるので見送りにはしない',
    cancelledOnlyResult.unpublished === 1 && cancelledOnlyResult.unpublishSkipped === 0,
    JSON.stringify(cancelledOnlyResult));
  check('削除だと分かる文言にする',
    cancelledDb.state.events[0].sync_warning?.includes('削除'),
    cancelledDb.state.events[0].sync_warning);

  const renamedDb = createFakeDb({
    events: [makeRow({ id: 'ev-renamed', google_calendar_event_id: 'gcal-1', is_published: true })],
  });

  const renamedResult = await syncCalendarEvents({
    config: {}, calendar: CALENDAR, db: renamedDb,
    fetchImpl: createFakeFetch({
      pages: [[calendarItem({ summary: '（中止）渋谷CAFEご予約' })]],
    }).fetchImpl,
    now: NOW,
  });

  check('公開中の回が1件だけでも、改題されたら受付を止める',
    renamedDb.state.events[0].is_published === false && renamedResult.unpublished === 1,
    JSON.stringify(renamedResult));
  check('改題の証拠があるので見送りにはしない',
    renamedResult.unpublishSkipped === 0, JSON.stringify(renamedResult));

  /* 主催者の条件から外れた場合（招待に置き換わった等）も同じ扱い。 */
  const disownedDb = createFakeDb({
    events: [makeRow({ id: 'ev-disowned', google_calendar_event_id: 'gcal-1', is_published: true })],
  });

  const disownedResult = await syncCalendarEvents({
    config: {}, calendar: CALENDAR, db: disownedDb,
    fetchImpl: createFakeFetch({
      pages: [[calendarItem({ organizer: { email: 'stranger@example.com' }, creator: undefined })]],
    }).fetchImpl,
    now: NOW,
  });

  check('主催者の条件から外れた予定でも受付を止める',
    disownedDb.state.events[0].is_published === false
      && disownedResult.unpublished === 1,
    JSON.stringify(disownedResult));

  /* 題名を戻せば、IDで再び紐づいて公開に戻る。 */
  const restoredResult = await syncCalendarEvents({
    config: {}, calendar: CALENDAR, db: renamedDb,
    fetchImpl: createFakeFetch({ pages: [[calendarItem()]] }).fetchImpl,
    now: NOW,
  });

  check('題名を戻せば再び公開になる',
    renamedDb.state.events[0].is_published === true && restoredResult.updated === 1);
  check('解消した警告は消す', renamedDb.state.events[0].sync_warning === null);

  /* ---------------------------------------------------------------- */
  section('予定の痕跡が消えた場合（安全弁）');

  /*
   * カレンダー側の障害・権限の変更・カレンダーIDの取り違えでも、
   * 応答は「予定0件」になりうる。予定のIDがフィードのどこにも現れず
   * （削除の証拠すら無く）、取り込み対象も0件のときだけ、受付を止めない。
   */
  const emptyCalendarDb = createFakeDb({
    events: [
      makeRow({ id: 'ev-a', google_calendar_event_id: 'gcal-a', is_published: true }),
      makeRow({
        id: 'ev-b',
        event_date: '2026-09-13T14:30:00+09:00',
        event_end_at: '2026-09-13T16:00:00+09:00',
        apply_end_at: '2026-09-13T14:30:00+09:00',
        google_calendar_event_id: 'gcal-b',
        is_published: true,
      }),
    ],
    paid: { 'ev-a': 2 },
  });

  const emptyCalendarResult = await syncCalendarEvents({
    config: {}, calendar: CALENDAR, db: emptyCalendarDb,
    fetchImpl: createFakeFetch({ pages: [[]] }).fetchImpl, now: NOW,
  });

  check('取得0件のときは公開中の回を止めない',
    emptyCalendarDb.state.events.every((e) => e.is_published === true),
    JSON.stringify(emptyCalendarDb.state.events.map((e) => e.is_published)));
  check('止めなかった件数を返す',
    emptyCalendarResult.unpublished === 0 && emptyCalendarResult.unpublishSkipped === 2,
    JSON.stringify(emptyCalendarResult));
  check('行を書き換えない', emptyCalendarDb.state.updates.length === 0);

  const heldBackDb = createFakeDb({
    events: [makeRow({ id: 'ev-a', google_calendar_event_id: 'gcal-a', is_published: true })],
    lastSyncedAt: new Date(NOW.getTime() - 20 * 60_000).toISOString(),
  });

  await syncIfStale({
    config: {}, calendar: CALENDAR, db: heldBackDb,
    fetchImpl: createFakeFetch({ pages: [[]] }).fetchImpl, now: NOW,
  });

  check('見送ったことを記録に残す（管理画面で気づけるように）',
    heldBackDb.state.syncState.last_status.includes('見送りました'),
    heldBackDb.state.syncState.last_status);
  check('カレンダー側の異常を疑う文言にする',
    heldBackDb.state.syncState.last_status.includes('要確認'),
    heldBackDb.state.syncState.last_status);

  /* 止める候補が無ければ、0件でも普通の成功として扱う。 */
  const emptyBothDb = createFakeDb({
    events: [makeRow({ id: 'ev-off', google_calendar_event_id: 'gcal-a', is_published: false })],
  });

  const emptyBoth = await syncCalendarEvents({
    config: {}, calendar: CALENDAR, db: emptyBothDb,
    fetchImpl: createFakeFetch({ pages: [[]] }).fetchImpl, now: NOW,
  });

  check('止める候補が無ければ見送りにはならない',
    emptyBoth.unpublishSkipped === 0, JSON.stringify(emptyBoth));

  /*
   * 対象外の予定しか返らない応答（他人の予定・別の打合せだけが残っている）。
   * 一覧そのものは届いているが、こちらの回のIDは現れていない。
   * この場合も「痕跡なし」として扱い、止めない。
   */
  const otherOnlyDb = createFakeDb({
    events: [makeRow({ id: 'ev-a', google_calendar_event_id: 'gcal-a', is_published: true })],
  });

  const otherOnly = await syncCalendarEvents({
    config: {}, calendar: CALENDAR, db: otherOnlyDb,
    fetchImpl: createFakeFetch({
      pages: [[calendarItem({ id: 'gcal-meeting', summary: '打合せ' })]],
    }).fetchImpl,
    now: NOW,
  });

  check('別の予定が対象外で返ってきても、自分の回の証拠にはしない',
    otherOnlyDb.state.events[0].is_published === true
      && otherOnly.unpublishSkipped === 1,
    JSON.stringify(otherOnly));

  /*
   * 証拠のある回と痕跡の無い回が混ざった場合。証拠のある回だけを止め、
   * もう一方は見送る（1回の同期で両方を正しく扱えること）。
   */
  const mixedDb = createFakeDb({
    events: [
      makeRow({ id: 'ev-deleted', google_calendar_event_id: 'gcal-1', is_published: true }),
      makeRow({
        id: 'ev-trace-less',
        event_date: '2026-09-13T14:30:00+09:00',
        event_end_at: '2026-09-13T16:00:00+09:00',
        apply_end_at: '2026-09-13T14:30:00+09:00',
        google_calendar_event_id: 'gcal-gone',
        is_published: true,
      }),
    ],
  });

  const mixedResult = await syncCalendarEvents({
    config: {}, calendar: CALENDAR, db: mixedDb,
    fetchImpl: createFakeFetch({
      pages: [[calendarItem({ status: 'cancelled' })]],
    }).fetchImpl,
    now: NOW,
  });

  check('削除された回だけを止める',
    mixedDb.state.events.find((e) => e.id === 'ev-deleted').is_published === false,
    JSON.stringify(mixedResult));
  check('痕跡の無い回は残す',
    mixedDb.state.events.find((e) => e.id === 'ev-trace-less').is_published === true);
  check('止めた件数と見送った件数を分けて返す',
    mixedResult.unpublished === 1 && mixedResult.unpublishSkipped === 1,
    JSON.stringify(mixedResult));

  /* ---------------------------------------------------------------- */
  section('取り込まない予定');

  const shortDb = createFakeDb({
    events: [makeRow({ id: 'ev-short', google_calendar_event_id: 'gcal-1', is_published: true })],
  });

  const shortResult = await syncCalendarEvents({
    config: {}, calendar: CALENDAR, db: shortDb,
    fetchImpl: createFakeFetch({
      pages: [[calendarItem({
        start: { dateTime: '2026-08-30T14:00:00+09:00' },
        end: { dateTime: '2026-08-30T15:00:00+09:00' },
      })]],
    }).fetchImpl,
    now: NOW,
  });

  check('60分の予約は見送る', shortResult.skipped === 1, JSON.stringify(shortResult));
  check('見送った予定で既存の受付を止めない',
    shortDb.state.events[0].is_published === true && shortResult.unpublished === 0);

  /* すでに始まっている予定は、受付期間を作れないので新規には取り込まない。 */
  const ongoingDb = createFakeDb({ events: [makeRow({ id: 'ev-template', google_calendar_event_id: 'gcal-past' })] });

  const ongoingResult = await syncCalendarEvents({
    config: {}, calendar: CALENDAR, db: ongoingDb,
    fetchImpl: createFakeFetch({ pages: [[calendarItem({ id: 'gcal-now' })]] }).fetchImpl,
    now: new Date('2026-08-30T15:00:00+09:00'),
  });

  check('開催開始が過ぎている予定は新規に作らない',
    ongoingResult.created === 0 && ongoingResult.skipped === 1,
    JSON.stringify(ongoingResult));

  /* ---------------------------------------------------------------- */
  section('同時に2本走った場合');

  const raceDb = createFakeDb({ events: [templateRow] });
  raceDb.state.insertRaces = 1;

  const raceResult = await syncCalendarEvents({
    config: {}, calendar: CALENDAR, db: raceDb,
    fetchImpl: createFakeFetch({ pages: [[calendarItem()]] }).fetchImpl, now: NOW,
  });

  check('一意制約に当たっても例外にしない', raceResult.created === 0);
  check('行は二重にならない', raceDb.state.events.length === 2, raceDb.state.events.length);
  check('先に作られた行を取り直して更新する',
    raceDb.state.updates.length === 1
      && raceDb.state.updates[0].id.startsWith('ev-race-'),
    JSON.stringify(raceDb.state.updates));

  /* ---------------------------------------------------------------- */
  section('同期の間引き（TTL）');

  check('間隔は10分', SYNC_TTL_MINUTES === 10);

  const freshDb = createFakeDb({
    events: [templateRow],
    /* 1分前に同期済み。 */
    lastSyncedAt: new Date(NOW.getTime() - 60_000).toISOString(),
  });

  const freshFetch = createFakeFetch({ pages: [[calendarItem()]] });

  const freshResult = await syncIfStale({
    config: {}, calendar: CALENDAR, db: freshDb, fetchImpl: freshFetch.fetchImpl, now: NOW,
  });

  check('TTL内なら実行しない', freshResult.skipped === true && freshResult.synced === false);
  check('TTL内ならGoogleを叩かない', freshFetch.calls.length === 0, freshFetch.calls.length);
  check('TTL内なら行も作らない', freshDb.state.events.length === 1);

  const staleDb = createFakeDb({
    events: [templateRow],
    lastSyncedAt: new Date(NOW.getTime() - 20 * 60_000).toISOString(),
  });

  const staleResult = await syncIfStale({
    config: {}, calendar: CALENDAR, db: staleDb,
    fetchImpl: createFakeFetch({ pages: [[calendarItem()]] }).fetchImpl, now: NOW,
  });

  check('TTLを過ぎていれば実行する',
    staleResult.synced === true && staleResult.result.created === 1,
    JSON.stringify(staleResult));
  check('実行時刻を控える（次のTTLの起点）',
    staleDb.state.syncState.last_synced_at === NOW_ISO);
  check('結果を記録する',
    staleDb.state.syncState.last_status.startsWith('成功'),
    staleDb.state.syncState.last_status);

  /* ---------------------------------------------------------------- */
  section('同期が失敗した場合');

  const brokenDb = createFakeDb({ events: [templateRow] });

  const brokenResult = await syncIfStale({
    config: {}, calendar: CALENDAR, db: brokenDb,
    fetchImpl: createFakeFetch({ throwNetwork: true }).fetchImpl, now: NOW,
  });

  check('例外を外に出さない', brokenResult.synced === false && brokenResult.error !== null,
    JSON.stringify(brokenResult));
  check('失敗を記録する',
    brokenDb.state.syncState.last_status.startsWith('失敗'),
    brokenDb.state.syncState.last_status);
  check('失敗しても既存の行は残る', brokenDb.state.events.length === 1);

  const authFailDb = createFakeDb({ events: [templateRow] });

  const authFail = await syncIfStale({
    config: {}, calendar: CALENDAR, db: authFailDb,
    fetchImpl: createFakeFetch({ tokenStatus: 401 }).fetchImpl, now: NOW,
  });

  check('トークン失効の状態コードは残す', authFail.error.includes('HTTP 401'), authFail.error);
  check('記録にトークンを書かない',
    !authFailDb.state.syncState.last_status.includes(REFRESH_TOKEN)
      && !authFailDb.state.syncState.last_status.includes(CLIENT_SECRET)
      && !authFailDb.state.syncState.last_status.includes(ACCESS_TOKEN),
    authFailDb.state.syncState.last_status);
  check('戻り値にもトークンを書かない',
    !authFail.error.includes(REFRESH_TOKEN) && !authFail.error.includes(CLIENT_SECRET));

  const claimBrokenDb = createFakeDb({ events: [templateRow] });
  claimBrokenDb.claimCalendarSync = async () => {
    throw new Error('データベース操作に失敗しました（HTTP 500）');
  };

  const claimBrokenFetch = createFakeFetch({ pages: [[calendarItem()]] });

  const claimBroken = await syncIfStale({
    config: {}, calendar: CALENDAR, db: claimBrokenDb,
    fetchImpl: claimBrokenFetch.fetchImpl, now: NOW,
  });

  check('実行権の取得に失敗しても例外にしない',
    claimBroken.skipped === true && claimBroken.synced === false);
  check('DBが不調ならGoogleも叩かない', claimBrokenFetch.calls.length === 0);

  const statusBrokenDb = createFakeDb({ events: [templateRow] });
  statusBrokenDb.updateCalendarSyncStatus = async () => {
    throw new Error('データベース操作に失敗しました（HTTP 500）');
  };

  const statusBroken = await syncIfStale({
    config: {}, calendar: CALENDAR, db: statusBrokenDb,
    fetchImpl: createFakeFetch({ pages: [[calendarItem()]] }).fetchImpl, now: NOW,
  });

  check('結果の記録に失敗しても同期は成功として返す',
    statusBroken.synced === true && statusBroken.result.created === 1,
    JSON.stringify(statusBroken));

  /* ---------------------------------------------------------------- */
  section('PostgRESTへの問い合わせ（lib/event/db.mjs）');

  /*
   * 実行権の判定はSQL1文（条件付き更新）に委ねている。条件の書き方を
   * 間違えると、ロックとして機能しないまま常に成功してしまう。
   * 組み立てた問い合わせそのものを確かめる。
   */
  function createRestFetch(responses) {
    const calls = [];
    let index = 0;

    async function fetchImpl(url, options = {}) {
      calls.push({ url: String(url), options });
      const response = responses[Math.min(index, responses.length - 1)];
      index += 1;

      return {
        ok: response.status < 400,
        status: response.status,
        json: async () => response.body,
      };
    }

    return { calls, fetchImpl };
  }

  const claimFetch = createRestFetch([{ status: 200, body: [{ key: 'calendar' }] }]);

  const claimed = await claimCalendarSync(
    { url: 'https://example.supabase.co', serviceRoleKey: 'k', fetchImpl: claimFetch.fetchImpl },
    { nowIso: NOW_ISO, ttlMinutes: SYNC_TTL_MINUTES },
  );

  const claimUrl = decodeURIComponent(claimFetch.calls[0].url);

  check('実行権は条件付き更新で取る', claimFetch.calls[0].options.method === 'PATCH');
  check('対象は calendar の1行', claimUrl.includes('key=eq.calendar'));
  check('TTLより古い行だけを更新する',
    claimUrl.includes(`last_synced_at=lt.${new Date(NOW.getTime() - SYNC_TTL_MINUTES * 60_000).toISOString()}`),
    claimUrl);
  check('更新した行を返させる（0件ならロックを取れていない）',
    claimFetch.calls[0].options.headers.Prefer === 'return=representation');
  check('最終同期時刻を現在時刻にする',
    JSON.parse(claimFetch.calls[0].options.body).last_synced_at === NOW_ISO);
  check('1行返れば実行権あり', claimed === true);

  const emptyClaimFetch = createRestFetch([{ status: 200, body: [] }]);

  check('0行なら実行権なし',
    (await claimCalendarSync(
      { url: 'https://example.supabase.co', serviceRoleKey: 'k', fetchImpl: emptyClaimFetch.fetchImpl },
      { nowIso: NOW_ISO, ttlMinutes: SYNC_TTL_MINUTES },
    )) === false);

  const conflictFetch = createRestFetch([{ status: 409, body: { code: '23505' } }]);

  const conflict = await insertEvent(
    { url: 'https://example.supabase.co', serviceRoleKey: 'k', fetchImpl: conflictFetch.fetchImpl },
    { google_calendar_event_id: 'gcal-1' },
  );

  check('一意制約違反（409）は例外にせず duplicate で返す',
    conflict.duplicate === true && conflict.row === null);

  const codeFetch = createRestFetch([{ status: 400, body: { code: '23505', message: 'duplicate key' } }]);

  const byCode = await insertEvent(
    { url: 'https://example.supabase.co', serviceRoleKey: 'k', fetchImpl: codeFetch.fetchImpl },
    { google_calendar_event_id: 'gcal-1' },
  );

  check('409以外でも 23505 なら duplicate で返す', byCode.duplicate === true);

  const errorFetch = createRestFetch([{ status: 400, body: { code: '23514', message: '違反' } }]);
  const SERVICE_KEY = 'service-role-key-must-not-leak';
  let insertError = null;

  try {
    await insertEvent(
      {
        url: 'https://example.supabase.co',
        serviceRoleKey: SERVICE_KEY,
        fetchImpl: errorFetch.fetchImpl,
      },
      { google_calendar_event_id: 'gcal-1' },
    );
  } catch (error) {
    insertError = error;
  }

  check('ほかの失敗は例外にする', insertError?.message.includes('HTTP 400'), insertError?.message);
  check('例外にサービスロールキーを含めない',
    !insertError.message.includes(SERVICE_KEY), insertError.message);

  const listFetch = createRestFetch([{ status: 200, body: [] }]);

  await listPublishedUpcomingEvents(
    { url: 'https://example.supabase.co', serviceRoleKey: 'k', fetchImpl: listFetch.fetchImpl },
    NOW_ISO,
  );

  const listUrl = decodeURIComponent(listFetch.calls[0].url);

  check('公開中に絞る', listUrl.includes('is_published=eq.true'), listUrl);
  check('これから開催の回に絞る', listUrl.includes(`event_date=gte.${NOW_ISO}`), listUrl);
  check('開催日の早い順に並べる', listUrl.includes('order=event_date.asc'), listUrl);

  const unlinkedFetch = createRestFetch([{ status: 200, body: [] }]);

  await findUnlinkedEventByDate(
    { url: 'https://example.supabase.co', serviceRoleKey: 'k', fetchImpl: unlinkedFetch.fetchImpl },
    EVENT_START_ISO,
    EVENT_END_ISO,
  );

  const unlinkedUrl = decodeURIComponent(unlinkedFetch.calls[0].url);

  check('未リンクの行だけを見る',
    unlinkedUrl.includes('google_calendar_event_id=is.null'), unlinkedUrl);
  check('開催日時が一致する行を見る',
    unlinkedUrl.includes(`event_date=eq.${EVENT_START_ISO}`), unlinkedUrl);
  /* 開始だけで引き取ると、長さの違う予定に既存行を持っていかれる。 */
  check('終了時刻の一致も条件にする',
    unlinkedUrl.includes(`event_end_at=eq.${EVENT_END_ISO}`), unlinkedUrl);
  /* 候補が複数ある場合に、実行のたびに違う行を引き取らないようにする。 */
  check('順序を明示する', unlinkedUrl.includes('order=created_at.asc'), unlinkedUrl);

  const noEndFetch = createRestFetch([{ status: 200, body: [] }]);

  await findUnlinkedEventByDate(
    { url: 'https://example.supabase.co', serviceRoleKey: 'k', fetchImpl: noEndFetch.fetchImpl },
    EVENT_START_ISO,
  );

  check('終了時刻を渡さなければ条件に加えない',
    !decodeURIComponent(noEndFetch.calls[0].url).includes('event_end_at'),
    decodeURIComponent(noEndFetch.calls[0].url));

  /*
   * 満席判定の件数取得。回ごとに数えると、公開APIの1リクエストが
   * 回の数だけのDB問い合わせになる（増幅する）。1回にまとめること。
   */
  const countFetch = createRestFetch([{
    status: 200,
    body: [
      { event_id: 'ev-a' },
      { event_id: 'ev-a' },
      { event_id: 'ev-c' },
    ],
  }]);

  const counts = await countPaidApplicationsByEventIds(
    { url: 'https://example.supabase.co', serviceRoleKey: 'k', fetchImpl: countFetch.fetchImpl },
    ['ev-a', 'ev-b', 'ev-a'],
  );

  const countUrl = decodeURIComponent(countFetch.calls[0].url);

  check('問い合わせは1回だけ', countFetch.calls.length === 1, countFetch.calls.length);
  check('支払済みだけを数える', countUrl.includes('status=eq.paid'), countUrl);
  check('必要な列だけを取る', countUrl.includes('select=event_id'), countUrl);
  check('複数の回をまとめて指定する', countUrl.includes('event_id=in.(ev-a,ev-b)'), countUrl);
  check('同じIDを重ねて渡しても1つにまとめる',
    !countUrl.includes('ev-a,ev-b,ev-a'), countUrl);
  check('回ごとに件数を返す', counts['ev-a'] === 2, JSON.stringify(counts));
  check('該当が無い回は0件', counts['ev-b'] === 0, JSON.stringify(counts));
  check('渡していない回は返さない（表示の取り違えを避ける）',
    !('ev-c' in counts), JSON.stringify(counts));

  const emptyCountFetch = createRestFetch([{ status: 200, body: [] }]);

  const emptyCounts = await countPaidApplicationsByEventIds(
    {
      url: 'https://example.supabase.co',
      serviceRoleKey: 'k',
      fetchImpl: emptyCountFetch.fetchImpl,
    },
    [],
  );

  check('数える回が無ければ問い合わせない',
    emptyCountFetch.calls.length === 0 && Object.keys(emptyCounts).length === 0);

  const statusFetch = createRestFetch([{ status: 200, body: [{ key: 'calendar' }] }]);

  await updateCalendarSyncStatus(
    { url: 'https://example.supabase.co', serviceRoleKey: 'k', fetchImpl: statusFetch.fetchImpl },
    { statusText: 'あ'.repeat(600) },
  );

  check('記録は長さを切る',
    JSON.parse(statusFetch.calls[0].options.body).last_status.length === 500,
    JSON.parse(statusFetch.calls[0].options.body).last_status.length);

  finish();
} catch (error) {
  fatal(error);
}

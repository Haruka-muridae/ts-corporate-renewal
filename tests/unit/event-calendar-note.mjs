/*
 * 支払済み人数と名簿のカレンダー書き戻し（lib/event/calendar-note.mjs）。
 *
 * ==================================================================
 * 特に確かめること
 * ==================================================================
 *   - 主催者の手書きメモを壊さないこと（自動更新ブロックだけを差し替える）
 *   - ブロックが増殖しないこと（何度書き戻しても1つだけ）
 *   - 名簿に受付番号と氏名しか出さないこと（アプリ外へ出す情報の最小化）
 *   - 氏名に改行やマーカーの罫線を入れられてもブロックが壊れないこと
 *   - 名簿が長すぎるときに人数だけは必ず書けること
 *   - 定員なしの回で「定員0名」と書かないこと
 *   - タイトル（summary）を送らないこと。同期の突き合わせキーのため、
 *     書き換わると公開中の回の受付が止まる
 *   - 書き戻しの失敗を呼び出し元へ例外として投げないこと
 *   - 例外の文言にトークンや応答本文が出ないこと
 * ==================================================================
 */

import { check, section, finish, fatal } from '../../public/apps/tests/helpers/assert.mjs';

import {
  NOTE_BEGIN_MARKER,
  NOTE_END_MARKER,
  ROSTER_MAX_LENGTH,
  buildDescriptionWithNote,
  createAttendeeNoteWriter,
  updateAttendeeNote,
  writeAttendeeNote,
} from '../../lib/event/calendar-note.mjs';

import { CALENDAR_EVENT_TITLE } from '../../lib/event/calendar-sync.mjs';

/* 判定の基準になる現在時刻。テスト中は固定する。 */
const NOW = new Date('2026-08-19T01:30:00Z'); /* JST 10:30 */
const STAMP = '更新: 2026-08-19 10:30';

/* 資格情報の偽物。例外の文言に出ていないことを確かめるのに使う。 */
const REFRESH_TOKEN = 'write-refresh-token-must-not-leak';
const CLIENT_SECRET = 'client-secret-must-not-leak';
const ACCESS_TOKEN = 'access-token-must-not-leak';

const CREDENTIALS = {
  clientId: 'client-id',
  clientSecret: CLIENT_SECRET,
  refreshToken: REFRESH_TOKEN,
};

const CALENDAR_ID = 'primary';
const EVENT_ID = 'gcal-1';
const EVENT_URL =
  `https://www.googleapis.com/calendar/v3/calendars/${CALENDAR_ID}/events/${EVENT_ID}`;

/** ブロックが何個あるかを数える（増殖の検出に使う）。 */
function blockCount(text) {
  return text.split(NOTE_BEGIN_MARKER).length - 1;
}

/* 名簿の材料。受付番号の昇順（DBの listPaidAttendees が返す並び）。 */
const ATTENDEES = [
  { receiptNumber: 'TSAM-0001', name: '山田 太郎' },
  { receiptNumber: 'TSAM-0002', name: '鈴木 花子' },
];

/*
 * fetch の偽物。トークン取得・予定の取得（GET）・予定の更新（PATCH）を返し分ける。
 * calendar-sync.mjs のテストと同じ作りにしてある。
 */
function createFakeFetch({
  description = '',
  tokenStatus = 200,
  getStatus = 200,
  patchStatus = 200,
  throwNetwork = false,
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

    if ((options.method ?? 'GET') === 'GET') {
      if (getStatus !== 200) {
        return {
          ok: false,
          status: getStatus,
          json: async () => ({ error: { message: ACCESS_TOKEN } }),
        };
      }

      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: EVENT_ID,
          summary: CALENDAR_EVENT_TITLE,
          description,
          start: { dateTime: '2026-08-30T14:00:00+09:00' },
        }),
      };
    }

    if (patchStatus !== 200) {
      return {
        ok: false,
        status: patchStatus,
        json: async () => ({ error: { message: ACCESS_TOKEN } }),
      };
    }

    return { ok: true, status: 200, json: async () => ({ id: EVENT_ID }) };
  }

  return { calls, fetchImpl };
}

function calendarCalls(calls) {
  return calls.filter((call) => call.url.includes('/calendar/v3/'));
}

/** 例外の文言に秘密が出ていないこと。 */
function leaks(message) {
  return [REFRESH_TOKEN, CLIENT_SECRET, ACCESS_TOKEN].some((secret) => message.includes(secret));
}

try {
  /* ---------------------------------------------------------------- */
  section('説明欄の組み立て（説明が空）');

  const fromEmpty = buildDescriptionWithNote('', { paidCount: 5, capacity: 30, now: NOW });

  check('ブロックだけになる',
    fromEmpty === [
      NOTE_BEGIN_MARKER,
      '支払済み: 5名 / 定員30名',
      STAMP,
      NOTE_END_MARKER,
    ].join('\n'),
    JSON.stringify(fromEmpty));

  check('前後に余分な空行を付けない',
    !fromEmpty.startsWith('\n') && !fromEmpty.endsWith('\n'));

  check('null でも動く',
    buildDescriptionWithNote(null, { paidCount: 5, capacity: 30, now: NOW }) === fromEmpty);
  check('undefined でも動く',
    buildDescriptionWithNote(undefined, { paidCount: 5, capacity: 30, now: NOW }) === fromEmpty);
  check('空白だけの説明でも動く',
    buildDescriptionWithNote('  \n\n ', { paidCount: 5, capacity: 30, now: NOW }) === fromEmpty);

  /* ---------------------------------------------------------------- */
  section('手書きメモがある説明欄');

  const memo = '会場へ: 椅子を2脚追加\n担当: 山田\n電話は当日 090-0000-0000';
  const appended = buildDescriptionWithNote(memo, { paidCount: 5, capacity: 30, now: NOW });

  check('手書きメモをそのまま残す', appended.startsWith(memo), JSON.stringify(appended));
  check('末尾にブロックを足す', appended.endsWith(NOTE_END_MARKER));
  check('メモとブロックの間は1行空ける',
    appended === `${memo}\n\n${fromEmpty}`, JSON.stringify(appended));
  check('ブロックは1つだけ', blockCount(appended) === 1);

  /* 末尾に空行が並んでいても、追記のたびに空行が増えていかない。 */
  const trailing = buildDescriptionWithNote(`${memo}\n\n\n\n`,
    { paidCount: 5, capacity: 30, now: NOW });

  check('末尾の余分な空行は詰める', trailing === appended, JSON.stringify(trailing));

  /* ---------------------------------------------------------------- */
  section('既存ブロックの置き換え');

  const replaced = buildDescriptionWithNote(appended, {
    paidCount: 12, capacity: 30, now: new Date('2026-08-19T02:31:00Z'),
  });

  check('人数を書き換える', replaced.includes('支払済み: 12名 / 定員30名'), replaced);
  check('古い人数は残らない', !replaced.includes('支払済み: 5名'), replaced);
  check('更新時刻も書き換える', replaced.includes('更新: 2026-08-19 11:31'), replaced);
  check('手書きメモは変わらない', replaced.startsWith(memo), JSON.stringify(replaced));
  check('ブロックは増えない', blockCount(replaced) === 1, blockCount(replaced));

  /* 同じ人数・同じ時刻なら、何度通しても文字列が変わらない（冪等）。 */
  check('同じ入力なら結果も同じ',
    buildDescriptionWithNote(appended, { paidCount: 5, capacity: 30, now: NOW }) === appended);

  /* ブロックの後ろに書かれたメモも残す（主催者が下へ書き足すことがある）。 */
  const trailingMemo = `${appended}\n\n直前に追記: 受付は2名体制`;
  const keptTail = buildDescriptionWithNote(trailingMemo, {
    paidCount: 7, capacity: 30, now: NOW,
  });

  check('ブロックより後ろのメモも残す',
    keptTail.endsWith('直前に追記: 受付は2名体制') && keptTail.startsWith(memo),
    JSON.stringify(keptTail));
  check('後ろにメモがあってもブロックは1つ', blockCount(keptTail) === 1);
  check('後ろにメモがあっても人数は更新される', keptTail.includes('支払済み: 7名 / 定員30名'));

  /*
   * 終了マーカーだけ手で消された場合。範囲を決められないので置換せず、
   * 新しいブロックを足す（手書きを巻き込んで消さないため）。
   */
  const brokenBlock = `${memo}\n\n${NOTE_BEGIN_MARKER}\n支払済み: 5名 / 定員30名`;
  const afterBroken = buildDescriptionWithNote(brokenBlock, {
    paidCount: 9, capacity: 30, now: NOW,
  });

  check('終了マーカーが無ければ既存を消さずに追記する',
    afterBroken.startsWith(brokenBlock), JSON.stringify(afterBroken));

  /* 次の書き戻しでは、追記した側（最後のブロック）だけを置き換える。 */
  const afterBrokenAgain = buildDescriptionWithNote(afterBroken, {
    paidCount: 10, capacity: 30, now: NOW,
  });

  check('次回は最後のブロックだけを置き換える',
    afterBrokenAgain === afterBroken.replace('支払済み: 9名 / 定員30名', '支払済み: 10名 / 定員30名'),
    JSON.stringify(afterBrokenAgain));
  check('取り残されたマーカーと新しいブロックの間の文字を消さない',
    afterBrokenAgain.startsWith(brokenBlock));

  /* ---------------------------------------------------------------- */
  section('定員なしの回');

  const noCapacity = buildDescriptionWithNote('', { paidCount: 5, capacity: null, now: NOW });

  check('定員の記載を出さない', noCapacity.includes('支払済み: 5名')
    && !noCapacity.includes('定員'), noCapacity);

  /*
   * 0・負数・小数は設定ミス。capacity.mjs（isSoldOut）が定員なしとして扱うので
   * 表示もそれに揃える。「定員0名」と書いて満席だと誤解させない。
   */
  [undefined, 0, -1, 12.5].forEach((capacity) => {
    const text = buildDescriptionWithNote('', { paidCount: 5, capacity, now: NOW });

    check(`定員 ${String(capacity)} は定員なし扱い`, !text.includes('定員'), text);
  });

  /* ---------------------------------------------------------------- */
  section('人数の境界');

  check('0名でも書く',
    buildDescriptionWithNote('', { paidCount: 0, capacity: 30, now: NOW })
      .includes('支払済み: 0名 / 定員30名'));

  check('満席（定員ちょうど）',
    buildDescriptionWithNote('', { paidCount: 30, capacity: 30, now: NOW })
      .includes('支払済み: 30名 / 定員30名'));

  /* 非同期決済の確定が重なると定員を超えることがある（capacity.mjs の設計）。 */
  check('定員超過もそのまま出す',
    buildDescriptionWithNote('', { paidCount: 31, capacity: 30, now: NOW })
      .includes('支払済み: 31名 / 定員30名'));

  [null, undefined, -1, 1.5, '5', Number.NaN].forEach((paidCount) => {
    let threw = false;

    try {
      buildDescriptionWithNote('', { paidCount, capacity: 30, now: NOW });
    } catch (error) {
      threw = error instanceof TypeError;
    }

    check(`人数が ${JSON.stringify(paidCount)} なら例外（0名と書かない）`, threw);
  });

  let noNowThrew = false;

  try {
    buildDescriptionWithNote('', { paidCount: 5, capacity: 30, now: null });
  } catch (error) {
    noNowThrew = error instanceof TypeError;
  }

  check('更新時刻が無ければ例外', noNowThrew);

  /* ---------------------------------------------------------------- */
  section('名簿の記載');

  const withRoster = buildDescriptionWithNote('', {
    paidCount: 2, capacity: 30, attendees: ATTENDEES, now: NOW,
  });

  check('人数行の下に受付番号順で並べる',
    withRoster === [
      NOTE_BEGIN_MARKER,
      '支払済み: 2名 / 定員30名',
      '1. TSAM-0001 山田 太郎',
      '2. TSAM-0002 鈴木 花子',
      STAMP,
      NOTE_END_MARKER,
    ].join('\n'),
    JSON.stringify(withRoster));

  check('1名でも同じ形',
    buildDescriptionWithNote('', {
      paidCount: 1, capacity: 30, attendees: [ATTENDEES[0]], now: NOW,
    }).includes('\n1. TSAM-0001 山田 太郎\n'));

  check('0名なら名簿の行は出ない',
    buildDescriptionWithNote('', { paidCount: 0, capacity: 30, attendees: [], now: NOW })
      === fromEmpty.replace('支払済み: 5名', '支払済み: 0名'));

  check('名簿を渡さなくても人数だけで書ける',
    buildDescriptionWithNote('', { paidCount: 5, capacity: 30, now: NOW }) === fromEmpty);

  check('定員なしでも名簿は出す',
    buildDescriptionWithNote('', {
      paidCount: 2, capacity: null, attendees: ATTENDEES, now: NOW,
    }) === [
      NOTE_BEGIN_MARKER,
      '支払済み: 2名',
      '1. TSAM-0001 山田 太郎',
      '2. TSAM-0002 鈴木 花子',
      STAMP,
      NOTE_END_MARKER,
    ].join('\n'));

  /*
   * 名簿に出すのは受付番号と氏名だけ。
   * 呼び出し側が余分な列を渡しても書き出さない（アプリ外へ出す情報を増やさない）。
   */
  const extra = buildDescriptionWithNote('', {
    paidCount: 1,
    capacity: 30,
    attendees: [{
      receiptNumber: 'TSAM-0001',
      name: '山田 太郎',
      email: 'taro@example.com',
      phone: '09000000000',
      company: '株式会社テスト',
      nameKana: 'ヤマダ タロウ',
    }],
    now: NOW,
  });

  check('メール・電話・会社名・フリガナは書かない',
    !extra.includes('taro@example.com') && !extra.includes('09000000000')
      && !extra.includes('株式会社テスト') && !extra.includes('ヤマダ'),
    extra);

  /* 受付番号が無い行（DBを直接触った等）でも並びを崩さない。 */
  check('受付番号が無ければ印を出す',
    buildDescriptionWithNote('', {
      paidCount: 1, capacity: 30, attendees: [{ receiptNumber: null, name: '氏名 のみ' }], now: NOW,
    }).includes('1. （番号未発行） 氏名 のみ'));

  check('氏名が空でも行を落とさない',
    buildDescriptionWithNote('', {
      paidCount: 1, capacity: 30, attendees: [{ receiptNumber: 'TSAM-0009', name: '' }], now: NOW,
    }).includes('1. TSAM-0009 （氏名なし）'));

  /* 名簿がある状態での置き換えでも、手書きメモとブロックの数は変わらない。 */
  const rosterInMemo = buildDescriptionWithNote(`${memo}\n\n${withRoster}`, {
    paidCount: 1, capacity: 30, attendees: [ATTENDEES[1]], now: NOW,
  });

  check('名簿ごと差し替える',
    rosterInMemo.includes('1. TSAM-0002 鈴木 花子')
      && !rosterInMemo.includes('TSAM-0001'), rosterInMemo);
  check('名簿を差し替えても手書きメモは残る', rosterInMemo.startsWith(memo));
  check('名簿を差し替えてもブロックは1つ', blockCount(rosterInMemo) === 1);

  /* ---------------------------------------------------------------- */
  section('氏名にブロックを壊す文字が入っていた場合');

  /*
   * 氏名は申込者が入力し、管理画面でも書き換えられる。改行やマーカーの罫線を
   * 混ぜてブロックの構造を壊せてはならない（次回の書き戻しが範囲を誤り、
   * 説明欄に文字列が取り残されていく）。
   */
  const hostile = buildDescriptionWithNote('', {
    paidCount: 1,
    capacity: 30,
    attendees: [{
      receiptNumber: 'TSAM-0001',
      name: `山田\n${NOTE_END_MARKER}\n偽の追記`,
    }],
    now: NOW,
  });

  check('氏名の改行で行を増やさない',
    hostile.split('\n').length === 5, JSON.stringify(hostile));
  check('終了マーカーは1つだけ',
    hostile.split(NOTE_END_MARKER).length - 1 === 1, JSON.stringify(hostile));
  check('罫線を落として氏名として並べる',
    hostile.includes('1. TSAM-0001 山田 偽の追記'), hostile);

  /* 開始マーカーを氏名に混ぜられても、ブロックは1つのまま。 */
  const hostileBegin = buildDescriptionWithNote('', {
    paidCount: 1,
    capacity: 30,
    attendees: [{ receiptNumber: 'TSAM-0001', name: `${NOTE_BEGIN_MARKER}山田` }],
    now: NOW,
  });

  check('開始マーカーも作らせない', blockCount(hostileBegin) === 1, hostileBegin);

  /* 罫線を混ぜた氏名を書いたあとでも、次の書き戻しが正しく置き換わる。 */
  const afterHostile = buildDescriptionWithNote(`${memo}\n\n${hostile}`, {
    paidCount: 2, capacity: 30, attendees: ATTENDEES, now: NOW,
  });

  check('次回の書き戻しで元どおり差し替わる',
    afterHostile === `${memo}\n\n${withRoster}`, JSON.stringify(afterHostile));

  /* カタカナの長音符（ー、U+30FC）は罫線とは別の文字なので残す。 */
  check('カタカナの長音符は消さない',
    buildDescriptionWithNote('', {
      paidCount: 1, capacity: 30, attendees: [{ receiptNumber: 'T-1', name: 'リー ジョン' }], now: NOW,
    }).includes('1. T-1 リー ジョン'));

  /* 長すぎる氏名は切り詰める（1行が異常に長くならないように）。 */
  const longName = buildDescriptionWithNote('', {
    paidCount: 1,
    capacity: 30,
    attendees: [{ receiptNumber: 'TSAM-0001', name: 'あ'.repeat(120) }],
    now: NOW,
  });

  check('長い氏名は切り詰めて印を付ける',
    longName.includes(`1. TSAM-0001 ${'あ'.repeat(40)}…`), longName.slice(0, 120));

  /* ---------------------------------------------------------------- */
  section('名簿が長すぎる場合');

  /*
   * Googleカレンダーの説明欄には上限（8,192文字）がある。名簿で埋めて
   * 更新そのものが弾かれるくらいなら、名簿を落として人数だけを残す。
   */
  const crowd = Array.from({ length: 400 }, (_, index) => ({
    receiptNumber: `TSAM-${String(index + 1).padStart(4, '0')}`,
    name: `参加者${index + 1}`,
  }));

  const truncated = buildDescriptionWithNote('', {
    paidCount: crowd.length, capacity: null, attendees: crowd, now: NOW,
  });

  check('人数は必ず書く', truncated.includes('支払済み: 400名'), truncated.slice(0, 200));
  check('名簿は落とす', !truncated.includes('TSAM-0001'), truncated.slice(0, 200));
  check('落とした理由を書く',
    truncated.includes('名簿は長くなりすぎるため省略しました（400名分）'), truncated);
  check('上限を超えない', truncated.length < ROSTER_MAX_LENGTH, truncated.length);

  /* 上限の内側なら、そのまま全員書く。 */
  const nearLimit = Array.from({ length: 100 }, (_, index) => ({
    receiptNumber: `TSAM-${String(index + 1).padStart(4, '0')}`,
    name: `参加者${index + 1}`,
  }));

  const hundred = buildDescriptionWithNote('', {
    paidCount: 100, capacity: null, attendees: nearLimit, now: NOW,
  });

  check('上限の内側なら全員書く', hundred.includes('100. TSAM-0100 参加者100'));

  /*
   * 名簿が上限内でも、手書きメモと合わせて説明欄の上限（8,192文字）を
   * 超える場合は名簿を落とす。人数まで書き戻せなくなるほうが困るため。
   */
  const longMemo = 'あ'.repeat(6500);
  const withLongMemo = buildDescriptionWithNote(longMemo, {
    paidCount: 100, capacity: null, attendees: nearLimit, now: NOW,
  });

  check('メモが長ければ名簿を落として人数だけ書く',
    withLongMemo.includes('支払済み: 100名')
      && withLongMemo.includes('名簿は長くなりすぎるため省略しました（100名分）')
      && !withLongMemo.includes('TSAM-0100'),
    withLongMemo.length);
  check('手書きメモは削らない', withLongMemo.startsWith(longMemo));
  check('説明欄の上限に収まる', withLongMemo.length <= 8192, withLongMemo.length);

  /* ---------------------------------------------------------------- */
  section('カレンダーへの書き込み');

  const fake = createFakeFetch({ description: memo });

  const wrote = await writeAttendeeNote({
    fetchImpl: fake.fetchImpl,
    credentials: CREDENTIALS,
    calendarId: CALENDAR_ID,
    googleCalendarEventId: EVENT_ID,
    paidCount: 5,
    capacity: 30,
    now: NOW,
  });

  const apiCalls = calendarCalls(fake.calls);

  check('トークン交換を1回だけ行う',
    fake.calls.filter((call) => call.url.startsWith('https://oauth2.googleapis.com/token')).length === 1);
  check('カレンダーへの通信は2回（取得と更新）', apiCalls.length === 2, apiCalls.length);

  check('1回目は予定の取得（GET）',
    apiCalls[0].url === EVENT_URL && (apiCalls[0].options.method ?? 'GET') === 'GET',
    apiCalls[0].url);
  check('取得にアクセストークンを付ける',
    apiCalls[0].options.headers.Authorization === `Bearer ${ACCESS_TOKEN}`);

  check('2回目は PATCH', apiCalls[1].options.method === 'PATCH', apiCalls[1].options.method);
  check('更新先は同じ予定', apiCalls[1].url.startsWith(EVENT_URL), apiCalls[1].url);
  check('参加者へ通知を飛ばさない（sendUpdates=none）',
    apiCalls[1].url.includes('sendUpdates=none'), apiCalls[1].url);

  const patched = JSON.parse(apiCalls[1].options.body);

  check('送るのは説明欄だけ',
    Object.keys(patched).length === 1 && 'description' in patched,
    JSON.stringify(Object.keys(patched)));
  check('タイトルを送らない（同期の突き合わせキーを壊さない）',
    !('summary' in patched) && !apiCalls[1].options.body.includes(CALENDAR_EVENT_TITLE));
  check('日時も参加者も送らない',
    !('start' in patched) && !('end' in patched) && !('attendees' in patched));

  check('説明欄は手書きメモ＋ブロック',
    patched.description === `${memo}\n\n${fromEmpty}`, JSON.stringify(patched.description));
  check('更新した旨を返す', wrote.updated === true);
  check('書き込んだ内容を返す', wrote.description === patched.description);

  /* 制限時間（AbortSignal）はトークン交換と両方の呼び出しに掛かる。 */
  check('すべての通信に signal を渡す',
    fake.calls.every((call) => call.options.signal !== undefined));

  /* ---------------------------------------------------------------- */
  section('内容が変わらないときは書き込まない');

  const already = createFakeFetch({ description: `${memo}\n\n${fromEmpty}` });

  const unchanged = await writeAttendeeNote({
    fetchImpl: already.fetchImpl,
    credentials: CREDENTIALS,
    calendarId: CALENDAR_ID,
    googleCalendarEventId: EVENT_ID,
    paidCount: 5,
    capacity: 30,
    now: NOW,
  });

  check('PATCH を送らない', calendarCalls(already.calls).length === 1);
  check('更新していない旨を返す', unchanged.updated === false);

  /* 説明欄が空（新しく作られた予定）でも書き込める。 */
  const emptyEvent = createFakeFetch({ description: undefined });

  await writeAttendeeNote({
    fetchImpl: emptyEvent.fetchImpl,
    credentials: CREDENTIALS,
    calendarId: CALENDAR_ID,
    googleCalendarEventId: EVENT_ID,
    paidCount: 1,
    capacity: null,
    now: NOW,
  });

  check('説明欄が無い予定にも書ける',
    JSON.parse(calendarCalls(emptyEvent.calls)[1].options.body).description
      .startsWith(NOTE_BEGIN_MARKER));

  /* ---------------------------------------------------------------- */
  section('引数が足りない場合（通信の前に止める）');

  const missingCases = [
    { name: 'カレンダーID', input: { calendarId: '' } },
    { name: '予定のID', input: { googleCalendarEventId: '' } },
    { name: 'リフレッシュトークン', input: { credentials: { ...CREDENTIALS, refreshToken: '' } } },
    { name: 'クライアントシークレット', input: { credentials: { ...CREDENTIALS, clientSecret: '' } } },
  ];

  for (const { name, input } of missingCases) {
    const guard = createFakeFetch();
    let error = null;

    try {
      await writeAttendeeNote({
        fetchImpl: guard.fetchImpl,
        credentials: CREDENTIALS,
        calendarId: CALENDAR_ID,
        googleCalendarEventId: EVENT_ID,
        paidCount: 1,
        capacity: null,
        now: NOW,
        ...input,
      });
    } catch (caught) {
      error = caught;
    }

    check(`${name}が無ければ例外`, error instanceof TypeError, String(error));
    check(`${name}が無ければ通信もしない`, guard.calls.length === 0);
    check(`${name}の例外に秘密を出さない`, !leaks(String(error?.message)));
  }

  /* ---------------------------------------------------------------- */
  section('HTTPエラー（トークンも応答本文も出さない）');

  const failures = [
    {
      name: 'トークン交換の失敗',
      options: { tokenStatus: 401 },
      expected: 'アクセストークンを取得できませんでした（HTTP 401）',
    },
    {
      name: '予定の取得の失敗',
      options: { getStatus: 404 },
      expected: 'カレンダー予定を取得できませんでした（HTTP 404）',
    },
    {
      name: '予定の更新の失敗（権限不足）',
      options: { getStatus: 200, patchStatus: 403, description: memo },
      expected: 'カレンダー予定を更新できませんでした（HTTP 403）',
    },
  ];

  for (const { name, options, expected } of failures) {
    const failing = createFakeFetch(options);
    let error = null;

    try {
      await writeAttendeeNote({
        fetchImpl: failing.fetchImpl,
        credentials: CREDENTIALS,
        calendarId: CALENDAR_ID,
        googleCalendarEventId: EVENT_ID,
        paidCount: 5,
        capacity: 30,
        now: NOW,
      });
    } catch (caught) {
      error = caught;
    }

    check(`${name}を例外にする`, error?.message === expected, String(error?.message));
    check(`${name}の文言に秘密を出さない`, !leaks(String(error?.message)));
  }

  /* 通信そのものが失敗した場合も、例外はそのまま外へ出す（呼び出し側が記録する）。 */
  const network = createFakeFetch({ throwNetwork: true });
  let networkError = null;

  try {
    await writeAttendeeNote({
      fetchImpl: network.fetchImpl,
      credentials: CREDENTIALS,
      calendarId: CALENDAR_ID,
      googleCalendarEventId: EVENT_ID,
      paidCount: 5,
      capacity: 30,
      now: NOW,
    });
  } catch (caught) {
    networkError = caught;
  }

  check('接続できない場合も例外', networkError instanceof Error);
  check('接続失敗の文言にも秘密を出さない', !leaks(String(networkError?.message)));

  /* ---------------------------------------------------------------- */
  section('名簿も説明欄へ送る');

  const rosterFetch = createFakeFetch({ description: memo });

  await writeAttendeeNote({
    fetchImpl: rosterFetch.fetchImpl,
    credentials: CREDENTIALS,
    calendarId: CALENDAR_ID,
    googleCalendarEventId: EVENT_ID,
    paidCount: 2,
    capacity: 30,
    attendees: ATTENDEES,
    now: NOW,
  });

  const rosterBody = JSON.parse(calendarCalls(rosterFetch.calls)[1].options.body);

  check('名簿を含めて書き込む',
    rosterBody.description === `${memo}\n\n${withRoster}`,
    JSON.stringify(rosterBody.description));
  check('送るのは説明欄だけ（名簿があっても変わらない）',
    Object.keys(rosterBody).length === 1 && 'description' in rosterBody);

  /* ---------------------------------------------------------------- */
  section('書き戻しの口の組み立て');

  check('設定が無ければ null（未設定の環境では機能ごと見送る）',
    createAttendeeNoteWriter(null) === null);
  check('カレンダーIDが無くても null',
    createAttendeeNoteWriter({ credentials: CREDENTIALS }) === null);
  check('資格情報が無くても null',
    createAttendeeNoteWriter({ calendarId: CALENDAR_ID }) === null);

  const builtFetch = createFakeFetch({ description: '' });
  const builtWriter = createAttendeeNoteWriter(
    { calendarId: CALENDAR_ID, credentials: CREDENTIALS },
    builtFetch.fetchImpl,
  );

  await builtWriter.write({
    googleCalendarEventId: EVENT_ID,
    paidCount: 2,
    capacity: 30,
    attendees: ATTENDEES,
    now: NOW,
  });

  check('設定があれば書き込める',
    JSON.parse(calendarCalls(builtFetch.calls)[1].options.body).description === withRoster);

  /* ---------------------------------------------------------------- */
  section('回を特定して書き戻す（updateAttendeeNote）');

  /* DBの偽物。呼ばれた回数と引数を見られるようにする。 */
  function createFakeDb(overrides = {}) {
    const calls = [];

    return {
      calls,
      async findApplicationById(_config, id) {
        calls.push(['findApplicationById', id]);
        return id === 'app-1' ? { id, event_id: 'event-1' } : null;
      },
      async findEventById(_config, id) {
        calls.push(['findEventById', id]);
        return id === 'event-1'
          ? { id, capacity: 30, google_calendar_event_id: EVENT_ID }
          : null;
      },
      async countPaidApplications(_config, id) {
        calls.push(['countPaidApplications', id]);
        return 2;
      },
      async listPaidAttendees(_config, id) {
        calls.push(['listPaidAttendees', id]);
        return [
          { receipt_number: 'TSAM-0001', name: '山田 太郎' },
          { receipt_number: 'TSAM-0002', name: '鈴木 花子' },
        ];
      },
      ...overrides,
    };
  }

  function createSpyWriter({ failWith = null } = {}) {
    const written = [];

    return {
      written,
      async write(note) {
        if (failWith !== null) {
          throw new Error(failWith);
        }

        written.push(note);
        return { updated: true, description: '' };
      },
    };
  }

  const byEventDb = createFakeDb();
  const byEventWriter = createSpyWriter();

  const byEvent = await updateAttendeeNote({
    config: {}, db: byEventDb, writer: byEventWriter, eventId: 'event-1', now: NOW,
  });

  check('回のIDが分かっていれば申込は読まない',
    !byEventDb.calls.some(([name]) => name === 'findApplicationById'),
    JSON.stringify(byEventDb.calls));
  check('人数と名簿を渡す',
    byEventWriter.written[0].paidCount === 2
      && byEventWriter.written[0].attendees.length === 2
      && byEventWriter.written[0].attendees[0].receiptNumber === 'TSAM-0001',
    JSON.stringify(byEventWriter.written[0]));
  check('定員と予定のIDも渡す',
    byEventWriter.written[0].capacity === 30
      && byEventWriter.written[0].googleCalendarEventId === EVENT_ID);
  check('結果を1行で返す',
    byEvent === 'カレンダーに支払済み2名（名簿2件）を書き戻しました', byEvent);

  /* 申込IDしか無い経路（返金・管理画面の編集）。 */
  const byApplicationDb = createFakeDb();
  const byApplicationWriter = createSpyWriter();

  await updateAttendeeNote({
    config: {}, db: byApplicationDb, writer: byApplicationWriter,
    applicationId: 'app-1', now: NOW,
  });

  check('申込IDから回を特定して書き戻す',
    byApplicationWriter.written.length === 1
      && byApplicationDb.calls.some(([name, id]) => name === 'findApplicationById' && id === 'app-1'),
    JSON.stringify(byApplicationDb.calls));

  /* ---------------------------------------------------------------- */
  section('書き戻しを見送る・失敗する場合（例外にしない）');

  const skipped = await updateAttendeeNote({
    config: {}, db: createFakeDb(), writer: null, eventId: 'event-1', now: NOW,
  });

  check('未設定なら見送りとして返す',
    skipped === 'カレンダーへの書き戻しは未設定のため見送りました', skipped);

  const manualWriter = createSpyWriter();
  const manual = await updateAttendeeNote({
    config: {},
    db: createFakeDb({
      async findEventById() {
        return { id: 'event-1', capacity: 30, google_calendar_event_id: null };
      },
    }),
    writer: manualWriter,
    eventId: 'event-1',
    now: NOW,
  });

  check('手動登録の回は対象外として返す',
    manual === 'カレンダーへの書き戻しは対象外（カレンダー連動ではない回）', manual);
  check('手動登録の回では書き込まない', manualWriter.written.length === 0);

  const missingEvent = await updateAttendeeNote({
    config: {}, db: createFakeDb(), writer: createSpyWriter(), eventId: 'event-x', now: NOW,
  });

  check('回が見つからなければ理由を返す',
    missingEvent === 'カレンダーへの書き戻し: 開催回が見つかりません', missingEvent);

  const missingApplication = await updateAttendeeNote({
    config: {}, db: createFakeDb(), writer: createSpyWriter(), applicationId: 'app-x', now: NOW,
  });

  check('申込が見つからなければ理由を返す',
    missingApplication === 'カレンダーへの書き戻し: 対象の回を特定できませんでした',
    missingApplication);

  const noTarget = await updateAttendeeNote({
    config: {}, db: createFakeDb(), writer: createSpyWriter(), now: NOW,
  });

  check('回も申込も渡されなければ理由を返す',
    noTarget === 'カレンダーへの書き戻し: 対象の回を特定できませんでした', noTarget);

  const writeFailed = await updateAttendeeNote({
    config: {},
    db: createFakeDb(),
    writer: createSpyWriter({ failWith: 'カレンダー予定を更新できませんでした（HTTP 403）' }),
    eventId: 'event-1',
    now: NOW,
  });

  check('書き込みの失敗も例外にせず返す',
    writeFailed === 'カレンダーへの書き戻しに失敗（カレンダー予定を更新できませんでした（HTTP 403））',
    writeFailed);

  const dbFailed = await updateAttendeeNote({
    config: {},
    db: createFakeDb({
      async listPaidAttendees() {
        throw new Error('データベース操作に失敗しました（HTTP 500）');
      },
    }),
    writer: createSpyWriter(),
    eventId: 'event-1',
    now: NOW,
  });

  check('DBの失敗も例外にせず返す',
    dbFailed.startsWith('カレンダーへの書き戻しに失敗'), dbFailed);

  finish();
} catch (error) {
  fatal(error);
}

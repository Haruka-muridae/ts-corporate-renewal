/*
 * 開催日一覧の組み立て（lib/event/schedule.mjs）。
 *
 * ==================================================================
 * 特に確かめること
 * ==================================================================
 *   - 表示の日時が日本時間で、参加確定メールと同じ書式になること
 *     （LPとメールで書式が違うと、同じ回だと分からなくなる）
 *   - 「申し込める回」の判定が、受付期間・満席・公開の3つで決まること
 *   - 過去回が一覧に残らないこと
 *   - 1件も無いときに例外にならず、空の形で返ること
 * ==================================================================
 */

import { readFileSync } from 'node:fs';

import { check, section, finish, fatal } from '../../public/apps/tests/helpers/assert.mjs';

import {
  buildSchedulePayload,
  isEventAcceptingNow,
  resolveSelectableEvents,
} from '../../lib/event/schedule.mjs';

/* 判定の基準になる現在時刻。テスト中は固定する。 */
const NOW = new Date('2026-08-20T12:00:00+09:00');

function makeEvent(overrides = {}) {
  return {
    id: 'ev-1',
    name: 'TSAMビジネス&フレンド交流会',
    event_date: '2026-08-30T14:30:00+09:00',
    event_end_at: '2026-08-30T16:00:00+09:00',
    capacity: 30,
    apply_start_at: '2026-08-01T00:00:00+09:00',
    apply_end_at: '2026-08-30T14:30:00+09:00',
    is_published: true,
    synced_at: '2026-08-20T02:00:00.000Z',
    ...overrides,
  };
}

try {
  /* ---------------------------------------------------------------- */
  section('表示の日時（Asia/Tokyo）');

  const basic = buildSchedulePayload({
    events: [makeEvent()],
    paidCounts: { 'ev-1': 0 },
    now: NOW,
  });

  check('メールと同じ書式で1行にする',
    basic.events[0].label === '2026年8月30日（日）14:30〜16:00', basic.events[0].label);

  check('開始はISO8601で返す',
    basic.events[0].startAt === '2026-08-30T05:30:00.000Z', basic.events[0].startAt);
  check('終了もISO8601で返す',
    basic.events[0].endAt === '2026-08-30T07:00:00.000Z', basic.events[0].endAt);

  const noEnd = buildSchedulePayload({
    events: [makeEvent({ event_end_at: null })],
    now: NOW,
  });

  check('終了時刻が無ければ開始だけを出す',
    noEnd.events[0].label === '2026年8月30日（日）14:30', noEnd.events[0].label);
  check('終了時刻が無ければ endAt は null', noEnd.events[0].endAt === null);

  /*
   * サーバーの時間帯設定に引きずられないこと。
   * UTC 表記で渡しても、表示は日本時間になる。
   */
  const utcInput = buildSchedulePayload({
    events: [makeEvent({
      event_date: '2026-08-30T05:30:00.000Z',
      event_end_at: '2026-08-30T07:00:00.000Z',
    })],
    now: NOW,
  });

  check('UTC表記で渡しても日本時間で表示する',
    utcInput.events[0].label === '2026年8月30日（日）14:30〜16:00', utcInput.events[0].label);

  /* ---------------------------------------------------------------- */
  section('受付中かどうか');

  check('受付期間内なら accepting',
    buildSchedulePayload({ events: [makeEvent()], now: NOW }).events[0].accepting === true);

  const beforePeriod = buildSchedulePayload({
    events: [makeEvent({ apply_start_at: '2026-08-25T00:00:00+09:00' })],
    now: NOW,
  });

  check('受付開始前は accepting にしない', beforePeriod.events[0].accepting === false);
  check('受付開始前でも一覧には出す（予告として見せる）',
    beforePeriod.events.length === 1);

  const afterPeriod = buildSchedulePayload({
    events: [makeEvent({ apply_end_at: '2026-08-19T23:59:59+09:00' })],
    now: NOW,
  });

  check('受付終了後は accepting にしない', afterPeriod.events[0].accepting === false);

  const soldOut = buildSchedulePayload({
    events: [makeEvent()],
    paidCounts: { 'ev-1': 30 },
    now: NOW,
  });

  check('定員ちょうどで満席', soldOut.events[0].soldOut === true);
  check('満席なら accepting にしない', soldOut.events[0].accepting === false);

  const almost = buildSchedulePayload({
    events: [makeEvent()],
    paidCounts: { 'ev-1': 29 },
    now: NOW,
  });

  check('定員に1つ足りなければ受け付ける',
    almost.events[0].soldOut === false && almost.events[0].accepting === true);

  const noCapacity = buildSchedulePayload({
    events: [makeEvent({ capacity: null })],
    paidCounts: { 'ev-1': 100 },
    now: NOW,
  });

  check('定員なしの回は満席にならない',
    noCapacity.events[0].soldOut === false && noCapacity.events[0].accepting === true);

  check('件数を渡さない回は0件として扱う',
    buildSchedulePayload({ events: [makeEvent()], now: NOW }).events[0].soldOut === false);

  const unpublished = buildSchedulePayload({
    events: [makeEvent({ is_published: false })],
    now: NOW,
  });

  check('公開されていない回は accepting にしない',
    unpublished.events[0].accepting === false);

  /* ---------------------------------------------------------------- */
  section('過去回の除外と並び順');

  const mixed = buildSchedulePayload({
    events: [
      makeEvent({ id: 'ev-late', event_date: '2026-09-13T15:00:00+09:00',
        event_end_at: '2026-09-13T17:00:00+09:00',
        apply_end_at: '2026-09-13T15:00:00+09:00' }),
      makeEvent({ id: 'ev-past', event_date: '2026-08-10T14:30:00+09:00',
        event_end_at: '2026-08-10T16:00:00+09:00',
        apply_end_at: '2026-08-10T14:30:00+09:00' }),
      makeEvent({ id: 'ev-soon' }),
    ],
    now: NOW,
  });

  check('過去回を落とす', mixed.events.length === 2, mixed.events.map((e) => e.id).join(','));
  check('開催日の早い順に並べる',
    mixed.events[0].id === 'ev-soon' && mixed.events[1].id === 'ev-late',
    mixed.events.map((e) => e.id).join(','));
  check('9月の回も日本時間で表示する',
    mixed.events[1].label === '2026年9月13日（日）15:00〜17:00', mixed.events[1].label);

  /* ---------------------------------------------------------------- */
  section('同期の鮮度');

  const synced = buildSchedulePayload({
    events: [
      makeEvent({ id: 'ev-a', synced_at: '2026-08-20T02:00:00.000Z' }),
      makeEvent({ id: 'ev-b', event_date: '2026-09-13T15:00:00+09:00',
        apply_end_at: '2026-09-13T15:00:00+09:00',
        synced_at: '2026-08-20T02:50:00.000Z' }),
    ],
    now: NOW,
  });

  check('いちばん新しい synced_at を返す',
    synced.syncedAt === '2026-08-20T02:50:00.000Z', synced.syncedAt);

  check('synced_at が無ければ null',
    buildSchedulePayload({ events: [makeEvent({ synced_at: null })], now: NOW })
      .syncedAt === null);

  /* ---------------------------------------------------------------- */
  section('1件も無いとき');

  const empty = buildSchedulePayload({ events: [], now: NOW });

  check('空の配列を返す', Array.isArray(empty.events) && empty.events.length === 0);
  check('syncedAt は null', empty.syncedAt === null);

  const missing = buildSchedulePayload({ events: undefined, now: NOW });

  check('events が未指定でも落ちない', missing.events.length === 0);

  /* ---------------------------------------------------------------- */
  section('申込ページで選べる回');

  const selectable = resolveSelectableEvents({
    events: [
      makeEvent({ id: 'ev-open' }),
      makeEvent({ id: 'ev-full' }),
      makeEvent({ id: 'ev-closed', apply_end_at: '2026-08-19T23:59:59+09:00' }),
      makeEvent({ id: 'ev-hidden', is_published: false }),
      makeEvent({ id: 'ev-past', event_date: '2026-08-10T14:30:00+09:00',
        apply_end_at: '2026-08-10T14:30:00+09:00' }),
    ],
    paidCounts: { 'ev-full': 30 },
    now: NOW,
  });

  const ids = selectable.map((item) => item.id);

  check('受付中の回を含む', ids.includes('ev-open'));
  check('満席の回も含む（満席と分かるように見せるため）', ids.includes('ev-full'));
  check('受付が終わった回は出さない', !ids.includes('ev-closed'));
  check('非公開の回は出さない', !ids.includes('ev-hidden'));
  check('過去回は出さない', !ids.includes('ev-past'));
  check('満席の回は選択不可として渡す',
    selectable.find((item) => item.id === 'ev-full')?.accepting === false);

  /* ---------------------------------------------------------------- */
  section('サーバー側の再確認（isEventAcceptingNow）');

  /*
   * 申込の保存（submitApplication）・決済の開始（startCheckout）・確認画面が
   * 使う判定。ここが緩いと、確認画面のURLを開き直すだけで受付終了後の回に
   * 決済を通せてしまう。一覧の accepting と同じ関数を使っている。
   */
  check('公開中・受付期間内なら受け付ける',
    isEventAcceptingNow(makeEvent(), NOW) === true);

  check('非公開の回は受け付けない',
    isEventAcceptingNow(makeEvent({ is_published: false }), NOW) === false);

  check('受付開始前は受け付けない',
    isEventAcceptingNow(makeEvent({ apply_start_at: '2026-08-25T00:00:00+09:00' }), NOW)
      === false);

  check('受付終了後は受け付けない',
    isEventAcceptingNow(makeEvent({ apply_end_at: '2026-08-19T23:59:59+09:00' }), NOW)
      === false);

  check('受付開始ちょうどは受け付ける',
    isEventAcceptingNow(makeEvent({ apply_start_at: NOW.toISOString() }), NOW) === true);
  check('受付終了ちょうどは受け付ける',
    isEventAcceptingNow(makeEvent({ apply_end_at: NOW.toISOString() }), NOW) === true);
  check('受付終了の1ミリ秒後は受け付けない',
    isEventAcceptingNow(
      makeEvent({ apply_end_at: new Date(NOW.getTime() - 1).toISOString() }), NOW,
    ) === false);

  check('イベントが無ければ受け付けない', isEventAcceptingNow(null, NOW) === false);

  /* 値が壊れているときは「受け付ける」側に倒さない。 */
  check('受付期間が日時として読めなければ受け付けない',
    isEventAcceptingNow(makeEvent({ apply_end_at: 'あした' }), NOW) === false);
  check('公開かどうかが真偽値でなければ受け付けない',
    isEventAcceptingNow(makeEvent({ is_published: 'true' }), NOW) === false);

  /* 定員はここでは見ない（件数の問い合わせを伴うため呼び出し側で確かめる）。 */
  check('定員は判定に含めない',
    isEventAcceptingNow(makeEvent({ capacity: 0 }), NOW) === true);

  /* ---------------------------------------------------------------- */
  section('判定を使っている場所');

  /*
   * サーバーアクションと確認画面は next/navigation・React に依存するため、
   * このランナーからは読み込めない。判定を通す前に決済を始めていないか
   * （順序が逆になっていないか）をファイルの中身で確かめる。
   */
  const actions = readFileSync(
    new URL('../../app/event/apply/actions.ts', import.meta.url), 'utf8');

  check('決済の開始でも公開状態と受付期間を確かめる',
    actions.includes('isEventAcceptingNow'), 'actions.ts');
  check('Checkout Session を作る前に確かめる',
    actions.lastIndexOf('isEventAcceptingNow') < actions.indexOf('createCheckoutSession('),
    'actions.ts');
  check('満席の判定より前に確かめる（受付終了と満席を取り違えない）',
    actions.lastIndexOf('isEventAcceptingNow') < actions.lastIndexOf('isEventSoldOut('),
    'actions.ts');

  const confirmPage = readFileSync(
    new URL('../../app/event/apply/confirm/page.tsx', import.meta.url), 'utf8');

  check('確認画面も同じ判定を使う',
    confirmPage.includes('isEventAcceptingNow'), 'confirm/page.tsx');
  check('受付を終えた回では決済へ進む導線を出さない',
    confirmPage.indexOf('isEventAcceptingNow') < confirmPage.indexOf('action={startCheckout}'),
    'confirm/page.tsx');
  check('受付終了だと分かる文言を出す',
    confirmPage.includes('お申し込みの受付を終了しました'), 'confirm/page.tsx');

  /* ---------------------------------------------------------------- */
  section('LPの受付状態（public/event/script.js）');

  /*
   * LP は静的HTMLに読み込まれる素のスクリプトで、DOMContentLoaded の中に
   * 閉じているため import できない。状態を決める関数だけを取り出して動かす
   * （文字列の一致で確かめるだけだと、条件を逆に書いても気づけないため）。
   */
  const lpScript = readFileSync(
    new URL('../../public/event/script.js', import.meta.url), 'utf8');

  const resolverSource =
    /\n {2}function resolveStatusFromSchedule\(items\) \{[\s\S]*?\n {2}\}/.exec(lpScript);

  check('状態を決める関数を取り出せる', resolverSource !== null);

  const resolveStatus = new Function(
    `${resolverSource[0]}\nreturn resolveStatusFromSchedule;`,
  )();

  const item = (overrides = {}) => ({ accepting: false, soldOut: false, ...overrides });

  check('1件も無ければ準備中', resolveStatus([]) === 'preparing');
  check('受付中の回があれば受付中',
    resolveStatus([item({ soldOut: true }), item({ accepting: true })]) === 'open');
  check('全て満席なら満席として終了',
    resolveStatus([item({ soldOut: true }), item({ soldOut: true })]) === 'full');
  /*
   * 受付開始前・受付終了後の回しか無い状態。以前は full に寄せていたため、
   * 満席ではないのに「満席のため終了」と読める案内が出ていた。
   */
  check('受付期間の外だけなら受付終了（満席とは分ける）',
    resolveStatus([item()]) === 'closed');
  check('満席と期間外が混ざっていれば受付終了',
    resolveStatus([item({ soldOut: true }), item()]) === 'closed');

  /* 遷移先が無いときに押せるボタンを出さない（リンク切れの保険）。 */
  const disabledLine = /applyButton\.disabled = [\s\S]*?;/.exec(lpScript)?.[0] ?? '';

  check('受付中かどうかを見る', disabledLine.includes("statusKey === 'open'"), disabledLine);
  check('遷移先の有無も見る',
    disabledLine.includes("typeof APPLY_URL === 'string'")
      && disabledLine.includes("APPLY_URL !== ''"),
    disabledLine);

  finish();
} catch (error) {
  fatal(error);
}

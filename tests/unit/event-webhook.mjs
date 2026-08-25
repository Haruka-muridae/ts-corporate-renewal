/*
 * Stripe Webhook の検証（実装仕様書 5.3、受入条件 4・5・7・9）。
 *
 * ==================================================================
 * 特に確かめること
 * ==================================================================
 *   - 偽の通知を受け付けないこと（署名検証）
 *   - 同じイベントを2回受けても、受付番号とメールが重複しないこと
 *   - PayPay想定の async_payment_succeeded 経由でも同じ結果になること
 *   - checkout.session.completed で未確定なら支払済みにしないこと
 *   - 手動返金が「返金済み（例外対応）」に反映されること
 *   - メールの失敗で支払の記録を巻き戻さないこと
 *   - カレンダーへの人数・名簿の書き戻しが失敗しても支払の記録を巻き戻さないこと
 * ==================================================================
 */

import { check, section, finish, fatal } from '../../public/apps/tests/helpers/assert.mjs';

import {
  verifyStripeSignature,
  parseSignatureHeader,
  parseStripeEvent,
  signPayload,
  DEFAULT_TOLERANCE_SECONDS,
} from '../../lib/event/webhook-signature.mjs';

import {
  handleStripeEvent,
  HANDLED_EVENT_TYPES,
} from '../../lib/event/webhook-handler.mjs';

const SECRET = 'whsec_test_secret_0123456789abcdef';
const NOW = 1_800_000_000;

const APPLICATION = {
  id: 'app-1',
  event_id: 'event-1',
  name: '山田 太郎',
  email: 'taro@example.com',
  industry: 'it',
  occupation: 'engineer',
  position: 'manager',
  age_group: '24+',
  is_banned_declared: false,
  status: 'awaiting',
  receipt_number: null,
};

const EVENT_ROW = {
  id: 'event-1',
  name: 'TSAMビジネス&フレンド交流会',
  event_date: '2026-08-30T14:30:00+09:00',
  venue: 'CAFE&BAR ZERA\n東京都渋谷区道玄坂1丁目17-4 道玄坂ビル4F',
  capacity: 30,
  /* カレンダー連動の回（書き戻しの対象）。手動登録の回は null になる。 */
  google_calendar_event_id: 'gcal-1',
};

/* DBの偽物。呼ばれた回数と最終状態を見られるようにする。 */
function createFakeDb() {
  const state = {
    webhookIds: new Set(),
    application: { ...APPLICATION },
    payment: {
      id: 'pay-1',
      application_id: 'app-1',
      payment_status: 'pending',
      stripe_payment_intent_id: null,
    },
    emailLogs: [],
    receiptAssignments: 0,
    processedResults: [],
    nextReceiptNumber: 'TSAM-0001',
    event: { ...EVENT_ROW },
    /* カレンダーへ書き戻す人数。支払済みの件数として返す。 */
    paidCount: 4,
    /* 同じくカレンダーへ書き戻す名簿（受付番号と氏名だけ）。 */
    attendees: [
      { receipt_number: 'TSAM-0001', name: '山田 太郎' },
      { receipt_number: 'TSAM-0002', name: '鈴木 花子' },
      { receipt_number: 'TSAM-0003', name: '佐藤 次郎' },
      { receipt_number: 'TSAM-0004', name: '高橋 三郎' },
    ],
  };

  const db = {
    state,

    async insertWebhookEvent(_config, { stripeEventId }) {
      if (state.webhookIds.has(stripeEventId)) {
        return { row: null, duplicate: true };
      }

      state.webhookIds.add(stripeEventId);
      return { row: { id: 'wh-1' }, duplicate: false };
    },

    async markWebhookProcessed(_config, stripeEventId, result) {
      state.processedResults.push({ stripeEventId, result });
      return { id: 'wh-1' };
    },

    async findApplicationById(_config, id) {
      return id === state.application.id ? { ...state.application } : null;
    },

    async findEventById(_config, id) {
      return id === state.event.id ? { ...state.event } : null;
    },

    async countPaidApplications(_config, _eventId) {
      return state.paidCount;
    },

    async listPaidAttendees(_config, _eventId) {
      return state.attendees.map((row) => ({ ...row }));
    },

    async findPaymentByApplicationId() {
      return { ...state.payment };
    },

    async findPaymentByPaymentIntentId(_config, paymentIntentId) {
      return state.payment.stripe_payment_intent_id === paymentIntentId
        ? { ...state.payment }
        : null;
    },

    async updatePayment(_config, _paymentId, patch) {
      Object.assign(state.payment, patch);
      return { ...state.payment };
    },

    async updateApplicationStatus(_config, _id, status) {
      state.application.status = status;
      return { ...state.application };
    },

    async assignReceiptNumber(_config, _applicationId) {
      /* DB側の関数と同じく、すでに発行済みなら同じ番号を返す。 */
      if (state.application.receipt_number === null) {
        state.receiptAssignments += 1;
        state.application.receipt_number = state.nextReceiptNumber;
      }

      return state.application.receipt_number;
    },

    async insertEmailLog(_config, log) {
      state.emailLogs.push(log);
      return { id: `log-${state.emailLogs.length}` };
    },
  };

  return db;
}

function createFakeMailer({ failWith = null } = {}) {
  const sent = [];

  return {
    sent,
    async send(message) {
      if (failWith !== null) {
        throw new Error(failWith);
      }

      sent.push(message);
      return { id: 'msg-1' };
    },
  };
}

/*
 * カレンダー書き戻しの偽物。
 * 本物（lib/event/calendar-note.mjs の writeAttendeeNote）と同じ形の口だけを持つ。
 */
function createFakeCalendarNote({ failWith = null } = {}) {
  const written = [];

  return {
    written,
    async write(note) {
      if (failWith !== null) {
        throw new Error(failWith);
      }

      written.push(note);
      return { updated: true };
    },
  };
}

function sessionEvent(type, overrides = {}) {
  return {
    id: `evt_${Math.abs(type.length * 7)}_${overrides.suffix ?? '1'}`,
    type,
    data: {
      object: {
        id: 'cs_test_1',
        payment_status: 'paid',
        payment_intent: 'pi_test_1',
        metadata: { applicationId: 'app-1', eventId: 'event-1' },
        ...overrides.object,
      },
    },
  };
}

try {
  /* ---------------------------------------------------------------- */
  section('署名ヘッダーの解析');

  const parsed = parseSignatureHeader('t=1614556800,v1=abc,v1=def');
  check('時刻を取り出す', parsed.timestamp === 1614556800, parsed.timestamp);
  check('署名を複数取り出す（鍵の入れ替え期間に備える）',
    parsed.signatures.length === 2, parsed.signatures.length);

  const headerErrors = [
    { name: 'ヘッダーが空', header: '' },
    { name: 'ヘッダーが未指定', header: undefined },
    { name: '時刻がない', header: 'v1=abc' },
    { name: '署名がない', header: 't=1614556800' },
    { name: '時刻が数値でない', header: 't=abc,v1=def' },
  ];

  headerErrors.forEach(({ name, header }) => {
    let threw = false;

    try {
      parseSignatureHeader(header);
    } catch {
      threw = true;
    }

    check(`${name}なら例外`, threw);
  });

  /* ---------------------------------------------------------------- */
  section('署名の検証');

  const payload = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed' });
  const header = signPayload(payload, SECRET, NOW);

  check('正しい署名は通る',
    verifyStripeSignature({ payload, header, secret: SECRET, nowSeconds: NOW }) === true);

  const rejections = [
    {
      name: '本文を書き換えた通知',
      input: { payload: payload.replace('evt_1', 'evt_2'), header, secret: SECRET },
    },
    {
      name: '別のシークレットで署名された通知',
      input: { payload, header: signPayload(payload, 'whsec_other', NOW), secret: SECRET },
    },
    {
      name: '署名が16進数でない',
      input: { payload, header: `t=${NOW},v1=zzzz`, secret: SECRET },
    },
    {
      name: '署名の長さが違う',
      input: { payload, header: `t=${NOW},v1=abcd`, secret: SECRET },
    },
    {
      name: 'シークレット未設定',
      input: { payload, header, secret: '' },
    },
    {
      name: '本文が文字列でない（整形済みオブジェクト）',
      input: { payload: { id: 'evt_1' }, header, secret: SECRET },
    },
  ];

  rejections.forEach(({ name, input }) => {
    let threw = false;

    try {
      verifyStripeSignature({ ...input, nowSeconds: NOW });
    } catch {
      threw = true;
    }

    check(`${name}を拒否する`, threw);
  });

  /* 古い通知の使い回し（リプレイ）。 */
  const oldHeader = signPayload(payload, SECRET, NOW - DEFAULT_TOLERANCE_SECONDS - 1);

  let replayThrew = false;

  try {
    verifyStripeSignature({ payload, header: oldHeader, secret: SECRET, nowSeconds: NOW });
  } catch {
    replayThrew = true;
  }

  check('許容時間を過ぎた通知を拒否する', replayThrew);

  check('許容時間内なら通る',
    verifyStripeSignature({
      payload,
      header: signPayload(payload, SECRET, NOW - DEFAULT_TOLERANCE_SECONDS + 10),
      secret: SECRET,
      nowSeconds: NOW,
    }) === true);

  check('複数の署名のうち1つ合えば通る',
    verifyStripeSignature({
      payload,
      header: `t=${NOW},v1=${'0'.repeat(64)},${signPayload(payload, SECRET, NOW).split(',')[1]}`,
      secret: SECRET,
      nowSeconds: NOW,
    }) === true);

  /* ---------------------------------------------------------------- */
  section('イベントの読み取り');

  check('id と type を取り出す',
    parseStripeEvent(payload).type === 'checkout.session.completed');

  let parseThrew = false;

  try {
    parseStripeEvent(JSON.stringify({ foo: 'bar' }));
  } catch {
    parseThrew = true;
  }

  check('id と type がなければ例外', parseThrew);

  /* ---------------------------------------------------------------- */
  section('対象イベントの種別（仕様書5.3）');

  [
    'checkout.session.completed',
    'checkout.session.async_payment_succeeded',
    'checkout.session.async_payment_failed',
    'checkout.session.expired',
    'charge.refunded',
  ].forEach((type) => {
    check(`${type} を処理対象にしている`, HANDLED_EVENT_TYPES.includes(type));
  });

  check('対象は5種類だけ', HANDLED_EVENT_TYPES.length === 5, HANDLED_EVENT_TYPES.length);

  const other = createFakeDb();
  const otherResult = await handleStripeEvent({
    event: { id: 'evt_x', type: 'payment_intent.created', data: { object: {} } },
    config: {}, db: other, mailer: createFakeMailer(),
  });

  check('対象外の種別は記録もしない',
    otherResult.handled === false && other.state.webhookIds.size === 0);

  /* ---------------------------------------------------------------- */
  section('支払完了（受入条件4）');

  const paidDb = createFakeDb();
  const paidMailer = createFakeMailer();

  const paidResult = await handleStripeEvent({
    event: sessionEvent('checkout.session.completed'),
    config: {}, db: paidDb, mailer: paidMailer,
  });

  check('処理した', paidResult.handled === true, paidResult.result);
  check('申込が支払済みになる', paidDb.state.application.status === 'paid');
  check('支払記録が succeeded になる', paidDb.state.payment.payment_status === 'succeeded');
  check('PaymentIntent の ID を記録する',
    paidDb.state.payment.stripe_payment_intent_id === 'pi_test_1');
  check('支払日時を記録する', typeof paidDb.state.payment.paid_at === 'string');
  check('受付番号を発行する', paidDb.state.application.receipt_number === 'TSAM-0001');
  check('参加確定メールを送る', paidMailer.sent.length === 1, paidMailer.sent.length);
  check('メールの宛先は申込者', paidMailer.sent[0].to === 'taro@example.com');
  check('件名に受付番号が入る', paidMailer.sent[0].subject.includes('TSAM-0001'));
  check('件名に開催日が入る（開催日が複数あるため）',
    paidMailer.sent[0].subject.includes('2026年8月30日'), paidMailer.sent[0].subject);
  check('本文に名札の案内が入る', paidMailer.sent[0].text.includes('名札を着用いただきます'));
  check('メール送信を記録する',
    paidDb.state.emailLogs.length === 1 && paidDb.state.emailLogs[0].status === 'sent');
  check('処理結果を記録する', paidDb.state.processedResults.length === 1);

  /* ---------------------------------------------------------------- */
  section('同じイベントを2回受ける（受入条件5）');

  const twiceDb = createFakeDb();
  const twiceMailer = createFakeMailer();
  const sameEvent = sessionEvent('checkout.session.completed');

  await handleStripeEvent({ event: sameEvent, config: {}, db: twiceDb, mailer: twiceMailer });
  const second = await handleStripeEvent({
    event: sameEvent, config: {}, db: twiceDb, mailer: twiceMailer,
  });

  check('2回目は処理済みとして扱う', second.duplicate === true);
  check('受付番号の発行は1回だけ', twiceDb.state.receiptAssignments === 1,
    twiceDb.state.receiptAssignments);
  check('メールは1通だけ', twiceMailer.sent.length === 1, twiceMailer.sent.length);
  check('メールの記録も1件だけ', twiceDb.state.emailLogs.length === 1);

  /* ---------------------------------------------------------------- */
  section('PayPay想定の経路（受入条件7）');

  /* 1通目：completed だが未確定。 */
  const asyncDb = createFakeDb();
  const asyncMailer = createFakeMailer();

  const pending = await handleStripeEvent({
    event: sessionEvent('checkout.session.completed', {
      suffix: 'a', object: { payment_status: 'unpaid' },
    }),
    config: {}, db: asyncDb, mailer: asyncMailer,
  });

  check('未確定では支払済みにしない', asyncDb.state.application.status !== 'paid',
    asyncDb.state.application.status);
  check('未確定では受付番号を発行しない', asyncDb.state.application.receipt_number === null);
  check('未確定ではメールを送らない', asyncMailer.sent.length === 0);
  check('待機した旨を記録する', pending.result.includes('待機'), pending.result);

  /* 2通目：async_payment_succeeded で確定。 */
  await handleStripeEvent({
    event: sessionEvent('checkout.session.async_payment_succeeded', { suffix: 'b' }),
    config: {}, db: asyncDb, mailer: asyncMailer,
  });

  check('確定通知で支払済みになる', asyncDb.state.application.status === 'paid');
  check('確定通知で受付番号が出る', asyncDb.state.application.receipt_number === 'TSAM-0001');
  check('確定通知でメールが届く', asyncMailer.sent.length === 1);

  /* ---------------------------------------------------------------- */
  section('支払の失敗と期限切れ');

  const failedDb = createFakeDb();
  const failedMailer = createFakeMailer();

  await handleStripeEvent({
    event: sessionEvent('checkout.session.async_payment_failed'),
    config: {}, db: failedDb, mailer: failedMailer,
  });

  check('決済失敗になる', failedDb.state.application.status === 'failed');
  check('支払記録も failed', failedDb.state.payment.payment_status === 'failed');
  check('受付番号は発行しない', failedDb.state.application.receipt_number === null);
  check('メールは送らない', failedMailer.sent.length === 0);

  const expiredDb = createFakeDb();
  const expiredMailer = createFakeMailer();

  await handleStripeEvent({
    event: sessionEvent('checkout.session.expired'),
    config: {}, db: expiredDb, mailer: expiredMailer,
  });

  check('決済期限切れになる', expiredDb.state.application.status === 'expired');
  check('支払記録も expired', expiredDb.state.payment.payment_status === 'expired');
  check('期限切れでメールは送らない', expiredMailer.sent.length === 0);

  /* ---------------------------------------------------------------- */
  section('手動返金の反映（受入条件9）');

  const refundDb = createFakeDb();
  refundDb.state.payment.stripe_payment_intent_id = 'pi_test_1';
  refundDb.state.payment.payment_status = 'succeeded';

  await handleStripeEvent({
    event: {
      id: 'evt_refund_1',
      type: 'charge.refunded',
      data: { object: { id: 'ch_1', payment_intent: 'pi_test_1', amount_refunded: 4400 } },
    },
    config: {}, db: refundDb, mailer: createFakeMailer(),
  });

  check('支払記録が refunded になる', refundDb.state.payment.payment_status === 'refunded');
  check('返金額を記録する', refundDb.state.payment.refunded_amount === 4400);
  check('返金日時を記録する', typeof refundDb.state.payment.refunded_at === 'string');
  check('申込が返金済み（例外対応）になる', refundDb.state.application.status === 'refunded');

  const unknownRefundDb = createFakeDb();
  const unknownRefund = await handleStripeEvent({
    event: {
      id: 'evt_refund_2',
      type: 'charge.refunded',
      data: { object: { id: 'ch_2', payment_intent: 'pi_unknown' } },
    },
    config: {}, db: unknownRefundDb, mailer: createFakeMailer(),
  });

  check('対応する支払記録が無ければ何もしない',
    unknownRefund.result.includes('見つかりません'), unknownRefund.result);

  /* ---------------------------------------------------------------- */
  section('メール送信が失敗した場合');

  const mailFailDb = createFakeDb();
  const failingMailer = createFakeMailer({ failWith: '送信できませんでした（HTTP 403）' });

  const mailFail = await handleStripeEvent({
    event: sessionEvent('checkout.session.completed'),
    config: {}, db: mailFailDb, mailer: failingMailer,
  });

  check('支払の記録は残る', mailFailDb.state.payment.payment_status === 'succeeded');
  check('受付番号も残る', mailFailDb.state.application.receipt_number === 'TSAM-0001');
  check('申込は支払済みのまま', mailFailDb.state.application.status === 'paid');
  check('例外にせず処理を完了する', mailFail.handled === true);
  check('失敗を記録する',
    mailFailDb.state.emailLogs[0].status.startsWith('failed:'),
    mailFailDb.state.emailLogs[0].status);
  check('処理結果にも残す', mailFail.result.includes('失敗'), mailFail.result);

  /* メール送信が未設定でも支払の記録は進む。 */
  const noMailerDb = createFakeDb();
  const noMailer = await handleStripeEvent({
    event: sessionEvent('checkout.session.completed'),
    config: {}, db: noMailerDb, mailer: null,
  });

  check('メール未設定でも支払済みにする', noMailerDb.state.application.status === 'paid');
  check('見送った旨を記録する',
    noMailerDb.state.emailLogs[0].status.startsWith('skipped:'),
    noMailerDb.state.emailLogs[0].status);
  check('処理は完了扱い', noMailer.handled === true);

  /* ---------------------------------------------------------------- */
  section('metadata が欠けている場合');

  const noMetaDb = createFakeDb();
  const noMeta = await handleStripeEvent({
    event: sessionEvent('checkout.session.completed', { object: { metadata: {} } }),
    config: {}, db: noMetaDb, mailer: createFakeMailer(),
  });

  check('何もせずに終える', noMetaDb.state.application.status === 'awaiting');
  check('理由を記録する', noMeta.result.includes('metadata'), noMeta.result);

  /* ---------------------------------------------------------------- */
  section('処理中に失敗した場合');

  const brokenDb = createFakeDb();
  brokenDb.updateApplicationStatus = async () => {
    throw new Error('DBに接続できません');
  };

  let handlerError = null;

  try {
    await handleStripeEvent({
      event: sessionEvent('checkout.session.completed'),
      config: {}, db: brokenDb, mailer: createFakeMailer(),
    });
  } catch (error) {
    handlerError = error;
  }

  check('例外を投げ直す（Stripeの再送に任せる）', handlerError instanceof Error);
  check('失敗した旨を記録する',
    brokenDb.state.processedResults.some((r) => r.result.startsWith('失敗:')),
    JSON.stringify(brokenDb.state.processedResults));

  /* ---------------------------------------------------------------- */
  section('カレンダーへの人数の書き戻し');

  const noteDb = createFakeDb();
  const note = createFakeCalendarNote();

  const noteResult = await handleStripeEvent({
    event: sessionEvent('checkout.session.completed'),
    config: {}, db: noteDb, mailer: createFakeMailer(), calendarNote: note,
  });

  check('支払確定で1回だけ書き戻す', note.written.length === 1, note.written.length);
  check('書き戻す先はカレンダー予定のID',
    note.written[0].googleCalendarEventId === 'gcal-1', note.written[0].googleCalendarEventId);
  check('支払済みの件数を渡す', note.written[0].paidCount === 4, note.written[0].paidCount);
  check('定員も渡す', note.written[0].capacity === 30, note.written[0].capacity);
  check('更新時刻を渡す', note.written[0].now instanceof Date);
  check('名簿を渡す', note.written[0].attendees.length === 4, note.written[0].attendees.length);
  check('名簿は受付番号と氏名だけ（列名はキャメルケースへ寄せる）',
    note.written[0].attendees[0].receiptNumber === 'TSAM-0001'
      && note.written[0].attendees[0].name === '山田 太郎'
      && Object.keys(note.written[0].attendees[0]).length === 2,
    JSON.stringify(note.written[0].attendees[0]));
  check('結果に人数と名簿の件数を残す',
    noteResult.result.includes('カレンダーに支払済み4名（名簿4件）を書き戻しました'),
    noteResult.result);

  /* 返金でも書き戻す（席が空くため）。 */
  const refundNoteDb = createFakeDb();
  refundNoteDb.state.payment.stripe_payment_intent_id = 'pi_test_1';
  refundNoteDb.state.payment.payment_status = 'succeeded';
  refundNoteDb.state.paidCount = 3;
  /* 返金された1名は status が paid でなくなるため、名簿からも消える。 */
  refundNoteDb.state.attendees = refundNoteDb.state.attendees.slice(0, 3);
  const refundNote = createFakeCalendarNote();

  const refundNoteResult = await handleStripeEvent({
    event: {
      id: 'evt_refund_note',
      type: 'charge.refunded',
      data: { object: { id: 'ch_3', payment_intent: 'pi_test_1', amount_refunded: 4400 } },
    },
    config: {}, db: refundNoteDb, mailer: null, calendarNote: refundNote,
  });

  check('返金でも書き戻す', refundNote.written.length === 1);
  check('返金後の人数を渡す', refundNote.written[0].paidCount === 3);
  check('返金された1名は名簿から消える',
    refundNote.written[0].attendees.length === 3
      && !refundNote.written[0].attendees.some((row) => row.receiptNumber === 'TSAM-0004'),
    JSON.stringify(refundNote.written[0].attendees));
  check('返金の結果にも残す',
    refundNoteResult.result.includes('カレンダーに支払済み3名（名簿3件）を書き戻しました'),
    refundNoteResult.result);

  /* 支払が成立しなかった経路では書き戻さない（人数が変わらないため）。 */
  const failNoteDb = createFakeDb();
  const failNote = createFakeCalendarNote();

  await handleStripeEvent({
    event: sessionEvent('checkout.session.expired'),
    config: {}, db: failNoteDb, mailer: null, calendarNote: failNote,
  });

  check('期限切れでは書き戻さない', failNote.written.length === 0);

  /* 同じイベントの2回目は、既存の冪等機構でここまで来ない。 */
  const twiceNoteDb = createFakeDb();
  const twiceNote = createFakeCalendarNote();
  const sameNoteEvent = sessionEvent('checkout.session.completed', { suffix: 'note' });

  await handleStripeEvent({
    event: sameNoteEvent, config: {}, db: twiceNoteDb, mailer: null, calendarNote: twiceNote,
  });
  await handleStripeEvent({
    event: sameNoteEvent, config: {}, db: twiceNoteDb, mailer: null, calendarNote: twiceNote,
  });

  check('同じ通知を2回受けても書き戻しは1回だけ',
    twiceNote.written.length === 1, twiceNote.written.length);

  /* ---------------------------------------------------------------- */
  section('カレンダーへの書き戻しが失敗した場合');

  const noteFailDb = createFakeDb();
  const noteFailMailer = createFakeMailer();

  const noteFail = await handleStripeEvent({
    event: sessionEvent('checkout.session.completed'),
    config: {}, db: noteFailDb, mailer: noteFailMailer,
    calendarNote: createFakeCalendarNote({
      failWith: 'カレンダー予定を更新できませんでした（HTTP 403）',
    }),
  });

  check('支払の記録は残る', noteFailDb.state.payment.payment_status === 'succeeded');
  check('受付番号も残る', noteFailDb.state.application.receipt_number === 'TSAM-0001');
  check('申込は支払済みのまま', noteFailDb.state.application.status === 'paid');
  check('参加確定メールは送られる', noteFailMailer.sent.length === 1);
  check('例外にせず処理を完了する', noteFail.handled === true);
  check('失敗を結果に残す',
    noteFail.result.includes('カレンダーへの書き戻しに失敗'), noteFail.result);
  check('処理済みとして記録する',
    noteFailDb.state.processedResults[0].result.includes('カレンダーへの書き戻しに失敗'));

  /* DB側（件数の取得）が失敗しても同じ扱いにする。 */
  const countFailDb = createFakeDb();
  countFailDb.countPaidApplications = async () => {
    throw new Error('件数を取得できませんでした（HTTP 500）');
  };

  const countFail = await handleStripeEvent({
    event: sessionEvent('checkout.session.completed'),
    config: {}, db: countFailDb, mailer: null, calendarNote: createFakeCalendarNote(),
  });

  check('件数を数えられなくても支払は確定したまま',
    countFailDb.state.application.status === 'paid' && countFail.handled === true);
  check('件数の失敗も結果に残す',
    countFail.result.includes('カレンダーへの書き戻しに失敗'), countFail.result);

  /* 名簿の取得が失敗した場合も同じ（支払は確定したまま）。 */
  const rosterFailDb = createFakeDb();
  rosterFailDb.listPaidAttendees = async () => {
    throw new Error('データベース操作に失敗しました（HTTP 500）');
  };

  const rosterFail = await handleStripeEvent({
    event: sessionEvent('checkout.session.completed'),
    config: {}, db: rosterFailDb, mailer: null, calendarNote: createFakeCalendarNote(),
  });

  check('名簿を取れなくても支払は確定したまま',
    rosterFailDb.state.application.status === 'paid' && rosterFail.handled === true);
  check('名簿の失敗も結果に残す',
    rosterFail.result.includes('カレンダーへの書き戻しに失敗'), rosterFail.result);

  /* ---------------------------------------------------------------- */
  section('書き戻しを行わない場合');

  /* 書き込み用トークンが未設定の環境（route.ts が null を渡す）。 */
  const noNoteDb = createFakeDb();
  const noNote = await handleStripeEvent({
    event: sessionEvent('checkout.session.completed'),
    config: {}, db: noNoteDb, mailer: null, calendarNote: null,
  });

  check('未設定でも支払済みにする', noNoteDb.state.application.status === 'paid');
  check('見送った旨を記録する',
    noNote.result.includes('カレンダーへの書き戻しは未設定のため見送りました'), noNote.result);

  /* 引数ごと渡されない場合も同じ（既定は未設定扱い）。 */
  const omittedDb = createFakeDb();
  const omitted = await handleStripeEvent({
    event: sessionEvent('checkout.session.completed'),
    config: {}, db: omittedDb, mailer: null,
  });

  check('引数が無くても落ちない', omitted.handled === true);
  check('引数が無い場合も見送りとして記録する',
    omitted.result.includes('見送りました'), omitted.result);

  /* 手で登録した回（カレンダー連動ではない）。 */
  const manualDb = createFakeDb();
  manualDb.state.event.google_calendar_event_id = null;
  const manualNote = createFakeCalendarNote();

  const manual = await handleStripeEvent({
    event: sessionEvent('checkout.session.completed'),
    config: {}, db: manualDb, mailer: null, calendarNote: manualNote,
  });

  check('手動登録の回では書き戻さない', manualNote.written.length === 0);
  check('支払は通常どおり確定する', manualDb.state.application.status === 'paid');
  check('対象外として記録する',
    manual.result.includes('カレンダーへの書き戻しは対象外'), manual.result);

  finish();
} catch (error) {
  fatal(error);
}

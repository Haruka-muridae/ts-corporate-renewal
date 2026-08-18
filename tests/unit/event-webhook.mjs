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
      return id === EVENT_ROW.id ? { ...EVENT_ROW } : null;
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

  finish();
} catch (error) {
  fatal(error);
}

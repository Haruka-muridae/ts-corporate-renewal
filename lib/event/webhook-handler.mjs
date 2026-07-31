/*
 * Stripe Webhook の処理（実装仕様書 5.3 / 5.4）。
 *
 * ==================================================================
 * 方針
 * ==================================================================
 *   - 署名の検証は呼び出し側（ルートハンドラ）で済ませてから渡す。
 *     ここは「検証済みのイベント」だけを受け取る。
 *   - 冪等性は webhook_events の一意制約で担保する。
 *     2回目以降は何もせず終わる（受入条件5）。
 *   - 支払済みへの更新・受付番号の発行・参加確定メールは、この順で行う。
 *     メールの失敗で支払の記録を巻き戻さない。支払は成立しているため。
 *   - 依存（DB・メール送信）は引数で受け取る。テストで差し替えられるようにする。
 * ==================================================================
 */

import { buildConfirmationMail } from './mail/confirmation.mjs';
import { calculatePrice } from './pricing.mjs';

/** 処理対象のイベント種別（仕様書5.3）。 */
export const HANDLED_EVENT_TYPES = [
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed',
  'checkout.session.expired',
  'charge.refunded',
];

/*
 * 支払を確定させる。
 *
 * checkout.session.completed と async_payment_succeeded の両方から呼ぶ。
 * どちらの経路でも同じ結果になる（受入条件7）。
 */
async function markPaid({ config, db, mailer, session }) {
  const applicationId = session.metadata?.applicationId;

  if (!applicationId) {
    return '申込IDがmetadataにないため何もしませんでした';
  }

  const application = await db.findApplicationById(config, applicationId);

  if (application === null) {
    return `申込が見つかりません（${applicationId}）`;
  }

  const payment = await db.findPaymentByApplicationId(config, applicationId);

  if (payment !== null) {
    await db.updatePayment(config, payment.id, {
      payment_status: 'succeeded',
      paid_at: new Date().toISOString(),
      stripe_payment_intent_id:
        typeof session.payment_intent === 'string'
          ? session.payment_intent
          : (session.payment_intent?.id ?? null),
      stripe_checkout_session_id: session.id,
    });
  }

  /* 受付番号は支払済みになった時点で発行する。すでにあれば同じ番号が返る。 */
  const receiptNumber = await db.assignReceiptNumber(config, applicationId);

  await db.updateApplicationStatus(config, applicationId, 'paid');

  const mailResult = await sendConfirmationMail({
    config,
    db,
    mailer,
    application: { ...application, receipt_number: receiptNumber },
  });

  return `支払済みに更新（受付番号 ${receiptNumber}）／${mailResult}`;
}

/*
 * 参加確定メールを送る。
 *
 * 送信に失敗しても例外にしない。ここで失敗を投げると Stripe が再送し、
 * 支払の記録まで何度もやり直すことになる。失敗は email_logs に残し、
 * 管理画面から送り直せるようにする。
 */
async function sendConfirmationMail({ config, db, mailer, application }) {
  if (mailer === null || mailer === undefined) {
    await db.insertEmailLog(config, {
      applicationId: application.id,
      mailType: 'confirmation',
      status: 'skipped:未設定',
    });

    return 'メール送信は未設定のため見送りました';
  }

  try {
    const event = await db.findEventById(config, application.event_id);

    const breakdown = calculatePrice({
      industry: application.industry,
      occupation: application.occupation,
      position: application.position,
      ageGroup: application.age_group,
      isBannedDeclared: application.is_banned_declared,
    });

    const mail = buildConfirmationMail({
      event: {
        name: event.name,
        startAt: event.event_date,
        /* 終了時刻は任意。無ければ開始時刻だけを出す。 */
        endAt: event.event_end_at ?? null,
        venue: event.venue,
      },
      application: {
        name: application.name,
        receiptNumber: application.receipt_number,
        industry: application.industry,
        occupation: application.occupation,
        position: application.position,
        ageGroup: application.age_group,
      },
      payment: breakdown,
    });

    await mailer.send({
      to: application.email,
      subject: mail.subject,
      text: mail.text,
    });

    await db.insertEmailLog(config, {
      applicationId: application.id,
      mailType: 'confirmation',
      status: 'sent',
    });

    return 'メール送信済み';
  } catch (error) {
    await db.insertEmailLog(config, {
      applicationId: application.id,
      mailType: 'confirmation',
      status: `failed:${String(error.message).slice(0, 200)}`,
    });

    return `メール送信に失敗（${error.message}）`;
  }
}

/** 支払が成立しなかったときの更新。 */
async function markNotPaid({ config, db, session, applicationStatus, paymentStatus }) {
  const applicationId = session.metadata?.applicationId;

  if (!applicationId) {
    return '申込IDがmetadataにないため何もしませんでした';
  }

  const payment = await db.findPaymentByApplicationId(config, applicationId);

  if (payment !== null) {
    await db.updatePayment(config, payment.id, { payment_status: paymentStatus });
  }

  await db.updateApplicationStatus(config, applicationId, applicationStatus);

  return `${applicationStatus} に更新しました`;
}

/*
 * 返金。アプリに返金機能は作らず、Stripeダッシュボードからの手動返金を
 * 反映するだけ（仕様書7.1、受入条件9）。
 */
async function markRefunded({ config, db, charge }) {
  const paymentIntentId =
    typeof charge.payment_intent === 'string'
      ? charge.payment_intent
      : (charge.payment_intent?.id ?? null);

  if (!paymentIntentId) {
    return 'PaymentIntentが特定できないため何もしませんでした';
  }

  const payment = await db.findPaymentByPaymentIntentId(config, paymentIntentId);

  if (payment === null) {
    return `支払記録が見つかりません（${paymentIntentId}）`;
  }

  await db.updatePayment(config, payment.id, {
    payment_status: 'refunded',
    refunded_amount: charge.amount_refunded ?? null,
    refunded_at: new Date().toISOString(),
  });

  await db.updateApplicationStatus(config, payment.application_id, 'refunded');

  return '返金済み（例外対応）に更新しました';
}

/**
 * 検証済みのStripeイベントを処理する。
 *
 * @param {{
 *   event: object,
 *   config: object,
 *   db: object,
 *   mailer: { send: (message: object) => Promise<unknown> } | null,
 * }} input
 * @returns {Promise<{ handled: boolean, duplicate: boolean, result: string }>}
 */
export async function handleStripeEvent({ event, config, db, mailer }) {
  if (!HANDLED_EVENT_TYPES.includes(event.type)) {
    /*
     * 対象外の種別は記録もせずに終える。
     * Stripe 側の設定で余分な種別が届いても、200 を返して再送を止める。
     */
    return { handled: false, duplicate: false, result: `対象外の種別（${event.type}）` };
  }

  /* 先に記録を試み、一意制約違反なら処理済みとみなす。 */
  const { duplicate } = await db.insertWebhookEvent(config, {
    stripeEventId: event.id,
    eventType: event.type,
  });

  if (duplicate) {
    return { handled: false, duplicate: true, result: '処理済みのイベントのため何もしませんでした' };
  }

  let result;

  try {
    const object = event.data?.object ?? {};

    switch (event.type) {
      case 'checkout.session.completed':
        /*
         * PayPay のようなリダイレクト型では、この時点ではまだ支払が
         * 確定していない（payment_status が unpaid）。確定は
         * async_payment_succeeded を待つ（仕様書5.3、受入条件7）。
         */
        result = object.payment_status === 'paid'
          ? await markPaid({ config, db, mailer, session: object })
          : `支払未確定のため待機します（payment_status=${object.payment_status}）`;
        break;

      case 'checkout.session.async_payment_succeeded':
        result = await markPaid({ config, db, mailer, session: object });
        break;

      case 'checkout.session.async_payment_failed':
        result = await markNotPaid({
          config, db, session: object,
          applicationStatus: 'failed', paymentStatus: 'failed',
        });
        break;

      case 'checkout.session.expired':
        result = await markNotPaid({
          config, db, session: object,
          applicationStatus: 'expired', paymentStatus: 'expired',
        });
        break;

      case 'charge.refunded':
        result = await markRefunded({ config, db, charge: object });
        break;

      default:
        result = '対象外';
    }
  } catch (error) {
    /*
     * 失敗した記録を残してから投げ直す。処理済みの印は付けないため、
     * Stripe の再送で処理をやり直せる。
     */
    await db.markWebhookProcessed(config, event.id, `失敗: ${error.message}`)
      .catch(() => {});

    throw error;
  }

  await db.markWebhookProcessed(config, event.id, result);

  return { handled: true, duplicate: false, result };
}

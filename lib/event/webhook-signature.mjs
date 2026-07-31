/*
 * Stripe Webhook の署名検証（実装仕様書 5.3、受入条件12）。
 *
 * ==================================================================
 * 何を防ぐか
 * ==================================================================
 *   Webhook のURLを知っていれば誰でもPOSTできる。署名を検証しないと、
 *   「支払済みになりました」という偽の通知で受付番号の発行と
 *   参加確定メールの送信を起こせてしまう。
 *
 *   Stripe は次の形式のヘッダーを付けてくる。
 *     Stripe-Signature: t=1614556800,v1=<16進>,v1=<16進>
 *
 *   署名対象は「<t>.<リクエストの生の本文>」。
 *   本文はJSONに変換する前の文字列をそのまま使う（整形すると一致しない）。
 * ==================================================================
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

/** 既定の許容時間（秒）。Stripe の推奨値に合わせる。 */
export const DEFAULT_TOLERANCE_SECONDS = 300;

/** ヘッダーを t と v1 の一覧に分解する。 */
export function parseSignatureHeader(header) {
  if (typeof header !== 'string' || header === '') {
    throw new Error('署名ヘッダーがありません');
  }

  let timestamp = null;
  const signatures = [];

  header.split(',').forEach((part) => {
    const index = part.indexOf('=');

    if (index < 0) {
      return;
    }

    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();

    if (key === 't') {
      timestamp = value;
    } else if (key === 'v1') {
      /* 鍵の入れ替え期間中は v1 が複数並ぶ。どれか1つが合えばよい。 */
      signatures.push(value);
    }
  });

  if (timestamp === null || !/^[0-9]+$/.test(timestamp)) {
    throw new Error('署名ヘッダーに時刻が含まれていません');
  }

  if (signatures.length === 0) {
    throw new Error('署名ヘッダーに署名が含まれていません');
  }

  return { timestamp: Number(timestamp), signatures };
}

/*
 * 長さが違う場合に timingSafeEqual は例外を投げる。
 * 先に長さを比べ、同じときだけ定数時間で比較する。
 */
function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) {
    return false;
  }

  if (!/^[0-9a-f]+$/i.test(b)) {
    return false;
  }

  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

/**
 * 署名を検証する。合わなければ例外にする。
 *
 * @param {{
 *   payload: string,   リクエストの生の本文
 *   header: string,    Stripe-Signature ヘッダー
 *   secret: string,    Webhook シークレット（whsec_…）
 *   toleranceSeconds?: number,
 *   nowSeconds?: number,
 * }} input
 * @returns {true}
 */
export function verifyStripeSignature({
  payload,
  header,
  secret,
  toleranceSeconds = DEFAULT_TOLERANCE_SECONDS,
  nowSeconds,
}) {
  if (!secret) {
    throw new Error('Webhookシークレットが設定されていません');
  }

  if (typeof payload !== 'string') {
    throw new Error('本文は文字列で渡してください（整形前の生の本文）');
  }

  const { timestamp, signatures } = parseSignatureHeader(header);

  const expected = createHmac('sha256', secret)
    .update(`${timestamp}.${payload}`, 'utf8')
    .digest('hex');

  if (!signatures.some((candidate) => safeEqualHex(expected, candidate))) {
    throw new Error('署名が一致しません');
  }

  /*
   * 署名が合っていても、古い通知の使い回し（リプレイ）は受け付けない。
   * 署名の一致を先に見るのは、時刻だけで弾いた場合に
   * 「鍵は合っているのか」を攻撃者に推測させないため。
   */
  const now = nowSeconds ?? Math.floor(Date.now() / 1000);

  if (Math.abs(now - timestamp) > toleranceSeconds) {
    throw new Error('署名の時刻が許容範囲を超えています');
  }

  return true;
}

/** 検証済みの本文をイベントとして読む。 */
export function parseStripeEvent(payload) {
  const event = JSON.parse(payload);

  if (!event?.id || !event?.type) {
    throw new Error('Stripeイベントの形式が不正です');
  }

  return event;
}

/** テストと開発で署名を作るための補助。本番の送信元はStripe。 */
export function signPayload(payload, secret, timestamp) {
  const signature = createHmac('sha256', secret)
    .update(`${timestamp}.${payload}`, 'utf8')
    .digest('hex');

  return `t=${timestamp},v1=${signature}`;
}

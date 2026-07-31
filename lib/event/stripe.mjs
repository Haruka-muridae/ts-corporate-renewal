/*
 * Stripe Checkout Session の作成（実装仕様書 5.1 / 5.2）。
 *
 * ==================================================================
 * 方針
 * ==================================================================
 *   - Session は必ずサーバー側で作る。ブラウザから来た金額は一切使わない。
 *     この関数は「サーバーが計算した金額」だけを受け取る。
 *   - 外部ライブラリを足さず、fetch で Stripe の REST API を直接叩く。
 *     送信形式は application/x-www-form-urlencoded（Stripe の作法）。
 *   - JPY は最小通貨単位が円。unit_amount には円額をそのまま入れる。
 *     100倍しない。
 *   - 例外にシークレットキーを含めない。
 * ==================================================================
 */

const CHECKOUT_ENDPOINT = 'https://api.stripe.com/v1/checkout/sessions';

/*
 * 明細書表記のサフィックス（仕様書5.2）。
 *
 * このアカウントの標準表記は別事業向けのため、Session ごとに指定して
 * 「<短縮プレフィックス>* 参加費」の形で参加者のカード明細に出す。
 *
 * kana は半角カタカナで渡す。日本の決済網が半角カナを使うため、
 * 全角のまま送ると Stripe 側で弾かれる。
 */
export const STATEMENT_DESCRIPTOR_SUFFIX = 'EVENT';
export const STATEMENT_DESCRIPTOR_SUFFIX_KANJI = '参加費';
export const STATEMENT_DESCRIPTOR_SUFFIX_KANA = 'ｻﾝｶﾋ';

/*
 * ネストしたオブジェクトを Stripe の形式（a[b][c]=v）に平坦化する。
 * 配列は添字を明示する（line_items[0][price_data][...]）。
 */
export function toFormEncoded(params, prefix = '') {
  const pairs = [];

  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === null) {
      return;
    }

    const name = prefix === '' ? key : `${prefix}[${key}]`;

    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        const itemName = `${name}[${index}]`;

        if (item !== null && typeof item === 'object') {
          pairs.push(toFormEncoded(item, itemName));
        } else {
          pairs.push(`${encodeURIComponent(itemName)}=${encodeURIComponent(String(item))}`);
        }
      });

      return;
    }

    if (typeof value === 'object') {
      pairs.push(toFormEncoded(value, name));
      return;
    }

    pairs.push(`${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`);
  });

  return pairs.filter((pair) => pair !== '').join('&');
}

/**
 * Checkout Session に渡すパラメータを組み立てる。
 *
 * 金額は呼び出し側（サーバー）が計算した値をそのまま使う。
 * ここで割引を計算し直したり、引数以外の値を参照したりしない。
 *
 * @param {{
 *   eventName: string,
 *   amount: number,
 *   email: string,
 *   applicationId: string,
 *   eventId: string,
 *   successUrl: string,
 *   cancelUrl: string,
 * }} input
 */
export function buildCheckoutSessionParams({
  eventName,
  amount,
  email,
  applicationId,
  eventId,
  successUrl,
  cancelUrl,
}) {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new TypeError('金額が不正です');
  }

  if (!applicationId || !eventId) {
    throw new TypeError('申込IDとイベントIDは必須です');
  }

  return {
    mode: 'payment',
    /*
     * 決済手段はダッシュボードの設定に委ねる（仕様書4.4）。
     * payment_method_types を書かないことで automatic payment methods になり、
     * PayPay の審査が通れば、コードを変えずに選択肢へ現れる。
     */
    line_items: [
      {
        price_data: {
          currency: 'jpy',
          product_data: { name: eventName },
          /* JPY は円がそのまま最小単位。7,700円 → 7700。 */
          unit_amount: amount,
        },
        quantity: 1,
      },
    ],
    customer_email: email,
    metadata: { applicationId, eventId },
    /* Webhook から申込を引けるよう、PaymentIntent 側にも同じ印を付ける。 */
    payment_intent_data: {
      metadata: { applicationId, eventId },
      statement_descriptor_suffix: STATEMENT_DESCRIPTOR_SUFFIX,
    },
    /*
     * 日本語の明細書表記は payment_intent_data の直下ではなく、
     * カード決済の設定として渡す（直下に置くと unknown parameter で弾かれる）。
     */
    payment_method_options: {
      card: {
        statement_descriptor_suffix_kanji: STATEMENT_DESCRIPTOR_SUFFIX_KANJI,
        statement_descriptor_suffix_kana: STATEMENT_DESCRIPTOR_SUFFIX_KANA,
      },
    },
    success_url: successUrl,
    cancel_url: cancelUrl,
  };
}

/**
 * Checkout Session を作る。
 *
 * @param {Parameters<typeof buildCheckoutSessionParams>[0] & {
 *   secretKey: string,
 *   idempotencyKey?: string,
 *   fetchImpl?: typeof fetch,
 * }} options
 * @returns {Promise<{ id: string, url: string }>}
 */
export async function createCheckoutSession({
  secretKey,
  idempotencyKey,
  fetchImpl = fetch,
  ...input
}) {
  if (!secretKey) {
    throw new TypeError('Stripeのシークレットキーが設定されていません');
  }

  const body = toFormEncoded(buildCheckoutSessionParams(input));

  const headers = {
    Authorization: `Bearer ${secretKey}`,
    'Content-Type': 'application/x-www-form-urlencoded',
  };

  /*
   * 同じ申込で二重に Session を作らないための鍵。
   * 利用者が確認画面で「決済へ進む」を連打しても、Stripe 側が同じ Session を返す。
   */
  if (idempotencyKey) {
    headers['Idempotency-Key'] = idempotencyKey;
  }

  const response = await fetchImpl(CHECKOUT_ENDPOINT, { method: 'POST', headers, body });
  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    /*
     * Stripe が返すエラーの説明までは載せる（原因の特定に要る）。
     * キーやトークンは載せない。
     */
    const message = payload?.error?.message ?? '詳細不明';
    throw new Error(`Checkout Sessionを作成できませんでした（HTTP ${response.status}）: ${message}`);
  }

  if (!payload?.id || !payload?.url) {
    throw new Error('Checkout Sessionの応答が不正です');
  }

  return { id: payload.id, url: payload.url };
}

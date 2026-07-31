/*
 * Supabase（PostgREST）へのアクセス。
 *
 * ==================================================================
 * 方針
 * ==================================================================
 *   - service_role キーで呼ぶ。これらの表は RLS（ポリシーなし）と
 *     テーブル権限の両方で塞いであり、anon キーでは触れない。
 *     したがって、このモジュールはサーバー側からのみ読み込むこと。
 *   - 外部ライブラリを足さず fetch で REST を直接叩く。
 *   - 例外にキーを含めない。
 * ==================================================================
 */

/*
 * このモジュールはサーバー専用。
 * service role キーを受け取るため、クライアントコンポーネントから読み込まないこと
 * （読み込むとキーがブラウザ配信のバンドルに載る）。
 * 依存を増やさないため server-only パッケージは使わず、
 * 呼び出し側をサーバーアクションとサーバーコンポーネントに限定して守る。
 */

function headersFor(config, extra = {}) {
  return {
    apikey: config.serviceRoleKey,
    Authorization: `Bearer ${config.serviceRoleKey}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

async function request(config, path, options = {}) {
  const fetchImpl = config.fetchImpl ?? fetch;
  const response = await fetchImpl(`${config.url}/rest/v1/${path}`, {
    ...options,
    headers: headersFor(config, options.headers),
  });

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    const message = payload?.message ?? '詳細不明';
    throw new Error(`データベース操作に失敗しました（HTTP ${response.status}）: ${message}`);
  }

  return payload;
}

/**
 * 公開中のイベントを1件取る。
 * 申込を受け付けてよいイベントかどうかは呼び出し側で判断する。
 */
export async function findPublishedEvent(config) {
  const rows = await request(
    config,
    'events?is_published=eq.true&order=event_date.asc&limit=1',
  );

  return rows?.[0] ?? null;
}

/** イベントをIDで取る。 */
export async function findEventById(config, eventId) {
  const rows = await request(config, `events?id=eq.${encodeURIComponent(eventId)}&limit=1`);
  return rows?.[0] ?? null;
}

/**
 * 申込を作る。
 *
 * 金額はここでは扱わない。支払額は payments 側に、
 * サーバーが計算した内訳とともに保存する。
 */
export async function insertApplication(config, application) {
  const rows = await request(config, 'applications', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      event_id: application.eventId,
      name: application.name,
      name_kana: application.nameKana,
      email: application.email,
      phone: application.phone,
      company: application.company,
      department: application.department,
      job_title: application.jobTitle,
      industry: application.industry,
      industry_other_text: application.industryOtherText,
      occupation: application.occupation,
      occupation_other_text: application.occupationOtherText,
      position: application.position,
      age_group: application.ageGroup,
      is_banned_declared: application.isBannedDeclared,
      status: 'received',
      agreed_at: application.agreedAt,
      policy_version: application.policyVersion,
    }),
  });

  return rows?.[0] ?? null;
}

/** 申込をIDで取る。金額の再計算に使う。 */
export async function findApplicationById(config, applicationId) {
  const rows = await request(
    config,
    `applications?id=eq.${encodeURIComponent(applicationId)}&limit=1`,
  );

  return rows?.[0] ?? null;
}

/** 申込のステータスを変える。 */
export async function updateApplicationStatus(config, applicationId, status) {
  const rows = await request(
    config,
    `applications?id=eq.${encodeURIComponent(applicationId)}`,
    {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ status }),
    },
  );

  return rows?.[0] ?? null;
}

/**
 * 支払記録を作る。割引の内訳は申込時点のスナップショットとして列に残す。
 *
 * @param {object} config
 * @param {{ applicationId: string, breakdown: import('./pricing.mjs').PriceBreakdown }} input
 */
export async function insertPayment(config, { applicationId, breakdown }) {
  const rows = await request(config, 'payments', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      application_id: applicationId,
      base_price: breakdown.basePrice,
      discount_industry: breakdown.discountIndustry,
      discount_occupation: breakdown.discountOccupation,
      discount_position: breakdown.discountPosition,
      discount_age: breakdown.discountAge,
      discount_total: breakdown.discountTotal,
      final_price: breakdown.finalPrice,
      currency: 'jpy',
      payment_status: 'pending',
    }),
  });

  return rows?.[0] ?? null;
}

/** 申込に紐づく支払記録を取る。 */
export async function findPaymentByApplicationId(config, applicationId) {
  const rows = await request(
    config,
    `payments?application_id=eq.${encodeURIComponent(applicationId)}&order=created_at.desc&limit=1`,
  );

  return rows?.[0] ?? null;
}

/** Checkout Session の ID を支払記録に記録する。 */
export async function attachCheckoutSession(config, paymentId, sessionId) {
  const rows = await request(config, `payments?id=eq.${encodeURIComponent(paymentId)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ stripe_checkout_session_id: sessionId }),
  });

  return rows?.[0] ?? null;
}

/* ------------------------------------------------------------------ */
/* Webhook 用 */

/**
 * Webhook イベントを記録する。
 *
 * stripe_event_id に一意制約があるため、同じイベントを2回受けると
 * 2回目は一意制約違反になる。それを「すでに処理した」の判定に使う
 * （受入条件5）。件数を数えてから入れる方式にすると、同時に2回届いたときに
 * すり抜けるため、DBの制約で判定する。
 *
 * @returns {Promise<{ row: object | null, duplicate: boolean }>}
 */
export async function insertWebhookEvent(config, { stripeEventId, eventType }) {
  const fetchImpl = config.fetchImpl ?? fetch;

  const response = await fetchImpl(`${config.url}/rest/v1/webhook_events`, {
    method: 'POST',
    headers: headersFor(config, { Prefer: 'return=representation' }),
    body: JSON.stringify({
      stripe_event_id: stripeEventId,
      event_type: eventType,
      processed: false,
    }),
  });

  if (response.status === 409) {
    return { row: null, duplicate: true };
  }

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    /* 23505 = 一意制約違反。状態コードが409以外で返る場合に備える。 */
    if (payload?.code === '23505') {
      return { row: null, duplicate: true };
    }

    const message = payload?.message ?? '詳細不明';
    throw new Error(`Webhookイベントを記録できませんでした（HTTP ${response.status}）: ${message}`);
  }

  return { row: payload?.[0] ?? null, duplicate: false };
}

/** Webhook の処理結果を記録する。 */
export async function markWebhookProcessed(config, stripeEventId, result) {
  const rows = await request(
    config,
    `webhook_events?stripe_event_id=eq.${encodeURIComponent(stripeEventId)}`,
    {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      /* 結果の文言は運用時の手掛かり。長くなりすぎないよう切る。 */
      body: JSON.stringify({ processed: true, result: String(result).slice(0, 500) }),
    },
  );

  return rows?.[0] ?? null;
}

/** Checkout Session の ID から支払記録を引く。 */
export async function findPaymentBySessionId(config, sessionId) {
  const rows = await request(
    config,
    `payments?stripe_checkout_session_id=eq.${encodeURIComponent(sessionId)}&limit=1`,
  );

  return rows?.[0] ?? null;
}

/** PaymentIntent の ID から支払記録を引く（返金の通知用）。 */
export async function findPaymentByPaymentIntentId(config, paymentIntentId) {
  const rows = await request(
    config,
    `payments?stripe_payment_intent_id=eq.${encodeURIComponent(paymentIntentId)}&limit=1`,
  );

  return rows?.[0] ?? null;
}

/** 支払記録を更新する。 */
export async function updatePayment(config, paymentId, patch) {
  const rows = await request(config, `payments?id=eq.${encodeURIComponent(paymentId)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(patch),
  });

  return rows?.[0] ?? null;
}

/**
 * 受付番号を発行する。
 *
 * 採番はDB側の関数に任せる。イベント行のロックで直列化しており、
 * すでに発行済みなら同じ番号を返す（同じWebhookを2回受けても変わらない）。
 */
export async function assignReceiptNumber(config, applicationId) {
  const result = await request(config, 'rpc/assign_receipt_number', {
    method: 'POST',
    body: JSON.stringify({ p_application_id: applicationId }),
  });

  return typeof result === 'string' ? result : (result?.[0] ?? null);
}

/** メールの送信結果を記録する。 */
export async function insertEmailLog(config, { applicationId, mailType, status }) {
  const rows = await request(config, 'email_logs', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      application_id: applicationId,
      mail_type: mailType,
      status,
    }),
  });

  return rows?.[0] ?? null;
}

/* ------------------------------------------------------------------ */
/* 管理画面用 */

/*
 * 申込を支払記録つきで一覧する。
 *
 * PostgREST の埋め込み（payments(...)）で1回の問い合わせにまとめる。
 * 申込ごとに支払を引くと件数分の往復が発生するため。
 */
const APPLICATION_WITH_PAYMENT_SELECT =
  '*,payments(base_price,discount_industry,discount_occupation,discount_position,'
  + 'discount_age,discount_total,final_price,payment_status,paid_at,'
  + 'stripe_checkout_session_id,stripe_payment_intent_id,refunded_amount,refunded_at)';

export async function listApplications(config, { eventId = null } = {}) {
  const filter = eventId === null ? '' : `event_id=eq.${encodeURIComponent(eventId)}&`;

  const rows = await request(
    config,
    `applications?${filter}select=${encodeURIComponent(APPLICATION_WITH_PAYMENT_SELECT)}`
    + '&order=created_at.desc',
  );

  return rows ?? [];
}

/** 申込1件を支払記録つきで取る。 */
export async function findApplicationWithPayment(config, applicationId) {
  const rows = await request(
    config,
    `applications?id=eq.${encodeURIComponent(applicationId)}`
    + `&select=${encodeURIComponent(APPLICATION_WITH_PAYMENT_SELECT)}&limit=1`,
  );

  return rows?.[0] ?? null;
}

/**
 * 申込者情報を書き換える（譲渡対応、仕様書7.2）。
 *
 * 受付番号と支払額は変えない。譲渡先の属性が違っても差額の徴収・返金はしない。
 */
export async function updateApplicationFields(config, applicationId, patch) {
  const rows = await request(
    config,
    `applications?id=eq.${encodeURIComponent(applicationId)}`,
    {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(patch),
    },
  );

  return rows?.[0] ?? null;
}

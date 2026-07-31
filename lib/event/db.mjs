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

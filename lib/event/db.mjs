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

/*
 * 件数だけを数える。
 *
 * 上の request() は本文だけを返し、レスポンスヘッダーを捨てる。件数は
 * ヘッダーで返るため request() では取れない。既存の呼び出しに影響を出さない
 * よう、request() は変えずにこの関数を別に置く。
 *
 * Prefer: count=exact を付けると PostgREST が総件数を
 * Content-Range: <範囲>/<総数> で返す。HEAD で投げるので行そのものは
 * 転送されない（30件でも0件でも通信量は変わらない）。
 */
async function count(config, path) {
  const fetchImpl = config.fetchImpl ?? fetch;

  const response = await fetchImpl(`${config.url}/rest/v1/${path}`, {
    method: 'HEAD',
    headers: headersFor(config, { Prefer: 'count=exact' }),
  });

  if (!response.ok) {
    throw new Error(`件数を取得できませんでした（HTTP ${response.status}）`);
  }

  /* スラッシュの右が総数（例: "0-29/30" なら 30）。該当が無ければ 0 が返る。 */
  const range = response.headers?.get?.('content-range') ?? '';
  const total = Number(String(range).split('/')[1]);

  if (!Number.isInteger(total) || total < 0) {
    throw new Error(`件数を解釈できませんでした（Content-Range: ${range || 'なし'}）`);
  }

  return total;
}

/**
 * 支払済みの申込を数える（定員判定に使う）。
 *
 * 数えるのは status='paid' だけ。決済待ち（awaiting）は席として扱わない。
 * 返金されると status が 'refunded' に変わるため、この件数から自動的に外れ、
 * 席が再び空く。
 *
 * (event_id, status) の索引がそのまま効く。
 */
export async function countPaidApplications(config, eventId) {
  return count(
    config,
    `applications?event_id=eq.${encodeURIComponent(eventId)}&status=eq.paid`,
  );
}

/**
 * 複数の回の支払済み件数をまとめて数える（開催日一覧の表示用）。
 *
 * countPaidApplications を回ごとに呼ぶと、回の数だけ往復が増える
 * （公開APIは誰でも叩けるため、1リクエストがDBへのN回の問い合わせになる）。
 * ここでは支払済みの行の event_id だけを1回で取り、アプリ側で数える。
 * 転送するのは1件あたりUUID1つ分で、件数は定員（既定30名）×回数の程度。
 *
 * 表示のための概算として使う。申込・決済を止める最終判定は
 * countPaidApplications（DB側で数える正確な件数）が担うため、
 * PostgREST の最大行数で万一切り詰められても、席が過剰に売れることはない。
 *
 * @param {object} config
 * @param {string[]} eventIds
 * @returns {Promise<Record<string, number>>} 渡したID全てを含む（0件でも0を入れる）
 */
export async function countPaidApplicationsByEventIds(config, eventIds) {
  const ids = [...new Set(
    (eventIds ?? []).filter((id) => typeof id === 'string' && id !== ''),
  )];

  const counts = {};

  for (const id of ids) {
    counts[id] = 0;
  }

  if (ids.length === 0) {
    return counts;
  }

  const list = ids.map((id) => encodeURIComponent(id)).join(',');

  const rows = await request(
    config,
    `applications?select=event_id&status=eq.paid&event_id=in.(${list})`,
  );

  for (const row of rows ?? []) {
    if (typeof row?.event_id === 'string' && row.event_id in counts) {
      counts[row.event_id] += 1;
    }
  }

  return counts;
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

/* ------------------------------------------------------------------ */
/* カレンダー同期・複数開催日用 */

/*
 * ここから下は「開催日が複数ある」前提の関数群。
 * 単一開催を前提にした findPublishedEvent はそのまま残してある
 * （まだ参照している画面があるため、置き換えは呼び出し側ごとに行う）。
 */

/**
 * 公開中かつこれから開催される回を、開催日の早い順に並べる。
 *
 * 過去回をDB側で落としておく。全件を持ってきてアプリで捨てると、
 * 回が増えるほど無駄な転送が増えるため。
 */
export async function listPublishedUpcomingEvents(config, nowIso) {
  const rows = await request(
    config,
    'events?is_published=eq.true'
    + `&event_date=gte.${encodeURIComponent(nowIso)}`
    + '&order=event_date.asc',
  );

  return rows ?? [];
}

/**
 * 管理画面・同期処理のための全件取得（新しい開催日が先頭）。
 *
 * 公開の有無で絞らない。受付を止めた回も管理画面には出すため。
 * 同期処理は「消えた予定を止める」判定と、新しい回を作るときの
 * ひな型（先頭行）にこの一覧を使う。
 */
export async function listEventsForAdmin(config) {
  const rows = await request(config, 'events?order=event_date.desc');
  return rows ?? [];
}

/** カレンダー予定のIDからイベント行を引く。 */
export async function findEventByCalendarEventId(config, googleEventId) {
  const rows = await request(
    config,
    `events?google_calendar_event_id=eq.${encodeURIComponent(googleEventId)}&limit=1`,
  );

  return rows?.[0] ?? null;
}

/**
 * まだカレンダーと紐づいていない、開催日時が一致する行を引く。
 *
 * 手で登録した既存の行（初回イベントなど）を、同じ日時の予定が
 * カレンダーにあるときに引き取るために使う。これが無いと、同じ開催日に
 * 行が2つできて申込先が分かれてしまう。
 *
 * 開始だけでなく終了も一致する行に限る。開始が同じで長さの違う予定を
 * 「同じ回」として引き取ると、既存行の開催時間が予定側で上書きされ、
 * すでに申し込んだ人へ案内した終了時刻が黙って変わる。
 * 終了を渡さなかった場合は開始だけで探す（従来の呼び出しのため）。
 *
 * 候補が複数あるときは作成の古い行を選ぶ。順序を明示しないと
 * PostgREST の返す順が不定で、同じ入力でも引き取る行が変わりうる。
 */
export async function findUnlinkedEventByDate(config, eventDateIso, eventEndAtIso) {
  const endFilter = eventEndAtIso
    ? `&event_end_at=eq.${encodeURIComponent(eventEndAtIso)}`
    : '';

  const rows = await request(
    config,
    'events?google_calendar_event_id=is.null'
    + `&event_date=eq.${encodeURIComponent(eventDateIso)}`
    + endFilter
    + '&order=created_at.asc&limit=1',
  );

  return rows?.[0] ?? null;
}

/**
 * イベント行を作る。
 *
 * google_calendar_event_id の一意制約に当たった場合は、例外にせず
 * duplicate を返す（insertWebhookEvent と同じ扱い）。同時に2本の同期が
 * 走った場合に起こりうるが、片方が作れていれば結果として正しいため、
 * 呼び出し側は取り直して更新に切り替えればよい。
 *
 * @returns {Promise<{ row: object | null, duplicate: boolean }>}
 */
export async function insertEvent(config, row) {
  const fetchImpl = config.fetchImpl ?? fetch;

  const response = await fetchImpl(`${config.url}/rest/v1/events`, {
    method: 'POST',
    headers: headersFor(config, { Prefer: 'return=representation' }),
    body: JSON.stringify(row),
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
    throw new Error(`イベントを登録できませんでした（HTTP ${response.status}）: ${message}`);
  }

  return { row: payload?.[0] ?? null, duplicate: false };
}

/** イベント行を更新する。 */
export async function updateEvent(config, eventId, patch) {
  const rows = await request(config, `events?id=eq.${encodeURIComponent(eventId)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(patch),
  });

  return rows?.[0] ?? null;
}

/**
 * 同期の実行権を取る（取れたときだけ true）。
 *
 * 「last_synced_at が TTL より古い行だけを、今の時刻で更新する」1回の
 * 条件付き更新で、実行間隔の制御と多重実行の防止を同時に行う。
 * 件数を数えてから更新する方式にすると、同時に来た2本が両方とも
 * 「まだ実行されていない」と判断してすり抜けるため、DB側の1文で決める。
 *
 * 更新できた行が0件なら、TTL内か、ほかのリクエストが同期中。
 *
 * @param {object} config
 * @param {{ nowIso: string, ttlMinutes: number }} input
 * @returns {Promise<boolean>}
 */
export async function claimCalendarSync(config, { nowIso, ttlMinutes }) {
  const thresholdIso = new Date(Date.parse(nowIso) - ttlMinutes * 60_000).toISOString();

  const rows = await request(
    config,
    'calendar_sync_state?key=eq.calendar'
    + `&last_synced_at=lt.${encodeURIComponent(thresholdIso)}`,
    {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ last_synced_at: nowIso }),
    },
  );

  return (rows?.length ?? 0) > 0;
}

/** 同期の結果を記録する（管理画面で障害に気づくための手掛かり）。 */
export async function updateCalendarSyncStatus(config, { statusText }) {
  const rows = await request(config, 'calendar_sync_state?key=eq.calendar', {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    /* 長くなりすぎないよう切る（markWebhookProcessed と同じ扱い）。 */
    body: JSON.stringify({ last_status: String(statusText).slice(0, 500) }),
  });

  return rows?.[0] ?? null;
}

/** 同期の状態を読む（管理画面の表示用）。 */
export async function findCalendarSyncState(config) {
  const rows = await request(config, 'calendar_sync_state?key=eq.calendar&limit=1');
  return rows?.[0] ?? null;
}

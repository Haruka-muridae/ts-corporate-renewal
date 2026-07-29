/**
 * Stripe API クライアントと Checkout Session の作成。
 *
 * ------------------------------------------------------------------
 * 秘密鍵はフロントへ出さない
 * ------------------------------------------------------------------
 * STRIPE_SECRET_KEY は Script Properties にのみ置く。
 * このファイルの外（レスポンス・ログ・メール）へ出してはならない。
 *
 * フロントから来るのはプランコードだけで、Price ID すら受け取らない。
 * Price ID を受け取ると、任意の価格で購入させられる余地が生まれる。
 * ------------------------------------------------------------------
 */

var STRIPE_API_BASE = 'https://api.stripe.com/v1/';

/** 秘密鍵。未設定なら空文字。 */
function getStripeSecretKey_() {
  return getProperty_(PROP.STRIPE_SECRET_KEY);
}

function isStripeConfigured_() {
  return getStripeSecretKey_() !== '';
}

/**
 * オブジェクトを Stripe の form-encoded 形式へ変換する。
 * ネストは `a[b][c]=v`、配列は `a[0][b]=v` の形になる。
 */
function toStripeForm_(params, prefix) {
  var parts = [];
  var keys = Object.keys(params);

  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];
    var value = params[key];

    if (value === null || value === undefined || value === '') {
      continue;
    }

    var name = prefix ? prefix + '[' + key + ']' : key;

    if (typeof value === 'object') {
      var nested = toStripeForm_(value, name);

      if (nested !== '') {
        parts.push(nested);
      }

      continue;
    }

    parts.push(encodeURIComponent(name) + '=' + encodeURIComponent(String(value)));
  }

  return parts.join('&');
}

/**
 * Stripe API を呼ぶ。
 *
 * @param {string} method 'get' または 'post'
 * @param {string} path   'checkout/sessions' など
 * @param {Object} params POST の本文（GET では未使用）
 * @return {{ok: boolean, status: number, body: Object, error: string}}
 */
function stripeRequest_(method, path, params) {
  var key = getStripeSecretKey_();

  if (key === '') {
    return { ok: false, status: 0, body: null, error: 'NOT_CONFIGURED' };
  }

  var options = {
    method: method,
    headers: {
      Authorization: 'Bearer ' + key,
      /* 同じ内容で2回呼ばれても二重課金しないための冪等キー。 */
      'Stripe-Version': '2024-06-20'
    },
    muteHttpExceptions: true
  };

  if (method === 'post') {
    options.contentType = 'application/x-www-form-urlencoded';
    options.payload = toStripeForm_(params || {}, '');

    if (params && params.__idempotencyKey) {
      options.headers['Idempotency-Key'] = params.__idempotencyKey;
    }
  }

  var response;

  try {
    response = UrlFetchApp.fetch(STRIPE_API_BASE + path, options);
  } catch (err) {
    /* err.message に鍵は含まれないが、念のため内容は転記しない。 */
    logSystemError_('stripe', 'fetch failed: ' + path);
    return { ok: false, status: 0, body: null, error: 'NETWORK' };
  }

  var status = response.getResponseCode();
  var text = response.getContentText();
  var body = null;

  try {
    body = JSON.parse(text);
  } catch (err) {
    body = null;
  }

  if (status < 200 || status >= 300) {
    var detail = (body && body.error && body.error.message) ? body.error.message : ('HTTP ' + status);
    logSystemError_('stripe', path + ' -> ' + clip_(detail, 300));
    return { ok: false, status: status, body: body, error: 'API_ERROR' };
  }

  return { ok: true, status: status, body: body, error: '' };
}

/* ---------- プラン ---------- */

/** 行をプランオブジェクトへ変換する。 */
function rowToPlan_(values) {
  return {
    planCode: trimStr_(values[PLAN_COL.PLAN_CODE - 1]),
    planName: trimStr_(values[PLAN_COL.PLAN_NAME - 1]),
    priceId: trimStr_(values[PLAN_COL.STRIPE_PRICE_ID - 1]),
    amount: trimStr_(values[PLAN_COL.AMOUNT - 1]),
    currency: trimStr_(values[PLAN_COL.CURRENCY - 1]) || 'jpy',
    interval: trimStr_(values[PLAN_COL.INTERVAL - 1]),
    features: trimStr_(values[PLAN_COL.FEATURES - 1]),
    enabled: parseBool_(values[PLAN_COL.ENABLED - 1])
  };
}

/**
 * 画面へ出すプラン一覧。
 * **Price ID は含めない**（フロントへ渡す必要が無く、渡せば改ざんの的になる）。
 */
function listPublicPlans_() {
  var rows = readRows_(SHEETS.PLANS);
  var out = [];

  for (var i = 0; i < rows.length; i++) {
    var plan = rowToPlan_(rows[i]);

    if (plan.planCode === '' || !plan.enabled) {
      continue;
    }

    out.push({
      planCode: plan.planCode,
      planName: plan.planName,
      amount: plan.amount,
      currency: plan.currency,
      interval: plan.interval,
      /* 改行区切りを配列にして渡す。画面側で箇条書きにする。 */
      features: plan.features === '' ? [] : plan.features.split('\n')
    });
  }

  return out;
}

/** プランコードから設定を引く。無効・未登録なら null。 */
function findPlanByCode_(planCode) {
  var code = trimStr_(planCode);

  if (code === '') {
    return null;
  }

  var found = findRow_(SHEETS.PLANS, function (values) {
    return trimStr_(values[PLAN_COL.PLAN_CODE - 1]) === code;
  });

  if (!found) {
    return null;
  }

  var plan = rowToPlan_(found.values);

  if (!plan.enabled || plan.priceId === '') {
    return null;
  }

  return plan;
}

/* ---------- Checkout ---------- */

/**
 * 乱用を抑える。誰でも叩ける入口なので、1時間あたりの作成数に上限を置く。
 * CacheService はベストエフォートだが、無いよりは効く。
 */
function checkoutRateLimitOk_() {
  var limit = getSettingNumber_('CHECKOUT_HOURLY_LIMIT', 60);

  if (limit <= 0) {
    return true;
  }

  try {
    var cache = CacheService.getScriptCache();
    var key = 'checkout_count_' + Math.floor(nowMs_() / (60 * 60 * 1000));
    var current = Number(cache.get(key)) || 0;

    if (current >= limit) {
      return false;
    }

    cache.put(key, String(current + 1), 3900);
    return true;
  } catch (err) {
    /* キャッシュが使えない場合は通す（機能を止めない）。 */
    return true;
  }
}

/**
 * Checkout Session を作る。
 *
 * @param {Object} input { planCode, email }
 * @return {{ok: boolean, errorPair: Array, data: Object}}
 */
function createCheckoutSession_(input) {
  if (!isStripeConfigured_()) {
    return { ok: false, errorPair: ERRORS.NOT_CONFIGURED };
  }

  if (!checkoutRateLimitOk_()) {
    return { ok: false, errorPair: ERRORS.RATE_LIMITED };
  }

  var plan = findPlanByCode_(input.planCode);

  if (!plan) {
    return { ok: false, errorPair: ERRORS.PLAN_NOT_FOUND };
  }

  var successUrl = getSuccessUrl_();
  var cancelUrl = getCancelUrl_();

  if (successUrl === '' || cancelUrl === '') {
    logSystemError_('stripe', 'SUCCESS_URL / CANCEL_URL が未設定です。');
    return { ok: false, errorPair: ERRORS.NOT_CONFIGURED };
  }

  var params = {
    mode: 'subscription',
    /* Checkout から戻ったとき、どのセッションだったかを画面が確認できるようにする。 */
    success_url: successUrl + (successUrl.indexOf('?') === -1 ? '?' : '&')
      + 'session_id={CHECKOUT_SESSION_ID}',
    cancel_url: cancelUrl,
    client_reference_id: plan.planCode,
    line_items: [{ price: plan.priceId, quantity: 1 }],
    subscription_data: { metadata: { plan_code: plan.planCode } },
    metadata: { plan_code: plan.planCode },
    /* 決済時のメールアドレスをそのままログイン用に使う。 */
    customer_creation: 'always'
  };

  var email = normalizeEmail_(input.email);

  if (isValidEmail_(email)) {
    params.customer_email = email;
  }

  var result = stripeRequest_('post', 'checkout/sessions', params);

  if (!result.ok || !result.body || !result.body.url) {
    return { ok: false, errorPair: ERRORS.STRIPE_ERROR };
  }

  return {
    ok: true,
    data: { checkoutUrl: result.body.url, checkoutSessionId: result.body.id }
  };
}

/**
 * 決済完了画面のための状態確認。
 *
 * ------------------------------------------------------------------
 * この結果で「契約有効」と判定しない（重要）
 * ------------------------------------------------------------------
 * 利用者の登録は Webhook が行う。ここで返すのは
 * 「案内メールを待ってよい状態か」を画面へ伝えるためだけの情報。
 * 返す値にも、契約を有効化する副作用は一切持たせない。
 * ------------------------------------------------------------------
 */
function getCheckoutStatus_(checkoutSessionId) {
  var id = trimStr_(checkoutSessionId);

  if (id === '' || !/^cs_[A-Za-z0-9_]+$/.test(id)) {
    return { ok: false, errorPair: ERRORS.INVALID_REQUEST };
  }

  if (!isStripeConfigured_()) {
    return { ok: false, errorPair: ERRORS.NOT_CONFIGURED };
  }

  var result = stripeRequest_('get', 'checkout/sessions/' + encodeURIComponent(id), null);

  if (!result.ok || !result.body) {
    return { ok: false, errorPair: ERRORS.STRIPE_ERROR };
  }

  var email = normalizeEmail_(
    result.body.customer_details ? result.body.customer_details.email : ''
  );

  /* 登録が済んでいるかは、こちらのシートを見て答える。 */
  var user = email === '' ? null : findUserByEmail_(email);

  return {
    ok: true,
    data: {
      paymentStatus: trimStr_(result.body.payment_status),
      emailMasked: maskEmail_(email),
      /* 案内メールを送れる状態になったか。 */
      accountReady: user !== null,
      accountStatus: user ? user.accountStatus : ''
    }
  };
}

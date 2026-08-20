/**
 * Stripe Webhook の受信。
 *
 * ==================================================================
 * 真正性の確認方法（必ず読むこと）
 * ==================================================================
 * Apps Script の doPost(e) には **HTTPリクエストヘッダーが渡らない**。
 * Stripe が付ける `Stripe-Signature` ヘッダーを、Apps Script 単体では
 * 受け取れない。したがって「標準の署名検証」だけでは成立しない。
 *
 * そこで、次の三重で真正性を確認する。
 *
 *   (1) URLの合言葉
 *       Webhook URL に ?k=<STRIPE_WEBHOOK_URL_KEY> を付ける。
 *       Script Properties に置いた推測困難な値と定数時間で比較する。
 *       URL を知らない相手は、そもそもここで落ちる。
 *
 *   (2) Stripe API への照会（**これが本命**）
 *       受信した本文からは event.id しか採用しない。
 *       その ID で Stripe API へ GET /v1/events/{id} を行い、
 *       **Stripe から返ってきた内容だけ** を処理に使う。
 *       攻撃者は自分の Stripe アカウントに存在しないイベントIDを
 *       作れないため、偽の本文を送っても処理は進まない。
 *       秘密鍵を持つのはこちらだけなので、なりすましは成立しない。
 *
 *   (3) 署名検証（中継を置いた場合のみ）
 *       署名ヘッダーをクエリ `sig` として転送してくれる中継
 *       （Cloudflare Worker 等）を挟む場合は、
 *       Crypto.gs の verifyStripeSignature_() で HMAC-SHA256 を検証する。
 *       署名が付いていて不正なら、その時点で拒否する。
 *
 * (3) は任意、(1)(2) は必須。
 * 中継を置かない構成でも「本文をそのまま信用する」ことは無い。
 * 詳細と中継のコード例は STRIPE_SETUP.md / SECURITY_NOTES.md を参照。
 * ==================================================================
 *
 * 冪等性: event_id を stripe_events シートに記録し、
 * すでに処理済みのイベントは二度処理しない。
 */

/** 処理するイベント種別。ここに無いものは記録だけして無視する。 */
var HANDLED_EVENTS = [
  'checkout.session.completed',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.payment_failed',
  'invoice.paid'
];

var EVENT_STATUS = {
  PROCESSING: 'processing',
  PROCESSED: 'processed',
  IGNORED: 'ignored',
  FAILED: 'failed',
  DUPLICATE: 'duplicate'
};

/**
 * Webhook の入口。
 * doPost から呼ばれる。戻り値は ContentService の出力。
 */
function handleStripeWebhook_(e) {
  var params = (e && e.parameter) ? e.parameter : {};
  var rawBody = (e && e.postData && e.postData.contents) ? e.postData.contents : '';

  /* ---- (1) URL の合言葉 ---- */
  var expectedKey = getProperty_(PROP.STRIPE_WEBHOOK_URL_KEY);

  if (expectedKey === '') {
    logSystemError_('webhook', 'STRIPE_WEBHOOK_URL_KEY が未設定のため受信を拒否しました。');
    return failFrom_(ERRORS.NOT_CONFIGURED);
  }

  if (!timingSafeEqual_(trimStr_(params.k), expectedKey)) {
    logSystemError_('webhook', 'URLキーが一致しないリクエストを拒否しました。');
    return failFrom_(ERRORS.INVALID_REQUEST);
  }

  /* ---- (3) 署名（中継経由で届いた場合のみ） ---- */
  var signatureHeader = trimStr_(params.sig || params.stripe_signature);

  /*
   * 中継（workers/stripe-relay）だけが呼ぶ構成にしたら、署名の無い要求は
   * 合言葉が合っていても拒否する（設定 STRIPE_WEBHOOK_REQUIRE_SIGNATURE）。
   */
  if (signatureHeader === '' && getSettingBool_('STRIPE_WEBHOOK_REQUIRE_SIGNATURE', false)) {
    logSystemError_('webhook', '署名の無い要求を拒否しました（STRIPE_WEBHOOK_REQUIRE_SIGNATURE=TRUE）。');
    return failFrom_(ERRORS.INVALID_REQUEST);
  }

  if (signatureHeader !== '') {
    var secret = getProperty_(PROP.STRIPE_WEBHOOK_SECRET);
    var verdict = verifyStripeSignature_(rawBody, signatureHeader, secret);

    if (!verdict.ok) {
      logSystemError_('webhook', '署名検証に失敗しました: ' + verdict.reason);
      return failFrom_(ERRORS.INVALID_REQUEST);
    }
  }

  /* ---- 本文からは ID だけを取り出す ---- */
  var claimed = null;

  try {
    claimed = JSON.parse(rawBody);
  } catch (err) {
    claimed = null;
  }

  var eventId = claimed ? trimStr_(claimed.id) : '';

  if (eventId === '' || !/^evt_[A-Za-z0-9_]+$/.test(eventId)) {
    logSystemError_('webhook', 'イベントIDが取得できないリクエストを拒否しました。');
    return failFrom_(ERRORS.INVALID_REQUEST);
  }

  /* ---- (2) Stripe へ照会し、返ってきた内容だけを使う ---- */
  var fetched = stripeRequest_('get', 'events/' + encodeURIComponent(eventId), null);

  if (!fetched.ok || !fetched.body || trimStr_(fetched.body.id) !== eventId) {
    logSystemError_('webhook', 'Stripeへの照会に失敗したため処理しません: ' + eventId);
    return failFrom_(ERRORS.INVALID_REQUEST);
  }

  var event = fetched.body;

  try {
    var outcome = processStripeEvent_(event);
    return ok_({ received: true, status: outcome.status });
  } catch (err) {
    logSystemError_('webhook', eventId + ' の処理に失敗: ' + clip_(err && err.message, 300));
    markEventFailed_(eventId, clip_(err && err.message, 300));
    return failFrom_(ERRORS.SERVER_ERROR);
  }
}

/**
 * 冪等性を保ちながらイベントを処理する。
 *
 * 「受信済みとして登録できたのは1回だけ」という形にするため、
 * 登録と重複判定を1つのロックの中で行う。
 */
function processStripeEvent_(event) {
  var eventId = trimStr_(event.id);
  var eventType = trimStr_(event.type);

  var claim = withLock_(function () {
    var existing = findRow_(SHEETS.STRIPE_EVENTS, function (values) {
      return trimStr_(values[EVENT_COL.EVENT_ID - 1]) === eventId;
    });

    if (existing) {
      return { fresh: false, rowNumber: existing.rowNumber };
    }

    var row = [];
    row[EVENT_COL.EVENT_ID - 1] = eventId;
    row[EVENT_COL.EVENT_TYPE - 1] = eventType;
    row[EVENT_COL.RECEIVED_AT - 1] = nowIso_();
    row[EVENT_COL.PROCESSED_AT - 1] = '';
    row[EVENT_COL.PROCESSING_STATUS - 1] = EVENT_STATUS.PROCESSING;
    row[EVENT_COL.ERROR_MESSAGE - 1] = '';

    appendRow_(SHEETS.STRIPE_EVENTS, row);

    return { fresh: true, rowNumber: 0 };
  });

  if (!claim.fresh) {
    /* すでに受信済み。何もしない。 */
    return { status: EVENT_STATUS.DUPLICATE };
  }

  if (HANDLED_EVENTS.indexOf(eventType) === -1) {
    finishEvent_(eventId, EVENT_STATUS.IGNORED, '');
    return { status: EVENT_STATUS.IGNORED };
  }

  var object = (event.data && event.data.object) ? event.data.object : {};

  if (eventType === 'checkout.session.completed') {
    var handled = handleCheckoutCompleted_(object);

    if (handled && handled.ignored) {
      finishEvent_(eventId, EVENT_STATUS.IGNORED, handled.reason);
      return { status: EVENT_STATUS.IGNORED };
    }
  } else if (eventType === 'customer.subscription.updated'
    || eventType === 'customer.subscription.deleted') {
    handleSubscriptionChanged_(eventType, object);
  } else if (eventType === 'invoice.paid' || eventType === 'invoice.payment_failed') {
    handleInvoiceEvent_(eventType, object);
  }

  finishEvent_(eventId, EVENT_STATUS.PROCESSED, '');
  return { status: EVENT_STATUS.PROCESSED };
}

/** 処理結果を記録する。 */
function finishEvent_(eventId, status, message) {
  var found = findRow_(SHEETS.STRIPE_EVENTS, function (values) {
    return trimStr_(values[EVENT_COL.EVENT_ID - 1]) === eventId;
  });

  if (!found) {
    return;
  }

  var updates = {};
  updates[EVENT_COL.PROCESSED_AT] = nowIso_();
  updates[EVENT_COL.PROCESSING_STATUS] = status;
  updates[EVENT_COL.ERROR_MESSAGE] = clip_(message, 500);

  updateCells_(SHEETS.STRIPE_EVENTS, found.rowNumber, updates);
}

function markEventFailed_(eventId, message) {
  try {
    finishEvent_(eventId, EVENT_STATUS.FAILED, message);
  } catch (err) {
    Logger.log('markEventFailed_ failed: ' + err);
  }
}

/* ---------- 個別イベントの処理 ---------- */

/**
 * 決済完了。利用者を作り、パスワード初期設定の案内を送る。
 *
 * 同じメールアドレス・同じ顧客ID・同じ契約IDでの重複登録を防ぐ。
 *
 * ------------------------------------------------------------------
 * 継続課金の Checkout 以外は処理しない（重要）
 * ------------------------------------------------------------------
 * 同じ Stripe アカウントには交流会アプリ（一回払い、mode=payment）が
 * 同居している。Stripe はアカウント内の全エンドポイントへイベントを
 * 配るため、設定次第で交流会の決済完了がここへ届く。その本文には
 * customer_details.email があるので、無条件に処理すると
 * **参加者を認証システムの会員として作成し、初期設定メールを送ってしまう**。
 * mode が subscription でない、または契約IDが無い Session は無視する。
 * ------------------------------------------------------------------
 *
 * @return {{ignored: boolean, reason: string}}
 */
function handleCheckoutCompleted_(session) {
  var mode = trimStr_(session.mode).toLowerCase();
  var subscriptionIdEarly = trimStr_(typeof session.subscription === 'string' ? session.subscription : '');

  if (mode !== '' && mode !== 'subscription') {
    logSystemError_('webhook', 'checkout.session.completed: mode=' + clip_(mode, 32) + ' のため無視しました。');
    return { ignored: true, reason: 'mode=' + clip_(mode, 32) };
  }

  if (subscriptionIdEarly === '') {
    logSystemError_('webhook', 'checkout.session.completed: 契約IDが無いため無視しました。');
    return { ignored: true, reason: 'no subscription id' };
  }

  var email = normalizeEmail_(
    (session.customer_details && session.customer_details.email)
      ? session.customer_details.email
      : session.customer_email
  );

  if (!isValidEmail_(email)) {
    logSystemError_('webhook', 'checkout.session.completed にメールアドレスがありません。');
    return { ignored: true, reason: 'no email' };
  }

  var customerId = trimStr_(typeof session.customer === 'string' ? session.customer : '');
  var subscriptionId = subscriptionIdEarly;

  var outcome = withLock_(function () {
    /* メール・顧客ID・契約IDのいずれかで既存を見つける（シートは1回だけ読む）。 */
    var user = findUserByAnyIdentity_(email, customerId, subscriptionId);

    if (user) {
      applySubscriptionToUser_(user, {
        stripeCustomerId: customerId,
        stripeSubscriptionId: subscriptionId,
        subscriptionStatus: SUBSCRIPTION_STATUS.ACTIVE
      });

      /* パスワード未設定のまま放置されている場合だけ、案内を送り直す。 */
      var needsSetup = user.passwordHash === '' || user.accountStatus === ACCOUNT_STATUS.PENDING;

      if (!needsSetup) {
        return { created: false, issued: null, user: user };
      }

      invalidateTokens_(user.userId, TOKEN_TYPE.INITIAL_SETUP);
      return { created: false, issued: issueToken_(user.userId, TOKEN_TYPE.INITIAL_SETUP), user: user };
    }

    var created = createUser_({
      email: email,
      role: ROLE.MEMBER,
      stripeCustomerId: customerId,
      stripeSubscriptionId: subscriptionId,
      subscriptionStatus: SUBSCRIPTION_STATUS.ACTIVE,
      paymentExempt: false,
      accountStatus: ACCOUNT_STATUS.PENDING
    });

    return { created: true, issued: issueToken_(created.userId, TOKEN_TYPE.INITIAL_SETUP), user: created };
  });

  logAdminAction_(
    'stripe-webhook',
    outcome.created ? 'user_created' : 'user_updated',
    outcome.user.userId,
    'email=' + maskEmail_(email)
  );

  if (outcome.issued) {
    sendInitialSetupMail_(email, outcome.issued.token, outcome.issued.expiresAtMs);
  }

  return { ignored: false, reason: '' };
}

/** 契約の更新・解約を反映する。 */
function handleSubscriptionChanged_(eventType, subscription) {
  var subscriptionId = trimStr_(subscription.id);
  var customerId = trimStr_(typeof subscription.customer === 'string' ? subscription.customer : '');

  var status = eventType === 'customer.subscription.deleted'
    ? SUBSCRIPTION_STATUS.CANCELED
    : trimStr_(subscription.status).toLowerCase();

  if (status === '') {
    return;
  }

  withLock_(function () {
    var user = findUserByStripeSubscriptionId_(subscriptionId)
      || findUserByStripeCustomerId_(customerId);

    if (!user) {
      logSystemError_('webhook', '該当する利用者が見つかりません: ' + eventType);
      return;
    }

    applySubscriptionToUser_(user, {
      stripeCustomerId: customerId,
      stripeSubscriptionId: subscriptionId,
      subscriptionStatus: status
    });

    /*
     * 契約が切れてもアカウントは無効にしない。
     * 再契約したときに、同じアカウントとパスワードで戻れるようにするため。
     * 利用可否の判断は subscription_status で毎回行う。
     */
    logAdminAction_('stripe-webhook', 'subscription_' + status, user.userId, eventType);
  });
}

/** 支払いの成功・失敗を反映する。 */
function handleInvoiceEvent_(eventType, invoice) {
  var subscriptionId = trimStr_(typeof invoice.subscription === 'string' ? invoice.subscription : '');
  var customerId = trimStr_(typeof invoice.customer === 'string' ? invoice.customer : '');

  withLock_(function () {
    var user = findUserByStripeSubscriptionId_(subscriptionId)
      || findUserByStripeCustomerId_(customerId);

    if (!user) {
      logSystemError_('webhook', '該当する利用者が見つかりません: ' + eventType);
      return;
    }

    /*
     * 支払い成功で active へ戻す。失敗は past_due にする。
     * 最終的な状態は customer.subscription.updated が上書きするため、
     * ここでは「速報」として扱う。
     */
    var status = eventType === 'invoice.paid'
      ? SUBSCRIPTION_STATUS.ACTIVE
      : SUBSCRIPTION_STATUS.PAST_DUE;

    applySubscriptionToUser_(user, {
      stripeCustomerId: customerId,
      stripeSubscriptionId: subscriptionId,
      subscriptionStatus: status
    });

    logAdminAction_('stripe-webhook', 'invoice_' + status, user.userId, eventType);
  });
}

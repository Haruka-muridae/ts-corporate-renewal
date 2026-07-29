/**
 * Web API のエントリポイント。
 *
 * ------------------------------------------------------------------
 * 方針
 * ------------------------------------------------------------------
 *   - action はホワイトリスト方式（Config.gs）。
 *     setupAuthSystem() などの管理関数はここから呼ばないため、
 *     Web からは実行できない。
 *   - POST の本文は text/plain の JSON を想定する
 *     （プリフライトを避けるフロント実装に合わせる。既存の gas/ と同じ）。
 *   - 例外は握りつぶさず catch してログへ残し、
 *     クライアントには定型メッセージだけを返す。
 * ------------------------------------------------------------------
 *
 * ------------------------------------------------------------------
 * Apps Script の制約
 * ------------------------------------------------------------------
 * doGet / doPost には HTTPヘッダーが渡らない。
 * そのため User-Agent も本文の userAgent フィールドとして受け取る
 * （利用者が詐称できる値であり、ログの参考情報にすぎない）。
 * Stripe の署名ヘッダーを受け取れない件は Webhook.gs を参照。
 * ------------------------------------------------------------------
 */

function doGet(e) {
  try {
    var params = (e && e.parameter) ? e.parameter : {};
    var action = trimStr_(params.action);

    if (ALLOWED_GET_ACTIONS.indexOf(action) === -1) {
      return failFrom_(ERRORS.INVALID_ACTION);
    }

    if (action === 'health') {
      return ok_({ ok: true });
    }

    if (action === 'listPlans') {
      return ok_({ plans: listPublicPlans_() });
    }

    if (action === 'publicConfig') {
      return ok_(buildPublicConfig_());
    }

    return failFrom_(ERRORS.INVALID_ACTION);
  } catch (err) {
    return handleUnexpected_('doGet', err);
  }
}

function doPost(e) {
  try {
    var params = (e && e.parameter) ? e.parameter : {};

    /* Webhook は action ではなく path で振り分ける（本文が Stripe の形式のため）。 */
    if (trimStr_(params.path) === 'stripe-webhook') {
      return handleStripeWebhook_(e);
    }

    var body = parsePostBody_(e);

    if (!body) {
      return failFrom_(ERRORS.INVALID_REQUEST);
    }

    var action = trimStr_(body.action);

    if (ALLOWED_POST_ACTIONS.indexOf(action) === -1) {
      return failFrom_(ERRORS.INVALID_ACTION);
    }

    return dispatchPost_(action, body);
  } catch (err) {
    return handleUnexpected_('doPost', err);
  }
}

/** POST本文（text/plain の JSON文字列）を安全に解析する。 */
function parsePostBody_(e) {
  if (!e || !e.postData || !e.postData.contents) {
    return null;
  }

  /* 想定外に大きい本文は読まない。 */
  if (e.postData.contents.length > 100000) {
    return null;
  }

  try {
    var parsed = JSON.parse(e.postData.contents);
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : null;
  } catch (err) {
    return null;
  }
}

/** action ごとの処理。 */
function dispatchPost_(action, body) {
  if (action === 'login') {
    return respond_(performLogin_({
      email: body.email,
      password: body.password,
      remember: body.remember === true,
      userAgent: body.userAgent
    }));
  }

  if (action === 'verifySession') {
    return handleVerifySession_(body);
  }

  if (action === 'logout') {
    revokeSessionByToken_(body.sessionToken);
    /* 存在しないトークンでも成功として返す（存在の手がかりを与えない）。 */
    return ok_({ signedOut: true });
  }

  if (action === 'setupPassword') {
    return respond_(performPasswordSet_({
      token: body.token,
      password: body.password,
      passwordConfirm: body.passwordConfirm,
      expectedType: TOKEN_TYPE.INITIAL_SETUP
    }));
  }

  if (action === 'resetPassword') {
    return respond_(performPasswordSet_({
      token: body.token,
      password: body.password,
      passwordConfirm: body.passwordConfirm,
      expectedType: TOKEN_TYPE.PASSWORD_RESET
    }));
  }

  if (action === 'requestPasswordReset') {
    return respond_(performPasswordResetRequest_({
      email: body.email,
      userAgent: body.userAgent
    }));
  }

  if (action === 'createCheckoutSession') {
    return respond_(createCheckoutSession_({
      planCode: body.planCode,
      email: body.email
    }));
  }

  if (action === 'checkoutStatus') {
    return respond_(getCheckoutStatus_(body.checkoutSessionId));
  }

  return failFrom_(ERRORS.INVALID_ACTION);
}

/**
 * セッションを検証する。
 * 保護対象の画面は、描画の前に必ずこれを呼ぶ。
 */
function handleVerifySession_(body) {
  var result = verifySessionToken_(body.sessionToken);

  if (!result.ok) {
    return failFrom_(ERRORS.SESSION_INVALID);
  }

  return ok_({
    user: toPublicUser_(result.user),
    expiresAt: toIso_(new Date(result.session.expiresAtMs)),
    remember: result.session.remember
  });
}

/** { ok, errorPair, data } 形式の結果をレスポンスへ変換する。 */
function respond_(result) {
  if (!result || result.ok !== true) {
    var pair = (result && result.errorPair) ? result.errorPair : ERRORS.SERVER_ERROR;
    return fail_(pair[0], pair[1]);
  }

  return ok_(result.data || {});
}

/** 画面が起動時に読む公開設定。秘密情報は含めない。 */
function buildPublicConfig_() {
  return {
    passwordMinLength: getSettingNumber_('PASSWORD_MIN_LENGTH', 12),
    passwordMaxLength: getSettingNumber_('PASSWORD_MAX_LENGTH', 128),
    loginUrl: getLoginUrl_(),
    portalUrl: getPortalUrl_(),
    /* 決済導線を出してよいか。Stripe 未設定なら申し込みボタンを隠す。 */
    checkoutAvailable: isStripeConfigured_() && listPublicPlans_().length > 0
  };
}

/**
 * 想定外の例外。
 * 内部情報（スタックトレース・シートの内容）はクライアントへ返さない。
 */
function handleUnexpected_(scope, err) {
  var message = (err && err.message) ? String(err.message) : String(err);

  Logger.log(scope + ' error: ' + message + '\n' + (err && err.stack));

  try {
    logSystemError_(scope, clip_(message, 500));
  } catch (inner) {
    /* ログにも書けない状況では、これ以上できることはない。 */
  }

  if (message.indexOf('LOCK_TIMEOUT') !== -1) {
    return failFrom_(ERRORS.RATE_LIMITED);
  }

  return failFrom_(ERRORS.SERVER_ERROR);
}

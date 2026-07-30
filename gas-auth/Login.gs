/**
 * ログイン判定、失敗制限、パスワードの初期設定と再設定。
 *
 * ------------------------------------------------------------------
 * 判定順序（要件どおり）
 * ------------------------------------------------------------------
 *   1. メールアドレス正規化
 *   2. ユーザー検索
 *   3. アカウント状態確認
 *   4. ロック状態確認
 *   5. パスワード照合
 *   6. 決済確認免除（payment_exempt）を確認
 *   7. 免除なら契約確認を省略
 *   8. 一般利用者は subscription_status を確認
 *   9. 条件を満たせばセッション発行
 *
 * どの段階で落ちても、画面へ返すのは同じ AUTH_FAILED（ロック時のみ LOCKED）。
 * 本当の理由は failure_reason_code として認証ログにだけ残す。
 * ------------------------------------------------------------------
 */

/** ロック中かどうか。 */
function isLocked_(user, now) {
  return user.lockedUntilMs > 0 && user.lockedUntilMs > (now || nowMs_());
}

/**
 * 失敗を1回数える。上限に達したらロックする。
 * 呼び出し側で withLock_ の中から呼ぶこと。
 */
function recordLoginFailure_(user) {
  var limit = getSettingNumber_('LOGIN_FAILURE_LIMIT', 5);
  var lockMinutes = getSettingNumber_('LOCK_DURATION_MINUTES', 15);

  /* 直前の値を読み直す。並行実行で数え漏れないように。 */
  var latest = findUserById_(user.userId) || user;
  var count = latest.loginFailureCount + 1;

  var updates = {};
  updates[USER_COL.LOGIN_FAILURE_COUNT] = count;

  if (count >= limit) {
    updates[USER_COL.LOCKED_UNTIL] = toIso_(new Date(nowMs_() + lockMinutes * 60 * 1000));
  }

  updateUserCells_(latest, updates);

  return { count: count, locked: count >= limit };
}

/** 成功時に失敗回数を戻す。 */
function resetLoginFailure_(user) {
  var updates = {};
  updates[USER_COL.LOGIN_FAILURE_COUNT] = 0;
  updates[USER_COL.LOCKED_UNTIL] = '';
  updates[USER_COL.LAST_LOGIN_AT] = nowIso_();

  updateUserCells_(user, updates);
}

/**
 * ログインする。
 *
 * @param {Object} input { email, password, remember, userAgent }
 * @return {Object} { ok, errorPair, data }
 */
function performLogin_(input) {
  var email = normalizeEmail_(input.email);
  var password = typeof input.password === 'string' ? input.password : '';
  var remember = input.remember === true;
  var userAgent = input.userAgent;

  if (!isValidEmail_(email) || password === '') {
    logLogin_({
      userId: '', email: email, result: 'failure',
      reasonCode: FAILURE_REASON.INVALID_INPUT, userAgent: userAgent
    });

    return { ok: false, errorPair: ERRORS.AUTH_FAILED };
  }

  var user = findUserByEmail_(email);

  /*
   * 存在しない場合でも、同じだけ計算する。
   * 応答時間の差からアカウントの有無を推測されないようにする。
   */
  if (!user) {
    consumeDummyVerification_(password);

    logLogin_({
      userId: '', email: email, result: 'failure',
      reasonCode: FAILURE_REASON.NOT_FOUND, userAgent: userAgent
    });

    return { ok: false, errorPair: ERRORS.AUTH_FAILED };
  }

  /* ロック中は照合そのものを行わない（総当たりへの計算資源を与えない）。 */
  if (isLocked_(user)) {
    logLogin_({
      userId: user.userId, email: email, result: 'failure',
      reasonCode: FAILURE_REASON.LOCKED, userAgent: userAgent
    });

    return { ok: false, errorPair: ERRORS.LOCKED };
  }

  /*
   * アカウント状態の確認。
   * pending（パスワード未設定）も、停止・無効も、同じ AUTH_FAILED で返す。
   * ここで理由を区別すると、登録済みかどうかが分かってしまう。
   */
  if (user.accountStatus !== ACCOUNT_STATUS.ACTIVE) {
    consumeDummyVerification_(password);

    logLogin_({
      userId: user.userId, email: email, result: 'failure',
      reasonCode: FAILURE_REASON.NOT_ACTIVE + ':' + user.accountStatus, userAgent: userAgent
    });

    return { ok: false, errorPair: ERRORS.AUTH_FAILED };
  }

  if (user.passwordHash === '') {
    consumeDummyVerification_(password);

    logLogin_({
      userId: user.userId, email: email, result: 'failure',
      reasonCode: FAILURE_REASON.NO_PASSWORD, userAgent: userAgent
    });

    return { ok: false, errorPair: ERRORS.AUTH_FAILED };
  }

  var verified = verifyPassword_(password, user.passwordHash, user.passwordSalt);

  if (!verified.ok) {
    var failure = withLock_(function () {
      return recordLoginFailure_(user);
    });

    logLogin_({
      userId: user.userId, email: email, result: 'failure',
      reasonCode: FAILURE_REASON.BAD_PASSWORD, userAgent: userAgent
    });

    /* ちょうど上限に達した回はロック中である旨を伝える。 */
    return { ok: false, errorPair: failure.locked ? ERRORS.LOCKED : ERRORS.AUTH_FAILED };
  }

  /*
   * ここから先はパスワードが一致している。
   * 管理者であっても、ここを通らずにログインできる経路は存在しない。
   */
  if (!isSubscriptionUsable_(user)) {
    logLogin_({
      userId: user.userId, email: email, result: 'failure',
      reasonCode: FAILURE_REASON.NO_SUBSCRIPTION + ':' + user.subscriptionStatus, userAgent: userAgent
    });

    return { ok: false, errorPair: ERRORS.AUTH_FAILED };
  }

  var session = withLock_(function () {
    /* 反復回数を増やしたあとの初回ログインで、静かに作り直す。 */
    if (verified.needsRehash) {
      var rehashed = hashPassword_(password, '', getPbkdf2Iterations_());
      var updates = {};
      updates[USER_COL.PASSWORD_HASH] = rehashed.hash;
      updates[USER_COL.PASSWORD_SALT] = rehashed.salt;
      updateUserCells_(user, updates);
    }

    resetLoginFailure_(user);
    return issueSession_(user, remember, userAgent);
  });

  logLogin_({
    userId: user.userId, email: email, result: 'success',
    reasonCode: '', userAgent: userAgent
  });

  return {
    ok: true,
    data: {
      sessionToken: session.token,
      expiresAt: toIso_(new Date(session.expiresAtMs)),
      remember: session.remember,
      user: toPublicUser_(user)
    }
  };
}

/* ---------- パスワードの初期設定と再設定 ---------- */

/**
 * トークンでパスワードを設定する（初期設定・再設定の共通処理）。
 *
 * @param {Object} input { token, password, passwordConfirm, expectedType }
 */
function performPasswordSet_(input) {
  var token = trimStr_(input.token);
  var password = typeof input.password === 'string' ? input.password : '';
  var confirm = typeof input.passwordConfirm === 'string' ? input.passwordConfirm : '';

  if (password !== confirm) {
    return { ok: false, errorPair: ERRORS.PASSWORD_MISMATCH };
  }

  var strength = validatePasswordStrength_(password);

  if (!strength.ok) {
    return { ok: false, errorPair: ['PASSWORD_WEAK', strength.message] };
  }

  /*
   * 検証と使用済み化を1つのロックで囲む。
   * 分けると、同じトークンで2回設定できる隙間ができる。
   */
  var result = withLock_(function () {
    var check = verifyToken_(token, input.expectedType || null);

    if (!check.ok) {
      return { ok: false, errorPair: ERRORS.TOKEN_INVALID };
    }

    var user = findUserById_(check.userId);

    if (!user) {
      return { ok: false, errorPair: ERRORS.TOKEN_INVALID };
    }

    if (user.accountStatus === ACCOUNT_STATUS.DISABLED
      || user.accountStatus === ACCOUNT_STATUS.SUSPENDED) {
      /* 停止中のアカウントをトークンで復活させない。 */
      return { ok: false, errorPair: ERRORS.TOKEN_INVALID };
    }

    setUserPassword_(user, password);
    markTokenUsed_(check.rowNumber);

    /* 同じ利用者の他の未使用トークンも無効化する。 */
    invalidateTokens_(user.userId, check.tokenType);

    /* パスワードが変わったら、既存のセッションはすべて捨てる。 */
    var revoked = revokeAllSessionsForUser_(user.userId);

    return { ok: true, user: user, tokenType: check.tokenType, revoked: revoked };
  });

  if (!result.ok) {
    return result;
  }

  logAdminAction_(
    result.user.email,
    result.tokenType === TOKEN_TYPE.INITIAL_SETUP ? 'password_initial_set' : 'password_reset',
    result.user.userId,
    'sessions_revoked=' + result.revoked
  );

  sendPasswordChangedMail_(result.user.email);

  return { ok: true, data: { loginUrl: getLoginUrl_() } };
}

/**
 * パスワード再設定を申し込む。
 *
 * 未登録のメールアドレスでも成功として返す。
 * 「登録があるかどうか」を返してしまうと、アカウントの存在確認に使われる。
 */
function performPasswordResetRequest_(input) {
  var email = normalizeEmail_(input.email);

  if (!isValidEmail_(email)) {
    /* 形式不正でも同じ応答にする。 */
    return { ok: true, data: {} };
  }

  var user = findUserByEmail_(email);

  if (!user) {
    return { ok: true, data: {} };
  }

  /* 停止・無効のアカウントには再設定リンクを送らない（応答は同じ）。 */
  if (user.accountStatus === ACCOUNT_STATUS.DISABLED
    || user.accountStatus === ACCOUNT_STATUS.SUSPENDED) {
    return { ok: true, data: {} };
  }

  var issued = withLock_(function () {
    invalidateTokens_(user.userId, TOKEN_TYPE.PASSWORD_RESET);
    return issueToken_(user.userId, TOKEN_TYPE.PASSWORD_RESET);
  });

  sendPasswordResetMail_(user.email, issued.token, issued.expiresAtMs);

  logLogin_({
    userId: user.userId, email: email, result: 'reset_requested',
    reasonCode: '', userAgent: input.userAgent
  });

  return { ok: true, data: {} };
}

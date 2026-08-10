/**
 * 利用者レコードの読み書き。
 *
 * 行 → オブジェクト の変換をここへ集約し、
 * 上位が列番号を知らずに済むようにする。
 */

/** 行（配列）を利用者オブジェクトへ変換する。 */
function rowToUser_(rowNumber, values) {
  return {
    rowNumber: rowNumber,
    userId: trimStr_(values[USER_COL.USER_ID - 1]),
    email: normalizeEmail_(values[USER_COL.EMAIL - 1]),
    passwordHash: trimStr_(values[USER_COL.PASSWORD_HASH - 1]),
    passwordSalt: trimStr_(values[USER_COL.PASSWORD_SALT - 1]),
    role: trimStr_(values[USER_COL.ROLE - 1]) || ROLE.MEMBER,
    stripeCustomerId: trimStr_(values[USER_COL.STRIPE_CUSTOMER_ID - 1]),
    stripeSubscriptionId: trimStr_(values[USER_COL.STRIPE_SUBSCRIPTION_ID - 1]),
    subscriptionStatus: trimStr_(values[USER_COL.SUBSCRIPTION_STATUS - 1]),
    paymentExempt: parseBool_(values[USER_COL.PAYMENT_EXEMPT - 1]),
    accountStatus: trimStr_(values[USER_COL.ACCOUNT_STATUS - 1]) || ACCOUNT_STATUS.PENDING,
    lastLoginAt: trimStr_(values[USER_COL.LAST_LOGIN_AT - 1]),
    loginFailureCount: parseCount_(values[USER_COL.LOGIN_FAILURE_COUNT - 1]),
    lockedUntilMs: parseTimeMs_(values[USER_COL.LOCKED_UNTIL - 1]),
    passwordUpdatedAt: trimStr_(values[USER_COL.PASSWORD_UPDATED_AT - 1]),
    createdAt: trimStr_(values[USER_COL.CREATED_AT - 1]),
    updatedAt: trimStr_(values[USER_COL.UPDATED_AT - 1]),
    /* 列を足す前に作られた行では空文字になる（未発行と同じ扱いでよい）。 */
    notifierLicenseKey: trimStr_(values[USER_COL.NOTIFIER_LICENSE_KEY - 1])
  };
}

/** メールアドレスで探す。正規化して比較する。 */
function findUserByEmail_(email) {
  var normalized = normalizeEmail_(email);

  if (normalized === '') {
    return null;
  }

  var found = findRow_(SHEETS.USERS, function (values) {
    return normalizeEmail_(values[USER_COL.EMAIL - 1]) === normalized;
  });

  return found ? rowToUser_(found.rowNumber, found.values) : null;
}

function findUserById_(userId) {
  var id = trimStr_(userId);

  if (id === '') {
    return null;
  }

  var found = findRow_(SHEETS.USERS, function (values) {
    return trimStr_(values[USER_COL.USER_ID - 1]) === id;
  });

  return found ? rowToUser_(found.rowNumber, found.values) : null;
}

/** Stripe の顧客IDで探す。重複登録の防止に使う。 */
function findUserByStripeCustomerId_(customerId) {
  var id = trimStr_(customerId);

  if (id === '') {
    return null;
  }

  var found = findRow_(SHEETS.USERS, function (values) {
    return trimStr_(values[USER_COL.STRIPE_CUSTOMER_ID - 1]) === id;
  });

  return found ? rowToUser_(found.rowNumber, found.values) : null;
}

/** Stripe の契約IDで探す。 */
function findUserByStripeSubscriptionId_(subscriptionId) {
  var id = trimStr_(subscriptionId);

  if (id === '') {
    return null;
  }

  var found = findRow_(SHEETS.USERS, function (values) {
    return trimStr_(values[USER_COL.STRIPE_SUBSCRIPTION_ID - 1]) === id;
  });

  return found ? rowToUser_(found.rowNumber, found.values) : null;
}

/**
 * 利用者を作る。呼び出し側は必ず withLock_ の中で呼ぶこと。
 * すでに同じメールアドレスがある場合は、既存を返す（重複行を作らない）。
 *
 * パスワードはここでは設定しない。
 * 初期設定トークン経由で本人が設定するまで account_status は pending。
 */
function createUser_(attributes) {
  var email = normalizeEmail_(attributes.email);

  if (!isValidEmail_(email)) {
    throw new Error('INVALID_EMAIL');
  }

  var existing = findUserByEmail_(email);

  if (existing) {
    return existing;
  }

  var now = nowIso_();
  var userId = newId_('usr');

  var row = [];
  row[USER_COL.USER_ID - 1] = userId;
  row[USER_COL.EMAIL - 1] = email;
  row[USER_COL.PASSWORD_HASH - 1] = '';
  row[USER_COL.PASSWORD_SALT - 1] = '';
  row[USER_COL.ROLE - 1] = trimStr_(attributes.role) || ROLE.MEMBER;
  row[USER_COL.STRIPE_CUSTOMER_ID - 1] = trimStr_(attributes.stripeCustomerId);
  row[USER_COL.STRIPE_SUBSCRIPTION_ID - 1] = trimStr_(attributes.stripeSubscriptionId);
  row[USER_COL.SUBSCRIPTION_STATUS - 1] = trimStr_(attributes.subscriptionStatus);
  row[USER_COL.PAYMENT_EXEMPT - 1] = boolToCell_(attributes.paymentExempt === true);
  row[USER_COL.ACCOUNT_STATUS - 1] = trimStr_(attributes.accountStatus) || ACCOUNT_STATUS.PENDING;
  row[USER_COL.LAST_LOGIN_AT - 1] = '';
  row[USER_COL.LOGIN_FAILURE_COUNT - 1] = 0;
  row[USER_COL.LOCKED_UNTIL - 1] = '';
  row[USER_COL.PASSWORD_UPDATED_AT - 1] = '';
  row[USER_COL.CREATED_AT - 1] = now;
  row[USER_COL.UPDATED_AT - 1] = now;
  /* ライセンスキーは本人が通知のセットアップを始めたときに発行する。 */
  row[USER_COL.NOTIFIER_LICENSE_KEY - 1] = '';

  appendRow_(SHEETS.USERS, row);

  return findUserByEmail_(email);
}

/**
 * 利用者の一部の列を更新する。
 * updates は { 列番号: 値 } 形式。updated_at は自動で入れる。
 */
function updateUserCells_(user, updates) {
  var payload = {};
  var keys = Object.keys(updates);

  for (var i = 0; i < keys.length; i++) {
    payload[keys[i]] = updates[keys[i]];
  }

  payload[USER_COL.UPDATED_AT] = nowIso_();
  updateCells_(SHEETS.USERS, user.rowNumber, payload);
}

/** パスワードを設定・変更する。 */
function setUserPassword_(user, password) {
  var hashed = hashPassword_(password, '', getPbkdf2Iterations_());
  var updates = {};

  updates[USER_COL.PASSWORD_HASH] = hashed.hash;
  updates[USER_COL.PASSWORD_SALT] = hashed.salt;
  updates[USER_COL.PASSWORD_UPDATED_AT] = nowIso_();
  updates[USER_COL.LOGIN_FAILURE_COUNT] = 0;
  updates[USER_COL.LOCKED_UNTIL] = '';

  /* 初回設定なら利用可能な状態へ進める。停止中・無効は自動で戻さない。 */
  if (user.accountStatus === ACCOUNT_STATUS.PENDING || user.accountStatus === ACCOUNT_STATUS.LOCKED) {
    updates[USER_COL.ACCOUNT_STATUS] = ACCOUNT_STATUS.ACTIVE;
  }

  updateUserCells_(user, updates);
}

/** Stripe 由来の契約情報を反映する。 */
function applySubscriptionToUser_(user, info) {
  var updates = {};

  if (trimStr_(info.stripeCustomerId) !== '') {
    updates[USER_COL.STRIPE_CUSTOMER_ID] = trimStr_(info.stripeCustomerId);
  }

  if (trimStr_(info.stripeSubscriptionId) !== '') {
    updates[USER_COL.STRIPE_SUBSCRIPTION_ID] = trimStr_(info.stripeSubscriptionId);
  }

  if (trimStr_(info.subscriptionStatus) !== '') {
    updates[USER_COL.SUBSCRIPTION_STATUS] = trimStr_(info.subscriptionStatus);
  }

  updateUserCells_(user, updates);
}

/**
 * 契約状態から利用可能かを判定する。
 *
 * payment_exempt が TRUE なら契約確認そのものを省く（管理者・招待枠）。
 * trialing と past_due の扱いは設定で変えられる。
 */
function isSubscriptionUsable_(user) {
  if (user.paymentExempt === true) {
    return true;
  }

  var status = trimStr_(user.subscriptionStatus).toLowerCase();

  if (status === SUBSCRIPTION_STATUS.ACTIVE) {
    return true;
  }

  if (status === SUBSCRIPTION_STATUS.TRIALING) {
    return getSettingBool_('TRIALING_ALLOWED', true);
  }

  if (status === SUBSCRIPTION_STATUS.PAST_DUE) {
    return getSettingBool_('PAST_DUE_ALLOWED', false);
  }

  /*
   * exempt は payment_exempt = TRUE と併用する前提の表示用の値。
   * payment_exempt が FALSE のまま exempt だけ書かれていても通さない。
   */
  return false;
}

/** 管理者かどうか。メールアドレスでは判定しない。 */
function isAdminUser_(user) {
  return trimStr_(user.role).toLowerCase() === ROLE.ADMIN;
}

/** 画面へ返してよい利用者情報。ハッシュ・ソルトは含めない。 */
function toPublicUser_(user) {
  return {
    userId: user.userId,
    email: user.email,
    role: user.role,
    accountStatus: user.accountStatus,
    subscriptionStatus: user.subscriptionStatus,
    paymentExempt: user.paymentExempt,
    isAdmin: isAdminUser_(user)
  };
}

/**
 * セッション。
 *
 * ------------------------------------------------------------------
 * 何を信頼するか
 * ------------------------------------------------------------------
 * ブラウザが持つのは、推測困難なランダム文字列（セッショントークン）だけ。
 * 有効期限も利用者IDもロールも、すべてサーバー側（sessions シート）で持つ。
 *
 * ブラウザ側の localStorage を書き換えても、
 * サーバーに無いトークンは verifySession で必ず落ちる。
 * 「LocalStorage にログイン済みと書いたからログイン済み」にはならない。
 * ------------------------------------------------------------------
 *
 * シートへ保存するのは HMAC-SHA256(トークン, SESSION_SECRET) だけ。
 * 平文トークンは保存しない。
 */

/** セッショントークンの保存用ハッシュ。 */
function hashSessionToken_(token) {
  var secret = getProperty_(PROP.SESSION_SECRET);

  if (secret === '') {
    throw new Error('SESSION_SECRET が未設定です。setupAuthSystem() を実行してください。');
  }

  return hmacHex_(token, secret);
}

/** 有効期間（ミリ秒）。「ログイン状態を保持する」で切り替える。 */
function sessionTtlMs_(remember) {
  if (remember === true) {
    return getSettingNumber_('REMEMBER_SESSION_TTL_DAYS', 30) * 24 * 60 * 60 * 1000;
  }

  return getSettingNumber_('SESSION_TTL_HOURS', 12) * 60 * 60 * 1000;
}

/**
 * セッションを発行する。
 * @return {{token: string, expiresAtMs: number, sessionId: string}}
 */
function issueSession_(user, remember, userAgent) {
  var token = randomToken_();
  var issuedAtMs = nowMs_();
  var expiresAtMs = issuedAtMs + sessionTtlMs_(remember === true);

  var row = [];
  row[SESSION_COL.SESSION_ID - 1] = newId_('ses');
  row[SESSION_COL.USER_ID - 1] = user.userId;
  row[SESSION_COL.TOKEN_HASH - 1] = hashSessionToken_(token);
  row[SESSION_COL.REMEMBER_LOGIN - 1] = boolToCell_(remember === true);
  row[SESSION_COL.ISSUED_AT - 1] = toIso_(new Date(issuedAtMs));
  row[SESSION_COL.EXPIRES_AT - 1] = toIso_(new Date(expiresAtMs));
  row[SESSION_COL.REVOKED_AT - 1] = '';
  row[SESSION_COL.LAST_ACCESS_AT - 1] = toIso_(new Date(issuedAtMs));
  row[SESSION_COL.USER_AGENT_SUMMARY - 1] = clip_(summarizeUserAgent_(userAgent), 64);

  appendRow_(SHEETS.SESSIONS, row);

  return {
    token: token,
    sessionId: row[SESSION_COL.SESSION_ID - 1],
    expiresAtMs: expiresAtMs,
    remember: remember === true
  };
}

/**
 * セッションを検証する。
 *
 * 有効なら最終アクセス時刻を更新する。
 * 有効期限そのものは延長しない（延長すると実質無期限になる）。
 *
 * @return {{ok: boolean, reason: string, user: Object, session: Object}}
 */
function verifySessionToken_(token) {
  var value = trimStr_(token);

  if (value === '' || value.length > 256) {
    return { ok: false, reason: 'MALFORMED' };
  }

  var hash;

  try {
    hash = hashSessionToken_(value);
  } catch (err) {
    return { ok: false, reason: 'NOT_CONFIGURED' };
  }

  var found = findRow_(SHEETS.SESSIONS, function (values) {
    return timingSafeEqual_(trimStr_(values[SESSION_COL.TOKEN_HASH - 1]), hash);
  });

  if (!found) {
    return { ok: false, reason: 'NOT_FOUND' };
  }

  var values = found.values;

  if (trimStr_(values[SESSION_COL.REVOKED_AT - 1]) !== '') {
    return { ok: false, reason: 'REVOKED' };
  }

  var expiresAtMs = parseTimeMs_(values[SESSION_COL.EXPIRES_AT - 1]);

  if (expiresAtMs === 0 || expiresAtMs <= nowMs_()) {
    return { ok: false, reason: 'EXPIRED' };
  }

  var user = findUserById_(trimStr_(values[SESSION_COL.USER_ID - 1]));

  if (!user) {
    return { ok: false, reason: 'USER_NOT_FOUND' };
  }

  /*
   * セッションが生きていても、いま利用してよいかは毎回確かめる。
   * 契約が切れた・アカウントを止めた場合、次のアクセスで締め出す。
   */
  if (user.accountStatus !== ACCOUNT_STATUS.ACTIVE) {
    return { ok: false, reason: 'ACCOUNT_NOT_ACTIVE' };
  }

  if (!isSubscriptionUsable_(user)) {
    return { ok: false, reason: 'SUBSCRIPTION_INACTIVE' };
  }

  updateCell_(SHEETS.SESSIONS, found.rowNumber, SESSION_COL.LAST_ACCESS_AT, nowIso_());

  return {
    ok: true,
    reason: '',
    user: user,
    session: {
      rowNumber: found.rowNumber,
      sessionId: trimStr_(values[SESSION_COL.SESSION_ID - 1]),
      expiresAtMs: expiresAtMs,
      remember: parseBool_(values[SESSION_COL.REMEMBER_LOGIN - 1])
    }
  };
}

/** 1つのセッションを無効にする（ログアウト）。 */
function revokeSessionByToken_(token) {
  var value = trimStr_(token);

  if (value === '') {
    return false;
  }

  var hash;

  try {
    hash = hashSessionToken_(value);
  } catch (err) {
    return false;
  }

  var found = findRow_(SHEETS.SESSIONS, function (values) {
    return timingSafeEqual_(trimStr_(values[SESSION_COL.TOKEN_HASH - 1]), hash);
  });

  if (!found) {
    return false;
  }

  if (trimStr_(found.values[SESSION_COL.REVOKED_AT - 1]) === '') {
    updateCell_(SHEETS.SESSIONS, found.rowNumber, SESSION_COL.REVOKED_AT, nowIso_());
  }

  return true;
}

/**
 * ある利用者のセッションをすべて無効にする。
 * パスワード変更時に必ず呼ぶ。呼ばないと、変更前のセッションが生き残る。
 *
 * @return {number} 無効にした件数
 */
function revokeAllSessionsForUser_(userId) {
  var id = trimStr_(userId);

  if (id === '') {
    return 0;
  }

  var rows = findRows_(SHEETS.SESSIONS, function (values) {
    return trimStr_(values[SESSION_COL.USER_ID - 1]) === id
      && trimStr_(values[SESSION_COL.REVOKED_AT - 1]) === '';
  });

  var stamp = nowIso_();

  for (var i = 0; i < rows.length; i++) {
    updateCell_(SHEETS.SESSIONS, rows[i].rowNumber, SESSION_COL.REVOKED_AT, stamp);
  }

  return rows.length;
}

/**
 * 期限切れ・失効済みのセッション行を掃除する。
 * 定期実行トリガーから呼ぶ想定。
 */
function cleanupExpiredSessions() {
  return withLock_(function () {
    var sheet = getSheet_(SHEETS.SESSIONS);
    var rows = readRows_(SHEETS.SESSIONS);
    var threshold = nowMs_() - (7 * 24 * 60 * 60 * 1000);
    var removed = 0;

    for (var i = rows.length - 1; i >= 0; i--) {
      var expiresMs = parseTimeMs_(rows[i][SESSION_COL.EXPIRES_AT - 1]);
      var revoked = trimStr_(rows[i][SESSION_COL.REVOKED_AT - 1]) !== '';

      if ((revoked || (expiresMs !== 0 && expiresMs <= nowMs_())) && expiresMs < threshold) {
        sheet.deleteRow(i + 2);
        removed++;
      }
    }

    Logger.log('cleanupExpiredSessions: ' + removed + ' 行を削除しました。');
    return { removed: removed };
  });
}

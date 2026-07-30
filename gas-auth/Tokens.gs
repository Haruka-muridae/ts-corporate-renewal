/**
 * 一時トークン（パスワード初期設定・再設定）。
 *
 * ------------------------------------------------------------------
 * 平文で保存しない
 * ------------------------------------------------------------------
 * シートへ書くのは HMAC-SHA256(トークン, TOKEN_SECRET) の16進だけ。
 * TOKEN_SECRET は Script Properties にあり、シートには無い。
 *
 * 単純な SHA-256 ではなく鍵付きにしているのは、
 * シートが漏れたときに「総当たりで平文トークンを求める」ことを
 * 鍵なしには行えなくするため。
 * ------------------------------------------------------------------
 *
 * 1度使ったトークンは used_at を埋めて再利用できなくする。
 * 使用の確定は必ず withLock_ の中で行う（同時に2回使われないように）。
 */

/** トークンの保存用ハッシュ。 */
function hashToken_(token) {
  var secret = getProperty_(PROP.TOKEN_SECRET);

  if (secret === '') {
    throw new Error('TOKEN_SECRET が未設定です。setupAuthSystem() を実行してください。');
  }

  return hmacHex_(token, secret);
}

/** 種類ごとの有効期間（ミリ秒）。 */
function tokenTtlMs_(tokenType) {
  if (tokenType === TOKEN_TYPE.PASSWORD_RESET) {
    return getSettingNumber_('RESET_TOKEN_TTL_MINUTES', 60) * 60 * 1000;
  }

  return getSettingNumber_('INITIAL_TOKEN_TTL_HOURS', 72) * 60 * 60 * 1000;
}

/**
 * トークンを発行する。
 * 戻り値の token は **この瞬間だけ** 平文で存在する。
 * メール本文へ載せる以外の用途で保持しない。
 *
 * @return {{token: string, tokenId: string, expiresAtMs: number}}
 */
function issueToken_(userId, tokenType) {
  var token = randomToken_();
  var expiresAtMs = nowMs_() + tokenTtlMs_(tokenType);

  var row = [];
  row[TOKEN_COL.TOKEN_ID - 1] = newId_('tok');
  row[TOKEN_COL.USER_ID - 1] = trimStr_(userId);
  row[TOKEN_COL.TOKEN_HASH - 1] = hashToken_(token);
  row[TOKEN_COL.TOKEN_TYPE - 1] = tokenType;
  row[TOKEN_COL.EXPIRES_AT - 1] = toIso_(new Date(expiresAtMs));
  row[TOKEN_COL.USED_AT - 1] = '';
  row[TOKEN_COL.CREATED_AT - 1] = nowIso_();

  appendRow_(SHEETS.PASSWORD_TOKENS, row);

  return { token: token, tokenId: row[TOKEN_COL.TOKEN_ID - 1], expiresAtMs: expiresAtMs };
}

/**
 * 同じ利用者の未使用トークンを、まとめて使用済みにする。
 * 新しく発行する前に呼び、古いリンクを生かしておかない。
 */
function invalidateTokens_(userId, tokenType) {
  var id = trimStr_(userId);

  var rows = findRows_(SHEETS.PASSWORD_TOKENS, function (values) {
    return trimStr_(values[TOKEN_COL.USER_ID - 1]) === id
      && trimStr_(values[TOKEN_COL.TOKEN_TYPE - 1]) === tokenType
      && trimStr_(values[TOKEN_COL.USED_AT - 1]) === '';
  });

  for (var i = 0; i < rows.length; i++) {
    updateCell_(SHEETS.PASSWORD_TOKENS, rows[i].rowNumber, TOKEN_COL.USED_AT, nowIso_());
  }

  return rows.length;
}

/**
 * トークンを検証する（この時点では使用済みにしない）。
 *
 * @return {{ok: boolean, reason: string, rowNumber: number, userId: string, tokenType: string}}
 */
function verifyToken_(token, expectedType) {
  var value = trimStr_(token);

  if (value === '' || value.length > 256) {
    return { ok: false, reason: 'MALFORMED' };
  }

  var hash;

  try {
    hash = hashToken_(value);
  } catch (err) {
    return { ok: false, reason: 'NOT_CONFIGURED' };
  }

  var found = findRow_(SHEETS.PASSWORD_TOKENS, function (values) {
    return timingSafeEqual_(trimStr_(values[TOKEN_COL.TOKEN_HASH - 1]), hash);
  });

  if (!found) {
    return { ok: false, reason: 'NOT_FOUND' };
  }

  var values = found.values;

  if (trimStr_(values[TOKEN_COL.USED_AT - 1]) !== '') {
    return { ok: false, reason: 'ALREADY_USED' };
  }

  var expiresAtMs = parseTimeMs_(values[TOKEN_COL.EXPIRES_AT - 1]);

  if (expiresAtMs === 0 || expiresAtMs <= nowMs_()) {
    return { ok: false, reason: 'EXPIRED' };
  }

  var tokenType = trimStr_(values[TOKEN_COL.TOKEN_TYPE - 1]);

  if (expectedType && tokenType !== expectedType) {
    return { ok: false, reason: 'WRONG_TYPE' };
  }

  return {
    ok: true,
    reason: '',
    rowNumber: found.rowNumber,
    userId: trimStr_(values[TOKEN_COL.USER_ID - 1]),
    tokenType: tokenType
  };
}

/** 使用済みにする。verifyToken_ が返した行番号を渡す。 */
function markTokenUsed_(rowNumber) {
  updateCell_(SHEETS.PASSWORD_TOKENS, rowNumber, TOKEN_COL.USED_AT, nowIso_());
}

/**
 * 期限切れ・使用済みのトークン行を掃除する。
 * 定期実行トリガーから呼ぶ想定（必須ではない）。
 */
function cleanupExpiredTokens() {
  return withLock_(function () {
    var sheet = getSheet_(SHEETS.PASSWORD_TOKENS);
    var rows = readRows_(SHEETS.PASSWORD_TOKENS);
    var threshold = nowMs_() - (30 * 24 * 60 * 60 * 1000);
    var removed = 0;

    /* 下の行から消す。上から消すと行番号がずれる。 */
    for (var i = rows.length - 1; i >= 0; i--) {
      var createdMs = parseTimeMs_(rows[i][TOKEN_COL.CREATED_AT - 1]);
      var expiresMs = parseTimeMs_(rows[i][TOKEN_COL.EXPIRES_AT - 1]);
      var used = trimStr_(rows[i][TOKEN_COL.USED_AT - 1]) !== '';

      if ((used || expiresMs <= nowMs_()) && createdMs !== 0 && createdMs < threshold) {
        sheet.deleteRow(i + 2);
        removed++;
      }
    }

    Logger.log('cleanupExpiredTokens: ' + removed + ' 行を削除しました。');
    return { removed: removed };
  });
}

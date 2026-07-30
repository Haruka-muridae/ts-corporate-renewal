/**
 * Apps Script 上でだけ確認できることのための関数。
 *
 * ロジックの自動テストは Node 側（リポジトリの tests/）で行う。
 * ここに置くのは「実際の Apps Script の速度」など、
 * 実環境でしか測れないものに限る。
 *
 * いずれもエディタから手動で実行する。Web からは呼べない。
 */

/**
 * パスワードハッシュの所要時間を測る。
 *
 * PBKDF2 の反復回数は、Apps Script の実行速度で決まる。
 * ここで実測し、認証設定シートの PBKDF2_ITERATIONS を決めること。
 *
 * 目安: ログイン1回あたり 0.5〜1.5 秒に収まる値を選ぶ。
 * 速すぎる（＝弱い）値のまま運用しない。
 */
function benchmarkPasswordHashing() {
  var candidates = [1000, 5000, 10000, 20000];
  var salt = randomSalt_();
  var lines = ['PBKDF2-HMAC-SHA256 の所要時間'];

  for (var i = 0; i < candidates.length; i++) {
    var start = new Date().getTime();
    pbkdf2Sha256Hex_('benchmark-password-example', salt, candidates[i]);
    var elapsed = new Date().getTime() - start;

    lines.push('  ' + candidates[i] + ' 回: ' + elapsed + ' ms');
  }

  lines.push('');
  lines.push('現在の設定: ' + getPbkdf2Iterations_() + ' 回');
  lines.push('変更する場合は認証設定シートの PBKDF2_ITERATIONS を書き換える。');

  var text = lines.join('\n');
  Logger.log(text);
  return text;
}

/**
 * 実環境での通し確認。
 *
 * 一時的な利用者を作り、パスワード設定 → ログイン → セッション検証 →
 * ログアウトまでを行い、最後に作った行を消す。
 *
 * **本番のスプレッドシートに対して実行される**。
 * 実行後にユーザー管理シートへ余分な行が残っていないか確認すること。
 */
function selfTestAuthFlow() {
  var email = 'selftest+' + Utilities.getUuid().slice(0, 8) + '@example.invalid';
  var password = 'SelfTest-Password-2026';
  var lines = [];
  var createdUserId = '';

  try {
    var user = withLock_(function () {
      return createUser_({
        email: email,
        role: ROLE.MEMBER,
        subscriptionStatus: SUBSCRIPTION_STATUS.ACTIVE,
        paymentExempt: false,
        accountStatus: ACCOUNT_STATUS.PENDING
      });
    });

    createdUserId = user.userId;
    lines.push('利用者作成: ok');

    var issued = withLock_(function () {
      return issueToken_(user.userId, TOKEN_TYPE.INITIAL_SETUP);
    });

    lines.push('トークン発行: ok');

    var set = performPasswordSet_({
      token: issued.token,
      password: password,
      passwordConfirm: password,
      expectedType: TOKEN_TYPE.INITIAL_SETUP
    });

    lines.push('パスワード設定: ' + (set.ok ? 'ok' : 'NG'));

    var reuse = performPasswordSet_({
      token: issued.token,
      password: password,
      passwordConfirm: password,
      expectedType: TOKEN_TYPE.INITIAL_SETUP
    });

    lines.push('使用済みトークンの再利用拒否: ' + (reuse.ok ? 'NG' : 'ok'));

    var bad = performLogin_({ email: email, password: 'wrong-password', remember: false });
    lines.push('誤パスワードで失敗: ' + (bad.ok ? 'NG' : 'ok'));

    var good = performLogin_({ email: email, password: password, remember: false });
    lines.push('正しいパスワードで成功: ' + (good.ok ? 'ok' : 'NG'));

    if (good.ok) {
      var verified = verifySessionToken_(good.data.sessionToken);
      lines.push('セッション検証: ' + (verified.ok ? 'ok' : 'NG'));

      revokeSessionByToken_(good.data.sessionToken);
      var after = verifySessionToken_(good.data.sessionToken);
      lines.push('ログアウト後は無効: ' + (after.ok ? 'NG' : 'ok'));
    }
  } catch (err) {
    lines.push('例外: ' + err);
  } finally {
    if (createdUserId !== '') {
      lines.push('後片付け: ' + cleanupSelfTestUser_(createdUserId) + ' 行を削除しました。');
    }
  }

  var text = lines.join('\n');
  Logger.log(text);
  return text;
}

/** selfTestAuthFlow が作った行を消す。 */
function cleanupSelfTestUser_(userId) {
  return withLock_(function () {
    var removed = 0;

    var userSheet = getSheet_(SHEETS.USERS);
    var users = readRows_(SHEETS.USERS);

    for (var i = users.length - 1; i >= 0; i--) {
      if (trimStr_(users[i][USER_COL.USER_ID - 1]) === userId) {
        userSheet.deleteRow(i + 2);
        removed++;
      }
    }

    var tokenSheet = getSheet_(SHEETS.PASSWORD_TOKENS);
    var tokens = readRows_(SHEETS.PASSWORD_TOKENS);

    for (var j = tokens.length - 1; j >= 0; j--) {
      if (trimStr_(tokens[j][TOKEN_COL.USER_ID - 1]) === userId) {
        tokenSheet.deleteRow(j + 2);
        removed++;
      }
    }

    var sessionSheet = getSheet_(SHEETS.SESSIONS);
    var sessions = readRows_(SHEETS.SESSIONS);

    for (var k = sessions.length - 1; k >= 0; k--) {
      if (trimStr_(sessions[k][SESSION_COL.USER_ID - 1]) === userId) {
        sessionSheet.deleteRow(k + 2);
        removed++;
      }
    }

    return removed;
  });
}

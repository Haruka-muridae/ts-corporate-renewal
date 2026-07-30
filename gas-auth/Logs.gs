/**
 * 認証ログ。
 *
 * ------------------------------------------------------------------
 * 書いてはならないもの
 * ------------------------------------------------------------------
 *   パスワード / パスワードハッシュ / ソルト /
 *   セッショントークン / 再設定トークン / Stripe の秘密鍵
 *
 * メールアドレスは maskEmail_() を通してから書く。
 * ------------------------------------------------------------------
 *
 * ログの書き込み失敗で本処理を止めない。
 * 「ログが残らなかった」より「ログインできなかった」ほうが影響が大きい。
 */

/**
 * ログイン試行を記録する。
 * @param {Object} entry { userId, email, result, reasonCode, userAgent }
 */
function logLogin_(entry) {
  try {
    appendRow_(SHEETS.LOGIN_LOGS, [
      newId_('log'),
      clip_(entry.userId, 128),
      maskEmail_(entry.email),
      clip_(entry.result, 32),
      clip_(entry.reasonCode, 64),
      nowIso_(),
      clip_(summarizeUserAgent_(entry.userAgent), 64)
    ]);
  } catch (err) {
    Logger.log('logLogin_ failed: ' + err);
  }
}

/**
 * 管理操作を記録する。
 * セットアップ、管理者レコード作成、契約状態の変更などが対象。
 */
function logAdminAction_(actor, action, target, detail) {
  try {
    appendRow_(SHEETS.ADMIN_ACTION_LOGS, [
      newId_('adm'),
      clip_(actor, 128),
      clip_(action, 64),
      clip_(target, 128),
      clip_(detail, 512),
      nowIso_()
    ]);
  } catch (err) {
    Logger.log('logAdminAction_ failed: ' + err);
  }
}

/**
 * 想定外のエラーを記録する。
 * message には利用者の入力値をそのまま入れない（伏せてから渡すこと）。
 */
function logSystemError_(scope, message) {
  try {
    appendRow_(SHEETS.SYSTEM_ERROR_LOGS, [
      newId_('err'),
      clip_(scope, 64),
      clip_(message, 1000),
      nowIso_()
    ]);
  } catch (err) {
    Logger.log('logSystemError_ failed: ' + err);
  }
}

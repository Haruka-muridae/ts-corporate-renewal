/**
 * API レスポンスの共通生成。
 *
 * 常に JSON を返す。
 *   成功: { success: true,  data: {...} }
 *   失敗: { success: false, error: { code, message } }
 *
 * ------------------------------------------------------------------
 * 失敗理由を画面へ書かない（重要）
 * ------------------------------------------------------------------
 * 「未登録のメールアドレス」「パスワード不一致」「契約が切れている」を
 * 区別して返すと、攻撃者にアカウントの存在や状態を教えることになる。
 *
 * 画面へ返すのは AUTH_FAILED（定型文）だけにし、
 * 本当の理由は failure_reason_code として認証ログにだけ残す。
 * ------------------------------------------------------------------
 */

function jsonOutput_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function ok_(data) {
  return jsonOutput_({ success: true, data: data || {} });
}

function fail_(code, message) {
  return jsonOutput_({
    success: false,
    error: {
      code: code || 'UNKNOWN',
      message: message || 'エラーが発生しました。'
    }
  });
}

/** クライアントへ返してよい定型メッセージ。 */
var ERRORS = {
  INVALID_ACTION: ['INVALID_ACTION', 'サポートされていない操作です。'],
  INVALID_REQUEST: ['INVALID_REQUEST', 'リクエストの形式が不正です。'],

  /* ログイン失敗。理由は一切区別しない。 */
  AUTH_FAILED: ['AUTH_FAILED', 'メールアドレスまたはパスワードが正しくありません。'],
  /* 失敗回数の上限に達している。 */
  LOCKED: ['LOCKED', 'ログインを一時的に制限しています。時間をおいて再度お試しください。'],

  SESSION_INVALID: ['SESSION_INVALID', 'ログインの有効期限が切れました。もう一度ログインしてください。'],

  TOKEN_INVALID: ['TOKEN_INVALID', 'このリンクは期限切れか、すでに使用済みです。もう一度手続きをやり直してください。'],
  PASSWORD_WEAK: ['PASSWORD_WEAK', 'パスワードが条件を満たしていません。'],
  PASSWORD_MISMATCH: ['PASSWORD_MISMATCH', '確認用パスワードが一致しません。'],

  PLAN_NOT_FOUND: ['PLAN_NOT_FOUND', '選択されたプランは現在ご利用いただけません。'],
  STRIPE_ERROR: ['STRIPE_ERROR', '決済手続きを開始できませんでした。時間をおいて再度お試しください。'],
  RATE_LIMITED: ['RATE_LIMITED', 'アクセスが集中しています。時間をおいて再度お試しください。'],

  NOT_CONFIGURED: ['NOT_CONFIGURED', 'この機能は現在ご利用いただけません。'],
  SERVER_ERROR: ['SERVER_ERROR', 'サーバーでエラーが発生しました。時間をおいてお試しください。']
};

function failFrom_(pair) {
  return fail_(pair[0], pair[1]);
}

/**
 * 認証ログにだけ残す失敗理由。画面へは出さない。
 */
var FAILURE_REASON = {
  NOT_FOUND: 'USER_NOT_FOUND',
  BAD_PASSWORD: 'BAD_PASSWORD',
  LOCKED: 'LOCKED',
  NOT_ACTIVE: 'ACCOUNT_NOT_ACTIVE',
  NO_SUBSCRIPTION: 'SUBSCRIPTION_INACTIVE',
  NO_PASSWORD: 'PASSWORD_NOT_SET',
  INVALID_INPUT: 'INVALID_INPUT'
};

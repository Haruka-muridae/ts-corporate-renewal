/**
 * メール送信。
 *
 * 送信に失敗しても、呼び出し元の処理は止めない。
 * 「メールが届かなかった」ことを利用者へ返すと、
 * そのアドレスが登録済みかどうかの手がかりになるため。
 * 失敗は system_error_logs にだけ残す。
 */

/** トークン付きのURLを組み立てる。 */
function buildTokenUrl_(baseUrl, token) {
  var base = trimStr_(baseUrl);

  if (base === '') {
    return '';
  }

  var separator = base.indexOf('?') === -1 ? '?' : '&';
  return base + separator + 'token=' + encodeURIComponent(token);
}

/** 実際に送る。設定で無効化されていれば送らない。 */
function sendMail_(to, subject, body) {
  if (!getSettingBool_('MAIL_ENABLED', true)) {
    Logger.log('MAIL_ENABLED=FALSE のため送信しません: ' + maskEmail_(to));
    return false;
  }

  var address = normalizeEmail_(to);

  if (!isValidEmail_(address)) {
    return false;
  }

  try {
    MailApp.sendEmail({
      to: address,
      subject: subject,
      body: body,
      name: getSetting_('MAIL_SENDER_NAME') || 'TSAM AI'
    });

    return true;
  } catch (err) {
    /* 本文も宛先も残さない。伏せたアドレスと種別だけ。 */
    logSystemError_('mail', 'send failed to ' + maskEmail_(address) + ': ' + (err && err.message));
    return false;
  }
}

function sendInitialSetupMail_(email, token, expiresAtMs) {
  var url = buildTokenUrl_(getPasswordSetupUrl_(), token);

  if (url === '') {
    logSystemError_('mail', 'パスワード初期設定URLが未設定のため送信できません。');
    return false;
  }

  var mail = templateInitialSetup_(url, expiresAtMs);
  return sendMail_(email, mail.subject, mail.body);
}

function sendPasswordResetMail_(email, token, expiresAtMs) {
  var url = buildTokenUrl_(getPasswordResetUrl_(), token);

  if (url === '') {
    logSystemError_('mail', 'パスワード再設定URLが未設定のため送信できません。');
    return false;
  }

  var mail = templatePasswordReset_(url, expiresAtMs);
  return sendMail_(email, mail.subject, mail.body);
}

function sendPasswordChangedMail_(email) {
  var mail = templatePasswordChanged_(getLoginUrl_());
  return sendMail_(email, mail.subject, mail.body);
}

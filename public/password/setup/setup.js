/*
 * パスワードの初期設定画面。
 *
 * 決済完了後に届くメールのリンクから開く。
 * 設定が終わってもログイン状態にはしない（自動ログインは行わない）。
 * ログイン画面へ案内し、設定したパスワードで実際に入れることを
 * 利用者自身に確かめてもらう。
 */

import { setScreenDepth } from '../../auth/config.js';
import { setupPassword } from '../../auth/api.js';
import { setupPasswordForm } from '../../auth/password-form.js';
import { clearSessionToken } from '../../auth/session.js';

/* /password/setup/ はサイトのルートから2階層下。 */
setScreenDepth(2);

/*
 * 別の利用者でログインしたままこのリンクを開く場合がある。
 * 手元のセッションは先に捨てておく。
 */
clearSessionToken();

setupPasswordForm({
  form: document.getElementById('setup-form'),
  passwordInput: document.getElementById('setup-password'),
  confirmInput: document.getElementById('setup-confirm'),
  submitButton: document.getElementById('setup-submit'),
  passwordToggle: document.getElementById('setup-password-toggle'),
  confirmToggle: document.getElementById('setup-confirm-toggle'),
  messageElement: document.getElementById('setup-message'),
  hintElement: document.getElementById('setup-password-hint'),
  doneElement: document.getElementById('setup-done'),
  submitPassword: (token, password, passwordConfirm) => setupPassword({
    token,
    password,
    passwordConfirm,
  }),
  successText: 'パスワードを設定しました。ログイン画面からログインしてください。',
  busyLabel: '設定しています…',
});

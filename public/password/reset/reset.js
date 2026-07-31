/*
 * パスワードの再設定画面。
 *
 * ------------------------------------------------------------------
 * 登録の有無を漏らさない（重要）
 * ------------------------------------------------------------------
 * 申し込みの結果は、登録済みでも未登録でも **同じ文言・同じ見た目** にする。
 * 「そのメールアドレスは登録されていません」と出すと、
 * 誰が利用者かを外部から調べられてしまう。
 *
 * サーバー側も同じ方針で、常に成功として応答する。
 * ------------------------------------------------------------------
 */

import { setScreenDepth } from '../../auth/config.js';
import { requestPasswordReset, resetPassword, ApiError } from '../../auth/api.js';
import { setupPasswordForm } from '../../auth/password-form.js';
import { clearSessionToken } from '../../auth/session.js';
import {
  MESSAGES,
  isValidEmail,
  createMessageArea,
  createSubmitButton,
  readTokenParam,
} from '../../auth/ui.js';

setScreenDepth(2);

const requestStep = document.getElementById('reset-step-request');
const setStep = document.getElementById('reset-step-set');

/*
 * メールのリンクから来たかどうかで、出す段階を決める。
 * token の読み取り自体は setupPasswordForm 側でも行うが、
 * ここでは「どちらの段階を出すか」の判断だけに使う。
 */
const hasToken = readTokenParam() !== '';

if (hasToken) {
  requestStep.hidden = true;
  setStep.hidden = false;

  /* 別の利用者でログインしたまま開いた場合に備えて、手元を捨てる。 */
  clearSessionToken();

  setupPasswordForm({
    form: document.getElementById('reset-form'),
    passwordInput: document.getElementById('reset-password'),
    confirmInput: document.getElementById('reset-confirm'),
    submitButton: document.getElementById('reset-submit'),
    passwordToggle: document.getElementById('reset-password-toggle'),
    confirmToggle: document.getElementById('reset-confirm-toggle'),
    messageElement: document.getElementById('reset-message'),
    hintElement: document.getElementById('reset-password-hint'),
    doneElement: document.getElementById('reset-done'),
    submitPassword: (token, password, passwordConfirm) => resetPassword({
      token,
      password,
      passwordConfirm,
    }),
    successText: 'パスワードを変更しました。新しいパスワードでログインしてください。',
    busyLabel: '変更しています…',
  });
} else {
  initRequestStep();
}

/* 第1段階: メールアドレスを受け取って案内を送る。 */
function initRequestStep() {
  const form = document.getElementById('request-form');
  const emailInput = document.getElementById('request-email');
  const submitButton = document.getElementById('request-submit');
  const messageElement = document.getElementById('request-message');

  const message = createMessageArea(messageElement);
  const submit = createSubmitButton(submitButton, { busyLabel: '送信しています…' });

  emailInput.addEventListener('input', () => {
    emailInput.removeAttribute('aria-invalid');

    if (messageElement.dataset.kind === 'error') {
      message.clear();
    }
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();

    if (submit.isBusy()) {
      return;
    }

    message.clear();

    const email = emailInput.value.trim();

    /*
     * 形式の確認だけはここで行う。
     * 「登録されているか」はこの画面では一切扱わない。
     */
    if (email === '') {
      message.show(MESSAGES.emailRequired, 'error');
      emailInput.setAttribute('aria-invalid', 'true');
      emailInput.focus();
      return;
    }

    if (!isValidEmail(email)) {
      message.show(MESSAGES.emailInvalid, 'error');
      emailInput.setAttribute('aria-invalid', 'true');
      emailInput.focus();
      return;
    }

    submit.start();

    try {
      await requestPasswordReset(email);

      form.hidden = true;
      message.show(
        '登録されているメールアドレスの場合、パスワード再設定のご案内を送信しました。',
        'success',
      );
      message.focus();
    } catch (error) {
      /*
       * ここへ来るのは通信・設定の失敗だけ。
       * 「未登録だった」ことでは失敗しない（サーバーが常に成功を返す）。
       */
      message.show(
        error instanceof ApiError ? error.userMessage : MESSAGES.network,
        'error',
      );
      message.focus();
    } finally {
      submit.stop();
    }
  });
}

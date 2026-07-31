/*
 * 「新しいパスワードを設定する」フォームの共通処理。
 *
 * 初期設定（password/setup/）と再設定（password/reset/）は、
 * 呼ぶAPIが違うだけで画面の振る舞いは同じ。
 * 二重に実装すると、片方だけ検証が抜けるといった食い違いが起きる。
 *
 * ------------------------------------------------------------------
 * ここでの検証は「利用者に早く気づいてもらう」ためのもの
 * ------------------------------------------------------------------
 * 最低文字数・一致・空白のみ、いずれも **サーバー側でも必ず確認する**。
 * 画面の検証は迂回できるため、これを保護とみなさない。
 * ------------------------------------------------------------------
 */

import { AUTH_CONFIG } from './config.js';
import { publicConfig, ApiError } from './api.js';
import {
  MESSAGES,
  createMessageArea,
  createSubmitButton,
  attachPasswordToggle,
  readTokenParam,
  stripTokenFromUrl,
} from './ui.js';

/*
 * @param {Object} options
 *   form, passwordInput, confirmInput, submitButton,
 *   passwordToggle, confirmToggle, messageElement, hintElement,
 *   doneElement … 完了後に出す案内（任意）
 *   submitPassword(token, password, passwordConfirm) … 実際に呼ぶAPI
 *   successText … 完了時の文言
 *   busyLabel   … 送信中のボタン文言
 */
export function setupPasswordForm(options) {
  const {
    form,
    passwordInput,
    confirmInput,
    submitButton,
    passwordToggle,
    confirmToggle,
    messageElement,
    hintElement,
    doneElement,
    submitPassword,
    successText,
    busyLabel = '設定しています…',
  } = options;

  const message = createMessageArea(messageElement);
  const submit = createSubmitButton(submitButton, { busyLabel });

  attachPasswordToggle(passwordToggle, passwordInput);
  attachPasswordToggle(confirmToggle, confirmInput);

  /*
   * トークンは読み取り後すぐ URL から消す。
   * 履歴・共有・referrer 経由で第三者へ渡らないようにする。
   */
  const token = readTokenParam();
  stripTokenFromUrl();

  let minLength = AUTH_CONFIG.passwordMinLength;

  /* サーバーの実際の設定に合わせてヒント文を直す（判定はサーバーが行う）。 */
  publicConfig()
    .then((config) => {
      const value = Number(config?.passwordMinLength);

      if (Number.isFinite(value) && value > 0) {
        minLength = Math.floor(value);

        if (hintElement) {
          hintElement.textContent = `${minLength}文字以上で設定してください。`;
        }
      }
    })
    .catch(() => {
      /* 取得できなくても既定値で動く。 */
    });

  if (token === '') {
    message.show(
      'このリンクは正しくありません。お手数ですが、もう一度手続きをやり直してください。',
      'error',
    );
    form.hidden = true;
    return;
  }

  [passwordInput, confirmInput].forEach((input) => {
    input.addEventListener('input', () => {
      input.removeAttribute('aria-invalid');

      if (messageElement.dataset.kind === 'error') {
        message.clear();
      }
    });
  });

  function validate() {
    const password = passwordInput.value;
    const confirm = confirmInput.value;

    if (password === '') {
      return { ok: false, text: MESSAGES.passwordRequired, field: passwordInput };
    }

    if (password.trim() === '') {
      return { ok: false, text: 'パスワードに空白以外の文字を含めてください。', field: passwordInput };
    }

    if (password.length < minLength) {
      return {
        ok: false,
        text: `パスワードは${minLength}文字以上で設定してください。`,
        field: passwordInput,
      };
    }

    if (confirm === '') {
      return { ok: false, text: '確認用のパスワードを入力してください。', field: confirmInput };
    }

    if (password !== confirm) {
      return { ok: false, text: '確認用パスワードが一致しません。', field: confirmInput };
    }

    return { ok: true, password, confirm };
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();

    if (submit.isBusy()) {
      return;
    }

    message.clear();

    const check = validate();

    if (!check.ok) {
      message.show(check.text, 'error');
      check.field.setAttribute('aria-invalid', 'true');
      check.field.focus();
      return;
    }

    submit.start();

    try {
      await submitPassword(token, check.password, check.confirm);

      /* 入力欄を消してから完了案内へ切り替える。 */
      passwordInput.value = '';
      confirmInput.value = '';

      form.hidden = true;
      message.show(successText, 'success');
      message.focus();

      if (doneElement) {
        doneElement.hidden = false;
      }
    } catch (error) {
      passwordInput.value = '';
      confirmInput.value = '';

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

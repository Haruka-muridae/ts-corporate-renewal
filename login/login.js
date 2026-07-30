/*
 * ログイン画面。
 *
 * ------------------------------------------------------------------
 * この画面がしないこと
 * ------------------------------------------------------------------
 *   - 失敗理由を区別して出さない（未登録・不一致・契約切れをすべて同じ文言に）
 *   - パスワードを保存しない（変数にも残さず、送信後に必ず入力欄を消す）
 *   - Stripe Checkout へ直接遷移しない（必ず料金プラン画面を経由する）
 *   - ログイン済みかどうかをローカルの値だけで判断しない
 * ------------------------------------------------------------------
 */

import { setScreenDepth, screenPath } from '../auth/config.js';
import { login as loginApi, ApiError } from '../auth/api.js';
import {
  writeSessionToken,
  clearSessionToken,
  redirectIfSignedIn,
  readNextParam,
  goToScreen,
  isStorageAvailable,
} from '../auth/session.js';
import {
  MESSAGES,
  isValidEmail,
  createMessageArea,
  createSubmitButton,
  attachPasswordToggle,
} from '../auth/ui.js';

/* /login/ はサイトのルートから1階層下。 */
setScreenDepth(1);

const form = document.getElementById('login-form');
const emailInput = document.getElementById('login-email');
const passwordInput = document.getElementById('login-password');
const rememberInput = document.getElementById('login-remember');
const submitButton = document.getElementById('login-submit');
const toggleButton = document.getElementById('login-password-toggle');
const messageElement = document.getElementById('login-message');

const message = createMessageArea(messageElement);
const submit = createSubmitButton(submitButton, { busyLabel: 'ログインしています…' });

attachPasswordToggle(toggleButton, passwordInput);

/* ログイン後の戻り先。既知の画面名だけを受け付ける。 */
const nextName = readNextParam();

/* 申し込み導線にも戻り先を持たせない（料金プラン画面は認証不要）。 */
document.getElementById('login-signup')?.setAttribute('href', screenPath('pricing'));

/*
 * すでに有効なセッションがあれば Portal へ送る。
 * 「トークンがある」ではなく「サーバーが有効と答えた」ときだけ遷移する。
 */
redirectIfSignedIn(nextName).catch(() => {
  /* 確認できなければログインフォームを出したままにする。 */
});

if (!isStorageAvailable()) {
  message.show(MESSAGES.storageUnavailable, 'info');
}

/* 入力し直したらエラー表示を消す（古いエラーを残さない）。 */
[emailInput, passwordInput].forEach((input) => {
  input.addEventListener('input', () => {
    input.removeAttribute('aria-invalid');

    if (messageElement.dataset.kind === 'error') {
      message.clear();
    }
  });
});

/*
 * 入力検証。
 * 最初に問題のあった項目へフォーカスを移し、キーボードだけで直せるようにする。
 */
function validate() {
  const email = emailInput.value.trim();

  if (email === '') {
    return { ok: false, text: MESSAGES.emailRequired, field: emailInput };
  }

  if (!isValidEmail(email)) {
    return { ok: false, text: MESSAGES.emailInvalid, field: emailInput };
  }

  if (passwordInput.value === '') {
    return { ok: false, text: MESSAGES.passwordRequired, field: passwordInput };
  }

  return { ok: true, email };
}

function showError(text, field) {
  message.show(text, 'error');

  if (field) {
    field.setAttribute('aria-invalid', 'true');
    field.focus();
  } else {
    message.focus();
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();

  /* 二重送信の防止。disabled になる前の Enter 連打もここで止まる。 */
  if (submit.isBusy()) {
    return;
  }

  message.clear();

  const check = validate();

  if (!check.ok) {
    showError(check.text, check.field);
    return;
  }

  submit.start();

  /*
   * パスワードは変数へ取り出したあと、成否にかかわらず入力欄を消す。
   * 画面に残しておくと、離席時にのぞかれる余地が残る。
   */
  const password = passwordInput.value;

  try {
    const data = await loginApi({
      email: check.email,
      password,
      remember: rememberInput.checked === true,
    });

    passwordInput.value = '';

    if (!data?.sessionToken) {
      showError(MESSAGES.network);
      return;
    }

    if (!writeSessionToken(data.sessionToken)) {
      showError(MESSAGES.storageUnavailable);
      return;
    }

    goToScreen(nextName);
  } catch (error) {
    passwordInput.value = '';

    /*
     * サーバーが返した文言をそのまま出す。
     * こちらで理由を推測して文言を足さない（アカウントの有無が漏れる）。
     */
    if (error instanceof ApiError) {
      /* 認証に失敗した場合は、セッションの残骸も片付ける。 */
      clearSessionToken();
      showError(error.userMessage, error.code === 'AUTH_FAILED' ? passwordInput : null);
      return;
    }

    showError(MESSAGES.network);
  } finally {
    submit.stop();
  }
});

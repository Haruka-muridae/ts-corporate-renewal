/*
 * パスワード再設定画面の制御。
 *
 * 2つの段階を1枚で扱う。
 *   1. 再設定メールの送信（未ログイン）
 *   2. 新しいパスワードの設定（メール内リンクから戻ってきた直後）
 *
 * 段階2は auth-callback がリンクを処理してセッションを復元したあと、
 * ?stage=set を付けてこの画面へ送ってくることで始まる。
 *
 * ------------------------------------------------------------------
 * 「メールを送りました」の文言について
 * ------------------------------------------------------------------
 * 未登録のメールアドレスでも同じ文言を出す。
 * 「そのアドレスは登録されていません」と返すと、
 * 総当たりで登録済みアドレスを調べられてしまうため
 * （アカウント列挙）。shared/auth-providers/supabase.js も同じ方針。
 * ------------------------------------------------------------------
 */

import {
  requestPasswordReset,
  updatePassword,
  isAuthenticated,
  getCapabilities,
  getProviderStatus,
  getInputRules,
  consumeRecoveryFlow,
  logout,
} from '../shared/auth.js';

const LOGIN_URL = '../login/';

const el = {
  stepRequest: document.getElementById('reset-step-request'),
  stepSet: document.getElementById('reset-step-set'),

  unavailable: document.getElementById('reset-unavailable'),
  unavailableReason: document.getElementById('reset-unavailable-reason'),

  requestForm: document.getElementById('reset-request-form'),
  email: document.getElementById('reset-email'),
  requestSubmit: document.getElementById('reset-request-submit'),
  requestMessage: document.getElementById('reset-request-message'),

  setForm: document.getElementById('reset-set-form'),
  setLead: document.getElementById('reset-set-lead'),
  password: document.getElementById('reset-password'),
  passwordConfirm: document.getElementById('reset-password-confirm'),
  passwordToggle: document.getElementById('reset-password-toggle'),
  passwordHint: document.getElementById('reset-password-hint'),
  setSubmit: document.getElementById('reset-set-submit'),
  setMessage: document.getElementById('reset-set-message'),
};

initialize();

/* ---------- 表示ユーティリティ ---------- */

function setMessage(element, text, { alert = false } = {}) {
  if (!element) {
    return;
  }

  if (!text) {
    element.removeAttribute('role');
    element.textContent = '';
    element.hidden = true;
    return;
  }

  /* 表示値は必ず textContent。innerHTML は使わない（XSS対策）。 */
  element.textContent = text;
  element.setAttribute('role', alert ? 'alert' : 'status');
  element.hidden = false;

  if (alert) {
    try {
      element.focus({ preventScroll: true });
    } catch {
      /* 無視。 */
    }
  }
}

function setBusy(button, busy, { busyLabel, idleLabel }) {
  if (!button) {
    return;
  }

  button.disabled = busy;
  button.setAttribute('aria-busy', busy ? 'true' : 'false');
  button.textContent = busy ? busyLabel : idleLabel;
}

function clearPasswords() {
  if (el.password) {
    el.password.value = '';
  }

  if (el.passwordConfirm) {
    el.passwordConfirm.value = '';
  }
}

/* ---------- 初期化 ---------- */

function initialize() {
  const stage = readStage();

  /*
   * 設定段階へ入れるのは、再設定リンクを踏んで
   * auth-callback を通過した直後だけにする。
   *
   * 通常ログイン中の人が ?stage=set を直接開いても、
   * 文脈のない「新しいパスワード」画面は出さない。
   * （これは導線の整理であって保護ではない。auth.js の注記を参照）
   */
  if (stage === 'set' && consumeRecoveryFlow()) {
    showSetStep();
  } else {
    showRequestStep();
  }

  bindPasswordToggle();
  bindRequest();
  bindSet();
}

function readStage() {
  try {
    return new URLSearchParams(globalThis.location.search).get('stage');
  } catch {
    return null;
  }
}

function showRequestStep() {
  el.stepRequest.hidden = false;
  el.stepSet.hidden = true;

  /* 対応していないプロバイダのときは、送信できないことを先に伝える。 */
  if (!getCapabilities()?.passwordReset) {
    const status = getProviderStatus();

    if (el.unavailable) {
      el.unavailable.hidden = false;
    }

    if (el.unavailableReason && status.reason) {
      el.unavailableReason.textContent = `パスワードの再設定は現在ご利用いただけません。（${status.reason}）`;
    }

    if (el.requestSubmit) {
      el.requestSubmit.disabled = true;
    }

    if (el.email) {
      el.email.disabled = true;
    }

    return;
  }

  try {
    el.email?.focus({ preventScroll: true });
  } catch {
    /* 無視。 */
  }
}

function showSetStep() {
  el.stepRequest.hidden = true;
  el.stepSet.hidden = false;

  const rules = getInputRules();

  if (el.passwordHint && rules?.passwordMinLength) {
    el.passwordHint.textContent = `${rules.passwordMinLength}文字以上で入力します。`;
  }

  if (rules?.passwordMaxLength) {
    el.password.maxLength = rules.passwordMaxLength;
    el.passwordConfirm.maxLength = rules.passwordMaxLength;
  }

  /*
   * リンクの処理に失敗している（セッションが無い）場合、
   * ここで新しいパスワードは設定できない。やり直してもらう。
   */
  if (!isAuthenticated()) {
    setMessage(
      el.setMessage,
      'このリンクは期限切れか、すでに使用済みです。お手数ですが、もう一度はじめからお試しください。',
      { alert: true },
    );

    if (el.setSubmit) {
      el.setSubmit.disabled = true;
    }

    if (el.password) {
      el.password.disabled = true;
    }

    if (el.passwordConfirm) {
      el.passwordConfirm.disabled = true;
    }

    return;
  }

  try {
    el.password?.focus({ preventScroll: true });
  } catch {
    /* 無視。 */
  }
}

function bindPasswordToggle() {
  if (!el.passwordToggle || !el.password) {
    return;
  }

  el.passwordToggle.addEventListener('click', () => {
    const shown = el.password.type === 'text';

    el.password.type = shown ? 'password' : 'text';
    el.passwordToggle.setAttribute('aria-pressed', shown ? 'false' : 'true');
    el.passwordToggle.textContent = shown ? '表示' : '非表示';

    try {
      el.password.focus({ preventScroll: true });
    } catch {
      /* 無視。 */
    }
  });
}

/* ---------- 第1段階: メール送信 ---------- */

function bindRequest() {
  if (!el.requestForm) {
    return;
  }

  el.requestForm.addEventListener('submit', async (event) => {
    event.preventDefault();

    if (el.requestSubmit?.disabled) {
      return;
    }

    setMessage(el.requestMessage, '');
    setBusy(el.requestSubmit, true, { busyLabel: '送信しています…', idleLabel: '再設定メールを送る' });

    try {
      await requestPasswordReset(el.email.value);

      /*
       * 登録の有無にかかわらず同じ文言を出す（上の注記を参照）。
       * 送信後はフォームを閉じ、二重送信を防ぐ。
       */
      setMessage(
        el.requestMessage,
        'ご登録のあるメールアドレスであれば、再設定用のリンクをお送りしました。'
        + 'メールが届かない場合は、迷惑メールフォルダもご確認ください。',
      );

      el.email.disabled = true;
      el.requestSubmit.disabled = true;
      el.requestSubmit.textContent = '送信しました';
    } catch (error) {
      setMessage(
        el.requestMessage,
        error?.userMessage ?? '送信できませんでした。しばらく待ってからお試しください。',
        { alert: true },
      );
      setBusy(el.requestSubmit, false, { busyLabel: '送信しています…', idleLabel: '再設定メールを送る' });
    }
  });
}

/* ---------- 第2段階: 新しいパスワード ---------- */

function bindSet() {
  if (!el.setForm) {
    return;
  }

  el.setForm.addEventListener('submit', async (event) => {
    event.preventDefault();

    if (el.setSubmit?.disabled) {
      return;
    }

    const password = el.password.value;
    const confirm = el.passwordConfirm.value;

    setMessage(el.setMessage, '');

    /* 打ち間違いはその場で伝える（往復させない）。 */
    if (password !== confirm) {
      clearPasswords();
      setMessage(el.setMessage, '2つの入力が一致しません。もう一度入力してください。', { alert: true });
      return;
    }

    setBusy(el.setSubmit, true, { busyLabel: '設定しています…', idleLabel: 'パスワードを設定する' });

    try {
      /* 再設定の目的上、他端末のログインも切る。 */
      await updatePassword(password, { revokeOthers: true });
      clearPasswords();

      /*
       * 設定できたら、いったんログアウトして新しいパスワードで
       * 入り直してもらう。
       * 再設定リンクから復元したセッションは二段階認証を経ていないため、
       * そのまま使い続けさせない。
       */
      await logout();

      setMessage(
        el.setMessage,
        'パスワードを変更しました。新しいパスワードでログインしてください。',
      );

      el.setSubmit.textContent = '変更しました';

      globalThis.setTimeout(() => {
        globalThis.location.replace(new URL(LOGIN_URL, globalThis.location.href).href);
      }, 1500);
    } catch (error) {
      clearPasswords();
      setMessage(
        el.setMessage,
        error?.userMessage ?? 'パスワードを変更できませんでした。',
        { alert: true },
      );
      setBusy(el.setSubmit, false, { busyLabel: '設定しています…', idleLabel: 'パスワードを設定する' });
    }
  });
}

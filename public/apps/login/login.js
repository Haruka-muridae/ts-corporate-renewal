/*
 * ログイン画面の制御。
 *
 * 責務はDOMの操作だけに限る。
 * ログインの判定・セッションの保存・遷移可否の判断は shared/auth.js が持つ。
 *
 * ------------------------------------------------------------------
 * パスワードの扱い
 * ------------------------------------------------------------------
 * パスワードは「入力欄から読む → login() へ渡す」だけにする。
 * 変数へ長く保持しない / ログへ出さない / URLへ載せない /
 * 他のモジュールへ渡さない。
 * 送信の成否にかかわらず、処理の最後に入力欄を必ずクリアする。
 *
 * フォームに action を置いていないため、万一 preventDefault が
 * 効かなくてもクエリ文字列へ値が載ることはない。
 * ------------------------------------------------------------------
 */

import {
  login,
  verifyMfaCode,
  cancelMfa,
  resumePendingMfa,
  redirectIfAuthenticated,
  isUsingDummyProvider,
  isStorageAvailable,
  getInputRules,
  getCapabilities,
  getProviderStatus,
  safeNextUrl,
  resolveNextUrl,
  LOGIN_STATUS,
} from '../shared/auth.js';

/* 遷移先の既定値。このページからの相対パスで書く。 */
const HOME_URL = '../home/';
const RESET_URL = '../password-reset/';

const el = {
  stepPassword: document.getElementById('login-step-password'),
  stepMfa: document.getElementById('login-step-mfa'),

  form: document.getElementById('login-form'),
  loginId: document.getElementById('login-id'),
  password: document.getElementById('login-password'),
  toggle: document.getElementById('login-password-toggle'),
  submit: document.getElementById('login-submit'),
  message: document.getElementById('login-message'),
  notice: document.getElementById('login-dummy-notice'),
  noticeReason: document.getElementById('login-dummy-reason'),
  passwordHint: document.getElementById('login-password-hint'),
  resetItem: document.getElementById('login-reset-item'),

  mfaForm: document.getElementById('mfa-form'),
  mfaCode: document.getElementById('mfa-code'),
  mfaSubmit: document.getElementById('mfa-submit'),
  mfaCancel: document.getElementById('mfa-cancel'),
  mfaMessage: document.getElementById('mfa-message'),
};

/*
 * ログイン後の戻り先。
 * ?next= は safeNextUrl() を通し、外部サイトへのリダイレクトを防ぐ。
 */
function readNextParam() {
  try {
    const value = new URLSearchParams(globalThis.location.search).get('next');
    return safeNextUrl(value, HOME_URL);
  } catch {
    return HOME_URL;
  }
}

/* 検証済みの相対パス（?next= へ載せる形）。 */
const nextUrl = readNextParam();

/*
 * 実際に遷移する絶対URL。
 * 検証（safeNextUrl）と同じ基準で解決するため、
 * 「検証は通ったのに違う場所へ飛ぶ」ずれが起きない。
 */
function nextHref() {
  return resolveNextUrl(nextUrl)
    ?? resolveNextUrl(HOME_URL)
    ?? new URL(HOME_URL, globalThis.location.href).href;
}

/*
 * ログイン済みなら、フォームを描画せずに遷移する。
 * ここで false が返った場合、以降の初期化は不要。
 */
if (redirectIfAuthenticated({ homeUrl: HOME_URL, next: nextUrl })) {
  initialize();
}

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
      /* フォーカスできなくても読み上げは role=alert で行われる。 */
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

/* 入力欄のエラー表示。色ではなく aria-invalid と文言で伝える。 */
function markInvalid(field, invalid) {
  if (!field) {
    return;
  }

  if (invalid) {
    field.setAttribute('aria-invalid', 'true');
  } else {
    field.removeAttribute('aria-invalid');
  }
}

function clearPassword() {
  if (el.password) {
    el.password.value = '';
  }
}

/* ---------- 初期化 ---------- */

function initialize() {
  if (!el.form || !el.loginId || !el.password) {
    return;
  }

  applyProviderStatus();
  bindPasswordToggle();
  bindSubmit();
  bindMfa();

  /* 最初の入力欄へ寄せる。スクロール位置は動かさない。 */
  try {
    el.loginId.focus({ preventScroll: true });
  } catch {
    /* 古いブラウザ。フォーカスできなくても操作はできる。 */
  }

  resumeInterruptedMfa();
}

/*
 * 二段階認証の途中で再読み込みされた場合に、コード入力から再開する。
 *
 * この状態を拾わないと、認証基盤側に「パスワードは通ったが
 * コード未入力」のセッションが残ったまま、利用者は
 * パスワード入力からやり直すことになる。
 *
 * 該当しない場合は何も起きない（通常のログイン画面のまま）。
 */
async function resumeInterruptedMfa() {
  let pending;

  try {
    pending = await resumePendingMfa();
  } catch {
    return;
  }

  if (!pending) {
    return;
  }

  showMfaStep();
  setMessage(el.mfaMessage, '二段階認証の確認が完了していません。コードを入力してください。');
}

/*
 * 認証基盤の状態を画面へ反映する。
 * Supabase を設定すると、注意書きが消えパスワード再設定が使えるようになる。
 */
function applyProviderStatus() {
  const dummy = isUsingDummyProvider();

  if (el.notice) {
    el.notice.hidden = !dummy;
  }

  if (dummy && el.noticeReason) {
    const status = getProviderStatus();

    /*
     * status.reason は利用者向けの文言だけを持つ。
     * 原因の詳細（describeConfig().detail）をここへ足さないこと。
     * 内部のファイル構成を利用者へ見せることになる。
     */
    if (status.reason) {
      el.noticeReason.textContent = '現在は画面遷移を確認するための仮ログインです。'
        + 'パスワードは照合されず、入力内容が端末の外へ送信されることもありません。'
        + `（${status.reason}）`;
    }
  }

  /* 入力規則はプロバイダが持つ。画面の文言と maxlength をそこから合わせる。 */
  const rules = getInputRules();

  if (el.passwordHint && rules?.passwordMinLength) {
    el.passwordHint.textContent = `${rules.passwordMinLength}文字以上で入力します。`;
  }

  if (rules?.loginIdMaxLength) {
    el.loginId.maxLength = rules.loginIdMaxLength;
  }

  if (rules?.passwordMaxLength) {
    el.password.maxLength = rules.passwordMaxLength;
  }

  /*
   * パスワード再設定は、対応しているプロバイダのときだけリンクにする。
   * 未対応のままリンクにすると、押しても何も起きない画面へ誘導してしまう。
   */
  if (el.resetItem && getCapabilities()?.passwordReset) {
    const link = document.createElement('a');
    link.href = RESET_URL;
    link.textContent = 'パスワードを忘れた方';

    el.resetItem.textContent = '';
    el.resetItem.classList.remove('account-links__pending');
    el.resetItem.append(link);
  }

  /*
   * ログイン状態を保持できない環境（プライベートモード等）では、
   * ログインしても遷移先で未ログインに戻ってしまう。先に伝える。
   */
  if (!isStorageAvailable()) {
    setMessage(
      el.message,
      'このブラウザではログイン状態を保持できません。プライベートモードを解除するか、別のブラウザでお試しください。',
    );
  }
}

function bindPasswordToggle() {
  if (!el.toggle || !el.password) {
    return;
  }

  el.toggle.addEventListener('click', () => {
    const shown = el.password.type === 'text';

    el.password.type = shown ? 'password' : 'text';
    el.toggle.setAttribute('aria-pressed', shown ? 'false' : 'true');
    el.toggle.textContent = shown ? '表示' : '非表示';

    try {
      el.password.focus({ preventScroll: true });
    } catch {
      /* 無視。 */
    }
  });
}

/* ---------- 第1段階: パスワード ---------- */

function bindSubmit() {
  el.form.addEventListener('submit', async (event) => {
    /* 既定の送信を止める。ここを通らないとURLへ値が載る可能性がある。 */
    event.preventDefault();

    if (el.submit?.disabled) {
      return;
    }

    const loginId = el.loginId.value;
    const password = el.password.value;

    markInvalid(el.loginId, false);
    markInvalid(el.password, false);
    setMessage(el.message, '');
    setBusy(el.submit, true, { busyLabel: 'ログインしています…', idleLabel: 'ログイン' });

    try {
      const result = await login(loginId, password);

      /* 成功・二段階どちらでもパスワードは残さない。 */
      clearPassword();

      if (result.status === LOGIN_STATUS.MFA_REQUIRED) {
        showMfaStep();
        return;
      }

      setMessage(el.message, 'ログインしました。画面を切り替えます。');
      globalThis.location.replace(nextHref());
    } catch (error) {
      /*
       * error.userMessage は画面へ出してよい日本語。
       * error 自体（内部コード）は画面へ出さない。
       */
      clearPassword();

      markInvalid(el.loginId, true);
      markInvalid(el.password, true);
      setMessage(
        el.message,
        error?.userMessage ?? 'ログインできませんでした。もう一度お試しください。',
        { alert: true },
      );
      setBusy(el.submit, false, { busyLabel: 'ログインしています…', idleLabel: 'ログイン' });
    }
  });
}

/* ---------- 第2段階: 二段階認証 ---------- */

function showMfaStep() {
  if (!el.stepMfa || !el.stepPassword) {
    return;
  }

  el.stepPassword.hidden = true;
  el.stepMfa.hidden = false;
  setMessage(el.mfaMessage, '');

  /* 入力欄へ移す。読み上げ利用者にも段階が変わったことが伝わる。 */
  try {
    el.mfaCode?.focus({ preventScroll: true });
  } catch {
    /* 無視。 */
  }
}

function bindMfa() {
  if (!el.mfaForm || !el.mfaCode) {
    return;
  }

  /* 数字以外を弾く。貼り付け時の空白やハイフンも落とす。 */
  el.mfaCode.addEventListener('input', () => {
    const digits = el.mfaCode.value.replace(/\D/g, '').slice(0, 6);

    if (el.mfaCode.value !== digits) {
      el.mfaCode.value = digits;
    }
  });

  el.mfaForm.addEventListener('submit', async (event) => {
    event.preventDefault();

    if (el.mfaSubmit?.disabled) {
      return;
    }

    const code = el.mfaCode.value;

    markInvalid(el.mfaCode, false);
    setMessage(el.mfaMessage, '');
    setBusy(el.mfaSubmit, true, { busyLabel: '確認しています…', idleLabel: '確認' });

    try {
      await verifyMfaCode(code);

      el.mfaCode.value = '';
      setMessage(el.mfaMessage, 'ログインしました。画面を切り替えます。');
      globalThis.location.replace(nextHref());
    } catch (error) {
      /* コードは1回限り有効なので、失敗したら必ず消す。 */
      el.mfaCode.value = '';

      markInvalid(el.mfaCode, true);
      setMessage(
        el.mfaMessage,
        error?.userMessage ?? 'コードを確認できませんでした。',
        { alert: true },
      );
      setBusy(el.mfaSubmit, false, { busyLabel: '確認しています…', idleLabel: '確認' });

      try {
        el.mfaCode.focus({ preventScroll: true });
      } catch {
        /* 無視。 */
      }
    }
  });

  el.mfaCancel?.addEventListener('click', async () => {
    await cancelMfa();

    el.mfaCode.value = '';
    el.stepMfa.hidden = true;
    el.stepPassword.hidden = false;
    setMessage(el.message, '');
    setBusy(el.submit, false, { busyLabel: 'ログインしています…', idleLabel: 'ログイン' });

    try {
      el.loginId.focus({ preventScroll: true });
    } catch {
      /* 無視。 */
    }
  });
}

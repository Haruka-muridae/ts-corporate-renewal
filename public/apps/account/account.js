/*
 * アカウント設定画面の制御。
 *
 * 扱うもの:
 *   メールアドレスの確認状態と再送
 *   二段階認証（TOTP）の登録・解除
 *   パスワードの変更
 *
 * 責務はDOMの操作だけに限る。判定と通信は shared/auth.js が持つ。
 *
 * ------------------------------------------------------------------
 * 秘密情報の扱い
 * ------------------------------------------------------------------
 * TOTP の secret と QR は、登録手続きの最中だけ画面に出す。
 * 手続きを抜けるときは必ず消す（画面に残して他人に見られないため）。
 * ログにも出さない。
 *
 * QR は Supabase が返す SVG の data URI。**img の src に渡す**。
 * innerHTML でSVGを流し込まない（外部由来のマークアップを実行しない）。
 * ------------------------------------------------------------------
 */

import {
  guardPage,
  watchAuthState,
  getCurrentUser,
  getCapabilities,
  getProviderStatus,
  getInputRules,
  listMfaFactors,
  startMfaEnrollment,
  confirmMfaEnrollment,
  disableMfa,
  updatePassword,
  resendConfirmation,
  hasMfaAssurance,
} from '../shared/auth.js';

const LOGIN_URL = '../login/';

const el = {
  main: document.getElementById('main-content'),

  email: document.getElementById('account-email'),
  emailStatus: document.getElementById('account-email-status'),
  emailMessage: document.getElementById('account-email-message'),
  emailActions: document.getElementById('account-email-actions'),
  resend: document.getElementById('account-resend'),

  mfaStatus: document.getElementById('account-mfa-status'),
  mfaMessage: document.getElementById('account-mfa-message'),
  mfaOff: document.getElementById('mfa-state-off'),
  mfaEnrolling: document.getElementById('mfa-state-enrolling'),
  mfaOn: document.getElementById('mfa-state-on'),
  mfaUnavailable: document.getElementById('mfa-unavailable'),
  mfaUnavailableReason: document.getElementById('mfa-unavailable-reason'),
  mfaStart: document.getElementById('mfa-start'),
  mfaQr: document.getElementById('mfa-qr'),
  mfaSecret: document.getElementById('mfa-secret'),
  mfaConfirmForm: document.getElementById('mfa-confirm-form'),
  mfaConfirmCode: document.getElementById('mfa-confirm-code'),
  mfaConfirm: document.getElementById('mfa-confirm'),
  mfaAbort: document.getElementById('mfa-abort'),
  mfaDisable: document.getElementById('mfa-disable'),
  mfaEnabledNote: document.getElementById('mfa-enabled-note'),

  passwordSection: document.getElementById('account-password-section'),
  passwordForm: document.getElementById('password-form'),
  password: document.getElementById('new-password'),
  passwordConfirm: document.getElementById('new-password-confirm'),
  passwordToggle: document.getElementById('new-password-toggle'),
  passwordHint: document.getElementById('new-password-hint'),
  passwordSubmit: document.getElementById('password-submit'),
  passwordMessage: document.getElementById('password-message'),
};

/* 登録手続き中の一時情報。手続きを抜けたら必ず捨てる。 */
let enrollment = null;

initialize();

/* ---------- 表示ユーティリティ ---------- */

function setText(element, text) {
  if (element) {
    /* 表示値は必ず textContent。innerHTML は使わない（XSS対策）。 */
    element.textContent = text;
  }
}

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

/* ---------- 初期化 ---------- */

/*
 * ------------------------------------------------------------------
 * 描画の順序（重要）
 * ------------------------------------------------------------------
 * 本文は hidden で始まり、**認証基盤への確認が終わるまで表示しない**。
 * この画面は二段階認証の設定を扱うため、写しの偽装だけで
 * 到達できてはならない。
 * ------------------------------------------------------------------
 */
async function initialize() {
  if (!(await guardPage({ loginUrl: LOGIN_URL }))) {
    return;
  }

  bindPasswordToggle();
  bindMfa();
  bindPasswordChange();
  bindResend();

  renderAccount(getCurrentUser());

  if (el.main) {
    el.main.hidden = false;
  }

  watchAuthState({
    onSignedOut: () => {
      if (el.main) {
        el.main.hidden = true;
      }

      globalThis.location.replace(new URL(LOGIN_URL, globalThis.location.href).href);
    },
  });

  await refreshMfaState();
}

function renderAccount(user) {
  setText(el.email, user?.loginId ?? '（未設定）');

  const capabilities = getCapabilities();

  if (!capabilities?.emailVerification) {
    setText(el.emailStatus, '—');
  } else if (user?.emailConfirmed) {
    setText(el.emailStatus, '確認済み');

    if (el.emailActions) {
      el.emailActions.hidden = true;
    }
  } else {
    setText(el.emailStatus, '未確認');

    if (el.emailActions) {
      el.emailActions.hidden = false;
    }

    setMessage(
      el.emailMessage,
      'メールアドレスの確認が済んでいません。届いているメールのリンクを開いてください。',
    );
  }

  /* パスワード変更に対応していないプロバイダでは節ごと隠す。 */
  if (el.passwordSection && !capabilities?.passwordChange) {
    el.passwordSection.hidden = true;
  }

  const rules = getInputRules();

  if (el.passwordHint && rules?.passwordMinLength) {
    setText(el.passwordHint, `${rules.passwordMinLength}文字以上で入力します。`);
  }

  if (rules?.passwordMaxLength && el.password) {
    el.password.maxLength = rules.passwordMaxLength;
    el.passwordConfirm.maxLength = rules.passwordMaxLength;
  }
}

/* ---------- 二段階認証 ---------- */

function showMfaState(name) {
  const states = {
    off: el.mfaOff,
    enrolling: el.mfaEnrolling,
    on: el.mfaOn,
    unavailable: el.mfaUnavailable,
  };

  Object.entries(states).forEach(([key, element]) => {
    if (element) {
      element.hidden = key !== name;
    }
  });
}

/* 手続き中の秘密情報を画面とメモリから消す。 */
function clearEnrollmentView() {
  enrollment = null;

  if (el.mfaQr) {
    el.mfaQr.removeAttribute('src');
  }

  setText(el.mfaSecret, '');

  if (el.mfaConfirmCode) {
    el.mfaConfirmCode.value = '';
  }
}

async function refreshMfaState() {
  if (!getCapabilities()?.mfa) {
    setText(el.mfaStatus, '—');

    const status = getProviderStatus();

    if (el.mfaUnavailableReason && status.reason) {
      setText(el.mfaUnavailableReason, `二段階認証は現在ご利用いただけません。（${status.reason}）`);
    }

    showMfaState('unavailable');
    return;
  }

  let factors;

  try {
    factors = await listMfaFactors();
  } catch (error) {
    setText(el.mfaStatus, '確認できません');
    setMessage(el.mfaMessage, error?.userMessage ?? '状態を取得できませんでした。', { alert: true });
    return;
  }

  if (factors.length === 0) {
    setText(el.mfaStatus, '未設定');
    showMfaState('off');
    return;
  }

  setText(el.mfaStatus, '設定済み');

  /*
   * 解除は AAL2（このログインでコードを入力済み）でのみ許す。
   * パスワードだけを知っている人に外させないため。
   */
  if (el.mfaDisable) {
    const allowed = hasMfaAssurance();
    el.mfaDisable.disabled = !allowed;

    setText(
      el.mfaEnabledNote,
      allowed
        ? '二段階認証が有効です。ログイン時に認証アプリのコードが必要になります。'
        : '二段階認証が有効です。解除するには、いったんログアウトし、コードを入力してログインし直してください。',
    );
  }

  showMfaState('on');
}

function bindMfa() {
  el.mfaStart?.addEventListener('click', async () => {
    setMessage(el.mfaMessage, '');
    setBusy(el.mfaStart, true, { busyLabel: '準備しています…', idleLabel: '二段階認証を設定する' });

    try {
      const result = await startMfaEnrollment();
      enrollment = { factorId: result.factorId };

      /* data URI をそのまま src へ。innerHTML は使わない。 */
      if (el.mfaQr && result.qrCode) {
        el.mfaQr.src = result.qrCode;
      }

      setText(el.mfaSecret, result.secret ?? '');
      showMfaState('enrolling');

      try {
        el.mfaConfirmCode?.focus({ preventScroll: true });
      } catch {
        /* 無視。 */
      }
    } catch (error) {
      setMessage(el.mfaMessage, error?.userMessage ?? '設定を開始できませんでした。', { alert: true });
    } finally {
      setBusy(el.mfaStart, false, { busyLabel: '準備しています…', idleLabel: '二段階認証を設定する' });
    }
  });

  /* 数字以外を弾く。貼り付け時の空白やハイフンも落とす。 */
  el.mfaConfirmCode?.addEventListener('input', () => {
    const digits = el.mfaConfirmCode.value.replace(/\D/g, '').slice(0, 6);

    if (el.mfaConfirmCode.value !== digits) {
      el.mfaConfirmCode.value = digits;
    }
  });

  el.mfaConfirmForm?.addEventListener('submit', async (event) => {
    event.preventDefault();

    if (el.mfaConfirm?.disabled || !enrollment) {
      return;
    }

    const code = el.mfaConfirmCode.value;
    setMessage(el.mfaMessage, '');
    setBusy(el.mfaConfirm, true, { busyLabel: '確認しています…', idleLabel: '設定を完了する' });

    try {
      await confirmMfaEnrollment({ factorId: enrollment.factorId, code });

      clearEnrollmentView();
      setMessage(el.mfaMessage, '二段階認証を有効にしました。次回のログインからコードが必要になります。');
      await refreshMfaState();
    } catch (error) {
      /* コードは1回限り有効なので、失敗したら必ず消す。 */
      el.mfaConfirmCode.value = '';
      setMessage(el.mfaMessage, error?.userMessage ?? '確認できませんでした。', { alert: true });
    } finally {
      setBusy(el.mfaConfirm, false, { busyLabel: '確認しています…', idleLabel: '設定を完了する' });
    }
  });

  el.mfaAbort?.addEventListener('click', async () => {
    clearEnrollmentView();
    setMessage(el.mfaMessage, '設定を中止しました。');
    await refreshMfaState();
  });

  el.mfaDisable?.addEventListener('click', async () => {
    setMessage(el.mfaMessage, '');

    /*
     * 解除は保護を弱める操作。取り消せないため、押し間違いを一度受け止める。
     * confirm はブラウザ標準で、読み上げにも対応している。
     */
    if (!globalThis.confirm('二段階認証を解除します。ログイン時のコード入力が不要になり、保護は弱くなります。よろしいですか？')) {
      return;
    }

    setBusy(el.mfaDisable, true, { busyLabel: '解除しています…', idleLabel: '二段階認証を解除する' });

    try {
      const factors = await listMfaFactors();

      for (const factor of factors) {
        /* 逐次実行。件数は多くても数件で、並列にする利点が無い。 */
        /* eslint-disable-next-line no-await-in-loop */
        await disableMfa(factor.id);
      }

      setMessage(el.mfaMessage, '二段階認証を解除しました。');
      await refreshMfaState();
    } catch (error) {
      setMessage(el.mfaMessage, error?.userMessage ?? '解除できませんでした。', { alert: true });
    } finally {
      setBusy(el.mfaDisable, false, { busyLabel: '解除しています…', idleLabel: '二段階認証を解除する' });
    }
  });
}

/* ---------- メール確認の再送 ---------- */

/*
 * 再送のクールダウン（秒）。
 * 認証基盤側にも送信制限があるが、そこへ到達する前に画面で止める。
 * 連打して制限に当たると、しばらく正規の再送もできなくなるため。
 */
const RESEND_COOLDOWN_SEC = 60;

function bindResend() {
  el.resend?.addEventListener('click', async () => {
    const user = getCurrentUser();

    if (!user?.loginId || el.resend.disabled) {
      return;
    }

    setBusy(el.resend, true, { busyLabel: '送信しています…', idleLabel: '確認メールを再送する' });

    try {
      await resendConfirmation(user.loginId);
      setMessage(el.emailMessage, '確認メールを再送しました。迷惑メールフォルダもご確認ください。');
      startResendCooldown();
    } catch (error) {
      setMessage(el.emailMessage, error?.userMessage ?? '再送できませんでした。', { alert: true });
      setBusy(el.resend, false, { busyLabel: '送信しています…', idleLabel: '確認メールを再送する' });
    }
  });
}

/* 残り秒数をボタンに出す。読み上げ利用者にも残り時間が伝わる。 */
function startResendCooldown() {
  let remaining = RESEND_COOLDOWN_SEC;

  el.resend.disabled = true;
  el.resend.removeAttribute('aria-busy');

  const tick = () => {
    if (remaining <= 0) {
      el.resend.disabled = false;
      el.resend.textContent = '確認メールを再送する';
      return;
    }

    el.resend.textContent = `再送できます（あと${remaining}秒）`;
    remaining -= 1;
    globalThis.setTimeout(tick, 1000);
  };

  tick();
}

/* ---------- パスワード変更 ---------- */

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

function clearPasswords() {
  if (el.password) {
    el.password.value = '';
  }

  if (el.passwordConfirm) {
    el.passwordConfirm.value = '';
  }
}

function bindPasswordChange() {
  el.passwordForm?.addEventListener('submit', async (event) => {
    event.preventDefault();

    if (el.passwordSubmit?.disabled) {
      return;
    }

    const password = el.password.value;
    const confirm = el.passwordConfirm.value;

    setMessage(el.passwordMessage, '');

    if (password !== confirm) {
      clearPasswords();
      setMessage(el.passwordMessage, '2つの入力が一致しません。もう一度入力してください。', { alert: true });
      return;
    }

    setBusy(el.passwordSubmit, true, { busyLabel: '変更しています…', idleLabel: 'パスワードを変更する' });

    try {
      /*
       * 他端末のセッションも失効させる。
       * 「漏れたかもしれない」から変更するのに、他端末のログインが
       * 生き残っていては変更の意味がないため。
       */
      const result = await updatePassword(password, { revokeOthers: true });
      clearPasswords();

      setMessage(
        el.passwordMessage,
        result.othersRevoked
          ? 'パスワードを変更し、他の端末のログインを解除しました。'
          : 'パスワードを変更しました。（他の端末のログイン解除は確認できませんでした）',
      );
    } catch (error) {
      clearPasswords();
      setMessage(el.passwordMessage, error?.userMessage ?? '変更できませんでした。', { alert: true });
    } finally {
      setBusy(el.passwordSubmit, false, { busyLabel: '変更しています…', idleLabel: 'パスワードを変更する' });
    }
  });
}

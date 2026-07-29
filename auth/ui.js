/*
 * 認証画面の共通UI部品。
 *
 * 各画面はここを使い、メッセージ表示・二重送信防止・
 * パスワード表示切替を自前で書かない。
 *
 * ------------------------------------------------------------------
 * 表示の原則
 * ------------------------------------------------------------------
 *   - エラーを色だけで示さない。必ず語（「エラー」等）とアイコン相当の
 *     記号を添え、色が見えなくても意味が伝わるようにする。
 *   - 文字列の挿入は textContent で行う。innerHTML は使わない。
 *   - 処理中はボタンを無効化し、文言も変える。
 * ------------------------------------------------------------------
 */

/* 共通の文言。画面ごとに書き分けない。 */
export const MESSAGES = Object.freeze({
  emailRequired: 'メールアドレスを入力してください。',
  emailInvalid: '正しいメールアドレスを入力してください。',
  passwordRequired: 'パスワードを入力してください。',
  network: '通信に失敗しました。時間をおいて再度お試しください。',
  notConfigured: 'この機能は現在ご利用いただけません。しばらくお待ちください。',
});

/*
 * メールアドレスの形式確認。
 * サーバー側でも同じ確認を行う（画面の検証に依存しない）。
 */
export function isValidEmail(value) {
  const email = String(value ?? '').trim();

  if (email === '' || email.length > 254) {
    return false;
  }

  return /^[^\s@,;:<>"'\\]+@[^\s@,;:<>"'\\.]+(\.[^\s@,;:<>"'\\.]+)+$/.test(email);
}

/*
 * メッセージ領域。
 *
 * kind:
 *   'error'   … 失敗。読み上げも割り込ませる（role="alert"）
 *   'success' … 完了
 *   'info'    … 案内
 *
 * role を常時 alert にしないのは、画面に出ているだけの案内文が
 * 毎回読み上げに割り込むのを避けるため。
 */
export function createMessageArea(element) {
  if (!element) {
    return { show() {}, clear() {}, focus() {} };
  }

  const labels = { error: 'エラー', success: '完了', info: 'お知らせ' };

  return {
    show(text, kind = 'error') {
      element.textContent = '';

      const label = document.createElement('strong');
      label.className = 'auth-message__label';
      label.textContent = labels[kind] ?? labels.info;

      const body = document.createElement('span');
      body.className = 'auth-message__body';
      body.textContent = String(text ?? '');

      element.append(label, body);
      element.dataset.kind = kind;
      element.hidden = false;

      /* 失敗だけ割り込ませる。 */
      if (kind === 'error') {
        element.setAttribute('role', 'alert');
      } else {
        element.setAttribute('role', 'status');
      }
    },

    clear() {
      element.textContent = '';
      element.hidden = true;
      element.removeAttribute('role');
      delete element.dataset.kind;
    },

    focus() {
      if (!element.hidden) {
        element.focus();
      }
    },
  };
}

/*
 * 送信ボタンの状態。
 *
 * 二重送信の防止は disabled だけに頼らない。
 * busy フラグでも弾く（Enter の連打や、無効化前の再送信を確実に止める）。
 */
export function createSubmitButton(button, { busyLabel = '送信しています…' } = {}) {
  const idleLabel = button ? button.textContent : '';
  let busy = false;

  return {
    isBusy() {
      return busy;
    },

    start() {
      busy = true;

      if (button) {
        button.disabled = true;
        button.textContent = busyLabel;
        button.setAttribute('aria-busy', 'true');
      }
    },

    stop() {
      busy = false;

      if (button) {
        button.disabled = false;
        button.textContent = idleLabel;
        button.removeAttribute('aria-busy');
      }
    },
  };
}

/*
 * パスワードの表示切替。
 *
 * aria-pressed で現在の状態を伝え、aria-label で
 * 「押すと何が起きるか」ではなく「いま何の状態か」を読み上げさせる。
 */
export function attachPasswordToggle(button, input) {
  if (!button || !input) {
    return;
  }

  const apply = (visible) => {
    input.type = visible ? 'text' : 'password';
    button.setAttribute('aria-pressed', visible ? 'true' : 'false');
    button.setAttribute('aria-label', visible ? 'パスワードを非表示にする' : 'パスワードを表示する');
    button.textContent = visible ? '非表示' : '表示';
  };

  apply(false);

  button.addEventListener('click', () => {
    apply(input.type === 'password');
    /* 切り替えたあとも入力を続けられるようにする。 */
    input.focus();
  });
}

/*
 * 金額の表示。
 * サーバーから来る amount は文字列（未確定なら空）。
 * 数値であれば通貨として整え、そうでなければそのまま出す。
 */
export function formatAmount(amount, currency = 'jpy') {
  const text = String(amount ?? '').trim();

  if (text === '') {
    return '';
  }

  const value = Number(text);

  if (!Number.isFinite(value)) {
    return text;
  }

  try {
    return new Intl.NumberFormat('ja-JP', {
      style: 'currency',
      currency: String(currency ?? 'jpy').toUpperCase(),
      maximumFractionDigits: 0,
    }).format(value);
  } catch {
    return `${value.toLocaleString('ja-JP')}円`;
  }
}

/* 支払周期の表示。 */
export function formatInterval(interval) {
  const value = String(interval ?? '').trim().toLowerCase();

  if (value === 'month') {
    return '月額';
  }

  if (value === 'year') {
    return '年額';
  }

  return '';
}

/*
 * URL から token を取り出す。
 *
 * 長さと文字種を確認し、明らかに不正な値はサーバーへ送らない。
 * サーバー側でも同じ確認を行う。
 */
export function readTokenParam() {
  try {
    const params = new URLSearchParams(globalThis.location?.search ?? '');
    const token = params.get('token') ?? '';

    if (token === '' || token.length > 256 || !/^[A-Za-z0-9_-]+$/.test(token)) {
      return '';
    }

    return token;
  } catch {
    return '';
  }
}

/*
 * アドレスバーから token を消す。
 *
 * 一度読み取ったら履歴に残さない。
 * 共有端末で「戻る」を押されたときに、URLからトークンを拾われないようにする。
 */
export function stripTokenFromUrl() {
  try {
    if (typeof globalThis.history?.replaceState !== 'function') {
      return;
    }

    const url = new URL(globalThis.location.href);

    if (!url.searchParams.has('token')) {
      return;
    }

    url.searchParams.delete('token');
    globalThis.history.replaceState(null, '', url.pathname + url.search + url.hash);
  } catch {
    /* 消せなくても処理は続ける。 */
  }
}

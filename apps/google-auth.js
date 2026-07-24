/*
 * Google Identity Services（Sign in with Google）連携。
 * /apps/ の共通ログイン入口として、Googleアカウントのプロフィール表示だけを担当する。
 *
 * ------------------------------------------------------------------
 * この機能の位置付け（重要）
 * ------------------------------------------------------------------
 * これは「クライアント側のプロフィール表示」であり、セキュリティ境界ではない。
 * 静的サイトのためIDトークンをサーバーで検証しておらず、ここで得られる
 * 表示名・メールアドレスは検証済みの本人確認情報として扱えない。
 *
 * 使ってよい用途:  プロフィール表示 / ログイン状態の表示 /
 *                  今後のOAuth認可フローへの導線 / 利便性向上
 * 使ってはいけない用途:
 *                  管理者判定 / 有料会員判定 / アクセス制御 / API認証 /
 *                  サーバー側の本人確認 / ドメインやメールアドレスによる権限付与
 *
 * Google Drive などのAPI利用に必要な「認可」は、ここでは一切行わない。
 * Drive保存を実装する際に、google.accounts.oauth2 を用いた別フローで
 * そのとき必要なスコープだけを要求する（本ファイルはログインのみ）。
 * ------------------------------------------------------------------
 */

import {
  GOOGLE_AUTH_CONFIG,
  GIS_SCRIPT_URL,
  GIS_LOAD_TIMEOUT_MS,
  isClientIdConfigured,
} from './auth-config.js';

import {
  loadProfile,
  saveProfile,
  clearProfile,
  sanitizeProfile,
  isProfileExpired,
} from './auth-session.js';

/* 認証UIの状態。UIの分岐はこの5つだけに限定する。 */
export const AUTH_STATUS = Object.freeze({
  LOADING: 'loading',
  SIGNED_OUT: 'signed-out',
  SIGNED_IN: 'signed-in',
  UNAVAILABLE: 'unavailable',
  ERROR: 'error',
});

/*
 * 状態変化の通知イベント名。
 * 既存コードに tsam- 接頭辞のイベントが無いことを確認済み。
 * detail: { status, profile }
 */
export const AUTH_EVENT = 'tsam-auth-change';

/* Google公式ボタンの描画設定。ボタン自体は自前で作らず renderButton に任せる。 */
const BUTTON_OPTIONS = Object.freeze({
  type: 'standard',
  theme: 'outline',
  size: 'large',
  text: 'signin_with',
  shape: 'rectangular',
  logo_alignment: 'left',
  locale: 'ja',
});

const BUTTON_MIN_WIDTH = 240;
const BUTTON_MAX_WIDTH = 360;

/* IDトークンの長さ上限。異常に長い入力はここで弾く。 */
const MAX_CREDENTIAL_LENGTH = 8192;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

/*
 * 状態ごとの表示内容。
 * DOM操作を各所へ散らさず、この表と renderAuthState() の1か所へ集約する。
 *   sentence … aria-live 領域へ出す状況説明
 *   signin   … Google公式ログインボタン領域を表示するか
 *   account  … アカウントカードを表示するか
 *   message  … 補足メッセージ（null なら非表示）
 *   alert    … message を role="alert" として読み上げるか
 */
const STATUS_VIEW = Object.freeze({
  [AUTH_STATUS.LOADING]: {
    sentence: 'Googleログインを読み込んでいます。',
    signin: false,
    account: false,
    message: null,
    alert: false,
  },
  [AUTH_STATUS.SIGNED_OUT]: {
    sentence: 'ログインしていません。',
    signin: true,
    account: false,
    message: null,
    alert: false,
  },
  [AUTH_STATUS.SIGNED_IN]: {
    sentence: 'Googleアカウントでログインしています。',
    signin: false,
    account: true,
    message: null,
    alert: false,
  },
  [AUTH_STATUS.UNAVAILABLE]: {
    sentence: 'Googleログインは現在準備中です。',
    signin: false,
    account: false,
    message: '準備が整うまで、ログインなしでアプリをご利用いただけます。',
    alert: false,
  },
  [AUTH_STATUS.ERROR]: {
    sentence: 'Googleログインを読み込めませんでした。',
    signin: false,
    account: false,
    message: 'ページを再読み込みすると解消する場合があります。ログインしなくてもアプリはご利用いただけます。',
    alert: true,
  },
});

const ELEMENT_IDS = Object.freeze({
  panel: 'auth-panel',
  status: 'auth-status',
  signin: 'auth-signin',
  button: 'auth-button',
  account: 'auth-account',
  avatar: 'auth-avatar',
  avatarFallback: 'auth-avatar-fallback',
  name: 'auth-name',
  email: 'auth-email',
  emailNote: 'auth-email-note',
  signout: 'auth-signout',
  message: 'auth-message',
});

/* ---------- モジュール内状態 ---------- */

let el = null;
let started = false;
let initializeCalled = false;
let renderButtonCalled = false;
let signOutBound = false;
let currentStatus = AUTH_STATUS.LOADING;
let currentProfile = null;

/* ---------- 小さなユーティリティ ---------- */

function getGoogleId() {
  return globalThis.google?.accounts?.id ?? null;
}

function setHidden(element, hidden) {
  if (!element) {
    return;
  }

  element.hidden = hidden;
}

function setText(element, text) {
  if (!element) {
    return;
  }

  /* 表示値は必ず textContent。innerHTML は使わない（XSS対策）。 */
  element.textContent = text;
}

/* ---------- IDトークンの解析 ---------- */

/*
 * Base64URL 文字列を UTF-8 として復号する。
 * 不正な入力では例外を投げず null を返す。
 */
function decodeBase64UrlToText(segment) {
  if (typeof segment !== 'string' || segment === '' || !BASE64URL_PATTERN.test(segment)) {
    return null;
  }

  /* Base64URL → Base64。パディングを補う。 */
  const base64 = segment.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');

  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);

    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }

    /* 不正なUTF-8列は例外にする（fatal）。 */
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/*
 * IDトークン（JWT）の payload を読み取る。
 *
 * 注意: ここでは署名検証を行わない。表示のためにpayloadを読むだけであり、
 * 戻り値を「検証済みの認証情報」として扱ってはならない。
 * 解析できない場合は null を返す（例外は外へ出さない）。
 */
export function decodeIdTokenPayload(credential) {
  if (typeof credential !== 'string') {
    return null;
  }

  const token = credential.trim();

  if (token === '' || token.length > MAX_CREDENTIAL_LENGTH) {
    return null;
  }

  const parts = token.split('.');

  /* JWTは header.payload.signature の3区分でなければならない。 */
  if (parts.length !== 3 || parts.some((part) => part === '')) {
    return null;
  }

  const json = decodeBase64UrlToText(parts[1]);

  if (json === null) {
    return null;
  }

  try {
    const payload = JSON.parse(json);

    /* 配列やプリミティブは payload として不正。 */
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return null;
    }

    return payload;
  } catch {
    /*
     * JSONの解析エラーメッセージには入力内容が含まれ得るため、
     * ログへは出さない。
     */
    return null;
  }
}

/* ---------- DOM ---------- */

function collectElements() {
  if (typeof document === 'undefined') {
    return null;
  }

  const found = {};

  Object.entries(ELEMENT_IDS).forEach(([key, id]) => {
    found[key] = document.getElementById(id);
  });

  return found;
}

/* 表示名が無い場合の代替テキスト。 */
function resolveDisplayName(profile) {
  if (profile?.name) {
    return profile.name;
  }

  if (profile?.email) {
    return profile.email.split('@')[0];
  }

  return 'Googleアカウント';
}

/* イニシャル1文字。サロゲートペアを壊さないよう Array.from で取り出す。 */
function resolveInitial(displayName) {
  const first = Array.from(displayName ?? '')[0];
  return first ? first.toUpperCase() : '?';
}

function renderAvatar(profile, displayName) {
  const initial = resolveInitial(displayName);
  setText(el.avatarFallback, initial);

  if (!el.avatar) {
    return;
  }

  if (!profile?.picture) {
    /* URLが無い、または不正だった場合はイニシャル表示のままにする。 */
    el.avatar.removeAttribute('src');
    setHidden(el.avatar, true);
    setHidden(el.avatarFallback, false);
    return;
  }

  /* 読み込み失敗時にレイアウトが崩れないよう、枠は常に同じサイズを保つ。 */
  el.avatar.onerror = () => {
    setHidden(el.avatar, true);
    setHidden(el.avatarFallback, false);
  };
  el.avatar.onload = () => {
    setHidden(el.avatar, false);
    setHidden(el.avatarFallback, true);
  };

  el.avatar.alt = `${displayName}のプロフィール画像`;
  el.avatar.referrerPolicy = 'no-referrer';
  el.avatar.src = profile.picture;
  setHidden(el.avatar, false);
  setHidden(el.avatarFallback, true);
}

function renderAccount(profile) {
  const displayName = resolveDisplayName(profile);

  setText(el.name, displayName);
  setText(el.email, profile?.email ?? 'メールアドレスは取得していません');

  /*
   * 未確認メールであることは色ではなく文言で示す。
   * ここでの確認状態はGoogleの申告値であり、権限判定には使用しない。
   */
  if (el.emailNote) {
    const unverified = Boolean(profile?.email) && profile.emailVerified !== true;
    setText(el.emailNote, unverified ? '（メールアドレス未確認）' : '');
    setHidden(el.emailNote, !unverified);
  }

  renderAvatar(profile, displayName);
}

/*
 * 認証UIの唯一の更新経路。
 * 状態ごとのDOM操作をここ以外へ書かないこと。
 */
export function renderAuthState(status, profile = null) {
  const view = STATUS_VIEW[status] ?? STATUS_VIEW[AUTH_STATUS.LOADING];
  const resolvedStatus = STATUS_VIEW[status] ? status : AUTH_STATUS.LOADING;

  currentStatus = resolvedStatus;
  currentProfile = resolvedStatus === AUTH_STATUS.SIGNED_IN ? profile : null;

  /* 要素が無いページで読み込まれても落とさない。 */
  if (el?.panel) {
    el.panel.dataset.authStatus = resolvedStatus;
  }

  if (el) {
    setText(el.status, view.sentence);
    setHidden(el.signin, !view.signin);
    setHidden(el.account, !view.account);

    if (el.signout) {
      el.signout.disabled = !view.account;
    }

    if (view.account) {
      renderAccount(profile);
    }

    if (el.message) {
      if (view.message) {
        setText(el.message, view.message);

        if (view.alert) {
          el.message.setAttribute('role', 'alert');
        } else {
          el.message.removeAttribute('role');
        }

        setHidden(el.message, false);
      } else {
        el.message.removeAttribute('role');
        setText(el.message, '');
        setHidden(el.message, true);
      }
    }
  }

  if (typeof document !== 'undefined' && typeof CustomEvent === 'function') {
    document.dispatchEvent(new CustomEvent(AUTH_EVENT, {
      detail: {
        status: resolvedStatus,
        profile: currentProfile,
      },
    }));
  }
}

/* ---------- Google Identity Services ---------- */

/*
 * 公式スクリプトを読み込む。
 * クライアントIDが未設定のときは呼ばない（不要な外部通信を発生させない）。
 */
function loadGisScript() {
  return new Promise((resolve, reject) => {
    if (getGoogleId()) {
      resolve();
      return;
    }

    let settled = false;

    const finish = (error) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);

      if (error) {
        reject(error);
        return;
      }

      resolve();
    };

    const timer = setTimeout(() => finish(new Error('GIS_TIMEOUT')), GIS_LOAD_TIMEOUT_MS);

    let script;

    try {
      script = document.createElement('script');
    } catch (error) {
      finish(error);
      return;
    }

    script.src = GIS_SCRIPT_URL;
    script.async = true;
    script.defer = true;

    script.addEventListener('load', () => {
      /* 読み込めても google.accounts.id が無い場合がある。 */
      finish(getGoogleId() ? null : new Error('GIS_UNAVAILABLE'));
    });

    script.addEventListener('error', () => finish(new Error('GIS_LOAD_FAILED')));

    (document.head ?? document.body)?.append(script);
  });
}

/* Google公式ボタンの幅。既存カード幅からはみ出さない範囲へ収める。 */
function resolveButtonWidth() {
  const measured = el?.button?.clientWidth ?? 0;

  if (!measured) {
    return BUTTON_MIN_WIDTH;
  }

  return Math.min(BUTTON_MAX_WIDTH, Math.max(BUTTON_MIN_WIDTH, Math.round(measured)));
}

/*
 * Googleからのコールバック。
 * response.credential はIDトークン。保存・ログ出力・外部送信は一切行わない。
 */
function handleCredentialResponse(response) {
  try {
    const credential = response?.credential;

    if (typeof credential !== 'string' || credential.trim() === '') {
      clearProfile();
      renderAuthState(AUTH_STATUS.ERROR);
      return;
    }

    const payload = decodeIdTokenPayload(credential);
    const profile = payload ? sanitizeProfile(payload) : null;

    if (!profile || isProfileExpired(profile)) {
      clearProfile();
      renderAuthState(AUTH_STATUS.ERROR);
      return;
    }

    /* 保存できなくても（プライベートモード等）、この場の表示は続行する。 */
    saveProfile(profile);
    renderAuthState(AUTH_STATUS.SIGNED_IN, profile);
  } catch (error) {
    /* 例外の内容にトークンが混ざる可能性があるため、種別名だけを出す。 */
    console.error('[apps] Googleログインの処理に失敗しました:', error?.name ?? 'Error');
    clearProfile();
    renderAuthState(AUTH_STATUS.ERROR);
  }
}

/*
 * ログアウト。
 * 解除するのはこのサイト上の表示状態だけで、Googleアカウント自体からは
 * ログアウトさせない（revoke も行わない）。
 */
export function signOut() {
  clearProfile();

  try {
    getGoogleId()?.disableAutoSelect?.();
  } catch (error) {
    console.warn('[apps] disableAutoSelect に失敗しました:', error?.name ?? 'Error');
  }

  renderAuthState(AUTH_STATUS.SIGNED_OUT);
}

function bindSignOut() {
  if (signOutBound || !el?.signout) {
    return;
  }

  signOutBound = true;
  el.signout.addEventListener('click', () => signOut());
}

/* initialize は1回だけ。二重呼び出しを防ぐ。 */
function initializeGis() {
  if (initializeCalled) {
    return;
  }

  const googleId = getGoogleId();

  if (!googleId) {
    return;
  }

  initializeCalled = true;
  googleId.initialize({
    client_id: GOOGLE_AUTH_CONFIG.clientId,
    callback: handleCredentialResponse,
    /* One Tap と自動ログインは使用しない。 */
    auto_select: false,
    cancel_on_tap_outside: true,
    itp_support: true,
  });
}

/* renderButton も1回だけ。以降は描画済みのボタンを表示/非表示で切り替える。 */
function renderSignInButton() {
  if (renderButtonCalled || !el?.button) {
    return;
  }

  const googleId = getGoogleId();

  if (!googleId) {
    return;
  }

  renderButtonCalled = true;
  googleId.renderButton(el.button, {
    ...BUTTON_OPTIONS,
    width: resolveButtonWidth(),
  });
}

/* ---------- 起動 ---------- */

export async function startGoogleAuth() {
  /* 二重初期化防止。 */
  if (started) {
    return;
  }

  started = true;
  el = collectElements();

  /* ログイン領域が無いページで読み込まれた場合は何もしない。 */
  if (!el?.panel) {
    return;
  }

  bindSignOut();

  /* クライアントID未設定。外部スクリプトの読み込みも行わない。 */
  if (!isClientIdConfigured()) {
    console.warn(
      '[apps] GoogleクライアントIDが未設定です。apps/auth-config.js の clientId を設定してください（設定手順: apps/AUTH_SETUP.md）。',
    );
    clearProfile();
    renderAuthState(AUTH_STATUS.UNAVAILABLE);
    return;
  }

  /*
   * 同一タブに残っている表示用プロフィール。
   * 未検証のキャッシュであり、期限切れ・破損は loadProfile() 側で破棄される。
   */
  const cached = loadProfile();
  renderAuthState(cached ? AUTH_STATUS.SIGNED_IN : AUTH_STATUS.LOADING, cached);

  try {
    await loadGisScript();
  } catch (error) {
    console.warn('[apps] Google Identity Services を読み込めませんでした:', error?.message ?? 'Error');

    /*
     * 読み込みに失敗しても、アプリ一覧は通常どおり利用できる。
     * すでに表示中のプロフィールがある場合は、その表示を維持する。
     */
    if (!cached) {
      renderAuthState(AUTH_STATUS.ERROR);
    }

    return;
  }

  try {
    initializeGis();

    if (!cached) {
      /* 先に領域を表示してから描画すると、ボタン幅を実測できる。 */
      renderAuthState(AUTH_STATUS.SIGNED_OUT);
    }

    renderSignInButton();
  } catch (error) {
    console.warn('[apps] Googleログインの初期化に失敗しました:', error?.name ?? 'Error');

    if (!cached) {
      renderAuthState(AUTH_STATUS.ERROR);
    }
  }
}

export function getAuthState() {
  return { status: currentStatus, profile: currentProfile };
}

/* ブラウザで読み込まれたときだけ自動起動する（テストからの import では起動しない）。 */
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { startGoogleAuth(); }, { once: true });
  } else {
    startGoogleAuth();
  }
}

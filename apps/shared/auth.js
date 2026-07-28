/*
 * TSAM AI のログイン。
 * 画面から呼ぶのはこのモジュールだけにする（プロバイダを直接呼ばない）。
 *
 * ------------------------------------------------------------------
 * Googleログインとの関係（重要）
 * ------------------------------------------------------------------
 * ここでいう「ログイン」は **TSAM AI 自体へのログイン** であり、
 * Googleアカウントとは無関係である。
 *
 *   shared/auth.js        … TSAM AI へのログイン（Supabase）
 *   apps/google-auth.js   … Googleアカウントの表示（既存・別物）
 *   shared/drive-auth.js  … Google Drive の認可（Phase 5）
 *
 * Googleログインは「Drive連携」として、ログイン後の個人ホームから
 * 任意で行う位置付けになる。ここでは一切扱わない。
 * ------------------------------------------------------------------
 *
 * ------------------------------------------------------------------
 * プロバイダの選択
 * ------------------------------------------------------------------
 * apps/shared/supabase-config.js が設定済みなら Supabase を、
 * 未設定ならダミー（動作確認用）を自動で選ぶ。
 * 設定を書き込むだけで本番認証へ切り替わり、画面側の変更は要らない。
 *
 * setAuthProvider() で明示的に差し替えることもできる（テスト・移行用）。
 * ------------------------------------------------------------------
 *
 * ------------------------------------------------------------------
 * どこまで守れるのか（重要）
 * ------------------------------------------------------------------
 * Supabase を設定すると、**サーバー側で検証される本物の認証**になる。
 * 発行されたアクセストークンが無ければ Supabase のAPIは通らない。
 *
 * ただし、この静的サイトには自前のサーバーが無いため、
 * 「ページを表示するかどうか」の判断はブラウザ側で行っている。
 * requireAuth() は導線の制御であって、HTMLやJSの取得は防げない。
 *
 * したがって:
 *   守れる   … Supabase 上のデータ（RLSとトークンで守られる）
 *   守れない … このサイトに置いた静的ファイルの中身
 *
 * 秘密にしたい情報を、HTMLやJSへ直接書かないこと。
 * ------------------------------------------------------------------
 */

import {
  AAL,
  createSession,
  readSession,
  writeSession,
  clearSession,
  touchSession,
  subscribeSession,
  resolveDisplayName,
  isStorageAvailable,
  SESSION_TTL_MS,
  SESSION_STORAGE_KEY,
} from './session.js';

import { safeNextUrl, resolveNextUrl, currentPageAsNext } from './app-paths.js';

import * as dummyProvider from './auth-providers/dummy.js';
import * as supabaseProvider from './auth-providers/supabase.js';
import { isSupabaseConfigured, describeConfig } from './supabase-config.js';

/* ログインの到達状態。 */
export const LOGIN_STATUS = Object.freeze({
  /* 完了。保護対象の操作をしてよい。 */
  SIGNED_IN: 'signed-in',
  /* パスワードは通ったが、二段階認証のコード入力が残っている。 */
  MFA_REQUIRED: 'mfa-required',
});

export const AuthErrorCode = Object.freeze({
  INVALID_INPUT: 'INVALID_INPUT',
  /* IDまたはパスワードが違う（どちらかは区別しない）。 */
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  /* メールアドレスの確認が済んでいない。 */
  EMAIL_NOT_CONFIRMED: 'EMAIL_NOT_CONFIRMED',
  /* 二段階認証のコードが必要／不足している。 */
  MFA_REQUIRED: 'MFA_REQUIRED',
  /* 二段階認証のコードが違う、または期限切れ。 */
  MFA_INVALID_CODE: 'MFA_INVALID_CODE',
  /* パスワードが要件を満たさない。 */
  WEAK_PASSWORD: 'WEAK_PASSWORD',
  /* 現在と同じパスワードを設定しようとした。 */
  SAME_PASSWORD: 'SAME_PASSWORD',
  /* メール内のリンクが期限切れ、または使用済み。 */
  LINK_EXPIRED: 'LINK_EXPIRED',
  SESSION_EXPIRED: 'SESSION_EXPIRED',
  RATE_LIMITED: 'RATE_LIMITED',
  NETWORK: 'NETWORK',
  /* 認証基盤が未設定。 */
  NOT_CONFIGURED: 'NOT_CONFIGURED',
  /* この機能にプロバイダが対応していない。 */
  NOT_SUPPORTED: 'NOT_SUPPORTED',
  STORAGE_UNAVAILABLE: 'STORAGE_UNAVAILABLE',
  REQUEST_IN_FLIGHT: 'REQUEST_IN_FLIGHT',
  UNKNOWN: 'UNKNOWN',
});

/*
 * 利用者へ出す既定の文言。
 * プロバイダが message を返さないときに使う。
 * 内部情報（英語のAPIメッセージ・スタック・コード）を混ぜないこと。
 */
const DEFAULT_MESSAGES = Object.freeze({
  [AuthErrorCode.INVALID_INPUT]: '入力内容を確認してください。',
  [AuthErrorCode.INVALID_CREDENTIALS]: 'メールアドレスまたはパスワードが正しくありません。',
  [AuthErrorCode.EMAIL_NOT_CONFIRMED]: 'メールアドレスの確認が済んでいません。届いている確認メールのリンクを開いてください。',
  [AuthErrorCode.MFA_REQUIRED]: '二段階認証のコードを入力してください。',
  [AuthErrorCode.MFA_INVALID_CODE]: 'コードが正しくありません。認証アプリに表示されている最新の6桁を入力してください。',
  [AuthErrorCode.WEAK_PASSWORD]: 'パスワードが条件を満たしていません。別のパスワードを設定してください。',
  [AuthErrorCode.SAME_PASSWORD]: '現在と同じパスワードは設定できません。',
  [AuthErrorCode.LINK_EXPIRED]: 'このリンクは期限切れか、すでに使用済みです。もう一度手続きをやり直してください。',
  [AuthErrorCode.SESSION_EXPIRED]: 'ログインの有効期限が切れました。もう一度ログインしてください。',
  [AuthErrorCode.RATE_LIMITED]: '試行回数が上限に達しました。しばらく待ってからお試しください。',
  [AuthErrorCode.NETWORK]: '通信に失敗しました。接続を確認してもう一度お試しください。',
  [AuthErrorCode.NOT_CONFIGURED]: 'ログイン機能は現在準備中です。',
  [AuthErrorCode.NOT_SUPPORTED]: 'この操作は現在の設定では利用できません。',
  [AuthErrorCode.STORAGE_UNAVAILABLE]: 'このブラウザではログイン状態を保持できません。プライベートモードを解除してお試しください。',
  [AuthErrorCode.REQUEST_IN_FLIGHT]: '処理中です。しばらくお待ちください。',
  [AuthErrorCode.UNKNOWN]: 'ログインできませんでした。しばらく待ってからお試しください。',
});

export class AuthError extends Error {
  constructor(code, message) {
    super(code);
    this.name = 'AuthError';
    this.code = Object.values(AuthErrorCode).includes(code) ? code : AuthErrorCode.UNKNOWN;
    /* 画面へそのまま出してよい日本語。内部情報は含めない。 */
    this.userMessage = message || DEFAULT_MESSAGES[this.code] || DEFAULT_MESSAGES.UNKNOWN;
  }
}

/* ---------- プロバイダ ---------- */

/*
 * 既定のプロバイダを決める。
 * Supabase が設定済みならそれを、未設定ならダミーを使う。
 */
function resolveDefaultProvider() {
  return isSupabaseConfigured() ? supabaseProvider : dummyProvider;
}

let provider = resolveDefaultProvider();
let inFlight = false;

/* 二段階認証の途中経過。ログイン処理の中だけで使い、保存しない。 */
let pendingMfa = null;

export function setAuthProvider(next) {
  if (!next || typeof next.signIn !== 'function' || typeof next.signOut !== 'function') {
    throw new AuthError(AuthErrorCode.UNKNOWN, 'invalid_provider');
  }

  provider = next;
  pendingMfa = null;
}

export function getAuthProviderId() {
  return provider?.PROVIDER_ID ?? 'unknown';
}

export function isUsingDummyProvider() {
  return getAuthProviderId() === dummyProvider.PROVIDER_ID;
}

/* プロバイダの入力規則。画面のヒント文や maxlength に使う。 */
export function getInputRules() {
  return provider?.INPUT_RULES ?? dummyProvider.INPUT_RULES;
}

/*
 * 利用できる機能。画面はこれを見て導線を出し分ける。
 * { mfa, passwordReset, emailVerification, passwordChange }
 */
export function getCapabilities() {
  return provider?.CAPABILITIES ?? dummyProvider.CAPABILITIES;
}

/*
 * 認証基盤の設定状況。準備中の案内に使う。
 *
 * configured は「本物の認証が動いているか」を表す。
 * ダミープロバイダのときは、設定ファイルの状態にかかわらず必ず false
 * （設定済みでも明示的にダミーへ差し替えている場合があるため）。
 */
export function getProviderStatus() {
  if (isUsingDummyProvider()) {
    return { configured: false, reason: describeConfig().reason };
  }

  return { configured: true, reason: null };
}

/* Result（{ok:false}）を AuthError へ変換する。 */
function toAuthError(result) {
  return new AuthError(result?.code ?? AuthErrorCode.UNKNOWN, result?.message);
}

/* プロバイダが機能を持たない場合に投げる。 */
function requireCapability(name) {
  if (getCapabilities()?.[name] !== true) {
    throw new AuthError(AuthErrorCode.NOT_SUPPORTED);
  }
}

/* ---------- 写しの更新 ---------- */

/*
 * プロバイダから受け取った利用者情報を、画面表示用の写しへ反映する。
 * 失敗（保存できない）した場合は false を返す。
 */
function syncSession(user) {
  const session = createSession({
    userId: user?.userId,
    displayName: user?.displayName ?? null,
    loginId: user?.loginId ?? null,
    provider: getAuthProviderId(),
    aal: user?.aal === AAL.TWO ? AAL.TWO : AAL.ONE,
    emailConfirmed: user?.emailConfirmed === true,
    ttlMs: SESSION_TTL_MS,
  });

  if (!session) {
    return false;
  }

  return writeSession(session);
}

/* ---------- 状態の参照 ---------- */

/*
 * ログイン済みか。**同期関数**。
 *
 * 判定に使うのは画面表示用の写しであり、トークンそのものではない。
 * 起動直後に一瞬だけ実際の状態とずれることがあるため、
 * ページは restoreSession() で補正する。
 */
export function isAuthenticated() {
  return readSession() !== null;
}

/*
 * 現在の利用者。未ログインなら null。
 * パスワードもトークンも含まない。
 */
export function getCurrentUser() {
  const session = readSession();

  if (!session) {
    return null;
  }

  return {
    userId: session.userId,
    displayName: resolveDisplayName(session),
    loginId: session.loginId,
    provider: session.provider,
    aal: session.aal,
    emailConfirmed: session.emailConfirmed,
    expiresAt: session.expiresAt,
  };
}

/* 二段階認証まで完了しているか。 */
export function hasMfaAssurance() {
  return readSession()?.aal === AAL.TWO;
}

export function subscribeAuth(listener) {
  if (typeof listener !== 'function') {
    return () => {};
  }

  return subscribeSession(({ authenticated }) => {
    listener({ authenticated, user: authenticated ? getCurrentUser() : null });
  });
}

/* ---------- ログイン ---------- */

/*
 * ログインする。
 *
 * 戻り値:
 *   { status: 'signed-in',    user }
 *   { status: 'mfa-required', user, factors }
 *
 * 失敗時は AuthError を投げる（error.userMessage をそのまま画面へ出せる）。
 *
 * ------------------------------------------------------------------
 * password はこの関数とプロバイダの中だけで扱う。
 * 写しにも保存されず、ログにも出ない。
 * 呼び出し側は成否にかかわらず入力欄を必ずクリアすること。
 * ------------------------------------------------------------------
 */
export async function login(loginId, password) {
  if (inFlight) {
    throw new AuthError(AuthErrorCode.REQUEST_IN_FLIGHT);
  }

  inFlight = true;
  pendingMfa = null;

  try {
    let result;

    try {
      result = await provider.signIn({ loginId, password });
    } catch (error) {
      console.warn('[tsam-auth] プロバイダのログイン処理で例外:', error?.name ?? 'Error');
      throw new AuthError(AuthErrorCode.UNKNOWN);
    }

    if (!result?.ok) {
      throw toAuthError(result);
    }

    /*
     * 二段階認証が残っている場合、まだ写しを作らない。
     * ここで写しを作ると、コード入力を終える前に
     * requireAuth() を通過できてしまう。
     */
    if (result.status === LOGIN_STATUS.MFA_REQUIRED) {
      const factors = Array.isArray(result.factors) ? result.factors : [];
      pendingMfa = { factors };

      return {
        status: LOGIN_STATUS.MFA_REQUIRED,
        user: result.user ?? null,
        factors,
      };
    }

    if (!syncSession(result.user)) {
      throw new AuthError(AuthErrorCode.STORAGE_UNAVAILABLE);
    }

    return { status: LOGIN_STATUS.SIGNED_IN, user: getCurrentUser(), factors: [] };
  } finally {
    inFlight = false;
  }
}

/* ログイン処理が二段階認証の入力待ちかどうか。 */
export function isAwaitingMfa() {
  return pendingMfa !== null;
}

/*
 * 「パスワードは通ったがコード入力を終えていない」状態を拾い直す。
 *
 * ------------------------------------------------------------------
 * なぜ必要か
 * ------------------------------------------------------------------
 * 二段階認証の途中でページを再読み込みすると、入力待ちの情報
 * （pendingMfa）はメモリ上なので消える。
 * 一方、認証基盤側には **AAL1 のセッションが残ったまま** になる。
 *
 * これを拾わないと:
 *   - 利用者はコード入力画面へ戻れない（パスワードからやり直しになる）
 *   - 中途半端なセッションが有効期限まで残り続ける
 *
 * ログイン画面の起動時にこれを呼び、待ち状態なら
 * コード入力画面から再開する。
 * ------------------------------------------------------------------
 *
 * 戻り値: 入力待ちなら { factors }、それ以外は null
 */
export async function resumePendingMfa() {
  if (getCapabilities()?.mfa !== true || typeof provider.refresh !== 'function') {
    return null;
  }

  let result;

  try {
    result = await provider.refresh(readSession());
  } catch {
    return null;
  }

  /* MFA_REQUIRED 以外（未ログイン・完了済み・通信失敗）は対象外。 */
  if (result?.ok || result?.code !== AuthErrorCode.MFA_REQUIRED) {
    return null;
  }

  let factors;

  try {
    factors = await provider.listMfaFactors();
  } catch {
    return null;
  }

  if (!factors?.ok || !Array.isArray(factors.factors) || factors.factors.length === 0) {
    /*
     * 要素が読めない状態で入力画面を出しても先へ進めない。
     * 中途半端なセッションを残さないよう、破棄してやり直してもらう。
     */
    await logout();
    return null;
  }

  pendingMfa = { factors: factors.factors };
  return { factors: factors.factors };
}

/* 入力待ちの要素一覧（画面で「どのアプリの分か」を出すため）。 */
export function getPendingMfaFactors() {
  return pendingMfa?.factors ? pendingMfa.factors.slice() : [];
}

/*
 * 二段階認証のコードを送ってログインを完了する。
 * login() が 'mfa-required' を返したあとに呼ぶ。
 */
export async function verifyMfaCode(code, { factorId = null } = {}) {
  if (!pendingMfa) {
    throw new AuthError(AuthErrorCode.SESSION_EXPIRED);
  }

  requireCapability('mfa');

  if (inFlight) {
    throw new AuthError(AuthErrorCode.REQUEST_IN_FLIGHT);
  }

  inFlight = true;

  try {
    const target = factorId ?? pendingMfa.factors[0]?.id ?? null;

    if (!target) {
      throw new AuthError(AuthErrorCode.UNKNOWN);
    }

    const result = await provider.verifyMfa({ factorId: target, code });

    if (!result?.ok) {
      throw toAuthError(result);
    }

    if (!syncSession(result.user)) {
      throw new AuthError(AuthErrorCode.STORAGE_UNAVAILABLE);
    }

    pendingMfa = null;
    return { status: LOGIN_STATUS.SIGNED_IN, user: getCurrentUser() };
  } finally {
    inFlight = false;
  }
}

/* 二段階認証の入力を中断する（「最初からやり直す」操作）。 */
export async function cancelMfa() {
  pendingMfa = null;
  await logout();
}

/* ---------- ログアウト / 復元 ---------- */

/*
 * ログアウトする。
 * プロバイダ側の失効に失敗しても、手元の写しは必ず破棄する。
 */
export async function logout() {
  const session = readSession();
  pendingMfa = null;

  try {
    await provider.signOut(session);
  } catch (error) {
    console.warn('[tsam-auth] プロバイダのログアウト処理に失敗:', error?.name ?? 'Error');
  }

  clearSession();
  return true;
}

/*
 * 保存済みトークンから実際の状態を確認し、写しを合わせる。
 *
 * ------------------------------------------------------------------
 * ページ読み込みごとに1回呼ぶこと。
 * 写しだけを見ていると、次のずれに気づけない。
 *   - 別のタブでログアウトした
 *   - Supabase 側でセッションが失効した
 *   - 写しだけが偽装された
 * ------------------------------------------------------------------
 *
 * 戻り値: { authenticated, user }
 */
export async function restoreSession() {
  if (typeof provider.refresh !== 'function') {
    return { authenticated: isAuthenticated(), user: getCurrentUser() };
  }

  let result;

  try {
    result = await provider.refresh(readSession());
  } catch (error) {
    /*
     * 通信できないだけの可能性がある。
     * ここで写しを消すと、オフライン時に勝手にログアウトしてしまう。
     * 判断を変えず、現在の写しをそのまま返す。
     */
    console.warn('[tsam-auth] セッション復元に失敗:', error?.name ?? 'Error');
    return { authenticated: isAuthenticated(), user: getCurrentUser() };
  }

  if (!result?.ok) {
    /* 通信エラーのときだけは写しを残す（上と同じ理由）。 */
    if (result?.code === AuthErrorCode.NETWORK) {
      return { authenticated: isAuthenticated(), user: getCurrentUser() };
    }

    clearSession();
    return { authenticated: false, user: null };
  }

  syncSession(result.user);
  return { authenticated: isAuthenticated(), user: getCurrentUser() };
}

/* 旧名。Phase 2 から呼んでいる箇所のために残す。 */
export async function refreshSession() {
  const { user } = await restoreSession();

  if (user) {
    touchSession();
  }

  return getCurrentUser();
}

/*
 * 別タブでのログアウトやトークン更新を、この画面へ反映する。
 * 戻り値: 解除する関数
 */
export async function watchProviderSession() {
  if (typeof provider.subscribe !== 'function') {
    return () => {};
  }

  return provider.subscribe(({ event, user }) => {
    if (!user || event === 'SIGNED_OUT') {
      clearSession();
      return;
    }

    syncSession(user);
  });
}

/* ---------- パスワード再設定 ---------- */

/*
 * 再設定メールを送る。
 *
 * 未登録のメールアドレスでも成功として返る。
 * 「登録済みかどうか」を教えないため（アカウント列挙の防止）。
 * 画面には「送信しました（登録がある場合）」と出すこと。
 */
export async function requestPasswordReset(loginId) {
  requireCapability('passwordReset');

  const result = await provider.requestPasswordReset({ loginId });

  if (!result?.ok) {
    throw toAuthError(result);
  }

  return true;
}

/*
 * 新しいパスワードを設定する。再設定リンクから、またはログイン中に呼ぶ。
 *
 * options.revokeOthers … true なら、この端末以外のセッションを失効させる。
 *   「パスワードが漏れたかもしれない」から変更する場合、
 *   他端末のログインが生き残っていては変更の意味がない。
 *   失効に失敗しても、変更自体は成功として扱う（結果で伝える）。
 *
 * 戻り値: { changed, othersRevoked }
 */
export async function updatePassword(password, { revokeOthers = false } = {}) {
  requireCapability('passwordChange');

  const result = await provider.updatePassword({ password });

  if (!result?.ok) {
    throw toAuthError(result);
  }

  if (result.user) {
    syncSession(result.user);
  }

  let othersRevoked = false;

  if (revokeOthers && typeof provider.revokeOtherSessions === 'function') {
    try {
      const revoked = await provider.revokeOtherSessions();
      othersRevoked = revoked?.ok === true;
    } catch {
      /* 失効できなくてもパスワードは変わっている。画面には結果で伝える。 */
      othersRevoked = false;
    }
  }

  return { changed: true, othersRevoked };
}

/*
 * 「パスワード再設定リンクから来た」ことの目印。
 *
 * ------------------------------------------------------------------
 * これは保護ではない（重要）
 * ------------------------------------------------------------------
 * sessionStorage の値であり、利用者が自分で書き込める。
 * 目的は導線の整理だけ:
 *   通常ログイン中の利用者が ?stage=set を直接開いたときに、
 *   文脈のない「新しいパスワード」画面を出さない。
 *
 * 「パスワード変更に再認証を求めるか」という本当の制御は、
 * Supabase 側の Secure password change 設定で行う。
 * ------------------------------------------------------------------
 */
const RECOVERY_FLAG_KEY = 'tsam-ai-recovery-flow';

function getSessionStorage() {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

export function markRecoveryFlow() {
  try {
    getSessionStorage()?.setItem(RECOVERY_FLAG_KEY, '1');
    return true;
  } catch {
    return false;
  }
}

/* 目印を読んで消す（1回だけ有効）。 */
export function consumeRecoveryFlow() {
  const storage = getSessionStorage();

  if (!storage) {
    return false;
  }

  try {
    const value = storage.getItem(RECOVERY_FLAG_KEY);
    storage.removeItem(RECOVERY_FLAG_KEY);
    return value === '1';
  } catch {
    return false;
  }
}

/* ---------- メール確認 ---------- */

export async function resendConfirmation(loginId) {
  requireCapability('emailVerification');

  const result = await provider.resendConfirmation({ loginId });

  if (!result?.ok) {
    throw toAuthError(result);
  }

  return true;
}

/*
 * メール内リンクから戻ってきたときの処理。
 * 戻り値: { type, user }
 */
export async function handleAuthCallback({ code, type = null } = {}) {
  if (typeof provider.exchangeCallback !== 'function') {
    throw new AuthError(AuthErrorCode.NOT_SUPPORTED);
  }

  const result = await provider.exchangeCallback({ code, type });

  if (!result?.ok) {
    throw toAuthError(result);
  }

  syncSession(result.user);

  return { type: result.type ?? type, user: getCurrentUser() };
}

/* ---------- 二段階認証の管理 ---------- */

export async function listMfaFactors() {
  requireCapability('mfa');

  const result = await provider.listMfaFactors();

  if (!result?.ok) {
    throw toAuthError(result);
  }

  return result.factors ?? [];
}

/*
 * TOTP の登録を開始する。
 * 戻り値: { factorId, qrCode, secret, uri }
 *
 * qrCode は SVG の data URI。**img の src に入れること**。
 * innerHTML でSVGを流し込まない（外部由来のマークアップを実行しない）。
 */
export async function startMfaEnrollment(options = {}) {
  requireCapability('mfa');

  const result = await provider.startMfaEnrollment(options);

  if (!result?.ok) {
    throw toAuthError(result);
  }

  return {
    factorId: result.factorId,
    qrCode: result.qrCode,
    secret: result.secret,
    uri: result.uri,
  };
}

/* 登録を確定する。成功したら写しの aal を上げる。 */
export async function confirmMfaEnrollment({ factorId, code }) {
  requireCapability('mfa');

  const result = await provider.confirmMfaEnrollment({ factorId, code });

  if (!result?.ok) {
    throw toAuthError(result);
  }

  await restoreSession();
  return true;
}

/* 二段階認証を解除する。AAL2（コード入力済み）でのみ成功する。 */
export async function disableMfa(factorId) {
  requireCapability('mfa');

  const result = await provider.disableMfa({ factorId });

  if (!result?.ok) {
    throw toAuthError(result);
  }

  await restoreSession();
  return true;
}

/* この端末でログイン状態を保持できるか。ログイン前の案内に使う。 */
export { isStorageAvailable };

/* ---------- 画面遷移 ---------- */

/*
 * 遷移先の検証は shared/app-paths.js に集約している。
 * 「文字列の見た目」ではなく「解決結果のオリジンとパス」で判定するため。
 * 理由と攻撃例は app-paths.js の safeNextUrl のコメントを参照。
 */
export {
  safeNextUrl, resolveNextUrl, getAppBaseUrl, resolveAppUrl,
} from './app-paths.js';

/*
 * 未ログインならログイン画面へ送る（**同期・写しだけを見る**）。
 *
 * 戻り値: 写しの上でログイン済みなら true / 未ログインなら false
 *
 * ------------------------------------------------------------------
 * これは「保護」ではない（重要）
 * ------------------------------------------------------------------
 * 見ているのは画面表示用の写しであり、実際のトークンではない。
 * 写しは開発者ツールから偽装できる。
 *
 * 保護対象の画面では、この関数だけで描画を始めてはならない。
 * **guardPage() を使い、サーバー確認を待ってから描画すること。**
 * requireAuth() は「明らかに未ログインの人を即座に案内する」ための
 * 早期リダイレクトにすぎない。
 * ------------------------------------------------------------------
 */
export function requireAuth({ loginUrl = 'login/', next = null } = {}) {
  if (isAuthenticated()) {
    return true;
  }

  redirectToLogin({ loginUrl, next });
  return false;
}

function redirectToLogin({ loginUrl = 'login/', next = null } = {}) {
  if (typeof globalThis.location === 'undefined') {
    return;
  }

  const target = new URL(loginUrl, globalThis.location.href);
  /* 自前で組み立てた値も、例外なく safeNextUrl を通す。 */
  const back = safeNextUrl(next) ?? safeNextUrl(currentPageAsNext());

  if (back) {
    target.searchParams.set('next', back);
  }

  globalThis.location.replace(target.href);
}

/*
 * 保護対象ページの入口。**認証の正本はSupabaseのセッション**。
 *
 * 手順:
 *   1. 写しを見て、明らかに未ログインなら即リダイレクト（体感を良くするため）
 *   2. プロバイダへ問い合わせて実際の状態を確認する
 *   3. 確認できた場合だけ true を返す
 *
 * 呼び出し側は **true が返るまで保護コンテンツを描画してはならない**。
 *
 *   if (!(await guardPage({ loginUrl: '../login/' }))) return;
 *   showContent();
 *
 * 通信できない場合（オフライン）は、写しが有効なら true を返す。
 * 圏外になった瞬間に画面から締め出さないため。
 * この判断は shared/auth.js の restoreSession() が担う。
 */
export async function guardPage({ loginUrl = 'login/', next = null } = {}) {
  if (!isAuthenticated()) {
    redirectToLogin({ loginUrl, next });
    return false;
  }

  const { authenticated } = await restoreSession();

  if (!authenticated) {
    redirectToLogin({ loginUrl, next });
    return false;
  }

  return true;
}

/*
 * ログイン済みならホームへ送る（ログイン画面で使う）。
 * 戻り値: 未ログインなら true（ログインフォームを描画してよい）
 */
export function redirectIfAuthenticated({ homeUrl = 'home/', next = null } = {}) {
  if (!isAuthenticated()) {
    return true;
  }

  if (typeof globalThis.location === 'undefined') {
    return false;
  }

  /*
   * 遷移先は「/apps/ の1階層下」を基準に解決する（app-paths.js の注記参照）。
   * 検証と遷移で基準を揃えないと、末尾スラッシュの有無でずれる。
   */
  const destination = resolveNextUrl(safeNextUrl(next) ?? homeUrl)
    ?? new URL(homeUrl, globalThis.location.href).href;

  globalThis.location.replace(destination);
  return false;
}

/*
 * 画面を離れている間の状態変化に追随する。
 *
 * 拾うもの:
 *   1. 別タブでのログイン／ログアウト（storage イベント）
 *   2. 認証基盤側の失効・トークン更新（プロバイダの購読）
 *   3. 「戻る」ボタンでの復帰（bfcache）
 *
 * 3 が重要。ブラウザは前後のページを丸ごと保存して復元することがあり、
 * その場合スクリプトは再実行されない。ログアウト後に「戻る」を押すと、
 * 個人情報が表示されたままの画面が復元されうる。
 * pageshow の persisted で検知して、その場で再確認する。
 *
 * 戻り値: 監視を解除する関数
 */
export function watchAuthState({ onSignedOut } = {}) {
  const handlers = [];

  const verify = async () => {
    const { authenticated } = await restoreSession();

    if (!authenticated) {
      onSignedOut?.();
    }
  };

  if (typeof globalThis.addEventListener === 'function') {
    /* bfcache から復元された場合は必ず再確認する。 */
    const onPageShow = (event) => {
      if (event.persisted) {
        verify();
      }
    };

    /* 別タブでの変化。写しのキーが変わったときだけ反応する。 */
    const onStorage = (event) => {
      if (event.key === null || event.key === SESSION_STORAGE_KEY) {
        if (!isAuthenticated()) {
          onSignedOut?.();
          return;
        }

        verify();
      }
    };

    globalThis.addEventListener('pageshow', onPageShow);
    globalThis.addEventListener('storage', onStorage);

    handlers.push(() => globalThis.removeEventListener('pageshow', onPageShow));
    handlers.push(() => globalThis.removeEventListener('storage', onStorage));
  }

  /* 認証基盤側の通知（失効・更新）。非同期に購読が張られる。 */
  let unsubscribeProvider = null;
  let cancelled = false;

  watchProviderSession().then((unsubscribe) => {
    if (cancelled) {
      unsubscribe();
      return;
    }

    unsubscribeProvider = unsubscribe;
  }).catch(() => {
    /* 購読できなくても画面は動く。 */
  });

  return () => {
    cancelled = true;
    handlers.forEach((off) => off());
    unsubscribeProvider?.();
  };
}

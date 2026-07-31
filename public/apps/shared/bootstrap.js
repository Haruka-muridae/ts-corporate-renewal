/*
 * /apps/ 配下の全アプリの共通入口。
 *
 * ------------------------------------------------------------------
 * アプリ側の使い方
 * ------------------------------------------------------------------
 * HTMLへ1行足すだけでよい。
 *
 *   <script type="module" src="../shared/bootstrap.js"></script>
 *
 * JSから使う場合も、個別ファイルではなくここを import する。
 *
 *   import { profileStore, aiClient, getSharedContext } from '../shared/bootstrap.js';
 *
 * 内部構成（drive-files.js を分割した等）が変わっても、
 * アプリ側を直さずに済むようにするため。
 * ------------------------------------------------------------------
 *
 * ------------------------------------------------------------------
 * このファイルがやらないこと（重要）
 * ------------------------------------------------------------------
 * 読み込んだだけでは **外部通信も認可ポップアップも発生しない**。
 *   - Google Identity Services を読み込まない
 *   - Drive API を呼ばない
 *   - アクセストークンを要求しない
 *
 * Drive へアクセスする処理は、すべて利用者のボタン押下から呼ぶこと。
 * ポップアップは利用者の操作からしか開けないため、
 * 起動時に自動で Drive を読む実装はできない（shared/README.md 第8節）。
 *
 * 起動時にやるのは localStorage のキャッシュを読むことだけで、
 * これは同期処理であり通信を伴わない。
 * ------------------------------------------------------------------
 */

import { readCachedProfile, dropCacheForOtherAccount } from './profile-store.js';
import { getAiConfig } from './ai-config.js';
import { getSignedInProfile } from './drive-auth.js';
import { isAuthenticated, getCurrentUser, getAuthProviderId } from './auth.js';

/* ---------- 名前空間としての再エクスポート ---------- */

export * as auth from './auth.js';
export * as session from './session.js';
export * as supabaseConfig from './supabase-config.js';
export * as driveAuth from './drive-auth.js';
export * as driveFiles from './drive-files.js';
export * as profileStore from './profile-store.js';
export * as aiConfig from './ai-config.js';
export * as aiClient from './ai-client.js';

/* ---------- よく使うものは直接も出す ---------- */

export {
  AuthError,
  AuthErrorCode,
  LOGIN_STATUS,
  login,
  logout,
  verifyMfaCode,
  cancelMfa,
  isAuthenticated,
  hasMfaAssurance,
  getCurrentUser,
  restoreSession,
  refreshSession,
  watchProviderSession,
  watchAuthState,
  subscribeAuth,
  requireAuth,
  guardPage,
  redirectIfAuthenticated,
  resumePendingMfa,
  safeNextUrl,
  getAppBaseUrl,
  resolveAppUrl,
  setAuthProvider,
  isUsingDummyProvider,
  getCapabilities,
  getProviderStatus,
  getInputRules,
  isStorageAvailable,
  requestPasswordReset,
  updatePassword,
  resendConfirmation,
  handleAuthCallback,
  listMfaFactors,
  startMfaEnrollment,
  confirmMfaEnrollment,
  disableMfa,
} from './auth.js';

export {
  SESSION_EVENT,
  SESSION_TTL_MS,
  subscribeSession,
  resolveDisplayName,
} from './session.js';

export {
  DRIVE_FILE_SCOPE,
  DriveAuthError,
  DriveAuthErrorCode,
  ensureAccessToken,
  withAccessToken,
  clearAccessToken,
  getSignedInProfile,
} from './drive-auth.js';

export {
  DRIVE_PATHS,
  DriveError,
  DriveErrorCode,
  isUnauthorized,
} from './drive-files.js';

export {
  PROFILE_EVENT,
  PROFILE_FIELDS,
  PROFILE_SOURCE,
  readCachedProfile,
  hasRegisteredProfile,
  loadProfileFromDrive,
  saveProfileToDrive,
  sanitizeProfileValues,
  getProfileSummary,
  describeProfileLocation,
} from './profile-store.js';

export {
  AI_CONFIG_EVENT,
  AI_MODE,
  KEY_PERSIST,
  getAiConfig,
  getAiMode,
  setAiMode,
  setApiKey,
  clearApiKey,
  hasApiKey,
  maskApiKey,
  subscribeAiConfig,
} from './ai-config.js';

export {
  AI_TASK,
  AiError,
  AiErrorCode,
  runAiTask,
  checkReady,
  listModes,
  getAiStatus,
} from './ai-client.js';

/* ---------- 起動 ---------- */

/* 共通基盤の版。不具合報告時にどの版かを特定するために使う。 */
export const SHARED_VERSION = '2.0.0-phase2';

/* 準備完了の通知。detail: { auth, profile, ai, signedIn } */
export const SHARED_READY_EVENT = 'tsam-shared-ready';

let started = false;

/*
 * 現在の共通状態をまとめて返す。
 * 通信は発生しない（ストレージを読むだけ）。
 *
 * 戻り値:
 *   auth     … TSAM AI へのログイン状態 { authenticated, user, provider }
 *              **これはセキュリティ境界ではない**（shared/auth.js の注記を参照）
 *   signedIn … Googleアカウント表示が生きているか（既存機能。別物）
 *   profile  … キャッシュ済みプロフィール。未登録・未同期なら null
 *   ai       … { mode, hasApiKey, persist }。**APIキーの実値は含まない**
 *
 * auth と signedIn は無関係である。
 *   auth     … TSAM AI のログイン（Phase 2 で追加）
 *   signedIn … Google Drive 連携の下地（後のPhaseで使う）
 */
export function getSharedContext() {
  const authenticated = isAuthenticated();

  return {
    version: SHARED_VERSION,
    auth: {
      authenticated,
      user: authenticated ? getCurrentUser() : null,
      provider: getAuthProviderId(),
    },
    signedIn: getSignedInProfile() !== null,
    profile: readCachedProfile(),
    ai: getAiConfig(),
  };
}

/*
 * 初期化。二重呼び出しは無視する。
 *
 * やること:
 *   1. TSAM AI のログイン状態を読む（期限切れならその場で破棄される）
 *   2. 別アカウントのプロフィールキャッシュが残っていれば捨てる
 *   3. Googleアカウント表示の変化を監視して、同じ処理を続ける
 *   4. tsam-shared-ready を発行して、各アプリへ準備完了を伝える
 *
 * いずれも同期処理で、通信もポップアップも伴わない。
 * **リダイレクトは行わない**（画面遷移は各ページが requireAuth で判断する）。
 */
export function startShared() {
  if (started || typeof document === 'undefined') {
    return getSharedContext();
  }

  started = true;

  /*
   * TSAM AI のログイン状態を確定させる。
   * readSession() は期限切れ・形式違い・破損したセッションを
   * その場で破棄するため、この1回で状態が正しくなる。
   * ここではリダイレクトを行わない（副作用を持たせない）。
   */
  try {
    isAuthenticated();
  } catch {
    /* ストレージが読めなくても起動は続ける（未ログイン扱い）。 */
  }

  /*
   * 別のGoogleアカウントでログインし直した場合、
   * 前のアカウントのプロフィールが画面に残らないようにする。
   * sub が一致する場合や、ログアウト中は何もしない。
   */
  try {
    dropCacheForOtherAccount();
  } catch {
    /* キャッシュが読めなくても起動は続ける。 */
  }

  /* 既存の apps/google-auth.js が発行するイベント。 */
  document.addEventListener('tsam-auth-change', () => {
    try {
      dropCacheForOtherAccount();
    } catch {
      /* 同上。 */
    }
  });

  const context = getSharedContext();

  if (typeof CustomEvent === 'function') {
    document.dispatchEvent(new CustomEvent(SHARED_READY_EVENT, { detail: context }));
  }

  return context;
}

/*
 * ブラウザで読み込まれたときだけ自動起動する
 * （テストやNodeからの import では起動しない）。
 * apps/google-auth.js と同じ方式。
 */
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { startShared(); }, { once: true });
  } else {
    startShared();
  }
}

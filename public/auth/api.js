/*
 * Apps Script Web アプリとの通信。
 *
 * ------------------------------------------------------------------
 * POST を text/plain で送る理由
 * ------------------------------------------------------------------
 * Content-Type を application/json にすると、ブラウザは事前に
 * OPTIONS（プリフライト）を送る。Apps Script の Web アプリは
 * OPTIONS に応答しないため、本体のリクエストが届かない。
 *
 * text/plain は「単純リクエスト」に該当し、プリフライトが発生しない。
 * 本文は JSON 文字列のまま送り、サーバー側で JSON.parse する。
 * 既存の apps/app-api.js と同じ方式。
 * ------------------------------------------------------------------
 *
 * ------------------------------------------------------------------
 * ここではエラー内容を作らない
 * ------------------------------------------------------------------
 * 画面に出す文言は、原則としてサーバーが返した message をそのまま使う。
 * 「未登録のメールアドレスです」のような、こちらで推測した文言を
 * 足さないこと。アカウントの有無を漏らす原因になる。
 *
 * 通信そのものが失敗した場合だけ、こちらの定型文を使う。
 * ------------------------------------------------------------------
 */

import { AUTH_CONFIG, isApiConfigured } from './config.js';

export const ApiErrorCode = Object.freeze({
  /* Webアプリ URL が未設定。 */
  NOT_CONFIGURED: 'NOT_CONFIGURED',
  /* 通信できなかった・タイムアウトした。 */
  NETWORK: 'NETWORK',
  /* サーバーが success:false を返した（code は error.code）。 */
  SERVER: 'SERVER',
});

const NETWORK_MESSAGE = '通信に失敗しました。時間をおいて再度お試しください。';
const NOT_CONFIGURED_MESSAGE = 'この機能は現在ご利用いただけません。';

export class ApiError extends Error {
  constructor(code, message) {
    super(code);
    this.name = 'ApiError';
    this.code = code;
    /* 画面へそのまま出してよい日本語。内部情報は含めない。 */
    this.userMessage = message;
  }
}

/* タイムアウト付きの fetch。 */
async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AUTH_CONFIG.requestTimeoutMs);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/* 共通の応答処理。success:false は ApiError にする。 */
async function readResult(response) {
  if (!response.ok) {
    throw new ApiError(ApiErrorCode.NETWORK, NETWORK_MESSAGE);
  }

  let payload;

  try {
    payload = await response.json();
  } catch {
    throw new ApiError(ApiErrorCode.NETWORK, NETWORK_MESSAGE);
  }

  if (!payload || payload.success !== true) {
    const error = payload?.error ?? {};
    throw new ApiError(error.code ?? ApiErrorCode.SERVER, error.message ?? NETWORK_MESSAGE);
  }

  return payload.data ?? {};
}

/*
 * POST する。body は JSON へ直列化して text/plain で送る。
 * パスワードはここを通るが、保存も記録もしない。
 */
export async function postAction(action, body = {}) {
  if (!isApiConfigured()) {
    throw new ApiError(ApiErrorCode.NOT_CONFIGURED, NOT_CONFIGURED_MESSAGE);
  }

  const payload = { action, ...body };

  /*
   * ログの参考情報。利用者が詐称できる値であり、判定には使わない。
   * GAS の doPost(e) は HTTPヘッダーを受け取れないため、
   * サーバー側で User-Agent を取得できない（docs/specs §14）。
   */
  if (typeof navigator !== 'undefined' && typeof navigator.userAgent === 'string') {
    payload.userAgent = navigator.userAgent.slice(0, 300);
  }

  let response;

  try {
    response = await fetchWithTimeout(AUTH_CONFIG.apiUrl, {
      method: 'POST',
      /* プリフライトを起こさないため text/plain のままにする。 */
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload),
      /* Cookie は使わない。認証はトークンだけで行う。 */
      credentials: 'omit',
      redirect: 'follow',
    });
  } catch {
    throw new ApiError(ApiErrorCode.NETWORK, NETWORK_MESSAGE);
  }

  return readResult(response);
}

/* GET する。参照専用の action だけに使う。 */
export async function getAction(action, params = {}) {
  if (!isApiConfigured()) {
    throw new ApiError(ApiErrorCode.NOT_CONFIGURED, NOT_CONFIGURED_MESSAGE);
  }

  const url = new URL(AUTH_CONFIG.apiUrl);
  url.searchParams.set('action', action);

  Object.keys(params).forEach((key) => {
    url.searchParams.set(key, String(params[key]));
  });

  let response;

  try {
    response = await fetchWithTimeout(url.href, {
      method: 'GET',
      credentials: 'omit',
      redirect: 'follow',
    });
  } catch {
    throw new ApiError(ApiErrorCode.NETWORK, NETWORK_MESSAGE);
  }

  return readResult(response);
}

/* ---------- 各操作 ---------- */

export function login({ email, password, remember }) {
  return postAction('login', { email, password, remember: remember === true });
}

export function verifySession(sessionToken) {
  return postAction('verifySession', { sessionToken });
}

export function logout(sessionToken) {
  return postAction('logout', { sessionToken });
}

export function setupPassword({ token, password, passwordConfirm }) {
  return postAction('setupPassword', { token, password, passwordConfirm });
}

export function resetPassword({ token, password, passwordConfirm }) {
  return postAction('resetPassword', { token, password, passwordConfirm });
}

export function requestPasswordReset(email) {
  return postAction('requestPasswordReset', { email });
}

/*
 * カレンダー通知のライセンスキーを受け取る。
 *
 * すでに発行済みなら**同じキー**が返る。作り直すと、そのキーで
 * セットアップ済みのテンプレートが全部動かなくなるためである。
 *
 * 戻り値の entitled は「いま通知を使える契約か」。false でもキーは返るので、
 * 呼び出し側は料金ページへの導線を出したうえで手続きを続けてよい
 * （契約後にセットアップをやり直さずに通知が始まる）。
 */
export function issueNotifierLicense(sessionToken) {
  return postAction('issueNotifierLicense', { sessionToken });
}

/*
 * 申込みを開始する。
 *
 * agreedItems と tosVersion は必須。
 * サーバー側でも必須項目の充足と規約版の一致を確認するため、
 * 画面のチェックを外しても決済へは進めない。
 */
export function createCheckoutSession({ planCode, email, agreedItems, tosVersion }) {
  return postAction('createCheckoutSession', {
    planCode,
    email,
    agreedItems,
    tosVersion,
  });
}

/* 申込み前に出す同意項目と契約条件の確認表。認証不要。 */
export function listConsentConfig() {
  return getAction('listConsentConfig');
}

export function checkoutStatus(checkoutSessionId) {
  return postAction('checkoutStatus', { checkoutSessionId });
}

export function listPlans() {
  return getAction('listPlans');
}

export function publicConfig() {
  return getAction('publicConfig');
}

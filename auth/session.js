/*
 * セッショントークンの保管と、保護対象ページの入口。
 *
 * ==================================================================
 * 何が「ログイン済み」の根拠なのか
 * ==================================================================
 * 根拠はサーバー（sessions シート）にある行だけである。
 *
 * ブラウザが持つのは推測困難なランダム文字列（セッショントークン）のみで、
 * 有効期限も利用者IDもロールも、この文字列からは読み取れない。
 * localStorage を書き換えても、サーバーに存在しないトークンは
 * verifySession で必ず落ちる。
 *
 * そのため、このモジュールは次を守る。
 *   - ローカルの値だけで「ログイン済み」と判断しない
 *   - 保護対象の内容は、サーバー確認が終わるまで描画しない
 *   - ロールは毎回サーバーから受け取ったものを使う
 *
 * profile（表示名・ロール）は **表示用の写し** であり、
 * 画面のちらつきを抑えるためだけに置いている。判定には使わない。
 * ==================================================================
 *
 * ------------------------------------------------------------------
 * 静的ホスティングの限界（隠さず書く）
 * ------------------------------------------------------------------
 * このサイトは GitHub Pages 上の静的ファイルであり、
 * 「HTMLやJSファイルそのものを配らない」ことはできない。
 * URL を直接叩けば、未ログインでも HTML と JS は取得できる。
 *
 * 守れるのはサーバー側にあるデータと操作であって、
 * 静的ファイルの中身ではない。
 * 秘密にしたい情報を HTML や JS へ直接書かないこと。
 * 詳細は SECURITY_NOTES.md に記載する。
 * ------------------------------------------------------------------
 */

import { AUTH_CONFIG, screenPath } from './config.js';
import { verifySession as verifySessionApi, logout as logoutApi, ApiError } from './api.js';

/* 保存先が使えない環境（プライベートモード等）でも画面は壊さない。 */
function getStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function isStorageAvailable() {
  return getStorage() !== null;
}

/* ---------- トークン ---------- */

export function readSessionToken() {
  const storage = getStorage();

  if (!storage) {
    return null;
  }

  try {
    const value = storage.getItem(AUTH_CONFIG.sessionStorageKey);
    return typeof value === 'string' && value !== '' ? value : null;
  } catch {
    return null;
  }
}

export function writeSessionToken(token) {
  const storage = getStorage();

  if (!storage || typeof token !== 'string' || token === '') {
    return false;
  }

  try {
    storage.setItem(AUTH_CONFIG.sessionStorageKey, token);
    return true;
  } catch {
    return false;
  }
}

export function clearSessionToken() {
  const storage = getStorage();

  if (!storage) {
    return;
  }

  try {
    storage.removeItem(AUTH_CONFIG.sessionStorageKey);
    /*
     * 旧版が保存していた表示用の写し。
     * 現在は書き込んでいないが、既存利用者の端末には残っているため、
     * ログアウト時に消す（AUTH_CONFIG.legacyProfileStorageKey の注記を参照）。
     */
    storage.removeItem(AUTH_CONFIG.legacyProfileStorageKey);
  } catch {
    /* 消せなくても、サーバー側が失効していれば入れない。 */
  }
}

/* ---------- 遷移 ---------- */

/*
 * ログイン後に戻る場所を ?next= で持ち回る。
 *
 * 受け付けるのは SCREENS に定義済みの画面名だけにする。
 * 任意のURLを受け取ると、ログイン直後に外部サイトへ飛ばす
 * オープンリダイレクトの踏み台になる。
 */
const ALLOWED_NEXT = ['portal'];

export function safeNextName(value) {
  return ALLOWED_NEXT.includes(value) ? value : 'portal';
}

export function readNextParam() {
  try {
    const params = new URLSearchParams(globalThis.location?.search ?? '');
    return safeNextName(params.get('next'));
  } catch {
    return 'portal';
  }
}

export function goToLogin({ next = null } = {}) {
  if (typeof globalThis.location === 'undefined') {
    return;
  }

  const url = new URL(screenPath('login'), globalThis.location.href);

  if (next) {
    url.searchParams.set('next', safeNextName(next));
  }

  globalThis.location.replace(url.href);
}

export function goToScreen(name) {
  if (typeof globalThis.location === 'undefined') {
    return;
  }

  globalThis.location.replace(new URL(screenPath(name), globalThis.location.href).href);
}

/* ---------- 保護対象ページの入口 ---------- */

/*
 * 保護対象ページの入口。
 *
 * 使い方:
 *   const user = await guardPage();
 *   if (!user) return;          // すでにログイン画面へ遷移している
 *   render(user);               // ここで初めて内容を描画する
 *
 * **戻り値が利用者オブジェクトになるまで、保護対象の内容を描画しないこと。**
 *
 * 通信できなかった場合も入れない（ログイン画面へ戻す）。
 * 「オフラインなら通す」という妥協はしない。
 * 確認できていない状態を「ログイン済み」と扱わないため。
 */
export async function guardPage({ next = 'portal' } = {}) {
  const token = readSessionToken();

  if (!token) {
    goToLogin({ next });
    return null;
  }

  try {
    const data = await verifySessionApi(token);

    if (!data?.user) {
      clearSessionToken();
      goToLogin({ next });
      return null;
    }

    return data.user;
  } catch (error) {
    /*
     * 期限切れ・失効・改ざんはここへ来る。手元のトークンも捨てる。
     * 通信エラーの場合はトークンを残す（オフラインで消してしまわない）が、
     * 画面へは入れない。
     */
    if (error instanceof ApiError && error.code !== 'NETWORK') {
      clearSessionToken();
    }

    goToLogin({ next });
    return null;
  }
}

/*
 * ログイン画面で使う。
 * すでに有効なセッションがあれば Portal へ送る。
 *
 * ここでも「トークンがあるから」ではなく、
 * サーバーが有効と答えたときだけ遷移する。
 */
export async function redirectIfSignedIn(nextName = 'portal') {
  const token = readSessionToken();

  if (!token) {
    return false;
  }

  try {
    const data = await verifySessionApi(token);

    if (data?.user) {
      goToScreen(safeNextName(nextName));
      return true;
    }
  } catch (error) {
    if (error instanceof ApiError && error.code !== 'NETWORK') {
      clearSessionToken();
    }
  }

  return false;
}

/*
 * ログアウトする。
 *
 * 順序が重要。まずサーバー側のセッションを失効させ、
 * そのあとブラウザ側を消す。画面遷移だけで済ませない。
 *
 * サーバーへの通知に失敗しても、手元のトークンは必ず消す。
 */
export async function signOut() {
  const token = readSessionToken();

  if (token) {
    try {
      await logoutApi(token);
    } catch {
      /* 失効を通知できなくても、手元は消す。期限が来ればサーバー側も切れる。 */
    }
  }

  clearSessionToken();
}

/*
 * メール内リンクの受け口。
 *
 * 招待・登録確認・パスワード再設定・メール変更の確認リンクは、
 * すべてこの画面へ戻ってくる。
 *
 * ------------------------------------------------------------------
 * ここで何をしているか
 * ------------------------------------------------------------------
 * PKCE フローでは、URLに一度きりの `?code=` が付いて戻ってくる。
 * それをセッションへ交換し、種別に応じた画面へ送る。
 *
 * `?flow=` は送信時にこちらで埋め込んだ種別（recovery / signup など）。
 * 利用者が書き換えられる値なので、**行き先の出し分けにだけ使う**。
 * 権限の判定には使わない。
 * ------------------------------------------------------------------
 *
 * ------------------------------------------------------------------
 * URLからコードを消す理由
 * ------------------------------------------------------------------
 * コードが付いたままのURLは、ブラウザの履歴・共有・
 * スクリーンショットに残る。交換が済んだ時点で不要になるため、
 * history.replaceState で消してから次へ進む。
 * ------------------------------------------------------------------
 */

import { handleAuthCallback, getCapabilities, markRecoveryFlow } from '../shared/auth.js';

const DESTINATIONS = Object.freeze({
  home: '../home/',
  login: '../login/',
  resetSet: '../password-reset/?stage=set',
  account: '../account/',
});

const el = {
  title: document.getElementById('callback-title'),
  lead: document.getElementById('callback-lead'),
  message: document.getElementById('callback-message'),
  links: document.getElementById('callback-links'),
};

start();

function setText(element, text) {
  if (element) {
    element.textContent = text;
  }
}

function showError(text) {
  setText(el.title, '確認できませんでした');
  setText(el.lead, '');

  if (el.message) {
    el.message.textContent = text;
    el.message.setAttribute('role', 'alert');
    el.message.hidden = false;

    try {
      el.message.focus({ preventScroll: true });
    } catch {
      /* 無視。 */
    }
  }

  if (el.links) {
    el.links.hidden = false;
  }
}

/*
 * 交換済みのコードをURLから取り除く。
 * 画面遷移を伴わないため、この時点で消しても処理は続けられる。
 */
function stripSensitiveParams() {
  try {
    const url = new URL(globalThis.location.href);
    url.searchParams.delete('code');
    url.searchParams.delete('token_hash');
    url.hash = '';
    globalThis.history.replaceState(null, '', url.href);
  } catch {
    /* 消せなくても続行する。 */
  }
}

function readParams() {
  try {
    const params = new URLSearchParams(globalThis.location.search);

    return {
      code: params.get('code'),
      flow: params.get('flow'),
      /* Supabase がエラーを返した場合、リンク自体にエラーが載ってくる。 */
      error: params.get('error') ?? params.get('error_code'),
      errorDescription: params.get('error_description'),
    };
  } catch {
    return { code: null, flow: null, error: null, errorDescription: null };
  }
}

function goTo(path) {
  globalThis.location.replace(new URL(path, globalThis.location.href).href);
}

async function start() {
  const params = readParams();

  /*
   * Supabase 側で先に弾かれた場合（期限切れリンクなど）。
   * error_description は英語かつ内部的なので、そのまま出さない。
   */
  if (params.error) {
    stripSensitiveParams();
    showError('このリンクは期限切れか、すでに使用済みです。お手数ですが、もう一度はじめからお試しください。');
    return;
  }

  if (!params.code) {
    showError('確認に必要な情報がURLに含まれていません。メール内のリンクをもう一度開いてください。');
    return;
  }

  if (!getCapabilities()?.emailVerification) {
    stripSensitiveParams();
    showError('メール確認は現在ご利用いただけません。');
    return;
  }

  try {
    await handleAuthCallback({ code: params.code, type: params.flow });

    /* 成功。コードは使い終わったので消す。 */
    stripSensitiveParams();

    if (params.flow === 'recovery') {
      /*
       * 再設定フローから来たことを次の画面へ伝える。
       * 通常ログイン中の利用者が ?stage=set を直接開いても
       * 設定画面が出ないようにするための目印。
       *
       * 利用者自身が書き換えられる値なので、これは**保護ではない**。
       * 「パスワード変更に再認証を要求するか」は Supabase 側の
       * Secure password change 設定で決まる（SUPABASE_SETUP.md 参照）。
       */
      markRecoveryFlow();
      setText(el.title, '確認できました');
      setText(el.lead, '新しいパスワードの設定へ進みます。');
      goTo(DESTINATIONS.resetSet);
      return;
    }

    setText(el.title, '確認できました');
    setText(el.lead, 'メールアドレスの確認が完了しました。');
    goTo(DESTINATIONS.home);
  } catch (error) {
    stripSensitiveParams();
    showError(error?.userMessage ?? 'このリンクを確認できませんでした。もう一度はじめからお試しください。');
  }
}

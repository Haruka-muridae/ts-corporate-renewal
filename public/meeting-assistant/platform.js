/*
 * 実行環境の判定（ブラウザ版）。
 *
 * ------------------------------------------------------------------
 * ここで決めるのは「どの画面を出すか」だけ
 * ------------------------------------------------------------------
 * 録音方式の切り替え（ネイティブ／Web）は native-bridge.js が担う。
 * このモジュールは DOM も録音も触らず、navigator / window だけを見る。
 *
 * Remote 録音（タブ音声）は PC ブラウザ専用。スマートフォンのブラウザでは
 * getDisplayMedia があっても実用にならないため、判定で隠す。
 * ------------------------------------------------------------------
 */

const MOBILE_UA_PATTERN = /Android|iPhone|iPad|iPod|Mobile|IEMobile|Opera Mini/i;

/*
 * スマートフォン／タブレットのブラウザか。
 *
 * 判定順:
 *   1. navigator.userAgentData.mobile（Chromium 系。UA 文字列の凍結後も信頼できる）
 *   2. UA 文字列
 *   3. iPadOS 13 以降は UA が Macintosh になるため、タッチ点数で見分ける
 */
export function isMobileBrowser(nav = globalThis.navigator) {
  if (!nav) {
    return false;
  }

  if (nav.userAgentData && typeof nav.userAgentData.mobile === 'boolean') {
    if (nav.userAgentData.mobile) {
      return true;
    }
  }

  if (MOBILE_UA_PATTERN.test(String(nav.userAgent ?? ''))) {
    return true;
  }

  const platform = String(nav.platform ?? '');
  const touchPoints = Number(nav.maxTouchPoints) || 0;

  return platform === 'MacIntel' && touchPoints > 1;
}

/*
 * ホーム画面へ追加した PWA（standalone）として開いているか。
 * iOS Safari は navigator.standalone、それ以外は display-mode で見る。
 */
export function isStandaloneDisplay(win = globalThis, nav = globalThis.navigator) {
  if (nav?.standalone === true) {
    return true;
  }

  try {
    return win?.matchMedia?.('(display-mode: standalone)')?.matches === true;
  } catch {
    return false;
  }
}

/*
 * Remote 録音を出してよいか。
 * ネイティブ・スマートフォンブラウザでは出さない。PC でもタブ音声を取れなければ出さない。
 */
export function canOfferRemote({ native = false, mobile = false, canCaptureTab = true } = {}) {
  return !native && !mobile && canCaptureTab;
}

/*
 * OAuth をリダイレクト方式で行うべきか。
 *
 * standalone の PWA ではポップアップが別アプリ（Safari 等）で開き、
 * トークンがこの画面へ戻ってこない。リダイレクト方式なら同じ画面で往復できる。
 * ネイティブ（Capacitor）は対象外。
 */
export function prefersRedirectAuth({ native = false, standalone = false } = {}) {
  return !native && standalone;
}

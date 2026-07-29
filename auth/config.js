/*
 * 本番認証システムの設定。
 * 値を書き換える場所は、このファイルの1か所だけにする。
 *
 * ------------------------------------------------------------------
 * これは秘密情報ではない
 * ------------------------------------------------------------------
 * apiUrl（Apps Script Webアプリの /exec URL）は、静的サイトのフロントから
 * 呼ぶための公開エンドポイントであり、秘密鍵ではない。
 * したがってこのファイルはリポジトリへコミットしてよい。
 *
 * 絶対に入れてはならないもの:
 *   Stripe シークレットキー / Webhook シークレット /
 *   セッション署名用シークレット / トークン用シークレット /
 *   Stripe Price ID
 *
 * Price ID すらフロントには持たせない。
 * 画面が送るのはプランコードだけで、Price ID への対応付けは
 * サーバー（認証設定スプレッドシートの plans シート）が持つ。
 * ------------------------------------------------------------------
 *
 * apiUrl が空のあいだは「未設定」とみなし、各画面は
 * 「現在ご利用いただけません」と案内して操作を止める。
 * 設定手順は AUTH_SETUP.md を参照。
 */

export const AUTH_CONFIG = Object.freeze({
  /*
   * Apps Script Webアプリの /exec URL。
   * 例: 'https://script.google.com/macros/s/AKfycb.../exec'
   * gas-auth/ をデプロイして得たURLをここへ貼る。
   */
  apiUrl: '',

  /* 通信のタイムアウト（ミリ秒）。パスワードハッシュの計算があるため長めにとる。 */
  requestTimeoutMs: 30000,

  /*
   * セッショントークンの保存キー。
   * 値そのものは推測困難なランダム文字列で、サーバー側でしか検証できない。
   */
  sessionStorageKey: 'tsam-auth-session',

  /* 画面表示用の写し（表示名・ロール）。認証の根拠にはしない。 */
  profileStorageKey: 'tsam-auth-profile',

  /* パスワード最低文字数の初期表示。実際の判定はサーバーが行う。 */
  passwordMinLength: 12,
});

/* Webアプリの /exec URL が設定済みかどうか。 */
export function isApiConfigured(url = AUTH_CONFIG.apiUrl) {
  return typeof url === 'string'
    && /^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec/.test(url.trim());
}

/*
 * 各画面のパス。
 *
 * ------------------------------------------------------------------
 * 相対パスに統一する理由
 * ------------------------------------------------------------------
 * このサイトは独自ドメイン（https://tsam-ai.com/login/）でも、
 * プロジェクトPages（https://user.github.io/repo/login/）でも配信されうる。
 * '/login/' のようなサイト内絶対パスを書くと、後者で404になる。
 *
 * そこで「いま自分がどの階層にいるか」を PATHS.depth で持ち、
 * そこからの相対パスを組み立てる。
 * ------------------------------------------------------------------
 */
export const SCREENS = Object.freeze({
  home: '',
  login: 'login/',
  logout: 'logout/',
  pricing: 'pricing/',
  portal: 'portal/',
  passwordSetup: 'password/setup/',
  passwordReset: 'password/reset/',
  paymentSuccess: 'payment/success/',
  paymentCancel: 'payment/cancel/',
});

/*
 * サイトのルートから見た、現在ページの深さ。
 * 各画面の JS が読み込み時に一度だけ設定する。
 *
 *   /login/            → 1
 *   /password/setup/   → 2
 */
let currentDepth = 1;

export function setScreenDepth(depth) {
  const value = Number(depth);
  currentDepth = Number.isFinite(value) && value >= 0 ? Math.floor(value) : 1;
}

/* サイトのルートまで戻る相対パス（'../' の繰り返し）。 */
export function rootPath() {
  return currentDepth === 0 ? './' : '../'.repeat(currentDepth);
}

/* 画面名から、現在ページを基準にした相対URLを作る。 */
export function screenPath(name) {
  const target = SCREENS[name];

  if (typeof target !== 'string') {
    return rootPath();
  }

  return `${rootPath()}${target}`;
}

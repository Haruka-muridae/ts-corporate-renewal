/*
 * Phase 3 で追加した画面の結合テスト（実ブラウザ）。
 *
 * Supabase 未設定＝ダミー動作の状態で、
 * 「準備中」への倒れ方と、SDKを読み込まないことを確認する。
 */

import { check, section, finish } from '../helpers/assert.mjs';
import { startSuite } from '../helpers/browser-harness.mjs';

/* サーバーと Chrome の起動・後片付けは共通実装に任せる。 */
const suite = await startSuite(1);
const { page, origin, subpathOrigin } = suite;
const { evaluate, goto, sleep, consoleErrors } = page;

/* 既存の記述を活かすための別名。 */
const ORIGIN = origin;
const ROOT = origin;
const SUBPATH = subpathOrigin;
const send = page.send;
const setViewport = page.setViewport;
let requests = [];
page.resetRequests();
const syncRequests = () => { requests = page.getRequests(); };


/* ================================================================ */

section("1. 同梱SDKが実ブラウザで動くか");
await goto(`${ORIGIN}/apps/login/`);
const sdk = await evaluate(`
  (async () => {
    const m = await import('/apps/vendor/supabase-auth-js-2.110.8.esm.js');
    return { keys: Object.keys(m).sort().join(','), type: typeof m.GoTrueClient };
  })()
`);
check('ESMとして読み込める', sdk.type === 'function', JSON.stringify(sdk));
check('必要な export がそろう',
  sdk.keys === 'AuthApiError,AuthError,AuthRetryableFetchError,GoTrueClient,isAuthApiError,isAuthError', sdk.keys);

const instantiable = await evaluate(`
  (async () => {
    const { GoTrueClient } = await import('/apps/vendor/supabase-auth-js-2.110.8.esm.js');
    const c = new GoTrueClient({ url: 'https://example.invalid/auth/v1', storageKey: 'probe', autoRefreshToken: false, persistSession: false, detectSessionInUrl: false });
    return typeof c.signInWithPassword === 'function' && typeof c.mfa.enroll === 'function';
  })()
`);
check('GoTrueClient を生成でき、MFA APIを持つ', instantiable === true);

section("2. 未設定時はSDKを読み込まない");
await evaluate('localStorage.clear(); sessionStorage.clear();');
page.resetRequests();
await goto(`${ORIGIN}/apps/login/`);
requests = page.getRequests();
const loadedVendor = requests.filter((u) => u.includes('/vendor/'));
check('★SDKを取得していない', loadedVendor.length === 0, loadedVendor.join(','));
const external = requests.filter((u) => !u.startsWith(ORIGIN) && !u.startsWith('data:') && !u.includes('fonts.g'));
check('★Supabaseへの通信も無い', external.length === 0, external.join(','));

section("3. ログイン画面（未設定）");
check('準備中の注意書きが出る', (await evaluate('!document.getElementById("login-dummy-notice").hidden')) === true);
check('理由が添えられる',
  (await evaluate('document.getElementById("login-dummy-reason").textContent')).includes('未設定'),
  await evaluate('document.getElementById("login-dummy-reason").textContent'));
check('メールアドレス欄になっている',
  (await evaluate('document.getElementById("login-id").type')) === 'email');
check('パスワード再設定はリンクにしない（未対応のため）',
  (await evaluate('document.querySelectorAll("#login-reset-item a").length')) === 0);
check('二段階認証の画面は隠れている',
  (await evaluate('document.getElementById("login-step-mfa").hidden')) === true);

section("4. ダミーでログイン→ホーム（Phase2 の回帰）");
await evaluate(`
  document.getElementById("login-id").value = "taro@example.com";
  document.getElementById("login-password").value = "password123";
  document.getElementById("login-form").requestSubmit();
`);
await sleep(1300);
check('ホームへ遷移', (await evaluate('location.pathname')) === '/apps/home/', await evaluate('location.pathname'));
check('表示名が出る', (await evaluate('document.getElementById("home-user-name").textContent')) === 'taro');
check('アカウント設定への導線が増えた',
  (await evaluate('!!document.querySelector(\'a.home-menu__item[href="../account/"]\')')) === true);
check('メニューは6項目', (await evaluate('document.querySelectorAll(".home-menu__item").length')) === 6);
check('セッション形式が v2',
  (await evaluate('JSON.parse(localStorage.getItem("tsam-ai-session")).v')) === 2);
check('aal が入っている',
  (await evaluate('JSON.parse(localStorage.getItem("tsam-ai-session")).aal')) === 'aal1');

section("5. アカウント設定画面");
await goto(`${ORIGIN}/apps/account/`);
check('開ける', (await evaluate('location.pathname')) === '/apps/account/');
check('本文が表示される', (await evaluate('!document.getElementById("main-content").hidden')) === true);
check('メールアドレスが出る',
  (await evaluate('document.getElementById("account-email").textContent')) === 'taro@example.com');
check('二段階認証は「—」（未対応）',
  (await evaluate('document.getElementById("account-mfa-status").textContent')) === '—');
check('準備中の案内が出る', (await evaluate('!document.getElementById("mfa-unavailable").hidden')) === true);
check('パスワード変更の節は隠れる（未対応）',
  (await evaluate('document.getElementById("account-password-section").hidden')) === true);
check('QRは描画していない', (await evaluate('!!document.getElementById("mfa-qr").getAttribute("src")')) === false);

section("6. 未ログインでアカウント設定を直接開く");
await evaluate('localStorage.clear()');
await goto(`${ORIGIN}/apps/account/`);
check('ログイン画面へ差し替わる', (await evaluate('location.pathname')) === '/apps/login/', await evaluate('location.pathname'));
check('next が入る', (await evaluate('new URLSearchParams(location.search).get("next")')) === '../account/');
check('個人向けの内容が露出しない',
  !(await evaluate('document.body.textContent')).includes('アカウント設定'));

section("7. パスワード再設定画面（未設定）");
await goto(`${ORIGIN}/apps/password-reset/`);
check('開ける', (await evaluate('location.pathname')) === '/apps/password-reset/');
check('準備中が出る', (await evaluate('!document.getElementById("reset-unavailable").hidden')) === true);
check('送信ボタンが無効', (await evaluate('document.getElementById("reset-request-submit").disabled')) === true);
check('入力欄も無効', (await evaluate('document.getElementById("reset-email").disabled')) === true);
check('ログインへ戻れる', (await evaluate('!!document.querySelector(\'a[href="../login/"]\')')) === true);

await goto(`${ORIGIN}/apps/password-reset/?stage=set`);
check('★目印なしでは設定段階に入れない',
  (await evaluate('document.getElementById("reset-step-set").hidden')) === true);
check('送信段階へ倒れる',
  (await evaluate('document.getElementById("reset-step-request").hidden')) === false);

/* 再設定リンク経由（auth-callback が立てる目印）を模す */
await evaluate('sessionStorage.setItem("tsam-ai-recovery-flow", "1")');
await goto(`${ORIGIN}/apps/password-reset/?stage=set`);
check('目印があれば設定段階に入る',
  (await evaluate('document.getElementById("reset-step-set").hidden')) === false);
check('★目印は1回で消費される',
  (await evaluate('sessionStorage.getItem("tsam-ai-recovery-flow")')) === null);
check('セッションが無いので入力は無効',
  (await evaluate('document.getElementById("reset-password").disabled')) === true);
check('文言が日本語',
  (await evaluate('document.getElementById("reset-set-message").textContent')).includes('期限切れ'));

section("8. メールリンクの受け口");
await goto(`${ORIGIN}/apps/auth-callback/`);
check('コード無しはエラー表示',
  (await evaluate('document.getElementById("callback-title").textContent')) === '確認できませんでした');
check('戻り先が出る', (await evaluate('!document.getElementById("callback-links").hidden')) === true);

await goto(`${ORIGIN}/apps/auth-callback/?error=access_denied&error_code=otp_expired`);
check('Supabase側エラーも日本語で説明',
  (await evaluate('document.getElementById("callback-message").textContent')).includes('期限切れ'));

await goto(`${ORIGIN}/apps/auth-callback/?code=some-secret-code&flow=recovery`);
await sleep(600);
check('★URLからコードを消している',
  !(await evaluate('location.search')).includes('some-secret-code'), await evaluate('location.search'));

section("9. 既存アプリへの影響");
await evaluate('localStorage.clear(); sessionStorage.clear();');

await goto(`${ORIGIN}/apps/`);
check('アプリ一覧はリダイレクトされない', (await evaluate('location.pathname')) === '/apps/');
check('アプリカードが描画される',
  (await evaluate('document.querySelectorAll("#apps-grid .app-card").length')) >= 4);
check('Googleログイン領域も従来どおり', (await evaluate('!!document.getElementById("auth-panel")')) === true);
check('TSAM AIのセッションを作らない', (await evaluate('localStorage.getItem("tsam-ai-session")')) === null);

await goto(`${ORIGIN}/apps/voice-recorder/`);
check('voice-recorder は無影響', (await evaluate('location.pathname')) === '/apps/voice-recorder/');
await goto(`${ORIGIN}/apps/payroll-transfer/`);
check('payroll-transfer は無影響', (await evaluate('location.pathname')) === '/apps/payroll-transfer/');
await goto(`${ORIGIN}/apps/favorites.html`);
check('favorites は無影響', (await evaluate('location.pathname')) === '/apps/favorites.html');

section("10. レスポンシブ");
const pages = [
  ['login', '/apps/login/'],
  ['password-reset', '/apps/password-reset/'],
  ['auth-callback', '/apps/auth-callback/'],
];

for (const width of [320, 375, 768, 1024, 1440]) {
  await setViewport(width);

  for (const [label, path] of pages) {
    await goto(`${ORIGIN}${path}`);
    const overflow = await evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth');
    check(`${label} ${width}px 横スクロールなし`, overflow <= 0, `overflow=${overflow}`);
  }

  /* アカウント設定は長いメールアドレスとQR領域があるため個別に見る。 */
  await evaluate(`localStorage.setItem("tsam-ai-session", JSON.stringify({
    v:2, userId:"dummy:x", displayName:"verylongdisplayname",
    loginId:"very.long.email.address.for.overflow@example-company-name.co.jp",
    provider:"dummy", aal:"aal1", emailConfirmed:false,
    issuedAt: Date.now(), expiresAt: Date.now()+3600000 }));`);
  await goto(`${ORIGIN}/apps/account/`);
  const accOverflow = await evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth');
  check(`account ${width}px 横スクロールなし（長いメール）`, accOverflow <= 0, `overflow=${accOverflow}`);
  await evaluate('localStorage.clear()');
}
await page.clearViewport();

section("11. コンソールエラー");
const realErrors = consoleErrors.filter((e) => !e.includes('favicon') && !e.includes('ERR_'));
check('コンソールエラーなし', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));
realErrors.slice(0, 5).forEach((e) => console.log(`    ! ${e}`));

finish();
await suite.close();

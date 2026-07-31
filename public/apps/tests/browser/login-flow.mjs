/*
 * ログインからログアウトまでの結合テスト（実ブラウザ）。
 *
 * Supabase 未設定（ダミー認証）の状態で、
 * 画面遷移・セッション・アクセシビリティを確認する。
 */

import { check, section, finish } from '../helpers/assert.mjs';
import { startSuite } from '../helpers/browser-harness.mjs';

/* サーバーと Chrome の起動・後片付けは共通実装に任せる。 */
const suite = await startSuite(0);
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

section("1. ログイン画面の表示");
await goto(`${ORIGIN}/apps/login/`);

check('URLがログイン画面', (await evaluate('location.pathname')) === '/apps/login/');
check('タイトル', (await evaluate('document.title')) === 'ログイン | TSAM AI');
check('h1 がログイン', (await evaluate('document.querySelector("h1").textContent')) === 'ログイン');
check('ログインID欄がある', (await evaluate('!!document.getElementById("login-id")')) === true);
check('パスワード欄は type=password',
  (await evaluate('document.getElementById("login-password").type')) === 'password');
check('autocomplete=username',
  (await evaluate('document.getElementById("login-id").autocomplete')) === 'username');
check('autocomplete=current-password',
  (await evaluate('document.getElementById("login-password").autocomplete')) === 'current-password');
check('仮ログインの注意書きが出る',
  (await evaluate('!document.getElementById("login-dummy-notice").hidden')) === true);
check('パスワードヒントが規則と一致',
  (await evaluate('document.getElementById("login-password-hint").textContent')) === '8文字以上で入力します。');
check('補助リンク3件',
  (await evaluate('document.querySelectorAll(".account-links__list li").length')) === 3);
check('リンク切れを作っていない',
  (await evaluate('document.querySelectorAll(".account-links__list a").length')) === 0);
check('未ログイン状態', (await evaluate('localStorage.getItem("tsam-ai-session")')) === null);

section("2. パスワード表示切替");
await evaluate('document.getElementById("login-password").value = "password123"');
await evaluate('document.getElementById("login-password-toggle").click()');
check('表示に切り替わる',
  (await evaluate('document.getElementById("login-password").type')) === 'text');
check('aria-pressed=true',
  (await evaluate('document.getElementById("login-password-toggle").getAttribute("aria-pressed")')) === 'true');
await evaluate('document.getElementById("login-password-toggle").click()');
check('非表示へ戻る',
  (await evaluate('document.getElementById("login-password").type')) === 'password');

section("3. 入力エラー");
await evaluate(`
  document.getElementById("login-id").value = "taro@example.com";
  document.getElementById("login-password").value = "abc";
  document.getElementById("login-form").requestSubmit();
`);
await sleep(300);
check('エラーが表示される',
  (await evaluate('!document.getElementById("login-message").hidden')) === true);
check('role=alert',
  (await evaluate('document.getElementById("login-message").getAttribute("role")')) === 'alert');
check('日本語の説明',
  (await evaluate('document.getElementById("login-message").textContent')).includes('8文字以上'),
  await evaluate('document.getElementById("login-message").textContent'));
check('パスワード欄がクリアされる',
  (await evaluate('document.getElementById("login-password").value')) === '');
check('aria-invalid が付く',
  (await evaluate('document.getElementById("login-password").getAttribute("aria-invalid")')) === 'true');
check('ログインしていない', (await evaluate('localStorage.getItem("tsam-ai-session")')) === null);
check('URLにパスワードが載っていない',
  !(await evaluate('location.search')).includes('password'));

section("4. ダミーログイン → 個人ホームへ遷移");
await evaluate(`
  document.getElementById("login-id").value = "taro@example.com";
  document.getElementById("login-password").value = "password123";
  document.getElementById("login-form").requestSubmit();
`);
await sleep(1200);

check('個人ホームへ遷移した', (await evaluate('location.pathname')) === '/apps/home/',
  await evaluate('location.pathname'));
check('タイトル', (await evaluate('document.title')) === 'マイページ | TSAM AI');
check('本文が表示される', (await evaluate('!document.getElementById("main-content").hidden')) === true);
check('表示名が出る', (await evaluate('document.getElementById("home-user-name").textContent')) === 'taro');
check('「ようこそ」がある',
  (await evaluate('document.querySelector(".home-welcome__label").textContent')) === 'ようこそ');
check('有効期限が出る',
  (await evaluate('document.getElementById("home-session-meta").textContent')).includes('有効期限'));

check('未実装3項目は aria-disabled',
  (await evaluate('document.querySelectorAll(".home-menu__item[aria-disabled=\\"true\\"]").length')) === 3);
check('リンク項目は3つ（アカウント設定・お気に入り・アプリ一覧）',
  (await evaluate('document.querySelectorAll("a.home-menu__item").length')) === 3);
check('ログアウトボタンがある', (await evaluate('!!document.getElementById("home-logout")')) === true);

section("5. セッションの中身");
const raw = await evaluate('localStorage.getItem("tsam-ai-session")');
console.log(`  ${raw}`);
check('セッションが保存されている', typeof raw === 'string' && raw.length > 0);
check('パスワードが含まれない', !raw.includes('password123'));
check('全ストレージにパスワードが無い',
  !(await evaluate('JSON.stringify({...localStorage, ...sessionStorage})')).includes('password123'));
check('保存キーが1つだけ',
  (await evaluate('Object.keys(localStorage).join(",")')) === 'tsam-ai-session',
  await evaluate('Object.keys(localStorage).join(",")'));

section("6. リロードしてもセッションが保持される");
await goto(`${ORIGIN}/apps/home/`);
check('ホームに留まる', (await evaluate('location.pathname')) === '/apps/home/');
check('表示名が復元される', (await evaluate('document.getElementById("home-user-name").textContent')) === 'taro');

section("7. ログイン済みでログイン画面を開くとホームへ戻される");
await goto(`${ORIGIN}/apps/login/`);
check('ホームへ転送される', (await evaluate('location.pathname')) === '/apps/home/',
  await evaluate('location.pathname'));

section("8. ログアウト");
await evaluate('document.getElementById("home-logout").click()');
await sleep(1200);
check('ログイン画面へ戻る', (await evaluate('location.pathname')) === '/apps/login/',
  await evaluate('location.pathname'));
check('セッションが消える', (await evaluate('localStorage.getItem("tsam-ai-session")')) === null);

section("9. 未ログインで /apps/home/ を直接開く");
await goto(`${ORIGIN}/apps/home/`);
check('ログイン画面へ差し替わる', (await evaluate('location.pathname')) === '/apps/login/',
  await evaluate('location.pathname'));
check('next に戻り先が入る',
  (await evaluate('new URLSearchParams(location.search).get("next")')) === '../home/',
  await evaluate('location.search'));
check('個人向けの見出しが露出していない',
  !(await evaluate('document.body.textContent')).includes('ようこそ'));

section("10. next= を使った復帰と、外部URLの拒否");
await evaluate(`
  document.getElementById("login-id").value = "hanako@example.com";
  document.getElementById("login-password").value = "password123";
  document.getElementById("login-form").requestSubmit();
`);
await sleep(1200);
check('next の指す先へ戻る', (await evaluate('location.pathname')) === '/apps/home/');
check('別の利用者名で表示される',
  (await evaluate('document.getElementById("home-user-name").textContent')) === 'hanako');

await evaluate('localStorage.clear()');
await goto(`${ORIGIN}/apps/login/?next=https://evil.example.com/`);
await evaluate(`
  document.getElementById("login-id").value = "taro@example.com";
  document.getElementById("login-password").value = "password123";
  document.getElementById("login-form").requestSubmit();
`);
await sleep(1200);
check('外部URLへは飛ばない', (await evaluate('location.origin')) === ORIGIN,
  await evaluate('location.href'));
check('既定のホームへ遷移', (await evaluate('location.pathname')) === '/apps/home/');

section("11. 既存ページへの影響");
await evaluate('localStorage.clear(); sessionStorage.clear();');

await goto(`${ORIGIN}/apps/`);
check('アプリ一覧はリダイレクトされない', (await evaluate('location.pathname')) === '/apps/');
check('アプリ一覧の見出しが従来どおり',
  (await evaluate('document.getElementById("apps-title").textContent')) === 'AIアプリ');
check('アプリカードが描画される',
  (await evaluate('document.querySelectorAll("#apps-grid .app-card").length')) >= 4,
  await evaluate('String(document.querySelectorAll("#apps-grid .app-card").length)'));
check('Googleログイン領域が従来どおり存在',
  (await evaluate('!!document.getElementById("auth-panel")')) === true);
check('TSAM AI のセッションを作っていない',
  (await evaluate('localStorage.getItem("tsam-ai-session")')) === null);

await goto(`${ORIGIN}/apps/favorites.html`);
check('お気に入り画面もリダイレクトされない',
  (await evaluate('location.pathname')) === '/apps/favorites.html');

await goto(`${ORIGIN}/apps/voice-recorder/`);
check('voice-recorder もリダイレクトされない',
  (await evaluate('location.pathname')) === '/apps/voice-recorder/');
check('voice-recorder が描画される',
  (await evaluate('!!document.querySelector("h1")')) === true);

await goto(`${ORIGIN}/apps/payroll-transfer/`);
check('payroll-transfer もリダイレクトされない',
  (await evaluate('location.pathname')) === '/apps/payroll-transfer/');

section("12. レスポンシブ（横スクロールが出ないこと）");
for (const width of [320, 375, 768, 1024, 1440]) {
  await setViewport(width);

  await goto(`${ORIGIN}/apps/login/`);
  const loginOverflow = await evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth');
  check(`login ${width}px 横スクロールなし`, loginOverflow <= 0, `overflow=${loginOverflow}`);

  await evaluate(`
    localStorage.setItem("tsam-ai-session", JSON.stringify({
      v:1, userId:"dummy:very.long.user.name@example.com",
      displayName:"very.long.user.name.for.overflow.test",
      loginId:"very.long.user.name@example.com", provider:"dummy",
      issuedAt: Date.now(), expiresAt: Date.now()+3600000
    }));
  `);
  await goto(`${ORIGIN}/apps/home/`);
  const homeOverflow = await evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth');
  check(`home ${width}px 横スクロールなし（長い表示名）`, homeOverflow <= 0, `overflow=${homeOverflow}`);

  await evaluate('localStorage.clear()');
}
await page.clearViewport();

section("13. コンソールエラー");
const realErrors = consoleErrors.filter((e) => !e.includes('favicon') && !e.includes('ERR_'));
check('コンソールエラーなし', realErrors.length === 0, realErrors.join(' | '));
if (realErrors.length > 0) {
  realErrors.forEach((e) => console.log(`    ! ${e}`));
}

finish();
await suite.close();

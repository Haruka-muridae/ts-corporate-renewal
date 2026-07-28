/*
 * 監査で追加した実ブラウザ検査。
 * 「要素があるか」ではなく「状態遷移が正しいか」を見る。
 *
 * サブパス配信（プロジェクトPages相当）は、同じサーバーが
 * /ts-corporate-renewal/apps/… を受け付けることで再現する。
 */

import { check, section, finish } from '../helpers/assert.mjs';
import { startSuite } from '../helpers/browser-harness.mjs';

/* サーバーと Chrome の起動・後片付けは共通実装に任せる。 */
const suite = await startSuite(2);
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


/* 写しだけを偽造する（攻撃者の視点）。 */
const forge = (extra = '') => `localStorage.setItem("tsam-ai-session", JSON.stringify({
  v:2, userId:"user-1", displayName:"偽装ユーザー", loginId:"forged@example.com",
  provider:"supabase", aal:"aal1", emailConfirmed:true,
  issuedAt: Date.now(), expiresAt: Date.now()+3600000 ${extra} }));`;

/* ================================================================ */

section("1. ダミー運用でも写しの偽装で入れてしまわないか");
/*
 * ダミープロバイダには照合先が無いため、写しがそのまま通る。
 * これは仕様（ダミーは保護ではない）。実Supabaseでは C 節のとおり弾かれる。
 * ここでは「その事実がテストで可視化されていること」を記録する。
 */
await goto(`${ROOT}/apps/login/`);
await evaluate('localStorage.clear(); sessionStorage.clear();');
await evaluate(forge());
await goto(`${ROOT}/apps/home/`);
const dummyForged = await evaluate('location.pathname');
check('ダミーでは写しが通る（＝保護ではないことの確認）', dummyForged === '/apps/home/', dummyForged);
check('その場合でも表示名は写しの値', (await evaluate('document.getElementById("home-user-name").textContent')) === '偽装ユーザー');

section("2. 保護コンテンツの露出タイミング");
/*
 * 保護ページのHTMLが hidden 付きで配信されていること（静的確認）。
 * 実行前にHTMLだけを見られても中身が出ないことを保証する。
 */
const homeHtml = await (await fetch(`${ROOT}/apps/home/`)).text();
const accountHtml = await (await fetch(`${ROOT}/apps/account/`)).text();
check('★home の本文が hidden 付きで配信される',
  /<main[^>]*id="main-content"[^>]*\shidden/.test(homeHtml));
check('★account の本文が hidden 付きで配信される',
  /<main[^>]*id="main-content"[^>]*\shidden/.test(accountHtml));
check('home のHTMLに個人情報が埋まっていない', !homeHtml.includes('@example.com'));

await goto(`${ROOT}/apps/login/`);
await evaluate('localStorage.clear(); sessionStorage.clear();');
await goto(`${ROOT}/apps/home/`);
check('未ログインならログイン画面へ差し替わる', (await evaluate('location.pathname')) === '/apps/login/');
check('個人向けの見出しが露出しない', !(await evaluate('document.body.textContent')).includes('ようこそ'));

section("3. セッション消失後に保護ページへ留まれないこと");
await goto(`${ROOT}/apps/login/`);
await evaluate('localStorage.clear(); sessionStorage.clear();');
await evaluate(`
  document.getElementById("login-id").value = "taro@example.com";
  document.getElementById("login-password").value = "password123";
  document.getElementById("login-form").requestSubmit();
`);
await sleep(1300);
check('ログインできる', (await evaluate('location.pathname')) === '/apps/home/', await evaluate('location.pathname'));

/* 別画面へ移動してからセッションを消し、保護ページを開き直す */
await goto(`${ROOT}/apps/password-reset/`);
await evaluate('localStorage.removeItem("tsam-ai-session")');
await goto(`${ROOT}/apps/home/`);
check('★セッションを消した後は home に留まれない',
  (await evaluate('location.pathname')) === '/apps/login/', await evaluate('location.pathname'));
await goto(`${ROOT}/apps/account/`);
check('★account にも留まれない',
  (await evaluate('location.pathname')) === '/apps/login/', await evaluate('location.pathname'));

section("4. 別タブでのログアウト（storage イベント）");
await goto(`${ROOT}/apps/login/`);
await evaluate('localStorage.clear()');
await evaluate(`
  document.getElementById("login-id").value = "taro@example.com";
  document.getElementById("login-password").value = "password123";
  document.getElementById("login-form").requestSubmit();
`);
await sleep(1300);
check('home にいる', (await evaluate('location.pathname')) === '/apps/home/');

/* 別タブのログアウトを storage イベントで再現する */
await evaluate(`
  localStorage.removeItem("tsam-ai-session");
  window.dispatchEvent(new StorageEvent("storage", { key: "tsam-ai-session", newValue: null }));
`);
await sleep(900);
check('★別タブのログアウトでログイン画面へ戻る',
  (await evaluate('location.pathname')) === '/apps/login/', await evaluate('location.pathname'));

section("5. オープンリダイレクト（実ブラウザ）");
const redirectAttacks = [
  ['二重バックスラッシュ', '%5C%5Cevil.example.com'],
  ['単一バックスラッシュ', '%5Cevil.example.com'],
  ['バックスラッシュ+スラッシュ', '%5C/evil.example.com'],
  ['プロトコル相対', '//evil.example.com'],
  ['絶対URL', 'https://evil.example.com/'],
  ['親をたどる', '../../index.html'],
];

for (const [label, payload] of redirectAttacks) {
  await goto(`${ROOT}/apps/login/`);
  await evaluate('localStorage.clear(); sessionStorage.clear();');
  await goto(`${ROOT}/apps/login/?next=${payload}`);
  await evaluate(`
    document.getElementById("login-id").value = "taro@example.com";
    document.getElementById("login-password").value = "password123";
    document.getElementById("login-form").requestSubmit();
  `);
  await sleep(1300);
  const origin = await evaluate('location.origin');
  const path = await evaluate('location.pathname');
  check(`★${label}: 外部へ飛ばない`, origin === ROOT, origin);
  check(`${label}: /apps/ 内に留まる`, path.startsWith('/apps/'), path);
}

section("6. GitHub Pages サブパス配信（/repo/apps/）");
/*
 * サブパスは同じサーバー（同じオリジン）で配信しているため、
 * 直前の節で作ったログイン状態が localStorage に残っている。
 * 本番では別ドメインになり共有されないので、先に消してから始める。
 */
await goto(`${ROOT}/apps/login/`);
await evaluate('localStorage.clear(); sessionStorage.clear();');

await goto(`${SUBPATH}/apps/login/`);
check('サブパスでログイン画面が開ける', (await evaluate('location.pathname')) === '/ts-corporate-renewal/apps/login/',
  await evaluate('location.pathname'));
check('ベースパスを正しく認識',
  (await evaluate('(async () => { const m = await import("/ts-corporate-renewal/apps/shared/app-paths.js"); return m.getAppBaseUrl(); })()'))
  === `${SUBPATH}/apps/`, await evaluate('(async () => { const m = await import("/ts-corporate-renewal/apps/shared/app-paths.js"); return m.getAppBaseUrl(); })()'));
check('コールバックURLもサブパスを含む',
  (await evaluate('(async () => { const m = await import("/ts-corporate-renewal/apps/shared/app-paths.js"); return m.resolveAppUrl("auth-callback/"); })()'))
  === `${SUBPATH}/apps/auth-callback/`);

await evaluate('localStorage.clear(); sessionStorage.clear();');
await evaluate(`
  document.getElementById("login-id").value = "taro@example.com";
  document.getElementById("login-password").value = "password123";
  document.getElementById("login-form").requestSubmit();
`);
await sleep(1300);
check('★サブパスでも home へ遷移する',
  (await evaluate('location.pathname')) === '/ts-corporate-renewal/apps/home/', await evaluate('location.pathname'));
check('表示名が出る', (await evaluate('document.getElementById("home-user-name").textContent')) === 'taro');

await goto(`${SUBPATH}/apps/account/`);
check('サブパスでアカウント設定も開ける',
  (await evaluate('location.pathname')) === '/ts-corporate-renewal/apps/account/');

await evaluate('localStorage.clear()');
await goto(`${SUBPATH}/apps/account/`);
check('★サブパスでも未ログインならログインへ',
  (await evaluate('location.pathname')) === '/ts-corporate-renewal/apps/login/', await evaluate('location.pathname'));
check('next もサブパス基準で正しい',
  (await evaluate('new URLSearchParams(location.search).get("next")')) === '../account/');

/* サブパスでオープンリダイレクトが復活しないこと */
await goto(`${SUBPATH}/apps/login/?next=%5C%5Cevil.example.com`);
await evaluate(`
  document.getElementById("login-id").value = "taro@example.com";
  document.getElementById("login-password").value = "password123";
  document.getElementById("login-form").requestSubmit();
`);
await sleep(1300);
check('★サブパスでも外部へ飛ばない', (await evaluate('location.origin')) === origin,
  await evaluate('location.href'));

section("7. 既存アプリの通信・ストレージ隔離");
await goto(`${ROOT}/apps/login/`);
await evaluate('localStorage.clear(); sessionStorage.clear();');

const legacyPages = [
  ['アプリ一覧', '/apps/'],
  ['お気に入り', '/apps/favorites.html'],
  ['voice-recorder', '/apps/voice-recorder/'],
  ['payroll-transfer', '/apps/payroll-transfer/'],
  ['knowledge', '/apps/knowledge/'],
];

for (const [label, path] of legacyPages) {
  page.resetRequests();
  await goto(`${ROOT}${path}`, 1400);

  const stayed = (await evaluate('location.pathname')) === path;
  const vendor = requests.filter((u) => u.includes('/vendor/supabase'));
  const sharedAuth = requests.filter((u) => u.includes('/shared/auth') || u.includes('/shared/supabase'));
  const supabaseNet = requests.filter((u) => u.includes('supabase.co'));
  const keys = await evaluate('Object.keys(localStorage).filter(k => k.startsWith("tsam-ai-session") || k.startsWith("tsam-ai-supabase")).join(",")');

  check(`${label}: リダイレクトされない`, stayed, await evaluate('location.pathname'));
  check(`${label}: Supabase SDK を読まない`, vendor.length === 0, vendor.join(','));
  check(`${label}: 認証モジュールを読まない`, sharedAuth.length === 0, sharedAuth.join(','));
  check(`${label}: Supabase へ通信しない`, supabaseNet.length === 0, supabaseNet.join(','));
  check(`${label}: 認証用キーを作らない`, keys === '', keys);
}

section("8. コールバックの外部通信");
page.resetRequests();
await goto(`${ROOT}/apps/auth-callback/?code=secret-code-value&flow=recovery`, 1200);
syncRequests();
const external = requests.filter((u) => !u.startsWith(ROOT));
check('★外部への通信が一切ない', external.length === 0, external.join(','));
check('★URLからコードが消えている', !(await evaluate('location.href')).includes('secret-code-value'),
  await evaluate('location.href'));

section("9. アクセシビリティ（状態遷移）");
await goto(`${ROOT}/apps/login/`);
await evaluate('localStorage.clear()');
check('パスワード欄の初期 aria-pressed',
  (await evaluate('document.getElementById("login-password-toggle").getAttribute("aria-pressed")')) === 'false');
await evaluate('document.getElementById("login-password-toggle").click()');
check('切替後 aria-pressed=true',
  (await evaluate('document.getElementById("login-password-toggle").getAttribute("aria-pressed")')) === 'true');

/* 二重送信の防止 */
await evaluate(`
  document.getElementById("login-id").value = "taro@example.com";
  document.getElementById("login-password").value = "short";
  document.getElementById("login-form").requestSubmit();
`);
await sleep(400);
check('エラー時に role=alert',
  (await evaluate('document.getElementById("login-message").getAttribute("role")')) === 'alert');
check('エラー時にフォーカスが移る',
  (await evaluate('document.activeElement.id')) === 'login-message', await evaluate('document.activeElement.id'));
check('aria-invalid が付く',
  (await evaluate('document.getElementById("login-password").getAttribute("aria-invalid")')) === 'true');

/* キーボードだけで到達できるか（tabindex が負でない） */
const focusables = await evaluate(`
  Array.from(document.querySelectorAll('#login-form input, #login-form button'))
    .filter(e => !e.disabled && e.tabIndex >= 0).length
`);
check('フォーム内の操作要素がキーボードで辿れる', focusables >= 3, String(focusables));

section("10. コンソールエラー");
const realErrors = consoleErrors.filter((e) => !e.includes('favicon') && !e.includes('ERR_'));
check('コンソールエラーなし', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));
realErrors.slice(0, 5).forEach((e) => console.log(`    ! ${e}`));

finish();
await suite.close();

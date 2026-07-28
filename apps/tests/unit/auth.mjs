/* Phase 2 認証・セッションの検証。DOM とストレージは最小のシムで再現する。 */

import { check, section, finish, fatal } from '../helpers/assert.mjs';
import { sharedUrl } from '../helpers/env.mjs';

/* 絶対パスを書かない。リポジトリのどこへ置いても動くようにする。 */
const url = (name) => sharedUrl(name);


function createStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    dump: () => Object.fromEntries(map),
  };
}

globalThis.localStorage = createStorage();
globalThis.sessionStorage = createStorage();

const target = new EventTarget();
globalThis.document = {
  readyState: 'complete',
  addEventListener: (...a) => target.addEventListener(...a),
  removeEventListener: (...a) => target.removeEventListener(...a),
  dispatchEvent: (e) => target.dispatchEvent(e),
};

/* location のシム。replace() は遷移せず記録するだけ。 */
const redirects = [];
globalThis.location = {
  href: 'https://tsam-ai.com/apps/home/',
  pathname: '/apps/home/',
  search: '',
  replace(url) { redirects.push(url); },
};

/* console.warn を静める（ダミー警告は仕様どおりなので出て当然）。 */
const warnings = [];
const realWarn = console.warn;
console.warn = (...a) => { warnings.push(a.join(' ')); };

const auth = await import(url('auth.js'));
const session = await import(url('session.js'));

section("1. 初期状態");
check('未ログイン', auth.isAuthenticated() === false);
check('getCurrentUser は null', auth.getCurrentUser() === null);
check('ダミープロバイダ', auth.isUsingDummyProvider() === true);
check('プロバイダID', auth.getAuthProviderId() === 'dummy');
check('ストレージ利用可', auth.isStorageAvailable() === true);

section("2. 入力検証（ダミーでも形式は見る）");

async function expectFail(name, id, pw, code) {
  try {
    await auth.login(id, pw);
    check(name, false, '例外が発生しなかった');
  } catch (error) {
    check(name, error?.name === 'AuthError' && error.code === code,
      `${error?.name}/${error?.code}`);
    check(`${name} - 日本語メッセージがある`, typeof error?.userMessage === 'string' && error.userMessage.length > 0);
  }
}

await expectFail('空ID', '', 'password123', 'INVALID_INPUT');
await expectFail('空パスワード', 'taro@example.com', '', 'INVALID_INPUT');
await expectFail('短いパスワード', 'taro@example.com', 'abc', 'INVALID_INPUT');
await expectFail('長すぎるID', 'a'.repeat(200), 'password123', 'INVALID_INPUT');
check('失敗してもログインしていない', auth.isAuthenticated() === false);

section("3. ログイン");
const sessionEvents = [];
globalThis.document.addEventListener('tsam-session-change', (e) => sessionEvents.push(e.detail));

const loginResult = await auth.login('  taro@example.com  ', 'password123');
const user = loginResult.user;
check('status=signed-in を返す', loginResult.status === 'signed-in');
check('ログイン成功', auth.isAuthenticated() === true);
check('前後空白を除去', user.loginId === 'taro@example.com');
check('表示名はローカル部', user.displayName === 'taro', user.displayName);
check('userId に接頭辞', user.userId === 'dummy:taro@example.com', user.userId);
check('provider が記録される', user.provider === 'dummy');
check('有効期限がある', typeof user.expiresAt === 'number' && user.expiresAt > Date.now());
check('tsam-session-change が発行される', sessionEvents.length === 1);

section("4. パスワードがどこにも残らない");
const dump = JSON.stringify({
  local: globalThis.localStorage.dump(),
  session: globalThis.sessionStorage.dump(),
});
check('ストレージにパスワードが無い', !dump.includes('password123'), dump);
check('セッションにパスワード欄が無い',
  !Object.keys(JSON.parse(globalThis.localStorage.getItem('tsam-ai-session'))).includes('password'));
check('警告ログにパスワードが無い', !warnings.join(' ').includes('password123'));
check('getCurrentUser にパスワードが無い',
  !JSON.stringify(auth.getCurrentUser()).includes('password123'));
console.log(`  保存キー: ${Object.keys(globalThis.localStorage.dump()).join(', ')}`);
console.log(`  保存内容: ${globalThis.localStorage.getItem('tsam-ai-session')}`);

section("5. セッションの期限");
const stored = JSON.parse(globalThis.localStorage.getItem('tsam-ai-session'));
check('12時間の期限', Math.round((stored.expiresAt - stored.issuedAt) / 3600000) === 12,
  String((stored.expiresAt - stored.issuedAt) / 3600000));

globalThis.localStorage.setItem('tsam-ai-session', JSON.stringify({
  ...stored, expiresAt: Date.now() - 1000,
}));
check('期限切れは未ログイン扱い', auth.isAuthenticated() === false);
check('期限切れは自動削除される', globalThis.localStorage.getItem('tsam-ai-session') === null);

await auth.login('taro@example.com', 'password123');
globalThis.localStorage.setItem('tsam-ai-session', '{壊れたJSON');
check('壊れたセッションは未ログイン扱い', auth.isAuthenticated() === false);
check('壊れたセッションは自動削除', globalThis.localStorage.getItem('tsam-ai-session') === null);

await auth.login('taro@example.com', 'password123');
const v = JSON.parse(globalThis.localStorage.getItem('tsam-ai-session'));
globalThis.localStorage.setItem('tsam-ai-session', JSON.stringify({ ...v, v: 99 }));
check('バージョン違いも破棄', auth.isAuthenticated() === false);

section("6. refreshSession");
check('未ログインでは復活しない', (await auth.refreshSession()) === null);

await auth.login('taro@example.com', 'password123');
const before = JSON.parse(globalThis.localStorage.getItem('tsam-ai-session')).expiresAt;
await new Promise((r) => setTimeout(r, 5));
const refreshed = await auth.refreshSession();
const after = JSON.parse(globalThis.localStorage.getItem('tsam-ai-session')).expiresAt;
check('期限が延びる', after > before, `${before} -> ${after}`);
check('利用者情報が保たれる', refreshed.userId === 'dummy:taro@example.com');

section("7. ログアウト");
await auth.logout();
check('未ログインになる', auth.isAuthenticated() === false);
check('ストレージから消える', globalThis.localStorage.getItem('tsam-ai-session') === null);
check('getCurrentUser が null', auth.getCurrentUser() === null);

section("8. safeNextUrl（オープンリダイレクト対策）");
const cases = [
  ['../home/', '../home/', '相対パスは通す'],
  ['home/', 'home/', '相対パスは通す2'],
  ['./x?a=1', './x?a=1', 'クエリ付き相対'],
  ['https://evil.example.com/', null, '絶対URLを拒否'],
  ['//evil.example.com/', null, 'プロトコル相対を拒否'],
  ['javascript:alert(1)', null, 'javascript: を拒否'],
  ['JaVaScRiPt:alert(1)', null, '大文字混じりも拒否'],
  ['java\nscript:alert(1)', null, '制御文字による難読化も拒否'],
  ['data:text/html,x', null, 'data: を拒否'],
  ['/apps/home/', null, 'サイト内絶対パスも拒否（サブパス配信対策）'],
  ['', null, '空文字'],
  ['a'.repeat(600), null, '長すぎる値'],
  [null, null, 'null'],
];

cases.forEach(([input, expected, label]) => {
  check(label, auth.safeNextUrl(input) === expected,
    `${JSON.stringify(input)} -> ${JSON.stringify(auth.safeNextUrl(input))}`);
});
check('fallback が返る', auth.safeNextUrl('https://evil.example.com/', '../home/') === '../home/');

section("9. requireAuth / redirectIfAuthenticated");
redirects.length = 0;
check('未ログインの requireAuth は false', auth.requireAuth({ loginUrl: '../login/' }) === false);
check('ログイン画面へ送られる', redirects.length === 1 && redirects[0].includes('/apps/login/'), redirects[0]);
check('next に戻り先が入る', redirects[0].includes('next=..%2Fhome%2F'), redirects[0]);
check('next は外部を指さない', !redirects[0].includes('evil'));

redirects.length = 0;
check('未ログインの redirectIfAuthenticated は true',
  auth.redirectIfAuthenticated({ homeUrl: '../home/' }) === true);
check('遷移していない', redirects.length === 0);

await auth.login('taro@example.com', 'password123');
redirects.length = 0;
check('ログイン済みの requireAuth は true', auth.requireAuth({ loginUrl: '../login/' }) === true);
check('遷移していない', redirects.length === 0);

check('ログイン済みの redirectIfAuthenticated は false',
  auth.redirectIfAuthenticated({ homeUrl: '../home/' }) === false);
check('ホームへ送られる', redirects.length === 1 && redirects[0].endsWith('/apps/home/'), redirects[0]);

redirects.length = 0;
auth.redirectIfAuthenticated({ homeUrl: '../home/', next: 'https://evil.example.com/' });
check('外部の next は無視してホームへ',
  redirects[0].endsWith('/apps/home/') && !redirects[0].includes('evil'), redirects[0]);

section("10. プロバイダ差し替え");
const fakeProvider = {
  PROVIDER_ID: 'fake',
  INPUT_RULES: { loginIdMaxLength: 64, passwordMinLength: 4, passwordMaxLength: 100 },
  calls: [],
  async signIn({ loginId, password }) {
    this.calls.push('signIn');
    if (password !== 'correct-horse') {
      return { ok: false, code: 'INVALID_CREDENTIALS' };
    }
    return { ok: true, user: { userId: 'srv-42', displayName: '花子', loginId } };
  },
  async signOut() { this.calls.push('signOut'); },
  async refresh(s) { return { ok: true, user: { userId: s.userId, displayName: '花子', loginId: s.loginId } }; },
};

await auth.logout();
auth.setAuthProvider(fakeProvider);
check('プロバイダが切り替わる', auth.getAuthProviderId() === 'fake');
check('ダミー判定が false', auth.isUsingDummyProvider() === false);
check('入力規則もプロバイダ由来', auth.getInputRules().passwordMinLength === 4);

let credErr = null;
try {
  await auth.login('hanako', 'wrong-password');
} catch (error) { credErr = error; }
check('誤ったパスワードを拒否できる', credErr?.code === 'INVALID_CREDENTIALS');
check('既定文言が入る',
  credErr?.userMessage === 'メールアドレスまたはパスワードが正しくありません。', credErr?.userMessage);

const hanako = (await auth.login('hanako', 'correct-horse')).user;
check('サーバー払い出しIDを使う', hanako.userId === 'srv-42');
check('表示名がプロバイダ由来', hanako.displayName === '花子');
check('provider が記録される', hanako.provider === 'fake');

await auth.logout();
check('signOut が呼ばれる', fakeProvider.calls.includes('signOut'));
check('差し替え後もセッションは共通', globalThis.localStorage.getItem('tsam-ai-session') === null);

check('不正なプロバイダを拒否', (() => {
  try { auth.setAuthProvider({}); return false; } catch { return true; }
})());

section("11. bootstrap の統合");
auth.setAuthProvider((await import(url('auth-providers/dummy.js'))));
await auth.login('taro@example.com', 'password123');

const readyEvents = [];
globalThis.document.addEventListener('tsam-shared-ready', (e) => readyEvents.push(e.detail));
const shared = await import(url('bootstrap.js'));

check('tsam-shared-ready が発行される', readyEvents.length === 1);
check('版が phase2', shared.SHARED_VERSION === '2.0.0-phase2');
check('auth 状態が含まれる', readyEvents[0].auth?.authenticated === true);
check('user が含まれる', readyEvents[0].auth?.user?.displayName === 'taro');
check('Googleログインとは別物', readyEvents[0].signedIn === false);
check('Phase1 の profile / ai も維持', 'profile' in readyEvents[0] && 'ai' in readyEvents[0]);
check('bootstrap から auth 名前空間', typeof shared.auth?.login === 'function');
check('bootstrap から session 名前空間', typeof shared.session?.readSession === 'function');
check('bootstrap から requireAuth', typeof shared.requireAuth === 'function');
check('bootstrap 経由でも同じ状態', shared.isAuthenticated() === true);
check('context にパスワードが無い', !JSON.stringify(readyEvents[0]).includes('password123'));

section("12. Google連携（Phase1資産）に影響しないこと");
check('Drive 認可は未実行', shared.driveAuth.hasValidAccessToken() === false);
check('プロフィールキャッシュは空', shared.readCachedProfile() === null);
check('AI設定は既定のまま', shared.getAiMode() === 'free');
check('GISは読み込まれていない', typeof globalThis.google === 'undefined');

console.console = realWarn;
finish();

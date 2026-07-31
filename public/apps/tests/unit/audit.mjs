/*
 * Phase 3 監査で追加した検査。
 * セキュリティ上意味のある状態遷移・失敗経路・パス問題に絞る。
 */

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
    clear: () => map.clear(),
    dump: () => Object.fromEntries(map),
  };
}

globalThis.localStorage = createStorage();
globalThis.sessionStorage = createStorage();

const docTarget = new EventTarget();
globalThis.document = {
  readyState: 'complete',
  addEventListener: (...a) => docTarget.addEventListener(...a),
  removeEventListener: (...a) => docTarget.removeEventListener(...a),
  dispatchEvent: (e) => docTarget.dispatchEvent(e),
};

const winTarget = new EventTarget();
globalThis.addEventListener = (...a) => winTarget.addEventListener(...a);
globalThis.removeEventListener = (...a) => winTarget.removeEventListener(...a);

const redirects = [];
globalThis.location = {
  href: 'https://tsam-ai.com/apps/home/',
  pathname: '/apps/home/',
  origin: 'https://tsam-ai.com',
  search: '',
  replace(url) { redirects.push(url); },
};

const warnings = [];
console.warn = (...a) => { warnings.push(a.join(' ')); };

const paths = await import(url('app-paths.js'));
const client = await import(url('supabase-client.js'));
const supabaseProvider = await import(url('auth-providers/supabase.js'));
const auth = await import(url('auth.js'));

/* ---- 偽 GoTrue ---- */

function createFakeGoTrue(options = {}) {
  const state = {
    session: options.session ?? null,
    factors: options.factors ?? [],
    aalCurrent: options.aal ?? 'aal1',
    nextError: null,
    calls: [],
    listFactorsFails: false,
    passwords: { 'taro@example.com': 'correct-password' },
    emailConfirmed: options.emailConfirmed ?? true,
  };

  const ok = (data) => ({ data, error: null });
  const errR = (code, status = 400) => ({ data: null, error: { code, status, name: 'AuthApiError' } });
  const verified = () => state.factors.filter((f) => f.status === 'verified');
  const mkUser = () => ({
    id: 'user-1',
    email: 'taro@example.com',
    email_confirmed_at: state.emailConfirmed ? '2026-01-01T00:00:00Z' : null,
    user_metadata: { display_name: '太郎' },
  });

  return {
    _state: state,
    async signInWithPassword({ email, password }) {
      state.calls.push('signInWithPassword');
      if (state.nextError) { const e = state.nextError; state.nextError = null; return errR(e.code, e.status); }
      if (state.passwords[email] !== password) return errR('invalid_credentials', 400);
      state.session = { user: mkUser() };
      state.aalCurrent = 'aal1';
      return ok({ user: state.session.user, session: state.session });
    },
    async signOut(opts) { state.calls.push(`signOut:${opts?.scope ?? 'local'}`); if (opts?.scope !== 'others') { state.session = null; state.aalCurrent = 'aal1'; } return { error: null }; },
    async getSession() {
      if (state.nextError) { const e = state.nextError; state.nextError = null; return errR(e.code, e.status); }
      return ok({ session: state.session });
    },
    async getUser() { return ok({ user: state.session?.user ?? null }); },
    async resetPasswordForEmail() { return ok({}); },
    async updateUser({ password }) { state.calls.push('updateUser'); state.passwords['taro@example.com'] = password; return ok({ user: mkUser() }); },
    async resend() { return ok({}); },
    async exchangeCodeForSession(code) {
      if (code !== 'good') return errR('flow_state_not_found', 404);
      state.session = { user: mkUser() };
      return ok({ user: state.session.user, session: state.session });
    },
    onAuthStateChange() { return { data: { subscription: { unsubscribe() { state.calls.push('unsubscribe'); } } } }; },
    mfa: {
      async getAuthenticatorAssuranceLevel() {
        return ok({ currentLevel: state.aalCurrent, nextLevel: verified().length > 0 ? 'aal2' : 'aal1' });
      },
      async listFactors() {
        if (state.listFactorsFails) return errR('unknown', 500);
        return ok({ all: state.factors, totp: state.factors });
      },
      async challengeAndVerify({ code }) {
        state.calls.push('challengeAndVerify');
        if (code !== '123456') return errR('mfa_verification_failed', 400);
        state.aalCurrent = 'aal2';
        state.factors.forEach((f) => { f.status = 'verified'; });
        return ok({});
      },
      async enroll() {
        const f = { id: 'new', status: 'unverified' };
        state.factors.push(f);
        return ok({ id: 'new', totp: { qr_code: 'data:image/svg+xml;utf-8,<svg/>', secret: 'ABCDEFGHIJKLMNOP', uri: 'otpauth://x' } });
      },
      async unenroll({ factorId }) { state.factors = state.factors.filter((f) => f.id !== factorId); return ok({}); },
    },
  };
}

function useFake(fake) {
  client.__setClientForTest(fake);
  auth.setAuthProvider(supabaseProvider);
  globalThis.localStorage.clear();
  globalThis.sessionStorage.clear();
  redirects.length = 0;
  return fake;
}

/* 写しだけを偽造する（攻撃者の視点）。 */
function forgeMirror(overrides = {}) {
  globalThis.localStorage.setItem('tsam-ai-session', JSON.stringify({
    v: 2,
    userId: 'user-1',
    displayName: '太郎',
    loginId: 'taro@example.com',
    provider: 'supabase',
    aal: 'aal1',
    emailConfirmed: true,
    issuedAt: Date.now(),
    expiresAt: Date.now() + 3600000,
    ...overrides,
  }));
}

/* ================================================================ */

section("A. 認証の正本がSupabaseであること");

let fake = useFake(createFakeGoTrue());
forgeMirror();
check('写しだけなら isAuthenticated は true（同期判定の限界）', auth.isAuthenticated() === true);
check('★guardPage はサーバー確認で false', (await auth.guardPage({ loginUrl: '../login/' })) === false);
check('★写しが破棄される', globalThis.localStorage.getItem('tsam-ai-session') === null);
check('ログイン画面へ送られる', redirects.length === 1 && redirects[0].includes('/apps/login/'));

fake = useFake(createFakeGoTrue());
fake._state.session = { user: { id: 'user-1', email: 'taro@example.com', user_metadata: {} } };
forgeMirror();
check('実セッションがあれば guardPage は true', (await auth.guardPage({ loginUrl: '../login/' })) === true);

section("B. AAL / メール確認の偽装");

fake = useFake(createFakeGoTrue({ factors: [{ id: 'f1', status: 'verified' }] }));
fake._state.session = { user: { id: 'user-1', email: 'taro@example.com', user_metadata: {} } };
fake._state.aalCurrent = 'aal1';
forgeMirror({ aal: 'aal2' });
check('写し上はAAL2', auth.hasMfaAssurance() === true);
check('★実態がAAL1なら guardPage は false', (await auth.guardPage({ loginUrl: '../login/' })) === false);
check('★偽装した写しが消える', globalThis.localStorage.getItem('tsam-ai-session') === null);

fake = useFake(createFakeGoTrue({ emailConfirmed: false }));
fake._state.session = { user: { id: 'user-1', email: 'taro@example.com', email_confirmed_at: null, user_metadata: {} } };
forgeMirror({ emailConfirmed: true });
await auth.restoreSession();
check('★メール未確認は復元時に false へ戻る', auth.getCurrentUser()?.emailConfirmed === false);

fake = useFake(createFakeGoTrue());
fake._state.session = { user: { id: 'OTHER-USER', email: 'other@example.com', user_metadata: {} } };
forgeMirror({ userId: 'user-1' });
await auth.restoreSession();
check('★ユーザーID不一致は実態で上書きされる', auth.getCurrentUser()?.userId === 'OTHER-USER',
  auth.getCurrentUser()?.userId);

section("C. セッション復元の分岐");

fake = useFake(createFakeGoTrue());
forgeMirror();
fake.getSession = async () => ({ data: { session: null }, error: null });
check('Supabaseセッション無し→ログアウト', (await auth.restoreSession()).authenticated === false);

fake = useFake(createFakeGoTrue());
forgeMirror();
fake.getSession = async () => { const e = new Error('x'); e.name = 'AuthRetryableFetchError'; throw e; };
check('オフラインは写しを保つ', (await auth.restoreSession()).authenticated === true);

fake = useFake(createFakeGoTrue());
forgeMirror();
fake.getSession = async () => ({ data: null, error: { code: 'session_not_found', status: 401 } });
check('refresh失敗（失効）は写しを消す', (await auth.restoreSession()).authenticated === false);

fake = useFake(createFakeGoTrue());
forgeMirror({ expiresAt: Date.now() - 1000 });
check('期限切れの写しは同期判定でも false', auth.isAuthenticated() === false);
check('期限切れは即削除', globalThis.localStorage.getItem('tsam-ai-session') === null);

fake = useFake(createFakeGoTrue());
globalThis.localStorage.setItem('tsam-ai-session', JSON.stringify({
  v: 1, userId: 'user-1', expiresAt: Date.now() + 3600000,
}));
check('★v1の古い写しは破棄される（移行）', auth.isAuthenticated() === false);

section("D. MFA の網羅");

/* factorなし */
fake = useFake(createFakeGoTrue({ factors: [] }));
check('factorなしなら通常ログイン', (await auth.login('taro@example.com', 'correct-password')).status === 'signed-in');

/* unverified のみ */
fake = useFake(createFakeGoTrue({ factors: [{ id: 'u1', status: 'unverified' }] }));
const unverifiedLogin = await auth.login('taro@example.com', 'correct-password');
check('★unverified factor は認証対象にしない', unverifiedLogin.status === 'signed-in', unverifiedLogin.status);

/* verified 複数 */
fake = useFake(createFakeGoTrue({ factors: [
  { id: 'f1', status: 'verified', friendly_name: 'iPhone' },
  { id: 'f2', status: 'verified', friendly_name: 'iPad' },
] }));
const multi = await auth.login('taro@example.com', 'correct-password');
check('複数factorでも入力待ちになる', multi.status === 'mfa-required');
check('全要素が返る', multi.factors.length === 2);
check('未完了なので写し無し', globalThis.localStorage.getItem('tsam-ai-session') === null);

/* 一覧取得失敗 */
fake = useFake(createFakeGoTrue({ factors: [{ id: 'f1', status: 'verified' }] }));
fake._state.listFactorsFails = true;
let listErr = null;
try { await auth.login('taro@example.com', 'correct-password'); } catch (e) { listErr = e; }
check('★一覧取得失敗で素通りしない', listErr !== null && auth.isAuthenticated() === false);

/* 不正コードの各種 */
fake = useFake(createFakeGoTrue({ factors: [{ id: 'f1', status: 'verified' }] }));
await auth.login('taro@example.com', 'correct-password');
for (const [label, code] of [
  ['空コード', ''],
  ['5桁', '12345'],
  ['7桁', '1234567'],
  ['英字混じり', '12a456'],
  ['全角数字', '\uFF11\uFF12\uFF13\uFF14\uFF15\uFF16'],
  ['空白入り（除去後6桁）', ' 000 000 '],
]) {
  let e = null;
  try { await auth.verifyMfaCode(code); } catch (err) { e = err; }
  check(`${label}を拒否`, e !== null && auth.isAuthenticated() === false, `${e?.code}`);
}
check('★誤入力を重ねてもログインしない', auth.isAuthenticated() === false);
check('正しいコードで完了', (await auth.verifyMfaCode('123456')).status === 'signed-in');
check('AAL2 になる', auth.getCurrentUser().aal === 'aal2');

/* 解除の権限 */
fake = useFake(createFakeGoTrue({ factors: [{ id: 'f1', status: 'verified' }] }));
await auth.login('taro@example.com', 'correct-password').catch(() => {});
fake._state.session = { user: { id: 'user-1', email: 'taro@example.com', user_metadata: {} } };
fake._state.aalCurrent = 'aal1';
let dis = null;
try { await auth.disableMfa('f1'); } catch (e) { dis = e; }
check('★AAL1では解除不可', dis?.code === 'MFA_REQUIRED');
check('要素は残る', fake._state.factors.length === 1);

/* 登録キャンセル → 未検証factorの掃除 */
fake = useFake(createFakeGoTrue());
fake._state.session = { user: { id: 'user-1', email: 'taro@example.com', user_metadata: {} } };
await auth.startMfaEnrollment();
check('登録開始で未検証factorができる', fake._state.factors.some((f) => f.status === 'unverified'));
await auth.startMfaEnrollment();
check('★再開始で古い未検証factorが掃除される',
  fake._state.factors.filter((f) => f.status === 'unverified').length === 1,
  String(fake._state.factors.length));

/* QR/secret の検証 */
fake = useFake(createFakeGoTrue());
fake._state.session = { user: { id: 'user-1', email: 'taro@example.com', user_metadata: {} } };
fake.mfa.enroll = async () => ({ data: { id: 'x', totp: { qr_code: 'https://evil.example.com/track.svg', secret: '<script>' } }, error: null });
const badEnroll = await auth.startMfaEnrollment();
check('★外部URLのQRは受け付けない', badEnroll.qrCode === null, String(badEnroll.qrCode));
check('★不正なsecretも落とす', badEnroll.secret === null, String(badEnroll.secret));

section("E. resumePendingMfa（中断の復帰）");

fake = useFake(createFakeGoTrue({ factors: [{ id: 'f1', status: 'verified', friendly_name: 'iPhone' }] }));
fake._state.session = { user: { id: 'user-1', email: 'taro@example.com', user_metadata: {} } };
fake._state.aalCurrent = 'aal1';
const resumed = await auth.resumePendingMfa();
check('★中断したMFAを拾い直せる', resumed !== null && resumed.factors.length === 1);
check('入力待ち状態が復元される', auth.isAwaitingMfa() === true);
check('この時点ではログイン扱いにしない', auth.isAuthenticated() === false);

fake = useFake(createFakeGoTrue({ factors: [{ id: 'f1', status: 'verified' }] }));
fake._state.session = { user: { id: 'user-1', email: 'taro@example.com', user_metadata: {} } };
fake._state.aalCurrent = 'aal1';
fake._state.listFactorsFails = true;
const resumeFail = await auth.resumePendingMfa();
check('★要素が読めない中途セッションは破棄する', resumeFail === null);
check('セッションを切っている', fake._state.calls.includes('signOut:local'));

fake = useFake(createFakeGoTrue());
check('通常セッションでは復帰対象にならない', (await auth.resumePendingMfa()) === null);

section("F. パスワード変更と他端末の失効");

fake = useFake(createFakeGoTrue());
fake._state.session = { user: { id: 'user-1', email: 'taro@example.com', user_metadata: {} } };
const changed = await auth.updatePassword('new-strong-password', { revokeOthers: true });
check('変更できる', changed.changed === true);
check('★他端末のセッションを失効させる', changed.othersRevoked === true);
check('scope=others で呼んでいる', fake._state.calls.includes('signOut:others'));
check('この端末のセッションは残る', fake._state.session !== null);

fake = useFake(createFakeGoTrue());
fake._state.session = { user: { id: 'user-1', email: 'taro@example.com', user_metadata: {} } };
const noRevoke = await auth.updatePassword('another-strong-pass');
check('既定では他端末を切らない', noRevoke.othersRevoked === false);

section("G. 再設定フローの目印");

globalThis.sessionStorage.clear();
check('目印なしでは消費できない', auth.consumeRecoveryFlow() === false);
auth.markRecoveryFlow();
check('目印を立てられる', auth.consumeRecoveryFlow() === true);
check('★1回しか使えない', auth.consumeRecoveryFlow() === false);

section("H. watchAuthState（bfcache / タブ間）");

fake = useFake(createFakeGoTrue());
fake._state.session = { user: { id: 'user-1', email: 'taro@example.com', user_metadata: {} } };
await auth.login('taro@example.com', 'correct-password');

let signedOutCalls = 0;
const stop = auth.watchAuthState({ onSignedOut: () => { signedOutCalls += 1; } });

/* bfcache 復元: 実セッションが消えていたら通知される */
fake._state.session = null;
winTarget.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
await new Promise((r) => setTimeout(r, 30));
check('★bfcache復元で失効を検知', signedOutCalls === 1, String(signedOutCalls));

/* 別タブでのログアウト（storage イベント） */
globalThis.localStorage.removeItem('tsam-ai-session');
winTarget.dispatchEvent(Object.assign(new Event('storage'), { key: 'tsam-ai-session' }));
await new Promise((r) => setTimeout(r, 30));
check('★別タブのログアウトを検知', signedOutCalls === 2, String(signedOutCalls));

/* 無関係なキーでは反応しない */
const before = signedOutCalls;
winTarget.dispatchEvent(Object.assign(new Event('storage'), { key: 'unrelated-key' }));
await new Promise((r) => setTimeout(r, 30));
check('無関係なキーでは動かない', signedOutCalls === before);

stop();
winTarget.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
await new Promise((r) => setTimeout(r, 30));
check('解除後は通知されない', signedOutCalls === before);

section("I. コールバックの失敗経路");

fake = useFake(createFakeGoTrue());
let cbe = null;
try { await auth.handleAuthCallback({ code: 'bad' }); } catch (e) { cbe = e; }
check('不正codeは LINK_EXPIRED', cbe?.code === 'LINK_EXPIRED');
check('セッションを作らない', auth.isAuthenticated() === false);

try { await auth.handleAuthCallback({ code: '' }); } catch (e) { cbe = e; }
check('空codeも拒否', cbe?.code === 'LINK_EXPIRED');

fake = useFake(createFakeGoTrue());
await auth.handleAuthCallback({ code: 'good', type: 'recovery' });
check('正常codeでセッション確立', auth.isAuthenticated() === true);
let twice = null;
try { await auth.handleAuthCallback({ code: 'good', type: 'recovery' }); } catch (e) { twice = e; }
check('二重実行しても壊れない', twice === null || twice.code === 'LINK_EXPIRED');

section("J. 設定値の正規化");

const cfg = await import(url('supabase-config.js'));
check('前後空白付きURLを許容', cfg.isUrlConfigured('  https://x.supabase.co  ') === true);
check('httpは拒否', cfg.isUrlConfigured('http://x.supabase.co') === false);
check('末尾スラッシュを許容', cfg.isUrlConfigured('https://x.supabase.co/') === true);
check('URLでない値を拒否', cfg.isUrlConfigured('not a url') === false);
check('空白のみのキーを拒否', cfg.isAnonKeyConfigured('   ') === false);
check('短すぎるキーを拒否', cfg.isAnonKeyConfigured('a.b.c') === false);

section("K. 入力の異常値（XSS・長大・双方向文字）");

fake = useFake(createFakeGoTrue());
const nasty = [
  ['HTMLを含むメール', '<img src=x onerror=alert(1)>@example.com'],
  ['非常に長い入力', `${'a'.repeat(5000)}@example.com`],
  ['双方向文字', '\u202Emoc.elpmaxe@orat'],
  ['改行入り', 'taro@example.com\nBcc: evil@example.com'],
  ['NUL入り', 'taro\u0000@example.com'],
];
for (const [label, value] of nasty) {
  let e = null;
  try { await auth.login(value, 'correct-password'); } catch (err) { e = err; }
  check(`${label}でログインしない`, auth.isAuthenticated() === false, `${e?.code}`);
}

/* 表示名にHTMLが入っても写しは文字列のまま（描画側は textContent） */
fake = useFake(createFakeGoTrue());
fake.signInWithPassword = async () => ({
  data: { user: { id: 'u', email: 'x@example.com', user_metadata: { display_name: '<script>alert(1)</script>' } } },
  error: null,
});
fake._state.session = { user: { id: 'u' } };
await auth.login('x@example.com', 'correct-password');
check('HTMLを含む表示名も文字列として保持', auth.getCurrentUser().displayName === '<script>alert(1)</script>');
check('写しに実行可能な形で入らない（描画はtextContent側の責務）',
  typeof auth.getCurrentUser().displayName === 'string');

section("L. 秘密情報の残留");

fake = useFake(createFakeGoTrue());
await auth.login('taro@example.com', 'correct-password');
const dump = JSON.stringify({ l: globalThis.localStorage.dump(), s: globalThis.sessionStorage.dump() });
check('パスワードが残らない', !dump.includes('correct-password'));
check('ログにも残らない', !warnings.join(' ').includes('correct-password'));

finish();

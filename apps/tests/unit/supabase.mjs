/*
 * Phase 3: Supabase 認証プロバイダの検証。
 * 偽の GoTrueClient を注入し、ネットワークなしで全経路を通す。
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

const target = new EventTarget();
globalThis.document = {
  readyState: 'complete',
  addEventListener: (...a) => target.addEventListener(...a),
  removeEventListener: (...a) => target.removeEventListener(...a),
  dispatchEvent: (e) => target.dispatchEvent(e),
};

const redirects = [];
globalThis.location = {
  href: 'https://tsam-ai.com/apps/login/',
  pathname: '/apps/login/',
  origin: 'https://tsam-ai.com',
  search: '',
  replace(url) { redirects.push(url); },
};

const warnings = [];
console.warn = (...a) => { warnings.push(a.join(' ')); };

const config = await import(url('supabase-config.js'));
const client = await import(url('supabase-client.js'));
const supabaseProvider = await import(url('auth-providers/supabase.js'));
const auth = await import(url('auth.js'));

/* ================= 偽の GoTrue クライアント ================= */

function createFakeGoTrue(options = {}) {
  const state = {
    session: null,
    factors: options.factors ?? [],   // [{id, status, friendly_name}]
    aalCurrent: 'aal1',
    nextError: null,
    calls: [],
    passwords: options.passwords ?? { 'taro@example.com': 'correct-password' },
  };

  const ok = (data) => ({ data, error: null });
  const err = (code, status = 400) => ({ data: null, error: { code, status, name: 'AuthApiError' } });

  const verifiedFactors = () => state.factors.filter((f) => f.status === 'verified');

  const api = {
    _state: state,

    async signInWithPassword({ email, password }) {
      state.calls.push('signInWithPassword');
      if (state.nextError) { const e = state.nextError; state.nextError = null; return err(e.code, e.status); }
      if (state.passwords[email] !== password) return err('invalid_credentials', 400);

      state.session = { user: { id: 'user-1', email, email_confirmed_at: '2026-01-01T00:00:00Z', user_metadata: { display_name: '太郎' } } };
      state.aalCurrent = 'aal1';
      return ok({ user: state.session.user, session: state.session });
    },

    async signOut() { state.calls.push('signOut'); state.session = null; state.aalCurrent = 'aal1'; return { error: null }; },

    async getSession() {
      if (state.nextError) { const e = state.nextError; state.nextError = null; return err(e.code, e.status); }
      return ok({ session: state.session });
    },

    async getUser() { return ok({ user: state.session?.user ?? null }); },

    async resetPasswordForEmail(email) {
      state.calls.push(`resetPasswordForEmail:${email}`);
      if (state.nextError) { const e = state.nextError; state.nextError = null; return err(e.code, e.status); }
      return ok({});
    },

    async updateUser({ password }) {
      state.calls.push('updateUser');
      if (state.nextError) { const e = state.nextError; state.nextError = null; return err(e.code, e.status); }
      if (!state.session) return err('session_not_found', 401);
      state.passwords[state.session.user.email] = password;
      return ok({ user: state.session.user });
    },

    async resend({ email }) { state.calls.push(`resend:${email}`); return ok({}); },

    async exchangeCodeForSession(code) {
      state.calls.push('exchangeCodeForSession');
      if (code !== 'good-code') return err('flow_state_not_found', 404);
      state.session = { user: { id: 'user-1', email: 'taro@example.com', email_confirmed_at: '2026-01-01T00:00:00Z', user_metadata: {} } };
      return ok({ user: state.session.user, session: state.session });
    },

    onAuthStateChange() { return { data: { subscription: { unsubscribe() {} } } }; },

    mfa: {
      async getAuthenticatorAssuranceLevel() {
        const has = verifiedFactors().length > 0;
        return ok({ currentLevel: state.aalCurrent, nextLevel: has ? 'aal2' : 'aal1' });
      },
      async listFactors() {
        if (state.nextError) { const e = state.nextError; state.nextError = null; return err(e.code, e.status); }
        return ok({ all: state.factors, totp: state.factors });
      },
      async challengeAndVerify({ code }) {
        state.calls.push('challengeAndVerify');
        if (code !== '123456') return err('mfa_verification_failed', 400);
        state.aalCurrent = 'aal2';
        state.factors.forEach((f) => { f.status = 'verified'; });
        return ok({ access_token: 'x' });
      },
      async enroll({ friendlyName }) {
        state.calls.push('enroll');
        const factor = { id: 'factor-new', status: 'unverified', friendly_name: friendlyName };
        state.factors.push(factor);
        return ok({ id: factor.id, totp: { qr_code: 'data:image/svg+xml;utf-8,<svg/>', secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', uri: 'otpauth://totp/x' } });
      },
      async unenroll({ factorId }) {
        state.calls.push(`unenroll:${factorId}`);
        state.factors = state.factors.filter((f) => f.id !== factorId);
        return ok({});
      },
    },
  };

  return api;
}

function useFake(fake) {
  client.__setClientForTest(fake);
  auth.setAuthProvider(supabaseProvider);
  globalThis.localStorage.clear();
  return fake;
}

/* ================= 検証 ================= */

section("1. 設定の検証");
check('プレースホルダーは未設定扱い', config.isSupabaseConfigured() === false);
check('URL未設定を検出', config.isUrlConfigured() === false);
check('httpsのみ許可', config.isUrlConfigured('http://x.supabase.co') === false);
check('https URLは通る', config.isUrlConfigured('https://x.supabase.co') === true);
check('anon key 未設定を検出', config.isAnonKeyConfigured() === false);
check('JWT形式のanon keyは通る',
  config.isAnonKeyConfigured('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiJ9.signaturesignature') === true);
check('新形式(sb_publishable_)も通る',
  config.isAnonKeyConfigured('sb_publishable_abcdefghijklmnop') === true);

/* service_role キーの検出（role: service_role を含むJWT） */
const svcPayload = Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url');
const svcKey = `eyJhbGciOiJIUzI1NiJ9.${svcPayload}.sig`;
check('service_role キーを検出する', config.looksLikeServiceRoleKey(svcKey) === true);
check('sb_secret_ も検出する', config.looksLikeServiceRoleKey('sb_secret_abcdefghijklmnop') === true);
const anonPayload = Buffer.from(JSON.stringify({ role: 'anon' })).toString('base64url');
check('anon キーは誤検出しない',
  config.looksLikeServiceRoleKey(`eyJhbGciOiJIUzI1NiJ9.${anonPayload}.sig`) === false);
check('未設定の理由が説明される', typeof config.describeConfig().reason === 'string');

/*
 * 利用者向けの文言に、内部のファイル構成を出さない。
 *
 * reason は login / account / password-reset の3画面が
 * `（${status.reason}）` の形でそのまま表示する。
 * ここに設定ファイルのパスが入ると、自分では直せない内部情報を
 * 一般の利用者へ見せることになる。
 */
section("1-b. 未設定時の文言に内部情報を出さない");
const desc = config.describeConfig();

check('★内部パスを出さない', !desc.reason.includes('supabase-config.js'), desc.reason);
check('★.js のファイル名を出さない', !/\.js\b/.test(desc.reason), desc.reason);
check('★ディレクトリ表記を出さない', !desc.reason.includes('apps/'), desc.reason);
check('★準備中と伝える', desc.reason === 'ログイン機能は現在準備中です。', desc.reason);
check('技術用語を出さない',
  !/Supabase|anon|service_role|Project URL/.test(desc.reason), desc.reason);

/* 開発者向けの詳細は残す。ただし画面へは出さない側に置く。 */
check('detail に原因が残る', typeof desc.detail === 'string' && desc.detail.length > 0, String(desc.detail));
check('detail と reason は別物', desc.detail !== desc.reason);

/* 戻り値の形を固定する。detail を足し忘れると開発者が原因を追えない。 */
check('reason / detail / configured が揃う',
  ['configured', 'reason', 'detail'].every((k) => k in desc), Object.keys(desc).join(','));

/* getProviderStatus 経由でも漏れないこと（画面が実際に読む経路）。 */
const statusFresh = await import(`${url('auth.js')}?leak=1`);
const st = statusFresh.getProviderStatus();
check('★getProviderStatus でも内部パスなし',
  !String(st.reason).includes('supabase-config.js'), String(st.reason));
check('★getProviderStatus は準備中を返す',
  st.reason === 'ログイン機能は現在準備中です。', String(st.reason));
check('★getProviderStatus は detail を渡さない',
  st.detail === undefined, String(st.detail));

section("2. 未設定時はダミーのまま");
const fresh = await import(`${url('auth.js')}?fresh=1`);
check('自動選択はダミー', fresh.isUsingDummyProvider() === true);
check('MFA非対応', fresh.getCapabilities().mfa === false);
check('パスワード再設定も非対応', fresh.getCapabilities().passwordReset === false);
let notSupported = null;
try { await fresh.requestPasswordReset('x@example.com'); } catch (e) { notSupported = e; }
check('未対応機能は NOT_SUPPORTED', notSupported?.code === 'NOT_SUPPORTED');
check('SDKを読み込んでいない', warnings.every((w) => !w.includes('vendor')));

section("3. ログイン（二段階認証なし）");
let fake = useFake(createFakeGoTrue());
check('Supabaseプロバイダに切替', auth.getAuthProviderId() === 'supabase');
check('MFA対応', auth.getCapabilities().mfa === true);

const r1 = await auth.login('taro@example.com', 'correct-password');
check('status=signed-in', r1.status === 'signed-in', r1.status);
check('ログイン済み', auth.isAuthenticated() === true);
check('表示名はメタデータ由来', auth.getCurrentUser().displayName === '太郎');
check('メール確認済みが写しに入る', auth.getCurrentUser().emailConfirmed === true);
check('aal1', auth.getCurrentUser().aal === 'aal1');
check('写しにパスワードが無い',
  !JSON.stringify(globalThis.localStorage.dump()).includes('correct-password'));

section("4. ログイン失敗（アカウント列挙の防止）");
useFake(createFakeGoTrue());
let e1 = null;
try { await auth.login('taro@example.com', 'wrong'); } catch (e) { e1 = e; }
let e2 = null;
try { await auth.login('nobody@example.com', 'whatever'); } catch (e) { e2 = e; }
check('誤パスワードは INVALID_CREDENTIALS', e1?.code === 'INVALID_CREDENTIALS');
check('未登録も同じコード', e2?.code === 'INVALID_CREDENTIALS');
check('文言も同一（存在を漏らさない）', e1.userMessage === e2.userMessage, e1.userMessage);
check('失敗後はログインしていない', auth.isAuthenticated() === false);

section("5. エラー写像");
const cases = [
  ['email_not_confirmed', 400, 'EMAIL_NOT_CONFIRMED'],
  ['over_request_rate_limit', 429, 'RATE_LIMITED'],
  ['weak_password', 422, 'WEAK_PASSWORD'],
  ['validation_failed', 422, 'INVALID_INPUT'],
  ['otp_expired', 401, 'LINK_EXPIRED'],
];
for (const [code, status, expected] of cases) {
  fake = useFake(createFakeGoTrue());
  fake._state.nextError = { code, status };
  let err = null;
  try { await auth.login('taro@example.com', 'correct-password'); } catch (e) { err = e; }
  check(`${code} -> ${expected}`, err?.code === expected, err?.code);
  check(`${code} は日本語文言を持つ`, /[ぁ-んァ-ン一-龠]/.test(err?.userMessage ?? ''));
}

section("6. 二段階認証つきログイン");
fake = useFake(createFakeGoTrue({ factors: [{ id: 'f1', status: 'verified', friendly_name: 'iPhone' }] }));

const r2 = await auth.login('taro@example.com', 'correct-password');
check('status=mfa-required', r2.status === 'mfa-required', r2.status);
check('要素一覧が返る', r2.factors.length === 1 && r2.factors[0].friendlyName === 'iPhone');
check('★コード入力前はログイン扱いにしない', auth.isAuthenticated() === false);
check('★写しが作られていない', globalThis.localStorage.getItem('tsam-ai-session') === null);
check('入力待ち状態', auth.isAwaitingMfa() === true);

let mfaErr = null;
try { await auth.verifyMfaCode('000000'); } catch (e) { mfaErr = e; }
check('誤コードは MFA_INVALID_CODE', mfaErr?.code === 'MFA_INVALID_CODE');
check('誤コード後もログインしていない', auth.isAuthenticated() === false);

const r3 = await auth.verifyMfaCode('123456');
check('正しいコードでログイン完了', r3.status === 'signed-in' && auth.isAuthenticated() === true);
check('aal2 になる', auth.getCurrentUser().aal === 'aal2');
check('hasMfaAssurance', auth.hasMfaAssurance() === true);
check('入力待ちが解除される', auth.isAwaitingMfa() === false);

section("7. 二段階認証の一覧が取れないときは通さない");
fake = useFake(createFakeGoTrue({ factors: [{ id: 'f1', status: 'verified' }] }));
const origList = fake.mfa.listFactors;
fake.mfa.listFactors = async () => ({ data: null, error: { code: 'unknown', status: 500 } });
let guardErr = null;
try { await auth.login('taro@example.com', 'correct-password'); } catch (e) { guardErr = e; }
check('★素通りさせず失敗にする', guardErr !== null && auth.isAuthenticated() === false, String(guardErr?.code));
check('セッションを破棄している', fake._state.calls.includes('signOut'));
fake.mfa.listFactors = origList;

section("8. セッション復元");
fake = useFake(createFakeGoTrue());
await auth.login('taro@example.com', 'correct-password');
const restored = await auth.restoreSession();
check('復元できる', restored.authenticated === true);

fake._state.session = null;
const gone = await auth.restoreSession();
check('サーバー側で失効していたら写しも消す', gone.authenticated === false);
check('写しが消えている', globalThis.localStorage.getItem('tsam-ai-session') === null);

/* 二段階認証を終えていないセッションは復元でも通さない */
fake = useFake(createFakeGoTrue({ factors: [{ id: 'f1', status: 'verified' }] }));
await auth.login('taro@example.com', 'correct-password').catch(() => {});
fake._state.session = { user: { id: 'user-1', email: 'taro@example.com', user_metadata: {} } };
fake._state.aalCurrent = 'aal1';
globalThis.localStorage.setItem('tsam-ai-session', JSON.stringify({
  v: 2, userId: 'user-1', displayName: '太郎', loginId: 'taro@example.com',
  provider: 'supabase', aal: 'aal1', emailConfirmed: true,
  issuedAt: Date.now(), expiresAt: Date.now() + 3600000,
}));
const half = await auth.restoreSession();
check('★コード未入力のセッションは復元しない', half.authenticated === false);

section("9. オフラインで勝手にログアウトしない");
fake = useFake(createFakeGoTrue());
await auth.login('taro@example.com', 'correct-password');
fake.getSession = async () => { const e = new Error('offline'); e.name = 'AuthRetryableFetchError'; throw e; };
const offline = await auth.restoreSession();
check('★通信できないだけならログイン状態を保つ', offline.authenticated === true);
check('写しが残っている', globalThis.localStorage.getItem('tsam-ai-session') !== null);

section("10. パスワード再設定（アカウント列挙の防止）");
fake = useFake(createFakeGoTrue());
const sent1 = await auth.requestPasswordReset('taro@example.com');
const sent2 = await auth.requestPasswordReset('nobody@example.com');
check('登録済みでも成功', sent1 === true);
check('★未登録でも同じく成功を返す', sent2 === true);
let badEmail = null;
try { await auth.requestPasswordReset('not-an-email'); } catch (e) { badEmail = e; }
check('形式不正は弾く', badEmail?.code === 'INVALID_INPUT');

fake._state.nextError = { code: 'over_email_send_rate_limit', status: 429 };
let rateErr = null;
try { await auth.requestPasswordReset('taro@example.com'); } catch (e) { rateErr = e; }
check('送信制限は伝える', rateErr?.code === 'RATE_LIMITED');

section("11. パスワード変更");
fake = useFake(createFakeGoTrue());
await auth.login('taro@example.com', 'correct-password');
let weak = null;
try { await auth.updatePassword('short'); } catch (e) { weak = e; }
check('短いパスワードを拒否', weak?.code === 'WEAK_PASSWORD');
check('通信していない', !fake._state.calls.includes('updateUser'));
check('変更できる', (await auth.updatePassword('new-strong-password')).changed === true);
let longPw = null;
try { await auth.updatePassword('a'.repeat(100)); } catch (e) { longPw = e; }
check('長すぎるパスワードを拒否', longPw?.code === 'INVALID_INPUT');

section("12. 二段階認証の登録と解除");
fake = useFake(createFakeGoTrue());
await auth.login('taro@example.com', 'correct-password');

const enroll = await auth.startMfaEnrollment();
check('QRが data URI', String(enroll.qrCode).startsWith('data:image/svg+xml'));
check('secret が返る', enroll.secret === 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', String(enroll.secret));
check('factorId が返る', enroll.factorId === 'factor-new');

let enrollErr = null;
try { await auth.confirmMfaEnrollment({ factorId: enroll.factorId, code: '999999' }); } catch (e) { enrollErr = e; }
check('誤コードで有効化されない', enrollErr?.code === 'MFA_INVALID_CODE');

check('正しいコードで有効化', (await auth.confirmMfaEnrollment({ factorId: enroll.factorId, code: '123456' })) === true);
check('aal2 へ上がる', auth.getCurrentUser().aal === 'aal2');
check('一覧に出る', (await auth.listMfaFactors()).length === 1);

check('AAL2 なら解除できる', (await auth.disableMfa('factor-new')) === true);
check('解除後は一覧が空', (await auth.listMfaFactors()).length === 0);

/* AAL1 では解除させない */
fake = useFake(createFakeGoTrue({ factors: [{ id: 'f1', status: 'verified' }] }));
await auth.login('taro@example.com', 'correct-password').catch(() => {});
fake._state.aalCurrent = 'aal1';
let disableErr = null;
try { await auth.disableMfa('f1'); } catch (e) { disableErr = e; }
check('★AAL1では解除を拒否', disableErr?.code === 'MFA_REQUIRED', disableErr?.code);
check('要素が残っている', fake._state.factors.length === 1);

section("13. 未確認の要素を掃除してから登録する");
fake = useFake(createFakeGoTrue({ factors: [{ id: 'old', status: 'unverified' }] }));
await auth.login('taro@example.com', 'correct-password');
await auth.startMfaEnrollment();
check('未確認の残骸を解除している', fake._state.calls.includes('unenroll:old'));

section("14. メールリンクの処理");
fake = useFake(createFakeGoTrue());
const cb = await auth.handleAuthCallback({ code: 'good-code', type: 'recovery' });
check('セッションが復元される', auth.isAuthenticated() === true);
check('種別が返る', cb.type === 'recovery');

useFake(createFakeGoTrue());
let cbErr = null;
try { await auth.handleAuthCallback({ code: 'used-code', type: 'recovery' }); } catch (e) { cbErr = e; }
check('使用済みリンクは LINK_EXPIRED', cbErr?.code === 'LINK_EXPIRED', cbErr?.code);
check('日本語で説明される', cbErr.userMessage.includes('期限切れ'));

section("15. ログアウト");
fake = useFake(createFakeGoTrue());
await auth.login('taro@example.com', 'correct-password');
await auth.logout();
check('写しが消える', globalThis.localStorage.getItem('tsam-ai-session') === null);
check('プロバイダの signOut も呼ぶ', fake._state.calls.includes('signOut'));
check('未ログイン', auth.isAuthenticated() === false);

section("16. 秘密情報がどこにも残らない");
fake = useFake(createFakeGoTrue());
await auth.login('taro@example.com', 'correct-password');
const allStorage = JSON.stringify({ ...globalThis.localStorage.dump(), ...globalThis.sessionStorage.dump() });
check('パスワードが無い', !allStorage.includes('correct-password'));
check('ログにパスワードが無い', !warnings.join(' ').includes('correct-password'));
check('写しのキーが想定どおり',
  Object.keys(JSON.parse(globalThis.localStorage.getItem('tsam-ai-session'))).sort().join(',')
  === 'aal,displayName,emailConfirmed,expiresAt,issuedAt,loginId,provider,userId,v',
  Object.keys(JSON.parse(globalThis.localStorage.getItem('tsam-ai-session'))).sort().join(','));

finish();

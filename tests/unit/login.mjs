/*
 * ログイン判定と失敗制限の検証。
 *
 * 要件のログイン確認項目をひととおり通す。
 *   - 正しい一般利用者で成功
 *   - パスワード不一致 / 未登録 / disabled / suspended / ロック中 / 契約無効 で失敗
 *   - payment_exempt の管理者は未決済でも成功
 *   - 管理者も誤パスワードでは失敗
 *   - 成功時に失敗回数がリセットされる
 *
 * あわせて「失敗理由が画面へ漏れないこと」も確かめる。
 */

import { check, section, finish, fatal } from '../../public/apps/tests/helpers/assert.mjs';
import { createReadyEnvironment, setSetting, createActiveUser } from '../helpers/gas-harness.mjs';

const MINUTE = 60 * 1000;

try {
  const env = createReadyEnvironment();
  const gas = env.api;

  /* 一般利用者（契約中）。大文字を混ぜ、正規化されて保存されることも見る。 */
  createActiveUser(env, {
    email: 'Member@Example.com',
    password: 'Member-Password-2026',
  });

  check(
    '登録時にメールアドレスが小文字へ正規化される',
    gas.findUserByEmail_('member@example.com') !== null,
  );

  /* ---------------------------------------------------------------- */
  section('正常なログイン');

  const success = gas.performLogin_({
    email: 'member@example.com',
    password: 'Member-Password-2026',
    remember: false,
  });

  check('正しい一般利用者でログインできる', success.ok === true);
  check('セッショントークンが返る', typeof success.data.sessionToken === 'string');
  check('有効期限が返る', typeof success.data.expiresAt === 'string');
  check('利用者情報が返る', success.data.user.email === 'member@example.com');
  check('管理者ではない', success.data.user.isAdmin === false);

  check(
    '返り値にパスワードハッシュが含まれない',
    !JSON.stringify(success.data).includes('pbkdf2$'),
  );

  check(
    'メールアドレスは大文字で入力しても正規化されて通る',
    gas.performLogin_({
      email: '  MEMBER@EXAMPLE.COM  ',
      password: 'Member-Password-2026',
      remember: false,
    }).ok === true,
  );

  check(
    'ログイン成功が認証ログに残る',
    gas.readRows_('login_logs').some((row) => (
      String(row[gas.LOGIN_LOG_RESULT ?? 3]).trim() === 'success'
    )) || gas.readRows_('login_logs').some((row) => row.includes('success')),
  );

  check(
    '認証ログのメールアドレスはマスクされている',
    gas.readRows_('login_logs').every((row) => !String(row[2]).includes('member@example.com')),
  );

  /* ---------------------------------------------------------------- */
  section('失敗する場合（理由は画面へ出さない）');

  const wrongPassword = gas.performLogin_({
    email: 'member@example.com',
    password: 'wrong-password',
    remember: false,
  });

  check('パスワード不一致で失敗する', wrongPassword.ok === false);
  check('返る文言は定型のみ', wrongPassword.errorPair[0] === 'AUTH_FAILED');
  check(
    '文言に理由が書かれていない',
    wrongPassword.errorPair[1] === 'メールアドレスまたはパスワードが正しくありません。',
  );

  const unknown = gas.performLogin_({
    email: 'nobody@example.com',
    password: 'any-password',
    remember: false,
  });

  check('未登録メールで失敗する', unknown.ok === false);
  check(
    '未登録と不一致で同じ文言になる（登録の有無を漏らさない）',
    unknown.errorPair[0] === wrongPassword.errorPair[0]
    && unknown.errorPair[1] === wrongPassword.errorPair[1],
  );

  check(
    '入力形式が不正な場合も同じ文言',
    gas.performLogin_({ email: 'not-an-email', password: 'x' }).errorPair[0] === 'AUTH_FAILED',
  );

  check(
    'パスワード未入力も同じ文言',
    gas.performLogin_({ email: 'member@example.com', password: '' }).errorPair[0] === 'AUTH_FAILED',
  );

  /* 本当の理由はログにだけ残る。 */
  const reasons = gas.readRows_('login_logs').map((row) => String(row[4]));

  check('未登録の理由はログに残る', reasons.some((r) => r === 'USER_NOT_FOUND'));
  check('パスワード不一致の理由もログに残る', reasons.some((r) => r === 'BAD_PASSWORD'));

  /* ---------------------------------------------------------------- */
  section('アカウント状態による拒否');

  for (const status of ['disabled', 'suspended', 'pending', 'locked']) {
    const target = createActiveUser(env, {
      email: `state-${status}@example.com`,
      password: 'State-Test-Password-2026',
    });

    const update = {};
    update[gas.USER_COL.ACCOUNT_STATUS] = status;
    gas.updateUserCells_(gas.findUserById_(target.user.userId), update);

    const result = gas.performLogin_({
      email: `state-${status}@example.com`,
      password: 'State-Test-Password-2026',
      remember: false,
    });

    check(`${status} の利用者はログインできない`, result.ok === false);
    check(`${status} でも文言は定型のまま`, result.errorPair[0] === 'AUTH_FAILED');
  }

  check(
    'パスワード未設定（ハッシュ空）ではログインできない',
    (() => {
      const pendingUser = gas.withLock_(() => gas.createUser_({
        email: 'no-password@example.com',
        role: 'member',
        subscriptionStatus: 'active',
        paymentExempt: false,
        accountStatus: 'active',
      }));

      return gas.performLogin_({
        email: 'no-password@example.com',
        password: 'anything',
        remember: false,
      }).ok === false && pendingUser.passwordHash === '';
    })(),
  );

  /* ---------------------------------------------------------------- */
  section('契約状態による判定');

  const statusCases = [
    ['active', true],
    ['trialing', true],
    ['past_due', false],
    ['canceled', false],
    ['unpaid', false],
    ['incomplete_expired', false],
    ['paused', false],
    ['', false],
  ];

  for (const [status, expected] of statusCases) {
    const target = createActiveUser(env, {
      email: `sub-${status || 'empty'}@example.com`,
      password: 'Subscription-Test-2026',
    });

    const update = {};
    update[gas.USER_COL.SUBSCRIPTION_STATUS] = status;
    gas.updateUserCells_(gas.findUserById_(target.user.userId), update);

    const result = gas.performLogin_({
      email: `sub-${status || 'empty'}@example.com`,
      password: 'Subscription-Test-2026',
      remember: false,
    });

    check(
      `subscription_status=${status || '(空)'} → ${expected ? 'ログイン可' : 'ログイン不可'}`,
      result.ok === expected,
    );
  }

  check(
    'past_due は設定で利用可能にできる',
    (() => {
      setSetting(env, 'PAST_DUE_ALLOWED', 'TRUE');

      const result = gas.performLogin_({
        email: 'sub-past_due@example.com',
        password: 'Subscription-Test-2026',
        remember: false,
      });

      setSetting(env, 'PAST_DUE_ALLOWED', 'FALSE');
      return result.ok === true;
    })(),
  );

  check(
    'trialing は設定で利用不可にできる',
    (() => {
      setSetting(env, 'TRIALING_ALLOWED', 'FALSE');

      const result = gas.performLogin_({
        email: 'sub-trialing@example.com',
        password: 'Subscription-Test-2026',
        remember: false,
      });

      setSetting(env, 'TRIALING_ALLOWED', 'TRUE');
      return result.ok === false;
    })(),
  );

  check(
    'subscription_status=exempt でも payment_exempt が FALSE なら通さない',
    (() => {
      const target = createActiveUser(env, {
        email: 'fake-exempt@example.com',
        password: 'Fake-Exempt-2026',
      });

      const update = {};
      update[gas.USER_COL.SUBSCRIPTION_STATUS] = 'exempt';
      update[gas.USER_COL.PAYMENT_EXEMPT] = 'FALSE';
      gas.updateUserCells_(gas.findUserById_(target.user.userId), update);

      return gas.performLogin_({
        email: 'fake-exempt@example.com',
        password: 'Fake-Exempt-2026',
        remember: false,
      }).ok === false;
    })(),
  );

  /* ---------------------------------------------------------------- */
  section('管理者（決済なしでログインできる）');

  const admin = gas.findUserByEmail_('architect@potenitas.com');
  const adminToken = gas.withLock_(() => gas.issueToken_(admin.userId, 'initial_setup'));

  const adminSetup = gas.performPasswordSet_({
    token: adminToken.token,
    password: 'Administrator-Password-2026',
    passwordConfirm: 'Administrator-Password-2026',
    expectedType: 'initial_setup',
  });

  check('管理者がパスワードを設定できる', adminSetup.ok === true);

  const adminAfterSetup = gas.findUserByEmail_('architect@potenitas.com');
  check('設定後は account_status が active', adminAfterSetup.accountStatus === 'active');
  check('payment_exempt は TRUE のまま', adminAfterSetup.paymentExempt === true);
  check('Stripe の顧客IDは無い（未決済）', adminAfterSetup.stripeCustomerId === '');
  check('契約IDも無い', adminAfterSetup.stripeSubscriptionId === '');

  const adminLogin = gas.performLogin_({
    email: 'architect@potenitas.com',
    password: 'Administrator-Password-2026',
    remember: false,
  });

  check('管理者は未決済でもログインできる', adminLogin.ok === true);
  check('管理者として認識される', adminLogin.data.user.isAdmin === true);
  check('role が admin で返る', adminLogin.data.user.role === 'admin');

  check(
    '管理者も誤ったパスワードではログインできない',
    gas.performLogin_({
      email: 'architect@potenitas.com',
      password: 'wrong-password',
      remember: false,
    }).ok === false,
  );

  check(
    '管理者判定はメールアドレスではなく role で行う',
    (() => {
      /* 同じアドレスでも role が member なら管理者扱いしない。 */
      const target = gas.findUserByEmail_('architect@potenitas.com');
      const update = {};
      update[gas.USER_COL.ROLE] = 'member';
      gas.updateUserCells_(target, update);

      const result = gas.performLogin_({
        email: 'architect@potenitas.com',
        password: 'Administrator-Password-2026',
        remember: false,
      });

      const restore = {};
      restore[gas.USER_COL.ROLE] = 'admin';
      gas.updateUserCells_(gas.findUserByEmail_('architect@potenitas.com'), restore);

      return result.ok === true && result.data.user.isAdmin === false;
    })(),
  );

  check(
    'アカウントを無効にすれば管理者でもログインできない',
    (() => {
      const target = gas.findUserByEmail_('architect@potenitas.com');
      const update = {};
      update[gas.USER_COL.ACCOUNT_STATUS] = 'disabled';
      gas.updateUserCells_(target, update);

      const result = gas.performLogin_({
        email: 'architect@potenitas.com',
        password: 'Administrator-Password-2026',
        remember: false,
      });

      const restore = {};
      restore[gas.USER_COL.ACCOUNT_STATUS] = 'active';
      gas.updateUserCells_(gas.findUserByEmail_('architect@potenitas.com'), restore);

      return result.ok === false;
    })(),
  );

  /* ---------------------------------------------------------------- */
  section('ログイン失敗制限');

  const locked = createActiveUser(env, {
    email: 'lockout@example.com',
    password: 'Lockout-Password-2026',
  });

  setSetting(env, 'LOGIN_FAILURE_LIMIT', '5');
  setSetting(env, 'LOCK_DURATION_MINUTES', '15');

  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const result = gas.performLogin_({
      email: 'lockout@example.com',
      password: 'wrong',
      remember: false,
    });

    check(`${attempt}回目の失敗はまだロックされない`, result.errorPair[0] === 'AUTH_FAILED');
  }

  check(
    '4回失敗した時点で失敗回数が4',
    gas.findUserById_(locked.user.userId).loginFailureCount === 4,
    gas.findUserById_(locked.user.userId).loginFailureCount,
  );

  const fifth = gas.performLogin_({
    email: 'lockout@example.com',
    password: 'wrong',
    remember: false,
  });

  check('5回目でロックされる', fifth.errorPair[0] === 'LOCKED');
  check(
    'ロックの文言は要件どおり',
    fifth.errorPair[1] === 'ログインを一時的に制限しています。時間をおいて再度お試しください。',
  );

  check(
    'ロック中は正しいパスワードでも入れない',
    gas.performLogin_({
      email: 'lockout@example.com',
      password: 'Lockout-Password-2026',
      remember: false,
    }).errorPair[0] === 'LOCKED',
  );

  check(
    'ロック期限がシートに記録される',
    gas.findUserById_(locked.user.userId).lockedUntilMs > env.getTime(),
  );

  env.advance(14 * MINUTE);
  check(
    '14分後はまだロック中',
    gas.performLogin_({
      email: 'lockout@example.com',
      password: 'Lockout-Password-2026',
      remember: false,
    }).errorPair[0] === 'LOCKED',
  );

  env.advance(2 * MINUTE);
  const afterLock = gas.performLogin_({
    email: 'lockout@example.com',
    password: 'Lockout-Password-2026',
    remember: false,
  });

  check('16分後はログインできる', afterLock.ok === true);

  check(
    'ログイン成功で失敗回数が0へ戻る',
    gas.findUserById_(locked.user.userId).loginFailureCount === 0,
    gas.findUserById_(locked.user.userId).loginFailureCount,
  );

  check(
    'ログイン成功でロック期限も消える',
    gas.findUserById_(locked.user.userId).lockedUntilMs === 0,
  );

  check(
    'ログイン成功で last_login_at が入る',
    gas.findUserById_(locked.user.userId).lastLoginAt !== '',
  );

  check(
    '失敗上限は設定で変えられる',
    (() => {
      setSetting(env, 'LOGIN_FAILURE_LIMIT', '2');

      const target = createActiveUser(env, {
        email: 'limit2@example.com',
        password: 'Limit-Two-Password-2026',
      });

      gas.performLogin_({ email: 'limit2@example.com', password: 'x', remember: false });
      const second = gas.performLogin_({ email: 'limit2@example.com', password: 'x', remember: false });

      setSetting(env, 'LOGIN_FAILURE_LIMIT', '5');
      return second.errorPair[0] === 'LOCKED' && target.user !== null;
    })(),
  );

  check(
    '存在しないメールアドレスではロック行を作らない（他人を締め出せない）',
    (() => {
      const before = gas.readRows_('users').length;

      for (let i = 0; i < 10; i += 1) {
        gas.performLogin_({ email: 'ghost@example.com', password: 'x', remember: false });
      }

      return gas.readRows_('users').length === before;
    })(),
  );

  /* ---------------------------------------------------------------- */
  section('パスワード再設定の申し込み');

  env.sentMails.length = 0;

  const requestKnown = gas.performPasswordResetRequest_({ email: 'member@example.com' });
  check('登録済みなら成功が返る', requestKnown.ok === true);
  check('案内メールが送られる', env.sentMails.length === 1);
  check(
    'メールにパスワードが載らない',
    !env.sentMails[0].body.includes('Member-Password-2026'),
  );
  check('メールにURLが載る', env.sentMails[0].body.includes('token='));
  check(
    'メールのURLは設定した基底URLから組み立てられる',
    env.sentMails[0].body.includes('https://tsam-ai.example/password/reset/?token='),
  );

  check(
    'APP_BASE_URL が未設定ならメールを送らず、エラーとして記録する',
    (() => {
      setSetting(env, 'APP_BASE_URL', '');
      env.sentMails.length = 0;

      const result = gas.performPasswordResetRequest_({ email: 'member@example.com' });
      const logged = gas.readRows_('system_error_logs')
        .some((row) => String(row[2]).includes('パスワード再設定URLが未設定'));

      setSetting(env, 'APP_BASE_URL', 'https://tsam-ai.example/');

      /* 利用者への応答は変えない（登録の有無を漏らさないため）。 */
      return result.ok === true && env.sentMails.length === 0 && logged;
    })(),
  );

  env.sentMails.length = 0;
  gas.performPasswordResetRequest_({ email: 'member@example.com' });

  env.sentMails.length = 0;

  const requestUnknown = gas.performPasswordResetRequest_({ email: 'nobody-at-all@example.com' });
  check('未登録でも成功が返る（登録の有無を漏らさない）', requestUnknown.ok === true);
  check('未登録にはメールを送らない', env.sentMails.length === 0);

  check(
    '登録済みと未登録で返り値が同じ',
    JSON.stringify(requestKnown) === JSON.stringify(requestUnknown),
  );

  check(
    '形式が不正なアドレスでも成功が返る',
    gas.performPasswordResetRequest_({ email: 'broken' }).ok === true,
  );

  check(
    '停止中のアカウントには再設定リンクを送らない（応答は同じ）',
    (() => {
      const target = createActiveUser(env, {
        email: 'suspended-reset@example.com',
        password: 'Suspended-Reset-2026',
      });

      const update = {};
      update[gas.USER_COL.ACCOUNT_STATUS] = 'suspended';
      gas.updateUserCells_(gas.findUserById_(target.user.userId), update);

      env.sentMails.length = 0;
      const result = gas.performPasswordResetRequest_({ email: 'suspended-reset@example.com' });

      return result.ok === true && env.sentMails.length === 0;
    })(),
  );

  /* ---------------------------------------------------------------- */
  section('パスワード設定の入力検証');

  const target = createActiveUser(env, {
    email: 'setpass@example.com',
    password: 'Set-Pass-Original-2026',
  });

  function freshToken() {
    return gas.withLock_(() => gas.issueToken_(target.user.userId, 'password_reset')).token;
  }

  check(
    '確認用と一致しなければ拒否する',
    gas.performPasswordSet_({
      token: freshToken(),
      password: 'Valid-Password-2026',
      passwordConfirm: 'Different-Password-2026',
      expectedType: 'password_reset',
    }).errorPair[0] === 'PASSWORD_MISMATCH',
  );

  check(
    '短すぎるパスワードを拒否する',
    gas.performPasswordSet_({
      token: freshToken(),
      password: 'short',
      passwordConfirm: 'short',
      expectedType: 'password_reset',
    }).errorPair[0] === 'PASSWORD_WEAK',
  );

  check(
    '空白のみのパスワードを拒否する',
    gas.performPasswordSet_({
      token: freshToken(),
      password: '              ',
      passwordConfirm: '              ',
      expectedType: 'password_reset',
    }).errorPair[0] === 'PASSWORD_WEAK',
  );

  check(
    '不正なトークンを拒否する',
    gas.performPasswordSet_({
      token: gas.randomToken_(),
      password: 'Valid-Password-2026',
      passwordConfirm: 'Valid-Password-2026',
      expectedType: 'password_reset',
    }).errorPair[0] === 'TOKEN_INVALID',
  );

  check(
    '同じトークンは2回使えない',
    (() => {
      const token = freshToken();

      const first = gas.performPasswordSet_({
        token,
        password: 'First-Valid-Password-2026',
        passwordConfirm: 'First-Valid-Password-2026',
        expectedType: 'password_reset',
      });

      const second = gas.performPasswordSet_({
        token,
        password: 'Second-Valid-Password-2026',
        passwordConfirm: 'Second-Valid-Password-2026',
        expectedType: 'password_reset',
      });

      return first.ok === true && second.errorPair[0] === 'TOKEN_INVALID';
    })(),
  );

  check(
    '期限切れトークンを拒否する',
    (() => {
      const token = freshToken();
      env.advance(2 * 60 * MINUTE);

      return gas.performPasswordSet_({
        token,
        password: 'Expired-Token-Password-2026',
        passwordConfirm: 'Expired-Token-Password-2026',
        expectedType: 'password_reset',
      }).errorPair[0] === 'TOKEN_INVALID';
    })(),
  );

  check(
    '停止中のアカウントはトークンでも復活しない',
    (() => {
      const suspended = createActiveUser(env, {
        email: 'suspended-set@example.com',
        password: 'Suspended-Set-2026',
      });

      const update = {};
      update[gas.USER_COL.ACCOUNT_STATUS] = 'suspended';
      gas.updateUserCells_(gas.findUserById_(suspended.user.userId), update);

      const token = gas.withLock_(
        () => gas.issueToken_(suspended.user.userId, 'password_reset'),
      ).token;

      return gas.performPasswordSet_({
        token,
        password: 'Should-Not-Work-2026',
        passwordConfirm: 'Should-Not-Work-2026',
        expectedType: 'password_reset',
      }).errorPair[0] === 'TOKEN_INVALID';
    })(),
  );

  finish();
} catch (error) {
  fatal(error);
}

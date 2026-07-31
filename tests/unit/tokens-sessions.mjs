/*
 * 一時トークンとセッションの検証。
 *
 * 確かめること:
 *   - 平文で保存されない
 *   - 期限が切れる
 *   - 一度使ったら再利用できない
 *   - パスワード変更で既存セッションが全部無効になる
 *   - 通常ログインと「ログイン状態を保持」で期限が違う
 */

import { check, section, finish, fatal } from '../../public/apps/tests/helpers/assert.mjs';
import { createReadyEnvironment, setSetting, createActiveUser } from '../helpers/gas-harness.mjs';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

try {
  const env = createReadyEnvironment();
  const gas = env.api;

  const { user } = createActiveUser(env, {
    email: 'token-test@example.com',
    password: 'Token-Test-Password-2026',
  });

  /* ---------------------------------------------------------------- */
  section('トークンの発行と保存');

  const issued = gas.withLock_(() => gas.issueToken_(user.userId, 'password_reset'));

  check('平文トークンが返る', typeof issued.token === 'string' && issued.token.length === 43);

  const tokenRow = gas.findRows_('password_tokens', (values) => (
    String(values[gas.TOKEN_COL.USER_ID - 1]).trim() === user.userId
    && String(values[gas.TOKEN_COL.TOKEN_TYPE - 1]).trim() === 'password_reset'
  ))[0];

  check('シートへ行が追加される', tokenRow !== undefined);

  const savedHash = String(tokenRow.values[gas.TOKEN_COL.TOKEN_HASH - 1]);

  check('保存されるのは16進のハッシュ', /^[0-9a-f]{64}$/.test(savedHash));
  check('平文トークンは保存されない', savedHash !== issued.token);

  const allTokenCells = gas.readRows_('password_tokens')
    .map((row) => row.join(' '))
    .join(' ');

  check('シート全体を見ても平文トークンが無い', !allTokenCells.includes(issued.token));

  check(
    '単純な SHA-256 ではなく鍵付き（TOKEN_SECRET が必要）',
    savedHash !== gas.sha256Hex_(issued.token),
  );

  /* ---------------------------------------------------------------- */
  section('トークンの検証');

  const verified = gas.verifyToken_(issued.token, 'password_reset');
  check('正しいトークンを受け入れる', verified.ok === true);
  check('利用者IDが取れる', verified.userId === user.userId);

  check(
    '種類が違えば拒否する（初期設定用のリンクで再設定させない）',
    gas.verifyToken_(issued.token, 'initial_setup').reason === 'WRONG_TYPE',
  );

  check(
    '存在しないトークンを拒否する',
    gas.verifyToken_(gas.randomToken_(), 'password_reset').reason === 'NOT_FOUND',
  );

  check('空文字を拒否する', gas.verifyToken_('', 'password_reset').reason === 'MALFORMED');
  check(
    '極端に長い値を拒否する',
    gas.verifyToken_('a'.repeat(300), 'password_reset').reason === 'MALFORMED',
  );

  check(
    'TOKEN_SECRET が無ければ検証できない',
    (() => {
      const before = env.properties.TOKEN_SECRET;
      delete env.properties.TOKEN_SECRET;
      const result = gas.verifyToken_(issued.token, 'password_reset');
      env.properties.TOKEN_SECRET = before;
      return result.reason === 'NOT_CONFIGURED';
    })(),
  );

  /* ---------------------------------------------------------------- */
  section('使用済みトークンの再利用禁止');

  gas.markTokenUsed_(verified.rowNumber);

  check(
    '一度使ったトークンは拒否される',
    gas.verifyToken_(issued.token, 'password_reset').reason === 'ALREADY_USED',
  );

  /* ---------------------------------------------------------------- */
  section('トークンの期限');

  setSetting(env, 'RESET_TOKEN_TTL_MINUTES', '60');
  const expiring = gas.withLock_(() => gas.issueToken_(user.userId, 'password_reset'));

  check('発行直後は有効', gas.verifyToken_(expiring.token, 'password_reset').ok === true);

  env.advance(59 * 60 * 1000);
  check('59分後はまだ有効', gas.verifyToken_(expiring.token, 'password_reset').ok === true);

  env.advance(2 * 60 * 1000);
  check(
    '61分後は期限切れ',
    gas.verifyToken_(expiring.token, 'password_reset').reason === 'EXPIRED',
  );

  check(
    '初期設定トークンの既定有効期限は72時間',
    (() => {
      const setup = gas.withLock_(() => gas.issueToken_(user.userId, 'initial_setup'));
      const hours = Math.round((setup.expiresAtMs - env.getTime()) / HOUR);
      return hours === 72;
    })(),
  );

  /* ---------------------------------------------------------------- */
  section('古いトークンの無効化');

  const first = gas.withLock_(() => gas.issueToken_(user.userId, 'password_reset'));
  const second = gas.withLock_(() => {
    gas.invalidateTokens_(user.userId, 'password_reset');
    return gas.issueToken_(user.userId, 'password_reset');
  });

  check(
    '新しく発行すると古いリンクは無効になる',
    gas.verifyToken_(first.token, 'password_reset').reason === 'ALREADY_USED',
  );

  check('新しいリンクは有効', gas.verifyToken_(second.token, 'password_reset').ok === true);

  /* ---------------------------------------------------------------- */
  section('セッションの発行');

  const normalSession = gas.withLock_(() => gas.issueSession_(user, false, 'Mozilla/5.0 (Windows NT 10.0) Chrome/120'));

  check('セッショントークンが返る', normalSession.token.length === 43);

  const sessionRow = gas.findRows_('sessions', (values) => (
    String(values[gas.SESSION_COL.SESSION_ID - 1]).trim() === normalSession.sessionId
  ))[0];

  check('シートへ行が追加される', sessionRow !== undefined);

  const sessionHash = String(sessionRow.values[gas.SESSION_COL.TOKEN_HASH - 1]);
  check('保存されるのは16進のハッシュ', /^[0-9a-f]{64}$/.test(sessionHash));
  check('平文トークンは保存されない', sessionHash !== normalSession.token);

  check(
    'User-Agent は要約だけを保存する',
    String(sessionRow.values[gas.SESSION_COL.USER_AGENT_SUMMARY - 1]) === 'windows/chrome',
    sessionRow.values[gas.SESSION_COL.USER_AGENT_SUMMARY - 1],
  );

  check(
    'sessions シートに平文トークンが無い',
    !gas.readRows_('sessions').map((row) => row.join(' ')).join(' ').includes(normalSession.token),
  );

  /* ---------------------------------------------------------------- */
  section('通常セッションと保持セッションの期限');

  const normalHours = Math.round((normalSession.expiresAtMs - env.getTime()) / HOUR);
  check('通常ログインは12時間', normalHours === 12, normalHours);

  const rememberSession = gas.withLock_(() => gas.issueSession_(user, true, ''));
  const rememberDays = Math.round((rememberSession.expiresAtMs - env.getTime()) / DAY);

  check('ログイン状態を保持すると30日', rememberDays === 30, rememberDays);
  check('2つの期限は異なる', normalSession.expiresAtMs !== rememberSession.expiresAtMs);

  check(
    'remember_login がシートに記録される',
    (() => {
      const row = gas.findRows_('sessions', (values) => (
        String(values[gas.SESSION_COL.SESSION_ID - 1]).trim() === rememberSession.sessionId
      ))[0];
      return String(row.values[gas.SESSION_COL.REMEMBER_LOGIN - 1]) === 'TRUE';
    })(),
  );

  check(
    '有効期限は設定で変えられる',
    (() => {
      setSetting(env, 'SESSION_TTL_HOURS', '4');
      const short = gas.withLock_(() => gas.issueSession_(user, false, ''));
      setSetting(env, 'SESSION_TTL_HOURS', '12');
      return Math.round((short.expiresAtMs - env.getTime()) / HOUR) === 4;
    })(),
  );

  /* ---------------------------------------------------------------- */
  section('セッションの検証');

  const check1 = gas.verifySessionToken_(normalSession.token);
  check('有効なセッションを受け入れる', check1.ok === true);
  check('利用者を取り出せる', check1.user.userId === user.userId);

  check(
    '存在しないトークンを拒否する',
    gas.verifySessionToken_(gas.randomToken_()).reason === 'NOT_FOUND',
  );

  check('空文字を拒否する', gas.verifySessionToken_('').reason === 'MALFORMED');

  check(
    'SESSION_SECRET が無ければ検証できない',
    (() => {
      const before = env.properties.SESSION_SECRET;
      delete env.properties.SESSION_SECRET;
      const result = gas.verifySessionToken_(normalSession.token);
      env.properties.SESSION_SECRET = before;
      return result.reason === 'NOT_CONFIGURED';
    })(),
  );

  check(
    '最終アクセス時刻が更新される',
    (() => {
      const before = gas.findRows_('sessions', (values) => (
        String(values[gas.SESSION_COL.SESSION_ID - 1]).trim() === normalSession.sessionId
      ))[0].values[gas.SESSION_COL.LAST_ACCESS_AT - 1];

      env.advance(60 * 1000);
      gas.verifySessionToken_(normalSession.token);

      const after = gas.findRows_('sessions', (values) => (
        String(values[gas.SESSION_COL.SESSION_ID - 1]).trim() === normalSession.sessionId
      ))[0].values[gas.SESSION_COL.LAST_ACCESS_AT - 1];

      return before !== after;
    })(),
  );

  /* ---------------------------------------------------------------- */
  section('セッションの失効');

  check('ログアウトで失効する', gas.revokeSessionByToken_(normalSession.token) === true);
  check(
    'ログアウト後は再利用できない',
    gas.verifySessionToken_(normalSession.token).reason === 'REVOKED',
  );

  check(
    '存在しないトークンのログアウトは false（例外を投げない）',
    gas.revokeSessionByToken_(gas.randomToken_()) === false,
  );

  /* ---------------------------------------------------------------- */
  section('セッションの期限切れ');

  const expiringSession = gas.withLock_(() => gas.issueSession_(user, false, ''));

  check('発行直後は有効', gas.verifySessionToken_(expiringSession.token).ok === true);

  env.advance(11 * HOUR);
  check('11時間後はまだ有効', gas.verifySessionToken_(expiringSession.token).ok === true);

  env.advance(2 * HOUR);
  check(
    '13時間後は期限切れ',
    gas.verifySessionToken_(expiringSession.token).reason === 'EXPIRED',
  );

  /* ---------------------------------------------------------------- */
  section('アカウント状態・契約状態の変化への追随');

  const live = gas.withLock_(() => gas.issueSession_(user, true, ''));
  check('セッションは有効', gas.verifySessionToken_(live.token).ok === true);

  /* 契約が切れたら、セッションが生きていても入れない。 */
  const subscriptionUpdate = {};
  subscriptionUpdate[gas.USER_COL.SUBSCRIPTION_STATUS] = 'canceled';
  gas.updateUserCells_(gas.findUserById_(user.userId), subscriptionUpdate);

  check(
    '契約が切れるとセッションが通らなくなる',
    gas.verifySessionToken_(live.token).reason === 'SUBSCRIPTION_INACTIVE',
  );

  subscriptionUpdate[gas.USER_COL.SUBSCRIPTION_STATUS] = 'active';
  gas.updateUserCells_(gas.findUserById_(user.userId), subscriptionUpdate);

  /* アカウントを止めたら入れない。 */
  const statusUpdate = {};
  statusUpdate[gas.USER_COL.ACCOUNT_STATUS] = 'suspended';
  gas.updateUserCells_(gas.findUserById_(user.userId), statusUpdate);

  check(
    'アカウントを停止するとセッションが通らなくなる',
    gas.verifySessionToken_(live.token).reason === 'ACCOUNT_NOT_ACTIVE',
  );

  statusUpdate[gas.USER_COL.ACCOUNT_STATUS] = 'active';
  gas.updateUserCells_(gas.findUserById_(user.userId), statusUpdate);

  check('戻せば再び通る', gas.verifySessionToken_(live.token).ok === true);

  /* ---------------------------------------------------------------- */
  section('パスワード変更で全セッションを破棄');

  const sessionA = gas.withLock_(() => gas.issueSession_(gas.findUserById_(user.userId), false, ''));
  const sessionB = gas.withLock_(() => gas.issueSession_(gas.findUserById_(user.userId), true, ''));

  check('2つとも有効', gas.verifySessionToken_(sessionA.token).ok && gas.verifySessionToken_(sessionB.token).ok);

  const resetToken = gas.withLock_(() => gas.issueToken_(user.userId, 'password_reset'));

  const changed = gas.performPasswordSet_({
    token: resetToken.token,
    password: 'New-Password-After-Change-2026',
    passwordConfirm: 'New-Password-After-Change-2026',
    expectedType: 'password_reset',
  });

  check('パスワードを変更できる', changed.ok === true);

  check(
    '変更前のセッションはすべて無効になる',
    gas.verifySessionToken_(sessionA.token).reason === 'REVOKED'
    && gas.verifySessionToken_(sessionB.token).reason === 'REVOKED',
  );

  check(
    '古いパスワードではログインできない',
    gas.performLogin_({
      email: 'token-test@example.com',
      password: 'Token-Test-Password-2026',
      remember: false,
    }).ok === false,
  );

  check(
    '新しいパスワードでログインできる',
    gas.performLogin_({
      email: 'token-test@example.com',
      password: 'New-Password-After-Change-2026',
      remember: false,
    }).ok === true,
  );

  check(
    'パスワード変更完了の通知メールが送られる',
    env.sentMails.some((mail) => mail.subject.includes('パスワードを変更しました')),
  );

  check(
    '通知メールにパスワードが載っていない',
    env.sentMails.every((mail) => !mail.body.includes('New-Password-After-Change-2026')),
  );

  /*
   * 変更前のセッションが、API から見ても入れなくなることを確かめる。
   * 上の確認は内部関数の理由コード（REVOKED）を見ているが、
   * 画面が実際に受け取るのは verifySession の応答である。
   * 仕様書 docs/specs/login-page-detailed-spec-v3.md §5.5 / §12
   */
  const revokedResponse = env.readOutput(gas.doPost({
    parameter: {},
    postData: { contents: JSON.stringify({ action: 'verifySession', sessionToken: sessionA.token }) },
  }));

  check('変更前のセッションは API から SESSION_INVALID が返る', revokedResponse.success === false);
  check(
    '失効理由を区別しない単一コードで返る',
    revokedResponse.error.code === 'SESSION_INVALID',
    revokedResponse.error.code,
  );

  check(
    '応答に内部の失効理由が含まれない',
    !JSON.stringify(revokedResponse).includes('REVOKED'),
  );

  /* ---------------------------------------------------------------- */
  section('Session fixation 対策');

  /*
   * ログイン成功のたびに新しいトークンを発行し、
   * 直前まで有効だったトークンを使い回さないことを確かめる。
   * 使い回すと、攻撃者が事前に握らせたトークンがログイン後も通ってしまう。
   * 仕様書 docs/specs/login-page-detailed-spec-v3.md §7
   */
  const fixationUser = createActiveUser(env, {
    email: 'fixation@example.com',
    password: 'Fixation-Test-Password-2026',
  });

  function signIn(remember) {
    const result = gas.performLogin_({
      email: fixationUser.email,
      password: fixationUser.password,
      remember: remember === true,
    });

    if (!result.ok) {
      throw new Error('テストの前提が崩れています: ログインに失敗しました。');
    }

    return result.data.sessionToken;
  }

  const firstToken = signIn(false);
  const secondToken = signIn(false);

  check('再ログインで別のトークンが発行される', firstToken !== secondToken);

  check(
    '1回目のトークンはそのままでは通らない形で置き換わる（使い回しなし）',
    gas.findRows_('sessions', (values) => (
      String(values[gas.SESSION_COL.TOKEN_HASH - 1]).trim()
      === gas.hmacHex_(firstToken, env.properties.SESSION_SECRET)
    )).length === 1,
  );

  check(
    '2つのトークンは別々のセッション行として記録される',
    gas.findRows_('sessions', (values) => (
      String(values[gas.SESSION_COL.USER_ID - 1]).trim() === fixationUser.user.userId
    )).length === 2,
  );

  const tokenSet = new Set([firstToken, secondToken]);

  for (let i = 0; i < 5; i += 1) {
    tokenSet.add(signIn(i % 2 === 0));
  }

  check('何度ログインしてもトークンが重複しない', tokenSet.size === 7, tokenSet.size);

  check(
    'remember の有無にかかわらず新規発行される',
    signIn(true) !== signIn(true),
  );

  /* ---------------------------------------------------------------- */
  section('掃除');

  const beforeCleanup = gas.readRows_('sessions').length;
  env.advance(40 * DAY);
  gas.cleanupExpiredSessions();

  check(
    '期限切れセッションが削除される',
    gas.readRows_('sessions').length < beforeCleanup,
    `${beforeCleanup} → ${gas.readRows_('sessions').length}`,
  );

  const beforeTokenCleanup = gas.readRows_('password_tokens').length;
  gas.cleanupExpiredTokens();

  check(
    '古いトークン行が削除される',
    gas.readRows_('password_tokens').length < beforeTokenCleanup,
    `${beforeTokenCleanup} → ${gas.readRows_('password_tokens').length}`,
  );

  finish();
} catch (error) {
  fatal(error);
}

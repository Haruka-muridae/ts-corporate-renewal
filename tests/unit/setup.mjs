/*
 * 初期セットアップの検証。
 *
 * 重視するのは冪等性。
 * setupAuthSystem() は運用中に何度でも実行されうる（設定を足したあと、
 * 権限を承認し直したあとなど）。そのたびに重複したフォルダ・シート・
 * 管理者レコードができると、どれが本物か分からなくなる。
 */

import { check, section, finish, fatal } from '../../public/apps/tests/helpers/assert.mjs';
import { createGasEnvironment } from '../helpers/gas-harness.mjs';

try {
  const env = createGasEnvironment();
  const gas = env.api;

  /* ---------------------------------------------------------------- */
  section('1回目の実行');

  const report = gas.setupAuthSystem();

  check('実行結果の要約が返る', typeof report === 'string' && report.length > 0);

  const tsamFolders = [];
  const rootIterator = env.rootFolder.getFoldersByName('TSAM AI');

  while (rootIterator.hasNext()) {
    tsamFolders.push(rootIterator.next());
  }

  check('マイドライブに「TSAM AI」が1つ作られる', tsamFolders.length === 1, tsamFolders.length);

  const authFolders = [];
  const authIterator = tsamFolders[0].getFoldersByName('Auth');

  while (authIterator.hasNext()) {
    authFolders.push(authIterator.next());
  }

  check('その中に「Auth」が1つ作られる', authFolders.length === 1, authFolders.length);

  const authFolder = authFolders[0];
  const fileNames = authFolder.files.map((file) => file.getName()).sort();

  check(
    '4つのスプレッドシートが Auth フォルダに置かれる',
    JSON.stringify(fileNames) === JSON.stringify(
      [
        'TSAM AI ユーザー管理',
        'TSAM AI 認証ログ',
        'TSAM AI 認証設定',
        'TSAM AI 法務文書',
      ].sort(),
    ),
    fileNames.join(' / '),
  );

  /* ---------------------------------------------------------------- */
  section('Script Properties');

  const requiredProperties = [
    'AUTH_ROOT_FOLDER_ID',
    'AUTH_FOLDER_ID',
    'AUTH_USER_SPREADSHEET_ID',
    'AUTH_LOG_SPREADSHEET_ID',
    'AUTH_CONFIG_SPREADSHEET_ID',
    'SESSION_SECRET',
    'TOKEN_SECRET',
    'PASSWORD_PEPPER',
    'STRIPE_WEBHOOK_URL_KEY',
  ];

  for (const key of requiredProperties) {
    check(`${key} が保存される`, String(env.properties[key] ?? '').length > 0);
  }

  check(
    'シークレットは十分な長さがある（86文字以上）',
    env.properties.SESSION_SECRET.length >= 86,
    env.properties.SESSION_SECRET.length,
  );

  check(
    'SESSION_SECRET と TOKEN_SECRET は別の値',
    env.properties.SESSION_SECRET !== env.properties.TOKEN_SECRET,
  );

  check(
    'PASSWORD_PEPPER も別の値',
    env.properties.PASSWORD_PEPPER !== env.properties.SESSION_SECRET,
  );

  check(
    'Stripe の秘密鍵は自動生成しない（運用者が入れる）',
    (env.properties.STRIPE_SECRET_KEY ?? '') === '',
  );

  /* ---------------------------------------------------------------- */
  section('シートとヘッダー');

  const expectedSheets = {
    users: gas.HEADERS.users,
    password_tokens: gas.HEADERS.password_tokens,
    sessions: gas.HEADERS.sessions,
    stripe_events: gas.HEADERS.stripe_events,
    login_logs: gas.HEADERS.login_logs,
    admin_action_logs: gas.HEADERS.admin_action_logs,
    system_error_logs: gas.HEADERS.system_error_logs,
    settings: gas.HEADERS.settings,
    plans: gas.HEADERS.plans,
  };

  for (const [name, header] of Object.entries(expectedSheets)) {
    const sheet = gas.getSheet_(name);
    const actual = sheet.getRange(1, 1, 1, header.length).getValues()[0];

    check(
      `${name} のヘッダーが仕様どおり`,
      JSON.stringify(actual) === JSON.stringify(header),
      actual.join(','),
    );
  }

  check(
    'users の列構成が要件の A〜P（16列）',
    gas.HEADERS.users.length === 16,
    gas.HEADERS.users.length,
  );

  check(
    'users の列順が要件どおり',
    gas.HEADERS.users[gas.USER_COL.EMAIL - 1] === 'email'
    && gas.HEADERS.users[gas.USER_COL.PASSWORD_HASH - 1] === 'password_hash'
    && gas.HEADERS.users[gas.USER_COL.PAYMENT_EXEMPT - 1] === 'payment_exempt'
    && gas.HEADERS.users[gas.USER_COL.UPDATED_AT - 1] === 'updated_at',
  );

  check(
    '新規作成時の「シート1」が残っていない',
    gas.getUserSpreadsheet_().getSheets().every((sheet) => sheet.getName() !== 'シート1'),
  );

  /* ---------------------------------------------------------------- */
  section('既定設定');

  check('PASSWORD_MIN_LENGTH の既定は12', gas.getSettingNumber_('PASSWORD_MIN_LENGTH', 0) === 12);
  check('LOGIN_FAILURE_LIMIT の既定は5', gas.getSettingNumber_('LOGIN_FAILURE_LIMIT', 0) === 5);
  check('LOCK_DURATION_MINUTES の既定は15', gas.getSettingNumber_('LOCK_DURATION_MINUTES', 0) === 15);
  check('SESSION_TTL_HOURS の既定は12', gas.getSettingNumber_('SESSION_TTL_HOURS', 0) === 12);
  check('REMEMBER_SESSION_TTL_DAYS の既定は30', gas.getSettingNumber_('REMEMBER_SESSION_TTL_DAYS', 0) === 30);
  check('TRIALING_ALLOWED の既定は TRUE', gas.getSettingBool_('TRIALING_ALLOWED', false) === true);
  check('PAST_DUE_ALLOWED の既定は FALSE', gas.getSettingBool_('PAST_DUE_ALLOWED', true) === false);

  check(
    '秘密情報キーは設定シート経由では読めない',
    gas.getSetting_('STRIPE_SECRET_KEY') === '' && gas.getSetting_('SESSION_SECRET') === '',
  );

  /* ---------------------------------------------------------------- */
  section('管理者レコード');

  const admin = gas.findUserByEmail_('architect@potenitas.com');

  check('管理者レコードが作られる', admin !== null);
  check('role が admin', admin.role === 'admin');
  check('payment_exempt が TRUE', admin.paymentExempt === true);
  check('subscription_status が exempt', admin.subscriptionStatus === 'exempt');
  check('account_status は pending（パスワード未設定）', admin.accountStatus === 'pending');
  check('パスワードハッシュは空（初期パスワードをコードに書かない）', admin.passwordHash === '');
  check('ソルトも空', admin.passwordSalt === '');

  const setupTokens = gas.findRows_('password_tokens', (values) => (
    String(values[gas.TOKEN_COL.USER_ID - 1]).trim() === admin.userId
  ));

  check('管理者の初期設定トークンが発行される', setupTokens.length === 1, setupTokens.length);

  check(
    'トークンは平文で保存されない（16進のハッシュだけ）',
    /^[0-9a-f]{64}$/.test(String(setupTokens[0].values[gas.TOKEN_COL.TOKEN_HASH - 1])),
  );

  /* ---------------------------------------------------------------- */
  section('2回目の実行（冪等性）');

  const secretsBefore = {
    session: env.properties.SESSION_SECRET,
    token: env.properties.TOKEN_SECRET,
    pepper: env.properties.PASSWORD_PEPPER,
    webhookKey: env.properties.STRIPE_WEBHOOK_URL_KEY,
  };

  const userBookId = env.properties.AUTH_USER_SPREADSHEET_ID;
  const settingsRowsBefore = gas.readRows_('settings').length;
  const usersBefore = gas.readRows_('users').length;

  gas.setupAuthSystem();
  gas.setupAuthSystem();

  const tsamAgain = [];
  const rootIterator2 = env.rootFolder.getFoldersByName('TSAM AI');

  while (rootIterator2.hasNext()) {
    tsamAgain.push(rootIterator2.next());
  }

  check('フォルダは増えない', tsamAgain.length === 1, tsamAgain.length);

  check(
    'スプレッドシートは増えない',
    authFolder.files.length === 4,
    authFolder.files.length,
  );

  check(
    '同じスプレッドシートを使い続ける',
    env.properties.AUTH_USER_SPREADSHEET_ID === userBookId,
  );

  check('設定行は増えない', gas.readRows_('settings').length === settingsRowsBefore);
  check('管理者が重複しない', gas.readRows_('users').length === usersBefore);

  check(
    'シークレットは上書きされない（既存セッションを壊さない）',
    env.properties.SESSION_SECRET === secretsBefore.session
    && env.properties.TOKEN_SECRET === secretsBefore.token
    && env.properties.PASSWORD_PEPPER === secretsBefore.pepper
    && env.properties.STRIPE_WEBHOOK_URL_KEY === secretsBefore.webhookKey,
  );

  check(
    'シートも重複しない',
    gas.getUserSpreadsheet_().getSheets().length === 4,
    gas.getUserSpreadsheet_().getSheets().length,
  );

  /* ---------------------------------------------------------------- */
  section('管理者レコードの自己修復');

  /* 運用中に role や payment_exempt が書き換わってしまった場合を再現する。 */
  const adminRow = gas.findUserByEmail_('architect@potenitas.com');
  const updates = {};
  updates[gas.USER_COL.ROLE] = 'member';
  updates[gas.USER_COL.PAYMENT_EXEMPT] = 'FALSE';
  gas.updateUserCells_(adminRow, updates);

  gas.setupAuthSystem();

  const repaired = gas.findUserByEmail_('architect@potenitas.com');
  check('role が admin へ戻る', repaired.role === 'admin');
  check('payment_exempt が TRUE へ戻る', repaired.paymentExempt === true);

  /* ---------------------------------------------------------------- */
  section('設定点検');

  const report2 = gas.checkAuthSetup();

  check('checkAuthSetup が結果を返す', typeof report2 === 'string' && report2.length > 0);
  check(
    'checkAuthSetup は秘密情報の値そのものを出さない',
    !report2.includes(env.properties.SESSION_SECRET)
    && !report2.includes(env.properties.TOKEN_SECRET)
    && !report2.includes(env.properties.PASSWORD_PEPPER),
  );

  check(
    'Stripe 未設定を「未設定」と報告する',
    report2.includes('未設定') && report2.includes('STRIPE_SECRET_KEY'),
  );

  finish();
} catch (error) {
  fatal(error);
}

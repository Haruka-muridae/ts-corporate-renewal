/*
 * カレンダー通知のライセンス発行と照会（gas-auth/Notifier.gs）。
 *
 * ==================================================================
 * ここで固定するもの
 * ==================================================================
 *   1. 発行はログイン必須で、2回目は同じキーを返すこと
 *   2. 照会は共有シークレット必須で、無いと存在すら答えないこと
 *   3. entitlement の切り替え（all_active / plan:<price_id>）
 *   4. **「無効」と「判定できなかった」を混ぜないこと**
 *      Stripe へ届かないときに valid:false を返すと、契約している人の通知が
 *      Stripe の不調だけで止まる。エラー応答にして Workers 側の猶予へ渡す
 *   5. ライセンスキーが画面向けの応答やログへ出ないこと
 * ==================================================================
 */

import { check, section, finish, fatal } from '../../public/apps/tests/helpers/assert.mjs';
import { createReadyEnvironment, setSetting, createActiveUser } from '../helpers/gas-harness.mjs';

const SHARED_SECRET = 'notifier-gate-shared-secret-for-test';

/** doPost をひととおり通して JSON を読む（実運用と同じ経路で確かめる）。 */
function post(env, body) {
  return env.readOutput(env.api.doPost({ postData: { contents: JSON.stringify(body) } }));
}

/** ログイン済みのセッショントークンを取る。 */
function login(env, email, password) {
  const response = post(env, { action: 'login', email, password });

  if (!response.success) {
    throw new Error(`ログインに失敗: ${JSON.stringify(response)}`);
  }

  return response.data.sessionToken;
}

try {
  const env = createReadyEnvironment();

  env.properties.NOTIFIER_SHARED_SECRET = SHARED_SECRET;

  const member = createActiveUser(env, {
    email: 'notifier-member@example.com',
    password: 'Notifier-Member-2026',
  });

  const sessionToken = login(env, member.email, member.password);

  /* ---------------------------------------------------------------- */
  section('ライセンスの発行');

  const first = post(env, { action: 'issueNotifierLicense', sessionToken });

  check('発行に成功する', first.success === true, JSON.stringify(first));
  check(
    'キーは base64url の43文字（32バイト相当）',
    /^[A-Za-z0-9_-]{43}$/.test(first.data.licenseKey),
    first.data.licenseKey,
  );
  check('権利があると答える（既定は all_active）', first.data.entitled === true);

  const second = post(env, { action: 'issueNotifierLicense', sessionToken });

  check(
    '2回目は同じキーを返す（作り直さない）',
    second.data.licenseKey === first.data.licenseKey,
    `${first.data.licenseKey} / ${second.data.licenseKey}`,
  );

  check(
    'users シートへ保存される',
    env.api.findUserByEmail_(member.email).notifierLicenseKey === first.data.licenseKey,
  );

  const anonymous = post(env, { action: 'issueNotifierLicense', sessionToken: 'not-a-session' });

  check('ログインしていなければ発行しない', anonymous.success === false, JSON.stringify(anonymous));
  check('理由はセッション切れ', anonymous.error.code === 'SESSION_INVALID', anonymous.error.code);

  /* 別の利用者には別のキーが出る。 */
  const other = createActiveUser(env, {
    email: 'notifier-other@example.com',
    password: 'Notifier-Other-2026',
  });
  const otherToken = login(env, other.email, other.password);
  const otherLicense = post(env, { action: 'issueNotifierLicense', sessionToken: otherToken });

  check('利用者ごとに別のキーになる', otherLicense.data.licenseKey !== first.data.licenseKey);

  /* ---------------------------------------------------------------- */
  section('ライセンスキーを外へ出さないこと');

  const verifySession = post(env, { action: 'verifySession', sessionToken });

  check(
    'verifySession の応答にライセンスキーが含まれない',
    JSON.stringify(verifySession).includes(first.data.licenseKey) === false,
    JSON.stringify(verifySession),
  );

  check(
    'toPublicUser_ にライセンスキーが含まれない',
    Object.keys(env.api.toPublicUser_(env.api.findUserByEmail_(member.email)))
      .includes('notifierLicenseKey') === false,
  );

  check(
    'ログにライセンスキーを書かない',
    env.logs.join('\n').includes(first.data.licenseKey) === false,
  );

  /* ---------------------------------------------------------------- */
  section('ライセンスの照会（Workers からのサーバー間呼び出し）');

  const verified = post(env, {
    action: 'verifyNotifierLicense',
    secret: SHARED_SECRET,
    licenseKey: first.data.licenseKey,
  });

  check('有効なキーは valid', verified.success === true && verified.data.valid === true, JSON.stringify(verified));
  check('plan を返す', verified.data.plan === 'all_active', verified.data.plan);

  const wrongSecret = post(env, {
    action: 'verifyNotifierLicense',
    secret: 'wrong-secret',
    licenseKey: first.data.licenseKey,
  });

  check('共有シークレットが違えば失敗', wrongSecret.success === false, JSON.stringify(wrongSecret));
  check(
    '鍵の存在に触れない定型エラーを返す',
    wrongSecret.error.code === 'INVALID_REQUEST',
    wrongSecret.error.code,
  );

  const noSecret = post(env, { action: 'verifyNotifierLicense', licenseKey: first.data.licenseKey });

  check('シークレット未指定も失敗', noSecret.success === false);

  const unknownKey = post(env, {
    action: 'verifyNotifierLicense',
    secret: SHARED_SECRET,
    licenseKey: 'ThisKeyDoesNotExistAtAllInTheSheet1234567890',
  });

  check('未知のキーは valid:false', unknownKey.success === true && unknownKey.data.valid === false);
  check('理由は not_found', unknownKey.data.status === 'not_found', unknownKey.data.status);

  const emptyKey = post(env, { action: 'verifyNotifierLicense', secret: SHARED_SECRET, licenseKey: '' });

  check('空のキーが未発行の行と一致しない', emptyKey.data.valid === false, JSON.stringify(emptyKey));

  /* ---------------------------------------------------------------- */
  section('契約状態が変わったとき');

  {
    const user = env.api.findUserByEmail_(member.email);
    const updates = {};

    updates[env.api.USER_COL.SUBSCRIPTION_STATUS] = 'canceled';
    env.api.updateUserCells_(user, updates);

    const canceled = post(env, {
      action: 'verifyNotifierLicense',
      secret: SHARED_SECRET,
      licenseKey: first.data.licenseKey,
    });

    check('解約したら valid:false', canceled.data.valid === false, JSON.stringify(canceled));
    check('理由に契約状態が入る', canceled.data.status === 'canceled', canceled.data.status);

    updates[env.api.USER_COL.SUBSCRIPTION_STATUS] = 'active';
    env.api.updateUserCells_(env.api.findUserByEmail_(member.email), updates);
  }

  {
    const user = env.api.findUserByEmail_(member.email);
    const updates = {};

    updates[env.api.USER_COL.ACCOUNT_STATUS] = 'suspended';
    env.api.updateUserCells_(user, updates);

    const suspended = post(env, {
      action: 'verifyNotifierLicense',
      secret: SHARED_SECRET,
      licenseKey: first.data.licenseKey,
    });

    check('アカウント停止なら valid:false', suspended.data.valid === false, JSON.stringify(suspended));
    check('理由が分かる', suspended.data.status === 'account_suspended', suspended.data.status);

    updates[env.api.USER_COL.ACCOUNT_STATUS] = 'active';
    env.api.updateUserCells_(env.api.findUserByEmail_(member.email), updates);
  }

  /* ---------------------------------------------------------------- */
  section('entitlement の切り替え');

  {
    /* アドオン化した場合を想定して plan: 指定へ切り替える。 */
    setSetting(env, 'NOTIFIER_ENTITLEMENT', 'plan:price_notifier_addon');
    env.properties.STRIPE_SECRET_KEY = 'sk_test_dummy';

    const user = env.api.findUserByEmail_(member.email);
    const updates = {};

    updates[env.api.USER_COL.STRIPE_SUBSCRIPTION_ID] = 'sub_test_1';
    env.api.updateUserCells_(user, updates);

    /* 契約に該当の価格が入っている場合。 */
    env.clearFetchHandlers();
    env.onFetch((url) => {
      if (String(url).includes('subscriptions/sub_test_1')) {
        return {
          status: 200,
          body: { items: { data: [{ price: { id: 'price_notifier_addon' } }] } },
        };
      }

      return null;
    });

    const matched = post(env, {
      action: 'verifyNotifierLicense',
      secret: SHARED_SECRET,
      licenseKey: first.data.licenseKey,
    });

    check('該当プランなら valid', matched.success === true && matched.data.valid === true, JSON.stringify(matched));
    check('plan には価格IDが入る', matched.data.plan === 'price_notifier_addon', matched.data.plan);

    /* 別の価格しか持っていない場合。 */
    env.clearFetchHandlers();
    env.onFetch((url) => {
      if (String(url).includes('subscriptions/sub_test_1')) {
        return {
          status: 200,
          body: { items: { data: [{ price: { id: 'price_basic_only' } }] } },
        };
      }

      return null;
    });

    const mismatched = post(env, {
      action: 'verifyNotifierLicense',
      secret: SHARED_SECRET,
      licenseKey: first.data.licenseKey,
    });

    check('別プランなら valid:false', mismatched.data.valid === false, JSON.stringify(mismatched));
    check('理由は plan_mismatch', mismatched.data.status === 'plan_mismatch', mismatched.data.status);

    /*
     * Stripe へ届かない場合。**ここが本題。**
     * valid:false を返すと、契約している人の通知が Stripe の不調だけで止まる。
     */
    env.clearFetchHandlers();
    env.onFetch((url) => {
      if (String(url).includes('subscriptions/sub_test_1')) {
        return { status: 500, body: { error: { message: 'boom' } } };
      }

      return null;
    });

    const unreachable = post(env, {
      action: 'verifyNotifierLicense',
      secret: SHARED_SECRET,
      licenseKey: first.data.licenseKey,
    });

    check(
      'Stripe へ届かないときは valid:false を返さない',
      unreachable.success === false,
      JSON.stringify(unreachable),
    );
    check(
      'エラー応答にする（Workers 側が猶予に入れる）',
      unreachable.error.code === 'STRIPE_ERROR',
      unreachable.error.code,
    );

    /* 支払い免除の利用者は、plan: 指定でも Stripe を見ずに通る。 */
    const admin = createActiveUser(env, {
      email: 'notifier-exempt@example.com',
      password: 'Notifier-Exempt-2026',
      subscriptionStatus: 'exempt',
      paymentExempt: true,
    });
    const adminToken = login(env, admin.email, admin.password);
    const adminLicense = post(env, { action: 'issueNotifierLicense', sessionToken: adminToken });

    const exempt = post(env, {
      action: 'verifyNotifierLicense',
      secret: SHARED_SECRET,
      licenseKey: adminLicense.data.licenseKey,
    });

    check('支払い免除は plan: 指定でも通る', exempt.data.valid === true, JSON.stringify(exempt));
    check('plan は exempt', exempt.data.plan === 'exempt', exempt.data.plan);

    /* 解釈できない設定値は通さない（打ち間違いで全員が通るのを避ける）。 */
    setSetting(env, 'NOTIFIER_ENTITLEMENT', 'すべての人');

    const unknownRule = post(env, {
      action: 'verifyNotifierLicense',
      secret: SHARED_SECRET,
      licenseKey: first.data.licenseKey,
    });

    check('解釈できない設定値では通さない', unknownRule.data.valid === false, JSON.stringify(unknownRule));
    check('理由が分かる', unknownRule.data.status === 'entitlement_unknown', unknownRule.data.status);

    setSetting(env, 'NOTIFIER_ENTITLEMENT', 'plan:');

    const emptyPlan = post(env, {
      action: 'verifyNotifierLicense',
      secret: SHARED_SECRET,
      licenseKey: first.data.licenseKey,
    });

    check('plan: が空でも通さない', emptyPlan.data.valid === false, JSON.stringify(emptyPlan));

    setSetting(env, 'NOTIFIER_ENTITLEMENT', 'all_active');
    env.clearFetchHandlers();
  }

  /* ---------------------------------------------------------------- */
  section('action ホワイトリスト');

  check(
    'issueNotifierLicense が許可されている',
    env.api.ALLOWED_POST_ACTIONS.includes('issueNotifierLicense'),
  );
  check(
    'verifyNotifierLicense が許可されている',
    env.api.ALLOWED_POST_ACTIONS.includes('verifyNotifierLicense'),
  );
  check(
    '内部関数は action から呼べない',
    env.api.ALLOWED_POST_ACTIONS.includes('evaluateNotifierEntitlement_') === false,
  );

  check(
    '共有シークレットは設定シートから読めない',
    env.api.getSetting_('NOTIFIER_SHARED_SECRET') === '',
  );

  check(
    'users シートの列が末尾に足されている',
    env.api.HEADERS.users[env.api.HEADERS.users.length - 1] === 'notifier_license_key',
    env.api.HEADERS.users.join(','),
  );
  check(
    'USER_COL とヘッダーの位置が一致している',
    env.api.HEADERS.users[env.api.USER_COL.NOTIFIER_LICENSE_KEY - 1] === 'notifier_license_key',
  );

  finish();
} catch (error) {
  fatal(error);
}

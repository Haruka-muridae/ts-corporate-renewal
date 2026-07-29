/*
 * Stripe Checkout と Webhook の検証。
 *
 * ==================================================================
 * 特に確かめること
 * ==================================================================
 *   - 偽の Webhook を受け付けないこと
 *     （URLの合言葉、Stripe APIへの照会、署名の3つ）
 *   - 同じイベントを2回受けても2重に処理しないこと
 *   - 決済完了で利用者が作られ、初期設定メールが送られること
 *   - 契約更新・解約・支払失敗が反映されること
 *   - 秘密鍵が応答やログへ漏れないこと
 * ==================================================================
 */

import { createHmac } from 'node:crypto';

import { check, section, finish, fatal } from '../../apps/tests/helpers/assert.mjs';
import { createReadyEnvironment, setSetting } from '../helpers/gas-harness.mjs';

const SECRET_KEY = 'sk_test_do_not_use_for_real_0000000000';
const WEBHOOK_SECRET = 'whsec_test_signing_secret_0000000000';
const WEBHOOK_URL_KEY = 'url-key-for-testing-0123456789';

try {
  const env = createReadyEnvironment();
  const gas = env.api;

  env.properties.STRIPE_SECRET_KEY = SECRET_KEY;
  env.properties.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
  env.properties.STRIPE_WEBHOOK_URL_KEY = WEBHOOK_URL_KEY;

  /* 有効なプランを1つ用意する。 */
  const plansSheet = gas.getConfigSpreadsheet_().getSheetByName('plans');
  plansSheet.rows[1] = [
    'standard', 'スタンダード', 'price_test_standard', '9800', 'jpy', 'month',
    'TSAM AI の各種アプリ\nメールサポート', 'TRUE',
  ];
  plansSheet.appendRow([
    'disabled-plan', '停止中プラン', 'price_test_disabled', '100', 'jpy', 'month', '', 'FALSE',
  ]);
  gas.clearSettingsCache_();

  /* ---------------------------------------------------------------- */
  section('プラン一覧');

  const plans = gas.listPublicPlans_();

  check('有効なプランだけが返る', plans.length === 1, plans.length);
  check('プランコードが返る', plans[0].planCode === 'standard');
  check('プラン名が返る', plans[0].planName === 'スタンダード');
  check('金額が返る', plans[0].amount === '9800');
  check('支払周期が返る', plans[0].interval === 'month');
  check('機能一覧が配列で返る', Array.isArray(plans[0].features) && plans[0].features.length === 2);

  check(
    'Price ID はフロントへ返さない',
    !Object.prototype.hasOwnProperty.call(plans[0], 'priceId')
    && !JSON.stringify(plans).includes('price_test_standard'),
  );

  check('無効なプランは引けない', gas.findPlanByCode_('disabled-plan') === null);
  check('存在しないプランは引けない', gas.findPlanByCode_('nope') === null);
  check('サーバー側では Price ID を引ける', gas.findPlanByCode_('standard').priceId === 'price_test_standard');

  /* ---------------------------------------------------------------- */
  section('Checkout Session の作成');

  env.onFetch((url, options) => {
    if (url.includes('checkout/sessions') && options.method === 'post') {
      return {
        status: 200,
        body: { id: 'cs_test_123', url: 'https://checkout.stripe.com/c/pay/cs_test_123' },
      };
    }

    return null;
  });

  const created = gas.createCheckoutSession_({ planCode: 'standard', email: 'buyer@example.com' });

  check('Checkout Session を作成できる', created.ok === true);
  check('決済画面のURLが返る', created.data.checkoutUrl.startsWith('https://checkout.stripe.com/'));
  check('セッションIDが返る', created.data.checkoutSessionId === 'cs_test_123');

  const request = env.fetchCalls[env.fetchCalls.length - 1];
  const payload = decodeURIComponent(request.options.payload);

  check('秘密鍵は Authorization ヘッダーで送る', request.options.headers.Authorization === `Bearer ${SECRET_KEY}`);
  check('秘密鍵は本文に入れない', !payload.includes(SECRET_KEY));
  check('サブスクリプションとして作成する', payload.includes('mode=subscription'));
  check('サーバー側で解決した Price ID を使う', payload.includes('price_test_standard'));
  check('成功URLにセッションIDの差し込みがある', payload.includes('{CHECKOUT_SESSION_ID}'));
  check('キャンセルURLを渡す', payload.includes('payment/cancel/'));
  check('入力されたメールアドレスを渡す', payload.includes('buyer@example.com'));
  check('プランコードを metadata に残す', payload.includes('plan_code'));

  check(
    '応答に秘密鍵が含まれない',
    !JSON.stringify(created).includes(SECRET_KEY),
  );

  check(
    '無効なプランでは作成しない',
    gas.createCheckoutSession_({ planCode: 'disabled-plan' }).errorPair[0] === 'PLAN_NOT_FOUND',
  );

  check(
    '存在しないプランでは作成しない',
    gas.createCheckoutSession_({ planCode: 'nope' }).errorPair[0] === 'PLAN_NOT_FOUND',
  );

  check(
    'Price ID を直接指定されても無視する（プランコードしか見ない）',
    gas.createCheckoutSession_({
      planCode: 'nope',
      priceId: 'price_attacker_controlled',
    }).errorPair[0] === 'PLAN_NOT_FOUND',
  );

  check(
    'Stripe 未設定なら作成しない',
    (() => {
      const before = env.properties.STRIPE_SECRET_KEY;
      delete env.properties.STRIPE_SECRET_KEY;
      const result = gas.createCheckoutSession_({ planCode: 'standard' });
      env.properties.STRIPE_SECRET_KEY = before;
      return result.errorPair[0] === 'NOT_CONFIGURED';
    })(),
  );

  check(
    '作成上限を超えると断る',
    (() => {
      setSetting(env, 'CHECKOUT_HOURLY_LIMIT', '2');

      gas.createCheckoutSession_({ planCode: 'standard' });
      gas.createCheckoutSession_({ planCode: 'standard' });
      const third = gas.createCheckoutSession_({ planCode: 'standard' });

      setSetting(env, 'CHECKOUT_HOURLY_LIMIT', '60');
      return third.errorPair[0] === 'RATE_LIMITED';
    })(),
  );

  /* ---------------------------------------------------------------- */
  section('Webhook: 受け付けない場合');

  /* Stripe API への照会に応じるハンドラ。イベントの正本はここが返す。 */
  const stripeEvents = new Map();

  env.clearFetchHandlers();
  env.onFetch((url, options) => {
    if (url.includes('checkout/sessions') && options.method === 'post') {
      return { status: 200, body: { id: 'cs_test_123', url: 'https://checkout.stripe.com/c/pay/cs_test_123' } };
    }

    const match = url.match(/\/v1\/events\/(evt_[A-Za-z0-9_]+)/);

    if (match) {
      const event = stripeEvents.get(match[1]);

      return event
        ? { status: 200, body: event }
        : { status: 404, body: { error: { message: 'No such event' } } };
    }

    return null;
  });

  function makeEvent(id, type, object) {
    const event = { id, type, data: { object } };
    stripeEvents.set(id, event);
    return event;
  }

  function post(event, { key = WEBHOOK_URL_KEY, body = null, sig = null } = {}) {
    const parameter = { path: 'stripe-webhook', k: key };

    if (sig !== null) {
      parameter.sig = sig;
    }

    return env.readOutput(gas.doPost({
      parameter,
      postData: { contents: body ?? JSON.stringify(event) },
    }));
  }

  const realEvent = makeEvent('evt_checkout_1', 'checkout.session.completed', {
    id: 'cs_test_123',
    customer: 'cus_test_1',
    subscription: 'sub_test_1',
    customer_details: { email: 'Buyer@Example.com' },
  });

  check(
    'URLの合言葉が違えば拒否する',
    post(realEvent, { key: 'wrong-key' }).success === false,
  );

  check(
    '合言葉が空でも拒否する',
    post(realEvent, { key: '' }).success === false,
  );

  check(
    '合言葉が未設定なら受信そのものを拒否する',
    (() => {
      const before = env.properties.STRIPE_WEBHOOK_URL_KEY;
      delete env.properties.STRIPE_WEBHOOK_URL_KEY;
      const result = post(realEvent);
      env.properties.STRIPE_WEBHOOK_URL_KEY = before;
      return result.success === false && result.error.code === 'NOT_CONFIGURED';
    })(),
  );

  check(
    '本文が JSON でなければ拒否する',
    post(null, { body: 'not json' }).success === false,
  );

  check(
    'イベントIDが無ければ拒否する',
    post(null, { body: JSON.stringify({ type: 'checkout.session.completed' }) }).success === false,
  );

  check(
    'イベントIDの形式が不正なら拒否する',
    post(null, { body: JSON.stringify({ id: '../../etc/passwd', type: 'x' }) }).success === false,
  );

  /*
   * 本命。攻撃者が本物そっくりの本文を送っても、
   * Stripe 側に実在しないイベントIDなら処理されない。
   */
  const forged = {
    id: 'evt_forged_by_attacker',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_forged',
        customer: 'cus_forged',
        subscription: 'sub_forged',
        customer_details: { email: 'attacker@example.com' },
      },
    },
  };

  const forgedResult = post(forged);

  check('Stripeに実在しないイベントは拒否する', forgedResult.success === false);
  check(
    '偽イベントで利用者が作られない',
    gas.findUserByEmail_('attacker@example.com') === null,
  );

  /*
   * 本文だけ差し替えた攻撃。IDは実在するが、中身は攻撃者のもの。
   * 照会結果だけを使うため、本文の中身は無視されなければならない。
   */
  const tamperedBody = JSON.stringify({
    id: 'evt_checkout_1',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_test_123',
        customer: 'cus_test_1',
        subscription: 'sub_test_1',
        customer_details: { email: 'hijacker@example.com' },
      },
    },
  });

  post(realEvent, { body: tamperedBody });

  check(
    '本文を差し替えても、Stripe から取得した内容だけが使われる',
    gas.findUserByEmail_('hijacker@example.com') === null,
  );

  check(
    'その結果、本物のメールアドレスで利用者が作られる',
    gas.findUserByEmail_('buyer@example.com') !== null,
  );

  /* ---------------------------------------------------------------- */
  section('Webhook: 署名の検証（中継を置いた場合）');

  const signedEvent = makeEvent('evt_signed_1', 'invoice.paid', {
    customer: 'cus_test_1',
    subscription: 'sub_test_1',
  });

  const signedBody = JSON.stringify(signedEvent);
  const timestamp = Math.floor(env.getTime() / 1000);
  const signature = createHmac('sha256', WEBHOOK_SECRET)
    .update(`${timestamp}.${signedBody}`)
    .digest('hex');

  check(
    '正しい署名なら受け付ける',
    post(signedEvent, { sig: `t=${timestamp},v1=${signature}` }).success === true,
  );

  check(
    '署名が不正なら拒否する',
    post(makeEvent('evt_signed_2', 'invoice.paid', { customer: 'cus_test_1' }), {
      sig: `t=${timestamp},v1=${'0'.repeat(64)}`,
    }).success === false,
  );

  check(
    '不正な署名のイベントは記録されない（処理に進まない）',
    gas.findRows_('stripe_events', (values) => (
      String(values[gas.EVENT_COL.EVENT_ID - 1]).trim() === 'evt_signed_2'
    )).length === 0,
  );

  /* ---------------------------------------------------------------- */
  section('決済完了で利用者が作られる');

  const buyer = gas.findUserByEmail_('buyer@example.com');

  check('利用者が作られる', buyer !== null);
  check('メールアドレスが正規化される（小文字）', buyer.email === 'buyer@example.com');
  check('Stripe の顧客IDが入る', buyer.stripeCustomerId === 'cus_test_1');
  check('契約IDが入る', buyer.stripeSubscriptionId === 'sub_test_1');
  check('契約状態が active', buyer.subscriptionStatus === 'active');
  check('アカウント状態は pending（パスワード未設定）', buyer.accountStatus === 'pending');
  check('パスワードは未設定', buyer.passwordHash === '');
  check('payment_exempt は FALSE', buyer.paymentExempt === false);
  check('role は member', buyer.role === 'member');

  check(
    'この時点ではまだログインできない',
    gas.performLogin_({ email: 'buyer@example.com', password: 'anything' }).ok === false,
  );

  const setupMail = env.sentMails.find((mail) => mail.to === 'buyer@example.com');

  check('初期設定の案内メールが送られる', setupMail !== undefined);
  check('件名が初期設定の案内', setupMail.subject.includes('パスワードの初期設定'));
  check('本文にURLが載る', setupMail.body.includes('/password/setup/?token='));
  check('本文にパスワードは載らない', !/パスワード[:：]\s*\S/.test(setupMail.body));

  const setupToken = setupMail.body.match(/token=([A-Za-z0-9_-]+)/)[1];

  const setupResult = gas.performPasswordSet_({
    token: setupToken,
    password: 'Buyer-Password-2026',
    passwordConfirm: 'Buyer-Password-2026',
    expectedType: 'initial_setup',
  });

  check('メールのリンクでパスワードを設定できる', setupResult.ok === true);
  check(
    '設定後は active になる',
    gas.findUserByEmail_('buyer@example.com').accountStatus === 'active',
  );

  check(
    '設定後はログインできる',
    gas.performLogin_({
      email: 'buyer@example.com',
      password: 'Buyer-Password-2026',
      remember: false,
    }).ok === true,
  );

  /* ---------------------------------------------------------------- */
  section('冪等性（同じイベントを2回受けても2重処理しない）');

  const usersBefore = gas.readRows_('users').length;
  const mailsBefore = env.sentMails.length;

  const again = post(realEvent);

  check('2回目も正常応答を返す（Stripeの再送を失敗させない）', again.success === true);
  check('重複として扱う', again.data.status === 'duplicate');
  check('利用者は増えない', gas.readRows_('users').length === usersBefore);
  check('メールも再送されない', env.sentMails.length === mailsBefore);

  const eventRows = gas.findRows_('stripe_events', (values) => (
    String(values[gas.EVENT_COL.EVENT_ID - 1]).trim() === 'evt_checkout_1'
  ));

  check('stripe_events の行も1つだけ', eventRows.length === 1, eventRows.length);
  check(
    '処理済みとして記録される',
    String(eventRows[0].values[gas.EVENT_COL.PROCESSING_STATUS - 1]) === 'processed',
  );
  check(
    '処理時刻が入る',
    String(eventRows[0].values[gas.EVENT_COL.PROCESSED_AT - 1]) !== '',
  );

  check(
    '未対応のイベント種別は記録だけして無視する',
    (() => {
      const other = makeEvent('evt_other_1', 'customer.created', { id: 'cus_x' });
      const result = post(other);

      return result.success === true && result.data.status === 'ignored';
    })(),
  );

  /* ---------------------------------------------------------------- */
  section('契約状態の反映');

  const scenarios = [
    ['evt_sub_updated', 'customer.subscription.updated', { id: 'sub_test_1', customer: 'cus_test_1', status: 'past_due' }, 'past_due'],
    ['evt_invoice_paid', 'invoice.paid', { subscription: 'sub_test_1', customer: 'cus_test_1' }, 'active'],
    ['evt_invoice_failed', 'invoice.payment_failed', { subscription: 'sub_test_1', customer: 'cus_test_1' }, 'past_due'],
    ['evt_sub_trial', 'customer.subscription.updated', { id: 'sub_test_1', customer: 'cus_test_1', status: 'trialing' }, 'trialing'],
    ['evt_sub_deleted', 'customer.subscription.deleted', { id: 'sub_test_1', customer: 'cus_test_1', status: 'canceled' }, 'canceled'],
  ];

  for (const [id, type, object, expected] of scenarios) {
    post(makeEvent(id, type, object));

    check(
      `${type} → subscription_status=${expected}`,
      gas.findUserByEmail_('buyer@example.com').subscriptionStatus === expected,
      gas.findUserByEmail_('buyer@example.com').subscriptionStatus,
    );
  }

  check(
    '解約してもアカウントは無効化しない（再契約で戻れるようにする）',
    gas.findUserByEmail_('buyer@example.com').accountStatus === 'active',
  );

  check(
    '解約後はログインできない',
    gas.performLogin_({
      email: 'buyer@example.com',
      password: 'Buyer-Password-2026',
      remember: false,
    }).ok === false,
  );

  check(
    '再契約すればログインできる',
    (() => {
      post(makeEvent('evt_sub_resumed', 'customer.subscription.updated', {
        id: 'sub_test_1', customer: 'cus_test_1', status: 'active',
      }));

      return gas.performLogin_({
        email: 'buyer@example.com',
        password: 'Buyer-Password-2026',
        remember: false,
      }).ok === true;
    })(),
  );

  /* ---------------------------------------------------------------- */
  section('既存利用者の再購入（重複登録しない）');

  const beforeRepeat = gas.readRows_('users').length;

  post(makeEvent('evt_checkout_repeat', 'checkout.session.completed', {
    id: 'cs_test_repeat',
    customer: 'cus_test_1',
    subscription: 'sub_test_1',
    customer_details: { email: 'buyer@example.com' },
  }));

  check('同じ利用者が二重に作られない', gas.readRows_('users').length === beforeRepeat);

  check(
    'パスワード設定済みなら案内メールを送り直さない',
    !env.sentMails
      .slice(mailsBefore)
      .some((mail) => mail.to === 'buyer@example.com' && mail.subject.includes('初期設定')),
  );

  check(
    'メールアドレスが違っても顧客IDが同じなら同一人物として扱う',
    (() => {
      const before = gas.readRows_('users').length;

      post(makeEvent('evt_checkout_same_customer', 'checkout.session.completed', {
        id: 'cs_other',
        customer: 'cus_test_1',
        subscription: 'sub_other',
        customer_details: { email: 'buyer-alias@example.com' },
      }));

      return gas.readRows_('users').length === before;
    })(),
  );

  check(
    'パスワード未設定のまま再購入すると案内を送り直す',
    (() => {
      post(makeEvent('evt_checkout_pending', 'checkout.session.completed', {
        id: 'cs_pending',
        customer: 'cus_pending',
        subscription: 'sub_pending',
        customer_details: { email: 'pending-buyer@example.com' },
      }));

      const mailsAfterFirst = env.sentMails.length;

      post(makeEvent('evt_checkout_pending_2', 'checkout.session.completed', {
        id: 'cs_pending_2',
        customer: 'cus_pending',
        subscription: 'sub_pending',
        customer_details: { email: 'pending-buyer@example.com' },
      }));

      return env.sentMails.length > mailsAfterFirst;
    })(),
  );

  /* ---------------------------------------------------------------- */
  section('決済完了画面の状態確認');

  env.onFetch((url) => {
    if (url.includes('checkout/sessions/cs_test_123') && !url.includes('events')) {
      return {
        status: 200,
        body: {
          id: 'cs_test_123',
          payment_status: 'paid',
          customer_details: { email: 'buyer@example.com' },
        },
      };
    }

    return null;
  });

  const status = gas.getCheckoutStatus_('cs_test_123');

  check('決済状態を取得できる', status.ok === true);
  check('paymentStatus が返る', status.data.paymentStatus === 'paid');
  check('メールアドレスはマスクして返す', status.data.emailMasked === 'b***@example.com');
  check('全体のメールアドレスは返さない', !JSON.stringify(status.data).includes('buyer@example.com'));
  check('登録済みかどうかが返る', status.data.accountReady === true);

  check(
    '不正な形式のセッションIDを拒否する',
    gas.getCheckoutStatus_('../../secret').errorPair[0] === 'INVALID_REQUEST',
  );

  check('空のセッションIDを拒否する', gas.getCheckoutStatus_('').errorPair[0] === 'INVALID_REQUEST');

  /* ---------------------------------------------------------------- */
  section('秘密情報の漏れがないこと');

  const allSheets = ['users', 'sessions', 'password_tokens', 'stripe_events',
    'login_logs', 'admin_action_logs', 'system_error_logs', 'settings', 'plans'];

  let leaked = false;

  for (const name of allSheets) {
    const text = gas.readRows_(name).map((row) => row.join(' ')).join(' ');

    if (text.includes(SECRET_KEY) || text.includes(WEBHOOK_SECRET) || text.includes(WEBHOOK_URL_KEY)) {
      leaked = true;
    }
  }

  check('どのシートにも秘密情報が書かれていない', !leaked);

  check(
    '実行ログにも秘密情報が出ていない',
    !env.logs.join('\n').includes(SECRET_KEY)
    && !env.logs.join('\n').includes(WEBHOOK_SECRET),
  );

  check(
    'publicConfig に秘密情報が含まれない',
    !JSON.stringify(gas.buildPublicConfig_()).includes(SECRET_KEY),
  );

  finish();
} catch (error) {
  fatal(error);
}

/*
 * 申込み前の同意の検証。
 *
 * ==================================================================
 * 特に確かめること
 * ==================================================================
 *   - 画面のチェックを外しても、サーバーが必須項目を確かめること
 *   - 規約を改訂したら、古い版の同意では申し込めなくなること
 *   - 文言がコードではなくスプレッドシートで管理されていること
 *   - セットアップを2回実行しても初期データが重複しないこと
 *   - 運用側が編集した文言をセットアップが上書きしないこと
 * ==================================================================
 */

import { check, section, finish, fatal } from '../../apps/tests/helpers/assert.mjs';
import { createReadyEnvironment, setSetting } from '../helpers/gas-harness.mjs';

const SECRET_KEY = 'sk_test_do_not_use_for_real_0000000000';

try {
  const env = createReadyEnvironment();
  const gas = env.api;

  env.properties.STRIPE_SECRET_KEY = SECRET_KEY;

  /* 有効なプランを1つ用意する。 */
  const plansSheet = gas.getConfigSpreadsheet_().getSheetByName('plans');
  plansSheet.rows[1] = [
    'standard', 'スタンダード', 'price_test_standard', '550', 'jpy', 'month',
    'TSAM AI の各種アプリ', 'TRUE',
  ];
  gas.clearSettingsCache_();

  env.onFetch((url, options) => {
    if (url.includes('checkout/sessions') && options.method === 'post') {
      return {
        status: 200,
        body: { id: 'cs_test_123', url: 'https://checkout.stripe.com/c/pay/cs_test_123' },
      };
    }

    return null;
  });

  /* ---------------------------------------------------------------- */
  section('セットアップで作られるシート');

  check(
    'consent_items シートができる',
    gas.getConfigSpreadsheet_().getSheetByName('consent_items') !== null,
  );

  check(
    'confirm_sections シートができる',
    gas.getConfigSpreadsheet_().getSheetByName('confirm_sections') !== null,
  );

  check(
    'consent_items のヘッダーが仕様どおり',
    JSON.stringify(gas.HEADERS.consent_items)
      === JSON.stringify(['item_id', 'label', 'required', 'sort_order', 'enabled']),
  );

  check(
    'confirm_sections のヘッダーが仕様どおり',
    JSON.stringify(gas.HEADERS.confirm_sections)
      === JSON.stringify(['section', 'item_label', 'item_value', 'emphasis', 'sort_order']),
  );

  check('初期データが4件入る', gas.readRows_('consent_items').length === 4, gas.readRows_('consent_items').length);
  check('確認表の初期データが入る', gas.readRows_('confirm_sections').length === 11, gas.readRows_('confirm_sections').length);

  check('TOS_VERSION の既定は 1.0', gas.getTosVersion_() === '1.0');

  check(
    '警告文が設定シートで管理されている',
    gas.getSetting_('CONSENT_WARNING_TEXT').includes('550円'),
  );

  /* ---------------------------------------------------------------- */
  section('listConsentConfig の応答');

  const config = env.readOutput(gas.doGet({ parameter: { action: 'listConsentConfig' } }));

  check('成功で返る', config.success === true);
  check('tosVersion が入る', config.data.tosVersion === '1.0');
  check('warningText が入る', typeof config.data.warningText === 'string' && config.data.warningText !== '');
  check('consentItems が配列', Array.isArray(config.data.consentItems));
  check('confirmSections が配列', Array.isArray(config.data.confirmSections));

  check('同意項目が4件返る', config.data.consentItems.length === 4, config.data.consentItems.length);

  check(
    '4項目すべてが必須',
    config.data.consentItems.every((item) => item.required === true),
  );

  check(
    'sort_order の順に並ぶ',
    config.data.consentItems.map((item) => item.itemId).join(',')
      === 'tos,auto_renew,api_cost,cancel_policy',
    config.data.consentItems.map((item) => item.itemId).join(','),
  );

  check(
    '規約とポリシーへの差し込みが文言に含まれる',
    config.data.consentItems[0].label.includes('{terms}')
    && config.data.consentItems[0].label.includes('{privacy}'),
  );

  check(
    '特商法への差し込みも含まれる',
    config.data.consentItems.some((item) => item.label.includes('{tokusho}')),
  );

  check(
    '確認表がセクションごとにまとまる',
    config.data.confirmSections.map((s) => s.section).join(' / ')
      === '料金と支払い / 契約期間と自動更新 / API利用料 / 解約',
    config.data.confirmSections.map((s) => s.section).join(' / '),
  );

  check(
    '特商法が求める項目を網羅する',
    (() => {
      const all = JSON.stringify(config.data.confirmSections);
      return ['550円', '自動更新', '毎月自動決済', '1か月', '解約', '返金', 'API']
        .every((word) => all.includes(word));
    })(),
  );

  check(
    '強調指定が伝わる',
    config.data.confirmSections[0].items.some((item) => item.emphasis === true),
  );

  check(
    '秘密情報を含まない',
    !JSON.stringify(config).includes(SECRET_KEY)
    && !JSON.stringify(config).includes('price_test_standard'),
  );

  check('認証は不要（GET で取得できる）', config.success === true);

  /* ---------------------------------------------------------------- */
  section('enabled=FALSE の除外');

  const consentSheet = gas.getConfigSpreadsheet_().getSheetByName('consent_items');
  consentSheet.rows[2][gas.CONSENT_COL.ENABLED - 1] = 'FALSE';

  check(
    '無効にした項目は返らない',
    gas.listConsentItems_().length === 3,
    gas.listConsentItems_().length,
  );

  check(
    '無効にした項目は必須一覧からも外れる',
    !gas.listRequiredConsentIds_().includes('auto_renew'),
  );

  consentSheet.rows[2][gas.CONSENT_COL.ENABLED - 1] = 'TRUE';

  check('戻せば再び返る', gas.listConsentItems_().length === 4);

  /* ---------------------------------------------------------------- */
  section('申込み時の同意検証');

  const ALL = gas.listRequiredConsentIds_();
  const VERSION = gas.getTosVersion_();

  function checkout(overrides) {
    return gas.createCheckoutSession_(Object.assign({
      planCode: 'standard',
      agreedItems: ALL,
      tosVersion: VERSION,
    }, overrides || {}));
  }

  check('必須をすべて満たせば作成できる', checkout().ok === true);

  check(
    'agreedItems が無ければ拒否する',
    checkout({ agreedItems: undefined }).errorPair[0] === 'INVALID_REQUEST',
  );

  check(
    'agreedItems が配列でなければ拒否する',
    checkout({ agreedItems: 'tos,auto_renew' }).errorPair[0] === 'INVALID_REQUEST',
  );

  check(
    '空配列（何も同意していない）を拒否する',
    checkout({ agreedItems: [] }).errorPair[0] === 'INVALID_REQUEST',
  );

  check(
    '必須が1つでも欠けたら拒否する',
    checkout({ agreedItems: ALL.slice(0, ALL.length - 1) }).errorPair[0] === 'INVALID_REQUEST',
  );

  check(
    '別の項目で埋め合わせても拒否する',
    checkout({ agreedItems: ['tos', 'tos', 'tos', 'tos'] }).errorPair[0] === 'INVALID_REQUEST',
  );

  check(
    'tosVersion が無ければ拒否する',
    checkout({ tosVersion: undefined }).errorPair[0] === 'INVALID_REQUEST',
  );

  check(
    'tosVersion が現行と違えば拒否する',
    checkout({ tosVersion: '0.9' }).errorPair[0] === 'INVALID_REQUEST',
  );

  check(
    '拒否の理由は画面へ返さない（定型文のみ）',
    checkout({ agreedItems: [] }).errorPair[1] === 'リクエストの形式が不正です。',
  );

  check(
    '拒否の理由はシステムログにだけ残る',
    gas.readRows_('system_error_logs')
      .some((row) => String(row[2]).includes('REQUIRED_NOT_AGREED')),
  );

  check(
    '余分な項目が混ざっていても必須が揃っていれば通る',
    checkout({ agreedItems: ALL.concat(['unknown_item']) }).ok === true,
  );

  /* ---------------------------------------------------------------- */
  section('規約改訂への追随');

  setSetting(env, 'TOS_VERSION', '2.0');

  check(
    '改訂後は古い版の同意を拒否する',
    checkout({ tosVersion: '1.0' }).errorPair[0] === 'INVALID_REQUEST',
  );

  check(
    '新しい版なら通る',
    checkout({ tosVersion: '2.0' }).ok === true,
  );

  check(
    'listConsentConfig も新しい版を返す',
    env.readOutput(gas.doGet({ parameter: { action: 'listConsentConfig' } })).data.tosVersion === '2.0',
  );

  setSetting(env, 'TOS_VERSION', '1.0');

  /* ---------------------------------------------------------------- */
  section('Checkout へ渡る同意の記録');

  checkout({ email: 'buyer@example.com' });

  const request = env.fetchCalls[env.fetchCalls.length - 1];
  const payload = decodeURIComponent(request.options.payload);

  check('metadata に規約の版が入る', payload.includes('metadata[tos_version]=1.0'));
  check('metadata に同意日時が入る', /metadata\[tos_agreed_at\]=\d{4}-\d{2}-\d{2}T/.test(payload));
  check('metadata に同意項目が入る', payload.includes('metadata[agreed_items]='));

  check(
    '同意項目はカンマ区切りで入る',
    ALL.every((id) => payload.includes(id)),
  );

  check('プランコードも従来どおり入る', payload.includes('metadata[plan_code]=standard'));

  /* ---------------------------------------------------------------- */
  section('セットアップの冪等性');

  const consentBefore = gas.readRows_('consent_items').length;
  const confirmBefore = gas.readRows_('confirm_sections').length;

  /* 運用側が文言を直した状態を再現する。 */
  consentSheet.rows[1][gas.CONSENT_COL.LABEL - 1] = '運用側が書き換えた文言';

  gas.setupAuthSystem();
  gas.setupAuthSystem();

  check('同意項目が増えない', gas.readRows_('consent_items').length === consentBefore);
  check('確認表も増えない', gas.readRows_('confirm_sections').length === confirmBefore);

  check(
    '運用側が編集した文言を上書きしない',
    gas.listConsentItems_()[0].label === '運用側が書き換えた文言',
    gas.listConsentItems_()[0].label,
  );

  check(
    'TOS_VERSION の設定行も重複しない',
    gas.readRows_('settings').filter((row) => String(row[0]).trim() === 'TOS_VERSION').length === 1,
  );

  finish();
} catch (error) {
  fatal(error);
}

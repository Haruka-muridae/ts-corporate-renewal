/*
 * 申込フォームの検証と Checkout Session の組み立ての確認
 * （実装仕様書 4.2 / 5.1 / 5.2、受入条件 3・8）。
 *
 * ==================================================================
 * 特に確かめること
 * ==================================================================
 *   - 同意3つが揃わなければ通さないこと（受入条件8）
 *   - ブラウザから送られた金額を一切使わないこと（受入条件3）
 *   - JPYの unit_amount に円額をそのまま入れること（100倍しない）
 *   - 明細書表記のサフィックスを必ず指定すること（仕様書5.2）
 *   - 出禁の申告が未選択のまま「該当しない」に倒れないこと
 * ==================================================================
 */

import { check, section, finish, fatal } from '../../public/apps/tests/helpers/assert.mjs';

import {
  validateApplicationInput,
  toKatakana,
  MAX_LENGTHS,
  CONSENT_FIELDS,
} from '../../lib/event/application-input.mjs';

import {
  buildCheckoutSessionParams,
  createCheckoutSession,
  toFormEncoded,
  STATEMENT_DESCRIPTOR_SUFFIX,
  STATEMENT_DESCRIPTOR_SUFFIX_KANJI,
  STATEMENT_DESCRIPTOR_SUFFIX_KANA,
} from '../../lib/event/stripe.mjs';

import { calculatePrice } from '../../lib/event/pricing.mjs';

const VALID = {
  eventId: '11111111-2222-3333-4444-555555555555',
  name: '山田 太郎',
  nameKana: 'ヤマダ タロウ',
  email: 'taro@example.com',
  phone: '090-1234-5678',
  company: '株式会社テスト',
  department: '開発部',
  jobTitle: '課長',
  industry: 'it',
  occupation: 'engineer',
  position: 'manager',
  ageGroup: '24+',
  isBannedDeclared: 'no',
  agreeTerms: 'on',
  agreeCancelPolicy: 'on',
  agreePrivacy: 'on',
};

try {
  /* ---------------------------------------------------------------- */
  section('正しい入力');

  const ok = validateApplicationInput(VALID);

  check('合格する', ok.ok === true, JSON.stringify(ok.errors));
  check('氏名', ok.value.name === '山田 太郎');
  check('メール', ok.value.email === 'taro@example.com');
  check('会社名', ok.value.company === '株式会社テスト');
  check('部署名・役職名は任意でも保存される',
    ok.value.department === '開発部' && ok.value.jobTitle === '課長');
  check('出禁の申告は false', ok.value.isBannedDeclared === false);
  check('参加日（eventId）が保存される', ok.value.eventId === VALID.eventId);

  const optional = validateApplicationInput({ ...VALID, department: '', jobTitle: '' });
  check('部署名・役職名は空でも合格する', optional.ok === true);
  check('空の任意項目は null にする',
    optional.value.department === null && optional.value.jobTitle === null);

  /* ---------------------------------------------------------------- */
  section('必須項目');

  const requiredFields = ['name', 'nameKana', 'email', 'phone', 'company'];

  requiredFields.forEach((field) => {
    const result = validateApplicationInput({ ...VALID, [field]: '' });
    check(`${field} が空なら不合格`, result.ok === false && Boolean(result.errors[field]));
  });

  ['industry', 'occupation', 'position', 'ageGroup'].forEach((field) => {
    const result = validateApplicationInput({ ...VALID, [field]: '' });
    check(`${field} が未選択なら不合格`, result.ok === false && Boolean(result.errors[field]));
  });

  check('前後の空白は落とす',
    validateApplicationInput({ ...VALID, name: '　山田 太郎　' }).value.name === '山田 太郎');

  check('空白だけの必須項目は空とみなす',
    validateApplicationInput({ ...VALID, name: '　　' }).ok === false);

  /* ---------------------------------------------------------------- */
  section('参加日（events.id）');

  check('未選択なら不合格（「参加日を選択してください」）',
    validateApplicationInput({ ...VALID, eventId: '' }).errors.eventId
      === '参加日を選択してください');

  check('UUID形式でなければ不合格',
    validateApplicationInput({ ...VALID, eventId: 'not-a-uuid' }).ok === false);

  check('数字だけの値も不合格（旧仕様の連番IDを誤って送っても通さない）',
    validateApplicationInput({ ...VALID, eventId: '12345' }).ok === false);

  check('大文字のUUIDも通る（Google側の表記ゆれを想定しない前提だが、形式は緩める）',
    validateApplicationInput({
      ...VALID, eventId: VALID.eventId.toUpperCase(),
    }).ok === true);

  /* ---------------------------------------------------------------- */
  section('同意項目（受入条件8）');

  CONSENT_FIELDS.forEach((field) => {
    const result = validateApplicationInput({ ...VALID, [field]: undefined });
    check(`${field} が未チェックなら決済へ進ませない`,
      result.ok === false && result.errors[field] === '同意が必要です');
  });

  const noConsent = validateApplicationInput({
    ...VALID, agreeTerms: undefined, agreeCancelPolicy: undefined, agreePrivacy: undefined,
  });

  check('3つとも未チェックなら3件とも報告する',
    CONSENT_FIELDS.every((field) => Boolean(noConsent.errors[field])));

  check('チェック済みは true でも受け付ける',
    validateApplicationInput({
      ...VALID, agreeTerms: true, agreeCancelPolicy: 'true', agreePrivacy: 'on',
    }).ok === true);

  /* ---------------------------------------------------------------- */
  section('出禁の申告');

  check('未選択なら不合格（「該当しない」に倒さない）',
    validateApplicationInput({ ...VALID, isBannedDeclared: '' }).ok === false);

  check('想定外の値も不合格',
    validateApplicationInput({ ...VALID, isBannedDeclared: 'maybe' }).ok === false);

  check('yes は true',
    validateApplicationInput({ ...VALID, isBannedDeclared: 'yes' }).value.isBannedDeclared === true);

  /* ---------------------------------------------------------------- */
  section('その他の自由記述');

  check('業界がその他なら自由記述が必須',
    validateApplicationInput({ ...VALID, industry: 'other', industryOtherText: '' }).ok === false);

  check('業界がその他で自由記述があれば合格',
    validateApplicationInput({
      ...VALID, industry: 'other', industryOtherText: '農業',
    }).value.industryOtherText === '農業');

  check('職種がその他なら自由記述が必須',
    validateApplicationInput({ ...VALID, occupation: 'other', occupationOtherText: '' }).ok === false);

  check('その他以外なら自由記述は捨てる（DB制約と食い違わせない）',
    validateApplicationInput({ ...VALID, industryOtherText: '余計な入力' })
      .value.industryOtherText === null);

  /* ---------------------------------------------------------------- */
  section('形式の検証');

  ['taro', 'taro@', '@example.com', 'taro@example', 'a b@example.com'].forEach((email) => {
    check(`メール「${email}」を弾く`,
      validateApplicationInput({ ...VALID, email }).ok === false);
  });

  check('正しいメールは通る',
    validateApplicationInput({ ...VALID, email: 'a.b+c@sub.example.co.jp' }).ok === true);

  /* 数字が10桁未満、11桁超、数字以外、空。10桁は固定電話があるため許す。 */
  ['090-1234-56', '090-1234-56789', 'abc-defg-hijk', ''].forEach((phone) => {
    check(`電話番号「${phone}」を弾く`,
      validateApplicationInput({ ...VALID, phone }).ok === false);
  });

  check('10桁の固定電話は通る',
    validateApplicationInput({ ...VALID, phone: '03-1234-5678' }).ok === true);

  check('括弧と空白を含む電話番号は数字とハイフンにそろえる',
    validateApplicationInput({ ...VALID, phone: '(090) 1234-5678' }).value.phone === '0901234-5678',
    validateApplicationInput({ ...VALID, phone: '(090) 1234-5678' }).value.phone);

  check('ひらがなのフリガナはカタカナへそろえる',
    validateApplicationInput({ ...VALID, nameKana: 'やまだ たろう' }).value.nameKana
      === 'ヤマダ タロウ');

  check('漢字のフリガナは弾く',
    validateApplicationInput({ ...VALID, nameKana: '山田 太郎' }).ok === false);

  check('toKatakana は濁点付きも変換する', toKatakana('ばぱ') === 'バパ');

  check('長すぎる氏名を弾く',
    validateApplicationInput({ ...VALID, name: 'あ'.repeat(MAX_LENGTHS.name + 1) }).ok === false);

  check('上限ちょうどは通る',
    validateApplicationInput({ ...VALID, name: 'あ'.repeat(MAX_LENGTHS.name) }).ok === true);

  const controlCharacter = String.fromCharCode(10);

  check('改行を含む氏名を弾く',
    validateApplicationInput({ ...VALID, name: `山田${controlCharacter}太郎` }).ok === false);

  /* ---------------------------------------------------------------- */
  section('金額はフォームから受け取らない（受入条件3）');

  const tampered = validateApplicationInput({
    ...VALID, amount: 100, finalPrice: 100, price: 100, discountTotal: 99999,
  });

  check('金額らしき入力があっても合格結果に含めない',
    tampered.ok === true
      && !('amount' in tampered.value)
      && !('finalPrice' in tampered.value)
      && !('price' in tampered.value)
      && !('discountTotal' in tampered.value),
    Object.keys(tampered.value).join(','));

  /* ---------------------------------------------------------------- */
  section('Checkout Session のパラメータ');

  const breakdown = calculatePrice({
    industry: 'it', occupation: 'engineer', position: 'manager', ageGroup: '24+',
  });

  const params = buildCheckoutSessionParams({
    eventName: 'TSAMビジネス&フレンド交流会',
    amount: breakdown.finalPrice,
    email: 'taro@example.com',
    applicationId: 'app-1',
    eventId: 'event-1',
    successUrl: 'https://example.com/event/apply/done/',
    cancelUrl: 'https://example.com/event/apply/canceled/',
  });

  check('mode は payment', params.mode === 'payment');
  check('通貨は jpy', params.line_items[0].price_data.currency === 'jpy');
  check('unit_amount は円額そのまま（100倍しない）',
    params.line_items[0].price_data.unit_amount === 4400,
    params.line_items[0].price_data.unit_amount);
  check('数量は1', params.line_items[0].quantity === 1);
  check('商品名はイベント名',
    params.line_items[0].price_data.product_data.name === 'TSAMビジネス&フレンド交流会');
  check('customer_email を渡す', params.customer_email === 'taro@example.com');
  check('metadata に applicationId と eventId',
    params.metadata.applicationId === 'app-1' && params.metadata.eventId === 'event-1');
  check('PaymentIntent 側にも metadata を付ける',
    params.payment_intent_data.metadata.applicationId === 'app-1');

  check('決済手段を固定しない（automatic payment methods）',
    !('payment_method_types' in params));

  check('成功URLと取消URL', params.success_url.includes('/done/') && params.cancel_url.includes('/canceled/'));

  /* ---------------------------------------------------------------- */
  section('明細書表記のサフィックス（仕様書5.2）');

  check('英字のサフィックス',
    params.payment_intent_data.statement_descriptor_suffix === STATEMENT_DESCRIPTOR_SUFFIX);
  check('漢字のサフィックスはカード設定側に置く',
    params.payment_method_options.card.statement_descriptor_suffix_kanji
      === STATEMENT_DESCRIPTOR_SUFFIX_KANJI);
  check('カナのサフィックスはカード設定側に置く',
    params.payment_method_options.card.statement_descriptor_suffix_kana
      === STATEMENT_DESCRIPTOR_SUFFIX_KANA);
  check('漢字は「参加費」', STATEMENT_DESCRIPTOR_SUFFIX_KANJI === '参加費');

  /*
   * カナは半角。全角のまま送ると日本の決済網の表記に合わず、
   * Stripe 側の検証にも通らない。
   */
  check('カナは半角カタカナ',
    /^[｡-ﾟ]+$/.test(STATEMENT_DESCRIPTOR_SUFFIX_KANA),
    STATEMENT_DESCRIPTOR_SUFFIX_KANA);

  /* ---------------------------------------------------------------- */
  section('不正な金額');

  const invalidAmounts = [0, -1, 4400.5, NaN, '4400'];

  invalidAmounts.forEach((amount) => {
    let threw = false;

    try {
      buildCheckoutSessionParams({
        eventName: 'x', amount, email: 'a@example.com',
        applicationId: 'app-1', eventId: 'event-1',
        successUrl: 'https://example.com/', cancelUrl: 'https://example.com/',
      });
    } catch (error) {
      threw = error instanceof TypeError;
    }

    check(`金額 ${String(amount)} を拒否する`, threw);
  });

  let missingIdThrew = false;

  try {
    buildCheckoutSessionParams({
      eventName: 'x', amount: 4400, email: 'a@example.com',
      applicationId: '', eventId: 'event-1',
      successUrl: 'https://example.com/', cancelUrl: 'https://example.com/',
    });
  } catch (error) {
    missingIdThrew = error instanceof TypeError;
  }

  check('申込IDが無ければ作らない', missingIdThrew);

  /* ---------------------------------------------------------------- */
  section('フォーム形式への変換');

  const encoded = toFormEncoded(params);

  check('入れ子は角括弧で表す',
    encoded.includes(encodeURIComponent('line_items[0][price_data][currency]') + '=jpy'),
    encoded.slice(0, 120));

  check('unit_amount が 4400 で入る',
    encoded.includes(encodeURIComponent('line_items[0][price_data][unit_amount]') + '=4400'));

  check('日本語は百分率符号化される', !encoded.includes('参加費') && encoded.includes('%'));

  check('未定義の値は送らない',
    toFormEncoded({ a: 1, b: undefined, c: null }) === 'a=1');

  /* ---------------------------------------------------------------- */
  section('Stripeへの送信');

  const calls = [];

  const fakeFetch = async (url, options) => {
    calls.push({ url, options });

    return {
      ok: true,
      status: 200,
      json: async () => ({ id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1' }),
    };
  };

  const session = await createCheckoutSession({
    secretKey: 'sk_test_dummy',
    eventName: 'TSAMビジネス&フレンド交流会',
    amount: 4400,
    email: 'taro@example.com',
    applicationId: 'app-1',
    eventId: 'event-1',
    successUrl: 'https://example.com/event/apply/done/',
    cancelUrl: 'https://example.com/event/apply/canceled/',
    idempotencyKey: 'app-1',
    fetchImpl: fakeFetch,
  });

  check('Checkout Sessions の作成を呼ぶ',
    calls[0].url === 'https://api.stripe.com/v1/checkout/sessions');
  check('Bearer でキーを渡す',
    calls[0].options.headers.Authorization === 'Bearer sk_test_dummy');
  check('フォーム形式で送る',
    calls[0].options.headers['Content-Type'] === 'application/x-www-form-urlencoded');
  check('冪等キーを渡す（連打で二重に作らない）',
    calls[0].options.headers['Idempotency-Key'] === 'app-1');
  check('id と url を返す',
    session.id === 'cs_test_1' && session.url.includes('checkout.stripe.com'));

  let noKeyThrew = false;

  try {
    await createCheckoutSession({
      secretKey: '', eventName: 'x', amount: 4400, email: 'a@example.com',
      applicationId: 'app-1', eventId: 'event-1',
      successUrl: 'https://example.com/', cancelUrl: 'https://example.com/',
      fetchImpl: fakeFetch,
    });
  } catch (error) {
    noKeyThrew = error instanceof TypeError;
  }

  check('キーが無ければ通信前に止める', noKeyThrew);

  const errorFetch = async () => ({
    ok: false,
    status: 400,
    json: async () => ({ error: { message: 'Invalid amount' } }),
  });

  let sendError = null;

  try {
    await createCheckoutSession({
      secretKey: 'sk_test_secret_value', eventName: 'x', amount: 4400, email: 'a@example.com',
      applicationId: 'app-1', eventId: 'event-1',
      successUrl: 'https://example.com/', cancelUrl: 'https://example.com/',
      fetchImpl: errorFetch,
    });
  } catch (error) {
    sendError = error;
  }

  check('失敗を例外にする', sendError instanceof Error);
  check('Stripeの説明は伝える', sendError.message.includes('Invalid amount'));
  check('例外にシークレットキーを含めない',
    !sendError.message.includes('sk_test_secret_value'), sendError.message);

  finish();
} catch (error) {
  fatal(error);
}

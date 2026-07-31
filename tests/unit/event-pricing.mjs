/*
 * 交流会の参加費計算の検証。
 *
 * ==================================================================
 * 特に確かめること
 * ==================================================================
 *   - 実装仕様書 3.4 の全テストケースで計算結果が一致すること（受入条件1）
 *   - 出禁の申告で 55,000円に固定され、割引が無効になること（受入条件2）
 *   - 割引が「すべて合算」され、最大1件方式になっていないこと
 *   - 下限 3,300円を割り込まないこと
 *   - 選択肢の綴り違いを黙って 0円 に丸めないこと
 * ==================================================================
 */

import { check, section, finish, fatal } from '../../public/apps/tests/helpers/assert.mjs';

import {
  BASE_PRICE,
  MIN_PRICE,
  BANNED_DECLARED_PRICE,
  INDUSTRY_KEYS,
  OCCUPATION_KEYS,
  POSITION_KEYS,
  AGE_GROUP_KEYS,
  INDUSTRY_DISCOUNTS,
  OCCUPATION_DISCOUNTS,
  POSITION_DISCOUNTS,
  AGE_GROUP_DISCOUNTS,
  calculatePrice,
  buildBreakdownLines,
} from '../../lib/event/pricing.mjs';

try {
  /* ---------------------------------------------------------------- */
  section('基本の定数');

  check('通常価格は11,000円', BASE_PRICE === 11000, BASE_PRICE);
  check('最低販売価格は3,300円', MIN_PRICE === 3300, MIN_PRICE);
  check('出禁申告時は55,000円', BANNED_DECLARED_PRICE === 55000, BANNED_DECLARED_PRICE);

  /* ---------------------------------------------------------------- */
  section('仕様書 3.4 のテストケース');

  /*
   * 「任意」となっているケースは、割引額が最大になる組み合わせと
   * 最小になる組み合わせの両方で確かめる。どちらでも期待値が変わらないため。
   */
  const CASES = [
    {
      title: '任意×任意×任意×18〜23歳×なし（割引最小の組み合わせ）',
      input: { industry: 'other', occupation: 'other', position: 'other', ageGroup: '18-23' },
      expected: 3300,
    },
    {
      title: '任意×任意×任意×18〜23歳×なし（割引最大の組み合わせ）',
      input: { industry: 'it', occupation: 'engineer', position: 'executive', ageGroup: '18-23' },
      expected: 3300,
    },
    {
      title: 'IT×エンジニア×経営者×24歳以上×なし',
      input: { industry: 'it', occupation: 'engineer', position: 'executive', ageGroup: '24+' },
      expected: 3300,
    },
    {
      title: 'IT×エンジニア×管理職×24歳以上×なし',
      input: { industry: 'it', occupation: 'engineer', position: 'manager', ageGroup: '24+' },
      expected: 4400,
    },
    {
      title: '生命保険×営業×経営者×24歳以上×なし',
      input: {
        industry: 'life_insurance', occupation: 'sales', position: 'executive', ageGroup: '24+',
      },
      expected: 5500,
    },
    {
      title: 'IT×エンジニア×一般社員×24歳以上×なし',
      input: { industry: 'it', occupation: 'engineer', position: 'employee', ageGroup: '24+' },
      expected: 5500,
    },
    {
      title: '生命保険×営業×一般社員×24歳以上×なし',
      input: {
        industry: 'life_insurance', occupation: 'sales', position: 'employee', ageGroup: '24+',
      },
      expected: 7700,
    },
    {
      title: '生命保険×営業×その他×24歳以上×なし',
      input: {
        industry: 'life_insurance', occupation: 'sales', position: 'other', ageGroup: '24+',
      },
      expected: 8800,
    },
    {
      title: 'その他×その他×一般社員×24歳以上×なし',
      input: { industry: 'other', occupation: 'other', position: 'employee', ageGroup: '24+' },
      expected: 9900,
    },
    {
      title: 'その他×その他×その他×24歳以上×なし',
      input: { industry: 'other', occupation: 'other', position: 'other', ageGroup: '24+' },
      expected: 11000,
    },
    {
      title: '任意×任意×任意×任意×該当する（割引最大の組み合わせ）',
      input: {
        industry: 'it',
        occupation: 'engineer',
        position: 'executive',
        ageGroup: '18-23',
        isBannedDeclared: true,
      },
      expected: 55000,
    },
    {
      title: '任意×任意×任意×任意×該当する（割引なしの組み合わせ）',
      input: {
        industry: 'other',
        occupation: 'other',
        position: 'other',
        ageGroup: '24+',
        isBannedDeclared: true,
      },
      expected: 55000,
    },
  ];

  CASES.forEach(({ title, input, expected }) => {
    const result = calculatePrice(input);
    check(title, result.finalPrice === expected, `${result.finalPrice} （期待 ${expected}）`);
  });

  /* ---------------------------------------------------------------- */
  section('割引はすべて合算する');

  const summed = calculatePrice({
    industry: 'it',
    occupation: 'engineer',
    position: 'manager',
    ageGroup: '24+',
  });

  check('内訳の合計が割引合計と一致する',
    summed.discountIndustry + summed.discountOccupation
      + summed.discountPosition + summed.discountAge === summed.discountTotal,
    summed.discountTotal);

  check('3件が合算されている（最大1件方式ではない）',
    summed.discountTotal === 6600, summed.discountTotal);

  check('通常価格から割引合計を引いた額になる',
    summed.finalPrice === BASE_PRICE - summed.discountTotal, summed.finalPrice);

  /* ---------------------------------------------------------------- */
  section('最低販売価格');

  const belowMin = calculatePrice({
    industry: 'it', occupation: 'engineer', position: 'executive', ageGroup: '18-23',
  });

  check('割引合計が通常価格を超えても下限で止まる',
    belowMin.finalPrice === MIN_PRICE, belowMin.finalPrice);
  check('下限に張り付いたことを示す', belowMin.isMinPriceApplied === true);
  check('割引内訳そのものは記録される（合計 15,400円）',
    belowMin.discountTotal === 15400, belowMin.discountTotal);

  const exactlyMin = calculatePrice({
    industry: 'it', occupation: 'engineer', position: 'executive', ageGroup: '24+',
  });

  check('ちょうど下限のときは張り付き扱いにしない',
    exactlyMin.finalPrice === MIN_PRICE && exactlyMin.isMinPriceApplied === false,
    `${exactlyMin.finalPrice} / ${exactlyMin.isMinPriceApplied}`);

  /* すべての組み合わせで下限を割らないことを総当たりで確かめる。 */
  let minSeen = Infinity;
  let maxSeen = 0;
  let allInteger = true;

  INDUSTRY_KEYS.forEach((industry) => {
    OCCUPATION_KEYS.forEach((occupation) => {
      POSITION_KEYS.forEach((position) => {
        AGE_GROUP_KEYS.forEach((ageGroup) => {
          const { finalPrice } = calculatePrice({ industry, occupation, position, ageGroup });
          minSeen = Math.min(minSeen, finalPrice);
          maxSeen = Math.max(maxSeen, finalPrice);
          if (!Number.isInteger(finalPrice)) allInteger = false;
        });
      });
    });
  });

  const combinations =
    INDUSTRY_KEYS.length * OCCUPATION_KEYS.length * POSITION_KEYS.length * AGE_GROUP_KEYS.length;

  check(`全${combinations}通りで下限を割らない`, minSeen === MIN_PRICE, minSeen);
  check(`全${combinations}通りで通常価格を超えない`, maxSeen === BASE_PRICE, maxSeen);
  check('端数が発生しない（すべて整数円）', allInteger === true);

  /* ---------------------------------------------------------------- */
  section('出禁の申告');

  const banned = calculatePrice({
    industry: 'it',
    occupation: 'engineer',
    position: 'executive',
    ageGroup: '18-23',
    isBannedDeclared: true,
  });

  check('55,000円に固定される', banned.finalPrice === BANNED_DECLARED_PRICE, banned.finalPrice);
  check('割引がすべて無効になる', banned.discountTotal === 0, banned.discountTotal);
  check('内訳の各項目も0になる',
    banned.discountIndustry === 0 && banned.discountOccupation === 0
      && banned.discountPosition === 0 && banned.discountAge === 0);
  check('下限の判定を適用しない', banned.isMinPriceApplied === false);
  check('出禁の申告であることを示す', banned.isBannedDeclared === true);

  check('該当しない場合は通常の計算に戻る',
    calculatePrice({
      industry: 'it', occupation: 'engineer', position: 'manager', ageGroup: '24+',
      isBannedDeclared: false,
    }).finalPrice === 4400);

  /*
   * 真偽値以外が入ってきても「該当する」に化けないこと。
   * フォームの値の取り違えで 55,000円を請求してしまうと影響が大きい。
   */
  check('文字列の "false" を該当扱いにしない',
    calculatePrice({
      industry: 'other', occupation: 'other', position: 'other', ageGroup: '24+',
      isBannedDeclared: 'false',
    }).finalPrice === BASE_PRICE);

  check('未指定なら該当しない扱い',
    calculatePrice({
      industry: 'other', occupation: 'other', position: 'other', ageGroup: '24+',
    }).finalPrice === BASE_PRICE);

  /* ---------------------------------------------------------------- */
  section('割引テーブルが仕様と一致する');

  check('生命保険・不動産投資・人材紹介は -1,100円',
    INDUSTRY_DISCOUNTS.life_insurance === 1100
      && INDUSTRY_DISCOUNTS.real_estate_investment === 1100
      && INDUSTRY_DISCOUNTS.recruitment_agency === 1100);

  check('IT・金融・教育・医療・不動産・人材・建設・製造・小売・サービス・士業は -2,200円',
    [
      'it', 'finance', 'education', 'medical', 'real_estate', 'hr',
      'construction', 'manufacturing', 'retail', 'service', 'professional',
    ].every((key) => INDUSTRY_DISCOUNTS[key] === 2200));

  check('業界のその他は0円', INDUSTRY_DISCOUNTS.other === 0);

  check('営業・マーケティングは -1,100円',
    OCCUPATION_DISCOUNTS.sales === 1100 && OCCUPATION_DISCOUNTS.marketing === 1100);

  check('人事・経営企画・エンジニア・デザイナー・コンサルタント・教育職・医療職・士業は -2,200円',
    [
      'hr', 'corporate_planning', 'engineer', 'designer',
      'consultant', 'educator', 'medical', 'professional',
    ].every((key) => OCCUPATION_DISCOUNTS[key] === 2200));

  check('職種のその他は0円', OCCUPATION_DISCOUNTS.other === 0);

  check('経営者・代表者・役員は -3,300円',
    POSITION_DISCOUNTS.executive === 3300
      && POSITION_DISCOUNTS.representative === 3300
      && POSITION_DISCOUNTS.officer === 3300);

  check('管理職は -2,200円', POSITION_DISCOUNTS.manager === 2200);

  check('個人事業主・フリーランス・学生は -2,200円',
    POSITION_DISCOUNTS.sole_proprietor === 2200
      && POSITION_DISCOUNTS.freelance === 2200
      && POSITION_DISCOUNTS.student === 2200);

  check('一般社員は -1,100円', POSITION_DISCOUNTS.employee === 1100);
  check('立場のその他は0円', POSITION_DISCOUNTS.other === 0);

  check('18〜23歳は -7,700円', AGE_GROUP_DISCOUNTS['18-23'] === 7700);
  check('24歳以上は0円', AGE_GROUP_DISCOUNTS['24+'] === 0);

  check('年齢区分は2つだけ（生年月日は扱わない）', AGE_GROUP_KEYS.length === 2, AGE_GROUP_KEYS);

  /* ---------------------------------------------------------------- */
  section('不正な入力');

  const invalidInputs = [
    { name: '業界', input: { industry: 'IT', occupation: 'engineer', position: 'manager', ageGroup: '24+' } },
    { name: '職種', input: { industry: 'it', occupation: 'unknown', position: 'manager', ageGroup: '24+' } },
    { name: '立場', input: { industry: 'it', occupation: 'engineer', position: '', ageGroup: '24+' } },
    { name: '年齢区分', input: { industry: 'it', occupation: 'engineer', position: 'manager', ageGroup: '18-24' } },
  ];

  invalidInputs.forEach(({ name, input }) => {
    let threw = false;

    try {
      calculatePrice(input);
    } catch (error) {
      threw = error instanceof TypeError;
    }

    check(`${name}の不正な値は例外にする（0円に丸めない）`, threw);
  });

  /*
   * プロトタイプ由来のプロパティを選択肢と誤認しないこと。
   * Object.hasOwn ではなく in で判定していると 'toString' などが通ってしまう。
   */
  let prototypeKeyThrew = false;

  try {
    calculatePrice({
      industry: 'toString', occupation: 'engineer', position: 'manager', ageGroup: '24+',
    });
  } catch (error) {
    prototypeKeyThrew = error instanceof TypeError;
  }

  check('プロトタイプのプロパティ名を選択肢として通さない', prototypeKeyThrew);

  /* ---------------------------------------------------------------- */
  section('内訳の行');

  const linesInput = {
    industry: 'it', occupation: 'engineer', position: 'manager', ageGroup: '24+',
  };
  const lines = buildBreakdownLines(calculatePrice(linesInput), linesInput);

  check('割引のある分類だけ行になる', lines.length === 3, lines.length);
  check('業界の行の文言と金額', lines[0].label === '業界割引（IT）' && lines[0].amount === -2200,
    JSON.stringify(lines[0]));
  check('職種の行の文言と金額',
    lines[1].label === '職種割引（エンジニア）' && lines[1].amount === -2200,
    JSON.stringify(lines[1]));
  check('立場の行の文言と金額',
    lines[2].label === '立場割引（管理職）' && lines[2].amount === -2200,
    JSON.stringify(lines[2]));

  const ageInput = {
    industry: 'other', occupation: 'other', position: 'other', ageGroup: '18-23',
  };
  const ageLines = buildBreakdownLines(calculatePrice(ageInput), ageInput);

  check('年齢割引だけの場合は1行', ageLines.length === 1, ageLines.length);
  check('年齢の行の文言と金額',
    ageLines[0].label === '年齢割引（18〜23歳）' && ageLines[0].amount === -7700,
    JSON.stringify(ageLines[0]));

  const noneInput = {
    industry: 'other', occupation: 'other', position: 'other', ageGroup: '24+',
  };

  check('割引がなければ行は空',
    buildBreakdownLines(calculatePrice(noneInput), noneInput).length === 0);

  const bannedInput = {
    industry: 'it',
    occupation: 'engineer',
    position: 'manager',
    ageGroup: '18-23',
    isBannedDeclared: true,
  };

  check('出禁申告時は内訳を出さない（理由を表示しないため）',
    buildBreakdownLines(calculatePrice(bannedInput), bannedInput).length === 0);

  /* ---------------------------------------------------------------- */
  section('Stripeへ渡す金額');

  /*
   * JPY は最小通貨単位が円。unit_amount には円額をそのまま入れる。
   * 100倍して渡す通貨と取り違えると請求額が100倍になるため、
   * 計算結果がそのまま unit_amount に使える形（正の整数）であることを確かめる。
   */
  const forStripe = calculatePrice({
    industry: 'life_insurance', occupation: 'sales', position: 'employee', ageGroup: '24+',
  });

  check('7,700円がそのまま 7700 になる', forStripe.finalPrice === 7700, forStripe.finalPrice);
  check('正の整数である',
    Number.isInteger(forStripe.finalPrice) && forStripe.finalPrice > 0);

  finish();
} catch (error) {
  fatal(error);
}

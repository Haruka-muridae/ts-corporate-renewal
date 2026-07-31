/*
 * 交流会の参加費を計算する。
 *
 * ==================================================================
 * 仕様（実装仕様書 3章）
 * ==================================================================
 *   支払額 = 11,000円 −（業界割引 + 職種割引 + 立場割引 + 年齢割引）
 *   ただし下限 3,300円。
 *
 *   該当する割引は「すべて合算」する（最大1件方式ではない）。
 *   割引はすべて固定額。端数処理は発生しない。
 *
 *   出禁を「該当する」と申告した場合は 55,000円に固定し、
 *   すべての割引を無効、下限の判定も適用しない。
 * ==================================================================
 *
 * 割引ルールはこのファイルの定数として持つ（DBのルールエンジンは作らない）。
 * 将来ここの金額を変えても過去の申込記録が変わらないよう、申込ごとの割引内訳は
 * payments テーブルに列として保存する（＝申込時点のスナップショット）。
 *
 * このモジュールは副作用を持たず、DBにもStripeにも依存しない。
 * サーバー側の金額再計算（改ざん防止）と、画面の内訳表示の両方から呼ぶ。
 */

/** 通常価格（税込・JPY）。 */
export const BASE_PRICE = 11000;

/** 最低販売価格（税込・JPY）。 */
export const MIN_PRICE = 3300;

/** 出禁を申告した場合の固定額（税込・JPY）。 */
export const BANNED_DECLARED_PRICE = 55000;

/*
 * 業界の割引額。
 * 「金融」は生命保険を除く、「不動産」は不動産投資を除く、
 * 「人材」は人材紹介を除く。区別が必要なため別の選択肢として持つ。
 */
export const INDUSTRY_DISCOUNTS = {
  life_insurance: 1100,
  real_estate_investment: 1100,
  recruitment_agency: 1100,
  it: 2200,
  finance: 2200,
  education: 2200,
  medical: 2200,
  real_estate: 2200,
  hr: 2200,
  construction: 2200,
  manufacturing: 2200,
  retail: 2200,
  service: 2200,
  professional: 2200,
  other: 0,
};

/** 職種の割引額。 */
export const OCCUPATION_DISCOUNTS = {
  sales: 1100,
  marketing: 1100,
  hr: 2200,
  corporate_planning: 2200,
  engineer: 2200,
  designer: 2200,
  consultant: 2200,
  educator: 2200,
  medical: 2200,
  professional: 2200,
  other: 0,
};

/** 立場の割引額。 */
export const POSITION_DISCOUNTS = {
  executive: 3300,
  representative: 3300,
  officer: 3300,
  manager: 2200,
  sole_proprietor: 2200,
  freelance: 2200,
  student: 2200,
  employee: 1100,
  other: 0,
};

/** 年齢区分の割引額。区分は2つのみで、生年月日は扱わない。 */
export const AGE_GROUP_DISCOUNTS = {
  '18-23': 7700,
  '24+': 0,
};

/*
 * 画面表示用のラベル。
 * 金額確認画面と参加確定メールで「業界割引（IT）」のように出す。
 */
export const INDUSTRY_LABELS = {
  life_insurance: '生命保険',
  real_estate_investment: '不動産投資',
  recruitment_agency: '人材紹介',
  it: 'IT',
  finance: '金融',
  education: '教育',
  medical: '医療',
  real_estate: '不動産',
  hr: '人材',
  construction: '建設',
  manufacturing: '製造',
  retail: '小売',
  service: 'サービス',
  professional: '士業',
  other: 'その他',
};

export const OCCUPATION_LABELS = {
  sales: '営業',
  marketing: 'マーケティング',
  hr: '人事',
  corporate_planning: '経営企画',
  engineer: 'エンジニア',
  designer: 'デザイナー',
  consultant: 'コンサルタント',
  educator: '教育職',
  medical: '医療職',
  professional: '士業',
  other: 'その他',
};

export const POSITION_LABELS = {
  executive: '経営者',
  representative: '代表者',
  officer: '役員',
  manager: '管理職',
  sole_proprietor: '個人事業主',
  freelance: 'フリーランス',
  student: '学生',
  employee: '一般社員',
  other: 'その他',
};

export const AGE_GROUP_LABELS = {
  '18-23': '18〜23歳',
  '24+': '24歳以上',
};

/** 選択肢の一覧。フォームの描画と入力値の検証に使う。 */
export const INDUSTRY_KEYS = Object.keys(INDUSTRY_DISCOUNTS);
export const OCCUPATION_KEYS = Object.keys(OCCUPATION_DISCOUNTS);
export const POSITION_KEYS = Object.keys(POSITION_DISCOUNTS);
export const AGE_GROUP_KEYS = Object.keys(AGE_GROUP_DISCOUNTS);

/*
 * 未知のキーは 0円 として扱わず、例外にする。
 * 入力値の綴り違いを黙って「割引なし」に丸めると、
 * 気づかないまま高い金額を請求してしまうため。
 */
function discountOf(table, key, label) {
  if (!Object.hasOwn(table, key)) {
    throw new TypeError(`${label}の選択肢が不正です: ${String(key)}`);
  }

  return table[key];
}

/**
 * 参加費を計算する。
 *
 * 入力は申込フォームの選択値そのもの。金額はブラウザから受け取らない。
 *
 * @param {object} input
 * @param {string} input.industry            業界（INDUSTRY_KEYS のいずれか）
 * @param {string} input.occupation          職種（OCCUPATION_KEYS のいずれか）
 * @param {string} input.position            立場（POSITION_KEYS のいずれか）
 * @param {string} input.ageGroup            年齢区分（'18-23' | '24+'）
 * @param {boolean} input.isBannedDeclared   出禁を「該当する」と申告したか
 * @returns {{
 *   basePrice: number,
 *   discountIndustry: number,
 *   discountOccupation: number,
 *   discountPosition: number,
 *   discountAge: number,
 *   discountTotal: number,
 *   finalPrice: number,
 *   isBannedDeclared: boolean,
 *   isMinPriceApplied: boolean,
 * }}
 */
export function calculatePrice({
  industry,
  occupation,
  position,
  ageGroup,
  isBannedDeclared = false,
}) {
  /*
   * 出禁の申告は割引計算より優先する。
   * 選択肢の検証はこの場合も行う。申込内容として保存するため、
   * 不正な値をここで通してしまうと後段で気づけない。
   */
  const discountIndustry = discountOf(INDUSTRY_DISCOUNTS, industry, '業界');
  const discountOccupation = discountOf(OCCUPATION_DISCOUNTS, occupation, '職種');
  const discountPosition = discountOf(POSITION_DISCOUNTS, position, '立場');
  const discountAge = discountOf(AGE_GROUP_DISCOUNTS, ageGroup, '年齢区分');

  if (isBannedDeclared === true) {
    return {
      basePrice: BASE_PRICE,
      discountIndustry: 0,
      discountOccupation: 0,
      discountPosition: 0,
      discountAge: 0,
      discountTotal: 0,
      finalPrice: BANNED_DECLARED_PRICE,
      isBannedDeclared: true,
      isMinPriceApplied: false,
    };
  }

  const discountTotal =
    discountIndustry + discountOccupation + discountPosition + discountAge;

  const rawPrice = BASE_PRICE - discountTotal;
  const finalPrice = Math.max(rawPrice, MIN_PRICE);

  return {
    basePrice: BASE_PRICE,
    discountIndustry,
    discountOccupation,
    discountPosition,
    discountAge,
    discountTotal,
    finalPrice,
    isBannedDeclared: false,
    /* 下限に張り付いたか。内訳表示の注記に使う。 */
    isMinPriceApplied: rawPrice < MIN_PRICE,
  };
}

/**
 * 金額確認画面と参加確定メールに出す内訳の行を組み立てる。
 *
 * 出禁の申告がある場合は内訳を返さない。
 * 仕様上、確認画面には「参加費 55,000円」とのみ表示し、理由は出さないため。
 *
 * @param {ReturnType<typeof calculatePrice>} breakdown
 * @param {{ industry: string, occupation: string, position: string, ageGroup: string }} input
 * @returns {Array<{ label: string, amount: number }>}
 */
export function buildBreakdownLines(breakdown, input) {
  if (breakdown.isBannedDeclared) {
    return [];
  }

  const lines = [];

  if (breakdown.discountIndustry > 0) {
    lines.push({
      label: `業界割引（${INDUSTRY_LABELS[input.industry]}）`,
      amount: -breakdown.discountIndustry,
    });
  }

  if (breakdown.discountOccupation > 0) {
    lines.push({
      label: `職種割引（${OCCUPATION_LABELS[input.occupation]}）`,
      amount: -breakdown.discountOccupation,
    });
  }

  if (breakdown.discountPosition > 0) {
    lines.push({
      label: `立場割引（${POSITION_LABELS[input.position]}）`,
      amount: -breakdown.discountPosition,
    });
  }

  if (breakdown.discountAge > 0) {
    lines.push({
      label: `年齢割引（${AGE_GROUP_LABELS[input.ageGroup]}）`,
      amount: -breakdown.discountAge,
    });
  }

  return lines;
}

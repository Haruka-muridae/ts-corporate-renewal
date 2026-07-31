/*
 * lib/event/pricing.mjs の型定義。
 *
 * ファイル名が .d.mts なのは、対象が .mjs だから。
 * .d.ts では TypeScript が pricing.mjs の型として認識しない。
 *
 * 実装を .mjs に置いているのは、既存のテスト実行環境（node で .mjs を直接動かす）
 * からそのまま読めるようにするため。Next.js 側（.ts / .tsx）からは、
 * このファイルの型が付いた状態で import できる。
 */

export type IndustryKey =
  | "life_insurance"
  | "real_estate_investment"
  | "recruitment_agency"
  | "it"
  | "finance"
  | "education"
  | "medical"
  | "real_estate"
  | "hr"
  | "construction"
  | "manufacturing"
  | "retail"
  | "service"
  | "professional"
  | "other";

export type OccupationKey =
  | "sales"
  | "marketing"
  | "hr"
  | "corporate_planning"
  | "engineer"
  | "designer"
  | "consultant"
  | "educator"
  | "medical"
  | "professional"
  | "other";

export type PositionKey =
  | "executive"
  | "representative"
  | "officer"
  | "manager"
  | "sole_proprietor"
  | "freelance"
  | "student"
  | "employee"
  | "other";

export type AgeGroupKey = "18-23" | "24+";

export type PricingInput = {
  industry: IndustryKey;
  occupation: OccupationKey;
  position: PositionKey;
  ageGroup: AgeGroupKey;
  isBannedDeclared?: boolean;
};

export type PriceBreakdown = {
  basePrice: number;
  discountIndustry: number;
  discountOccupation: number;
  discountPosition: number;
  discountAge: number;
  discountTotal: number;
  finalPrice: number;
  isBannedDeclared: boolean;
  /** 割引後の金額が最低販売価格を下回り、下限に張り付いたか。 */
  isMinPriceApplied: boolean;
};

export type BreakdownLine = {
  label: string;
  /** 割引行は負の数。 */
  amount: number;
};

export declare const BASE_PRICE: 11000;
export declare const MIN_PRICE: 3300;
export declare const BANNED_DECLARED_PRICE: 55000;

export declare const INDUSTRY_DISCOUNTS: Record<IndustryKey, number>;
export declare const OCCUPATION_DISCOUNTS: Record<OccupationKey, number>;
export declare const POSITION_DISCOUNTS: Record<PositionKey, number>;
export declare const AGE_GROUP_DISCOUNTS: Record<AgeGroupKey, number>;

export declare const INDUSTRY_LABELS: Record<IndustryKey, string>;
export declare const OCCUPATION_LABELS: Record<OccupationKey, string>;
export declare const POSITION_LABELS: Record<PositionKey, string>;
export declare const AGE_GROUP_LABELS: Record<AgeGroupKey, string>;

export declare const INDUSTRY_KEYS: IndustryKey[];
export declare const OCCUPATION_KEYS: OccupationKey[];
export declare const POSITION_KEYS: PositionKey[];
export declare const AGE_GROUP_KEYS: AgeGroupKey[];

export declare function calculatePrice(input: PricingInput): PriceBreakdown;

export declare function buildBreakdownLines(
  breakdown: PriceBreakdown,
  input: Pick<PricingInput, "industry" | "occupation" | "position" | "ageGroup">,
): BreakdownLine[];

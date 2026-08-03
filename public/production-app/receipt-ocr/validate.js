/*
 * 抽出結果の妥当性検証（v1.3 §13）。
 *
 * ==================================================================
 * 抽出値は、そのまま確定データにしない
 * ==================================================================
 * ルール由来でも Gemini 由来でも、必ずここを通す。
 * §10 の前文が「検証に不合格の場合はルールで値が取れていても確定しない
 * （安全側に倒す）」と定めている。
 * ==================================================================
 *
 * ------------------------------------------------------------------
 * 「許容誤差1円」は使わない（§13.1）
 * ------------------------------------------------------------------
 * 端数処理は事業者の裁量であり、値引き・クーポン・ポイント充当・
 * 非課税品の混在により、正当なレシートの相当数が1円基準で不整合になる。
 * 検算は**加点の材料**であって、不整合を即エラーにしない。
 * ------------------------------------------------------------------
 */

import { normalizeAmount } from './amount.js';
import { TAX_NOTATION } from './status.js';

/* 既定のしきい値（設定タブで上書きできる。v1.3 §16.6）。 */
export const DEFAULT_LIMITS = Object.freeze({
  maxAmount: 10000000,
  pastDateLimitDays: 365,
  taxToleranceYen: 3,
});

/* §13.1 の検算スキップ条件。値引き等の行があれば検算しない。 */
const DISCOUNT_MARK = /(値引|割引|クーポン|ポイント利用|ポイント充当|ポイント値引|サービス券|優待)/;

/* ---------- §13.1 金額検証 ---------- */

export function validateAmount(rawAmount, { lines = [], tax = null, limits = DEFAULT_LIMITS } = {}) {
  const warnings = [];
  const amount = normalizeAmount(rawAmount);

  /* 基本検証（常時）。 */
  if (amount === null) {
    return { ok: false, amount: null, warnings: ['金額を数値として読み取れませんでした'], taxConsistent: false };
  }

  if (amount <= 0) {
    return { ok: false, amount, warnings: ['合計金額が0円以下です'], taxConsistent: false };
  }

  if (amount >= limits.maxAmount) {
    return { ok: false, amount, warnings: ['合計金額が上限を超えています'], taxConsistent: false };
  }

  /* 検算（税額が取得できた場合のみ）。 */
  const hasDiscount = lines.some((line) => DISCOUNT_MARK.test(line));
  let taxConsistent = false;

  if (hasDiscount) {
    warnings.push('値引きあり・検算省略');
  } else if (tax) {
    const result = checkTax(amount, tax, limits);

    taxConsistent = result.consistent;

    if (result.warning) {
      warnings.push(result.warning);
    }
  }

  return { ok: true, amount, warnings, taxConsistent };
}

/*
 * 税額の逆算（§13.1）。
 *
 * 整合すれば信頼度加点（OCRの桁誤読の検知に有効）。
 * **不整合でも即エラーにしない。** 警告に留める。
 */
function checkTax(total, tax, limits) {
  const parts = [
    { base: tax.tax8Base, amount: tax.tax8Amount, rate: 0.08 },
    { base: tax.tax10Base, amount: tax.tax10Amount, rate: 0.1 },
  ].filter((part) => part.amount !== null && part.amount !== undefined && part.amount !== '');

  if (parts.length === 0) {
    return { consistent: false, warning: null };
  }

  let matched = 0;

  for (const part of parts) {
    const base = normalizeAmount(part.base);
    const taxAmount = normalizeAmount(part.amount);

    if (base === null || taxAmount === null) {
      continue;
    }

    /*
     * 対象額が税込か税抜かで逆算式が変わる。
     * どちらでも合うなら整合とみなす（表記区分が不明なことがあるため）。
     */
    const fromExclusive = Math.round(base * part.rate);
    const fromInclusive = Math.round((base * part.rate) / (1 + part.rate));

    if (Math.abs(fromExclusive - taxAmount) <= limits.taxToleranceYen
      || Math.abs(fromInclusive - taxAmount) <= limits.taxToleranceYen) {
      matched += 1;
    }
  }

  if (matched === 0) {
    return { consistent: false, warning: '税額の逆算が合いません' };
  }

  return { consistent: matched === parts.length, warning: null };
}

/*
 * 「8％対象額＋10％対象額 ≒ 合計」の参考検証（§13.1 末尾）。
 *
 * **表記区分が「税込」と特定でき、かつ値引き等が検出されていない場合のみ**
 * 行う。一致すれば加点、不一致でも警告に留め、
 * 要確認判定の単独根拠にはしない。
 */
export function checkBaseSum(total, tax, { lines = [], limits = DEFAULT_LIMITS } = {}) {
  if (tax?.notation !== TAX_NOTATION.INCLUSIVE) {
    return { applicable: false, consistent: false, warning: null };
  }

  if (lines.some((line) => DISCOUNT_MARK.test(line))) {
    return { applicable: false, consistent: false, warning: null };
  }

  const base8 = normalizeAmount(tax.tax8Base);
  const base10 = normalizeAmount(tax.tax10Base);

  if (base8 === null && base10 === null) {
    return { applicable: false, consistent: false, warning: null };
  }

  const sum = (base8 ?? 0) + (base10 ?? 0);
  const consistent = Math.abs(sum - Number(total)) <= limits.taxToleranceYen;

  return {
    applicable: true,
    consistent,
    warning: consistent ? null : '税率別対象額の合計が合計金額と一致しません',
  };
}

/* ---------- §13.2 日付検証 ---------- */

/*
 * §13.2。
 *
 * 未来日はポイント失効日等の誤取得を示唆するため要確認。
 * 1年超過去も要確認（閾値は設定変更可）。
 */
export function validateDate(dateText, { now = new Date(), limits = DEFAULT_LIMITS } = {}) {
  const value = String(dateText ?? '').trim();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return { ok: false, warnings: ['利用日を読み取れませんでした'] };
  }

  const parsed = new Date(`${value}T00:00:00Z`);

  if (Number.isNaN(parsed.getTime())) {
    return { ok: false, warnings: ['利用日を日付として解釈できませんでした'] };
  }

  /* 比較は日付単位で行う。時刻差で「未来日」と誤判定しないため。 */
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const diffDays = Math.round((parsed.getTime() - today.getTime()) / 86400000);

  if (diffDays > 0) {
    return { ok: false, warnings: ['利用日が未来の日付です（有効期限等の誤取得の可能性）'] };
  }

  if (-diffDays > limits.pastDateLimitDays) {
    return { ok: false, warnings: ['利用日が1年以上前です'] };
  }

  return { ok: true, warnings: [] };
}

/* ---------- §13.4 必須項目検証 ---------- */

/*
 * §13.4。不足する場合 reviewStatus を REQUIRED とする。
 * 必須は 支払先 / 利用日 / 合計金額 / 原本画像URL の4つ。
 */
export const REQUIRED_FIELDS = Object.freeze(['payee', 'usedOn', 'totalAmount', 'originalUrl']);

export function validateRequired(values) {
  const missing = REQUIRED_FIELDS.filter((key) => {
    const value = values?.[key];
    return value === null || value === undefined || String(value).trim() === '';
  });

  return {
    ok: missing.length === 0,
    missing,
    warnings: missing.length > 0 ? [`必須項目が不足しています（${missing.join(', ')}）`] : [],
  };
}

/* ---------- まとめ ---------- */

/*
 * 全体の検証。
 *
 * 戻り値の ok は「必須項目が揃い、金額と日付が検証を通った」こと。
 * false なら reviewStatus は REQUIRED になる。
 */
export function validateAll(values, { lines = [], tax = null, now = new Date(), limits = DEFAULT_LIMITS } = {}) {
  const warnings = [];

  const amount = validateAmount(values?.totalAmount, { lines, tax, limits });
  warnings.push(...amount.warnings);

  const date = validateDate(values?.usedOn, { now, limits });
  warnings.push(...date.warnings);

  const required = validateRequired({ ...values, totalAmount: amount.amount ?? '' });
  warnings.push(...required.warnings);

  const baseSum = tax
    ? checkBaseSum(amount.amount, tax, { lines, limits })
    : { applicable: false, consistent: false, warning: null };

  if (baseSum.warning) {
    warnings.push(baseSum.warning);
  }

  return {
    ok: amount.ok && date.ok && required.ok,
    amount,
    date,
    required,
    baseSum,
    warnings,
  };
}

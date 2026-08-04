/*
 * 信頼度判定（v1.3 §14）。
 *
 * ==================================================================
 * コード側で算出する。Gemini の自己申告値は使わない
 * ==================================================================
 * LLM の自己申告確率は校正されておらず、自動確定の根拠にできない
 * （§12.5 / §14）。ai-complete.js も confidence を要求していない。
 *
 * また、信頼度は「どの経路で処理したか」ではなく
 * 「値がどれだけ確からしいか」の推定として設計する。
 * 「Gemini 未使用なら高」のような経路ベースの条件を足さないこと。
 * ==================================================================
 */

import { CONFIDENCE_LEVEL } from './status.js';

/*
 * 加点表（v1.3 §14 の初期値をそのまま写したもの）。
 * 運用実測に基づき調整する。満点は 200 点。
 */
export const POINTS = Object.freeze({
  date: { labelAdjacent: 30, singleCandidate: 20, agreed: 20 },
  amount: { labelAdjacent: 30, singleCandidate: 20, taxConsistent: 30, agreed: 20 },
  payee: { masterExact: 20, agreed: 10 },
  penalty: { discountSkip: -10 },
});

export const MAX_SCORE = 200;

/* しきい値の既定（v1.3 §14 は「設定シートで管理」とし初期値を示していない）。 */
export const DEFAULT_THRESHOLDS = Object.freeze({ high: 120, medium: 60 });

/*
 * スコアを出す。
 *
 * agreements は「ルールと Gemini が一致したか」（§12.2 の突合結果）。
 * evidence 照合が通らなかった項目は、そもそも採用されないため
 * ここへ来ない（§14「evidence照合不可：採用しない（スコア対象外）」）。
 */
export function scoreOf({
  usedOn = null,
  totalAmount = null,
  payee = null,
  taxConsistent = false,
  discountSkipped = false,
  agreements = {},
} = {}) {
  const detail = [];
  let score = 0;

  const add = (points, reason) => {
    if (points === 0) {
      return;
    }

    score += points;
    detail.push({ points, reason });
  };

  /* 日付。 */
  if (usedOn?.labelAdjacent) {
    add(POINTS.date.labelAdjacent, '利用日をラベル近接で取得');
  }

  if (usedOn?.candidates === 1) {
    add(POINTS.date.singleCandidate, '日付候補が1件');
  }

  if (agreements.usedOn) {
    add(POINTS.date.agreed, '利用日がルールとAIで一致');
  }

  /* 金額。 */
  if (totalAmount?.labelAdjacent) {
    add(POINTS.amount.labelAdjacent, '合計金額を合計ラベル近接で取得');
  }

  if (totalAmount?.candidates === 1) {
    add(POINTS.amount.singleCandidate, '金額候補が1件');
  }

  if (taxConsistent) {
    add(POINTS.amount.taxConsistent, '税額の逆算と整合');
  }

  if (agreements.totalAmount) {
    add(POINTS.amount.agreed, '合計金額がルールとAIで一致');
  }

  /* 支払先。 */
  if (payee?.masterMatch) {
    add(POINTS.payee.masterExact, '店舗マスタと一致');
  }

  if (agreements.payee) {
    add(POINTS.payee.agreed, '支払先がルールとAIで一致');
  }

  /* 減点。 */
  if (discountSkipped) {
    add(POINTS.penalty.discountSkip, '値引き検出により検算を省略');
  }

  return { score: Math.max(0, score), max: MAX_SCORE, detail };
}

/* スコアを高・中・低へ分類する（§14）。 */
export function levelOf(score, thresholds = DEFAULT_THRESHOLDS) {
  const value = Number(score) || 0;

  if (value >= thresholds.high) {
    return CONFIDENCE_LEVEL.HIGH;
  }

  if (value >= thresholds.medium) {
    return CONFIDENCE_LEVEL.MEDIUM;
  }

  return CONFIDENCE_LEVEL.LOW;
}

/*
 * 確認画面で強調すべき項目か（v2.0 §8）。
 * 信頼度が低い、または要確認判定の項目を強調する。
 */
export function shouldHighlight({ level, needsReview = false, missing = false } = {}) {
  return missing || needsReview || level === CONFIDENCE_LEVEL.LOW;
}

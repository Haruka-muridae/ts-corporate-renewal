/*
 * ステータス体系（v1.3 §15。v2.0 §5 により processingStatus を除いた3軸）。
 *
 * ------------------------------------------------------------------
 * なぜ processingStatus を持たないか
 * ------------------------------------------------------------------
 * v1.3 の4軸は、サーバーが受け付けてから非同期で処理する構成
 * （RECEIVED → PROCESSING → SUCCEEDED / FAILED）を前提にしていた。
 *
 * v2.0 ではサーバーが無く、処理はすべて利用者のブラウザの中で
 * 完結してから1行が書かれる。書かれた行は必ず「処理済み」であり、
 * PROCESSING の行が残ることがない。持っても常に同じ値になる列を
 * 増やすだけなので、v2.0 §9.1 の指示どおり列ごと落とす。
 * ------------------------------------------------------------------
 */

/* 確認状態（v1.3 §15）。 */
export const REVIEW_STATUS = Object.freeze({
  NOT_REQUIRED: 'NOT_REQUIRED',
  REQUIRED: 'REQUIRED',
  REVIEWED: 'REVIEWED',
});

/* 重複状態（v1.3 §15）。 */
export const DUPLICATE_STATUS = Object.freeze({
  NONE: 'NONE',
  CANDIDATE: 'CANDIDATE',
  EXACT: 'EXACT',
});

/* 抽出方式（v1.3 §15）。 */
export const EXTRACTION_METHOD = Object.freeze({
  RULE: 'RULE',
  GEMINI: 'GEMINI',
  HYBRID: 'HYBRID',
  MANUAL: 'MANUAL',
});

/* 信頼度区分（v1.3 §14）。 */
export const CONFIDENCE_LEVEL = Object.freeze({
  HIGH: '高',
  MEDIUM: '中',
  LOW: '低',
});

/* 登録番号の状態（v1.3 §10.6。3値）。 */
export const REGISTRATION_STATUS = Object.freeze({
  FOUND: '取得済み',
  ABSENT: '記載なし（免税の可能性）',
  UNREADABLE: '読取失敗',
});

/* 対象額の表記区分（v1.3 §10.9）。 */
export const TAX_NOTATION = Object.freeze({
  INCLUSIVE: '税込',
  EXCLUSIVE: '税抜',
  UNKNOWN: '不明',
});

/* 科目候補の出所（v1.3 §10.8 / §16.1 J列）。 */
export const ACCOUNT_SOURCE = Object.freeze({
  STORE_MASTER: '店舗マスタ',
  GEMINI: 'Gemini',
  MANUAL: '手動',
});

/*
 * 抽出方式を決める。
 *
 * ルールだけで確定 … RULE
 * AI の値を採った  … ルール由来の値も残っていれば HYBRID、無ければ GEMINI
 * 人が直した       … MANUAL（v1.3 §18.1-4。他のどれよりも優先する）
 */
export function decideExtractionMethod({ usedRule = false, usedGemini = false, edited = false } = {}) {
  if (edited) {
    return EXTRACTION_METHOD.MANUAL;
  }

  if (usedRule && usedGemini) {
    return EXTRACTION_METHOD.HYBRID;
  }

  if (usedGemini) {
    return EXTRACTION_METHOD.GEMINI;
  }

  return EXTRACTION_METHOD.RULE;
}

/* 重複判定の結果（duplicate.js）を列の値へ移す。 */
export function toDuplicateStatus(kind) {
  if (kind === 'exact') {
    return DUPLICATE_STATUS.EXACT;
  }

  if (kind === 'similar') {
    return DUPLICATE_STATUS.CANDIDATE;
  }

  return DUPLICATE_STATUS.NONE;
}

/*
 * 保存前確認（v2.0 §8）。
 *
 * ==================================================================
 * 自動確定のリスクを人の目で止める、最後の関門
 * ==================================================================
 * ここを飛ばして保存できる経路を作らないこと。
 * §15.1 が「誤った値を信頼度が高いとして提示した件数0件」を求めており、
 * 機械が確信していても、人が見る機会は残す。
 * ==================================================================
 *
 * このファイルは画面に出す「形」を作るだけで、DOM を触らない。
 * 描画は app.js が textContent で行う（innerHTML を使わない。§13）。
 */

import { DATA_COLUMNS, columnOf } from './schema.js';
import { EXTRACTION_METHOD, REVIEW_STATUS, decideExtractionMethod } from './status.js';
import { shouldHighlight } from './confidence.js';
import { RECONCILE } from './ai-complete.js';

/* 確認画面に並べる項目。必須3項目を先頭に置く（§8）。 */
export const REVIEW_FIELDS = Object.freeze([
  'usedOn',
  'payee',
  'totalAmount',
  'taxTotal',
  'tax8Base',
  'tax8Amount',
  'tax10Base',
  'tax10Amount',
  'taxNotation',
  'paymentMethod',
  'registrationNumber',
  'registrationStatus',
  'receiptNumber',
  'phoneNumber',
  'addressee',
  'note',
  'summary',
  'accountCandidate',
]);

const REQUIRED_KEYS = new Set(['usedOn', 'payee', 'totalAmount']);

function text(value) {
  return value === null || value === undefined ? '' : String(value);
}

/*
 * 確認画面に出す行を作る。
 *
 * highlight が true の項目を強調表示する（§8）。
 * 強調の理由は「値が無い」「突合で食い違った」「信頼度が低い」の3つ。
 */
export function buildReviewModel({
  values = {},
  reconciliation = null,
  confidenceLevel = null,
  fields = REVIEW_FIELDS,
} = {}) {
  const rows = fields.map((key) => {
    const column = columnOf(DATA_COLUMNS, key);
    const value = text(values[key]);
    const field = reconciliation?.fields?.[key] ?? null;
    const missing = REQUIRED_KEYS.has(key) && value === '';
    const conflicted = field?.status === RECONCILE.CONFLICT;

    return {
      key,
      label: column?.header ?? key,
      value,
      required: REQUIRED_KEYS.has(key),
      missing,
      /* 食い違ったときは AI 側の値も見せて、人が選べるようにする。 */
      aiValue: conflicted ? text(field.aiValue) : '',
      status: field?.status ?? null,
      highlight: shouldHighlight({
        level: confidenceLevel,
        needsReview: Boolean(field?.needsReview),
        missing,
      }),
    };
  });

  return {
    rows,
    highlightCount: rows.filter((row) => row.highlight).length,
  };
}

/*
 * 利用者が直した値を反映する（§8）。
 *
 * **利用者が修正した値は抽出値より優先する。**
 * 1つでも直っていれば extractionMethod は MANUAL になる（v1.3 §18.1-4）。
 * 前後の空白だけの違いは修正とみなさない（誤って MANUAL にしないため）。
 */
export function applyEdits(values, edits, { fields = REVIEW_FIELDS } = {}) {
  const next = { ...values };
  const changed = [];

  for (const key of fields) {
    if (!Object.hasOwn(edits ?? {}, key)) {
      continue;
    }

    const before = text(values[key]).trim();
    const after = text(edits[key]).trim();

    if (before === after) {
      continue;
    }

    next[key] = after;
    changed.push(key);
  }

  return { values: next, changed, edited: changed.length > 0 };
}

/*
 * 保存する1件を組み立てる。
 *
 * ここで extractionMethod と reviewStatus が決まる。
 * 「要確認のまま保存」も選べる（§8 末尾）ため、
 * keepReview が true なら検証が通っていても REQUIRED のままにする。
 */
export function buildRecord({
  values = {},
  edited = false,
  usedRule = true,
  usedGemini = false,
  validation = null,
  reconciliation = null,
  confidence = null,
  duplicateStatus,
  keepReview = false,
  recordId,
  imageHash = '',
  original = {},
  now = '',
} = {}) {
  const needsReview = keepReview
    || validation?.ok === false
    || Boolean(reconciliation?.needsReview);

  const warnings = [...(validation?.warnings ?? [])];

  if (reconciliation?.needsReview) {
    const conflicted = Object.entries(reconciliation.fields ?? {})
      .filter(([, field]) => field.needsReview)
      .map(([key]) => key);

    if (conflicted.length > 0) {
      warnings.push(`AI補完と食い違い（${conflicted.join(', ')}）`);
    }
  }

  return {
    ...values,
    recordId,
    createdAt: now,
    updatedAt: now,
    imageHash,
    originalFileName: original.name ?? '',
    originalFileId: original.id ?? '',
    originalUrl: original.url ?? '',
    /* 科目確定フラグの初期値は必ず「未確定」（v1.3 §10.8）。 */
    accountConfirmed: '未確定',
    extractionMethod: decideExtractionMethod({ usedRule, usedGemini, edited }),
    completionUsed: usedGemini ? '実施' : '未実施',
    confidenceScore: confidence?.score ?? '',
    confidenceLevel: confidence?.level ?? '',
    reviewStatus: needsReview ? REVIEW_STATUS.REQUIRED : REVIEW_STATUS.NOT_REQUIRED,
    duplicateStatus,
    warnings: warnings.join(' / '),
  };
}

export { EXTRACTION_METHOD, REVIEW_STATUS };

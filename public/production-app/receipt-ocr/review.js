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
 * 検証の警告を、関係する項目へ割り当てる（v1.3 §13）。
 *
 * ------------------------------------------------------------------
 * 警告はシートだけでなく画面にも出す
 * ------------------------------------------------------------------
 * 当初は buildRecord() が警告内容列へ書くだけで、確認画面には
 * 出していなかった。実機で未来日（§13.2）が入った領収書を保存する際、
 * 画面に何の断りも出ないことが分かった。
 *
 * 警告は「人が直す判断材料」なので、直せる場所＝確認画面に出す。
 * 値そのものは消さない（消すと、何を直せばよいか分からなくなる）。
 * ------------------------------------------------------------------
 */
function warningsByField(validation) {
  if (!validation) {
    return {};
  }

  return {
    usedOn: [...(validation.date?.warnings ?? [])],
    totalAmount: [...(validation.amount?.warnings ?? [])],
  };
}

/*
 * 確認画面に出す行を作る。
 *
 * highlight が true の項目を強調表示する（§8）。
 * 強調の理由は「値が無い」「突合で食い違った」「検証の警告がある」
 * 「信頼度が低い」の4つ。
 */
export function buildReviewModel({
  values = {},
  reconciliation = null,
  confidenceLevel = null,
  validation = null,
  fields = REVIEW_FIELDS,
} = {}) {
  const fieldWarnings = warningsByField(validation);

  const rows = fields.map((key) => {
    const column = columnOf(DATA_COLUMNS, key);
    const value = text(values[key]);
    const field = reconciliation?.fields?.[key] ?? null;
    const missing = REQUIRED_KEYS.has(key) && value === '';
    const conflicted = field?.status === RECONCILE.CONFLICT;
    const warnings = fieldWarnings[key] ?? [];

    return {
      key,
      label: column?.header ?? key,
      value,
      required: REQUIRED_KEYS.has(key),
      missing,
      /* 食い違ったときは AI 側の値も見せて、人が選べるようにする。 */
      aiValue: conflicted ? text(field.aiValue) : '',
      status: field?.status ?? null,
      warnings,
      highlight: warnings.length > 0 || shouldHighlight({
        level: confidenceLevel,
        needsReview: Boolean(field?.needsReview),
        missing,
      }),
    };
  });

  /*
   * どの項目にも結び付かない警告（必須項目の不足、税率別対象額の不一致など）。
   * 画面の上部へまとめて出す。
   */
  const attached = new Set(Object.values(fieldWarnings).flat());
  const general = (validation?.warnings ?? []).filter((warning) => !attached.has(warning));

  return {
    rows,
    warnings: [...(validation?.warnings ?? [])],
    generalWarnings: general,
    highlightCount: rows.filter((row) => row.highlight).length,
  };
}

/*
 * 突合で食い違い、AI 側の値が示されている項目。
 * 確認画面の「この値を使う」ボタンは、ここに挙がった項目にだけ出る。
 */
export function conflictedAiValues(reconciliation, { fields = REVIEW_FIELDS } = {}) {
  const out = {};

  for (const key of fields) {
    const field = reconciliation?.fields?.[key];

    if (field?.status === RECONCILE.CONFLICT && text(field.aiValue) !== '') {
      out[key] = text(field.aiValue);
    }
  }

  return out;
}

/*
 * 利用者が直した値を反映する（§8）。
 *
 * **利用者が修正した値は抽出値より優先する。**
 * 前後の空白だけの違いは修正とみなさない（誤って MANUAL にしないため）。
 *
 * ------------------------------------------------------------------
 * 「AIの読み取りを採用した」と「人が打ち直した」を分ける
 * ------------------------------------------------------------------
 * 画面の「この値を使う」で AI の値を入れた場合、人が新しい値を
 * 作ったわけではない。ルールと AI の両方を使った結果なので HYBRID にあたる。
 * 打ち直しだけを MANUAL とする（v1.3 §18.1-4 の「人手修正の識別」）。
 *
 * 判定はボタンの押下履歴ではなく、**入っている値が AI の値と同じか**で行う。
 * 押したあとに手で打ち直しても、正しく MANUAL に倒れる。
 * ------------------------------------------------------------------
 */
export function applyEdits(values, edits, { fields = REVIEW_FIELDS, reconciliation = null } = {}) {
  const next = { ...values };
  const aiValues = conflictedAiValues(reconciliation, { fields });
  const changed = [];
  const adopted = [];
  const manual = [];

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

    if (Object.hasOwn(aiValues, key) && aiValues[key].trim() === after) {
      adopted.push(key);
    } else {
      manual.push(key);
    }
  }

  return {
    values: next,
    changed,
    adopted,
    manual,
    /* MANUAL にするのは打ち直しがあったときだけ。 */
    edited: manual.length > 0,
    adoptedFromAi: adopted.length > 0,
  };
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

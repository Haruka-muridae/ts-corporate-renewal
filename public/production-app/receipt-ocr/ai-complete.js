/*
 * Gemini による補完（仕様書 §5-⑦ / §7 の 12.2〜12.5・13章）。
 *
 * ==================================================================
 * 独立抽出（§7「ルール候補をプロンプトに含めない」）
 * ==================================================================
 * ルール抽出が出した候補を Gemini へ見せない。見せると、
 * ルール側の誤読をそのまま追認する答えが返り、
 * 「2つの方法で読んで突き合わせる」という仕掛けが意味を失う。
 *
 * buildPrompt() は OCR原文しか受け取らない。**候補を引数に足さないこと。**
 * ==================================================================
 *
 * ==================================================================
 * confidence を使わない・evidence を必須にする（§7）
 * ==================================================================
 * Gemini 自身が申告する確信度は、当たっていなくても高く出る。
 * 代わりに evidence（そう読んだ根拠となる原文の一部）を必ず出させ、
 * **それが OCR原文に実在するかどうかをこちら側で確かめる**（§13）。
 *
 * 原文に無い文字列を根拠として挙げてきたら、その値は幻覚とみなして
 * 採用しない。これが §13 の「幻覚検出という品質チェック」である。
 * ==================================================================
 */

import { AppError, PROGRESS } from './errors.js';
import { generate, textOf } from './gemini-client.js';
import { normalizeAmount } from './amount.js';
import { parseDate } from './extract.js';

/*
 * 補完してもらう項目。
 *
 * 並びと名前は schema.js の列キーに合わせてある。
 * 増やすときは schema.js と一緒に直すこと。
 */
export const COMPLETION_FIELDS = Object.freeze([
  'payee',
  'usedOn',
  'totalAmount',
  'taxTotal',
  'tax8Base',
  'tax8Amount',
  'tax10Base',
  'tax10Amount',
  'paymentMethod',
  'registrationNumber',
  'receiptNumber',
  'phoneNumber',
  'accountCandidate',
  'summary',
]);

/* Gemini のタイムアウト（v1.3 §12.3）。 */
export const TIMEOUT_MS = 30000;

/*
 * Structured Output のスキーマ（§7 12.2〜12.5）。
 *
 * 各項目は { value, evidence } の対にする。
 * evidence を必須にしておけば、根拠なしの値が構造上返ってこない。
 */
export function responseSchema(fields = COMPLETION_FIELDS) {
  const properties = {};

  for (const field of fields) {
    properties[field] = {
      type: 'object',
      properties: {
        value: { type: 'string' },
        evidence: { type: 'string' },
      },
      required: ['value', 'evidence'],
    };
  }

  return { type: 'object', properties, required: [...fields] };
}

/*
 * プロンプト。
 *
 * **引数は OCR原文だけ。** ルール抽出の候補を渡す口を作らないこと（独立抽出）。
 */
export function buildPrompt(ocrText) {
  return [
    '以下は日本の領収書をOCRした文字列です。',
    '',
    '事実として読み取れる情報のみを抽出してください。',
    '不明な項目は空文字を返してください。',
    '金額を推測で補完しないでください。',
    '各項目について、根拠となったOCR文字列の該当箇所をevidenceとして返してください。',
    'evidenceには、下の文字列に実際に現れる部分をそのまま写してください。',
    '',
    '抽出項目：',
    '・支払先',
    '・利用日',
    '・合計金額',
    '・消費税合計と税率別内訳（8％・10％の対象額・税額）',
    '・支払方法',
    '・適格請求書登録番号',
    '・レシートNo.',
    '・電話番号',
    '・勘定科目候補',
    '・摘要',
    '',
    '--- OCR文字列ここから ---',
    String(ocrText ?? ''),
    '--- OCR文字列ここまで ---',
  ].join('\n');
}

/* ---------- サニタイズ（§7 12.2〜12.5） ---------- */

const MAX_VALUE_LENGTH = 200;
const MAX_EVIDENCE_LENGTH = 400;

/*
 * 制御文字を落とす。
 *
 * 正規表現の文字クラスに制御文字を直接書くと、ファイルそのものに
 * 制御文字が混ざり、Git がバイナリとして扱う。コードポイントで判定する。
 */
function stripControl(text) {
  let out = '';

  for (const ch of text) {
    const code = ch.codePointAt(0);

    if (code >= 0x20 && code !== 0x7f) {
      out += ch;
    }
  }

  return out;
}

export function sanitizeText(value, max = MAX_VALUE_LENGTH) {
  if (typeof value !== 'string') {
    return '';
  }

  return stripControl(value).trim().slice(0, max);
}

/*
 * 応答（JSON文字列）を読み、形の合わない部分を捨てる。
 * 壊れた JSON でも例外を投げず null を返す（呼び出し側がリトライを決める）。
 */
/*
 * Markdown のコードフェンスを剥がす（v1.3 §12.3）。
 *
 * Structured Output を指定していても、モデルが ```json で包むことがある。
 * JSON.parse の前に落としておく。
 */
export function stripCodeFence(rawText) {
  const text = String(rawText ?? '').trim();
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);

  return fenced ? fenced[1].trim() : text;
}

export function parseResponse(rawText, fields = COMPLETION_FIELDS) {
  let parsed;

  try {
    parsed = JSON.parse(stripCodeFence(rawText));
  } catch {
    return null;
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }

  const out = {};

  for (const field of fields) {
    const entry = parsed[field];

    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      out[field] = { value: '', evidence: '' };
      continue;
    }

    out[field] = {
      value: sanitizeText(entry.value, MAX_VALUE_LENGTH),
      evidence: sanitizeText(entry.evidence, MAX_EVIDENCE_LENGTH),
    };
  }

  return out;
}

/* ---------- evidence 照合（§13） ---------- */

/*
 * evidence を原文から探すための正規化。
 *
 * OCR は空白や改行の入り方が安定しない。そこだけ吸収する。
 * 文字そのものは変えない（別の文字へ読み替えると照合の意味が薄れる）。
 */
function normalizeForSearch(text) {
  return String(text ?? '').replace(/[\s　]/g, '');
}

/* ---------- 突合のための正規化（項目ごと） ---------- */

/*
 * ==================================================================
 * 書き方の違いを「食い違い」と呼ばない
 * ==================================================================
 * ルール抽出と Gemini は同じ値を別の書き方で返す。
 *
 *   電話番号  07012400971   と 070-1240-0971
 *   金額      1200          と ¥1,200
 *   日付      2026-08-01    と 2026年8月1日
 *
 * 空白を落とすだけの比較では、これらが全部「不一致」になる。
 * 不一致は §12.2 により要確認へ回るため、正しく読めている領収書まで
 * 人の手に戻ってしまい、要確認が意味を持たなくなる。
 *
 * そこで、比較のときだけ項目の性質に合わせて正規化する。
 * **シートへ書く値は正規化しない。** ここでやるのは比較のための
 * 見比べ方の統一であって、値の書き換えではない。
 * ==================================================================
 */

/* 数値として比べる項目（金額系）。 */
const AMOUNT_FIELDS = new Set([
  'totalAmount', 'taxTotal', 'tax8Base', 'tax8Amount', 'tax10Base', 'tax10Amount',
]);

/* 日付として比べる項目。 */
const DATE_FIELDS = new Set(['usedOn']);

/*
 * 区切り記号を無視して比べる項目。
 * 電話番号・登録番号・レシートNo. は、ハイフンの有無だけが違うことが多い。
 */
const IDENTIFIER_FIELDS = new Set(['phoneNumber', 'registrationNumber', 'receiptNumber']);

export function comparableValue(field, value) {
  const text = String(value ?? '').trim();

  if (text === '') {
    return '';
  }

  if (AMOUNT_FIELDS.has(field)) {
    const number = normalizeAmount(text);
    return number === null ? normalizeForSearch(text) : String(number);
  }

  if (DATE_FIELDS.has(field)) {
    return parseDate(text) ?? normalizeForSearch(text);
  }

  if (IDENTIFIER_FIELDS.has(field)) {
    /* 記号だけを落とす。文字と数字は残す（T の有無は意味を持つ）。 */
    return normalizeForSearch(text).replace(/[-‐-―ー()（）.]/g, '').toUpperCase();
  }

  return normalizeForSearch(text);
}

/*
 * evidence が OCR原文に実在するか。
 *
 * 実在しなければ、その値は採用しない。
 * 空の evidence も「根拠なし」として不採用にする。
 */
export function evidenceExists(evidence, ocrText) {
  const needle = normalizeForSearch(evidence);

  if (needle === '') {
    return false;
  }

  return normalizeForSearch(ocrText).includes(needle);
}

/* ---------- 突合（§5-⑦） ---------- */

export const RECONCILE = Object.freeze({
  /* ルールと AI が一致した。 */
  AGREED: 'agreed',
  /* ルールが空で、AI の値を採用した。 */
  FILLED: 'filled',
  /* 食い違った。自動確定しない（要確認）。 */
  CONFLICT: 'conflict',
  /* AI の根拠が原文に無い。幻覚とみなし不採用（§13）。 */
  REJECTED: 'rejected',
  /* どちらも値なし。 */
  EMPTY: 'empty',
});

/*
 * 同じ値とみなしてよいか。
 *
 * field を渡すと、その項目の性質に合わせて見比べる（comparableValue）。
 * 渡さない場合は空白を落とすだけの比較に戻る。
 */
function sameValue(a, b, field = null) {
  const left = field ? comparableValue(field, a) : normalizeForSearch(a);
  const right = field ? comparableValue(field, b) : normalizeForSearch(b);

  return left === right && left !== '';
}

/*
 * 1項目を突き合わせる。
 *
 * 手順（順番に意味がある）:
 *   1. AI の根拠が原文に無ければ、AI の値は最初から無かったものとする
 *   2. ルールと AI が一致したら採用する
 *   3. ルールが空で AI だけがあるなら、AI を採用する（これが「補完」）
 *   4. 食い違ったら、**どちらも自動では採らない**（要確認）
 *
 * 4 を「どちらか一方を優先する」に変えないこと。
 * §15.1 は「誤った値を信頼度が高いとして提示した件数0件」を求めており、
 * 食い違いは、人が見るべき合図である。
 */
export function reconcileField({ ruleValue = '', ai = null, ocrText = '', field = null } = {}) {
  const rule = sanitizeText(ruleValue);

  if (!ai || !evidenceExists(ai.evidence, ocrText)) {
    /* 根拠が確かめられない。AI の値は使わない。 */
    if (rule !== '') {
      return { status: RECONCILE.REJECTED, value: rule, needsReview: false, source: 'rule' };
    }

    const attempted = sanitizeText(ai?.value ?? '');

    return {
      status: attempted === '' ? RECONCILE.EMPTY : RECONCILE.REJECTED,
      value: '',
      /* 幻覚を捨てた結果、値が無いまま残る。人に見てもらう。 */
      needsReview: attempted !== '',
      source: 'none',
    };
  }

  const aiValue = sanitizeText(ai.value);

  if (rule === '' && aiValue === '') {
    return { status: RECONCILE.EMPTY, value: '', needsReview: false, source: 'none' };
  }

  if (sameValue(rule, aiValue, field)) {
    /*
     * 一致。書き方が違うだけのことがあるが、値としては同じなので
     * ルール側の書き方を残す（シートの表記を揺らさないため）。
     */
    return { status: RECONCILE.AGREED, value: rule, needsReview: false, source: 'both' };
  }

  if (rule === '') {
    return { status: RECONCILE.FILLED, value: aiValue, needsReview: false, source: 'ai' };
  }

  if (aiValue === '') {
    return { status: RECONCILE.REJECTED, value: rule, needsReview: false, source: 'rule' };
  }

  /* 食い違い。自動で決めない。 */
  return {
    status: RECONCILE.CONFLICT,
    value: rule,
    aiValue,
    needsReview: true,
    source: 'rule',
  };
}

/* 全項目ぶん突き合わせる。1つでも要確認があれば全体を要確認とする。 */
export function reconcile({ ruleValues = {}, aiValues = {}, ocrText = '', fields = COMPLETION_FIELDS } = {}) {
  const results = {};
  let needsReview = false;

  for (const field of fields) {
    const result = reconcileField({
      ruleValue: ruleValues[field] ?? '',
      ai: aiValues?.[field] ?? null,
      ocrText,
      field,
    });

    results[field] = result;

    if (result.needsReview) {
      needsReview = true;
    }
  }

  return { fields: results, needsReview };
}

/* ---------- 呼び出し（リトライ1回） ---------- */

/*
 * 補完を実行する。
 *
 * 形の壊れた応答が返ったときだけ、**1回だけ**やり直す（§7）。
 * それ以上は試さない。利用者のクォータを黙って使わないため。
 *
 * キーが無ければ KEY-001。会社のキーへは落とさない（§13）。
 */
export async function complete({ apiKey, ocrText, fields = COMPLETION_FIELDS, signal } = {}) {
  if (String(apiKey ?? '').trim() === '') {
    throw new AppError('KEY-001', { progress: PROGRESS.ORIGINAL_SAVED, detail: 'no_key' });
  }

  const body = {
    contents: [{ role: 'user', parts: [{ text: buildPrompt(ocrText) }] }],
    generationConfig: {
      temperature: 0,
      responseMimeType: 'application/json',
      responseSchema: responseSchema(fields),
    },
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { result } = await generate({ apiKey, body, signal, progress: PROGRESS.ORIGINAL_SAVED });
    const parsed = parseResponse(textOf(result), fields);

    if (parsed) {
      return parsed;
    }
  }

  /* 2回とも読めなかった。補完なしで進める（要確認になる）。 */
  return null;
}

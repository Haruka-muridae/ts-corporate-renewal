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

/*
 * 補完してもらう項目。
 *
 * 並びと名前は schema.js の列キーに合わせてある。
 * 増やすときは schema.js と一緒に直すこと。
 */
export const COMPLETION_FIELDS = Object.freeze([
  'usedOn',
  'payee',
  'totalAmount',
  'receiptNumber',
  'phoneNumber',
  'registrationNumber',
  'paymentMethod',
  'addressee',
  'note',
]);

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
    '次の文字列は、日本の領収書・レシートを読み取った結果です。',
    '各項目について、値と、そう判断した根拠を答えてください。',
    '',
    '守ること:',
    '- 根拠（evidence）には、下の文字列に**実際に現れる部分**をそのまま写すこと',
    '- 読み取れない項目は、値・根拠ともに空文字にすること',
    '- 推測で補わないこと。書かれていないものは空文字にすること',
    '',
    '--- 読み取り結果ここから ---',
    String(ocrText ?? ''),
    '--- 読み取り結果ここまで ---',
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
export function parseResponse(rawText, fields = COMPLETION_FIELDS) {
  let parsed;

  try {
    parsed = JSON.parse(String(rawText ?? ''));
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
 * 突き合わせのための正規化。
 *
 * OCR は空白や改行の入り方が安定しない。そこだけ吸収する。
 * 文字そのものは変えない（別の文字へ読み替えると照合の意味が薄れる）。
 */
function normalizeForSearch(text) {
  return String(text ?? '').replace(/[\s　]/g, '');
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

function sameValue(a, b) {
  return normalizeForSearch(a) === normalizeForSearch(b) && normalizeForSearch(a) !== '';
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
export function reconcileField({ ruleValue = '', ai = null, ocrText = '' } = {}) {
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

  if (sameValue(rule, aiValue)) {
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

/*
 * Gemini の結果と正規表現の結果を突き合わせる（§FR-10・FR-14）。
 *
 * ==================================================================
 * どちらが正か
 * ==================================================================
 * §FR-10 は「**用途分類は Gemini 優先**」としている。会社名・氏名・
 * 役職・住所のように文脈が要る判断は Gemini のほうが強い。
 *
 * ただし例外が1つある。**電話番号の種別だけは正規表現が正**である。
 * 日本の携帯番号は 070 / 080 / 090 で始まると決まっており、
 * これは文脈ではなく形の問題だからである。
 *
 * フェーズ0の予行で「同じ番号が phone と mobile の両方に入る」
 * 不具合が出た（計画 §7-5-3 の課題3）。プロンプトでも禁じたが、
 * **形で決められるものを言葉で頼まない。**
 * ==================================================================
 *
 * ==================================================================
 * 空欄だけを埋める。上書きはしない
 * ==================================================================
 * 正規表現が見つけた値は、Gemini が空にした項目にだけ入れる。
 * 埋めたことは patternFilled に残し、確認画面で示せるようにする
 * （§FR-15 の5「値の由来をたどれるようにする」と同じ考え方）。
 * ==================================================================
 *
 * DOM も通信も持たない純粋関数。
 */

import { isMobileNumber, normalizePhoneDigits } from './extract.js';

/* 正規表現が担当してよい項目。**会社名・氏名・役職は入れない。** */
export const PATTERN_FIELDS = Object.freeze([
  'email', 'url', 'postalCode', 'phone', 'mobile', 'fax',
]);

/* 台帳と確認画面が扱う項目（§11.2 の中身の列）。 */
export const VALUE_FIELDS = Object.freeze([
  'companyName', 'departmentName', 'jobTitle', 'fullName', 'fullNameKana',
  'postalCode', 'address', 'phone', 'mobile', 'fax', 'email', 'url',
  /* v3.5: どの項目にも入らなかった読み取り内容。 */
  'otherInformation',
]);

/*
 * 複数行になりうる項目（画面では textarea、台帳では改行入りのセル）。
 *
 * Gemini は配列で返す。**つなぐ側をこちらに寄せる**ことで、
 * 画面・台帳・編集後の読み戻しが同じ形（改行区切りの文字列）で揃う。
 */
export const MULTILINE_FIELDS = Object.freeze(['otherInformation']);

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function list(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
}

/*
 * 電話番号の種別を整える。
 *
 *   1. 070/080/090 の番号が phone にあれば mobile へ移す
 *   2. **phone と mobile が同じ番号なら phone を空にする**
 *   3. 空いた項目を正規表現の候補で埋める
 *
 * 2 で phone のほうを空けるのは、番号の形が携帯だと分かっているため。
 * 固定電話として残すほうが誤りである。
 */
export function reconcilePhones(values, patterns) {
  const result = { ...values };
  const moved = [];

  const phone = text(result.phone);
  const mobile = text(result.mobile);

  /* 1. 形が携帯なら mobile が正しい置き場所。 */
  if (phone !== '' && isMobileNumber(phone)) {
    if (mobile === '') {
      result.mobile = phone;
      result.phone = '';
      moved.push('phone→mobile');
    } else if (normalizePhoneDigits(phone) === normalizePhoneDigits(mobile)) {
      /* 2. 同じ番号が両方に入っている。 */
      result.phone = '';
      moved.push('phone(重複を削除)');
    } else {
      /* 携帯が2つ。phone に置いたままにはしない。 */
      result.phone = '';
      moved.push('phone(携帯のため削除)');
    }
  } else if (
    phone !== '' && mobile !== ''
    && normalizePhoneDigits(phone) === normalizePhoneDigits(mobile)
  ) {
    /* 形は固定電話だが、同じ番号が両方にある。mobile 側を空ける。 */
    result.mobile = '';
    moved.push('mobile(重複を削除)');
  }

  /* 3. 空いた項目を候補で埋める。 */
  for (const field of ['phone', 'mobile', 'fax']) {
    if (text(result[field]) !== '') {
      continue;
    }

    const candidate = (patterns?.[field] ?? []).find((value) => {
      const digits = normalizePhoneDigits(value);

      /* すでに他の項目に入っている番号は使わない。 */
      return !['phone', 'mobile', 'fax']
        .some((other) => normalizePhoneDigits(text(result[other])) === digits && digits !== '');
    });

    if (candidate) {
      result[field] = candidate;
    }
  }

  return { values: result, moved };
}

/*
 * 突き合わせる。
 *
 * 戻り値:
 *   values        … 台帳へ入れる値（VALUE_FIELDS のみ）
 *   patternFilled … 正規表現で埋めた項目名
 *   reclassified  … 電話番号の種別を直した記録
 *   uncertainFields / fromBackFields / conflicts … Gemini の申告をそのまま
 */
export function mergeExtraction(aiResult = {}, patterns = {}) {
  const values = {};

  for (const field of VALUE_FIELDS) {
    /*
     * 配列で返る項目は改行でつなぐ。
     * **空の要素は落とす。** モデルが空文字を混ぜることがあり、
     * そのままだと台帳のセルに空行が並ぶ。
     */
    if (MULTILINE_FIELDS.includes(field)) {
      values[field] = list(aiResult[field])
        .map((item) => item.trim())
        .filter((item) => item !== '')
        .join('\n');
      continue;
    }

    values[field] = text(aiResult[field]);
  }

  const { values: withPhones, moved } = reconcilePhones(values, patterns);
  const patternFilled = [];

  /* 電話以外の空欄を候補で埋める。**先頭の候補だけを使う。** */
  for (const field of ['email', 'url', 'postalCode']) {
    if (text(withPhones[field]) !== '') {
      continue;
    }

    const candidate = (patterns?.[field] ?? [])[0];

    if (candidate) {
      withPhones[field] = candidate;
      patternFilled.push(field);
    }
  }

  /* 電話系も、埋まったものは記録する。 */
  for (const field of ['phone', 'mobile', 'fax']) {
    if (text(values[field]) === '' && text(withPhones[field]) !== '' && !moved.length) {
      patternFilled.push(field);
    }
  }

  return {
    values: withPhones,
    patternFilled,
    reclassified: moved,
    uncertainFields: list(aiResult.uncertainFields),
    fromBackFields: list(aiResult.fromBackFields),
    conflicts: list(aiResult.conflicts),
  };
}

/*
 * 確認画面で目立たせる項目（§FR-15 の5）。
 *
 * **重複を除いてから返す。** 同じ項目が uncertainFields と conflicts の
 * 両方に出ることがあり、そのまま並べると同じ警告が2回出る。
 */
export function fieldsNeedingReview(merged) {
  return [...new Set([
    ...list(merged?.uncertainFields),
    ...list(merged?.conflicts),
  ])];
}

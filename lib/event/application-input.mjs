/*
 * 申込フォームの入力を検証して、DBに保存できる形にそろえる（実装仕様書 4.2）。
 *
 * ==================================================================
 * 方針
 * ==================================================================
 *   - 検証はサーバー側で必ず通す。ブラウザ側の検証は入力を助けるためだけのもので、
 *     信用しない。
 *   - 金額は受け取らない。支払額はサーバーが lib/event/pricing.mjs で計算する
 *     （仕様書5.1）。この関数は金額に関する入力を一切見ない。
 *   - 同意3つが揃っていなければ、その時点で不合格にする（受入条件8）。
 * ==================================================================
 */

import {
  INDUSTRY_KEYS,
  OCCUPATION_KEYS,
  POSITION_KEYS,
  AGE_GROUP_KEYS,
} from './pricing.mjs';

/** 入力欄ごとの上限。DBの列も文字列型のため、ここで長さを抑える。 */
export const MAX_LENGTHS = {
  name: 100,
  nameKana: 100,
  email: 254,
  phone: 20,
  company: 200,
  department: 100,
  jobTitle: 100,
  otherText: 100,
};

/** 同意項目。3つすべてが必須（仕様書4.2）。 */
export const CONSENT_FIELDS = ['agreeTerms', 'agreeCancelPolicy', 'agreePrivacy'];

/*
 * 全角スペースも空白として扱い、前後を落とす。
 * 「　山田　太郎　」のような入力をそのまま保存しないため。
 */
function trim(value) {
  return typeof value === 'string' ? value.replace(/^[\s　]+|[\s　]+$/g, '') : '';
}

/*
 * 制御文字を含む値は受け付けない。
 * メールの差し込みや、CSV出力時の行崩れの原因になるため。
 */
function hasControlCharacter(value) {
  /* 正規表現に制御文字をそのまま書かず、符号位置で判定する。 */
  for (const char of value) {
    const code = char.codePointAt(0);

    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }

  return false;
}

function checkText(errors, field, value, { required = true, max, label }) {
  if (value === '') {
    if (required) {
      errors[field] = `${label}を入力してください`;
    }

    return;
  }

  if (hasControlCharacter(value)) {
    errors[field] = `${label}に使用できない文字が含まれています`;
    return;
  }

  if (value.length > max) {
    errors[field] = `${label}は${max}文字以内で入力してください`;
  }
}

/*
 * メールアドレスの形式。
 * RFCを厳密に見ず、「@が1つ」「前後が空でない」「ドメインに.がある」までにする。
 * 打ち間違いを拾うのが目的で、送信可否の最終判断はしない。
 */
function checkEmail(errors, value) {
  if (value === '') {
    errors.email = 'メールアドレスを入力してください';
    return;
  }

  if (value.length > MAX_LENGTHS.email) {
    errors.email = `メールアドレスは${MAX_LENGTHS.email}文字以内で入力してください`;
    return;
  }

  if (!/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(value)) {
    errors.email = 'メールアドレスの形式が正しくありません';
  }
}

/*
 * 電話番号。数字が10〜11桁あることだけを見る。
 * ハイフン・括弧・空白は入力の揺れとして許し、保存時に数字とハイフンへそろえる。
 */
function checkPhone(errors, value) {
  if (value === '') {
    errors.phone = '電話番号を入力してください';
    return;
  }

  const digits = value.replace(/[^0-9]/g, '');

  if (!/^[0-9()\-\s+]+$/.test(value) || digits.length < 10 || digits.length > 11) {
    errors.phone = '電話番号は10桁または11桁の数字で入力してください';
  }
}

/*
 * フリガナ。ひらがな・カタカナのどちらでも受け付ける。
 * 「カナで入れ直してください」と突き返す価値のある場面ではないため、
 * 全角カタカナへそろえて保存する。
 */
function checkKana(errors, value) {
  if (value === '') {
    errors.nameKana = '氏名フリガナを入力してください';
    return;
  }

  if (value.length > MAX_LENGTHS.nameKana) {
    errors.nameKana = `氏名フリガナは${MAX_LENGTHS.nameKana}文字以内で入力してください`;
    return;
  }

  if (!/^[ぁ-ゖァ-ヺー・\s　ー]+$/.test(value)) {
    errors.nameKana = '氏名フリガナはひらがなまたはカタカナで入力してください';
  }
}

/** ひらがなを全角カタカナにそろえる。 */
export function toKatakana(value) {
  return value.replace(/[ぁ-ゖ]/g, (char) =>
    String.fromCharCode(char.charCodeAt(0) + 0x60));
}

function checkChoice(errors, field, value, allowed, label) {
  if (value === '') {
    errors[field] = `${label}を選択してください`;
    return;
  }

  if (!allowed.includes(value)) {
    errors[field] = `${label}の選択肢が正しくありません`;
  }
}

/*
 * 「該当する」「該当しない」のどちらかが明示的に選ばれていること。
 * 未選択を「該当しない」に倒すと、申告漏れが黙って安い金額になるため
 * 未選択は不合格にする。
 */
function parseBannedDeclared(errors, raw) {
  if (raw === 'yes') return true;
  if (raw === 'no') return false;

  errors.isBannedDeclared = '出入り禁止・参加お断りの通告について選択してください';
  return null;
}

/**
 * フォームの入力を検証する。
 *
 * @param {Record<string, unknown>} raw フォームの値（文字列想定）
 * @returns {{ ok: boolean, errors: Record<string, string>, value: object | null }}
 */
export function validateApplicationInput(raw) {
  const errors = {};

  const name = trim(raw.name);
  const nameKana = trim(raw.nameKana);
  const email = trim(raw.email);
  const phone = trim(raw.phone);
  const company = trim(raw.company);
  const department = trim(raw.department);
  const jobTitle = trim(raw.jobTitle);

  checkText(errors, 'name', name, { max: MAX_LENGTHS.name, label: '氏名' });
  checkKana(errors, nameKana);
  checkEmail(errors, email);
  checkPhone(errors, phone);
  checkText(errors, 'company', company, { max: MAX_LENGTHS.company, label: '会社名または団体名' });
  checkText(errors, 'department', department, {
    required: false, max: MAX_LENGTHS.department, label: '部署名',
  });
  checkText(errors, 'jobTitle', jobTitle, {
    required: false, max: MAX_LENGTHS.jobTitle, label: '役職名',
  });

  const industry = trim(raw.industry);
  const occupation = trim(raw.occupation);
  const position = trim(raw.position);
  const ageGroup = trim(raw.ageGroup);

  checkChoice(errors, 'industry', industry, INDUSTRY_KEYS, '業界');
  checkChoice(errors, 'occupation', occupation, OCCUPATION_KEYS, '職種');
  checkChoice(errors, 'position', position, POSITION_KEYS, '立場');
  checkChoice(errors, 'ageGroup', ageGroup, AGE_GROUP_KEYS, '年齢区分');

  /*
   * 「その他」を選んだときだけ自由記述を必須にする。
   * 逆に、その他以外で自由記述が入っていたら捨てる（DBの制約と食い違わせない）。
   */
  const industryOtherText = trim(raw.industryOtherText);
  const occupationOtherText = trim(raw.occupationOtherText);

  if (industry === 'other') {
    checkText(errors, 'industryOtherText', industryOtherText, {
      max: MAX_LENGTHS.otherText, label: '業界（その他）の内容',
    });
  }

  if (occupation === 'other') {
    checkText(errors, 'occupationOtherText', occupationOtherText, {
      max: MAX_LENGTHS.otherText, label: '職種（その他）の内容',
    });
  }

  const isBannedDeclared = parseBannedDeclared(errors, trim(raw.isBannedDeclared));

  /* 同意は3つとも必要。ひとつでも欠ければ決済へ進ませない。 */
  CONSENT_FIELDS.forEach((field) => {
    if (raw[field] !== 'on' && raw[field] !== true && raw[field] !== 'true') {
      errors[field] = '同意が必要です';
    }
  });

  if (Object.keys(errors).length > 0) {
    return { ok: false, errors, value: null };
  }

  return {
    ok: true,
    errors: {},
    value: {
      name,
      nameKana: toKatakana(nameKana),
      email,
      /* 数字とハイフンだけにそろえる。括弧や空白は落とす。 */
      phone: phone.replace(/[()\s+]/g, ''),
      company,
      department: department === '' ? null : department,
      jobTitle: jobTitle === '' ? null : jobTitle,
      industry,
      industryOtherText: industry === 'other' ? industryOtherText : null,
      occupation,
      occupationOtherText: occupation === 'other' ? occupationOtherText : null,
      position,
      ageGroup,
      isBannedDeclared,
    },
  };
}

/*
 * Gemini へ渡すプロンプトと構造化出力の定義。
 *
 * ==================================================================
 * この検証ページで確かめたいこと
 * ==================================================================
 * 要件定義書 §4.1 のとおり、Drive OCR はレイアウトを保たないため、
 * 出力の**行順が原稿と一致しない**。行頭を手掛かりにすると崩れる。
 *
 * そこで「行の位置ではなく、文脈から項目を判断させる」プロンプトが
 * 成立するかを、フェーズ0で確かめる（§18、§FR-13）。
 *
 * ここは検証用の最小版であり、MVP のプロンプトはこの結果を見てから
 * 決める。バージョンを付けてあるのは、精度を比べるため。
 * ==================================================================
 */

export const PROMPT_VERSION = 'poc-1';

/*
 * 構造化出力のスキーマ（要件定義書 §FR-12）。
 *
 * - confidence は持たせない。値の確からしさを数値で出させると、
 *   その数値の根拠を誰も検証できないまま信用してしまう。
 *   代わりに「自信が無い項目名」だけを uncertainFields で返させる。
 * - 非該当は空文字にする。キー自体を欠かせると、受け取り側が
 *   毎回 undefined を気にすることになる。
 */
export const CARD_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    companyName: { type: 'string' },
    departmentName: { type: 'string' },
    jobTitle: { type: 'string' },
    fullName: { type: 'string' },
    fullNameKana: { type: 'string' },
    postalCode: { type: 'string' },
    address: { type: 'string' },
    phone: { type: 'string' },
    mobile: { type: 'string' },
    fax: { type: 'string' },
    email: { type: 'string' },
    url: { type: 'string' },
    uncertainFields: { type: 'array', items: { type: 'string' } },
  },
  required: [
    'companyName',
    'fullName',
    'email',
    'phone',
    'uncertainFields',
  ],
});

/* 精度を測る主要5項目（要件定義書 §16.2）。 */
export const PRIMARY_FIELDS = Object.freeze([
  'companyName',
  'fullName',
  'jobTitle',
  'email',
  'phone',
]);

/*
 * 指示文。
 *
 * 「書かれていないことを補わない」を最初に置いている。
 * 名刺は第三者の個人情報であり、推測で埋めた値がそのまま
 * 台帳に残ると、あとから誤りだと気づけない（§FR-13）。
 */
export const SYSTEM_INSTRUCTION = [
  'あなたは名刺のテキストを項目へ振り分ける処理系です。',
  '',
  '守ること:',
  '1. 入力に書かれていない情報を補わないこと。推測しないこと。',
  '   該当する情報が無い項目は空文字にすること。',
  '2. 入力は OCR の出力であり、**行の順序は原稿と一致しない**。',
  '   行の位置ではなく、文脈と表記の形から項目を判断すること。',
  '3. 値は入力に現れた表記のまま返すこと。整形・翻訳・敬称の付与をしないこと。',
  '4. 判断に自信が無い項目名を uncertainFields へ入れること。',
  '   自信がある場合は空配列にすること。',
  '5. 会社名と部署名を混ぜないこと。役職は jobTitle へ入れること。',
].join('\n');

/*
 * リクエスト本体を組み立てる。
 *
 * 履歴は持たせない。1名刺1リクエストとする（§FR-11）。
 * 出力上限は既定400トークン。無料枠キーのクォータを無駄に減らさないため。
 */
export function buildGeminiRequest(text, { maxOutputTokens = 400 } = {}) {
  return {
    systemInstruction: {
      parts: [{ text: SYSTEM_INSTRUCTION }],
    },
    contents: [
      {
        role: 'user',
        parts: [{ text: String(text ?? '') }],
      },
    ],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: CARD_SCHEMA,
      maxOutputTokens,
      /* 揺れを抑える。分類であって創作ではない。 */
      temperature: 0,
    },
  };
}

/*
 * 検証用の入力サンプル。
 *
 * 実在しない架空の名刺である。**実在の会社名・氏名・連絡先を
 * ここへ書かないこと**（docs/specs/README.md）。
 *
 * shuffled は同じ内容の行順を入れ替えたもの。行順崩れ耐性
 * （§4.1、§FR-13）を確かめるために対で持つ。
 */
export const SAMPLE_ORDERED = [
  '株式会社サンプル商事',
  '営業推進部 部長',
  '見本 太郎',
  'ミホン タロウ',
  '〒100-0001',
  '東京都千代田区千代田1-1-1',
  'TEL: 03-1234-5678',
  'FAX: 03-1234-5679',
  'MOBILE: 090-1234-5678',
  'taro.mihon@example.com',
  'https://example.com',
].join('\n');

export const SAMPLE_SHUFFLED = [
  'taro.mihon@example.com',
  '見本 太郎',
  'TEL: 03-1234-5678',
  '株式会社サンプル商事',
  '東京都千代田区千代田1-1-1',
  '営業推進部 部長',
  'MOBILE: 090-1234-5678',
  '〒100-0001',
  'https://example.com',
  'ミホン タロウ',
  'FAX: 03-1234-5679',
].join('\n');

/* 両サンプルで期待する主要5項目の値。判定はテスト側で行う。 */
export const SAMPLE_EXPECTED = Object.freeze({
  companyName: '株式会社サンプル商事',
  fullName: '見本 太郎',
  jobTitle: '部長',
  email: 'taro.mihon@example.com',
  phone: '03-1234-5678',
});

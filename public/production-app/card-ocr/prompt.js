/*
 * Gemini へ渡す指示と構造化出力の定義（§FR-11・FR-12・FR-13、§4.1）。
 *
 * ==================================================================
 * 複製元
 * ==================================================================
 * public/production-app/card-ocr/poc/prompt.js（2026-08-04）。
 * **import はしない**（docs/repository-structure.md §4-1）。
 *
 * PoC から変えたところ:
 *   - **両面に対応した**（fromBackFields / conflicts、表面優先の統合）
 *   - **同じ番号を phone と mobile の両方へ入れない**よう明記（課題3）
 *   - **日英併記は日本語を採る**よう明記（課題4）
 *   - 版を card-ocr-2 にした
 * ==================================================================
 */

/*
 * プロンプトの版。**台帳の prompt_version 列に入る**（§11.2）。
 *
 * 変えたら必ず上げること。あとから「この行はどの指示で作られたのか」を
 * たどれなくなる。PoC が poc-1 で、課題3・4 を直したこれが 2 にあたる。
 */
export const PROMPT_VERSION = 'card-ocr-2';

/*
 * 構造化出力の定義。
 *
 * **type は大文字。** responseSchema は proto の列挙型で、小文字だと
 * サーバーに弾かれる（400）。フェーズ0で SYS-999 の原因になった箇所
 * （計画 §7-5-2）。
 *
 * confidence は持たせない（§FR-12）。モデルの自己申告は当てにならず、
 * 「自信がある」と言われたほうが確かめられなくなる。
 * 代わりに uncertainFields に項目名を挙げさせる。
 */
export const CARD_SCHEMA = Object.freeze({
  type: 'OBJECT',
  properties: {
    companyName: { type: 'STRING' },
    departmentName: { type: 'STRING' },
    jobTitle: { type: 'STRING' },
    fullName: { type: 'STRING' },
    fullNameKana: { type: 'STRING' },
    postalCode: { type: 'STRING' },
    address: { type: 'STRING' },
    phone: { type: 'STRING' },
    mobile: { type: 'STRING' },
    fax: { type: 'STRING' },
    email: { type: 'STRING' },
    url: { type: 'STRING' },
    uncertainFields: { type: 'ARRAY', items: { type: 'STRING' } },
    /* v3.1: 裏面から採った項目名。台帳の back_filled_fields に入る。 */
    fromBackFields: { type: 'ARRAY', items: { type: 'STRING' } },
    /* v3.1: 表裏で値が食い違った項目名。確認画面で目立たせる。 */
    conflicts: { type: 'ARRAY', items: { type: 'STRING' } },
  },
  required: [
    'companyName',
    'fullName',
    'email',
    'phone',
    'uncertainFields',
    'fromBackFields',
    'conflicts',
  ],
});

/* 精度を測る主要5項目（§16.2）。 */
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
 * 名刺は第三者の個人情報であり、推測で埋めた値がそのまま台帳に残ると、
 * あとから誤りだと気づけない（§FR-13）。
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
  '',
  /*
   * 課題3（計画 §7-5-3）。予行で同じ番号が両方に入った。
   * 番号の形での判定は extract.js が行うが、指示でも重ねて禁じる。
   */
  '6. 電話番号について:',
  '   - **同じ番号を phone と mobile の両方に入れないこと。**',
  '   - 070 / 080 / 090 で始まる番号は mobile に入れること。',
  '     「TEL」と書かれていても、番号の形を優先すること。',
  '   - FAX と書かれた番号は fax に入れること。',
  '',
  /*
   * 課題4（同上）。日英併記の名刺で日本語側が落ちた。
   * どちらを採るかを決めておかないと、正解の基準そのものが定まらない。
   */
  '7. 日本語と英語が併記されている項目は、**日本語のほうを採ること。**',
  '   例: 「営業部長 / Sales Manager」→ jobTitle は「営業部長」。',
  '   英語しか無い場合は英語をそのまま採ること。',
  '',
  '8. 装飾的な表記と正式名称が両方ある場合、**正式名称を採ること。**',
  '   例: ロゴの英字表記より、法人格を含む社名を優先する。',
  '',
  '両面の名刺について:',
  '9. 入力に「【表面】」「【裏面】」の見出しがある場合、両面ぶんが入っている。',
  '   **表面の値を優先すること。** 裏面は、表面で空になった項目を',
  '   埋めるためだけに使うこと。',
  '10. 裏面から採った項目名を fromBackFields へ入れること。',
  '    表面だけで決まった項目は入れないこと。',
  '11. 表面と裏面で値が食い違った項目名を conflicts へ入れること。',
  '    **同じ内容の別表記（日本語と英語、旧字と新字）は食い違いではない。**',
  '    食い違いが無ければ空配列にすること。',
  '12. 片面が空でも、もう片面に文字があれば処理を続けること。',
].join('\n');

/*
 * リクエスト本体を組み立てる。
 *
 * 履歴は持たせない。1名刺1リクエストとする（§FR-11）。
 * 両面でも**呼び出しは1回**（§20 で確定）。表裏を別々に投げると、
 * 「株式会社サンプル商事」と「Sample Trading Co., Ltd.」が別の値として
 * 競合する。1回で両方を見せれば、同じ会社の別表記だと判断できる。
 *
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

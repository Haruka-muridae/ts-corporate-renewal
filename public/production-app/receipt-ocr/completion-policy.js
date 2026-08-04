/*
 * Gemini 補完の要否判定（v1.3 §11）。
 *
 * ------------------------------------------------------------------
 * 判定する場所が変わっただけで、条件は v1.3 と同じ
 * ------------------------------------------------------------------
 * v1.3 では要否判定がサーバー、実行がブラウザに分かれていた。
 * v2.0 §7 は「判定を実行するのがブラウザ内になる点のみ変更」としている。
 * 条件そのものは触らない。
 * ------------------------------------------------------------------
 *
 * ------------------------------------------------------------------
 * OCR が短いときは、補完せず要確認にする（§11 の重要条件）
 * ------------------------------------------------------------------
 * OCR が情報を失っている場合、テキストだけを受け取る Gemini は
 * 誤補完（推測）しかできない。**補完を要求しないこと。**
 * ここを「短いからこそ AI に頼む」と読み替えないこと。
 * ------------------------------------------------------------------
 */

/* 補完しない理由。画面の出し分けに使う。 */
export const SKIP_REASON = Object.freeze({
  /* 補完の必要が無い（ルールで全部取れた）。 */
  NOT_NEEDED: 'not-needed',
  /* OCR文字数が基準未満。OCR失敗・要確認とする（§11）。 */
  OCR_TOO_SHORT: 'ocr-too-short',
  /* 設定で Gemini を停止している（§11）。 */
  DISABLED: 'disabled',
  /* キーが未設定。第2段階をスキップし要確認のまま残す（v2.0 §4 / §11 末尾）。 */
  NO_API_KEY: 'no-api-key',
});

export const DEFAULT_MIN_OCR_LENGTH = 30;

/*
 * 補完が要るか（§11 の1〜5）。
 *
 * 1. 利用日をルールで確定できない
 * 2. 支払先をルールで確定できない
 * 3. 合計金額をルールで確定できない（候補複数を含む）
 * 4. 金額検証（§13）に不合格
 * 5. 正規表現による抽出結果に矛盾がある
 */
export function needsCompletion(extracted, validation) {
  const reasons = [];

  if (!extracted?.usedOn?.confirmed) {
    reasons.push('利用日をルールで確定できない');
  }

  if (!extracted?.payee?.confirmed) {
    reasons.push('支払先をルールで確定できない');
  }

  if (!extracted?.totalAmount?.confirmed) {
    reasons.push(
      extracted?.totalAmount?.candidates > 1
        ? '合計金額の候補が複数ある'
        : '合計金額をルールで確定できない',
    );
  }

  if (validation && !validation.amount?.ok) {
    reasons.push('金額検証に不合格');
  }

  if (hasContradiction(extracted, validation)) {
    reasons.push('抽出結果に矛盾がある');
  }

  return { needed: reasons.length > 0, reasons };
}

/*
 * §11-5「正規表現による抽出結果に矛盾がある」。
 *
 * 仕様は具体例を挙げていないため、コード側で確かめられる矛盾に限る。
 * 判断に迷うものを足さないこと（誤って補完を呼ぶと利用者のクォータを使う）。
 */
function hasContradiction(extracted, validation) {
  /* 日付が読めているのに検証で落ちた（未来日・古すぎる）。 */
  if (extracted?.usedOn?.value && validation && !validation.date?.ok) {
    return true;
  }

  /* 税額が合計を超えている。 */
  const total = Number(extracted?.totalAmount?.value);
  const taxTotal = Number(extracted?.tax?.taxTotal);

  if (Number.isFinite(total) && Number.isFinite(taxTotal) && taxTotal > total) {
    return true;
  }

  /* 電話番号とレシートNo.に同じ数字を割り当ててしまった。 */
  const phone = String(extracted?.phoneNumber?.value ?? '').replace(/\D/g, '');
  const receipt = String(extracted?.receiptNumber?.value ?? '').replace(/\D/g, '');

  if (phone !== '' && phone === receipt) {
    return true;
  }

  return false;
}

/*
 * 実際に補完を呼ぶかを決める。
 *
 * 呼ばない条件のほうが強い。順序を入れ替えないこと
 * （OCR が短ければ、キーがあっても呼ばない）。
 */
export function decideCompletion({
  extracted,
  validation,
  ocrText = '',
  hasApiKey = false,
  geminiEnabled = true,
  minOcrLength = DEFAULT_MIN_OCR_LENGTH,
} = {}) {
  const need = needsCompletion(extracted, validation);

  if (!need.needed) {
    return { run: false, reason: SKIP_REASON.NOT_NEEDED, needsReview: false, reasons: [] };
  }

  const length = String(ocrText ?? '').trim().length;

  if (length < minOcrLength) {
    /* §11：補完を要求せず「OCR失敗・要確認」とする。 */
    return { run: false, reason: SKIP_REASON.OCR_TOO_SHORT, needsReview: true, reasons: need.reasons };
  }

  if (!geminiEnabled) {
    return { run: false, reason: SKIP_REASON.DISABLED, needsReview: true, reasons: need.reasons };
  }

  if (!hasApiKey) {
    /* v2.0 §4：キー未設定なら補完をスキップし、要確認のまま残す。 */
    return { run: false, reason: SKIP_REASON.NO_API_KEY, needsReview: true, reasons: need.reasons };
  }

  return { run: true, reason: null, needsReview: false, reasons: need.reasons };
}

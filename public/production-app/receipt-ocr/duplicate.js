/*
 * 重複判定（仕様書 §10）。
 *
 * ------------------------------------------------------------------
 * 判断だけを持つ
 * ------------------------------------------------------------------
 * シートから値を取ってくるのは sheets.js。ここは「取れた列」を受け取って
 * 判断するだけの純関数にしてある。テストで全分岐を実通信なしに見られる。
 * ------------------------------------------------------------------
 *
 * ------------------------------------------------------------------
 * 全件・全列を取らない（§10）
 * ------------------------------------------------------------------
 * §10 は「ハッシュ列のみを取得し、ブラウザ内で照合する（全列の全件取得を
 * 行わない）」と定めている。完全一致はハッシュだけで済む。
 *
 * 類似（同日・同店舗・同金額）の判定には、日付・支払先・金額と、
 * 除外条件に使うレシートNo.、表示に使う管理IDが要る。
 * そこで取るのはこの6列だけとし、OCR原文や但し書きは取らない。
 * 「全列の全件取得を行わない」という趣旨はこれで満たしている。
 * ------------------------------------------------------------------
 */

/* 判定に必要な列。sheets.js はこの並びで値を取る。 */
export const DUPLICATE_COLUMN_KEYS = Object.freeze([
  'recordId',
  'imageHash',
  'usedOn',
  'payee',
  'totalAmount',
  'receiptNumber',
]);

export const DUPLICATE_KIND = Object.freeze({
  NONE: 'none',
  /* 同一画像。保存しない（§12 DUP-001）。 */
  EXACT: 'exact',
  /* 同日・同店舗・同金額。警告のみ。保存は利用者の判断（§10）。 */
  SIMILAR: 'similar',
});

function text(value) {
  return String(value ?? '').trim();
}

function lower(value) {
  return text(value).toLowerCase();
}

/*
 * 金額を比べるための正規化。
 *
 * ここでやるのは「シートに入っている値どうしを比べられる形にする」ことだけで、
 * OCR結果の金額正規化（v1.3 §10.1）とは別物である。
 * 桁区切りと通貨記号だけを落とし、読み替えは行わない。
 */
function amountValue(value) {
  const raw = text(value).replace(/[,\s¥￥円]/g, '');

  if (raw === '' || !/^-?\d+(\.\d+)?$/.test(raw)) {
    return null;
  }

  return Number(raw);
}

/*
 * 支払先の突き合わせ。
 *
 * 表記ゆれの吸収は店舗マスタの仕事なので、ここでは踏み込まない。
 * 前後の空白と全角空白だけ落として比べる。
 */
function payeeKey(value) {
  return text(value).replace(/[\s　]/g, '');
}

/*
 * 既存行を { recordId, imageHash, ... } の形へ組み直す。
 * sheets.js が返す「列ごとの配列」を、行ごとの object にする。
 */
export function toRows(columns) {
  const lists = DUPLICATE_COLUMN_KEYS.map((key) => (Array.isArray(columns?.[key]) ? columns[key] : []));
  const length = lists.reduce((max, list) => Math.max(max, list.length), 0);
  const rows = [];

  for (let i = 0; i < length; i += 1) {
    const row = { rowNumber: i + 2 };

    DUPLICATE_COLUMN_KEYS.forEach((key, index) => {
      row[key] = lists[index][i] ?? '';
    });

    rows.push(row);
  }

  return rows;
}

/*
 * 判定する。
 *
 * candidate … いま保存しようとしている値
 * rows      … 既存行（toRows の戻り値）
 *
 * 戻り値:
 *   { kind: 'none' }
 *   { kind: 'exact',   match }            … 保存しない
 *   { kind: 'similar', matches: [...] }   … 警告のみ
 *
 * 完全一致を先に見る。同じ画像なら、日付や金額を比べるまでもない。
 */
export function evaluateDuplicate(candidate, rows) {
  const list = Array.isArray(rows) ? rows : [];
  const hash = lower(candidate?.imageHash);

  if (hash !== '') {
    const exact = list.find((row) => lower(row.imageHash) === hash);

    if (exact) {
      return { kind: DUPLICATE_KIND.EXACT, match: exact, matches: [exact] };
    }
  }

  const usedOn = text(candidate?.usedOn);
  const payee = payeeKey(candidate?.payee);
  const amount = amountValue(candidate?.totalAmount);

  /* 3つとも揃っていなければ、類似は判断できない。黙って通す。 */
  if (usedOn === '' || payee === '' || amount === null) {
    return { kind: DUPLICATE_KIND.NONE, matches: [] };
  }

  const candidateReceiptNo = text(candidate?.receiptNumber);

  const matches = list.filter((row) => {
    if (text(row.usedOn) !== usedOn) return false;
    if (payeeKey(row.payee) !== payee) return false;
    if (amountValue(row.totalAmount) !== amount) return false;

    /*
     * §10：両者のレシートNo.が取得でき、番号が異なる場合は警告しない。
     * 別のレシートだと分かっているものを毎回警告すると、警告が読まれなくなる。
     * 片方でも欠けていれば「分からない」ので、警告は出す。
     */
    const rowReceiptNo = text(row.receiptNumber);

    if (candidateReceiptNo !== '' && rowReceiptNo !== '' && candidateReceiptNo !== rowReceiptNo) {
      return false;
    }

    return true;
  });

  return matches.length > 0
    ? { kind: DUPLICATE_KIND.SIMILAR, matches }
    : { kind: DUPLICATE_KIND.NONE, matches: [] };
}

/* 画面へ出す文言のもと。実値はここで組み立て、textContent で入れる。 */
export function describeDuplicate(result) {
  if (result?.kind === DUPLICATE_KIND.EXACT) {
    const match = result.match ?? {};

    return {
      code: 'DUP-001',
      canSave: false,
      text: `この画像はすでに登録されています（管理ID: ${text(match.recordId) || '不明'} / ${match.rowNumber ?? '?'}行目）。`,
    };
  }

  if (result?.kind === DUPLICATE_KIND.SIMILAR) {
    const ids = result.matches.map((row) => text(row.recordId) || `${row.rowNumber}行目`).join('、');

    return {
      code: null,
      /* 警告のみ。保存は利用者の判断に委ねる（§10）。 */
      canSave: true,
      text: `同じ日・同じ支払先・同じ金額の記録があります（${ids}）。別の領収書であれば、そのまま保存してください。`,
    };
  }

  return { code: null, canSave: true, text: '' };
}

/*
 * ルールによる項目抽出（v1.3 §10.2〜§10.10）。
 *
 * ==================================================================
 * 前提となる制約（v1.3 §10 前文）
 * ==================================================================
 * プレーンテキスト化された OCR 結果では行順序・左右の対応が崩れる。
 * 「近くの金額」という判定には限界がある。
 *
 * したがって、ここが返すのは**候補**であり、確定ではない。
 * 確定してよいかは §13 の検証が決める。
 * 「候補が複数残った場合はルールで確定しない」を各所で守ること。
 * ==================================================================
 *
 * 各項目は次の形で返す。
 *   { value, confirmed, candidates, labelAdjacent, evidence }
 *
 *   confirmed     … ルールだけで確定してよいか（false なら補完か要確認）
 *   candidates    … 候補の数。§14 の「候補が1件のみ」加点に使う
 *   labelAdjacent … ラベル近接で取れたか。§14 の加点に使う
 *   evidence      … 根拠にした行。確認画面で示す
 */

import { findAmounts, normalizeAmount, toHalfWidth } from './amount.js';
import { REGISTRATION_STATUS, TAX_NOTATION } from './status.js';

/* ラベルと値が離れていても、この行数までは同じものとみなす。 */
const LABEL_WINDOW = 1;

const empty = () => ({
  value: null,
  confirmed: false,
  candidates: 0,
  labelAdjacent: false,
  evidence: '',
});

export function toLines(ocrText) {
  return String(ocrText ?? '')
    .split(/\r?\n/)
    .map((line) => toHalfWidth(line).trim())
    .filter((line) => line !== '');
}

/* ラベルを含む行と、その直後の行を返す。 */
function linesNearLabel(lines, labelPattern) {
  const hits = [];

  lines.forEach((line, index) => {
    if (!labelPattern.test(line)) {
      return;
    }

    for (let i = index; i <= index + LABEL_WINDOW && i < lines.length; i += 1) {
      hits.push({ line: lines[i], labelLine: line, sameLine: i === index });
    }
  });

  return hits;
}

/* ---------- §10.2 利用日 ---------- */

const DATE_LABEL = /(取引日|利用日|ご利用日|発行日|領収日|お買上日|購入日)/;

/*
 * 取引日ではない日付が載る行（§10.2）。
 *
 * ポイント失効日・クーポン有効期限・キャンペーン期間・カード有効期限。
 * ラベル行の**次の行**を見るとき、これらを拾ってしまうと
 * §10.2 が防ごうとしている誤取得そのものになる。
 */
const DATE_EXCLUDE = /(有効期限|失効|期限|キャンペーン|クーポン|ポイント|次回|来店)/;

/*
 * 和暦・西暦・2桁年を YYYY-MM-DD へ。
 * 解釈できなければ null（推測で補わない）。
 */
export function parseDate(text) {
  const value = toHalfWidth(text);

  /* 令和8年8月2日 / R8.8.2 */
  const reiwa = value.match(/(?:令和|R)\s?(\d{1,2})[年.\-/]\s?(\d{1,2})[月.\-/]\s?(\d{1,2})/);

  if (reiwa) {
    return build(2018 + Number(reiwa[1]), reiwa[2], reiwa[3]);
  }

  /* 平成31年まで（古い領収書の混入に備える）。 */
  const heisei = value.match(/(?:平成|H)\s?(\d{1,2})[年.\-/]\s?(\d{1,2})[月.\-/]\s?(\d{1,2})/);

  if (heisei) {
    return build(1988 + Number(heisei[1]), heisei[2], heisei[3]);
  }

  /* 2026年8月2日 / 2026/08/02 / 2026-08-02 / 2026.08.02 */
  const western = value.match(/(\d{4})[年.\-/]\s?(\d{1,2})[月.\-/]\s?(\d{1,2})/);

  if (western) {
    return build(western[1], western[2], western[3]);
  }

  /* 26/08/02（2桁年）。00-69 は 2000 年代、70-99 は 1900 年代とみなす。 */
  const short = value.match(/(?<!\d)(\d{2})[.\-/](\d{1,2})[.\-/](\d{1,2})(?!\d)/);

  if (short) {
    const yy = Number(short[1]);
    return build(yy <= 69 ? 2000 + yy : 1900 + yy, short[2], short[3]);
  }

  return null;

  function build(year, month, day) {
    const y = Number(year);
    const m = Number(month);
    const d = Number(day);

    if (!Number.isInteger(y) || m < 1 || m > 12 || d < 1 || d > 31) {
      return null;
    }

    /* 2月30日のような、形は合うが存在しない日付を落とす。 */
    const probe = new Date(Date.UTC(y, m - 1, d));

    if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) {
      return null;
    }

    return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
}

/*
 * §10.2。
 *
 * **ラベル近接で特定できない場合、ルールでの確定を行わない。**
 * レシートにはポイント失効日・クーポン期限・カード有効期限など
 * 取引日以外の日付が多数印字される。消去法で選ぶと誤取得が起きる。
 */
export function extractUsedOn(lines) {
  const result = empty();
  const found = new Map();

  for (const hit of linesNearLabel(lines, DATE_LABEL)) {
    /*
     * ラベル行そのものに日付があるなら、それが答え。
     * 次の行まで見るのは、ラベルと値が改行で割れた場合の救済であって、
     * 別の日付を拾いにいくためではない。
     */
    if (!hit.sameLine && (DATE_EXCLUDE.test(hit.line) || parseDate(hit.labelLine) !== null)) {
      continue;
    }

    const date = parseDate(hit.line);

    if (date !== null && !found.has(date)) {
      found.set(date, hit.line);
    }
  }

  result.candidates = found.size;
  result.labelAdjacent = found.size > 0;

  if (found.size === 1) {
    const [date, evidence] = [...found.entries()][0];
    result.value = date;
    result.evidence = evidence;
    result.confirmed = true;
  }

  return result;
}

/* ---------- §10.4 合計金額 ---------- */

const TOTAL_LABEL = /(合計|総合計|税込合計|ご請求額|請求金額|お支払[額金]|支払金額|領収金額|お買上金額|お買上計|現計)/;
const SUBTOTAL_LABEL = /小計/;

/*
 * 合計として採用しない行（§10.4）。
 *
 * お預り・お釣りは「合計より大きい金額が混在する典型原因」と
 * 名指しされている。**優先順位を下げるのではなく、候補にしない。**
 * 消費税合計は「合計」の字を含むが税額であり、合計金額ではない。
 * クレジット支払額は現金併用時に合計と一致しないため根拠にしない。
 */
const TOTAL_EXCLUDE = /(お預[りかっ]|預り金|お釣|おつり|釣銭|釣り銭|消費税|内税|外税|対象|ポイント|残高|クレジット|カード支払|決済額)/;

export function extractTotalAmount(lines) {
  const result = empty();
  const primary = new Set();
  const fallback = new Set();
  const evidence = new Map();

  for (const hit of linesNearLabel(lines, TOTAL_LABEL)) {
    if (TOTAL_EXCLUDE.test(hit.line) || TOTAL_EXCLUDE.test(hit.labelLine)) {
      continue;
    }

    for (const amount of findAmounts(hit.line)) {
      primary.add(amount);

      if (!evidence.has(amount)) {
        evidence.set(amount, hit.line);
      }
    }
  }

  /* 小計は最終合計より優先しない。合計が取れなかったときだけ見る。 */
  if (primary.size === 0) {
    for (const hit of linesNearLabel(lines, SUBTOTAL_LABEL)) {
      if (TOTAL_EXCLUDE.test(hit.line)) {
        continue;
      }

      for (const amount of findAmounts(hit.line)) {
        fallback.add(amount);

        if (!evidence.has(amount)) {
          evidence.set(amount, hit.line);
        }
      }
    }
  }

  const pool = primary.size > 0 ? primary : fallback;

  result.candidates = pool.size;
  result.labelAdjacent = primary.size > 0;

  /* 候補が複数残った場合はルールで確定しない（§10.4 末尾）。 */
  if (pool.size === 1) {
    const [amount] = [...pool];
    result.value = amount;
    result.evidence = evidence.get(amount) ?? '';
    result.confirmed = primary.size === 1;
  }

  return result;
}

/* ---------- §10.7 電話番号 ---------- */

const PHONE_LABEL = /(TEL|Tel|tel|電話|℡|☎|FAX番号なし)/;

/*
 * §10.7。
 *
 * ラベル、または市外局番形式（区切り記号あり）の確認を必須とする。
 * **数字列単独では採用しない。** レシートNo.・会員番号・登録番号との
 * 混同を防ぐためで、これを緩めると 10.5 と取り違える。
 */
export function extractPhoneNumber(lines) {
  const result = empty();
  const found = new Map();

  /*
   * 区切りのある形。ラベルが無くても電話番号だと分かる。
   * 「03-1234-5678」「(03)1234-5678」「03(1234)5678」を通す。
   *
   * 区切り記号を1つ以上含むことを条件にする。裸の数字列を
   * ここで通すと、レシートNo.や会員番号を電話番号にしてしまう。
   */
  const separated = /(?<!\d)(0\d{0,3}[-()][\d\-()]{6,12}\d)(?!\d)/g;

  for (const line of lines) {
    for (const match of line.matchAll(separated)) {
      const digits = match[1].replace(/\D/g, '');

      if (digits.length >= 10 && digits.length <= 11 && !found.has(digits)) {
        found.set(digits, line);
      }
    }
  }

  if (found.size === 0) {
    /* 区切りが無い場合は、ラベル近接を必須にする。 */
    for (const hit of linesNearLabel(lines, PHONE_LABEL)) {
      const match = hit.line.match(/(?<!\d)(0\d{9,10})(?!\d)/);

      if (match && !found.has(match[1])) {
        found.set(match[1], hit.line);
      }
    }
  }

  result.candidates = found.size;

  if (found.size >= 1) {
    const [digits, evidence] = [...found.entries()][0];
    result.value = digits;
    result.evidence = evidence;
    result.labelAdjacent = true;
    result.confirmed = true;
  }

  return result;
}

/* ---------- §10.5 レシートNo. ---------- */

const RECEIPT_NO_LABEL = /(伝票番号|伝票No|レシートNo|レシート番号|取引No|取引番号|No\.)/i;

/*
 * §10.5。
 *
 * **ラベル近接を必須とし、番号単独では採用しない。**
 * 電話番号・会員番号・適格請求書登録番号との混同を防ぐ。
 */
export function extractReceiptNumber(lines, phoneDigits = null) {
  const result = empty();
  const found = new Map();

  for (const hit of linesNearLabel(lines, RECEIPT_NO_LABEL)) {
    /* 電話番号のラベルが同居する行は、電話番号として扱う（10.7 が優先）。 */
    if (PHONE_LABEL.test(hit.line)) {
      continue;
    }

    const match = hit.line.match(/(?:No\.?|番号|NO\.?)\s*[:：]?\s*([0-9A-Za-z-]{2,20})/i);
    const value = match?.[1] ?? hit.line.match(/(?<![\d-])(\d{2,20})(?![\d-])/)?.[1] ?? null;

    if (value === null) {
      continue;
    }

    /* 電話番号として採った数字と同じものは、レシートNo.にしない。 */
    if (phoneDigits && value.replace(/\D/g, '') === phoneDigits) {
      continue;
    }

    if (!found.has(value)) {
      found.set(value, hit.line);
    }
  }

  result.candidates = found.size;

  if (found.size >= 1) {
    const [value, evidence] = [...found.entries()][0];
    result.value = value;
    result.evidence = evidence;
    result.labelAdjacent = true;
    result.confirmed = true;
  }

  return result;
}

/* ---------- §10.6 適格請求書登録番号 ---------- */

const REGISTRATION_LABEL = /(登録番号|適格請求書|インボイス|事業者番号)/;

/*
 * 登録番号のラベルの近くに、書き込まれた数字があるか。
 *
 * 見るのは次の2つだけにする。
 *   ・ラベルと同じ行の、ラベルより後ろ
 *   ・次の行が「数字とTと区切りだけ」でできている場合（欄が改行で割れた形）
 *
 * 次の行を無条件に見ると、下に印字された電話番号や日付を
 * 「登録番号が書いてある」と読んでしまう。
 */
function hasNumberNearRegistrationLabel(lines) {
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const label = line.match(REGISTRATION_LABEL);

    if (!label) {
      continue;
    }

    /* ラベルより後ろに数字が並んでいるか。 */
    const tail = line.slice(label.index + label[0].length).replace(/[\s-]/g, '');

    if (/\d{8,}/.test(tail)) {
      return true;
    }

    /*
     * 欄が改行で割れた形。次の行が数字だけでできているときに限る。
     *
     * 桁数は12以上を求める。登録番号は13桁で、10〜11桁だと
     * すぐ下に印字された電話番号を拾ってしまう。
     */
    const next = lines[i + 1];

    if (next && /^[T\d\s-]+$/.test(next) && next.replace(/\D/g, '').length >= 12) {
      return true;
    }
  }

  return false;
}

/*
 * §10.6。
 *
 * **「T」が明示的に認識できた場合のみ採用する。**
 * 数字13桁のみの検出に T を補って採用することは禁止されている
 * （電話番号・伝票番号との混同防止）。
 *
 * 状態は3値。「記載なし（免税の可能性）」と「読取失敗」は
 * 仕入税額控除の処理が違うため、必ず区別する。
 */
export function extractRegistrationNumber(lines) {
  const result = empty();
  const text = lines.join('\n');

  const match = text.match(/(?<![A-Za-z])T\s?-?\s?(\d{13})(?!\d)/);

  if (match) {
    result.value = `T${match[1]}`;
    result.evidence = lines.find((line) => line.includes(match[0])) ?? match[0];
    result.confirmed = true;
    result.candidates = 1;
    result.labelAdjacent = REGISTRATION_LABEL.test(result.evidence);
    result.status = REGISTRATION_STATUS.FOUND;

    return result;
  }

  /*
   * T が取れなかった。値は補正しない。
   *
   * ------------------------------------------------------------------
   * ラベルがあるだけでは「読取失敗」にしない
   * ------------------------------------------------------------------
   * 市販の領収証用紙には登録番号欄が**あらかじめ印刷されている**。
   * 免税事業者はそこを空欄のまま渡すため、「欄はあるが何も書いていない」
   * 領収証が普通に出てくる。これは「記載なし（免税の可能性）」であって
   * 「読取失敗」ではない。§10.6 が両者を区別せよと言うのは、
   * 仕入税額控除の処理が違うからで、ここを取り違えると
   * 控除できない取引を控除できるものとして扱ってしまう。
   *
   * 「書いてあるが読めなかった」とみなすのは、ラベルの近くに
   * 実際にそれらしい数字列があるときだけにする。
   * ------------------------------------------------------------------
   */
  result.status = hasNumberNearRegistrationLabel(lines)
    ? REGISTRATION_STATUS.UNREADABLE
    : REGISTRATION_STATUS.ABSENT;

  return result;
}

/*
 * 法人番号形式のチェックデジット（§10.6）。
 *
 * **信頼度の加点にだけ使う。** 個人事業主の登録番号には適用できないため、
 * 不一致を即エラーにしない。
 */
export function checkDigitValid(registrationNumber) {
  const digits = String(registrationNumber ?? '').replace(/^T/, '');

  if (!/^\d{13}$/.test(digits)) {
    return false;
  }

  const check = Number(digits[0]);
  const body = digits.slice(1);
  let odd = 0;
  let even = 0;

  for (let i = 0; i < body.length; i += 1) {
    /* 右端から数えて奇数桁・偶数桁。 */
    const digit = Number(body[body.length - 1 - i]);

    if (i % 2 === 0) {
      odd += digit;
    } else {
      even += digit;
    }
  }

  return check === 9 - ((odd * 2 + even) % 9);
}

/* ---------- §10.9 消費税内訳 ---------- */

/*
 * §10.9。
 *
 * **印字された値をそのまま記録し、表記区分（税込／税抜／不明）を併記する。**
 * 対象額には税込表記・税抜表記の両方が存在するため、こちらで
 * 揃えようとすると元の値が失われる。
 */
export function extractTaxBreakdown(lines) {
  const out = {
    tax8Base: null,
    tax8Amount: null,
    tax10Base: null,
    tax10Amount: null,
    taxTotal: null,
    notation: TAX_NOTATION.UNKNOWN,
    evidence: [],
  };

  for (const rate of [8, 10]) {
    const marker = new RegExp(`(?<!\\d)${rate}\\s?[%％]`);

    for (const line of lines) {
      if (!marker.test(line)) {
        continue;
      }

      const amounts = findAmounts(line).filter((amount) => amount !== rate);

      if (amounts.length === 0) {
        continue;
      }

      const isTaxLine = /(消費税|税額|内税|税[:：])/.test(line);
      const isBaseLine = /対象/.test(line);

      if (isBaseLine && out[`tax${rate}Base`] === null) {
        out[`tax${rate}Base`] = amounts[0];
        out.evidence.push(line);
      }

      if (isTaxLine) {
        const taxValue = isBaseLine && amounts.length > 1 ? amounts[amounts.length - 1] : amounts[0];

        if (out[`tax${rate}Amount`] === null) {
          out[`tax${rate}Amount`] = taxValue;
          out.evidence.push(line);
        }
      }
    }
  }

  /* 消費税合計。税率の指定が無い「消費税」行から拾う。 */
  for (const line of lines) {
    if (!/消費税/.test(line) || /\d\s?[%％]/.test(line)) {
      continue;
    }

    const amounts = findAmounts(line);

    if (amounts.length > 0) {
      out.taxTotal = amounts[0];
      out.evidence.push(line);
      break;
    }
  }

  const text = lines.join('\n');
  const inclusive = /(税込|内税)/.test(text);
  const exclusive = /(税抜|外税)/.test(text);

  if (inclusive && !exclusive) {
    out.notation = TAX_NOTATION.INCLUSIVE;
  } else if (exclusive && !inclusive) {
    out.notation = TAX_NOTATION.EXCLUSIVE;
  }

  return out;
}

/* ---------- §10.10 支払方法 ---------- */

const PAYMENT_METHODS = Object.freeze([
  { label: '現金', pattern: /(現金|キャッシュ|お預[りかっ])/ },
  { label: 'クレジットカード', pattern: /(クレジット|VISA|Visa|MasterCard|Mastercard|JCB|AMEX|AmericanExpress|カード払|ご利用カード)/ },
  { label: 'コード決済', pattern: /(PayPay|ペイペイ|楽天ペイ|d払い|au ?PAY|メルペイ|LINE ?Pay)/i },
  { label: '交通系IC', pattern: /(Suica|PASMO|ICOCA|PiTaPa|manaca|TOICA|SUGOCA|nimoca|Kitaca|交通系)/i },
  { label: '電子マネー', pattern: /(電子マネー|楽天Edy|Edy|iD|QUICPay|nanaco|WAON)/i },
  { label: '振込', pattern: /(振込|振替|お振込)/ },
]);

/*
 * §10.10。
 *
 * 「クレジット支払」等の金額行は支払方法の判定に使うが、
 * 合計金額の根拠には使わない（§10.4。現金併用時のズレ防止）。
 * 合計側での除外は extractTotalAmount の TOTAL_EXCLUDE が担っている。
 */
export function extractPaymentMethod(lines) {
  const result = empty();
  const text = lines.join('\n');

  for (const method of PAYMENT_METHODS) {
    if (method.pattern.test(text)) {
      result.value = method.label;
      result.evidence = lines.find((line) => method.pattern.test(line)) ?? '';
      result.confirmed = true;
      result.candidates = 1;
      return result;
    }
  }

  return result;
}

/* ---------- §10.3 支払先・店舗名 ---------- */

const COMPANY_MARK = /(株式会社|\(株\)|合同会社|有限会社|合資会社|一般社団法人|店$|支店|営業所)/;
const ADDRESS_MARK = /(都|道|府|県|市|区|町|村|丁目|番地|[0-9]-[0-9])/;

/*
 * 用紙の題字（§10.3 が「店舗名として採用しない」とする類）。
 *
 * ------------------------------------------------------------------
 * 誤読に耐える形にする
 * ------------------------------------------------------------------
 * 手書き領収証の題字は大きく崩した字で書かれ、OCR が
 * 「領取 証」「領 収 証」のように読むことがある。実機で
 * 「領取 証」を店名として採用してしまった。
 *
 * そこで、空白を落としてから、収と取・証と書の揺れを許して照合する。
 * 完全一致・行頭一致にすると、この手の誤読を素通りさせる。
 * ------------------------------------------------------------------
 */
const TITLE_MARK = /(領[収取叉]?[証書]|レシート|受領証|受取証|お買上|お買い上げ|明細書|計算書|請求書|納品書)/;

function isTitleLine(line) {
  return TITLE_MARK.test(line.replace(/[\s　]/g, ''));
}

/*
 * その行が日付そのものか（§10.2 が扱う書式に一致するか）。
 *
 * 実機で「2026年8月1日」を店名として採用してしまった。
 * 日付は領収証のどこにでも印字され、店名より上に来ることもある。
 */
function isDateLine(line) {
  return parseDate(line) !== null;
}

/*
 * その行が宛名（領収証を受け取る側）か。
 *
 * ==================================================================
 * ここだけは法人格による例外を認めない
 * ==================================================================
 * 題字や日付は「法人格が読めていれば店名として採ってよい」としたが、
 * 宛名は逆である。**宛名はたいてい法人名で書かれる**
 * （「株式会社◯◯ 御中」）。ここで法人格を優先すると、
 * 支払先の欄に取引相手ではなく自社名が入る。
 *
 * 領収証では宛名が発行者より上に印字されることが多く、
 * 先頭付近を探す §10.3-2 と正面からぶつかる。
 * ==================================================================
 *
 * 「様」は行末にあるときだけ見る。店名の途中に出る「様」
 * （「王様」等）を宛名と取り違えないため。
 */
const ADDRESSEE_MARK = /(御中|各位|上様|様[\s　]*$)/;

function isAddresseeLine(line) {
  return ADDRESSEE_MARK.test(line.trim());
}

/*
 * §10.3。優先順位は
 *   1. 店舗マスタに登録された名称
 *   2. OCR文中の先頭付近にある法人名・店舗名
 *   3. 「株式会社」「合同会社」「店」「支店」等を含む文字列
 *   4. Gemini による補完（ここでは行わない）
 *
 * 電話番号・住所・担当者名のみの行は店舗名として採用しない。
 */
export function extractPayee(lines, { storeMaster = [], phoneDigits = null } = {}) {
  const result = empty();

  /* 1. 店舗マスタ。電話番号一致を最優先の照合キーとする（§10.7）。 */
  if (phoneDigits) {
    const byPhone = storeMaster.find(
      (store) => String(store.phoneNumber ?? '').replace(/\D/g, '') === phoneDigits,
    );

    if (byPhone) {
      result.value = byPhone.officialName;
      result.evidence = `店舗マスタ（電話番号一致）`;
      result.confirmed = true;
      result.candidates = 1;
      result.masterMatch = 'phone';
      return result;
    }
  }

  const text = lines.join('\n');
  const byKeyword = storeMaster.find(
    (store) => store.keyword && text.includes(String(store.keyword)),
  );

  if (byKeyword) {
    result.value = byKeyword.officialName;
    result.evidence = lines.find((line) => line.includes(byKeyword.keyword)) ?? '';
    result.confirmed = true;
    result.candidates = 1;
    result.masterMatch = 'keyword';
    return result;
  }

  /* 2〜3. 先頭付近の法人名・店舗名。 */
  const head = lines.slice(0, 8);

  /*
   * 店名として採ってよい行か。
   *
   * 除外は「法人格が無い場合に限る」形にしてある。
   * 「株式会社◯◯ 2026年8月1日」のように、正しい店名の行に
   * 日付が同居することがあるため、法人格が読めているほうを優先する。
   */
  const looksLikePayee = (line) => {
    const hasCompanyMark = COMPANY_MARK.test(line);

    /* 宛名。法人格があっても除外する（上の注記を読むこと）。 */
    if (isAddresseeLine(line)) {
      return false;
    }

    /* 用紙の題字（領収証・レシート等）。 */
    if (isTitleLine(line) && !hasCompanyMark) {
      return false;
    }

    /* 日付だけの行。 */
    if (isDateLine(line) && !hasCompanyMark) {
      return false;
    }

    /* 電話番号の行。 */
    if (PHONE_LABEL.test(line) || /(?<!\d)0\d{1,4}[-(]\d{1,4}/.test(line)) {
      return false;
    }

    /* 住所の行。 */
    if (ADDRESS_MARK.test(line) && !hasCompanyMark) {
      return false;
    }

    return line.length >= 2 && line.length <= 60;
  };

  const withCompany = head.find((line) => COMPANY_MARK.test(line) && looksLikePayee(line));

  if (withCompany) {
    result.value = withCompany;
    result.evidence = withCompany;
    result.confirmed = true;
    result.candidates = 1;
    return result;
  }

  const first = head.find(looksLikePayee);

  if (first) {
    /*
     * 手がかりが「先頭付近にある」ことしかない。
     * 候補としては出すが、ルールでは確定しない（補完か確認へ回す）。
     */
    result.value = first;
    result.evidence = first;
    result.candidates = 1;
    result.confirmed = false;
  }

  return result;
}

/* ---------- §10.8 勘定科目（候補のみ） ---------- */

/*
 * §10.8。
 *
 * **勘定科目は確定しない。常に「候補」として提示する。**
 * 同じ支払先でも利用目的で科目は変わるため、支払先からの自動確定は
 * 原理的に不可能である。確定フラグの初期値は必ず「未確定」。
 */
export function extractAccountCandidate({ payee = null, storeMaster = [] } = {}) {
  const match = storeMaster.find(
    (store) => store.officialName === payee || (store.keyword && payee?.includes(store.keyword)),
  );

  if (match?.accountCandidate) {
    return {
      value: match.accountCandidate,
      source: '店舗マスタ',
      summaryDefault: match.summaryDefault ?? '',
    };
  }

  return { value: null, source: null, summaryDefault: '' };
}

/* ---------- まとめ ---------- */

/*
 * すべてのルール抽出を実行する。
 * 抽出の順序に意味がある箇所（電話番号→レシートNo.／支払先）は
 * ここで順番を保証する。
 */
export function extractAll(ocrText, { storeMaster = [] } = {}) {
  const lines = toLines(ocrText);

  const phoneNumber = extractPhoneNumber(lines);
  const phoneDigits = phoneNumber.value;

  const receiptNumber = extractReceiptNumber(lines, phoneDigits);
  const payee = extractPayee(lines, { storeMaster, phoneDigits });
  const usedOn = extractUsedOn(lines);
  const totalAmount = extractTotalAmount(lines);
  const registration = extractRegistrationNumber(lines);
  const tax = extractTaxBreakdown(lines);
  const paymentMethod = extractPaymentMethod(lines);
  const account = extractAccountCandidate({ payee: payee.value, storeMaster });

  return {
    lines,
    usedOn,
    payee,
    totalAmount,
    phoneNumber,
    receiptNumber,
    registration,
    tax,
    paymentMethod,
    account,
  };
}

/* 抽出結果を、確認画面とシートが使う「値だけ」の形へ落とす。 */
export function toValues(extracted) {
  return {
    usedOn: extracted.usedOn.value ?? '',
    payee: extracted.payee.value ?? '',
    totalAmount: extracted.totalAmount.value ?? '',
    phoneNumber: extracted.phoneNumber.value ?? '',
    receiptNumber: extracted.receiptNumber.value ?? '',
    registrationNumber: extracted.registration.value ?? '',
    registrationStatus: extracted.registration.status ?? REGISTRATION_STATUS.ABSENT,
    taxTotal: extracted.tax.taxTotal ?? '',
    tax8Base: extracted.tax.tax8Base ?? '',
    tax8Amount: extracted.tax.tax8Amount ?? '',
    tax10Base: extracted.tax.tax10Base ?? '',
    tax10Amount: extracted.tax.tax10Amount ?? '',
    taxNotation: extracted.tax.notation,
    paymentMethod: extracted.paymentMethod.value ?? '',
    accountCandidate: extracted.account.value ?? '',
    accountSource: extracted.account.source ?? '',
    summary: extracted.account.summaryDefault ?? '',
  };
}

export { normalizeAmount };

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
 *
 * ------------------------------------------------------------------
 * 対応するのは同一行形式だけ（v2.0 §7.1）
 * ------------------------------------------------------------------
 * 「10%対象 ¥1,100」のように、税率と金額が同じ行にある形だけを拾う。
 * 「税率 10%」と金額が別の行に分かれる形は拾わず、空欄になる。
 * §10.9 は「取得できた場合のみ記録」としており、誤った値は入らない。
 *
 * 行またぎへ対応するかは、フェーズ0で出現率を数えてから決める
 * （§16 フェーズ0-4）。行をまたぐ状態管理はこの関数全体に触る変更で、
 * いま入れるとフェーズ0の測定中に案Aの実力が動いてしまう。
 * ------------------------------------------------------------------
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
  /*
   * 「お預り」「おつり」を現金の根拠にしないこと。
   *
   * POS はカード払いでも「お預り ¥2,761 / おつり ¥0」を印字する
   * （実機のレシートで確認）。これはレジの表示様式であって、
   * 支払方法の記載ではない。根拠にすると、カード払いが必ず現金になる。
   *
   * 現金は「現金」と書かれているときだけ現金とする。
   * 取れなくても §10.10 は「取得できた場合のみ記録」としており、
   * 誤って現金と決めるより、空のほうがよい。
   */
  { label: '現金', pattern: /(現金|キャッシュ)/ },
  { label: 'クレジットカード', pattern: /(クレジット|VISA|Visa|MasterCard|Mastercard|JCB|AMEX|AmericanExpress|カード払|ご利用カード)/ },
  { label: 'コード決済', pattern: /(PayPay|ペイペイ|楽天ペイ|d払い|au ?PAY|メルペイ|LINE ?Pay)/i },
  { label: '交通系IC', pattern: /(Suica|PASMO|ICOCA|PiTaPa|manaca|TOICA|SUGOCA|nimoca|Kitaca|交通系)/i },
  { label: '電子マネー', pattern: /(電子マネー|楽天Edy|Edy|iD|QUICPay|nanaco|WAON)/i },
  { label: '振込', pattern: /(振込|振替|お振込)/ },
]);

/*
 * 支払方法の選択欄（手書き領収証）。
 *
 * 市販の領収証用紙には「現金・小切手・手形」のような選択肢が
 * **あらかじめ印刷**されており、発行者はどれかを丸で囲む。
 * OCR は丸を読まないので、印刷された選択肢が全部テキストになる。
 *
 * この行を根拠にすると、カード払いの領収証でも「現金」と判定される。
 * どれが選ばれたかは分からないので、根拠として使わない。
 */
const PAYMENT_OPTION_LIST = /(現金|小切手|手形|振込|振替|カード)[\s　]*[・･／/、,][\s　]*(現金|小切手|手形|振込|振替|カード)/;

/*
 * §10.10。
 *
 * ------------------------------------------------------------------
 * 先に見つかったものを採らない
 * ------------------------------------------------------------------
 * 当初は PAYMENT_METHODS の並び順に照合し、最初に当たったものを
 * 確定していた。現金が先頭にあるため、クレジットの記載がある
 * 領収証でも現金と判定されうる。並び順は優先順位ではない。
 *
 * §10.4 が「候補が複数残った場合はルールで確定しない」としているのと
 * 同じ考え方で、複数当たったら確定せずに補完と要確認へ回す。
 * ------------------------------------------------------------------
 */
export function extractPaymentMethod(lines) {
  const result = empty();

  /* 選択欄の行は根拠に使わない。どれが丸で囲まれたか読めないため。 */
  const usable = lines.filter((line) => !PAYMENT_OPTION_LIST.test(line));
  const hits = [];

  for (const method of PAYMENT_METHODS) {
    const line = usable.find((item) => method.pattern.test(item));

    if (line) {
      hits.push({ label: method.label, line });
    }
  }

  result.candidates = hits.length;

  if (hits.length === 1) {
    result.value = hits[0].label;
    result.evidence = hits[0].line;
    result.confirmed = true;
  }

  /*
   * 複数当たった場合は値を入れない。
   * 「現金で一部、残りをカード」も実在するため、
   * どちらか一方を機械が選ぶのは誤りである。
   */
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
 * その行に日付が混ざっているか。
 *
 * ------------------------------------------------------------------
 * 「行全体が日付」では足りない
 * ------------------------------------------------------------------
 * 当初は parseDate() が通るかどうかで見ていた。しかし実機では
 * 「様 様 2027 年 7 月 29 日 729」のように、手書き領収証の複数の欄が
 * 1行へ潰れたゴミ行を店名として採用してしまった。
 *
 * この行は parseDate() を通らない（「2027 年」に空白が入るため）。
 * 行全体の一致を求めると、崩れた行ほど素通りする。
 *
 * そこで、行の**どこかに**日付らしい並びがあるかで見る。
 * 区切りの前後に空白が入っていても拾う。
 * ------------------------------------------------------------------
 */
const DATE_ISH_MARK = new RegExp(
  '\\d{2,4}\\s*[年./-]\\s*\\d{1,2}\\s*[月./-]\\s*\\d{1,2}'
  + '|(令和|平成|昭和)\\s*\\d{1,2}\\s*年'
  + '|\\d{1,2}\\s*月\\s*\\d{1,2}\\s*日',
);

function hasDateInLine(line) {
  return parseDate(line) !== null || DATE_ISH_MARK.test(line);
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
 * ------------------------------------------------------------------
 * 「様」をどこまで宛名とみなすか
 * ------------------------------------------------------------------
 * 当初は行末の「様」だけを見ていた。しかし実機では
 * 「様 様 2027 年 7 月 29 日 729」のように、行末が数字で終わる
 * 崩れた行を素通りさせた。
 *
 * そこで、単独で立っている「様」（前後が空白か行端）も宛名とみなす。
 * 語の途中に出る「様」（「王様のパン工房」）は見ない。
 * ------------------------------------------------------------------
 */
const ADDRESSEE_MARK = /(御中|各位|上様|様[\s　]*$|(^|[\s　])様(?=[\s　]|$))/;

function hasAddresseeMark(line) {
  return ADDRESSEE_MARK.test(line.trim());
}

/* 金額の欄。「¥2,761」のように金額しか無い行と、金額ラベルの付いた行。 */
const MONEY_LABEL = /(合計|小計|総計|現計|請求|支払|預|釣|税|金額|単価|数量|点数|残高|ポイント|お買上)/;

function hasMoneyInLine(line) {
  if (!/\d/.test(line)) {
    return false;
  }

  /* 金額しか書かれていない行。数字・通貨記号・区切りを除くと何も残らない。 */
  const withoutMoney = line.replace(/[¥￥,.\s　円0-9-]/g, '');

  if (withoutMoney === '') {
    return true;
  }

  return MONEY_LABEL.test(line) && findAmounts(line).length > 0;
}

/* 電話番号の欄。 */
function hasPhoneInLine(line) {
  return PHONE_LABEL.test(line) || /(?<!\d)0\d{1,4}[-(]\d{1,4}/.test(line);
}

/*
 * 用紙に印刷されている見出しと定型文。
 *
 * レシートは金額欄の見出しが先に並び、店名は後ろに出ることがある。
 * 実機のレシートでは、先頭8行が金額と見出しだけで埋まり、
 * 「稅金額」を店名として採ってしまった。
 *
 * 値のある行かどうかではなく、**用紙の一部かどうか**で外す。
 */
const BOILERPLATE_MARK = /^(税|稅|消費税|内消費税|税率|小計|合計|総計|点数|数量|単価|お預|おつり|お釣|釣銭|残高|ポイント|受付|担当|テーブル|人数|POS|レジ|伝票|但し|上記|印刷|ありがとう|またのお越し|〒)/;

/*
 * ==================================================================
 * 支払先として採ってよい行か（§10.3）
 * ==================================================================
 * 当初は「これは店名ではない」を見つけるたびに除外を継ぎ足していた。
 * 手書き領収証は欄が崩れて1行へ潰れるため、その形では
 * 新しい崩れ方が出るたびに抜け道ができる。実機で
 * 「様 様 2027 年 7 月 29 日 729」と「¥2,761」の両方を採ってしまった。
 *
 * そこで、採用してよい条件のほうを定義する。
 *
 *   法人格が読める行  … 採る（ただし宛名は除く）
 *   読めない行        … 下の「他の欄の中身」を含まないものだけ採る
 *
 * 他の欄の中身 = 金額 / 日付 / 宛名マーカー / 電話番号 / 住所 / 用紙の題字
 *
 * 迷ったら採らない側へ倒す。採らなくても補完と要確認で拾えるが、
 * 誤った店名で確定すると §15.1 の「誤った値を高信頼で提示 0件」に反する。
 * ==================================================================
 */
export function isPayeeCandidate(line) {
  const text = String(line ?? '').trim();

  if (text.length < 2 || text.length > 60) {
    return false;
  }

  /*
   * 宛名だけは法人格による例外を認めない。
   * 宛名はたいてい法人名で書かれるため（「株式会社◯◯ 御中」）、
   * ここで例外を認めると支払先の欄に自社名が入る。
   */
  if (hasAddresseeMark(text)) {
    return false;
  }

  /* 法人格が読めるなら、他の欄が同居していても店名とみなす。 */
  if (COMPANY_MARK.test(text)) {
    return true;
  }

  /* 用紙に印刷された見出し・定型文。 */
  if (BOILERPLATE_MARK.test(text)) {
    return false;
  }

  /* 法人格が読めない行は、他の欄の中身を含まないことを求める。 */
  return !hasMoneyInLine(text)
    && !hasDateInLine(text)
    && !hasPhoneInLine(text)
    && !ADDRESS_MARK.test(text)
    && !isTitleLine(text);
}

/*
 * 「事業者名:◯◯」のようにラベルが付いた支払先（§10.3）。
 *
 * 位置で推し量る §10.3-2 より、ラベルのほうがはるかに確かである。
 * 店舗マスタの次に見る。
 */
const PAYEE_LABEL = /(事業者名|発行者|販売者|店名|屋号)(.*)$/;

export function extractLabeledPayee(lines) {
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(PAYEE_LABEL);

    if (!match) {
      continue;
    }

    /* 区切り記号はここで落とす。ラベルだけの行を「:」という値にしない。 */
    let value = match[2].replace(/^[\s　:：]+/, '').trim();

    if (value === '') {
      continue;
    }

    /*
     * OCR が「株式会社」を行またぎで割ることがある
     * （実機で「…株式会」＋「社」に割れた）。次の行が「社」だけなら継ぐ。
     */
    const next = String(lines[i + 1] ?? '').trim();

    if (/(株式会|有限会|合同会|合資会)$/.test(value) && next === '社') {
      value += '社';
    }

    return { value, evidence: lines[i] };
  }

  return null;
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

  /* 2. ラベルの付いた事業者名。位置で推し量るより確かなので先に見る。 */
  const labeled = extractLabeledPayee(lines);

  if (labeled) {
    result.value = labeled.value;
    result.evidence = labeled.evidence;
    result.confirmed = true;
    result.candidates = 1;
    return result;
  }

  /*
   * 3. 法人格を含む行（§10.3-3）。
   *
   * 探す範囲を先頭に限らない。レシートは金額欄が先に並び、
   * 発行者が末尾に出ることがある。先頭を優先しつつ、
   * 無ければ全体から探す。
   */
  const head = lines.slice(0, 8);

  const withCompany = head.find((line) => COMPANY_MARK.test(line) && isPayeeCandidate(line))
    ?? lines.find((line) => COMPANY_MARK.test(line) && isPayeeCandidate(line));

  if (withCompany) {
    result.value = withCompany;
    result.evidence = withCompany;
    result.confirmed = true;
    result.candidates = 1;
    return result;
  }

  const first = head.find(isPayeeCandidate);

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

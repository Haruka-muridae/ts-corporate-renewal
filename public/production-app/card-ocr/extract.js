/*
 * テキストの正規化と、正規表現による事前抽出（§FR-09・FR-10）。
 *
 * ==================================================================
 * ここに通信も DOM も無い
 * ==================================================================
 * 入力は OCR が返した文字列、出力は正規化した文字列と候補の集合。
 * すべて純粋関数なので、ブラウザ無しで確かめられる。
 * ==================================================================
 *
 * ==================================================================
 * 正規表現は Gemini の代わりではない。**得意な所だけを担当する**
 * ==================================================================
 * §FR-10 は「用途分類は Gemini 優先」としている。会社名・氏名・役職の
 * ような文脈の要る判断は Gemini に任せる。
 *
 * 一方で、**形が決まっているものは正規表現のほうが確実**である。
 * メール・URL・郵便番号・電話番号がそれにあたる。
 *
 * とくに携帯番号は、日本では 070 / 080 / 090 で始まると決まっている。
 * フェーズ0の予行で「同じ番号が phone と mobile の両方に入る」
 * 不具合が出たが（計画 §7-5-3 の課題3）、**これはプロンプトを直すより
 * 番号の形で決めるほうが確実**である。ここで判定する。
 * ==================================================================
 */

/* Gemini へ送る上限（§FR-09、§20）。 */
export const MAX_GEMINI_INPUT_LENGTH = 2000;

/* ---------- 正規化（§FR-09） ---------- */

/*
 * OCR の出力を整える。
 *
 *   1. NFKC で全角英数と半角カナを揃える
 *   2. 制御文字を落とす（タブは空白へ）
 *   3. 行ごとに前後の空白を落とす
 *   4. 空行と**重複行**を落とす
 *
 * 重複行を落とすのは、名刺の表裏に同じ文字列が入ることが多く、
 * 上限（2,000文字）を無駄に食うため。
 */
export function normalizeText(input) {
  const source = String(input ?? '');

  /* 全角英数・半角カナを揃える。名刺は表記が混ざる。 */
  const normalized = source.normalize('NFKC');

  const seen = new Set();
  const lines = [];

  for (const rawLine of normalized.split(/\r\n|\r|\n/)) {
    /* 制御文字は空白へ。落とすと単語がくっつく。 */
    const line = [...rawLine]
      .map((ch) => (ch.codePointAt(0) < 0x20 || ch.codePointAt(0) === 0x7f ? ' ' : ch))
      .join('')
      .replace(/\s+/g, ' ')
      .trim();

    if (line === '' || seen.has(line)) {
      continue;
    }

    seen.add(line);
    lines.push(line);
  }

  return lines.join('\n');
}

/* ---------- 事前抽出（§FR-10） ---------- */

/*
 * 形が決まっているものだけを拾う。
 * **拾えなかったものは空にする。推測で埋めない**（§FR-13）。
 */
const PATTERNS = Object.freeze({
  email: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
  url: /https?:\/\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]+/g,
  postalCode: /(?:〒\s*)?(\d{3}-\d{4})/g,
});

/*
 * 電話番号らしい並び。
 *
 * 国内表記（03-1234-5678、090-1234-5678）と国際表記（+81 90 …）を拾う。
 * **数字の並びだけでは拾わない。** 名刺には郵便番号・番地・登録番号など
 * 数字の並びが多く、区切り記号を要求しないと拾いすぎる。
 */
const PHONE_PATTERN = /(?:\+81[\d\-\s()]{9,}|0\d{1,4}[-\s(]\d{1,4}[)\-\s]?\d{3,4})/g;

/* ラベルから種別が分かる場合。名刺はたいていラベルが付いている。 */
const LABELS = Object.freeze([
  { kind: 'fax', pattern: /\b(fax|ＦＡＸ|F\s*A\s*X)\b/i },
  { kind: 'mobile', pattern: /(携帯|モバイル|\bmobile\b|\bcell\b|\bM\.?P\b)/i },
  { kind: 'phone', pattern: /(電話|\btel\b|\bphone\b|代表)/i },
]);

/*
 * 数字だけにした番号。比較と種別判定に使う。
 * 先頭の +81 は 0 に読み替える（同じ番号を別物にしないため）。
 */
export function normalizePhoneDigits(value) {
  const digits = String(value ?? '').replace(/[^\d+]/g, '');

  if (digits.startsWith('+81')) {
    return `0${digits.slice(3)}`;
  }

  return digits.replace(/\+/g, '');
}

/*
 * 携帯番号か。
 *
 * **日本では 070 / 080 / 090 で始まると決まっている。**
 * ここを形で決めておけば、同じ番号が phone と mobile の両方に入る
 * ことは起きない（計画 §7-5-3 の課題3）。
 */
export function isMobileNumber(value) {
  return /^0[789]0\d{8}$/.test(normalizePhoneDigits(value));
}

/* 行に付いているラベルから種別を読む。無ければ null。 */
export function labelKindOf(line) {
  for (const { kind, pattern } of LABELS) {
    if (pattern.test(String(line ?? ''))) {
      return kind;
    }
  }

  return null;
}

/*
 * 行の中に現れるラベルを、位置つきで拾う。
 *
 * **1行に複数のラベルが入ることがある。**
 * 「TEL: 03-1234-5678  FAX: 03-1234-5679」のような名刺は珍しくない。
 * 行に1つの種別を割り当てると、両方の番号が同じ種別になる。
 */
function labelPositions(line) {
  const found = [];

  for (const { kind, pattern } of LABELS) {
    /* g を付け直して全部拾う。元の pattern は使い回すので複製する。 */
    const global = new RegExp(pattern.source, `${pattern.flags.replace(/g/g, '')}g`);

    for (const match of String(line ?? '').matchAll(global)) {
      found.push({ kind, index: match.index ?? 0 });
    }
  }

  return found.sort((a, b) => a.index - b.index);
}

/* その位置より前にある、いちばん近いラベル。 */
function labelBefore(labels, index) {
  let kind = null;

  for (const label of labels) {
    if (label.index < index) {
      kind = label.kind;
    }
  }

  return kind;
}

/*
 * 電話番号を種別ごとに振り分ける。
 *
 * 優先順位:
 *   1. **番号の形**（070/080/090 なら携帯）— いちばん確実
 *   2. 行のラベル（FAX / 携帯 / TEL）
 *   3. どちらも無ければ phone
 *
 * 形を先に見るのは、「TEL: 090-…」と書かれた名刺があるため。
 * ラベルより番号のほうが正しい。
 *
 * **同じ番号を2つの種別に入れない。** 先に決まったほうを採る。
 */
export function classifyPhones(text) {
  const result = { phone: [], mobile: [], fax: [] };
  const taken = new Set();

  for (const line of String(text ?? '').split('\n')) {
    const labels = labelPositions(line);
    const pattern = new RegExp(PHONE_PATTERN.source, 'g');

    for (const found of line.matchAll(pattern)) {
      const match = found[0];
      /* **その番号の直前にあるラベル**を見る。行単位ではない。 */
      const label = labelBefore(labels, found.index ?? 0);
      const digits = normalizePhoneDigits(match);

      if (digits.length < 10 || taken.has(digits)) {
        continue;
      }

      taken.add(digits);

      let kind = 'phone';

      if (isMobileNumber(digits)) {
        kind = 'mobile';
      } else if (label === 'fax') {
        kind = 'fax';
      } else if (label === 'mobile') {
        /* ラベルは携帯だが番号の形が違う。ラベルを信じる。 */
        kind = 'mobile';
      }

      result[kind].push(match.trim());
    }
  }

  return result;
}

function uniqueMatches(text, pattern) {
  const found = String(text ?? '').match(pattern) ?? [];
  return [...new Set(found)];
}

/*
 * 事前抽出（§FR-10）。
 *
 * 戻り値は**候補の配列**。1つに決めるのは統合のとき（merge.js）。
 * 名刺には複数のメールや番号があることがあり、ここで選ぶと
 * Gemini の判断と食い違ったときに理由が分からなくなる。
 */
export function extractByPattern(text) {
  const normalized = String(text ?? '');
  const phones = classifyPhones(normalized);

  return {
    email: uniqueMatches(normalized, PATTERNS.email),
    url: uniqueMatches(normalized, PATTERNS.url),
    /* 〒 は落として数字だけにする（OCR が 〒 を T と読むことがある）。 */
    postalCode: uniqueMatches(normalized, PATTERNS.postalCode)
      .map((value) => value.replace(/^〒\s*/, '')),
    phone: phones.phone,
    mobile: phones.mobile,
    fax: phones.fax,
  };
}

/* ---------- 上限に収める（§FR-09） ---------- */

/*
 * Gemini へ送る前に上限へ収める。
 *
 * **切り捨てるときは、抽出済み項目を含む行を優先して残す**（§FR-09）。
 * 頭から機械的に切ると、名刺の下の方にあるメールや電話が落ちる。
 * 会社名や氏名は上の方にあるので、順序は保ったまま「落とす行」を選ぶ。
 */
export function truncateForGemini(text, maxLength = MAX_GEMINI_INPUT_LENGTH) {
  const source = String(text ?? '');

  if (source.length <= maxLength) {
    return source;
  }

  const lines = source.split('\n');
  const extracted = extractByPattern(source);
  const needles = [
    ...extracted.email, ...extracted.url, ...extracted.postalCode,
    ...extracted.phone, ...extracted.mobile, ...extracted.fax,
  ];

  const important = new Set();

  lines.forEach((line, index) => {
    if (needles.some((needle) => line.includes(needle))) {
      important.add(index);
    }
  });

  /* 重要な行を先に確保し、残りを上から詰める。並び順は元のまま。 */
  const keep = new Set();
  let used = 0;

  const tryKeep = (index) => {
    const cost = lines[index].length + 1;

    if (used + cost > maxLength) {
      return false;
    }

    keep.add(index);
    used += cost;
    return true;
  };

  for (const index of important) {
    tryKeep(index);
  }

  for (let index = 0; index < lines.length; index += 1) {
    if (!keep.has(index)) {
      tryKeep(index);
    }
  }

  return [...keep]
    .sort((a, b) => a - b)
    .map((index) => lines[index])
    .join('\n');
}

/* 正規化して上限に収めるところまでを一度に。 */
export function prepareForGemini(text, maxLength = MAX_GEMINI_INPUT_LENGTH) {
  return truncateForGemini(normalizeText(text), maxLength);
}

/*
 * 名刺1件に付ける機械的な属性の計算。
 *
 * このファイルは純粋関数だけで構成する。
 * DOM・fetch・Drive・Sheets・アクセストークンのいずれも参照しない。
 * したがって Node からそのまま import してテストできる（この性質を壊さないこと）。
 *
 * 扱うもの:
 *   カードID / 会社ID / SHA-256 / 名刺の向き / 言語 / OCR信頼度 / OCRエンジン名
 *
 * ここに置かないもの:
 *   API呼び出し / 画面文言 / 保存処理
 */

/* ==================================================================
 * OCRエンジン
 * ================================================================== */

/*
 * 保存する固定値。文字列を各所へ直書きしないこと。
 * 別のエンジンを足すときは、ここに定数を増やして保存時に選ぶ形にする。
 */
export const OCR_ENGINE = 'Google Drive OCR';

/* ==================================================================
 * SHA-256
 *
 * Web Crypto（crypto.subtle）を使う。ただし crypto.subtle は
 * **セキュアコンテキストでしか存在しない**。
 * http://localhost は secure context だが、http://192.168.x.x は違う。
 * 実機をLAN経由で開いた場合に undefined になるため、純JS版を用意してある。
 *
 * 純JS版は遅いが、対象は名刺画像1枚（数百KB）と会社名だけなので実用上問題ない。
 * ================================================================== */

const K = Object.freeze([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(value, bits) {
  return (value >>> bits) | (value << (32 - bits));
}

/* 純JS版の SHA-256。入力・出力ともバイト列で扱う。 */
function sha256Bytes(bytes) {
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);

  const length = bytes.length;
  /* 末尾に 0x80、長さ64bit、64バイト境界へパディングする。 */
  const paddedLength = (((length + 9) >> 6) + 1) << 6;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[length] = 0x80;

  /* 長さはビット数。2^32ビット（512MB）を超える入力は想定しない。 */
  const bitLength = length * 8;
  padded[paddedLength - 4] = (bitLength >>> 24) & 0xff;
  padded[paddedLength - 3] = (bitLength >>> 16) & 0xff;
  padded[paddedLength - 2] = (bitLength >>> 8) & 0xff;
  padded[paddedLength - 1] = bitLength & 0xff;

  const w = new Uint32Array(64);

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i += 1) {
      const j = offset + i * 4;
      w[i] = (padded[j] << 24) | (padded[j + 1] << 16) | (padded[j + 2] << 8) | padded[j + 3];
    }

    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let [a, b, c, d, e, f, g, hh] = h;

    for (let i = 0; i < 64; i += 1) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (hh + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;

      hh = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
    h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0;
    h[7] = (h[7] + hh) >>> 0;
  }

  const out = new Uint8Array(32);

  for (let i = 0; i < 8; i += 1) {
    out[i * 4] = (h[i] >>> 24) & 0xff;
    out[i * 4 + 1] = (h[i] >>> 16) & 0xff;
    out[i * 4 + 2] = (h[i] >>> 8) & 0xff;
    out[i * 4 + 3] = h[i] & 0xff;
  }

  return out;
}

function toHex(bytes) {
  let out = '';

  for (let i = 0; i < bytes.length; i += 1) {
    out += bytes[i].toString(16).padStart(2, '0');
  }

  return out;
}

/* 入力を Uint8Array へ揃える。文字列は UTF-8 として符号化する。 */
function toBytes(input) {
  if (input instanceof Uint8Array) {
    return input;
  }

  if (input instanceof ArrayBuffer) {
    return new Uint8Array(input);
  }

  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }

  return new TextEncoder().encode(String(input ?? ''));
}

/*
 * SHA-256 を16進小文字64文字で返す。
 *
 * crypto.subtle があればそれを使い、無ければ純JS版へ落とす。
 * どちらも同じ値を返す（テストで突き合わせている）。
 */
export async function sha256Hex(input) {
  const bytes = toBytes(input);
  const subtle = globalThis.crypto?.subtle;

  if (subtle && typeof subtle.digest === 'function') {
    try {
      /* Uint8Array の一部ビューをそのまま渡すと環境差が出るため、複製して渡す。 */
      const copy = new Uint8Array(bytes);
      const digest = await subtle.digest('SHA-256', copy);
      return toHex(new Uint8Array(digest));
    } catch {
      /* セキュアコンテキスト外などで失敗した場合は純JS版へ。 */
    }
  }

  return toHex(sha256Bytes(bytes));
}

/* ==================================================================
 * カードID
 * ================================================================== */

export const CARD_ID_PREFIX = 'CARD';
const CARD_ID_SEQUENCE_DIGITS = 6;
const CARD_ID_RE = /^CARD-(\d{8})-(\d{6})$/;

function pad2(value) {
  return String(value).padStart(2, '0');
}

/* YYYYMMDD。ローカル時刻で作る（登録日時と同じ基準にするため）。 */
export function formatCardIdDate(date = new Date()) {
  return `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}`;
}

/*
 * CARD-YYYYMMDD-XXXXXX 形式のIDを組み立てる。
 * sequence は1始まり。桁が溢れた場合は切り詰めずそのまま伸ばす
 * （1日に100万件は想定しないが、黙って別のIDになるより気付ける方がよい）。
 */
export function buildCardId(sequence, date = new Date()) {
  const number = Math.max(1, Math.floor(Number(sequence) || 1));
  return `${CARD_ID_PREFIX}-${formatCardIdDate(date)}-${String(number).padStart(CARD_ID_SEQUENCE_DIGITS, '0')}`;
}

/* 形式が正しいかどうか。既存行の値を読むときの選別に使う。 */
export function isCardId(value) {
  return CARD_ID_RE.test(String(value ?? '').trim());
}

/*
 * 既存のカードID一覧から、その日の次の連番を求める。
 *
 * 同じ日付のIDだけを見て、最大の連番 + 1 を返す。
 * 1件も無ければ 1。形式外の値（手入力された文字列など）は無視する。
 */
export function nextCardSequence(existingIds, date = new Date()) {
  const day = formatCardIdDate(date);
  let max = 0;

  (Array.isArray(existingIds) ? existingIds : []).forEach((raw) => {
    const match = CARD_ID_RE.exec(String(raw ?? '').trim());

    if (!match || match[1] !== day) {
      return;
    }

    const sequence = Number(match[2]);

    if (Number.isFinite(sequence) && sequence > max) {
      max = sequence;
    }
  });

  return max + 1;
}

/* ==================================================================
 * 会社ID
 * ================================================================== */

export const COMPANY_ID_PREFIX = 'COMPANY';
const COMPANY_ID_HASH_LENGTH = 12;

/*
 * 会社名を突き合わせ用に整える。
 *
 *   ・全角英数記号を半角へ、全角スペースを半角へ
 *   ・空白をすべて除去（「株式会社 テスト」と「株式会社テスト」を同一視する）
 *   ・英字は小文字へ
 *
 * 法人格（株式会社／Inc. など）はあえて落とさない。
 * 落とすと「テスト株式会社」と「テスト合同会社」が同じIDになってしまう。
 */
export function normalizeCompanyName(value) {
  return String(value ?? '')
    .replace(/[！-～]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
    .replace(/　/g, ' ')
    .replace(/\s+/g, '')
    .toLowerCase();
}

/*
 * COMPANY-<正規化した会社名のSHA-256の先頭12文字>
 *
 * 会社名が空なら空文字を返す。
 * 同じ会社名なら常に同じIDになる（端末やブラウザが違っても同じ）。
 *
 * 将来これを会社マスタの参照へ置き換えるときは、この関数だけを差し替える。
 */
export async function buildCompanyId(companyName) {
  const normalized = normalizeCompanyName(companyName);

  if (normalized === '') {
    return '';
  }

  const hex = await sha256Hex(normalized);
  return `${COMPANY_ID_PREFIX}-${hex.slice(0, COMPANY_ID_HASH_LENGTH)}`;
}

/* ==================================================================
 * 名刺の向き
 * ================================================================== */

export const Orientation = Object.freeze({
  LANDSCAPE: '横',
  PORTRAIT: '縦',
  SQUARE: '正方形',
});

/* 正方形と判定する許容幅。1.1未満の差は正方形として扱う。 */
const ORIENTATION_RATIO = 1.1;

/*
 * 幅と高さから向きを決める。
 * 値が読めない場合は正方形（既定値）にする。誤った断定をしない。
 */
export function detectOrientation(width, height) {
  const w = Number(width);
  const h = Number(height);

  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    return Orientation.SQUARE;
  }

  if (w / h >= ORIENTATION_RATIO) {
    return Orientation.LANDSCAPE;
  }

  if (h / w >= ORIENTATION_RATIO) {
    return Orientation.PORTRAIT;
  }

  return Orientation.SQUARE;
}

/* ==================================================================
 * 言語
 * ================================================================== */

export const Language = Object.freeze({
  JA: '日本語',
  EN: '英語',
  ZH: '中国語',
  KO: '韓国語',
  MIXED: '混在',
  UNKNOWN: '不明',
});

/* 判定の母数から外すもの。書式が決まっていて言語の手がかりにならない。 */
const NOISE_PATTERNS = Object.freeze([
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,   // メール
  /https?:\/\/\S+/g,                                    // URL（スキーム付き）
  /(?:www\.)[A-Za-z0-9.-]+\.[A-Za-z]{2,}\S*/g,          // URL（www）
  /[0-9０-９][0-9０-９\-()（） ]{5,}/g,                  // 電話・FAX・郵便番号
]);

const HIRAGANA_RE = /[ぁ-ゟ]/g;
const KATAKANA_RE = /[ァ-ヺー]/g;
const HAN_RE = /[一-鿿㐀-䶿]/g;
const LATIN_RE = /[A-Za-z]/g;
const HANGUL_RE = /[가-힣ᄀ-ᇿ㄰-㆏]/g;

/* 「その言語がある」と見なす最低比率。これ未満は混在に数えない。 */
const MIXED_THRESHOLD = 0.2;

/*
 * 漢字・かな・ハングルに掛ける重み。
 *
 * 文字数をそのまま比べると、必ずラテン文字側に偏る。
 * 「株式会社テスト」は7文字だが、同じ意味の "TEST Corporation" は16文字あり、
 * 素の比率では日本語が2割を切って英語だけと判定されてしまう。
 * 1文字あたりの情報量の差を埋めるため、CJK側を2倍に数える。
 */
const CJK_WEIGHT = 2;

function countMatches(text, re) {
  const matches = text.match(re);
  return matches ? matches.length : 0;
}

/*
 * OCRテキストから言語を推定する。
 *
 * 方針:
 *   ・メール／URL／電話番号／記号は母数から除く（どの言語でも同じ形のため）
 *   ・ひらがな・カタカナが1文字でもあれば日本語を優先する。
 *     漢字だけで判定すると、日本語の名刺が中国語になってしまう
 *   ・ハングルがあれば韓国語
 *   ・漢字のみ（かな無し）なら中国語
 *   ・ラテン文字だけなら英語
 *   ・上記のうち2種類以上がそれぞれ2割以上を占めるなら混在
 *   ・比率を出すとき、CJK側は1文字あたりの情報量が多いぶん重みを掛ける
 *   ・判定に使える文字が無ければ不明
 *
 * 精密な言語判定ライブラリは入れない。名刺に必要な粒度はこれで足りる。
 */
export function detectLanguage(text) {
  let cleaned = String(text ?? '');

  NOISE_PATTERNS.forEach((re) => {
    cleaned = cleaned.replace(re, ' ');
  });

  const hiragana = countMatches(cleaned, HIRAGANA_RE);
  const katakana = countMatches(cleaned, KATAKANA_RE);
  const han = countMatches(cleaned, HAN_RE);
  const latin = countMatches(cleaned, LATIN_RE);
  const hangul = countMatches(cleaned, HANGUL_RE);

  if (hiragana + katakana + han + latin + hangul === 0) {
    return Language.UNKNOWN;
  }

  /* かなの有無で日本語と中国語を分ける。ここが判定の要。 */
  const kana = hiragana + katakana;
  const japanese = (kana > 0 ? kana + han : 0) * CJK_WEIGHT;
  const chinese = (kana > 0 ? 0 : han) * CJK_WEIGHT;
  const korean = hangul * CJK_WEIGHT;

  const total = japanese + chinese + korean + latin;

  const scores = [
    { language: Language.JA, count: japanese },
    { language: Language.ZH, count: chinese },
    { language: Language.KO, count: korean },
    { language: Language.EN, count: latin },
  ].filter((item) => item.count > 0);

  if (scores.length === 0) {
    return Language.UNKNOWN;
  }

  const significant = scores.filter((item) => item.count / total >= MIXED_THRESHOLD);

  if (significant.length >= 2) {
    return Language.MIXED;
  }

  scores.sort((a, b) => b.count - a.count);

  return scores[0].language;
}

/* ==================================================================
 * OCR信頼度
 * ================================================================== */

/*
 * 主要項目。ここに挙げたものだけで平均を取る。
 * 空欄も母数に含める（＝0点として数える）。
 *
 * 含めない方式だと「1項目しか取れなかったが、それがメールだったので100点」と
 * なってしまい、読み取り不良の名刺が満点になる。
 * 固定母数にすることで「6項目のうちどれだけ拾えたか」が数値へ表れる。
 */
export const CONFIDENCE_FIELDS = Object.freeze([
  'company',
  'name',
  'primaryEmail',
  'tel',
  'mobile',
  'address',
]);

/* confidence 区分から点数へ。fields.js の区分と対応させる。 */
export const CONFIDENCE_SCORES = Object.freeze({
  high: 100,
  medium: 70,
  low: 40,
});

/*
 * アプリ独自の総合信頼度（0〜100の整数）を求める。
 *
 * **これは Google が返す公式の信頼度ではない。** Drive の OCR は数値を返さないため、
 * 「どの項目を、どれだけ確かな手がかりで取れたか」をアプリ側で点数化したものである。
 *
 * 1項目あたりの点数:
 *   利用者が手で直した          … 100（人が確認した値なので最も確か）
 *   値が空                      … 0
 *   自動入力の根拠が無い(matched=false) … 0
 *   根拠あり                    … その項目の confidence 区分による（high 100 / medium 70 / low 40）
 *
 * 引数:
 *   values          … 確認画面の現在値
 *   matched         … 項目ごとの根拠の有無
 *   confidenceByKey … 項目ごとの confidence 区分（fields.js 由来）
 *   editedKeys      … 利用者が手で直した項目のキー（配列または Set）
 */
export function calcOcrConfidence({ values, matched, confidenceByKey, editedKeys }) {
  const edited = editedKeys instanceof Set ? editedKeys : new Set(editedKeys ?? []);

  const total = CONFIDENCE_FIELDS.reduce((sum, key) => {
    /* メールは配列で持つため、メインの値を見る。 */
    const value = key === 'primaryEmail'
      ? String(values?.primaryEmail ?? values?.emails?.[0] ?? '')
      : String(values?.[key] ?? '');

    /* 手で直した項目は、根拠の有無にかかわらず満点。 */
    if (edited.has(key) && value !== '') {
      return sum + 100;
    }

    if (value === '') {
      return sum;
    }

    const matchedKey = key === 'primaryEmail' ? 'emails' : key;

    if (matched?.[matchedKey] !== true) {
      return sum;
    }

    const level = key === 'primaryEmail'
      ? (confidenceByKey?.emails ?? 'high')
      : (confidenceByKey?.[key] ?? 'low');

    return sum + (CONFIDENCE_SCORES[level] ?? 0);
  }, 0);

  return Math.round(total / CONFIDENCE_FIELDS.length);
}

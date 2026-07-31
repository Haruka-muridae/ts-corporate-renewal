/*
 * テキスト正規化。
 *
 * ------------------------------------------------------------------
 * 原則（重要）
 * ------------------------------------------------------------------
 * 原文の意味・数字・固有名詞を変更しない。
 * 行うのは「ノイズの除去」だけで、言い換え・要約・単位換算・全角半角の
 * 相互変換（数字を含む）は行わない。
 * ------------------------------------------------------------------
 *
 * 依存を持たない純関数にしてある（Web Worker からもそのまま使える）。
 */

/*
 * 制御文字を除去する。
 *   - C0 制御文字（\n \t を除く）
 *   - DEL、C1 制御文字
 *   - BOM / ゼロ幅文字 / 双方向制御文字（表示偽装に使われるため）
 * 改行は \n へ統一する。
 */
export function stripControlChars(input) {
  const source = String(input ?? '')
    .replace(/\r\n?/g, '\n')
    /* 改ページはPDFの区切りとして来るため、段落境界として扱う。 */
    .replace(/\f/g, '\n\n');

  let out = '';

  for (const char of source) {
    const code = char.codePointAt(0);

    /* C0（\n と \t は残す） */
    if (code < 0x20 && char !== '\n' && char !== '\t') {
      continue;
    }

    /* DEL と C1 */
    if (code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
      continue;
    }

    /* BOM / ゼロ幅 / 語結合子 */
    if (code === 0xfeff || (code >= 0x200b && code <= 0x200f) || code === 0x2060) {
      continue;
    }

    /* 双方向制御（LRE/RLE/PDF/LRO/RLO と分離子） */
    if (code >= 0x202a && code <= 0x202e) {
      continue;
    }
    if (code >= 0x2066 && code <= 0x2069) {
      continue;
    }

    /* ソフトハイフン（PDF由来で単語中に混ざる） */
    if (code === 0x00ad) {
      continue;
    }

    out += char;
  }

  return out;
}

/*
 * 連続する空白を整理する。
 *   - NBSP を通常の空白に寄せる
 *   - 半角スペース／タブの連続を1つに
 *   - 全角スペースの連続を1つに（全角は全角のまま。日本語の見た目を壊さない）
 *   - 行末の空白を落とす
 * 単語の途中に空白を足したり、日本語の文字を削ったりはしない。
 */
export function collapseWhitespace(input) {
  return String(input ?? '')
    .replace(/ /g, ' ')
    .split('\n')
    .map((line) => line
      .replace(/[ \t]+/g, ' ')
      /* 全角スペースは全角のまま、連続だけをまとめる（日本語の体裁を壊さない）。 */
      .replace(/　{2,}/g, '　')
      .replace(/[ \t　]+$/g, ''))
    .join('\n');
}

/* 3行以上の連続する空行を、段落区切り（空行1つ）へまとめる。 */
export function collapseBlankLines(input) {
  return String(input ?? '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '');
}

/* 直前とまったく同じ行が続く場合、2行目以降を落とす。 */
export function dedupeConsecutiveLines(input) {
  const lines = String(input ?? '').split('\n');
  const out = [];
  let previous = null;

  lines.forEach((line) => {
    const key = line.trim();

    /* 空行は段落区切りとして残す（重複判定の対象外）。 */
    if (key === '') {
      out.push(line);
      previous = null;
      return;
    }

    if (key === previous) {
      return;
    }

    out.push(line);
    previous = key;
  });

  return out.join('\n');
}

/*
 * ページ見出し・フッターのように、文書全体で何度も現れる短い行を落とす。
 *
 * 誤って本文を消さないよう、条件を厳しくしている。
 *   - 行の長さが maxLength 以下
 *   - 出現回数が minOccurrences 以上
 *   - 文末記号（。．.！？!?）で終わらない（＝文ではない）
 *   - 数字だけの行は対象外（ページ番号は毎回違うので通常は重複しない）
 * PDF 以外では既定で無効。
 */
export function dropRepeatedShortLines(input, { minOccurrences = 3, maxLength = 60 } = {}) {
  const lines = String(input ?? '').split('\n');
  const counts = new Map();

  lines.forEach((line) => {
    const key = line.trim();

    if (key === '' || key.length > maxLength) {
      return;
    }

    counts.set(key, (counts.get(key) ?? 0) + 1);
  });

  const removable = new Set();

  counts.forEach((count, key) => {
    if (count < minOccurrences) {
      return;
    }
    if (/[。．.！？!?]$/.test(key)) {
      return;
    }
    if (/^[\d\s.,-]+$/.test(key)) {
      return;
    }
    removable.add(key);
  });

  if (removable.size === 0) {
    return String(input ?? '');
  }

  return lines.filter((line) => !removable.has(line.trim())).join('\n');
}

/*
 * PDF 抽出でよく起きる、単語途中の不要な改行を戻す。
 * 日本語の行末が文字で、次行も文字から始まる場合のみ連結する。
 * 英文はスペースで区切って連結する（単語を壊さない）。
 */
export function joinBrokenLines(input) {
  const lines = String(input ?? '').split('\n');
  const out = [];

  const isJa = (char) => /[぀-ヿ㐀-鿿＀-￯]/.test(char);

  lines.forEach((line) => {
    const previous = out.length > 0 ? out[out.length - 1] : null;

    if (previous === null || previous === '' || line.trim() === '') {
      out.push(line);
      return;
    }

    const prevLast = previous[previous.length - 1];
    const currFirst = line.trim()[0];

    /* 文末や箇条書きの開始は連結しない。 */
    if (/[。．.！？!?:：、,;；]$/.test(previous) || /^[-*•・>#|]/.test(line.trim())) {
      out.push(line);
      return;
    }

    if (isJa(prevLast) && isJa(currFirst)) {
      out[out.length - 1] = previous + line.trim();
      return;
    }

    out.push(line);
  });

  return out.join('\n');
}

/*
 * 正規化の本体。
 *
 * options:
 *   sourceType        … 'pdf' | 'docx' | 'gdoc' | 'text' | 'markdown'
 *   dropRepeatedLines … 繰り返し行の除去（既定は sourceType === 'pdf' のときのみ true）
 *   joinLines         … 単語途中の改行の結合（既定は 'pdf' のときのみ true）
 */
export function normalizeText(input, options = {}) {
  const sourceType = options.sourceType ?? 'text';
  const isPdf = sourceType === 'pdf';

  const dropRepeated = options.dropRepeatedLines ?? isPdf;
  const joinLines = options.joinLines ?? isPdf;

  let text = stripControlChars(input);
  text = collapseWhitespace(text);

  if (dropRepeated) {
    text = dropRepeatedShortLines(text);
  }

  text = dedupeConsecutiveLines(text);

  if (joinLines) {
    text = joinBrokenLines(text);
  }

  text = collapseBlankLines(text);

  return text;
}

/* 正規化前後の差分を記録するための簡易メトリクス（ログ用。本文は含めない）。 */
export function normalizationStats(before, after) {
  return {
    beforeChars: String(before ?? '').length,
    afterChars: String(after ?? '').length,
    beforeLines: String(before ?? '').split('\n').length,
    afterLines: String(after ?? '').split('\n').length,
  };
}

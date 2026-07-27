/*
 * チャンク分割。
 *
 * ------------------------------------------------------------------
 * 方針（重要）
 * ------------------------------------------------------------------
 * 固定文字数だけで機械的に切らない。優先順位は
 *   1. 見出し（章・節の境界）
 *   2. 段落（空行）
 *   3. 改行
 *   4. 文末（。．！？.!?）
 *   5. どうしても収まらない場合のみ強制分割
 * の順で、上位の境界を優先して切る。
 * ------------------------------------------------------------------
 *
 * 依存を持たない純関数（Web Worker からもそのまま使える）。
 */

/*
 * 見出しの判定。
 *
 * 確実なもの:
 *   - Markdown ATX（# 〜 ######）
 *   - Markdown Setext（次行が === または ---）
 * 経験則（誤検出を減らすため条件を厳しくしている）:
 *   - 短く（60文字以下）、文末記号で終わらず、章番号・記号見出しの形をしている
 */
const ATX = /^(#{1,6})\s+(.+?)\s*#*$/;
const NUMBERED = /^(?:第[0-9０-９一二三四五六七八九十百]+[章節条項編部回]|[0-9０-９]+(?:[.．][0-9０-９]+)*[.．]?)(?:\s|　|$)/;
const BRACKETED = /^(?:[■□◆◇●○▲△※]|【.+】|〔.+〕|\[[^\]]+\])/;

function isSetextUnderline(line) {
  const trimmed = line.trim();
  return /^={3,}$/.test(trimmed) || /^-{3,}$/.test(trimmed);
}

export function detectHeading(line, nextLine) {
  const raw = String(line ?? '');
  const trimmed = raw.trim();

  if (trimmed === '') {
    return null;
  }

  const atx = ATX.exec(trimmed);

  if (atx) {
    return { level: atx[1].length, text: atx[2].trim() };
  }

  if (nextLine !== undefined && isSetextUnderline(nextLine) && trimmed.length <= 120) {
    return { level: /^=/.test(nextLine.trim()) ? 1 : 2, text: trimmed };
  }

  if (trimmed.length > 60) {
    return null;
  }

  /* 文になっている行は見出しにしない。 */
  if (/[。．！？!?、,]$/.test(trimmed)) {
    return null;
  }

  if (NUMBERED.test(trimmed)) {
    return { level: 3, text: trimmed };
  }

  if (BRACKETED.test(trimmed)) {
    return { level: 3, text: trimmed };
  }

  return null;
}

/*
 * 本文を「見出し + その配下の段落」の単位（セクション）へ分ける。
 * 見出しが1つも無い文書は、全体を1セクションとして扱う。
 */
export function splitSections(text) {
  const lines = String(text ?? '').split('\n');
  const sections = [];

  let current = { heading: '', level: 0, lines: [] };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const heading = detectHeading(line, lines[i + 1]);

    if (heading) {
      if (current.lines.some((l) => l.trim() !== '') || current.heading !== '') {
        sections.push(current);
      }

      current = { heading: heading.text, level: heading.level, lines: [] };

      /* Setext の下線行は本文に含めない。 */
      if (lines[i + 1] !== undefined && isSetextUnderline(lines[i + 1]) && !ATX.test(line.trim())) {
        i += 1;
      }

      continue;
    }

    current.lines.push(line);
  }

  if (current.lines.some((l) => l.trim() !== '') || current.heading !== '') {
    sections.push(current);
  }

  return sections.map((section) => ({
    heading: section.heading,
    level: section.level,
    text: section.lines.join('\n').replace(/^\n+/, '').replace(/\n+$/, ''),
  }));
}

/* 段落（空行区切り）へ分ける。 */
function splitParagraphs(text) {
  return String(text ?? '')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p !== '');
}

/* 文末で分ける。閉じ括弧・引用符が続く場合はそこまでを1文に含める。 */
function splitSentences(text) {
  const source = String(text ?? '');
  const out = [];
  let buffer = '';

  for (let i = 0; i < source.length; i += 1) {
    buffer += source[i];

    if (/[。．！？!?]/.test(source[i])) {
      /* 直後の閉じ記号を巻き取る。 */
      while (i + 1 < source.length && /[）」』】〉》”"'’\]]/.test(source[i + 1])) {
        i += 1;
        buffer += source[i];
      }

      out.push(buffer);
      buffer = '';
    }
  }

  if (buffer.trim() !== '') {
    out.push(buffer);
  }

  return out.length > 0 ? out : [source];
}

/*
 * 文字数で強制的に切る。
 *
 * String.prototype.slice はコード単位で切るため、そのまま使うと
 * 絵文字や一部の漢字（サロゲートペア）が2つに割れ、
 * 壊れた文字（孤立サロゲート）が保存・索引されてしまう。
 * 境界がペアの途中に来た場合は1つ手前へ寄せる。
 */
function hardSlice(text, maxChars) {
  const out = [];
  let start = 0;

  while (start < text.length) {
    let end = Math.min(start + maxChars, text.length);

    /* 上位サロゲートで終わるなら、その1文字ぶん手前で切る。 */
    if (end < text.length) {
      const code = text.charCodeAt(end - 1);
      if (code >= 0xd800 && code <= 0xdbff) {
        end -= 1;
      }
    }

    /* 上限が1文字ぶんも取れないほど小さい場合の保険。 */
    if (end <= start) {
      end = Math.min(start + 2, text.length);
    }

    out.push(text.slice(start, end));
    start = end;
  }

  return out;
}

/* 上限を超える単位を、改行 → 文 → 強制の順で細かくする。 */
function splitOversized(text, maxChars) {
  if (text.length <= maxChars) {
    return [text];
  }

  const byLine = text.split('\n').filter((line) => line.trim() !== '');
  const pieces = byLine.length > 1 ? byLine : splitSentences(text);
  const out = [];

  pieces.forEach((piece) => {
    if (piece.length <= maxChars) {
      out.push(piece);
      return;
    }

    const sentences = splitSentences(piece);

    if (sentences.length > 1) {
      sentences.forEach((sentence) => {
        if (sentence.length <= maxChars) {
          out.push(sentence);
          return;
        }
        /* 最後の手段。ここでのみ文字数で切る（サロゲートは割らない）。 */
        hardSlice(sentence, maxChars).forEach((part) => out.push(part));
      });
      return;
    }

    hardSlice(piece, maxChars).forEach((part) => out.push(part));
  });

  return out;
}

/*
 * 末尾から n 文字を取り出す。
 * 先頭が下位サロゲートにならないよう、割れる場合は1つ内側へ寄せる。
 */
function safeTail(text, n) {
  if (n <= 0 || text.length === 0) {
    return '';
  }

  let start = Math.max(0, text.length - n);

  if (start > 0) {
    const code = text.charCodeAt(start);
    if (code >= 0xdc00 && code <= 0xdfff) {
      start -= 1;
    }
  }

  return text.slice(start);
}

/* 直前チャンクの末尾から、文の切れ目を優先して overlap 分を取り出す。 */
function tailOverlap(text, overlapChars) {
  if (overlapChars <= 0 || text.length === 0) {
    return '';
  }

  const tail = safeTail(text, Math.min(overlapChars * 2, text.length));
  const sentences = splitSentences(tail);
  let acc = '';

  for (let i = sentences.length - 1; i >= 0; i -= 1) {
    const next = sentences[i] + acc;

    if (next.length > overlapChars && acc !== '') {
      break;
    }

    acc = next;

    if (acc.length >= overlapChars) {
      break;
    }
  }

  const result = acc === '' ? safeTail(text, overlapChars) : acc;
  return result.length > overlapChars * 2 ? safeTail(result, overlapChars) : result;
}

/*
 * 本体。
 *
 * options: { targetChars, overlapChars, maxChars, minChars }
 * 戻り値: [{ heading, text }]  （メタデータの付与は呼び出し側で行う）
 */
export function chunkText(text, options = {}) {
  const targetChars = Math.max(100, Number(options.targetChars) || 800);
  const maxChars = Math.max(targetChars, Number(options.maxChars) || 1200);
  const overlapChars = Math.max(0, Math.min(Number(options.overlapChars) || 100, Math.floor(targetChars / 2)));
  const minChars = Math.max(0, Number(options.minChars) || 0);

  const normalized = String(text ?? '').trim();

  if (normalized === '') {
    return [];
  }

  const chunks = [];

  splitSections(normalized).forEach((section) => {
    const units = [];

    splitParagraphs(section.text).forEach((paragraph) => {
      splitOversized(paragraph, maxChars).forEach((piece) => {
        const trimmed = piece.trim();
        if (trimmed !== '') {
          units.push(trimmed);
        }
      });
    });

    /* 見出しだけで本文が無いセクションは、チャンクにしない（空チャンクの除去）。 */
    if (units.length === 0) {
      return;
    }

    let buffer = '';
    let carry = '';

    const flush = () => {
      const body = buffer.trim();

      if (body === '') {
        buffer = '';
        return;
      }

      chunks.push({ heading: section.heading, text: body });
      carry = tailOverlap(body, overlapChars);
      buffer = '';
    };

    units.forEach((unit) => {
      const candidate = buffer === '' ? unit : `${buffer}\n\n${unit}`;

      if (candidate.length <= targetChars) {
        buffer = candidate;
        return;
      }

      /* 目標を超えるが上限内で、まだ何も溜まっていないならそのまま入れる。 */
      if (buffer === '') {
        buffer = unit.length <= maxChars ? unit : hardSlice(unit, maxChars)[0];
        flush();
        buffer = carry;
        return;
      }

      /* 上限に収まるなら、区切りの良さを優先して詰め込む。 */
      if (candidate.length <= maxChars) {
        buffer = candidate;
        flush();
        buffer = carry;
        return;
      }

      flush();
      buffer = carry === '' ? unit : `${carry}\n\n${unit}`;

      if (buffer.length > maxChars) {
        buffer = unit;
      }
    });

    flush();
  });

  /*
   * 短すぎる断片は、同じ見出しの隣へ吸収する（上限を超えない範囲でのみ）。
   * 前後どちらへも寄せられるようにしておくと、
   * 「見出し直後の一文だけが独立する」といった細切れを減らせる。
   */
  const merged = [];

  chunks.forEach((chunk) => {
    const previous = merged[merged.length - 1];

    if (!previous || previous.heading !== chunk.heading) {
      merged.push({ ...chunk });
      return;
    }

    const fits = previous.text.length + chunk.text.length + 2 <= maxChars;
    const eitherIsShort = chunk.text.length < minChars || previous.text.length < minChars;

    if (fits && eitherIsShort) {
      previous.text = `${previous.text}\n\n${chunk.text}`;
      return;
    }

    merged.push({ ...chunk });
  });

  /* 空チャンクの除去（最終確認）。 */
  return merged.filter((chunk) => chunk.text.trim() !== '');
}

/*
 * チャンクへメタデータを付ける。
 * chunkId は「ファイルID + 連番」で決まる。内容が変わっても同じIDになるため、
 * 再解析時は replaceChunks() で丸ごと入れ替える前提とする。
 */
export function attachChunkMetadata(chunks, { fileId, fileName, updatedTime, driveUrl }) {
  return chunks.map((chunk, index) => ({
    chunkId: `${fileId}:${index}`,
    fileId,
    fileName: fileName ?? '',
    heading: chunk.heading ?? '',
    text: chunk.text,
    chunkIndex: index,
    updatedTime: updatedTime ?? '',
    driveUrl: driveUrl ?? '',
  }));
}

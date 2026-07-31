/*
 * 検索結果の「関連部分」を切り出す。
 *
 * 返すのは素の文字列。強調（<mark>）は表示側の highlightFragment が
 * DOMノードとして組み立てる。ここでHTMLを作らないこと。
 *
 * DOM に依存しない純関数。
 */

const DEFAULT_WIDTH = 180;

export function buildSnippet(text, terms, { width = DEFAULT_WIDTH } = {}) {
  const source = String(text ?? '');

  if (source.length <= width) {
    return source;
  }

  const lower = source.toLowerCase();
  let hit = -1;

  (Array.isArray(terms) ? terms : []).some((term) => {
    const needle = String(term ?? '').trim().toLowerCase();

    if (needle === '') {
      return false;
    }

    const found = lower.indexOf(needle);

    if (found !== -1) {
      hit = found;
      return true;
    }

    return false;
  });

  if (hit === -1) {
    return `${source.slice(0, safeEnd(source, width))}…`;
  }

  /* 一致箇所が中央寄りに来るように前後を取る。 */
  const start = safeStart(source, Math.max(0, hit - Math.floor(width / 3)));
  const end = safeEnd(source, Math.min(source.length, start + width));

  return `${start > 0 ? '…' : ''}${source.slice(start, end)}${end < source.length ? '…' : ''}`;
}

/*
 * サロゲートペアを割らないための境界調整。
 * 割れた状態で切り出すと、画面に「壊れた文字」が出る。
 */
function safeStart(text, index) {
  const code = text.charCodeAt(index);
  return index > 0 && code >= 0xdc00 && code <= 0xdfff ? index - 1 : index;
}

function safeEnd(text, index) {
  if (index <= 0 || index >= text.length) {
    return index;
  }
  const code = text.charCodeAt(index - 1);
  return code >= 0xd800 && code <= 0xdbff ? index - 1 : index;
}

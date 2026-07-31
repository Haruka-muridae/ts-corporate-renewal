/*
 * DOM生成ヘルパー。
 *
 * ------------------------------------------------------------------
 * XSS対策の中核（重要）
 * ------------------------------------------------------------------
 * このアプリが扱う文字列は、ほぼすべてが外部由来である。
 *   - Google Drive のファイル名・フォルダ名
 *   - PDF / DOCX / TXT から抽出した本文
 *   - Drive が返すURL
 * したがって **innerHTML / outerHTML / insertAdjacentHTML を使わない**。
 * 文字列の挿入は必ず textContent か createTextNode を通す。
 *
 * ハイライト（<mark>）のような「HTMLに見える出力」も、
 * 文字列連結ではなく DOM ノードの組み立てで作る。
 * ------------------------------------------------------------------
 */

/*
 * 要素を作る。
 *
 *   el('div', { class: 'card', dataset: { id: '1' } }, [child, 'テキスト'])
 *
 * - text は textContent として設定する。
 * - on* は addEventListener として登録する。
 * - href / src は safeUrl() を通ったものだけを設定する。
 */
export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);

  Object.entries(props).forEach(([key, value]) => {
    if (value === null || value === undefined || value === false) {
      return;
    }

    if (key === 'text') {
      node.textContent = String(value);
      return;
    }

    if (key === 'class') {
      node.className = String(value);
      return;
    }

    if (key === 'dataset') {
      Object.entries(value).forEach(([dataKey, dataValue]) => {
        node.dataset[dataKey] = String(dataValue);
      });
      return;
    }

    if (key === 'style') {
      /* 文字列でのstyle指定は許さない（CSP/可読性のため）。 */
      Object.entries(value).forEach(([prop, propValue]) => {
        node.style.setProperty(prop, String(propValue));
      });
      return;
    }

    if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
      return;
    }

    if (key === 'href' || key === 'src') {
      const safe = safeUrl(value);
      if (safe) {
        node.setAttribute(key, safe);
      }
      return;
    }

    if (value === true) {
      node.setAttribute(key, '');
      return;
    }

    node.setAttribute(key, String(value));
  });

  appendChildren(node, children);
  return node;
}

export function appendChildren(node, children) {
  const list = Array.isArray(children) ? children : [children];

  list.forEach((child) => {
    if (child === null || child === undefined || child === false) {
      return;
    }

    if (child instanceof Node) {
      node.append(child);
      return;
    }

    /* プリミティブは必ずテキストノードにする。 */
    node.append(document.createTextNode(String(child)));
  });
}

/* 子をすべて外す。innerHTML = '' の代わり。 */
export function clear(node) {
  while (node.firstChild) {
    node.removeChild(node.firstChild);
  }
}

export function replaceChildren(node, children) {
  clear(node);
  appendChildren(node, children);
}

/*
 * リンクに使ってよいURLかを判定する。
 * 許可するのは https と、同一オリジンの相対パスのみ。
 * javascript: / data: / vbscript: / blob: / プロトコル相対 は拒否する。
 */
export function safeUrl(value) {
  if (typeof value !== 'string') {
    return null;
  }

  /* 制御文字による難読化（"java\nscript:" 等）を先に潰す。 */
  let cleaned = '';
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code > 0x1f && code !== 0x7f) {
      cleaned += value[i];
    }
  }
  cleaned = cleaned.trim();

  if (cleaned === '' || cleaned.startsWith('//')) {
    return null;
  }

  try {
    const url = new URL(cleaned, window.location.href);

    if (url.protocol !== 'https:') {
      /* 開発時の http://localhost だけは相対パス解決の結果として許容する。 */
      const isLocalRelative = !/^[a-z][a-z0-9+.-]*:/i.test(cleaned)
        && url.protocol === 'http:'
        && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');

      if (!isLocalRelative) {
        return null;
      }
    }

    return url.href;
  } catch {
    return null;
  }
}

/*
 * Google Drive のリンクとして妥当かを追加で検証する。
 * Drive API が返した webViewLink をそのまま信用しない。
 */
const DRIVE_HOSTS = new Set(['drive.google.com', 'docs.google.com']);

export function safeDriveUrl(value) {
  const safe = safeUrl(value);

  if (!safe) {
    return null;
  }

  try {
    return DRIVE_HOSTS.has(new URL(safe).hostname) ? safe : null;
  } catch {
    return null;
  }
}

/*
 * 本文の一部を、検索語の位置だけ <mark> で強調した DocumentFragment にする。
 * 文字列連結でHTMLを作らないため、本文に < や & が含まれても安全。
 *
 * terms は正規化済みの検索語配列。空なら素のテキストノードを返す。
 */
export function highlightFragment(text, terms) {
  const fragment = document.createDocumentFragment();
  const source = String(text ?? '');

  const needles = (Array.isArray(terms) ? terms : [])
    .map((t) => String(t ?? '').trim().toLowerCase())
    .filter((t) => t.length > 0)
    .sort((a, b) => b.length - a.length);

  if (needles.length === 0) {
    fragment.append(document.createTextNode(source));
    return fragment;
  }

  const lower = source.toLowerCase();
  let cursor = 0;

  while (cursor < source.length) {
    let hitIndex = -1;
    let hitLength = 0;

    needles.forEach((needle) => {
      const found = lower.indexOf(needle, cursor);
      if (found !== -1 && (hitIndex === -1 || found < hitIndex)) {
        hitIndex = found;
        hitLength = needle.length;
      }
    });

    if (hitIndex === -1) {
      fragment.append(document.createTextNode(source.slice(cursor)));
      break;
    }

    if (hitIndex > cursor) {
      fragment.append(document.createTextNode(source.slice(cursor, hitIndex)));
    }

    const mark = document.createElement('mark');
    mark.textContent = source.slice(hitIndex, hitIndex + hitLength);
    fragment.append(mark);

    cursor = hitIndex + hitLength;
  }

  return fragment;
}

/* ---------- 表示用フォーマッタ ---------- */

export function formatBytes(bytes) {
  const value = Number(bytes);

  if (!Number.isFinite(value) || value < 0) {
    return '—';
  }

  if (value < 1024) {
    return `${value} B`;
  }

  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = value / 1024;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  return `${size.toFixed(size >= 100 ? 0 : 1)} ${units[unitIndex]}`;
}

export function formatDateTime(value) {
  if (!value) {
    return '—';
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return '—';
  }

  const pad = (n) => String(n).padStart(2, '0');

  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num.toLocaleString('ja-JP') : '—';
}

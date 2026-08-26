/**
 * 通知をタップしたときに開く URL を決める（仕様書 §9）。純関数だけ。
 *
 * ==================================================================
 * ここが要件の中心である
 * ==================================================================
 * 「通知を1回タップすると URL が直接開く」ためには、通知を作る**前**に
 * 行き先が確定していなければならない。中間画面を挟んで選ばせるのは
 * 要件に反する。だから優先順位を固定し、必ず 1 本に決める
 * （最後は必ずアプリの URL に落ちるので、決まらないことが無い）。
 * ==================================================================
 *
 * ==================================================================
 * 「候補を捨てて次へ」であって「拒否して終わり」ではない
 * ==================================================================
 * 予定の説明に `javascript:` が書いてあったら、その候補を捨てて
 * **次の候補（location → htmlLink → アプリ）へ進む。** 通知そのものを
 * 止めてしまうと、悪意ある招待を 1 通受け取るだけで通知が消える。
 * ==================================================================
 */

import { MAX_EXTRACTED_URLS, MAX_URL_LENGTH } from './constants.mjs';

/** 制御文字（C0 と DEL）。URL に含まれてよいものは無い。 */
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;

/** `<a href="...">` の href。クォート有り・無しの両方を拾う。 */
const HREF_PATTERN = /<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s">]+))/gi;

/**
 * 素の本文に現れる URL。
 *
 * 文字クラスを **RFC 3986 が URL に許す ASCII だけ**に絞ってある。
 * 「空白以外なら通す」にすると、日本語の文中で
 * 「詳細（https://example.com/x）です」の `）です` まで URL に取り込まれ、
 * 開けない URL ができる（末尾の記号を落とすだけでは、その後ろの
 * 平仮名が残るので直らない）。
 *
 * 代償として、非 ASCII をそのまま含む URL（IRI）は途中で切れる。
 * Google Calendar / Meet が返す URL は percent-encoding 済みなので
 * 実害が無く、切れて開けないより「取りこぼす」ほうが安全側に倒れる。
 */
const BARE_URL_PATTERN = /https?:\/\/[A-Za-z0-9\-._~:\/?#\[\]@!$&()*+,;=%]+/gi;

/**
 * URL の末尾から落とす文字。
 *
 * 「詳細は https://example.com/a. をご覧ください」のような文で、
 * 句読点まで URL に取り込まれるのを防ぐ。全角の句読点は
 * BARE_URL_PATTERN の文字クラス（空白以外なら通る）に入ってしまうので、
 * ここでも落とす。
 */
const TRAILING_JUNK = /[).,>"'。、）］」』]+$/;

/** 名前付き実体参照のうち、説明文で実際に出会うもの。 */
const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  '#39': "'",
  nbsp: ' ',
};

/**
 * HTML 実体参照を戻す。
 *
 * Calendar の description は HTML で返ることがあり、クエリ文字列の `&` が
 * `&amp;` になっている。戻さないと Meet の URL がそのまま壊れる。
 */
export function decodeEntities(text) {
  return String(text ?? '').replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, name) => {
    const lower = String(name).toLowerCase();

    if (Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, lower)) {
      return NAMED_ENTITIES[lower];
    }

    if (lower.startsWith('#x')) {
      const code = Number.parseInt(lower.slice(2), 16);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : match;
    }

    if (lower.startsWith('#')) {
      const code = Number.parseInt(lower.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : match;
    }

    return match;
  });
}

/**
 * 開いてよい URL か（仕様書 §9）。
 *
 *   - new URL() で解釈できる（相対 URL は基準が無いので弾かれる）
 *   - protocol が http: / https: … javascript: data: ftp: mailto: を落とす
 *   - username / password が空 … `https://user:pass@evil/` の偽装を落とす
 *   - 2048 文字以下 … 通知の本文は 4KB 弱しか入らない
 *   - 制御文字を含まない … 改行を混ぜて表示を崩す小細工を落とす
 */
export function isAllowedUrl(text) {
  const value = String(text ?? '').trim();

  if (value === '' || value.length > MAX_URL_LENGTH) {
    return false;
  }

  if (CONTROL_CHARS.test(value)) {
    return false;
  }

  let url;

  try {
    url = new URL(value);
  } catch {
    return false;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return false;
  }

  if (url.username !== '' || url.password !== '') {
    return false;
  }

  return true;
}

/** 末尾の句読点や閉じ括弧を落とす。 */
function trimTrailing(value) {
  let out = String(value).trim();

  for (let i = 0; i < 5; i += 1) {
    const next = out.replace(TRAILING_JUNK, '');

    if (next === out) {
      break;
    }

    out = next;
  }

  return out;
}

/**
 * 文章から URL を順に拾う（仕様書 §9）。
 *
 * 順序に意味がある。**href を先に見る。** 説明が HTML のとき、
 * 表示文字列（「会議に参加」）とリンク先は別物であり、利用者が
 * 押すつもりでいるのは href のほう。タグを除去してから本文を
 * 探すだけだと、href しか URL が無い説明から 1 本も拾えない。
 *
 * 重複は先に出たほうを残す。返すのは最大 MAX_EXTRACTED_URLS 本。
 */
export function extractUrls(text) {
  const source = String(text ?? '');

  if (source === '') {
    return [];
  }

  const found = [];
  const seen = new Set();

  const push = (candidate) => {
    const url = trimTrailing(decodeEntities(candidate));

    if (!isAllowedUrl(url) || seen.has(url)) {
      return;
    }

    seen.add(url);
    found.push(url);
  };

  HREF_PATTERN.lastIndex = 0;

  for (let match = HREF_PATTERN.exec(source); match !== null; match = HREF_PATTERN.exec(source)) {
    push(match[1] ?? match[2] ?? match[3] ?? '');
  }

  /* タグを空白へ置き換える（詰めると隣の語とくっついて URL が伸びる）。 */
  const plain = decodeEntities(source.replace(/<[^>]*>/g, ' '));

  BARE_URL_PATTERN.lastIndex = 0;

  for (let match = BARE_URL_PATTERN.exec(plain); match !== null; match = BARE_URL_PATTERN.exec(plain)) {
    push(match[0]);
  }

  return found.slice(0, MAX_EXTRACTED_URLS);
}

/**
 * 開く URL を 1 本に決める（仕様書 §9 の優先順位）。
 *
 * 0. overrideUrl（利用者が予定ごとに手動指定した行き先）… **最優先**。
 *    http/https（isAllowedUrl）を満たすときだけ採り、source は 'custom'。
 *    利用者が明示した意図なので自動抽出より優先する。無効・未指定なら無視して
 *    従来の優先順位へ落ちる（javascript: 等を入れられても通知は止めない）。
 * 1. conference（Meet 等）… 会議に入るのが目的なので最優先
 * 2. description 内の最初の URL … 主催者が書いた行き先
 * 3. location が URL … 会議室名のこともあるので URL のときだけ
 * 4. htmlLink … 少なくとも予定は開ける
 * 5. appUrl … ここまで全滅することは無い（htmlLink は必ず来る）が、
 *    「開く先が無い通知」を作らないための最後の受け皿
 */
export function resolveOpenUrl(event, { appUrl, overrideUrl } = {}) {
  if (isAllowedUrl(overrideUrl)) {
    return { url: String(overrideUrl).trim(), source: 'custom' };
  }

  const candidates = [
    ['conference', event?.conferenceUrl],
    ...(Array.isArray(event?.urls) ? event.urls.map((url) => ['description', url]) : []),
    ['location', event?.location],
    ['calendar', event?.htmlLink],
  ];

  for (const [source, candidate] of candidates) {
    if (isAllowedUrl(candidate)) {
      return { url: String(candidate).trim(), source };
    }
  }

  return { url: appUrl, source: 'app' };
}

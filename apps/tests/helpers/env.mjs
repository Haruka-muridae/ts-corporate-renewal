/*
 * Node 上でブラウザの最小環境を再現する。
 *
 * /apps/shared/ のモジュールは localStorage / sessionStorage /
 * document / location を触るため、import する前にこれらを用意する。
 *
 * 本物のブラウザではないので、ここで通ったことは
 * 「ロジックが正しい」ことしか示さない。
 * 実際の描画・遷移は tests/browser/ で確認する。
 */

import { pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/*
 * /apps/shared/ 配下のモジュールURLを組み立てる。
 * 絶対パスを直書きしないこと（別の環境で動かなくなる）。
 */
export function sharedUrl(relativePath) {
  return pathToFileURL(resolve(here, '../../shared', relativePath)).href;
}

/* 同じモジュールを別インスタンスとして読み込む（状態を分離したいとき）。 */
export function freshSharedUrl(relativePath, tag) {
  return `${sharedUrl(relativePath)}?fresh=${encodeURIComponent(tag)}`;
}

export function createStorage() {
  const map = new Map();

  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear(),
    key: (i) => [...map.keys()][i] ?? null,
    get length() { return map.size; },
    dump: () => Object.fromEntries(map),
  };
}

/*
 * ブラウザ環境を組み立てる。
 *
 * 戻り値:
 *   localStorage / sessionStorage … dump() で中身を覗ける
 *   redirects   … location.replace() の記録（実際には遷移しない）
 *   warnings    … console.warn の記録
 *   docEvents   … document 側の EventTarget
 *   winEvents   … window 側の EventTarget（pageshow / storage 用）
 */
export function installBrowserEnv({
  href = 'https://tsam-ai.com/apps/home/',
  captureWarnings = true,
} = {}) {
  const url = new URL(href);

  const localStorage = createStorage();
  const sessionStorage = createStorage();
  const redirects = [];
  const warnings = [];

  const docEvents = new EventTarget();
  const winEvents = new EventTarget();

  globalThis.localStorage = localStorage;
  globalThis.sessionStorage = sessionStorage;

  globalThis.document = {
    readyState: 'complete',
    addEventListener: (...a) => docEvents.addEventListener(...a),
    removeEventListener: (...a) => docEvents.removeEventListener(...a),
    dispatchEvent: (e) => docEvents.dispatchEvent(e),
  };

  globalThis.addEventListener = (...a) => winEvents.addEventListener(...a);
  globalThis.removeEventListener = (...a) => winEvents.removeEventListener(...a);

  globalThis.location = {
    href: url.href,
    pathname: url.pathname,
    origin: url.origin,
    search: url.search,
    replace(target) { redirects.push(target); },
    assign(target) { redirects.push(target); },
  };

  if (captureWarnings) {
    /* ダミー認証の警告は仕様どおり出るため、標準出力を汚さず記録だけする。 */
    console.warn = (...args) => { warnings.push(args.join(' ')); };
  }

  return { localStorage, sessionStorage, redirects, warnings, docEvents, winEvents };
}

/* pageshow / storage をブラウザと同じ形で発火させる。 */
export function fireWindowEvent(winEvents, type, props = {}) {
  winEvents.dispatchEvent(Object.assign(new Event(type), props));
}

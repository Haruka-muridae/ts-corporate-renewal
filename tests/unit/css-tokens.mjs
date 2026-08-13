/*
 * 共通CSSのカスタムプロパティが、読み込み経路の中で解決できること。
 *
 * ==================================================================
 * なぜこのテストがあるか（2026-08-13 の障害）
 * ==================================================================
 * public/auth/auth.css は --c-main / --radius-button / --font-en などを
 * 参照するが、それらを定義しているのは public/css/style.css だけだった。
 * 認証系24ページは style.css も読むので気づかれなかった一方、
 * /production-app/ の receipt-ocr と voice-recorder は auth.css と自前の
 * style.css しか読まない。この2つでは --c-main が未定義になり、
 * .auth-button が「背景 transparent ＋ 文字 #ffffff」＝ 白地に白文字で
 * 見えないボタンになった。
 *
 * CSS の未定義変数は無視されるだけでエラーにならないため、この種の穴は
 * 実際に画面を見るまで分からない。そこで「auth.css が参照する変数は、
 * auth.css と @import 先だけで全部定義済み」を機械的に確かめる。
 *
 * ==================================================================
 * 特に確かめること
 * ==================================================================
 *   - auth.css の var(--x) が、auth.css ＋ @import の閉包の中で解決できる
 *   - auth.css で二重に宣言したトークンの値が style.css と一致している
 *     （style.css も読むページで見た目が変わらないこと）
 *   - style.css が @media で幅ごとに切り替えるトークンを、auth.css が
 *     後から素の :root で宣言していない（後勝ちで潰してしまう）
 *   - auth.css を読む各HTMLで、参照される変数がどこかで定義されている
 * ==================================================================
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { check, section, finish, fatal } from '../../public/apps/tests/helpers/assert.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, '../..');
const PUBLIC_DIR = resolve(REPO_ROOT, 'public');

const AUTH_CSS = resolve(PUBLIC_DIR, 'auth/auth.css');
const STYLE_CSS = resolve(PUBLIC_DIR, 'css/style.css');

/* ---------------------------------------------------------------- */
/* CSS の最小限の読み取り                                            */
/* ---------------------------------------------------------------- */

/*
 * コメントを落とす。
 * コメント内の例示（var(--x) と書いた説明文など）を宣言や参照として
 * 拾ってしまうと、コメントを直すだけでテストが動くことになる。
 */
function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, ' ');
}

/*
 * 宣言（--name: value）を拾う。
 * 直前が `{` `;` `}` のいずれかであることを条件にして、
 * var(--a, --b) の中の名前を宣言と誤認しないようにする。
 */
function declarations(css) {
  const out = [];
  const re = /(?:^|[{;}])\s*(--[\w-]+)\s*:\s*([^;{}]*)/g;
  let m;
  while ((m = re.exec(css)) !== null) {
    out.push({ name: m[1], value: m[2].trim().replace(/\s+/g, ' ') });
  }
  return out;
}

/*
 * var() 参照のうち、代替値を持たないものだけを拾う。
 *
 * var(--i, 0) のように第2引数がある参照は、変数が無くても宣言が壊れない。
 * 「未定義でも成り立つ」と書き手が明示している形なので、欠落として
 * 数えると style.css の既存の書き方（一覧の遅延計算など）を誤検出する。
 */
function references(css) {
  const out = new Set();
  const re = /var\(\s*(--[\w-]+)\s*([,)])/g;
  let m;
  while ((m = re.exec(css)) !== null) {
    if (m[2] === ')') out.add(m[1]);
  }
  return out;
}

/* @import url("...") の相対解決。auth.css → theme.css を辿るために使う。 */
function imports(css, fromFile) {
  const out = [];
  const re = /@import\s+url\(\s*["']?([^"')]+)["']?\s*\)/g;
  let m;
  while ((m = re.exec(css)) !== null) {
    const href = m[1].trim();
    if (/^(?:https?:)?\/\//.test(href)) continue;
    out.push(resolve(dirname(fromFile), href));
  }
  return out;
}

/* ファイルと @import 先を、読み込まれる順に並べたリスト。 */
function importClosure(entryFile, seen = new Set()) {
  const abs = resolve(entryFile);
  if (seen.has(abs)) return [];
  seen.add(abs);

  const css = stripComments(readFileSync(abs, 'utf8'));
  const files = [];
  for (const target of imports(css, abs)) {
    files.push(...importClosure(target, seen));
  }
  files.push({ file: abs, css });
  return files;
}

/* @media ブロックの中身だけを取り出す（波括弧の対応を数える）。 */
function mediaBlockBodies(css) {
  const out = [];
  const re = /@media[^{]*\{/g;
  let m;
  while ((m = re.exec(css)) !== null) {
    let depth = 1;
    let i = m.index + m[0].length;
    while (i < css.length && depth > 0) {
      if (css[i] === '{') depth += 1;
      else if (css[i] === '}') depth -= 1;
      i += 1;
    }
    out.push(css.slice(m.index + m[0].length, Math.max(i - 1, 0)));
    re.lastIndex = i;
  }
  return out;
}

function listHtmlFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    /* node_modules 相当の巨大ディレクトリは public/ 配下に無いが、念のため。 */
    if (entry === 'node_modules') continue;
    const full = resolve(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listHtmlFiles(full));
    else if (entry.endsWith('.html')) out.push(full);
  }
  return out;
}

/* HTML が読む <link rel="stylesheet"> を、書かれた順にファイルパスで返す。 */
function linkedStylesheets(htmlFile) {
  const html = readFileSync(htmlFile, 'utf8');
  const out = [];
  const re = /<link\b[^>]*>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const tag = m[0];
    if (!/rel\s*=\s*["']?stylesheet/i.test(tag)) continue;
    const href = tag.match(/href\s*=\s*["']([^"']+)["']/i)?.[1];
    if (!href) continue;
    if (/^(?:https?:)?\/\//.test(href)) continue;
    out.push(resolve(dirname(htmlFile), href));
  }
  return out;
}

const shortPath = (file) => relative(REPO_ROOT, file).replace(/\\/g, '/');

try {
  /* ---------------------------------------------------------------- */
  section('auth.css は自分が使うトークンを自分で解決できる');
  /* ---------------------------------------------------------------- */

  const authClosure = importClosure(AUTH_CSS);

  check(
    'auth.css は theme.css を @import している',
    authClosure.some((entry) => entry.file === resolve(PUBLIC_DIR, 'css/theme.css')),
    authClosure.map((e) => shortPath(e.file)).join(' -> '),
  );

  const definedInClosure = new Set();
  for (const entry of authClosure) {
    for (const decl of declarations(entry.css)) definedInClosure.add(decl.name);
  }

  const authRefs = references(stripComments(readFileSync(AUTH_CSS, 'utf8')));
  const missing = [...authRefs].filter((name) => !definedInClosure.has(name)).sort();

  check(
    'auth.css の var() 参照はすべて auth.css ＋ @import 先で定義済み'
    + `（参照 ${authRefs.size} 種）`,
    missing.length === 0,
    missing.length === 0 ? '' : `未定義: ${missing.join(', ')}`,
  );

  /* ---------------------------------------------------------------- */
  section('二重定義でも style.css と同じ値になる');
  /* ---------------------------------------------------------------- */

  /*
   * auth.css は style.css より後に読まれるため、同名を宣言すると
   * auth.css 側が勝つ。右辺が食い違うと、認証系24ページの見た目だけが
   * 静かに変わる。ここで一致を縛る。
   */
  const styleCss = stripComments(readFileSync(STYLE_CSS, 'utf8'));
  const styleDecls = declarations(styleCss);
  const styleTop = new Map();
  for (const decl of styleDecls) {
    if (!styleTop.has(decl.name)) styleTop.set(decl.name, decl.value);
  }

  const authOwnDecls = declarations(stripComments(readFileSync(AUTH_CSS, 'utf8')));

  const mismatched = authOwnDecls
    .filter((decl) => styleTop.has(decl.name) && styleTop.get(decl.name) !== decl.value)
    .map((decl) => `${decl.name}: ${decl.value} ≠ ${styleTop.get(decl.name)}`);

  check(
    'auth.css で宣言するトークンの右辺は css/style.css と同一',
    mismatched.length === 0,
    mismatched.join(' / '),
  );

  /* 幅ごとに切り替わるトークンを後から素の :root で潰していないこと。 */
  const mediaOverridden = new Set();
  for (const body of mediaBlockBodies(styleCss)) {
    for (const decl of declarations(body)) mediaOverridden.add(decl.name);
  }

  check(
    'style.css が @media で切り替えるトークンを auth.css は宣言していない',
    authOwnDecls.every((decl) => !mediaOverridden.has(decl.name)),
    `@media 側: ${[...mediaOverridden].sort().join(', ')}`,
  );

  /* ---------------------------------------------------------------- */
  section('auth.css を読む各ページで解決できる');
  /* ---------------------------------------------------------------- */

  /*
   * 閉包が足りていれば理屈の上では十分だが、ページ単位でも見ておく。
   * 各アプリが自前の style.css を auth.css より後ろに置いて同名の
   * トークンを再定義しても、auth.css の参照が解決できる状態を保つ。
   *
   * 対象は auth.css が参照する変数だけに絞る。ページ上の全CSSを対象に
   * すると、そのページに存在しない要素向けの規則や、HTMLの style 属性で
   * 要素側に入れる変数（--point-index など）まで欠落として数えてしまう。
   */
  const pages = listHtmlFiles(PUBLIC_DIR)
    .filter((file) => linkedStylesheets(file).some((css) => css === AUTH_CSS));

  check('auth.css を読むページを検出できている', pages.length >= 20, `${pages.length} ページ`);

  const brokenPages = [];
  for (const page of pages) {
    const defined = new Set();

    for (const sheet of linkedStylesheets(page)) {
      for (const entry of importClosure(sheet)) {
        for (const decl of declarations(entry.css)) defined.add(decl.name);
      }
    }

    const gaps = [...authRefs].filter((name) => !defined.has(name)).sort();
    if (gaps.length > 0) brokenPages.push(`${shortPath(page)}: ${gaps.join(', ')}`);
  }

  check(
    'auth.css を読むどのページでも、その参照が解決できる',
    brokenPages.length === 0,
    brokenPages.join(' | '),
  );

  /* ---------------------------------------------------------------- */
  section('回帰: 障害そのものの再現条件');
  /* ---------------------------------------------------------------- */

  /*
   * 白地に白文字を作っていた組み合わせ。.auth-button は
   * background-color: var(--c-main) と color: var(--color-white) を持つ。
   * style.css を読まないページでも両方が解決できることを名指しで見る。
   */
  for (const app of ['receipt-ocr', 'voice-recorder', 'audio-transcriber', 'meeting-minutes']) {
    const page = resolve(PUBLIC_DIR, 'production-app', app, 'index.html');
    const defined = new Set();
    for (const sheet of linkedStylesheets(page)) {
      for (const entry of importClosure(sheet)) {
        for (const decl of declarations(entry.css)) defined.add(decl.name);
      }
    }

    check(
      `${app}: .auth-button の背景・文字・枠線のトークンが揃っている`,
      ['--c-main', '--c-main-dark', '--color-white', '--radius-button']
        .every((name) => defined.has(name)),
      ['--c-main', '--c-main-dark', '--color-white', '--radius-button']
        .filter((name) => !defined.has(name)).join(', '),
    );
  }
} catch (error) {
  fatal(error);
}

finish();

/*
 * 配信ベースパスと遷移先URLの検査。
 * GitHub Pages のサブパス配信と、オープンリダイレクトを重点的に見る。
 */

import { check, section, finish, fatal } from '../helpers/assert.mjs';
import { sharedUrl } from '../helpers/env.mjs';

/* 絶対パスを書かない。リポジトリのどこへ置いても動くようにする。 */
const url = (name) => sharedUrl(name);


globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.sessionStorage = globalThis.localStorage;

const paths = await import(url('app-paths.js'));

/* 検証する配信形態。 */
const DEPLOYMENTS = [
  ['独自ドメイン', 'https://tsam-ai.com/apps/', 'https://tsam-ai.com/apps/login/'],
  ['プロジェクトPages', 'https://user.github.io/ts-corporate-renewal/apps/', 'https://user.github.io/ts-corporate-renewal/apps/login/'],
  ['リポジトリ名がapps', 'https://user.github.io/apps/apps/', 'https://user.github.io/apps/apps/login/'],
  ['localhost', 'http://localhost:8000/apps/', 'http://localhost:8000/apps/login/'],
  ['末尾スラッシュ無し', 'https://tsam-ai.com/apps/', 'https://tsam-ai.com/apps/login'],
  ['index.html明示', 'https://tsam-ai.com/apps/', 'https://tsam-ai.com/apps/login/index.html'],
  ['クエリ付き', 'https://tsam-ai.com/apps/', 'https://tsam-ai.com/apps/login/?next=../home/'],
  ['ハッシュ付き', 'https://tsam-ai.com/apps/', 'https://tsam-ai.com/apps/login/#x'],
];

section("1. ベースパスの解決");
for (const [label, expected, href] of DEPLOYMENTS) {
  /* 末尾スラッシュ無しのケースは login がファイル扱いになるため除外する。 */
  if (label === '末尾スラッシュ無し') {
    check(`${label}（/apps/ を含めば解決できる）`, paths.getAppBaseUrl(href) === expected,
      paths.getAppBaseUrl(href));
    continue;
  }
  check(label, paths.getAppBaseUrl(href) === expected, paths.getAppBaseUrl(href));
}
check('/apps/ 外はディレクトリを基底にする',
  paths.getAppBaseUrl('https://tsam-ai.com/other/page.html') === 'https://tsam-ai.com/other/');
check('不正な入力は null', paths.getAppBaseUrl('not a url') === null);
check('未指定は null', paths.getAppBaseUrl(null) === null);

section("2. コールバックURLの組み立て");
for (const [label, base, href] of DEPLOYMENTS) {
  const resolved = paths.resolveAppUrl('auth-callback/', href);
  check(`${label}: ${base}auth-callback/`, resolved === `${base}auth-callback/`, resolved);
}

section("3. オープンリダイレクト（外部オリジンへ出ないこと）");

/*
 * バックスラッシュは WHATWG URL 解析でスラッシュへ正規化される。
 * 文字列の見た目だけで判定すると外部オリジンへ飛ばされる。
 */
const EXTERNAL_ATTACKS = [
  ['単一バックスラッシュ', '\u005Cevil.example.com'],
  ['二重バックスラッシュ', '\u005C\u005Cevil.example.com'],
  ['三重バックスラッシュ', '\u005C\u005C\u005Cevil.example.com'],
  ['バックスラッシュ+スラッシュ', '\u005C/evil.example.com'],
  ['スラッシュ+バックスラッシュ', '/\u005Cevil.example.com'],
  ['バックスラッシュ+@', '\u005C\u005Cevil.example.com\u005C@tsam-ai.com'],
  ['プロトコル相対', '//evil.example.com'],
  ['絶対URL', 'https://evil.example.com/'],
  ['scheme+エンコード', 'https:%2f%2fevil.example.com'],
  ['javascript:', 'javascript:alert(1)'],
  ['大文字javascript:', 'JaVaScRiPt:alert(1)'],
  ['タブ難読化', 'java\u0009script:alert(1)'],
  ['改行難読化', 'java\u000Ascript:alert(1)'],
  ['NUL難読化', 'java\u0000script:alert(1)'],
  ['data:', 'data:text/html,<script>alert(1)</script>'],
  ['vbscript:', 'vbscript:msgbox(1)'],
  ['file:', 'file:///etc/passwd'],
  ['全角空白+//', '\u3000//evil.example.com'],
  ['BOM+//', '\uFEFF//evil.example.com'],
  ['LINE SEPARATOR+//', '\u2028//evil.example.com'],
  ['NBSP+//', '\u00A0//evil.example.com'],
  ['サイト内絶対パス', '/apps/home/'],
  ['サイト内絶対+%5c', '/%5cevil.example.com'],
  ['長すぎる値', `${'a'.repeat(600)}/`],
];

let externalLeaks = 0;

for (const [label, base, href] of DEPLOYMENTS) {
  let leaked = 0;

  for (const [, attack] of EXTERNAL_ATTACKS) {
    const out = paths.safeNextUrl(attack, null, { href, appBase: base });

    if (out === null) {
      continue;
    }

    try {
      const resolved = new URL(out, href);
      if (resolved.origin !== new URL(base).origin) {
        leaked += 1;
      }
    } catch {
      /* 解析できない＝遷移できない。 */
    }
  }

  externalLeaks += leaked;
  check(`${label}: ${EXTERNAL_ATTACKS.length}件すべて外部へ出ない`, leaked === 0, `${leaked}件流出`);
}

/* 個別にも記録しておく（どのケースが効いているか分かるように）。 */
const HOME = 'https://tsam-ai.com/apps/';
const LOGIN = 'https://tsam-ai.com/apps/login/';
for (const [label, attack] of EXTERNAL_ATTACKS) {
  check(`拒否: ${label}`, paths.safeNextUrl(attack, null, { href: LOGIN, appBase: HOME }) === null,
    JSON.stringify(paths.safeNextUrl(attack, null, { href: LOGIN, appBase: HOME })));
}

section("4. /apps/ の外へ出ないこと");
const ESCAPES = [
  ['親をたどる', '../../../evil.html'],
  ['サイトルートへ', '../../index.html'],
  ['深い親参照', '../../../../../../etc/passwd'],
];
for (const [label, attack] of ESCAPES) {
  check(`拒否: ${label}`, paths.safeNextUrl(attack, null, { href: LOGIN, appBase: HOME }) === null,
    JSON.stringify(paths.safeNextUrl(attack, null, { href: LOGIN, appBase: HOME })));
}

section("5. 正常な遷移先は通ること");
const ALLOWED = [
  ['ホーム', '../home/'],
  ['アカウント', '../account/'],
  ['同階層', './x'],
  ['クエリ付き', '../home/?a=1'],
  ['アプリ一覧', '../index.html'],
  ['サブディレクトリ', '../voice-recorder/'],
];
for (const [label, value] of ALLOWED) {
  for (const [dep, base, href] of DEPLOYMENTS) {
    const out = paths.safeNextUrl(value, null, { href, appBase: base });
    check(`${label} @ ${dep}`, out === value, `${out}`);
  }
}

section("6. fallback の扱い");
check('拒否時は fallback を返す',
  paths.safeNextUrl('https://evil.example.com/', '../home/', { href: LOGIN, appBase: HOME }) === '../home/');
check('空文字も fallback',
  paths.safeNextUrl('', '../home/', { href: LOGIN, appBase: HOME }) === '../home/');
check('null も fallback',
  paths.safeNextUrl(null, '../home/', { href: LOGIN, appBase: HOME }) === '../home/');

section("7. currentPageAsNext");
check('home から', paths.currentPageAsNext('https://tsam-ai.com/apps/home/') === '../home/');
check('account から', paths.currentPageAsNext('https://tsam-ai.com/apps/account/') === '../account/');
check('index.html を落とす',
  paths.currentPageAsNext('https://tsam-ai.com/apps/home/index.html') === '../home/');
check('プロジェクトPages でも同じ',
  paths.currentPageAsNext('https://user.github.io/repo/apps/home/') === '../home/');
check('クエリを保つ',
  paths.currentPageAsNext('https://tsam-ai.com/apps/home/?a=1') === '../home/?a=1');
check('/apps/ 直下は null', paths.currentPageAsNext('https://tsam-ai.com/apps/') === null);
/* 生成した値が、そのまま safeNextUrl を通ること（往復の整合） */
for (const [dep, base, href] of DEPLOYMENTS) {
  const page = `${base}account/`;
  const next = paths.currentPageAsNext(page);
  const accepted = paths.safeNextUrl(next, null, { href: `${base}login/`, appBase: base });
  check(`往復の整合 @ ${dep}`, accepted === next, `${next} -> ${accepted}`);
}

finish();

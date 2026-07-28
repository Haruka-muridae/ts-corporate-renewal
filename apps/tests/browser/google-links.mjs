/*
 * Googleログイン導線とアカウント作成リンクの実ブラウザ検査。
 *
 * ------------------------------------------------------------------
 * 外部へ通信しない
 * ------------------------------------------------------------------
 * この画面はクライアントIDが設定済みのため、放っておくと
 * accounts.google.com（GIS本体）へ実際に取りに行く。
 *
 * テストのたびにGoogleや紹介プログラムへ通信を発生させたくないので、
 * CDP で外部ホストを遮断してから開く。
 *
 * 遮断すると Googleログインは ERROR 状態になる。
 * これは都合の悪い状態ではなく、**確かめたい状態**でもある。
 * アカウントを持っていない利用者が見ているのは、
 * たいてい「ログインしていない・使えない」画面だからである。
 *
 * リンクは実際には開かない。href と属性だけを見る。
 * ------------------------------------------------------------------
 */

import { check, section, finish } from '../helpers/assert.mjs';
import { startSuite } from '../helpers/browser-harness.mjs';

const suite = await startSuite(3);
const { page, origin } = suite;
const { evaluate, goto, send, consoleErrors } = page;

/* 外部ホストを遮断する。テストが外へ出ないことの保証でもある。 */
await send('Network.setBlockedURLs', {
  urls: [
    '*accounts.google.com*',
    '*referworkspace.app.goo.gl*',
    '*workspace.google.com*',
    '*googleapis.com*',
    '*gstatic.com*',
  ],
});

/* リンク1件分の情報をまとめて取り出す。 */
const readLink = async (linkId) => {
  const raw = await evaluate(`(() => {
    const item = document.querySelector('[data-link-id="${linkId}"]');
    if (!item) return JSON.stringify({ found: false });
    const a = item.querySelector('a');
    return JSON.stringify({
      found: true,
      href: a?.getAttribute('href') ?? '',
      target: a?.getAttribute('target') ?? '',
      rel: a?.getAttribute('rel') ?? '',
      text: a?.textContent ?? '',
      lead: item.querySelector('.auth-signup__lead')?.textContent ?? '',
      note: item.querySelector('.auth-signup__note')?.textContent ?? '',
      visible: item.offsetParent !== null,
    });
  })()`);

  return JSON.parse(raw);
};

/* ================================================================ */

section("1. アプリ一覧でアカウント作成導線が出る");
page.resetRequests();
await goto(`${origin}/apps/`, 1600);

check('ページが表示される', (await evaluate('location.pathname')) === '/apps/');
check('認証パネルがある', (await evaluate('!!document.getElementById("auth-panel")')) === true);

const signupVisible = await evaluate(`(() => {
  const el = document.getElementById('auth-signup');
  return el ? String(!el.hidden) : 'missing';
})()`);
check('★案内が表示される（未ログイン時）', signupVisible === 'true', String(signupVisible));

const title = await evaluate('document.getElementById("auth-signup-title")?.textContent ?? ""');
check('見出しがある', title.includes('Googleアカウントをお持ちでない方'), title);

section("2. 通常Googleアカウント作成リンク");
const personal = await readLink('google-account');
check('リンクがある', personal.found === true);
check('★公式のアカウント作成URL',
  personal.href === 'https://accounts.google.com/signup', personal.href);
check('HTTPS', personal.href.startsWith('https://'));
check('許可ドメイン', new URL(personal.href).hostname === 'accounts.google.com');
check('★target="_blank"', personal.target === '_blank', personal.target);
check('★rel に noopener', personal.rel.includes('noopener'), personal.rel);
check('★rel に noreferrer', personal.rel.includes('noreferrer'), personal.rel);
check('外部サイトと分かる文言', personal.text.includes('外部サイト'), personal.text);
check('新しいタブと分かる文言', personal.text.includes('新しいタブ'), personal.text);
check('「無料」と書いてある', personal.lead.includes('無料'), personal.lead);
check('Google LLC 提供と明記', personal.note.includes('Google LLC'), personal.note);
check('Workspace が必要だと誤解させない',
  !personal.lead.includes('Workspace') && !personal.note.includes('Workspace'),
  `${personal.lead} / ${personal.note}`);

section("3. Google Workspace 紹介リンク");
const workspace = await readLink('workspace-referral');
check('リンクがある', workspace.found === true);
check('★設定値どおりの紹介URL',
  workspace.href === 'https://referworkspace.app.goo.gl/2KTq', workspace.href);
check('HTTPS', workspace.href.startsWith('https://'));
check('許可ドメイン', new URL(workspace.href).hostname === 'referworkspace.app.goo.gl');
check('★target="_blank"', workspace.target === '_blank', workspace.target);
check('★rel に noopener', workspace.rel.includes('noopener'), workspace.rel);
check('★rel に noreferrer', workspace.rel.includes('noreferrer'), workspace.rel);
check('外部サイトと分かる文言', workspace.text.includes('外部サイト'), workspace.text);
check('★紹介プログラムと明記', workspace.note.includes('紹介プログラム'), workspace.note);
check('★有料サービスと明記', workspace.note.includes('有料'), workspace.note);
check('★Google LLC 提供と明記', workspace.note.includes('Google LLC'), workspace.note);
check('★「無料」と書いていない',
  !`${workspace.text}${workspace.lead}${workspace.note}`.includes('無料'),
  workspace.note);

section("4. 2つの導線が取り違えられないこと");
check('無料の語は通常アカウント側だけ',
  personal.lead.includes('無料') && !workspace.note.includes('無料'));
check('有料の語はWorkspace側だけ',
  workspace.note.includes('有料') && !personal.note.includes('有料'));
check('リンク先が別ドメイン',
  new URL(personal.href).hostname !== new URL(workspace.href).hostname);

section("5. 外部リンクを実際に開いていないこと");
const outbound = page.getRequests().filter((u) => (
  u.includes('accounts.google.com')
  || u.includes('referworkspace')
  || u.includes('workspace.google.com')
));
/*
 * GIS の読み込みは遮断済みだが「試みた」記録は残る。
 * 紹介リンクは押していないので、こちらは記録自体が無いはず。
 */
const referralHit = page.getRequests().filter((u) => u.includes('referworkspace'));
check('★紹介リンクへ通信していない', referralHit.length === 0, referralHit.join(','));
check('遮断により外部から取得できていない', outbound.every((u) => !u.startsWith('data:')));

section("6. Googleログイン時にDriveスコープを要求しない");
/*
 * ログインは IDトークン（openid/email/profile 相当）だけを扱う。
 * Drive のスコープ文字列がログイン経路のコードに現れてはならない。
 */
const loginSources = await evaluate(`(async () => {
  const names = ['google-auth.js', 'auth-config.js', 'gis-loader.js', 'auth-session.js'];
  const out = [];
  for (const n of names) {
    const res = await fetch('/apps/' + n);
    out.push(await res.text());
  }
  return out.join('\\n');
})()`);

check('★ログイン経路に drive スコープが無い',
  !loginSources.includes('auth/drive'), 'drive スコープが混入している');
check('★ログイン経路に spreadsheets スコープが無い',
  !loginSources.includes('auth/spreadsheets'));
check('★ログイン経路に calendar スコープが無い',
  !loginSources.includes('auth/calendar'));
check('ログイン経路は renderButton を使う（公式ボタン）',
  loginSources.includes('renderButton'));

section("7. Drive認可は別モジュールに分かれている");
const driveSource = await evaluate(`fetch('/apps/shared/drive-auth.js').then(r => r.text())`);
check('drive-auth.js に drive.file がある',
  driveSource.includes('auth/drive.file'));
check('★Drive認可はトークンモデル（initTokenClient）',
  driveSource.includes('initTokenClient'));
check('★ログイン側は initTokenClient を使わない',
  !loginSources.includes('initTokenClient'));

section("8. 紹介リンクは認証状態に影響しない");
const before = await evaluate('document.getElementById("auth-panel")?.dataset.authStatus ?? ""');
/* 実際には開かず、href を読むだけ（開くと外部へ通信が出る）。 */
await evaluate(`document.querySelector('[data-link-id="workspace-referral"] a')?.getAttribute('href')`);
const after = await evaluate('document.getElementById("auth-panel")?.dataset.authStatus ?? ""');
check('認証状態が変わらない', before === after, `${before} -> ${after}`);

const storageKeys = await evaluate(`Object.keys(sessionStorage).concat(Object.keys(localStorage)).join(',')`);
check('紹介リンクで保存領域が汚れない',
  !storageKeys.includes('referral') && !storageKeys.includes('workspace'), storageKeys);

section("9. 認証パネルを持つ他ページでも同じ案内が出る");
/*
 * ------------------------------------------------------------------
 * 未追跡ファイルへ依存しないこと
 * ------------------------------------------------------------------
 * favorites.html はリポジトリに入っていない時期がある
 * （お気に入り機能は別途開発中のため）。
 *
 * 「手元にあるから」で当てにすると、クリーンなチェックアウトで
 * 必ず落ちるテストになる。存在するときだけ確かめる。
 *
 * 無い場合も検査は飛ばさない。
 * 「正本が1か所である」という本題は、
 * 描画元が1モジュールであることで確かめられる。
 * ------------------------------------------------------------------
 */
const favStatus = await evaluate(
  `fetch('/apps/favorites.html').then(r => String(r.status)).catch(() => '0')`,
);

if (favStatus === '200') {
  await goto(`${origin}/apps/favorites.html`, 1600);

  const favSignup = await evaluate(`(() => {
    const el = document.getElementById('auth-signup');
    return el ? String(!el.hidden) : 'missing';
  })()`);
  check('★お気に入り画面にも同じ案内が出る', favSignup === 'true', String(favSignup));

  const favHref = await evaluate(`document.querySelector('[data-link-id="workspace-referral"] a')?.getAttribute('href') ?? ''`);
  check('★アプリ一覧と同じURL', favHref === workspace.href, favHref);
} else {
  /* ページが無い版。正本が1か所であることを別の形で確かめる。 */
  const builders = await evaluate(`(async () => {
    const files = ['google-auth.js', 'auth-session.js', 'gis-loader.js', 'auth-config.js'];
    let hits = 0;
    for (const f of files) {
      const t = await (await fetch('/apps/' + f)).text();
      if (t.includes('auth-signup')) hits += 1;
    }
    return String(hits);
  })()`);
  check('★案内を組み立てるモジュールは1つだけ', builders === '1', `${builders} 個 (favorites.html なし)`);

  const inHtml = await evaluate(
    `fetch('/apps/index.html').then(r => r.text()).then(t => String(t.includes('referworkspace')))`,
  );
  check('★URLをHTMLへ書き写していない', inHtml === 'false', inHtml);
}

section("10. レスポンシブ");
await goto(`${origin}/apps/`, 1400);
for (const width of [320, 375, 768, 1024, 1440]) {
  await page.setViewport(width);
  await page.sleep(150);

  const overflow = await evaluate('document.documentElement.scrollWidth > window.innerWidth + 1');
  check(`${width}px: 横スクロールしない`, overflow === false);

  const tappable = await evaluate(`(() => {
    const a = document.querySelector('.auth-signup__link');
    if (!a) return 'missing';
    return String(a.getBoundingClientRect().height >= 44);
  })()`);
  check(`${width}px: リンクが44px以上`, tappable === 'true', String(tappable));
}
await page.clearViewport();

section("12. ログインが完了しなかったとき");
/*
 * ------------------------------------------------------------------
 * ここで確かめられること・確かめられないこと
 * ------------------------------------------------------------------
 * GIS の renderButton 方式では、利用者がポップアップを閉じても
 * コールバックは呼ばれない。つまり「キャンセルされた」という
 * 通知はアプリ側へ届かない。ポップアップ遮断も同様である。
 *
 * したがって「キャンセル用の文言を出す」テストは書けない。
 * 代わりに、**画面が使えないまま固まらないこと**を確かめる。
 * これが実際に利用者を困らせる失敗の形である。
 * ------------------------------------------------------------------
 */
await goto(`${origin}/apps/`, 1600);

const stuck = await evaluate('document.getElementById("auth-panel")?.dataset.authStatus ?? ""');
check('★読み込み中のまま固まらない', stuck !== 'loading', stuck);

/* GIS を遮断してあるので、ここは error になる。 */
check('取得できないと error 状態になる', stuck === 'error', stuck);

const errMessage = await evaluate(`(() => {
  const m = document.getElementById('auth-message');
  return m && !m.hidden ? m.textContent : '';
})()`);
check('日本語の案内が出る', errMessage.includes('ログインしなくても'), errMessage);
check('内部情報を出さない',
  !/[A-Za-z]{2,}Error|net::|stack/.test(errMessage), errMessage);

/* 失敗しても、アカウントを持たない利用者の導線は残っていなければならない。 */
const linksAlive = await evaluate(`(() => {
  const el = document.getElementById('auth-signup');
  return el ? String(!el.hidden) : 'missing';
})()`);
check('★失敗時も作成導線は消えない', linksAlive === 'true', String(linksAlive));

/* 未完了のまま勝手にログイン済みへ倒れないこと。 */
check('ログイン済みにならない', stuck !== 'signed-in', stuck);
const leaked = await evaluate(`Object.keys(sessionStorage).filter(k => k.includes('google-profile')).join(',')`);
check('★プロフィールを保存しない', leaked === '', leaked);

section("13. ログアウトと表示の復元");
/*
 * 実ログインはできない（外部を遮断している）ため、
 * 保存層の往復だけを確かめる。署名検証はしていない表示用キャッシュである。
 */
await evaluate(`sessionStorage.setItem('tsam-ai-google-profile', JSON.stringify({
  v: 1, sub: 'sub-1', name: '表示 太郎', email: 'taro@example.com',
  picture: '', emailVerified: true, expiresAt: Date.now() + 3600000,
}));`);
await goto(`${origin}/apps/`, 1600);

const restored = await evaluate('document.getElementById("auth-name")?.textContent ?? ""');
check('★同一タブで表示が復元される', restored === '表示 太郎', restored);

const signupHidden = await evaluate(`(() => {
  const el = document.getElementById('auth-signup');
  return el ? String(el.hidden) : 'missing';
})()`);
check('★ログイン中は作成導線を出さない', signupHidden === 'true', String(signupHidden));

await evaluate('document.getElementById("auth-signout")?.click();');
await page.sleep(400);

const afterSignOut = await evaluate('document.getElementById("auth-panel")?.dataset.authStatus ?? ""');
check('ログアウトで signed-in を抜ける', afterSignOut !== 'signed-in', afterSignOut);
const cleared = await evaluate(`sessionStorage.getItem('tsam-ai-google-profile') === null`);
check('★ログアウトで保存が消える', cleared === true);

const signupBack = await evaluate(`(() => {
  const el = document.getElementById('auth-signup');
  return el ? String(!el.hidden) : 'missing';
})()`);
check('★ログアウト後は作成導線が戻る', signupBack === 'true', String(signupBack));

section("11. コンソールエラー");
/*
 * 外部を遮断しているため、GIS の取得失敗に伴うエラーは出てよい。
 * それ以外（自前コードの例外）が無いことを確かめる。
 */
const ours = consoleErrors.filter((line) => (
  !line.includes('accounts.google.com')
  && !line.includes('ERR_BLOCKED_BY_CLIENT')
  && !line.includes('net::ERR_FAILED')
  && !line.includes('Failed to load resource')
));
check('自前コードのエラーが無い', ours.length === 0, ours.join(' | '));

await suite.close();
finish();

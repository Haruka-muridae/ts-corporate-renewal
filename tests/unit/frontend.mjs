/*
 * フロント共通資産（auth/*.js）の検証。
 *
 * ブラウザを起動せずに確かめられるもの（純粋な関数）をここで見る。
 * 実際の画面操作は tests/browser/auth-screens.mjs が担当する。
 */

import { check, section, finish, fatal } from '../../public/apps/tests/helpers/assert.mjs';

/*
 * location と history を差し替えてから読み込む。
 * auth/ui.js は読み込み時ではなく呼び出し時に参照するため、
 * あとから差し替えても効く。
 */
let currentSearch = '';
let replacedUrl = null;

globalThis.location = {
  get href() { return `https://tsam-ai.example/password/setup/${currentSearch}`; },
  get search() { return currentSearch; },
  get pathname() { return '/password/setup/'; },
  get origin() { return 'https://tsam-ai.example'; },
};

globalThis.history = {
  replaceState: (state, title, url) => {
    replacedUrl = url;
  },
};

try {
  const config = await import('../../public/auth/config.js');
  const ui = await import('../../public/auth/ui.js');
  const session = await import('../../public/auth/session.js');
  const { PORTAL_APPS } = await import('../../public/auth/apps.js');

  /* ---------------------------------------------------------------- */
  section('設定');

  /*
   * apiUrl は Apps Script Webアプリの公開エンドポイントであり、秘密ではない。
   * 設定済みであることと、GAS 以外へ向いていないことを確かめる。
   */
  check(
    'apiUrl が設定済みである',
    config.isApiConfigured() === true,
    config.AUTH_CONFIG.apiUrl,
  );

  check(
    'apiUrl は Apps Script の /exec を指している',
    /^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec$/.test(config.AUTH_CONFIG.apiUrl),
    config.AUTH_CONFIG.apiUrl,
  );

  check('空文字は isApiConfigured が false', config.isApiConfigured('') === false);

  check(
    '正しい /exec URL を設定済みと判定する',
    config.isApiConfigured('https://script.google.com/macros/s/AKfycbXXXX/exec') === true,
  );

  check(
    '別ドメインのURLは受け付けない',
    config.isApiConfigured('https://evil.example.com/macros/s/AKfycbXXXX/exec') === false,
  );

  check(
    'http は受け付けない',
    config.isApiConfigured('http://script.google.com/macros/s/AKfycbXXXX/exec') === false,
  );

  check(
    '設定に秘密情報の入れ物が無い',
    !Object.keys(config.AUTH_CONFIG).some((key) => /secret|priceId|stripe/i.test(key)),
  );

  check(
    'パスワード最低文字数の初期表示は12',
    config.AUTH_CONFIG.passwordMinLength === 12,
  );

  /* ---------------------------------------------------------------- */
  section('画面パスの解決');

  config.setScreenDepth(1);
  check('1階層下から見たルートは ../', config.rootPath() === '../');
  check('1階層下から見たログイン画面', config.screenPath('login') === '../login/');
  check('1階層下から見たPortal', config.screenPath('portal') === '../portal/');
  check('1階層下から見た料金プラン', config.screenPath('pricing') === '../pricing/');

  config.setScreenDepth(2);
  check('2階層下から見たルートは ../../', config.rootPath() === '../../');
  check('2階層下から見たログイン画面', config.screenPath('login') === '../../login/');
  check(
    '2階層下から見たパスワード初期設定',
    config.screenPath('passwordSetup') === '../../password/setup/',
  );

  check(
    '先頭スラッシュのパスを作らない（プロジェクトPages配信で壊れるため）',
    Object.keys(config.SCREENS).every((name) => !config.screenPath(name).startsWith('/')),
  );

  check(
    '不正な画面名ではルートを返す（例外を投げない）',
    config.screenPath('nonexistent') === '../../',
  );

  config.setScreenDepth('壊れた値');
  check('壊れた深さは1として扱う', config.rootPath() === '../');

  config.setScreenDepth(1);

  /* ---------------------------------------------------------------- */
  section('メールアドレスの検証（サーバー側と同じ条件）');

  const emailCases = [
    ['taro@example.com', true],
    ['  taro@example.com  ', true],
    ['a+tag@example.co.jp', true],
    ['taro.example.com', false],
    ['taro@example', false],
    ['', false],
    ['   ', false],
    ['a b@example.com', false],
    ['a,b@example.com', false],
    ['a@b@c.com', false],
    [`${'a'.repeat(250)}@example.com`, false],
    [null, false],
    [undefined, false],
  ];

  for (const [value, expected] of emailCases) {
    check(
      `isValidEmail(${JSON.stringify(String(value).slice(0, 20))}) → ${expected}`,
      ui.isValidEmail(value) === expected,
    );
  }

  /* ---------------------------------------------------------------- */
  section('要件どおりの文言');

  check(
    'メール未入力',
    ui.MESSAGES.emailRequired === 'メールアドレスを入力してください。',
  );
  check(
    'メール形式不正',
    ui.MESSAGES.emailInvalid === '正しいメールアドレスを入力してください。',
  );
  check(
    'パスワード未入力',
    ui.MESSAGES.passwordRequired === 'パスワードを入力してください。',
  );
  check(
    '通信エラー',
    ui.MESSAGES.network === '通信に失敗しました。時間をおいて再度お試しください。',
  );

  /* ---------------------------------------------------------------- */
  section('金額と支払周期の表示');

  check('円で整形する', ui.formatAmount('9800', 'jpy').includes('9,800'));
  check('通貨記号が付く', /[¥￥]/.test(ui.formatAmount('9800', 'jpy')));
  check('未確定なら空文字', ui.formatAmount('', 'jpy') === '');
  check('数値でなければそのまま返す', ui.formatAmount('応相談', 'jpy') === '応相談');
  check('null でも壊れない', ui.formatAmount(null, 'jpy') === '');

  check('month は月額', ui.formatInterval('month') === '月額');
  check('year は年額', ui.formatInterval('year') === '年額');
  check('未知の値は空文字', ui.formatInterval('week') === '');
  check('null でも壊れない', ui.formatInterval(null) === '');

  /* ---------------------------------------------------------------- */
  section('トークンの読み取り');

  currentSearch = '?token=abcDEF123_-xyz';
  check('URLからトークンを読める', ui.readTokenParam() === 'abcDEF123_-xyz');

  currentSearch = '';
  check('トークンが無ければ空文字', ui.readTokenParam() === '');

  currentSearch = '?token=';
  check('空のトークンは空文字', ui.readTokenParam() === '');

  currentSearch = `?token=${'a'.repeat(300)}`;
  check('長すぎるトークンは受け付けない', ui.readTokenParam() === '');

  currentSearch = '?token=abc%20def';
  check('空白入りのトークンは受け付けない', ui.readTokenParam() === '');

  currentSearch = '?token=<script>';
  check('記号入りのトークンは受け付けない', ui.readTokenParam() === '');

  currentSearch = '?token=abc/../../etc';
  check('パス区切りを含むトークンは受け付けない', ui.readTokenParam() === '');

  currentSearch = '?token=validtoken123&other=x';
  replacedUrl = null;
  ui.stripTokenFromUrl();

  check('URLからトークンを取り除く', replacedUrl !== null && !replacedUrl.includes('token='));
  check('他のパラメータは残す', replacedUrl.includes('other=x'));

  currentSearch = '?other=x';
  replacedUrl = null;
  ui.stripTokenFromUrl();
  check('トークンが無ければ書き換えない', replacedUrl === null);

  /* ---------------------------------------------------------------- */
  section('遷移先の検証（オープンリダイレクト対策）');

  check('既知の画面名は通す', session.safeNextName('portal') === 'portal');
  check('未知の画面名は portal へ丸める', session.safeNextName('login') === 'portal');
  check('外部URLは通さない', session.safeNextName('https://evil.example.com') === 'portal');
  check('プロトコル相対も通さない', session.safeNextName('//evil.example.com') === 'portal');
  check('サイト内絶対パスも通さない', session.safeNextName('/admin/') === 'portal');
  check('相対パスも通さない', session.safeNextName('../../etc') === 'portal');
  check('javascript: も通さない', session.safeNextName('javascript:alert(1)') === 'portal');
  check('null でも壊れない', session.safeNextName(null) === 'portal');

  currentSearch = '?next=portal';
  check('URLの next を読める', session.readNextParam() === 'portal');

  currentSearch = '?next=https://evil.example.com';
  check('URLの不正な next は丸められる', session.readNextParam() === 'portal');

  currentSearch = '';
  check('next が無ければ portal', session.readNextParam() === 'portal');

  /* ---------------------------------------------------------------- */
  section('Portal のアプリ一覧');

  check('アプリ一覧は配列', Array.isArray(PORTAL_APPS));

  check(
    'テスト環境（/apps/）を本番一覧へ載せていない',
    PORTAL_APPS.every((app) => !String(app.path ?? '').includes('apps/')),
  );

  check(
    '登録する場合はサイト内絶対パスにしない',
    PORTAL_APPS.every((app) => !String(app.path ?? '').startsWith('/')),
  );

  /* ---------------------------------------------------------------- */
  section('セッション保管（保存先が使えない環境）');

  /* localStorage が無い環境でも、例外を投げずに false / null を返すこと。 */
  check('保存先が無ければ利用不可と答える', session.isStorageAvailable() === false);
  check('読み出しは null', session.readSessionToken() === null);
  check('書き込みは false', session.writeSessionToken('token') === false);

  /* 例外を投げないことの確認。 */
  session.clearSessionToken();
  check('片付けで例外が出ない', true);

  /*
   * 保存するのはセッショントークンだけにする（仕様書 §7）。
   * 表示用の写しを保存する口が復活していないことを、
   * 公開されている名前の側から確かめる。
   */
  check(
    '表示用の写しを読み書きする関数を公開していない',
    session.readProfile === undefined && session.writeProfile === undefined,
  );

  finish();
} catch (error) {
  fatal(error);
}

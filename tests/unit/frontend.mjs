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

/* location.replace(...) の行き先を受け取る。goToLogin / goToScreen の検証に使う。 */
let replacedLocation = null;

globalThis.location = {
  get href() { return `https://tsam-ai.example/password/setup/${currentSearch}`; },
  get search() { return currentSearch; },
  get pathname() { return '/password/setup/'; },
  get origin() { return 'https://tsam-ai.example'; },
  replace: (url) => { replacedLocation = url; },
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
    '先頭スラッシュのパスを作らない（rootPath との連結がスラッシュ2つになるため）',
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

  check('録音アプリは戻り先として許可されている', session.safeNextName('voiceRecorder') === 'voiceRecorder');
  check('録音アプリの画面パスが定義されている',
    config.SCREENS.voiceRecorder === 'production-app/voice-recorder/');

  /* ---------------------------------------------------------------- */
  section('ログイン後に引き継ぐクエリ（仕様 §6 / 画面ごとの許可リスト）');

  /*
   * カレンダー通知から未ログインで開いた場合、ログイン画面を挟んでも
   * ?eventId= が残らなければ「どの予定の通知だったか」を出せない。
   * 引き継ぎは画面ごとの許可リストで行い、元URLはそのまま持ち回らない。
   */
  check('録音アプリでは eventId を引き継ぐ',
    session.safeNextParams('voiceRecorder', { eventId: 'abc123' }).eventId === 'abc123');
  check('URLSearchParams でも受け取れる',
    session.safeNextParams('voiceRecorder', new URLSearchParams('eventId=abc123')).eventId === 'abc123');
  check('繰り返し予定の回IDも通す（_YYYYMMDDTHHMMSSZ）',
    session.safeNextParams('voiceRecorder', { eventId: 'evt_20260810T010000Z' }).eventId
      === 'evt_20260810T010000Z');

  check('★portal には eventId を引き継がない（許可した画面だけ）',
    session.safeNextParams('portal', { eventId: 'abc123' }).eventId === undefined);
  check('★許可していない名前のパラメータは引き継がない',
    session.safeNextParams('voiceRecorder', { redirect: 'https://evil.example.com' }).redirect === undefined);

  check('★記号を含む eventId は落とす（別のクエリを差し込ませない）',
    session.safeNextParams('voiceRecorder', { eventId: 'a&next=portal' }).eventId === undefined);
  check('★スラッシュを含む値も落とす',
    session.safeNextParams('voiceRecorder', { eventId: '../../etc' }).eventId === undefined);
  check('★空文字は引き継がない',
    session.safeNextParams('voiceRecorder', { eventId: '' }).eventId === undefined);
  check('★長すぎる値は落とす',
    session.safeNextParams('voiceRecorder', { eventId: 'a'.repeat(513) }).eventId === undefined);
  check('文字列でない値も落とす',
    session.safeNextParams('voiceRecorder', { eventId: 12345 }).eventId === undefined);
  check('source が無くても壊れない',
    Object.keys(session.safeNextParams('voiceRecorder', null)).length === 0);

  currentSearch = '?eventId=abc123&next=voiceRecorder';
  check('URLから引き継ぎ値を読める', session.readNextParams().eventId === 'abc123');

  currentSearch = '?eventId=abc123&next=portal';
  check('★next が portal なら URL に eventId があっても読まない',
    session.readNextParams().eventId === undefined);

  /* ---------------------------------------------------------------- */
  section('ログイン画面への往復（実機で eventId が消えた経路）');

  config.setScreenDepth(2);
  currentSearch = '?eventId=abc123';
  replacedLocation = null;

  session.goToLogin({ next: 'voiceRecorder', params: { eventId: 'abc123' } });

  check('ログイン画面へ送る',
    replacedLocation === 'https://tsam-ai.example/login/?next=voiceRecorder&eventId=abc123',
    replacedLocation);

  replacedLocation = null;
  session.goToLogin({ next: 'voiceRecorder', params: { eventId: 'a b' } });
  check('★不正な eventId はログインURLに載せない',
    replacedLocation === 'https://tsam-ai.example/login/?next=voiceRecorder', replacedLocation);

  replacedLocation = null;
  session.goToLogin({ next: 'portal', params: { eventId: 'abc123' } });
  check('★portal 行きには eventId を載せない',
    replacedLocation === 'https://tsam-ai.example/login/?next=portal', replacedLocation);

  /*
   * ログイン成功後の遷移（login.js が goToScreen へ渡す形）。
   *
   * 深さは2のまま。この偽の location は /password/setup/ を指しており、
   * ルートまで戻るには '../../' が要る。実際のログイン画面は1階層下だが、
   * ここで見たいのは「引き継ぎ値が付くか」であって階層の計算ではない。
   */
  replacedLocation = null;

  session.goToScreen('voiceRecorder', { eventId: 'abc123' });

  check('★ログイン後に録音アプリへ eventId 付きで戻る',
    replacedLocation === 'https://tsam-ai.example/production-app/voice-recorder/?eventId=abc123',
    replacedLocation);

  replacedLocation = null;
  session.goToScreen('portal', { eventId: 'abc123' });
  check('portal へ戻るときは eventId を付けない',
    replacedLocation === 'https://tsam-ai.example/portal/', replacedLocation);

  replacedLocation = null;
  session.goToScreen('voiceRecorder');
  check('引き継ぎ値が無ければクエリを付けない',
    replacedLocation === 'https://tsam-ai.example/production-app/voice-recorder/', replacedLocation);

  currentSearch = '';
  config.setScreenDepth(1);

  /* ---------------------------------------------------------------- */
  section('Portal のアプリ一覧（portal/app-registry.js）');

  const { APP_REGISTRY } = await import('../../public/portal/app-registry.js');

  check('アプリ一覧は配列', Array.isArray(APP_REGISTRY));

  const isExternal = (href) => /^https?:\/\//i.test(String(href ?? ''));

  /*
   * 「本番サイトのテスト環境（tsam-ai.com/apps/）へは繋がない」が元の意図。
   * 仮データには localhost の /apps/ を指すものがあるため、
   * 判定を **本番ドメインだけ** に絞る。開発機のURLは対象外。
   */
  check(
    '本番サイトのテスト環境（/apps/）へ繋いでいない',
    APP_REGISTRY.every((app) => {
      const href = String(app.href ?? '');

      if (!isExternal(href)) {
        /* サイト内相対。/apps/ を指してはならない。 */
        return !href.includes('apps/');
      }

      /* 絶対URL。本番ドメインの /apps/ だけを禁じる。 */
      return !/^https?:\/\/(www\.)?tsam-ai\.com\/apps\//i.test(href);
    }),
    JSON.stringify(APP_REGISTRY.map((app) => app.href)),
  );

  check(
    'サイト内のときはサイト内絶対パスにしない',
    APP_REGISTRY.every((app) => isExternal(app.href) || !String(app.href ?? '').startsWith('/')),
  );

  /*
   * 仮データの見張り。
   *
   * localhost を指すエントリは、その端末でしか開けない。
   * 出荷したまま忘れられないよう、**いま仮であると分かっているものだけ**に
   * 限定しておく。新しく増やしたらここで落ちるので、意識せざるを得なくなる。
   * 仮データを外したら、この検査ごと消してよい（§13）。
   */
  const PROVISIONAL_IDS = ['202607No01', '202607No02', '202607No03'];

  check(
    'localhost を指すのは既知の仮データだけ',
    APP_REGISTRY
      .filter((app) => /localhost/i.test(String(app.href ?? '')))
      .every((app) => PROVISIONAL_IDS.includes(app.id)),
    JSON.stringify(APP_REGISTRY.filter((app) => /localhost/i.test(String(app.href ?? ''))).map((app) => app.id)),
  );

  check(
    '外部リンクは https か http の絶対URL',
    APP_REGISTRY.filter((app) => isExternal(app.href))
      .every((app) => { try { return new URL(app.href).protocol.startsWith('http'); } catch { return false; } }),
  );

  /* id は配置データ（order）が指す先。空や重複があると並べ替えが壊れる。 */
  check(
    'id は空でなく重複しない',
    APP_REGISTRY.every((app) => typeof app.id === 'string' && app.id.trim() !== '')
    && new Set(APP_REGISTRY.map((app) => app.id)).size === APP_REGISTRY.length,
  );

  /*
   * 移行元（auth/apps.js の PORTAL_APPS）は削除済み。
   * 復活させると「足しても Portal に出ない定義」が2か所になるため、
   * 存在しないことを見ておく。
   */
  let removedRegistryExists = false;

  try {
    await import('../../public/auth/apps.js');
    removedRegistryExists = true;
  } catch {
    /* 読み込めないのが正しい。 */
  }

  check('移行元 auth/apps.js が復活していない', removedRegistryExists === false);

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

  /* ---------------------------------------------------------------- */
  section('アプリの配置解決（portal/app-layout.js）');

  const layout = await import('../../public/portal/app-layout.js');
  const {
    resolveFavorites, resolveCatalog, parseLayout, pageCountFor, paginate, catalogPageCount,
  } = layout;

  check('保存キーは tsam-app-layout', layout.LAYOUT_STORAGE_KEY === 'tsam-app-layout');
  check('保存形式は version 2', layout.LAYOUT_VERSION === 2);
  check('お気に入りは1ページ8枠', layout.PAGE_SIZE === 8);
  check('最低2ページ', layout.MIN_PAGES === 2);
  check('カタログは1ページ20枠', layout.CATALOG_PAGE_SIZE === 20);

  /* カタログは埋め枠も最低ページ数も持たない。 */
  check('カタログ0件でも1ページ', catalogPageCount(0) === 1);
  check('カタログ20件で1ページ', catalogPageCount(20) === 1);
  check('カタログ21件で2ページ', catalogPageCount(21) === 2, catalogPageCount(21));
  check('カタログ40件で2ページ', catalogPageCount(40) === 2);
  check('カタログ41件で3ページ', catalogPageCount(41) === 3);

  /* ---- ページ数 ---- */

  check('0件でも2ページ', pageCountFor(0) === 2, pageCountFor(0));
  check('8件で2ページ', pageCountFor(8) === 2, pageCountFor(8));
  check('9件で2ページ（ceil(9/8)=2）', pageCountFor(9) === 2, pageCountFor(9));
  check('17件で3ページ', pageCountFor(17) === 3, pageCountFor(17));
  check('負数・NaN でも2ページ', pageCountFor(-5) === 2 && pageCountFor(NaN) === 2);

  /* ---- 配置解決 ---- */

  const APPS = [
    { id: 'a', name: 'A', href: 'app/a/' },
    { id: 'b', name: 'B', href: 'app/b/' },
    { id: 'c', name: 'C', href: 'app/c/' },
  ];

  const ids = (list) => list.map((app) => app.id).join(',');

  /*
   * v2 では order は「お気に入りのID列」。
   * 載っていないアプリはお気に入りに入らず、カタログへ回る。
   */

  /* a: 保存済み order の順で出す。 */
  check(
    'お気に入りは order の順で並ぶ',
    ids(resolveFavorites(APPS, { version: 2, order: ['c', 'a'] })) === 'c,a',
    ids(resolveFavorites(APPS, { version: 2, order: ['c', 'a'] })),
  );

  /* b: order に無い既知アプリはお気に入りに入らない（v1 からの意味変更）。 */
  check(
    'order に無い既知アプリはお気に入りに入らない',
    ids(resolveFavorites(APPS, { version: 2, order: ['c'] })) === 'c',
    ids(resolveFavorites(APPS, { version: 2, order: ['c'] })),
  );

  check(
    'お気に入りに入らなかったアプリはカタログへ回る',
    ids(resolveCatalog(APPS, resolveFavorites(APPS, { version: 2, order: ['c'] }))) === 'a,b',
    ids(resolveCatalog(APPS, resolveFavorites(APPS, { version: 2, order: ['c'] }))),
  );

  /* c: 未知 ID は無視する（既定へは倒さない）。 */
  check(
    '未知IDは無視され、既知の並びは保たれる',
    ids(resolveFavorites(APPS, { version: 2, order: ['zzz', 'b', 'unknown', 'a'] })) === 'b,a',
    ids(resolveFavorites(APPS, { version: 2, order: ['zzz', 'b', 'unknown', 'a'] })),
  );

  check(
    '同じIDが2回あっても重複させない',
    ids(resolveFavorites(APPS, { version: 2, order: ['b', 'b', 'a'] })) === 'b,a',
    ids(resolveFavorites(APPS, { version: 2, order: ['b', 'b', 'a'] })),
  );

  /* d: 保存が無ければお気に入りは空。全アプリがカタログに出る。 */
  check('保存が無ければお気に入りは空', resolveFavorites(APPS, null).length === 0);
  check('第2引数を省略してもお気に入りは空', resolveFavorites(APPS).length === 0);
  check('そのときカタログは全件', ids(resolveCatalog(APPS, [])) === 'a,b,c');
  check('定義が空ならどちらも空', resolveFavorites([], { version: 2, order: ['a'] }).length === 0 && resolveCatalog([], []).length === 0);
  check('定義が配列でなければ空', resolveFavorites(null).length === 0 && resolveCatalog(null, []).length === 0);
  check('id の無い定義は落とす', ids(resolveCatalog([{ name: 'X' }, ...APPS], [])) === 'a,b,c');
  check('全件お気に入りならカタログは0件', resolveCatalog(APPS, APPS).length === 0);

  /* ---- v1 データからの移行 ---- */

  /*
   * v1 の order は「表示順」で、全アプリが載っていた。
   * それを v2 として読むと、全アプリが勝手にお気に入りへ入る。
   * 版が違うものは読まず、お気に入り空から始めさせる。
   */
  check('v1 の保存は読まない（null になる）', parseLayout('{"version":1,"order":["c","b","a"]}') === null);

  check(
    'v1 データはお気に入り空へフォールバックする',
    resolveFavorites(APPS, parseLayout('{"version":1,"order":["c","b","a"]}')).length === 0,
  );

  check(
    'そのとき全アプリがカタログに出る',
    ids(resolveCatalog(APPS, resolveFavorites(APPS, parseLayout('{"version":1,"order":["c","b","a"]}')))) === 'a,b,c',
  );

  /* ---- 保存データの解釈（壊れていても例外を投げない） ---- */

  check('正しい JSON を読める', JSON.stringify(parseLayout('{"version":2,"order":["a"]}')) === JSON.stringify({ version: 2, order: ['a'] }));
  check('壊れた JSON は null', parseLayout('{') === null);
  check('null 文字列は null', parseLayout('null') === null);
  check('配列は null', parseLayout('[1,2]') === null);
  check('文字列リテラルは null', parseLayout('"text"') === null);
  check('空文字は null', parseLayout('') === null && parseLayout('   ') === null);
  check('文字列以外は null', parseLayout(null) === null && parseLayout(undefined) === null && parseLayout(42) === null);
  check('order が配列でなければ null', parseLayout('{"version":2,"order":"a"}') === null);

  /* 版が違うものは読まない（推測で解釈しない）。 */
  check('version が違えば null', parseLayout('{"version":3,"order":["a"]}') === null);
  check('version が無ければ null', parseLayout('{"order":["a"]}') === null);
  check(
    'version 不一致はお気に入り空へ倒れる',
    resolveFavorites(APPS, parseLayout('{"version":9,"order":["c","b","a"]}')).length === 0,
  );

  check(
    '壊れた JSON もお気に入り空へ倒れる',
    resolveFavorites(APPS, parseLayout('{{{')).length === 0,
  );

  check(
    'order の中の非文字列・空文字は落とす',
    JSON.stringify(parseLayout('{"version":2,"order":["a",1,null,"","  ","b"]}').order)
      === JSON.stringify(['a', 'b']),
    JSON.stringify(parseLayout('{"version":2,"order":["a",1,null,"","  ","b"]}')?.order),
  );

  /* ---- ページ分割 ---- */

  const pages = paginate(APPS);

  check('0件でも2ページぶんの枠ができる', paginate([]).length === 2);
  check('各ページは8枠', pages.every((page) => page.length === 8));
  check('足りない枠は null で埋まる', pages[0][3] === null && pages[1].every((slot) => slot === null));
  check('先頭3枠にアプリが入る', ids(pages[0].slice(0, 3).filter(Boolean)) === 'a,b,c');

  const nine = Array.from({ length: 9 }, (unused, index) => ({ id: `app-${index}`, name: `App ${index}` }));
  check('9件なら2ページ目に1件だけ入る', paginate(nine)[1].filter(Boolean).length === 1);

  const seventeen = Array.from({ length: 17 }, (unused, index) => ({ id: `x-${index}`, name: `X ${index}` }));
  check('17件で3ページになる', paginate(seventeen).length === 3);

  /* 保存先が無い環境でも例外を投げない。 */
  check('localStorage が無ければ null を返す', layout.readStoredLayout() === null);
  check('保存先が無ければ書き込みは false', layout.writeStoredLayout(['a']) === false);
  check('保存先が無ければ削除も false', layout.clearStoredLayout() === false);

  /* ---- 挿入（押しのけ方式） ---- */

  const { moveItem } = layout;
  const L = ['a', 'b', 'c', 'd'];
  const j = (list) => list.join(',');

  check('末尾を先頭へ', j(moveItem(L, 3, 0)) === 'd,a,b,c', j(moveItem(L, 3, 0)));
  check('先頭を末尾へ', j(moveItem(L, 0, 3)) === 'b,c,d,a', j(moveItem(L, 0, 3)));
  check('1つ右へ', j(moveItem(L, 1, 2)) === 'a,c,b,d', j(moveItem(L, 1, 2)));
  check('1つ左へ', j(moveItem(L, 2, 1)) === 'a,c,b,d', j(moveItem(L, 2, 1)));

  /* 入れ替えではなく押しのけ。間の要素が1つずつずれる。 */
  check('入れ替え（swap）ではない', j(moveItem(L, 0, 2)) === 'b,c,a,d', j(moveItem(L, 0, 2)));

  check('同じ位置なら変わらない', j(moveItem(L, 2, 2)) === 'a,b,c,d');
  check('範囲外（大きい）は末尾へ丸める', j(moveItem(L, 0, 99)) === 'b,c,d,a', j(moveItem(L, 0, 99)));
  check('範囲外（負）は先頭へ丸める', j(moveItem(L, 3, -5)) === 'd,a,b,c', j(moveItem(L, 3, -5)));
  check('to が数値でなければ末尾へ', j(moveItem(L, 0, undefined)) === 'b,c,d,a', j(moveItem(L, 0, undefined)));

  check('from が範囲外なら変わらない', j(moveItem(L, 9, 0)) === 'a,b,c,d');
  check('from が負でも変わらない', j(moveItem(L, -1, 0)) === 'a,b,c,d');
  check('空配列でも例外を投げない', moveItem([], 0, 0).length === 0);
  check('配列でなければ空を返す', moveItem(null, 0, 0).length === 0);

  /* 元の配列を書き換えない。 */
  const before = ['a', 'b', 'c'];
  moveItem(before, 0, 2);
  check('元の配列を書き換えない', j(before) === 'a,b,c');

  /* ---- 保存と削除（localStorage を差し替えて確認） ---- */

  const layoutStore = new Map();

  globalThis.localStorage = {
    getItem: (k) => (layoutStore.has(k) ? layoutStore.get(k) : null),
    setItem: (k, v) => { layoutStore.set(k, String(v)); },
    removeItem: (k) => { layoutStore.delete(k); },
  };

  check('保存できる', layout.writeStoredLayout(['b', 'a']) === true);

  check(
    '保存の形は {version:2, order:[…]}',
    layoutStore.get('tsam-app-layout') === JSON.stringify({ version: 2, order: ['b', 'a'] }),
    layoutStore.get('tsam-app-layout'),
  );

  check(
    '保存したものをそのまま読み戻せる',
    j(layout.readStoredLayout().order) === 'b,a',
  );

  check(
    '空文字や非文字列は保存時に落とす',
    layout.writeStoredLayout(['a', '', 1, null, '  ', 'b']) === true
    && layoutStore.get('tsam-app-layout') === JSON.stringify({ version: 2, order: ['a', 'b'] }),
    layoutStore.get('tsam-app-layout'),
  );

  check('削除すると保存キーごと消える', layout.clearStoredLayout() === true && layoutStore.has('tsam-app-layout') === false);
  check('削除後は保存なし扱い', layout.readStoredLayout() === null);

  /* 保存に失敗しても例外を投げない（容量超過の再現）。 */
  globalThis.localStorage = {
    getItem: () => null,
    setItem: () => { throw new Error('QuotaExceededError'); },
    removeItem: () => {},
  };

  check('保存に失敗したら false を返す（例外は投げない）', layout.writeStoredLayout(['a']) === false);

  delete globalThis.localStorage;

  /* ---------------------------------------------------------------- */
  section('アプリ一覧の取得（portal/app-source.js）');

  const source = await import('../../public/portal/app-source.js');
  const { parseCsv, rowsToApps, fetchApps } = source;

  check('キャッシュキーは tsam-app-registry-cache', source.CACHE_STORAGE_KEY === 'tsam-app-registry-cache');

  check(
    'CSV出力のURLはシートIDと gid を含む',
    /^https:\/\/docs\.google\.com\/spreadsheets\/d\/[^/]+\/gviz\/tq\?tqx=out:csv&gid=0$/.test(source.sheetCsvUrl()),
    source.sheetCsvUrl(),
  );

  /* ---- CSV 解析 ---- */

  check(
    '素直な CSV を行と列へ分ける',
    JSON.stringify(parseCsv('a,b,c\n1,2,3')) === JSON.stringify([['a', 'b', 'c'], ['1', '2', '3']]),
    JSON.stringify(parseCsv('a,b,c\n1,2,3')),
  );

  /* 引用符の中のカンマは区切りではない。split(',') では崩れるところ。 */
  check(
    '引用符の中のカンマは区切りにしない',
    JSON.stringify(parseCsv('"a,b",c')) === JSON.stringify([['a,b', 'c']]),
    JSON.stringify(parseCsv('"a,b",c')),
  );

  check(
    '引用符の中の改行はセルの一部として扱う',
    JSON.stringify(parseCsv('"1行目\n2行目",x')) === JSON.stringify([['1行目\n2行目', 'x']]),
    JSON.stringify(parseCsv('"1行目\n2行目",x')),
  );

  check(
    '"" は引用符そのもの',
    JSON.stringify(parseCsv('"He said ""hi""",y')) === JSON.stringify([['He said "hi"', 'y']]),
    JSON.stringify(parseCsv('"He said ""hi""",y')),
  );

  check('CRLF でも1行として数える', parseCsv('a,b\r\nc,d').length === 2);
  check('CR だけでも1行として数える', parseCsv('a,b\rc,d').length === 2);
  check('末尾の改行で空行を作らない', parseCsv('a,b\n').length === 1);
  check('空文字なら0行', parseCsv('').length === 0 && parseCsv(null).length === 0);
  check('空行は落とす', parseCsv('a,b\n\n,\nc,d').length === 2, JSON.stringify(parseCsv('a,b\n\n,\nc,d')));

  /* ---- 行 → アプリ定義 ---- */

  const CSV_OK = [
    'アプリID,アプリ名,アプリURL,アイコンURL',
    'A1,音声録音,https://example.com/voice/,https://example.com/v.svg',
    'A2,"領収書, 収支",https://example.com/receipt/,',
  ].join('\n');

  const okApps = rowsToApps(parseCsv(CSV_OK));

  check('ヘッダー行を読み飛ばす', okApps.length === 2, JSON.stringify(okApps));
  check('4列が id/name/href/icon に入る',
    JSON.stringify(okApps[0]) === JSON.stringify({
      id: 'A1', name: '音声録音', href: 'https://example.com/voice/', icon: 'https://example.com/v.svg',
    }),
    JSON.stringify(okApps[0]));
  check('引用符付きの名前も取れる', okApps[1].name === '領収書, 収支');
  check('アイコンが空でも行は残る（icon は空文字）', okApps[1].icon === '');

  /* ヘッダーが無いシートでも1行目を落とさない。 */
  check(
    'ヘッダーが無ければ1行目もデータとして読む',
    rowsToApps(parseCsv('A1,名前,https://example.com/,')).length === 1,
  );

  /* 不正行はその行だけ捨て、全体は失敗させない。 */
  const CSV_DIRTY = [
    'アプリID,アプリ名,アプリURL,アイコンURL',
    ',名無し,https://example.com/a/,',
    'B1,,https://example.com/b/,',
    'B2,名前,javascript:alert(1),',
    'B3,名前,ftp://example.com/,',
    'B4,名前,,',
    'B5,ちゃんとした,https://example.com/ok/,',
    'B5,重複ID,https://example.com/dup/,',
  ].join('\n');

  const dirty = rowsToApps(parseCsv(CSV_DIRTY));

  check('ID が空の行は落とす', !dirty.some((app) => app.name === '名無し'));
  check('名前が空の行は落とす', !dirty.some((app) => app.id === 'B1'));
  check('javascript: の行は落とす', !dirty.some((app) => app.id === 'B2'));
  check('http(s) 以外のURLの行は落とす', !dirty.some((app) => app.id === 'B3'));
  check('URL が空の行は落とす', !dirty.some((app) => app.id === 'B4'));
  check('重複IDは先に出たほうを採る',
    dirty.filter((app) => app.id === 'B5').length === 1 && dirty.find((app) => app.id === 'B5').name === 'ちゃんとした');
  check('壊れた行があっても正しい行は残る', dirty.length === 1, JSON.stringify(dirty));

  /* アイコンだけ不正なら、行は残して icon を空にする。 */
  check(
    'アイコンURLが不正でも行は落とさない',
    (() => {
      const apps = rowsToApps(parseCsv('C1,名前,https://example.com/,javascript:alert(1)'));
      return apps.length === 1 && apps[0].icon === '';
    })(),
  );

  /* ---- 取得（fetch はスタブ。実ネットワークへは出ない） ---- */

  const stubFetch = (body, { ok = true, status = 200 } = {}) => async () => ({
    ok, status, text: async () => body,
  });

  const okResult = await fetchApps({ fetchImpl: stubFetch(CSV_OK) });
  check('取得できたら ok=true とアプリ配列', okResult.ok === true && okResult.apps.length === 2);

  const httpFail = await fetchApps({ fetchImpl: stubFetch('', { ok: false, status: 401 }) });
  check('401 は失敗として扱う', httpFail.ok === false && httpFail.reason === 'HTTP_401', httpFail.reason);

  /* 共有設定が未了だと Google はログイン画面のHTMLを返す。 */
  const htmlFail = await fetchApps({ fetchImpl: stubFetch('<!DOCTYPE html><body>Sign in</body>') });
  check('HTMLが返ってきたら失敗として扱う', htmlFail.ok === false, JSON.stringify(htmlFail));

  const emptyFail = await fetchApps({ fetchImpl: stubFetch('アプリID,アプリ名,アプリURL,アイコンURL') });
  check('0件は失敗として扱う（空の一覧を出さない）', emptyFail.ok === false && emptyFail.reason === 'EMPTY');

  const throwFail = await fetchApps({ fetchImpl: async () => { throw new Error('offline'); } });
  check('通信が失敗しても例外を投げない', throwFail.ok === false && throwFail.reason === 'NETWORK');

  check('fetch が無い環境でも例外を投げない',
    (await fetchApps({ fetchImpl: null })).reason === 'NO_FETCH'
    || (await fetchApps({ fetchImpl: undefined, url: 'x' })).ok === false);

  /* ---- キャッシュ ---- */

  const cacheStore = new Map();

  globalThis.localStorage = {
    getItem: (k) => (cacheStore.has(k) ? cacheStore.get(k) : null),
    setItem: (k, v) => { cacheStore.set(k, String(v)); },
    removeItem: (k) => { cacheStore.delete(k); },
  };

  check('保存前は空配列', source.readCachedApps().length === 0);
  check('保存できる', source.writeCachedApps(okApps) === true);
  check('保存したものを読み戻せる', source.readCachedApps().length === 2);

  check(
    'キャッシュには version と fetchedAt が入る',
    (() => {
      const saved = JSON.parse(cacheStore.get('tsam-app-registry-cache'));
      return saved.version === 1 && typeof saved.fetchedAt === 'string' && Array.isArray(saved.apps);
    })(),
    cacheStore.get('tsam-app-registry-cache'),
  );

  /* 読み戻した値も取得直後と同じ検査を通す。 */
  cacheStore.set('tsam-app-registry-cache', JSON.stringify({
    version: 1,
    fetchedAt: 'x',
    apps: [{ id: 'D1', name: '悪いURL', href: 'javascript:alert(1)' }, { id: 'D2', name: '良い', href: 'https://example.com/' }],
  }));

  check(
    'キャッシュの中の不正な行も落とす',
    source.readCachedApps().length === 1 && source.readCachedApps()[0].id === 'D2',
    JSON.stringify(source.readCachedApps()),
  );

  cacheStore.set('tsam-app-registry-cache', JSON.stringify({ version: 99, apps: [] }));
  check('版が違うキャッシュは無視する', source.readCachedApps().length === 0);

  cacheStore.set('tsam-app-registry-cache', '{{{');
  check('壊れたキャッシュでも例外を投げない', source.readCachedApps().length === 0);

  cacheStore.clear();
  delete globalThis.localStorage;

  check('保存先が無ければ書き込みは false', source.writeCachedApps(okApps) === false);
  check('保存先が無ければ読み出しは空', source.readCachedApps().length === 0);

  /* ---------------------------------------------------------------- */
  section('KeyStore（APIキーの保管庫）');

  const keystore = await import('../../public/auth/keystore.js');
  const { KeyStore } = keystore;

  check('保存キーは tsam-api-keys', keystore.KEYSTORE_STORAGE_KEY === 'tsam-api-keys');
  check('プロバイダー名 gemini を持つ', keystore.PROVIDERS.gemini === 'gemini');

  /* localStorage が無い環境。例外を投げず、保存できなかったと答えること。 */
  check('保存先が無ければ利用不可と答える', keystore.isKeyStoreAvailable() === false);
  check('読み出しは null', KeyStore.get('gemini') === null);
  check('has は false', KeyStore.has('gemini') === false);
  check('書き込みは false', KeyStore.set('gemini', 'AIzaTEST') === false);

  /* ここから先は localStorage を差し替えて、保存の形そのものを見る。 */
  const store = new Map();

  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
  };

  check('差し替え後は利用可能と答える', keystore.isKeyStoreAvailable() === true);

  check('保存できる', KeyStore.set('gemini', 'AIzaTESTKEY') === true);
  check('保存した値が読める', KeyStore.get('gemini') === 'AIzaTESTKEY');
  check('has が true になる', KeyStore.has('gemini') === true);

  check(
    '保存の形は プロバイダー名をキーにした JSON 1件',
    store.get('tsam-api-keys') === JSON.stringify({ gemini: 'AIzaTESTKEY' }),
    store.get('tsam-api-keys'),
  );

  /* 2社目が増えても localStorage のキーは増やさない。 */
  KeyStore.set('openai', 'sk-TESTKEY');

  check(
    '2件目も同じ JSON へ入る（保存キーを増やさない）',
    store.get('tsam-api-keys') === JSON.stringify({ gemini: 'AIzaTESTKEY', openai: 'sk-TESTKEY' })
    && store.size === 1,
    JSON.stringify([...store.entries()]),
  );

  check('片方を消してももう片方は残る', KeyStore.remove('openai') === true && KeyStore.get('gemini') === 'AIzaTESTKEY');

  /* 空文字は受け付けない。消したいときは remove を使う。 */
  check('空文字での上書きは拒否する', KeyStore.set('gemini', '') === false);
  check('拒否しても元の値は残っている', KeyStore.get('gemini') === 'AIzaTESTKEY');
  check('空白だけの値も拒否する', KeyStore.set('gemini', '   ') === false);

  check('前後の空白は落として保存する', KeyStore.set('gemini', '  AIzaTRIMMED  ') === true && KeyStore.get('gemini') === 'AIzaTRIMMED');

  /* 全部消えたら、保存キーごと消す（空の JSON を残さない）。 */
  KeyStore.remove('gemini');

  check(
    '最後の1件を消すと保存キーごと消える',
    store.has('tsam-api-keys') === false,
    JSON.stringify([...store.entries()]),
  );

  check('元から無いものを消しても true', KeyStore.remove('gemini') === true);

  /* 手で書き換えられた値でも壊れない。 */
  for (const broken of ['{', 'null', '"text"', '[1,2]', '']) {
    store.set('tsam-api-keys', broken);
    check(`壊れた保存値（${broken || '空文字'}）でも例外を投げず null`, KeyStore.get('gemini') === null);
  }

  store.delete('tsam-api-keys');
  delete globalThis.localStorage;

  finish();
} catch (error) {
  fatal(error);
}

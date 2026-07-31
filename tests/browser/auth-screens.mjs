/*
 * 本番認証画面の実ブラウザ確認。
 *
 * 確かめること:
 *   - 320px / 375px / 768px / 1440px で横スクロールが出ない
 *   - ラベル・フォーカス・キーボード操作が成立する
 *   - パスワード表示切替が aria-pressed と同期する
 *   - Enter キーでログインできる
 *   - 二重送信を防いでいる
 *   - 要件どおりの検証文言が出る
 *   - ログイン画面に余計なもの（アプリ一覧・料金・長文説明）を出していない
 *   - 未ログインで Portal を開くとログイン画面へ戻される
 *   - コンソールエラーが出ない
 *
 * ------------------------------------------------------------------
 * 本番のエンドポイントへ送らないこと
 * ------------------------------------------------------------------
 * auth/config.js の apiUrl には本番の Apps Script URL が入っている。
 * API を呼ぶ操作を試すときは fetch を差し替えて通信を遮断し、
 * テストが本番の認証ログへ行を作らないようにする。
 *
 * ただし /password/setup/ と /password/reset/ は、読み込み時に
 * publicConfig（参照のみ・副作用なし）を取得する。この2画面の確認では
 * 実際の GET が1回発生する。
 * ------------------------------------------------------------------
 */

import { check, section, finish, fatal } from '../../apps/tests/helpers/assert.mjs';
import { startSuite } from '../../apps/tests/helpers/browser-harness.mjs';

/* 既存の apps 側テストとポートが衝突しないよう、離れた番号を使う。 */
const SUITE_INDEX = 20;

const WIDTHS = [320, 375, 768, 1024, 1440];

let suite = null;

try {
  suite = await startSuite(SUITE_INDEX);
  const { page, origin, subpathOrigin } = suite;

  /* ---------------------------------------------------------------- */
  section('ログイン画面の表示');

  await page.goto(`${origin}/login/`);

  check(
    'タイトルが設定されている',
    (await page.evaluate('document.title')) === 'ログイン | TSAM AI',
  );

  check(
    '検索結果に出さない設定',
    (await page.evaluate('document.querySelector("meta[name=robots]").content')).includes('noindex'),
  );

  check('見出しは「ログイン」', (await page.evaluate('document.querySelector("h1").textContent')) === 'ログイン');

  check(
    '要件どおりの導入文が出る',
    (await page.evaluate('document.querySelector(".auth-card__lead").textContent'))
      .includes('TSAM AIサービスをご利用いただくには'),
  );

  /* ---- 必須要素 ---- */
  const requiredIds = [
    'login-email', 'login-password', 'login-password-toggle',
    'login-remember', 'login-submit', 'login-signup', 'login-message',
  ];

  for (const id of requiredIds) {
    const exists = await page.evaluate(`document.getElementById(${JSON.stringify(id)}) !== null`);
    check(`${id} が存在する`, exists);
  }

  check(
    'メールアドレス欄は type=email',
    (await page.evaluate('document.getElementById("login-email").type')) === 'email',
  );

  check(
    'パスワード欄は type=password',
    (await page.evaluate('document.getElementById("login-password").type')) === 'password',
  );

  check(
    'ログイン状態を保持するチェックボックスがある',
    (await page.evaluate('document.getElementById("login-remember").type')) === 'checkbox',
  );

  /* ---- ラベル ---- */
  check(
    'すべての入力欄に label が結び付いている',
    await page.evaluate(`
      [...document.querySelectorAll("input")].every((input) => {
        if (input.type === "hidden") return true;
        const label = document.querySelector('label[for="' + input.id + '"]');
        return label !== null && label.textContent.trim() !== "";
      })
    `),
  );

  check(
    'プレースホルダーだけに頼っていない（placeholder を使っていない）',
    await page.evaluate('[...document.querySelectorAll("input")].every((i) => !i.placeholder)'),
  );

  /* ---- 導線 ---- */
  check(
    'パスワードをお忘れですか？のリンクがある',
    await page.evaluate(`
      [...document.querySelectorAll("a")].some((a) =>
        a.textContent.includes("パスワードをお忘れ") && a.getAttribute("href") === "../password/reset/")
    `),
  );

  check(
    '「初めてご利用の方」の見出しがある',
    await page.evaluate('document.body.textContent.includes("初めてご利用の方")'),
  );

  check(
    '「サービスを申し込む」ボタンがある',
    (await page.evaluate('document.getElementById("login-signup").textContent.trim()')) === 'サービスを申し込む',
  );

  check(
    '申し込みは料金プラン画面へ向く（Stripeへ直接遷移しない）',
    (await page.evaluate('document.getElementById("login-signup").getAttribute("href")')) === '../pricing/',
  );

  check(
    'ログイン画面から Stripe へのリンクが無い',
    await page.evaluate(`
      [...document.querySelectorAll("a")].every((a) => !a.href.includes("stripe.com"))
    `),
  );

  check(
    '利用規約の項目がある',
    await page.evaluate('document.body.textContent.includes("利用規約")'),
  );

  check(
    'プライバシーポリシーの項目がある',
    await page.evaluate('document.body.textContent.includes("プライバシーポリシー")'),
  );

  check(
    '利用規約が公開ページへリンクしている',
    await page.evaluate(`
      [...document.querySelectorAll("a")].some((a) =>
        a.textContent.trim() === "利用規約" && a.getAttribute("href") === "../legal/terms/")
    `),
  );

  check(
    'プライバシーポリシーも公開ページへリンクしている',
    await page.evaluate(`
      [...document.querySelectorAll("a")].some((a) =>
        a.textContent.trim() === "プライバシーポリシー" && a.getAttribute("href") === "../legal/privacy/")
    `),
  );

  /* ---- 載せてはいけないもの ---- */
  section('ログイン画面に載せないもの');

  const forbidden = ['アプリ一覧', 'お知らせ', 'ニュース', '導入事例', '会社紹介', '料金プラン一覧'];

  for (const word of forbidden) {
    const present = await page.evaluate(
      `document.body.textContent.includes(${JSON.stringify(word)})`,
    );
    check(`「${word}」を載せていない`, present === false);
  }

  check(
    '料金の金額を載せていない',
    await page.evaluate('!/[0-9][0-9,]*\\s*円/.test(document.body.textContent)'),
  );

  check(
    '本文が長文になっていない（500文字未満）',
    await page.evaluate('document.querySelector("main").textContent.replace(/\\s+/g, "").length < 500'),
    await page.evaluate('document.querySelector("main").textContent.replace(/\\s+/g, "").length'),
  );

  /* ---------------------------------------------------------------- */
  section('レスポンシブ（横スクロールが出ない）');

  for (const width of WIDTHS) {
    await page.setViewport(width, 900);
    await page.goto(`${origin}/login/`);

    const overflow = await page.evaluate(
      'document.documentElement.scrollWidth - document.documentElement.clientWidth',
    );

    check(`ログイン画面 ${width}px で横スクロールが出ない`, overflow <= 0, overflow);
  }

  await page.setViewport(320, 900);

  check(
    '320px でもカードが画面内に収まる',
    await page.evaluate('document.querySelector(".auth-card").getBoundingClientRect().width <= 320'),
  );

  check(
    '320px でも送信ボタンが押せる大きさ（高さ40px以上）',
    await page.evaluate('document.getElementById("login-submit").getBoundingClientRect().height >= 40'),
  );

  await page.setViewport(1440, 900);
  await page.goto(`${origin}/login/`);

  check(
    'PC表示ではカードが420px以下に収まる',
    await page.evaluate('document.querySelector(".auth-shell").getBoundingClientRect().width <= 420'),
    await page.evaluate('document.querySelector(".auth-shell").getBoundingClientRect().width'),
  );

  check(
    'PC表示でカードが中央に置かれる',
    await page.evaluate(`
      (() => {
        const rect = document.querySelector(".auth-shell").getBoundingClientRect();
        const center = rect.left + rect.width / 2;
        /* スクロールバーの幅を含まない clientWidth で比べる。 */
        return Math.abs(center - document.documentElement.clientWidth / 2) < 4;
      })()
    `),
    await page.evaluate(`
      (() => {
        const rect = document.querySelector(".auth-shell").getBoundingClientRect();
        return (rect.left + rect.width / 2) + " vs " + (document.documentElement.clientWidth / 2);
      })()
    `),
  );

  /* ---------------------------------------------------------------- */
  section('入力検証の文言');

  await page.clearViewport();
  await page.goto(`${origin}/login/`);

  async function submitAndReadMessage(email, password) {
    await page.evaluate(`
      document.getElementById("login-email").value = ${JSON.stringify(email)};
      document.getElementById("login-password").value = ${JSON.stringify(password)};
      document.getElementById("login-form").requestSubmit();
    `);

    await page.sleep(200);

    return page.evaluate(
      'document.getElementById("login-message").querySelector(".auth-message__body")?.textContent ?? ""',
    );
  }

  check(
    'メール未入力の文言',
    (await submitAndReadMessage('', '')) === 'メールアドレスを入力してください。',
  );

  check(
    'メール形式不正の文言',
    (await submitAndReadMessage('not-an-email', '')) === '正しいメールアドレスを入力してください。',
  );

  check(
    'パスワード未入力の文言',
    (await submitAndReadMessage('taro@example.com', '')) === 'パスワードを入力してください。',
  );

  check(
    'エラーは色だけでなく語でも示す',
    (await page.evaluate(
      'document.getElementById("login-message").querySelector(".auth-message__label").textContent',
    )) === 'エラー',
  );

  check(
    'エラーは支援技術へ割り込んで伝える',
    (await page.evaluate('document.getElementById("login-message").getAttribute("role")')) === 'alert',
  );

  check(
    '問題のある入力欄へフォーカスが移る',
    (await page.evaluate('document.activeElement.id')) === 'login-password',
  );

  check(
    '問題のある入力欄に aria-invalid が付く',
    (await page.evaluate('document.getElementById("login-password").getAttribute("aria-invalid")')) === 'true',
  );

  await page.evaluate('document.getElementById("login-password").value = "x"; document.getElementById("login-password").dispatchEvent(new Event("input"))');
  await page.sleep(100);

  check(
    '入力し直すとエラー表示が消える',
    await page.evaluate('document.getElementById("login-message").hidden === true'),
  );

  check(
    '入力し直すと aria-invalid も外れる',
    await page.evaluate('document.getElementById("login-password").getAttribute("aria-invalid") === null'),
  );

  /* ---------------------------------------------------------------- */
  section('Enter キーでのログイン');

  await page.goto(`${origin}/login/`);

  /*
   * フォーム内の input で Enter を押したときの既定動作（暗黙の送信）を再現する。
   * 送信ハンドラが動けば検証文言が出る。
   */
  await page.evaluate(`
    document.getElementById("login-email").value = "";
    document.getElementById("login-email").focus();
  `);

  await page.send('Input.dispatchKeyEvent', {
    type: 'keyDown', windowsVirtualKeyCode: 13, key: 'Enter', code: 'Enter', text: '\r',
  });
  await page.send('Input.dispatchKeyEvent', {
    type: 'keyUp', windowsVirtualKeyCode: 13, key: 'Enter', code: 'Enter',
  });

  await page.sleep(300);

  check(
    'Enter キーでフォームが送信される',
    (await page.evaluate(
      'document.getElementById("login-message").querySelector(".auth-message__body")?.textContent ?? ""',
    )) === 'メールアドレスを入力してください。',
  );

  check(
    'Enter で送信してもページ遷移しない（入力値がURLに出ない）',
    (await page.evaluate('location.search')) === '',
  );

  /* ---------------------------------------------------------------- */
  section('パスワード表示切替');

  await page.goto(`${origin}/login/`);

  check(
    '初期状態は非表示',
    (await page.evaluate('document.getElementById("login-password").type')) === 'password',
  );

  check(
    '初期状態の aria-pressed は false',
    (await page.evaluate('document.getElementById("login-password-toggle").getAttribute("aria-pressed")')) === 'false',
  );

  check(
    'aria-label が付いている',
    (await page.evaluate('document.getElementById("login-password-toggle").getAttribute("aria-label")')) === 'パスワードを表示する',
  );

  check(
    'aria-controls で対象を示している',
    (await page.evaluate('document.getElementById("login-password-toggle").getAttribute("aria-controls")')) === 'login-password',
  );

  await page.evaluate('document.getElementById("login-password-toggle").click()');
  await page.sleep(100);

  check(
    '押すと平文表示になる',
    (await page.evaluate('document.getElementById("login-password").type')) === 'text',
  );

  check(
    'aria-pressed が true になる',
    (await page.evaluate('document.getElementById("login-password-toggle").getAttribute("aria-pressed")')) === 'true',
  );

  check(
    'aria-label も現在の状態に合わせて変わる',
    (await page.evaluate('document.getElementById("login-password-toggle").getAttribute("aria-label")')) === 'パスワードを非表示にする',
  );

  check(
    '切り替え後もフォーカスが入力欄へ戻る',
    (await page.evaluate('document.activeElement.id')) === 'login-password',
  );

  await page.evaluate('document.getElementById("login-password-toggle").click()');
  await page.sleep(100);

  check(
    'もう一度押すと非表示へ戻る',
    (await page.evaluate('document.getElementById("login-password").type')) === 'password',
  );

  /* ---------------------------------------------------------------- */
  section('二重送信の防止');

  await page.goto(`${origin}/tests/browser/fixtures/ui-harness.html`);

  await page.evaluate('document.getElementById("form").requestSubmit()');
  await page.sleep(150);

  check('1回目の送信が始まる', (await page.evaluate('window.__harness.submitCount')) === 1);

  check(
    '処理中はボタンが無効になる',
    await page.evaluate('document.getElementById("submit").disabled === true'),
  );

  check(
    '処理中の文言に変わる',
    (await page.evaluate('document.getElementById("submit").textContent')) === 'ログインしています…',
  );

  check(
    '処理中であることを支援技術へ伝える',
    (await page.evaluate('document.getElementById("submit").getAttribute("aria-busy")')) === 'true',
  );

  /* 無効化をすり抜けて requestSubmit を直接呼んでも、二重には走らない。 */
  await page.evaluate(`
    document.getElementById("form").requestSubmit();
    document.getElementById("form").requestSubmit();
    document.getElementById("form").requestSubmit();
  `);
  await page.sleep(200);

  check(
    '処理中に何度送信しても2回目は走らない',
    (await page.evaluate('window.__harness.submitCount')) === 1,
    await page.evaluate('window.__harness.submitCount'),
  );

  await page.evaluate('window.__harness.release()');
  await page.sleep(200);

  check(
    '処理が終わるとボタンが戻る',
    await page.evaluate('document.getElementById("submit").disabled === false'),
  );

  check(
    'ボタンの文言も元に戻る',
    (await page.evaluate('document.getElementById("submit").textContent')) === '送信する',
  );

  check(
    'aria-busy が外れる',
    await page.evaluate('document.getElementById("submit").getAttribute("aria-busy") === null'),
  );

  await page.evaluate('document.getElementById("form").requestSubmit()');
  await page.sleep(150);

  check('終了後は再び送信できる', (await page.evaluate('window.__harness.submitCount')) === 2);

  await page.evaluate('window.__harness.release()');
  await page.sleep(100);

  /* ---------------------------------------------------------------- */
  section('通信できないときの案内');

  /*
   * ------------------------------------------------------------------
   * 本番のエンドポイントへ実際に送らない（重要）
   * ------------------------------------------------------------------
   * auth/config.js の apiUrl には本番の Apps Script URL が入っている。
   * そのまま送信すると、テストのたびに本番へログイン要求が飛び、
   * 認証ログへ行が増え、パスワードハッシュの計算も消費される。
   *
   * そこで fetch を差し替えて通信を遮断し、
   * 「API へ到達できないときに画面が壊れず案内が出る」ことだけを確かめる。
   * ------------------------------------------------------------------
   */
  await page.goto(`${origin}/login/`);

  page.resetRequests();

  await page.evaluate(`
    window.__fetchCalls = 0;
    window.fetch = () => {
      window.__fetchCalls += 1;
      return Promise.reject(new TypeError('blocked by test'));
    };
  `);

  const unreachable = await submitAndReadMessage('taro@example.com', 'Password-For-Test-2026');

  check(
    '通信に失敗したら案内文を出す',
    unreachable === '通信に失敗しました。時間をおいて再度お試しください。',
    unreachable,
  );

  check(
    '送信は1回だけ試みる',
    (await page.evaluate('window.__fetchCalls')) === 1,
    await page.evaluate('window.__fetchCalls'),
  );

  check(
    '本番エンドポイントへ実際のリクエストが出ていない',
    page.getRequests().every((url) => !url.includes('script.google.com')),
    page.getRequests().filter((url) => url.includes('script.google.com')).join(' / '),
  );

  check(
    '失敗後にパスワード欄が消える（画面に残さない）',
    (await page.evaluate('document.getElementById("login-password").value')) === '',
  );

  check(
    '失敗後もボタンは押せる状態へ戻る',
    await page.evaluate('document.getElementById("login-submit").disabled === false'),
  );

  /* ---------------------------------------------------------------- */
  section('Portal のアクセス制御');

  await page.goto(`${origin}/portal/`);
  await page.evaluate('localStorage.clear()');
  await page.goto(`${origin}/portal/`, 1500);

  check(
    '未ログインではログイン画面へ送られる',
    (await page.evaluate('location.pathname')).includes('/login/'),
    await page.evaluate('location.pathname'),
  );

  check(
    '戻り先が引き継がれる',
    (await page.evaluate('new URLSearchParams(location.search).get("next")')) === 'portal',
  );

  /*
   * 写しだけを偽造しても入れないこと。
   *
   * 偽造トークンの検証を本番のエンドポイントへ問い合わせに行かせない。
   * 実際に送ると、本番の応答時間に結果が左右されて不安定になる。
   * サーバーが「そのトークンは無効」と答えた場合の挙動だけを見たいので、
   * 遷移をまたいで残る差し替えを入れ、応答を固定する。
   */
  const stub = await page.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      window.fetch = () => Promise.resolve(new Response(
        JSON.stringify({
          success: false,
          error: { code: 'SESSION_INVALID', message: 'ログインの有効期限が切れました。もう一度ログインしてください。' },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ));
    `,
  });

  await page.evaluate(`
    localStorage.setItem("tsam-auth-session", "forged-token-value");
    localStorage.setItem("tsam-auth-profile", JSON.stringify({ email: "attacker@example.com", role: "admin" }));
  `);

  page.resetRequests();
  await page.goto(`${origin}/portal/`, 1500);

  check(
    'ブラウザ側の値を偽造してもPortalへ入れない',
    (await page.evaluate('location.pathname')).includes('/login/'),
    await page.evaluate('location.pathname'),
  );

  check(
    '偽造トークンの検証で本番エンドポイントへ実際のリクエストが出ていない',
    page.getRequests().every((url) => !url.includes('script.google.com')),
    page.getRequests().filter((url) => url.includes('script.google.com')).join(' / '),
  );

  check(
    '無効と判定されたトークンは手元から消える',
    (await page.evaluate('localStorage.getItem("tsam-auth-session")')) === null,
  );

  check(
    '旧版の表示用の写しもログイン画面へ戻る過程で消える',
    (await page.evaluate('localStorage.getItem("tsam-auth-profile")')) === null,
  );

  /* 差し替えを外し、以降の確認へ持ち込まない。 */
  await page.send('Page.removeScriptToEvaluateOnNewDocument', {
    identifier: stub.result.identifier,
  });

  /*
   * 「確認が済むまで描画しない」ことは、配信されるHTMLそのもので確かめる。
   * 遷移が速いため画面を覗く方法では取り逃す。
   * hidden が最初から付いていれば、JS が動く前に中身が出ることはない。
   *
   * 差し替えは新しい文書にしか効かないため、いったん読み込み直して
   * 素の fetch を取り戻してから取得する。
   */
  await page.goto(`${origin}/login/`);

  const portalHtml = await page.evaluate(
    `fetch(${JSON.stringify(`${origin}/portal/`)}).then((r) => r.text())`,
  );

  check(
    '配信されるHTMLの時点で保護対象は hidden',
    /id="portal-content"\s+hidden/.test(portalHtml),
  );

  check(
    'HTMLに利用者情報が埋め込まれていない',
    !portalHtml.includes('@') || !/portal-user-email"[^>]*>[^<]+</.test(portalHtml),
  );

  check(
    '偽造したメールアドレスが画面に出ない',
    await page.evaluate('!document.body.textContent.includes("attacker@example.com")'),
  );

  await page.goto(`${origin}/login/`);
  await page.evaluate('localStorage.clear()');

  /* ---------------------------------------------------------------- */
  section('Portal のレイアウト（応答を固定して確認）');

  /*
   * ここから先はログイン済みの画面を見る。
   * 本番のエンドポイントへは送らず、verifySession の応答だけを差し替える。
   *
   * 差し替えるのは応答であって guardPage の手順ではない。
   * 「サーバーが有効と答えたときだけ描画する」という順序は本物のまま動く。
   */
  const portalStub = await page.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      window.fetch = (url, options) => {
        const body = JSON.parse(options?.body ?? '{}');

        if (body.action === 'verifySession') {
          return Promise.resolve(new Response(
            JSON.stringify({ success: true, data: { user: {
              email: 'member@example.com',
              role: 'member',
              isAdmin: false,
              subscriptionStatus: 'active',
              paymentExempt: false,
            } } }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ));
        }

        return Promise.resolve(new Response(
          JSON.stringify({ success: true, data: {} }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ));
      };
    `,
  });

  await page.evaluate('localStorage.setItem("tsam-auth-session", "stub-session-token")');
  await page.goto(`${origin}/portal/`, 1500);

  check(
    'セッションが有効なら内容が表示される',
    await page.evaluate('document.getElementById("portal-content").hidden === false'),
  );

  /* ---- ブランドブロックの不在 ---- */

  check(
    'ブランドブロック（auth-brand）が無い',
    await page.evaluate('document.querySelectorAll(".auth-brand").length === 0'),
    await page.evaluate('document.querySelectorAll(".auth-brand").length'),
  );

  check(
    '本文に社名の見出しを重ねて出さない（フッターの1回だけ）',
    (await page.evaluate(`
      [...document.querySelectorAll("main *")].filter(
        (el) => el.children.length === 0 && el.textContent.trim() === "TSアセットマネジメント合同会社").length
    `)) === 0,
  );

  check(
    '導入文「ご利用になるアプリを選択してください。」が無い',
    await page.evaluate('!document.body.textContent.includes("ご利用になるアプリを選択してください")'),
  );

  /* ---- ヘッダーバーの構成 ---- */

  check(
    'ヘッダーバーが1本だけある',
    await page.evaluate('document.querySelectorAll(".auth-portal-bar").length === 1'),
  );

  check(
    '見出しは「Portal」で、h1 のまま',
    await page.evaluate(`
      document.querySelector("h1").textContent.trim() === "Portal"
      && document.querySelector("h1").closest(".auth-portal-bar") !== null
    `),
  );

  check(
    'メールアドレスがヘッダーバーに出る',
    (await page.evaluate('document.getElementById("portal-user-email").textContent'))
      === 'member@example.com',
  );

  check(
    'ログアウトボタンがヘッダーバーにある',
    await page.evaluate(`
      document.getElementById("portal-logout").closest(".auth-portal-bar") !== null
    `),
  );

  check(
    '管理者でなければロールバッジは出ない',
    await page.evaluate('document.getElementById("portal-user-badge").hidden === true'),
  );

  /* 左＝Portal＋バッジ、右＝メール＋ログアウト。実際の座標で確かめる。 */
  const barLayout = await page.evaluate(`(() => {
    const bar = document.querySelector(".auth-portal-bar").getBoundingClientRect();
    const title = document.querySelector(".auth-portal-bar__title").getBoundingClientRect();
    const logout = document.getElementById("portal-logout").getBoundingClientRect();
    const email = document.getElementById("portal-user-email").getBoundingClientRect();

    return JSON.stringify({
      titleAtLeft: Math.abs(title.left - bar.left) < 2,
      logoutAtRight: Math.abs(bar.right - logout.right) < 2,
      emailBeforeLogout: email.right <= logout.left + 1,
      sameLine: Math.abs(title.top - logout.top) < 24,
      barHeight: bar.height,
    });
  })()`);

  const bar = JSON.parse(barLayout);

  check('左端が「Portal」', bar.titleAtLeft, barLayout);
  check('右端がログアウト', bar.logoutAtRight, barLayout);
  check('メールアドレスはログアウトの左', bar.emailBeforeLogout, barLayout);
  check('1行に収まる細い帯になっている', bar.sameLine && bar.barHeight < 90, barLayout);

  /* ---- APIキー未設定バナー ---- */

  check(
    'バナーの要素は用意されている',
    await page.evaluate('document.getElementById("portal-api-key-banner") !== null'),
  );

  check(
    'バナーは表示しない（キー管理画面が未実装のため）',
    await page.evaluate('document.getElementById("portal-api-key-banner").hidden === true'),
  );

  /*
   * textContent は隠れている要素も拾うため、描画結果で確かめる。
   * innerText は表示されている文字だけを返す。
   */
  check(
    'バナーの文言が画面に出ていない',
    await page.evaluate('!document.body.innerText.includes("Gemini APIキーが未設定です")'),
  );

  check(
    'バナーは面積を持たない',
    await page.evaluate(`
      document.getElementById("portal-api-key-banner").getBoundingClientRect().height === 0
    `),
  );

  check(
    '行き先の無いリンクを踏ませない（href が空のまま）',
    (await page.evaluate('document.getElementById("portal-api-key-link").getAttribute("href")')) === '',
  );

  /*
   * 表示条件そのものを呼んで確かめる。
   * 同じページの module は再読み込みされないため、
   * 画面が使っているのと同一の実装が返る。
   */
  const bannerLogic = JSON.parse(await page.evaluate(`
    import('./portal.js').then((m) => JSON.stringify({
      未設定と分かっていても: m.shouldShowApiKeyBanner({ geminiApiKeyConfigured: false }),
      サーバーが答えていない: m.shouldShowApiKeyBanner({}),
      設定済み: m.shouldShowApiKeyBanner({ geminiApiKeyConfigured: true }),
      利用者情報が無い: m.shouldShowApiKeyBanner(null),
    }))
  `));

  check(
    '遷移先が未定のうちは、どの状態でも表示しない',
    Object.values(bannerLogic).every((value) => value === false),
    JSON.stringify(bannerLogic),
  );

  /*
   * 将来有効化したときに崩れないことだけ、いま見ておく。
   * 表示条件を通さずに hidden を外し、体裁を確かめる。
   */
  await page.evaluate(`(() => {
    const banner = document.getElementById("portal-api-key-banner");
    document.getElementById("portal-api-key-link").href = "../portal/";
    banner.hidden = false;
  })()`);
  await page.sleep(120);

  check(
    '有効化したときは鍵の図・本文・導線がそろって出る',
    await page.evaluate(`(() => {
      const banner = document.getElementById("portal-api-key-banner");
      return banner.getBoundingClientRect().height > 0
        && banner.querySelector("svg") !== null
        && banner.innerText.includes("Gemini APIキーが未設定です。")
        && banner.querySelector(".auth-portal-banner__action") !== null;
    })()`),
  );

  check(
    '有効化してもアプリ一覧より上に出る',
    await page.evaluate(`
      document.getElementById("portal-api-key-banner").getBoundingClientRect().bottom
      <= document.getElementById("portal-apps").getBoundingClientRect().top + 1
    `),
  );

  /* 320px でも折り返して収まること（有効化したときに初めて分かっては遅い）。 */
  await page.setViewport(320, 900);
  await page.sleep(150);

  check(
    '有効化しても320pxで横スクロールしない',
    (await page.evaluate(
      'document.documentElement.scrollWidth - document.documentElement.clientWidth',
    )) <= 0,
  );

  await page.clearViewport();
  await page.sleep(120);

  await page.evaluate(`(() => {
    document.getElementById("portal-api-key-banner").hidden = true;
    document.getElementById("portal-api-key-link").setAttribute("href", "");
  })()`);

  /* ---- アプリグリッド ---- */

  check(
    'apps.js が空なので案内文が出る',
    await page.evaluate(`
      document.getElementById("portal-apps-empty").hidden === false
      && document.getElementById("portal-apps").children.length === 0
    `),
  );

  check(
    '案内文は従来どおり',
    (await page.evaluate('document.getElementById("portal-apps-empty").textContent.trim()'))
      === 'ご利用可能なアプリは順次追加されます。',
  );

  /* ---- アカウント情報 ---- */

  check(
    'アカウント情報が下部の小型カードになっている',
    await page.evaluate(`
      document.querySelector(".auth-account") !== null
      && document.querySelector(".auth-account").getBoundingClientRect().top
         > document.getElementById("portal-apps-empty").getBoundingClientRect().top
    `),
  );

  check(
    'メールと契約状態が1行に並ぶ',
    await page.evaluate(`(() => {
      const email = document.getElementById("portal-account-email").getBoundingClientRect();
      const state = document.getElementById("portal-account-subscription").getBoundingClientRect();
      return Math.abs(email.top - state.top) < 2 && state.left > email.left;
    })()`),
  );

  check(
    '契約状態は内部値ではなく日本語で出る',
    (await page.evaluate('document.getElementById("portal-account-subscription").textContent'))
      === 'ご利用中',
  );

  check(
    'パスワード変更への導線が残っている',
    await page.evaluate(`
      [...document.querySelectorAll(".auth-account a")].some(
        (a) => a.getAttribute("href") === "../password/reset/")
    `),
  );

  /* ---- ダミーのアプリを入れてカードの体裁を見る ---- */

  await page.evaluate(`(() => {
    const list = document.getElementById("portal-apps");
    document.getElementById("portal-apps-empty").hidden = true;

    for (const app of [
      { name: '音声録音・MP3変換', desc: '会議の録音をMP3にします。', icon: '録' },
      { name: 'ナレッジチャット', desc: '社内資料に質問できます。', icon: '' },
      { name: '名刺読み取り', desc: '名刺を一覧にします。', icon: '' },
    ]) {
      const item = document.createElement('li');
      item.className = 'auth-app-card';

      const link = document.createElement('a');
      link.className = 'auth-app-card__link';
      link.href = '../portal/';

      const icon = document.createElement('span');
      icon.className = 'auth-app-card__icon';
      icon.textContent = app.icon !== '' ? app.icon : app.name.slice(0, 1);
      icon.setAttribute('aria-hidden', 'true');
      link.append(icon);

      const name = document.createElement('h2');
      name.className = 'auth-app-card__name';
      name.textContent = app.name;
      link.append(name);

      const desc = document.createElement('p');
      desc.className = 'auth-app-card__desc';
      desc.textContent = app.desc;
      link.append(desc);

      item.append(link);
      list.append(item);
    }
  })()`);

  await page.sleep(150);

  check(
    'カードはアイコン・名前・説明の3つを持つ',
    await page.evaluate(`
      [...document.querySelectorAll(".auth-app-card")].every((card) =>
        card.querySelector(".auth-app-card__icon")
        && card.querySelector(".auth-app-card__name")
        && card.querySelector(".auth-app-card__desc"))
    `),
  );

  check(
    'カード全体が1つのリンクになっている',
    await page.evaluate(`
      [...document.querySelectorAll(".auth-app-card")].every((card) =>
        card.children.length === 1 && card.firstElementChild.tagName === "A")
    `),
  );

  check(
    'カードの角丸が12px',
    await page.evaluate(`
      getComputedStyle(document.querySelector(".auth-app-card__link")).borderTopLeftRadius === "12px"
    `),
    await page.evaluate('getComputedStyle(document.querySelector(".auth-app-card__link")).borderTopLeftRadius'),
  );

  check(
    'カードの中身が中央寄せ',
    await page.evaluate(`
      getComputedStyle(document.querySelector(".auth-app-card__link")).textAlign === "center"
    `),
  );

  check(
    'アイコンが省略されたら名前の1文字目を使う',
    (await page.evaluate('document.querySelectorAll(".auth-app-card__icon")[1].textContent')) === 'ナ',
  );

  /* ---- 画面幅ごとの列数と横スクロール ---- */

  const PORTAL_WIDTHS = [
    [320, 1],
    [375, 1],
    [768, 3],
    [1024, 3],
    [1440, 3],
  ];

  /* 同じ高さに並ぶカードの数を数えて、実際の列数を測る。 */
  const COLUMN_PROBE = `(() => {
    const cards = [...document.querySelectorAll(".auth-app-card")];
    const top = Math.min(...cards.map((c) => c.getBoundingClientRect().top));
    return cards.filter((c) => Math.abs(c.getBoundingClientRect().top - top) < 2).length;
  })()`;

  for (const [width, expected] of PORTAL_WIDTHS) {
    await page.setViewport(width, 900);
    await page.goto(`${origin}/portal/`, 1200);

    /* 遷移でカードは消えるため、幅ごとに入れ直す。 */
    await page.evaluate(`(() => {
      const list = document.getElementById("portal-apps");
      for (let i = 0; i < 3; i += 1) {
        const item = document.createElement('li');
        item.className = 'auth-app-card';
        const link = document.createElement('a');
        link.className = 'auth-app-card__link';
        link.href = '../portal/';
        link.textContent = 'テスト用アプリ' + (i + 1);
        item.append(link);
        list.append(item);
      }
    })()`);
    await page.sleep(120);

    check(
      `${width}px: アプリが${expected}列に並ぶ`,
      (await page.evaluate(COLUMN_PROBE)) === expected,
      await page.evaluate(COLUMN_PROBE),
    );

    const overflow = await page.evaluate(
      'document.documentElement.scrollWidth - document.documentElement.clientWidth',
    );
    check(`${width}px: 横スクロールしない`, overflow <= 0, overflow);

    check(
      `${width}px: ヘッダーバーが表示領域からはみ出さない`,
      await page.evaluate(`(() => {
        const bar = document.querySelector(".auth-portal-bar").getBoundingClientRect();
        return bar.left >= -1 && bar.right <= document.documentElement.clientWidth + 1;
      })()`),
    );
  }

  await page.clearViewport();

  /* ---- 管理者のときだけロールバッジが出る ---- */

  await page.send('Page.removeScriptToEvaluateOnNewDocument', {
    identifier: portalStub.result.identifier,
  });

  const adminStub = await page.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      window.fetch = () => Promise.resolve(new Response(
        JSON.stringify({ success: true, data: { user: {
          email: 'architect@example.com',
          role: 'admin',
          isAdmin: true,
          subscriptionStatus: 'exempt',
          paymentExempt: true,
        } } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ));
    `,
  });

  await page.goto(`${origin}/portal/`, 1500);

  check(
    '管理者にはロールバッジが出る',
    await page.evaluate(`
      document.getElementById("portal-user-badge").hidden === false
      && document.getElementById("portal-user-badge").textContent === "管理者"
    `),
  );

  check(
    'バッジは見出しの右隣（ヘッダーバーの左ブロック）に入る',
    await page.evaluate(`
      document.getElementById("portal-user-badge").closest(".auth-portal-bar__identity") !== null
    `),
  );

  check(
    '決済不要の管理者はその旨が出る',
    (await page.evaluate('document.getElementById("portal-account-subscription").textContent'))
      === '決済不要（管理者）',
  );

  await page.send('Page.removeScriptToEvaluateOnNewDocument', {
    identifier: adminStub.result.identifier,
  });

  await page.goto(`${origin}/login/`);
  await page.evaluate('localStorage.clear()');

  /* ---------------------------------------------------------------- */
  section('その他の画面');

  const screens = [
    ['/pricing/', '料金プランの選択'],
    ['/password/setup/', 'パスワードの初期設定'],
    ['/password/reset/', 'パスワードの再設定'],
    ['/payment/success/', 'お申し込みを受け付けました'],
    ['/payment/cancel/', 'お申し込みを中止しました'],
    ['/logout/', 'ログアウト'],
  ];

  for (const [path, heading] of screens) {
    await page.goto(`${origin}${path}`, 1200);

    const actual = await page.evaluate('document.querySelector("h1")?.textContent ?? ""');
    check(`${path} の見出しが「${heading}」`, actual === heading, actual);

    await page.setViewport(320, 900);
    await page.goto(`${origin}${path}`, 800);
    const overflow = await page.evaluate(
      'document.documentElement.scrollWidth - document.documentElement.clientWidth',
    );
    check(`${path} が320pxで横スクロールしない`, overflow <= 0, overflow);
    await page.clearViewport();
  }

  /* ---- パスワード初期設定はトークン無しでは入力させない ---- */
  await page.goto(`${origin}/password/setup/`, 1200);

  check(
    'トークンが無ければ入力フォームを出さない',
    await page.evaluate('document.getElementById("setup-form").hidden === true'),
  );

  check(
    'やり直しの案内を出す',
    (await page.evaluate(
      'document.getElementById("setup-message").querySelector(".auth-message__body")?.textContent ?? ""',
    )).includes('もう一度手続きをやり直してください'),
  );

  await page.goto(`${origin}/password/setup/?token=abcDEF123456`, 1200);

  check(
    'トークンがあれば入力フォームを出す',
    await page.evaluate('document.getElementById("setup-form").hidden === false'),
  );

  check(
    '読み取り後はURLからトークンを消す',
    (await page.evaluate('location.search')) === '',
    await page.evaluate('location.search'),
  );

  /* ---- パスワード再設定の段階切り替え ---- */
  await page.goto(`${origin}/password/reset/`, 1200);

  check(
    'トークン無しではメールアドレス入力を出す',
    await page.evaluate('document.getElementById("reset-step-request").hidden === false'),
  );

  check(
    '新しいパスワードの入力は出さない',
    await page.evaluate('document.getElementById("reset-step-set").hidden === true'),
  );

  /*
   * 再設定の申し込みは、本番へ送ると実際にメールが飛びうる操作である。
   * サーバーは登録の有無にかかわらず成功を返す仕様なので、
   * その応答を固定したうえで画面の文言だけを確かめる。
   */
  await page.evaluate(`
    window.fetch = () => Promise.resolve(new Response(
      JSON.stringify({ success: true, data: {} }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    document.getElementById("request-email").value = "nobody@example.com";
    document.getElementById("request-form").requestSubmit();
  `);
  await page.sleep(400);

  check(
    'メール送信の案内は登録の有無を示さない文言',
    (await page.evaluate(
      'document.getElementById("request-message").querySelector(".auth-message__body")?.textContent ?? ""',
    )) === '登録されているメールアドレスの場合、パスワード再設定のご案内を送信しました。',
    await page.evaluate(
      'document.getElementById("request-message").querySelector(".auth-message__body")?.textContent ?? ""',
    ),
  );

  await page.goto(`${origin}/password/reset/?token=abcDEF123456`, 1200);

  check(
    'トークンがあれば新しいパスワードの入力を出す',
    await page.evaluate('document.getElementById("reset-step-set").hidden === false'),
  );

  check(
    'メールアドレス入力は隠す',
    await page.evaluate('document.getElementById("reset-step-request").hidden === true'),
  );

  /* ---- 料金プラン画面 ---- */
  await page.goto(`${origin}/pricing/`, 1200);

  check(
    'ログイン画面へ戻るリンクがある',
    await page.evaluate(`
      [...document.querySelectorAll("a")].some((a) => a.getAttribute("href") === "../login/")
    `),
  );

  check(
    '自動更新の有無を明示している',
    await page.evaluate('document.body.textContent.includes("自動更新")'),
  );

  check(
    '解約条件を明示している',
    await page.evaluate('document.body.textContent.includes("解約")'),
  );

  check(
    '支払周期を明示している',
    await page.evaluate('document.body.textContent.includes("支払周期")'),
  );

  check(
    'HTMLに料金を直書きしていない（サーバーから取得する）',
    await page.evaluate('document.getElementById("pricing-plans").children.length === 0'),
  );

  check(
    'Price ID をHTMLへ埋め込んでいない',
    await page.evaluate('!document.documentElement.innerHTML.includes("price_")'),
  );

  check(
    '同意項目の文言をHTMLへ直書きしていない（サーバーから取得する）',
    await page.evaluate('document.getElementById("pricing-consent-items").children.length === 0'),
  );

  check(
    '確認表もHTMLへ直書きしていない',
    await page.evaluate('document.getElementById("pricing-consent-sections").children.length === 0'),
  );

  check(
    'プランを選ぶまで同意セクションを出さない',
    await page.evaluate('document.getElementById("pricing-consent").hidden === true'),
  );

  /* ---------------------------------------------------------------- */
  section('法務ページ');

  const legalPages = [
    ['/legal/terms/', '利用規約', 'TSAM AI 利用規約'],
    ['/legal/privacy/', 'プライバシーポリシー', 'TSAM AI プライバシーポリシー'],
    ['/legal/tokusho/', '特定商取引法に基づく表記', '特定商取引法に基づく表記'],
  ];

  for (const [path, label, heading] of legalPages) {
    await page.goto(`${origin}${path}`, 900);

    const actual = await page.evaluate('document.querySelector("h1")?.textContent ?? ""');
    check(`${path} の見出しが「${heading}」`, actual === heading, actual);

    check(
      `${path} に制定日と版が出る`,
      await page.evaluate('document.body.textContent.includes("2026年7月30日 制定")')
      && await page.evaluate('document.body.textContent.includes("Version 1.0")'),
    );

    /* 法務確認コメントと草案注記は公開ページに出さない。 */
    check(
      `${path} に法務確認コメントが残っていない`,
      await page.evaluate('!document.body.textContent.includes("法務確認コメント")'),
    );

    check(
      `${path} に草案の注記が残っていない`,
      await page.evaluate(`
        !document.body.textContent.includes("弁護士による確認を受けることを推奨")
        && !document.body.textContent.includes("DRAFT")
        && !document.body.textContent.includes("要確認リスト")
      `),
    );

    await page.setViewport(320, 900);
    await page.goto(`${origin}${path}`, 700);

    const overflow = await page.evaluate(
      'document.documentElement.scrollWidth - document.documentElement.clientWidth',
    );
    check(`${path} が320pxで横スクロールしない`, overflow <= 0, overflow);
    await page.clearViewport();

    /* ラベルだけ使って未使用変数を作らない。 */
    check(`${path} のタイトルに「${label}」が入る`, (await page.evaluate('document.title')).includes(label));
  }

  await page.goto(`${origin}/legal/tokusho/`, 900);

  check(
    '特商法に適格請求書発行事業者登録番号が出る',
    await page.evaluate('document.body.textContent.includes("T3021003007473")'),
  );

  check(
    '特商法に請求書・領収書の扱いが出る',
    await page.evaluate('document.body.textContent.includes("領収書メール")'),
  );

  check(
    '特商法に月額550円が出る',
    await page.evaluate('document.body.textContent.includes("550円")'),
  );

  check(
    '特商法に1年間継続の目安が出る',
    await page.evaluate('document.body.textContent.includes("6,600円")'),
  );

  /* ---------------------------------------------------------------- */
  section('法務ページの表：四辺の罫線が閉じること');

  /*
   * 罫線は行の重なりを避けるため、隣り合うセルで片側ずつ落としてある。
   * その「落とす側」を1行ぶん間違えると、表の外周のどこかが開く。
   * 実際、768px 以上で1行目の td から上罫線が落ち、右上角が欠けていた。
   *
   * 見た目の欠けを機械で捉えるため、
   *   1. 全セルを「同じ高さに並んでいる行」へまとめ直し
   *   2. 最上段の各セルに上罫線、最下段に下罫線
   *   3. 各段の左端に左罫線、右端に右罫線
   *   4. 最上段・最下段の幅の合計が表の幅を覆っているか
   * を確かめる。4 があるので「一部のセルにしか罫線が無い」状態も落ちる。
   *
   * 320px では th と td が積み上がるため段の数が変わる。
   * 段の作り方を実測に任せることで、どちらの組み方でも同じ判定になる。
   */
  const BORDER_PROBE = `(() => {
    const table = document.querySelector('.auth-legal__table');

    if (!table) {
      return JSON.stringify({ hasTable: false });
    }

    const box = table.getBoundingClientRect();
    const cells = [...table.querySelectorAll('th, td')];

    const drawn = (el, side) => {
      const style = getComputedStyle(el);
      return parseFloat(style['border' + side + 'Width']) > 0
        && style['border' + side + 'Style'] !== 'none';
    };

    /* 同じ高さに並ぶセルを1段としてまとめる。 */
    const lines = [];

    for (const cell of cells) {
      const rect = cell.getBoundingClientRect();
      const line = lines.find((item) => Math.abs(item.top - rect.top) < 1.5);

      if (line) {
        line.cells.push({ cell, rect });
      } else {
        lines.push({ top: rect.top, cells: [{ cell, rect }] });
      }
    }

    lines.sort((a, b) => a.top - b.top);
    lines.forEach((line) => line.cells.sort((a, b) => a.rect.left - b.rect.left));

    const first = lines[0];
    const last = lines[lines.length - 1];
    const span = (line) => line.cells.reduce((sum, item) => sum + item.rect.width, 0);

    return JSON.stringify({
      hasTable: true,
      lines: lines.length,
      topDrawn: first.cells.every((item) => drawn(item.cell, 'Top')),
      bottomDrawn: last.cells.every((item) => drawn(item.cell, 'Bottom')),
      leftDrawn: lines.every((line) => drawn(line.cells[0].cell, 'Left')),
      rightDrawn: lines.every((line) => drawn(line.cells[line.cells.length - 1].cell, 'Right')),
      topCovered: Math.abs(span(first) - box.width) < 2,
      bottomCovered: Math.abs(span(last) - box.width) < 2,
    });
  })()`;

  const BORDER_WIDTHS = [320, 375, 768, 1024, 1440];

  for (const [path] of legalPages) {
    for (const width of BORDER_WIDTHS) {
      await page.setViewport(width, 900);
      await page.goto(`${origin}${path}`, 700);

      const probe = JSON.parse(await page.evaluate(BORDER_PROBE));

      if (!probe.hasTable) {
        check(`${path} ${width}px: 表を持たないページ（条単位のため）`, true);
        continue;
      }

      check(
        `${path} ${width}px: 上辺が端から端まで閉じている`,
        probe.topDrawn && probe.topCovered,
        JSON.stringify(probe),
      );

      check(
        `${path} ${width}px: 下辺が端から端まで閉じている`,
        probe.bottomDrawn && probe.bottomCovered,
        JSON.stringify(probe),
      );

      check(
        `${path} ${width}px: 左右の辺が全段で閉じている`,
        probe.leftDrawn && probe.rightDrawn,
        JSON.stringify(probe),
      );
    }
  }

  await page.clearViewport();

  /* ---------------------------------------------------------------- */
  section('「準備中」表記が残っていないこと');

  for (const path of ['/login/', '/pricing/']) {
    await page.goto(`${origin}${path}`, 1000);

    check(
      `${path} に「準備中」が無い`,
      await page.evaluate('!document.body.textContent.includes("準備中")'),
    );

    check(
      `${path} から利用規約へリンクしている`,
      await page.evaluate(`
        [...document.querySelectorAll("a")].some((a) => a.getAttribute("href")?.includes("legal/terms/"))
      `),
    );

    check(
      `${path} からプライバシーポリシーへリンクしている`,
      await page.evaluate(`
        [...document.querySelectorAll("a")].some((a) => a.getAttribute("href")?.includes("legal/privacy/"))
      `),
    );
  }

  await page.goto(`${origin}/pricing/`, 1000);

  check(
    '/pricing/ から特定商取引法の表記へリンクしている',
    await page.evaluate(`
      [...document.querySelectorAll("a")].some((a) => a.getAttribute("href")?.includes("legal/tokusho/"))
    `),
  );

  /* ---------------------------------------------------------------- */
  section('同意フロー（応答を固定して確認）');

  /*
   * 本番のエンドポイントへ送らず、listPlans と listConsentConfig の
   * 応答を差し替えて画面の挙動だけを確かめる。
   */
  const consentStub = await page.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      window.__checkoutCalls = [];
      window.fetch = (url, options) => {
        const target = String(url);
        const reply = (data) => Promise.resolve(new Response(
          JSON.stringify({ success: true, data }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ));

        if (target.includes('action=listPlans')) {
          return reply({ plans: [{
            planCode: 'standard', planName: 'スタンダード',
            amount: '550', currency: 'jpy', interval: 'month',
            features: ['TSAM AI の各種アプリ'],
          }] });
        }

        if (target.includes('action=listConsentConfig')) {
          return reply({
            tosVersion: '1.0',
            warningText: 'これはテスト用の警告文です。',
            consentItems: [
              { itemId: 'tos', label: '{terms}および{privacy}に同意します。', required: true, sortOrder: 1 },
              { itemId: 'auto_renew', label: '自動更新であることを確認しました。', required: true, sortOrder: 2 },
              { itemId: 'optional_note', label: '任意の項目です（{tokusho}）。', required: false, sortOrder: 3 },
            ],
            confirmSections: [
              { section: '料金と支払い', items: [
                { label: '月額料金', value: '550円（税込）', emphasis: true },
                { label: '支払方法', value: 'クレジットカード', emphasis: false },
              ] },
              { section: '解約', items: [
                { label: '返金', value: '返金なし', emphasis: true },
              ] },
            ],
          });
        }

        /*
         * createCheckoutSession は記録するだけにする。
         * 別ページへ遷移させると記録ごと失われるため、
         * 同じページのハッシュだけを変える URL を返す（再読み込みが起きない）。
         */
        window.__checkoutCalls.push(JSON.parse(options.body));
        return reply({
          checkoutUrl: location.href.split('#')[0] + '#stubbed-checkout',
          checkoutSessionId: 'cs_stub',
        });
      };
    `,
  });

  await page.goto(`${origin}/pricing/`, 1500);

  check(
    'プランが描画される',
    (await page.evaluate('document.getElementById("pricing-plans").children.length')) === 1,
  );

  check(
    'この時点では同意セクションは隠れている',
    await page.evaluate('document.getElementById("pricing-consent").hidden === true'),
  );

  await page.evaluate(`document.querySelector('button[data-plan-code="standard"]').click()`);
  await page.sleep(300);

  check(
    'プランを選ぶと同意セクションが出る',
    await page.evaluate('document.getElementById("pricing-consent").hidden === false'),
  );

  check(
    '選択中のプランが表示される',
    (await page.evaluate('document.getElementById("pricing-consent-selected").textContent')).includes('スタンダード'),
  );

  check(
    '警告文がサーバーの値で表示される',
    (await page.evaluate('document.getElementById("pricing-consent-warning-body").textContent'))
      === 'これはテスト用の警告文です。',
  );

  check(
    '確認表が2セクション描画される',
    (await page.evaluate('document.getElementById("pricing-consent-sections").children.length')) === 2,
  );

  check(
    '強調指定の値に印が付く',
    await page.evaluate(`
      document.querySelectorAll('#pricing-consent-sections td[data-emphasis="true"]').length === 2
    `),
  );

  check(
    'チェック項目が3件描画される',
    (await page.evaluate('document.getElementById("pricing-consent-items").children.length')) === 3,
  );

  check(
    '{terms} が利用規約リンクへ展開される',
    await page.evaluate(`
      [...document.querySelectorAll('#pricing-consent-items a')].some(
        (a) => a.textContent === '利用規約' && a.getAttribute('href') === '../legal/terms/')
    `),
  );

  check(
    '{privacy} と {tokusho} も展開される',
    await page.evaluate(`
      [...document.querySelectorAll('#pricing-consent-items a')].some((a) => a.getAttribute('href') === '../legal/privacy/')
      && [...document.querySelectorAll('#pricing-consent-items a')].some((a) => a.getAttribute('href') === '../legal/tokusho/')
    `),
  );

  check(
    '差し込み記法が画面に残らない',
    await page.evaluate(`!document.getElementById("pricing-consent-items").textContent.includes("{")`),
  );

  check(
    '必須項目に（必須）が付く',
    (await page.evaluate(`
      document.querySelectorAll('#pricing-consent-items .auth-consent__required').length
    `)) === 2,
  );

  check(
    'チェックボックスに label が結び付いている',
    await page.evaluate(`
      [...document.querySelectorAll('#pricing-consent-items input[type=checkbox]')].every(
        (box) => document.querySelector('label[for="' + box.id + '"]') !== null)
    `),
  );

  check(
    '未チェックではボタンが無効',
    await page.evaluate('document.getElementById("pricing-consent-submit").disabled === true'),
  );

  /* 必須を1つだけチェックしても、まだ進めない。 */
  await page.evaluate(`
    document.getElementById("consent-tos").click();
  `);
  await page.sleep(150);

  check(
    '必須が一部だけではボタンが無効のまま',
    await page.evaluate('document.getElementById("pricing-consent-submit").disabled === true'),
  );

  /* 任意項目をチェックしても、必須が揃わなければ進めない。 */
  await page.evaluate('document.getElementById("consent-optional_note").click()');
  await page.sleep(150);

  check(
    '任意項目では必須の代わりにならない',
    await page.evaluate('document.getElementById("pricing-consent-submit").disabled === true'),
  );

  await page.evaluate('document.getElementById("consent-auto_renew").click()');
  await page.sleep(150);

  check(
    '必須が全部そろうとボタンが有効になる',
    await page.evaluate('document.getElementById("pricing-consent-submit").disabled === false'),
  );

  /* 必須を外すと、また無効に戻る。 */
  await page.evaluate('document.getElementById("consent-tos").click()');
  await page.sleep(150);

  check(
    '必須を外すと無効へ戻る',
    await page.evaluate('document.getElementById("pricing-consent-submit").disabled === true'),
  );

  await page.evaluate('document.getElementById("consent-tos").click()');
  await page.sleep(150);

  /* 送信内容を確かめる。 */
  await page.evaluate('document.getElementById("pricing-consent-form").requestSubmit()');
  await page.sleep(500);

  const sent = await page.evaluate('JSON.stringify(window.__checkoutCalls)');
  const calls = JSON.parse(sent);

  check('申し込みが1回だけ送られる', calls.length === 1, calls.length);
  check('action が createCheckoutSession', calls[0]?.action === 'createCheckoutSession');
  check('プランコードを送る', calls[0]?.planCode === 'standard');
  check('tosVersion を送る', calls[0]?.tosVersion === '1.0');

  check(
    'チェックした項目だけを送る',
    JSON.stringify((calls[0]?.agreedItems ?? []).slice().sort())
      === JSON.stringify(['auto_renew', 'optional_note', 'tos']),
    JSON.stringify(calls[0]?.agreedItems),
  );

  check(
    'Price ID を送らない',
    !JSON.stringify(calls[0]).includes('price_'),
  );

  /* プランを選び直すと同意はやり直しになる。 */
  await page.goto(`${origin}/pricing/`, 1500);
  await page.evaluate(`document.querySelector('button[data-plan-code="standard"]').click()`);
  await page.sleep(200);
  await page.evaluate(`
    document.getElementById("consent-tos").click();
    document.getElementById("consent-auto_renew").click();
  `);
  await page.sleep(150);
  await page.evaluate('document.getElementById("pricing-consent-back").click()');
  await page.sleep(200);
  await page.evaluate(`document.querySelector('button[data-plan-code="standard"]').click()`);
  await page.sleep(200);

  check(
    'プランを選び直すとチェックが外れる',
    await page.evaluate(`
      [...document.querySelectorAll('#pricing-consent-items input[type=checkbox]')].every((box) => !box.checked)
    `),
  );

  check(
    '選び直した直後はボタンが無効',
    await page.evaluate('document.getElementById("pricing-consent-submit").disabled === true'),
  );

  await page.send('Page.removeScriptToEvaluateOnNewDocument', {
    identifier: consentStub.result.identifier,
  });

  /* ---------------------------------------------------------------- */
  section('プロジェクトPages配信（サブパス）でも壊れない');

  await page.setViewport(375, 900);
  await page.goto(`${subpathOrigin}/login/`, 1200);

  check(
    'サブパス配信でもログイン画面が出る',
    (await page.evaluate('document.querySelector("h1")?.textContent ?? ""')) === 'ログイン',
  );

  check(
    'サブパス配信でもCSSが当たる',
    await page.evaluate(`
      getComputedStyle(document.querySelector(".auth-card")).borderStyle === "solid"
    `),
  );

  check(
    'サブパス配信でも申し込み導線が同じ配信下を指す',
    (await page.evaluate('document.getElementById("login-signup").href'))
      .includes('/ts-corporate-renewal/pricing/'),
    await page.evaluate('document.getElementById("login-signup").href'),
  );

  await page.goto(`${subpathOrigin}/portal/`, 1500);

  check(
    'サブパス配信でも未ログインならログイン画面へ戻る',
    (await page.evaluate('location.pathname')).includes('/ts-corporate-renewal/login/'),
    await page.evaluate('location.pathname'),
  );

  await page.clearViewport();

  /* ---------------------------------------------------------------- */
  section('外部通信とコンソール');

  page.resetRequests();
  await page.goto(`${origin}/login/`, 1200);

  const requests = page.getRequests();
  const external = requests.filter((url) => (
    !url.startsWith(origin) && !url.startsWith('data:') && !url.startsWith('about:')
  ));

  check(
    '外部通信はフォント取得だけ',
    external.every((url) => url.includes('fonts.googleapis.com') || url.includes('fonts.gstatic.com')),
    external.join(' / '),
  );

  check(
    '解析タグや広告タグを読み込まない',
    external.every((url) => !/googletagmanager|google-analytics|doubleclick/.test(url)),
  );

  const errors = page.consoleErrors.filter((text) => (
    /* 404 などネットワーク系のブラウザ既定メッセージは対象外。 */
    !text.includes('Failed to load resource')
  ));

  check('コンソールにエラーが出ていない', errors.length === 0, errors.join(' | '));

  finish();
} catch (error) {
  fatal(error);
} finally {
  if (suite) {
    await suite.close();
  }
}

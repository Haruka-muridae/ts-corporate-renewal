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

import { check, section, finish, fatal } from '../../public/apps/tests/helpers/assert.mjs';
import { startSuite } from '../../public/apps/tests/helpers/browser-harness.mjs';

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
    !portalHtml.includes('@') || !/portal-account-email"[^>]*>[^<]+</.test(portalHtml),
  );

  /*
   * アカウント情報パネルは配信時点でも閉じている。
   * 中身は空だが、閉じた状態で配られることを HTML そのもので押さえる。
   */
  check(
    '配信されるHTMLの時点でアカウント情報パネルは閉じている',
    /id="portal-account-panel"[^>]*\shidden/.test(portalHtml),
  );

  check(
    '配信されるHTMLの時点で aria-expanded は false',
    /id="portal-account-toggle"[\s\S]{0,200}?aria-expanded="false"/.test(portalHtml),
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
    await page.evaluate('document.querySelector("h1").textContent.trim()'),
  );

  /*
   * メールアドレスはアカウント情報パネルへ移した。
   * 帯には出さない（要素ごと存在しない）。
   */
  check(
    'ヘッダーバーにメールアドレスを出さない',
    await page.evaluate(`
      document.getElementById("portal-user-email") === null
      && !document.querySelector(".auth-portal-bar").textContent.includes("member@example.com")
    `),
    await page.evaluate('document.querySelector(".auth-portal-bar").textContent.trim()'),
  );

  check(
    'ログアウトボタンがヘッダーバーにある',
    await page.evaluate(`
      document.getElementById("portal-logout").closest(".auth-portal-bar") !== null
    `),
  );

  /* 帯にあるのは3つだけ。押せるものが他に無いことを数で押さえる。 */
  check(
    'ヘッダーバーの押せる要素はアカウント・API設定・ログアウトの3つだけ',
    (await page.evaluate(`
      JSON.stringify([...document.querySelectorAll(".auth-portal-bar button, .auth-portal-bar a")]
        .map((el) => el.id))
    `)) === JSON.stringify(['portal-account-toggle', 'portal-api-toggle', 'portal-logout']),
    await page.evaluate(`
      JSON.stringify([...document.querySelectorAll(".auth-portal-bar button, .auth-portal-bar a")]
        .map((el) => el.id || el.tagName))
    `),
  );

  check(
    '管理者でなければロールバッジは出ない',
    await page.evaluate('document.getElementById("portal-user-badge").hidden === true'),
  );

  /* 左＝Portal＋逆三角＋バッジ、右＝ログアウト。実際の座標で確かめる。 */
  const barLayout = await page.evaluate(`(() => {
    const bar = document.querySelector(".auth-portal-bar").getBoundingClientRect();
    const title = document.querySelector(".auth-portal-bar__title").getBoundingClientRect();
    const logout = document.getElementById("portal-logout").getBoundingClientRect();
    const chevron = document.querySelector(".auth-portal-bar__chevron").getBoundingClientRect();

    return JSON.stringify({
      titleAtLeft: Math.abs(title.left - bar.left) < 2,
      logoutAtRight: Math.abs(bar.right - logout.right) < 2,
      chevronBeforeLogout: chevron.right <= logout.left + 1,
      sameLine: Math.abs(title.top - logout.top) < 24,
      barHeight: bar.height,
    });
  })()`);

  const bar = JSON.parse(barLayout);

  check('左端が「Portal」', bar.titleAtLeft, barLayout);
  check('右端がログアウト', bar.logoutAtRight, barLayout);
  check('逆三角はログアウトの左（左ブロック側）', bar.chevronBeforeLogout, barLayout);
  check('1行に収まる細い帯になっている', bar.sameLine && bar.barHeight < 90, barLayout);

  /* ---- APIキー未設定バナー（KeyStore が未保存のあいだ出る） ---- */

  check(
    'バナーの要素は用意されている',
    await page.evaluate('document.getElementById("portal-api-key-banner") !== null'),
  );

  check(
    'キーが未保存なのでバナーが出る',
    await page.evaluate(`
      document.getElementById("portal-api-key-banner").hidden === false
      && document.getElementById("portal-api-key-banner").getBoundingClientRect().height > 0
    `),
  );

  check(
    '鍵の図・本文・導線がそろって出る',
    await page.evaluate(`(() => {
      const banner = document.getElementById("portal-api-key-banner");
      return banner.querySelector("svg") !== null
        && banner.innerText.includes("Gemini APIキーが未設定です。")
        && banner.querySelector(".auth-portal-banner__action") !== null;
    })()`),
  );

  check(
    'アプリ一覧より上に出る',
    await page.evaluate(`
      document.getElementById("portal-api-key-banner").getBoundingClientRect().bottom
      <= document.getElementById("portal-apps").getBoundingClientRect().top + 1
    `),
  );

  /*
   * 導線はページ移動ではない。button であり、href を持たない。
   * a のままだと、押した瞬間に画面が切り替わってしまう。
   */
  check(
    '導線はリンクではなくボタン',
    await page.evaluate(`
      document.getElementById("portal-api-key-action").tagName === "BUTTON"
      && document.getElementById("portal-api-key-action").getAttribute("href") === null
    `),
  );

  /*
   * 表示条件そのものを呼んで確かめる。
   * 同じページの module は再読み込みされないため、
   * 画面が使っているのと同一の実装が返る。
   */
  const bannerLogic = JSON.parse(await page.evaluate(`
    import('./portal.js').then(async (m) => {
      const { KeyStore } = await import('../auth/keystore.js');
      const before = m.shouldShowApiKeyBanner();
      KeyStore.set('gemini', 'AIzaSyDUMMY0000000000000000000000000000');
      const after = m.shouldShowApiKeyBanner();
      KeyStore.remove('gemini');
      const removed = m.shouldShowApiKeyBanner();
      return JSON.stringify({ 未保存: before, 保存済み: after, 削除後: removed });
    })
  `));

  check(
    '表示条件は KeyStore の保存状態だけで決まる',
    bannerLogic.未保存 === true && bannerLogic.保存済み === false && bannerLogic.削除後 === true,
    JSON.stringify(bannerLogic),
  );

  /* 320px でも折り返して収まること。 */
  await page.setViewport(320, 900);
  await page.sleep(150);

  check(
    'バナーが出ていても320pxで横スクロールしない',
    (await page.evaluate(
      'document.documentElement.scrollWidth - document.documentElement.clientWidth',
    )) <= 0,
  );

  await page.clearViewport();
  await page.sleep(120);

  /* ---- アプリグリッド（アプリ0件・2ページ＝16枠） ---- */

  /*
   * 空状態の案内文は廃止した。準備中の枠そのものが状態を語る。
   * 文言が復活していないことも見ておく。
   */
  check(
    '空状態の案内文（要素・文言）が無い',
    await page.evaluate(`
      document.getElementById("portal-apps-empty") === null
      && !document.body.textContent.includes("ご利用可能なアプリは順次追加されます")
    `),
  );

  check(
    'アプリ0件でも2ページぶんの枠が並ぶ',
    await page.evaluate(`
      document.querySelectorAll("#portal-apps .auth-apps__page").length === 2
      && document.querySelectorAll("#portal-apps .auth-app-card").length === 16
    `),
    await page.evaluate(`JSON.stringify({
      pages: document.querySelectorAll("#portal-apps .auth-apps__page").length,
      slots: document.querySelectorAll("#portal-apps .auth-app-card").length,
    })`),
  );

  check(
    '1ページは8枠（2列×4行）',
    await page.evaluate(`
      [...document.querySelectorAll("#portal-apps .auth-apps__page")]
        .every((page) => page.children.length === 8)
    `),
  );

  check(
    '空枠はすべて「準備中」',
    await page.evaluate(`
      [...document.querySelectorAll("#portal-apps .auth-app-card--empty")].length === 16
      && [...document.querySelectorAll("#portal-apps .auth-app-card__pending")]
        .every((el) => el.textContent.trim() === "準備中")
    `),
  );

  /* 行き先が無いものを押せる形にしない。 */
  check(
    '準備中の枠はリンクでもボタンでもない',
    await page.evaluate(`
      document.querySelectorAll("#portal-apps .auth-app-card--empty a, #portal-apps .auth-app-card--empty button").length === 0
    `),
  );

  check(
    '準備中の枠は破線で示す（形と語の両方）',
    await page.evaluate(`
      getComputedStyle(document.querySelector("#portal-apps .auth-app-card__placeholder")).borderTopStyle === "dashed"
    `),
    await page.evaluate('getComputedStyle(document.querySelector("#portal-apps .auth-app-card__placeholder")).borderTopStyle'),
  );

  /* ---- ページ送り ---- */

  check(
    '初期表示は1ページ目',
    await page.evaluate(`(() => {
      const pages = [...document.querySelectorAll("#portal-apps .auth-apps__page")];
      return pages[0].hidden === false && pages.slice(1).every((p) => p.hidden === true);
    })()`),
  );

  check(
    'ドットはページ数ぶんの button',
    await page.evaluate(`(() => {
      const dots = [...document.querySelectorAll("#portal-apps-dots .auth-apps__dot")];
      return dots.length === 2
        && dots.every((d) => d.tagName === "BUTTON" && d.getAttribute("aria-label"));
    })()`),
  );

  check(
    '表示中のドットに aria-current が付く',
    await page.evaluate(`(() => {
      const dots = [...document.querySelectorAll("#portal-apps-dots .auth-apps__dot")];
      return dots[0].getAttribute("aria-current") === "true"
        && dots.slice(1).every((d) => d.getAttribute("aria-current") === null);
    })()`),
  );

  check(
    '矢印は button で aria-label を持つ',
    await page.evaluate(`(() => {
      const prev = document.getElementById("portal-apps-prev");
      const next = document.getElementById("portal-apps-next");
      return prev.tagName === "BUTTON" && next.tagName === "BUTTON"
        && prev.getAttribute("aria-label") === "前のページ"
        && next.getAttribute("aria-label") === "次のページ";
    })()`),
  );

  check(
    '1ページ目では「前へ」が押せない',
    await page.evaluate(`
      document.getElementById("portal-apps-prev").disabled === true
      && document.getElementById("portal-apps-next").disabled === false
    `),
  );

  /* 矢印で送る。 */
  await page.evaluate('document.getElementById("portal-apps-next").click()');
  await page.sleep(150);

  check(
    '「次へ」で2ページ目が出る（aria-current も追従）',
    await page.evaluate(`(() => {
      const pages = [...document.querySelectorAll("#portal-apps .auth-apps__page")];
      const dots = [...document.querySelectorAll("#portal-apps-dots .auth-apps__dot")];
      return pages[1].hidden === false && pages[0].hidden === true
        && dots[1].getAttribute("aria-current") === "true"
        && dots[0].getAttribute("aria-current") === null;
    })()`),
  );

  check(
    '最終ページでは「次へ」が押せない',
    await page.evaluate(`
      document.getElementById("portal-apps-next").disabled === true
      && document.getElementById("portal-apps-prev").disabled === false
    `),
  );

  /* ドットで戻る。 */
  await page.evaluate('document.querySelectorAll("#portal-apps-dots .auth-apps__dot")[0].click()');
  await page.sleep(150);

  check(
    'ドットを押すとそのページへ移る',
    await page.evaluate(`
      document.querySelectorAll("#portal-apps .auth-apps__page")[0].hidden === false
      && document.querySelectorAll("#portal-apps-dots .auth-apps__dot")[0].getAttribute("aria-current") === "true"
    `),
  );

  /* キーボードだけで送れること。実際にキーを送って確かめる。 */
  await page.evaluate('document.getElementById("portal-apps-next").focus()');
  await page.send('Input.dispatchKeyEvent', {
    type: 'keyDown', windowsVirtualKeyCode: 13, key: 'Enter', code: 'Enter', text: '\r',
  });
  await page.send('Input.dispatchKeyEvent', {
    type: 'keyUp', windowsVirtualKeyCode: 13, key: 'Enter', code: 'Enter',
  });
  await page.sleep(200);

  check(
    'Enter キーでページを送れる',
    await page.evaluate(`
      document.querySelectorAll("#portal-apps .auth-apps__page")[1].hidden === false
    `),
  );

  await page.evaluate('document.querySelectorAll("#portal-apps-dots .auth-apps__dot")[0].focus()');
  await page.send('Input.dispatchKeyEvent', {
    type: 'keyDown', windowsVirtualKeyCode: 32, key: ' ', code: 'Space', text: ' ',
  });
  await page.send('Input.dispatchKeyEvent', {
    type: 'keyUp', windowsVirtualKeyCode: 32, key: ' ', code: 'Space',
  });
  await page.sleep(200);

  check(
    'Space キーでドットを押せる',
    await page.evaluate(`
      document.querySelectorAll("#portal-apps .auth-apps__page")[0].hidden === false
    `),
  );

  /* 表示ページは保存しない。 */
  await page.evaluate('document.getElementById("portal-apps-next").click()');
  await page.sleep(150);
  await page.goto(`${origin}/portal/`, 1500);

  check(
    '再読み込みすると1ページ目へ戻る（表示ページを保存しない）',
    await page.evaluate(`
      document.querySelectorAll("#portal-apps .auth-apps__page")[0].hidden === false
      && document.querySelectorAll("#portal-apps-dots .auth-apps__dot")[0].getAttribute("aria-current") === "true"
    `),
  );

  check(
    '配置データを書き込んでいない（第2便まで読むだけ）',
    (await page.evaluate('localStorage.getItem("tsam-app-layout")')) === null,
    await page.evaluate('localStorage.getItem("tsam-app-layout")'),
  );

  /* バナーとの位置関係は従来どおり（バナーがグリッドより上）。 */
  check(
    'APIキーバナーはグリッドより上のまま',
    await page.evaluate(`
      document.getElementById("portal-api-key-banner").getBoundingClientRect().bottom
      <= document.getElementById("portal-apps").getBoundingClientRect().top + 1
    `),
  );

  /* ---- アカウント情報パネル（ヘッダーバー直下の開閉式） ---- */

  /*
   * キーを1つ押して離す。button の既定動作（Enter / Space で click）を
   * 実際のキー入力で確かめるために使う。
   */
  const pressKey = async (key, code, keyCode, text) => {
    await page.send('Input.dispatchKeyEvent', {
      type: 'keyDown', windowsVirtualKeyCode: keyCode, key, code, text,
    });
    await page.send('Input.dispatchKeyEvent', {
      type: 'keyUp', windowsVirtualKeyCode: keyCode, key, code,
    });
    await page.sleep(120);
  };

  /*
   * 枠（.auth-account）はアカウント情報とAPI設定の2枚。
   * どちらもヘッダーバー直下にあり、アプリ一覧より下には1枚も無い。
   */
  check(
    '下部のアカウント情報カードは無くなっている',
    await page.evaluate(`(() => {
      const panels = [...document.querySelectorAll(".auth-account")];
      const apps = document.getElementById("portal-apps");
      return panels.length === 2
        && panels.every((p) =>
          p.compareDocumentPosition(apps) === Node.DOCUMENT_POSITION_FOLLOWING);
    })()`),
    await page.evaluate(`
      JSON.stringify([...document.querySelectorAll(".auth-account")].map((p) => p.id))
    `),
  );

  check(
    'パネルはヘッダーバーの直下にある（アプリ一覧より上）',
    await page.evaluate(`(() => {
      const barBottom = document.querySelector(".auth-portal-bar").getBoundingClientRect().bottom;
      const panel = document.getElementById("portal-account-panel");
      const apps = document.getElementById("portal-apps").getBoundingClientRect();
      /* 閉じているあいだは高さ0なので、DOM 順で位置を見る。 */
      return panel.compareDocumentPosition(document.getElementById("portal-apps"))
        === Node.DOCUMENT_POSITION_FOLLOWING
        && document.querySelector(".auth-portal-bar")
             .compareDocumentPosition(panel) === Node.DOCUMENT_POSITION_FOLLOWING
        && barBottom <= apps.top + 1;
    })()`),
  );

  check(
    '初期状態ではパネルが閉じている',
    await page.evaluate(`
      document.getElementById("portal-account-panel").hidden === true
      && document.getElementById("portal-account-panel").getBoundingClientRect().height === 0
    `),
  );

  check(
    '初期状態の aria-expanded は false',
    (await page.evaluate(`
      document.getElementById("portal-account-toggle").getAttribute("aria-expanded")
    `)) === 'false',
  );

  check(
    'トグルは button 要素',
    await page.evaluate(`
      document.getElementById("portal-account-toggle").tagName === "BUTTON"
      && document.getElementById("portal-account-toggle").getAttribute("type") === "button"
    `),
  );

  check(
    'aria-controls がパネルを指している',
    (await page.evaluate(`
      document.getElementById("portal-account-toggle").getAttribute("aria-controls")
    `)) === 'portal-account-panel',
  );

  /*
   * 見出しはボタンの外側に残す。
   * button の子孫は読み上げ上ひとかたまりに潰れるため、h1 を内側へ入れると
   * 見出しジャンプでこの画面の主題を掴めなくなる（§3-3）。
   */
  check(
    'h1 がトグルを包んでいる（h1 をボタンの内側に入れない）',
    await page.evaluate(`
      document.getElementById("portal-account-toggle").closest("h1") !== null
      && document.querySelector("h1 button, h1 > button") !== null
      && document.getElementById("portal-account-toggle").querySelector("h1") === null
    `),
  );

  /* ---- 押して開く ---- */

  await page.evaluate('document.getElementById("portal-account-toggle").click()');
  await page.sleep(120);

  check(
    'トグルを押すとパネルが開く',
    await page.evaluate(`
      document.getElementById("portal-account-panel").hidden === false
      && document.getElementById("portal-account-panel").getBoundingClientRect().height > 0
    `),
  );

  check(
    '開くと aria-expanded が true になる',
    (await page.evaluate(`
      document.getElementById("portal-account-toggle").getAttribute("aria-expanded")
    `)) === 'true',
  );

  /*
   * 回転は 0.15s かけて動く。終わってから測る。
   * matrix(a, b, c, d, …) の a と b から角度を出し、180度に寄っているかを見る。
   * 文字列の完全一致で見ると、途中の値を拾って落ちる。
   */
  await page.sleep(400);

  const chevronAngle = await page.evaluate(`(() => {
    const t = getComputedStyle(document.querySelector(".auth-portal-bar__chevron")).transform;
    const m = t.match(/matrix\\(([^)]+)\\)/);
    if (!m) return null;
    const [a, b] = m[1].split(",").map(Number);
    return Math.round(Math.abs(Math.atan2(b, a) * 180 / Math.PI));
  })()`);

  check(
    '開くと逆三角が180度回る',
    chevronAngle !== null && Math.abs(chevronAngle - 180) <= 2,
    `${chevronAngle}deg`,
  );

  check(
    'パネルが実際にヘッダーバーの下へ出る',
    await page.evaluate(`(() => {
      const bar = document.querySelector(".auth-portal-bar").getBoundingClientRect();
      const panel = document.getElementById("portal-account-panel").getBoundingClientRect();
      const apps = document.getElementById("portal-apps").getBoundingClientRect();
      return panel.top >= bar.bottom - 1 && panel.bottom <= apps.top + 1;
    })()`),
  );

  check(
    '項目名と値が3組そろう',
    (await page.evaluate(`
      JSON.stringify([...document.querySelectorAll(".auth-account dt")].map((dt) => dt.textContent))
    `)) === JSON.stringify(['メールアドレス', 'ご契約の状態', 'パスワード']),
    await page.evaluate(`
      JSON.stringify([...document.querySelectorAll(".auth-account dt")].map((dt) => dt.textContent))
    `),
  );

  check(
    'メールアドレスはパネルの中に出る',
    (await page.evaluate('document.getElementById("portal-account-email").textContent'))
      === 'member@example.com'
    && await page.evaluate(`
      document.getElementById("portal-account-email").closest("#portal-account-panel") !== null
    `),
  );

  check(
    '項目名と値は縦に並ぶ（横並びにしない）',
    await page.evaluate(`
      [...document.querySelectorAll(".auth-account dt")].every((dt) => {
        const dd = dt.nextElementSibling;
        return dd.getBoundingClientRect().top > dt.getBoundingClientRect().top + 1;
      })
    `),
  );

  check(
    'メールアドレスと契約状態も上下に分かれる',
    await page.evaluate(`(() => {
      const email = document.getElementById("portal-account-email").getBoundingClientRect();
      const state = document.getElementById("portal-account-subscription").getBoundingClientRect();
      return state.top > email.top + 1;
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

  check(
    'カードの枠線と角丸は現行のまま',
    await page.evaluate(`(() => {
      const s = getComputedStyle(document.querySelector(".auth-account"));
      return s.borderStyle === "solid" && s.borderTopWidth === "1px" && s.borderTopLeftRadius === "6px";
    })()`),
    await page.evaluate(`
      getComputedStyle(document.querySelector(".auth-account")).borderTopLeftRadius
    `),
  );

  /* ---- もう一度押して閉じる ---- */

  await page.evaluate('document.getElementById("portal-account-toggle").click()');
  await page.sleep(120);

  check(
    'もう一度押すと閉じる',
    await page.evaluate(`
      document.getElementById("portal-account-panel").hidden === true
      && document.getElementById("portal-account-toggle").getAttribute("aria-expanded") === "false"
    `),
  );

  /* ---- キーボードだけで開閉できる ---- */

  /*
   * Tab で到達できることを、実際に Tab を押して確かめる。
   * 先頭はスキップリンクなので、数回押して現れるかを見る。
   */
  await page.evaluate('document.activeElement && document.activeElement.blur()');

  const tabOrder = [];

  for (let i = 0; i < 5; i += 1) {
    await pressKey('Tab', 'Tab', 9);
    tabOrder.push(await page.evaluate(
      'document.activeElement.id || document.activeElement.className || document.activeElement.tagName',
    ));

    if (tabOrder.at(-1) === 'portal-account-toggle') {
      break;
    }
  }

  check(
    'Tab でトグルへ到達できる',
    tabOrder.includes('portal-account-toggle'),
    JSON.stringify(tabOrder),
  );

  await pressKey('Enter', 'Enter', 13, '\r');

  check(
    'Enter で開く',
    await page.evaluate(`
      document.getElementById("portal-account-panel").hidden === false
      && document.getElementById("portal-account-toggle").getAttribute("aria-expanded") === "true"
    `),
  );

  await pressKey(' ', 'Space', 32, ' ');

  check(
    'Space で閉じる',
    await page.evaluate(`
      document.getElementById("portal-account-panel").hidden === true
      && document.getElementById("portal-account-toggle").getAttribute("aria-expanded") === "false"
    `),
  );

  /* ---- 開閉状態は保存しない ---- */

  await page.evaluate('document.getElementById("portal-account-toggle").click()');
  await page.sleep(120);

  check(
    '（前提）再読み込みの直前は開いている',
    await page.evaluate('document.getElementById("portal-account-panel").hidden === false'),
  );

  await page.goto(`${origin}/portal/`, 1500);

  check(
    '再読み込みすると閉じた状態に戻る（開閉状態を保存しない）',
    await page.evaluate(`
      document.getElementById("portal-account-panel").hidden === true
      && document.getElementById("portal-account-toggle").getAttribute("aria-expanded") === "false"
    `),
  );

  check(
    '開閉状態を localStorage へ書いていない',
    await page.evaluate(`
      !Object.keys(localStorage).some((k) => /panel|account|expand|open/i.test(k))
    `),
    await page.evaluate('JSON.stringify(Object.keys(localStorage))'),
  );

  /* ---------------------------------------------------------------- */
  section('Gemini APIキーの設定');

  /*
   * 実際の Gemini API へは絶対に通信させない。
   * portalStub の window.fetch をさらに包み、
   *   - generativelanguage.googleapis.com は必ずスタブが返す
   *   - すべての呼び出しを __fetchCalls へ記録する
   * ようにする。記録は「GASへキーを送っていない」ことの確認にも使う。
   */
  const apiStub = await page.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      window.__fetchCalls = [];
      window.__geminiStatus = 200;

      const inner = window.fetch;

      window.fetch = (url, options) => {
        window.__fetchCalls.push({
          url: String(url),
          headers: JSON.stringify(options?.headers ?? null),
          body: typeof options?.body === 'string' ? options.body : null,
        });

        if (String(url).includes('generativelanguage.googleapis.com')) {
          return Promise.resolve(new Response(
            JSON.stringify({ models: [] }),
            { status: window.__geminiStatus, headers: { 'Content-Type': 'application/json' } },
          ));
        }

        return inner(url, options);
      };
    `,
  });

  /* AIza ＋ 35文字 ＝ 39文字。Google の採番に合わせた形。 */
  const VALID_KEY = 'AIzaSyTESTKEY0123456789abcdefghijKLMNOP';
  const ODD_KEY = 'not-a-google-shaped-key';

  await page.evaluate('localStorage.removeItem("tsam-api-keys")');
  await page.goto(`${origin}/portal/`, 1500);

  /* ---- トグルとパネルの体裁 ---- */

  check(
    'API設定トグルは button で aria が揃っている',
    await page.evaluate(`(() => {
      const t = document.getElementById("portal-api-toggle");
      return t.tagName === "BUTTON"
        && t.getAttribute("type") === "button"
        && t.getAttribute("aria-expanded") === "false"
        && t.getAttribute("aria-controls") === "portal-api-panel";
    })()`),
  );

  check(
    'API設定トグルはログアウトの左隣にある',
    await page.evaluate(`(() => {
      const t = document.getElementById("portal-api-toggle").getBoundingClientRect();
      const l = document.getElementById("portal-logout").getBoundingClientRect();
      return t.right <= l.left + 1 && Math.abs(t.top - l.top) < 24;
    })()`),
  );

  check(
    'トグルの押下領域は44px以上',
    (await page.evaluate(`
      document.getElementById("portal-api-toggle").getBoundingClientRect().height
    `)) >= 44,
    await page.evaluate(`
      document.getElementById("portal-api-toggle").getBoundingClientRect().height
    `),
  );

  check(
    '初期状態でAPI設定パネルは閉じている',
    await page.evaluate('document.getElementById("portal-api-panel").hidden === true'),
  );

  /* ---- 2枚のパネルは排他 ---- */

  await page.evaluate('document.getElementById("portal-api-toggle").click()');
  await page.sleep(400);

  check(
    'API設定を開くとパネルが出て、逆三角が180度回る',
    await page.evaluate(`(() => {
      const panel = document.getElementById("portal-api-panel");
      const chev = document.getElementById("portal-api-toggle")
        .querySelector(".auth-portal-bar__chevron");
      const m = getComputedStyle(chev).transform.match(/matrix\\(([^)]+)\\)/);
      const [a, b] = m ? m[1].split(",").map(Number) : [1, 0];
      const deg = Math.round(Math.abs(Math.atan2(b, a) * 180 / Math.PI));
      return panel.hidden === false && panel.getBoundingClientRect().height > 0
        && Math.abs(deg - 180) <= 2;
    })()`),
  );

  await page.evaluate('document.getElementById("portal-account-toggle").click()');
  await page.sleep(200);

  check(
    'アカウント情報を開くとAPI設定が閉じる（排他）',
    await page.evaluate(`
      document.getElementById("portal-account-panel").hidden === false
      && document.getElementById("portal-api-panel").hidden === true
      && document.getElementById("portal-api-toggle").getAttribute("aria-expanded") === "false"
    `),
  );

  await page.evaluate('document.getElementById("portal-api-toggle").click()');
  await page.sleep(200);

  check(
    'API設定を開くとアカウント情報が閉じる（排他・逆向き）',
    await page.evaluate(`
      document.getElementById("portal-api-panel").hidden === false
      && document.getElementById("portal-account-panel").hidden === true
      && document.getElementById("portal-account-toggle").getAttribute("aria-expanded") === "false"
    `),
  );

  /* ---- 未保存のときの中身 ---- */

  check(
    '未保存のときは入力欄と保存ボタンが出る',
    await page.evaluate(`
      document.getElementById("portal-api-form").hidden === false
      && document.getElementById("portal-api-saved").hidden === true
      && document.getElementById("portal-api-key").type === "password"
    `),
  );

  check(
    '説明文に「当社サーバーには送信されません」が入っている',
    await page.evaluate(`
      document.getElementById("portal-api-panel").innerText
        .includes("お使いの端末（ブラウザ）にのみ保存され、当社サーバーには送信されません")
    `),
  );

  /* ---- 案内文（キーの取得手順） ---- */

  check(
    'Google AI Studio への導線がある',
    await page.evaluate(`(() => {
      const a = document.querySelector('#portal-api-panel a[href="https://aistudio.google.com/apikey"]');
      return a !== null
        && a.textContent.trim() === "Google AI Studio"
        && a.target === "_blank"
        && a.rel.includes("noopener") && a.rel.includes("noreferrer");
    })()`),
  );

  /*
   * リンクだけでなく、URL そのものも文字として読めること。
   * リンクを踏まずに行き先を確かめてから移動できるようにするため。
   *
   * 表示は完全一致で見る。/apikey が落ちても
   * 「aistudio.google.com を含む」だけの検査では通ってしまう。
   */
  check(
    'AI Studio の URL が文字としても見えている',
    await page.evaluate(`(() => {
      const panel = document.getElementById("portal-api-panel");
      const url = [...panel.querySelectorAll(".auth-api-panel__url")]
        .map((el) => el.textContent.trim());
      return url.includes("https://aistudio.google.com/apikey")
        && panel.innerText.includes("https://aistudio.google.com/apikey");
    })()`),
    await page.evaluate(`
      JSON.stringify([...document.querySelectorAll("#portal-api-panel .auth-api-panel__url")]
        .map((el) => el.textContent.trim()))
    `),
  );

  /*
   * トップURLへの逆戻り検知。
   * Playground に着地してしまい、キー取得までメニューを探す必要が出る。
   */
  check(
    'トップURL（/）へ戻っていない',
    await page.evaluate(`(() => {
      const panel = document.getElementById("portal-api-panel");
      const hrefs = [...panel.querySelectorAll('a[href*="aistudio.google.com"]')]
        .map((a) => a.getAttribute("href"));
      const shown = [...panel.querySelectorAll(".auth-api-panel__url")]
        .map((el) => el.textContent.trim());
      return hrefs.every((h) => h.endsWith("/apikey"))
        && shown.every((s) => !/^https:\\/\\/aistudio\\.google\\.com\\/?$/.test(s));
    })()`),
    await page.evaluate(`
      JSON.stringify([...document.querySelectorAll('#portal-api-panel a[href*="aistudio.google.com"]')]
        .map((a) => a.getAttribute("href")))
    `),
  );

  check(
    '無料のGoogleアカウントで発行できる旨が書いてある',
    await page.evaluate(`
      document.getElementById("portal-api-panel").innerText
        .includes("Googleアカウントがあれば無料で発行できます")
    `),
  );

  check(
    '有料契約が不要である旨が書いてある',
    await page.evaluate(`
      document.getElementById("portal-api-panel").innerText
        .includes("Google Workspace などの有料契約は必要ありません")
    `),
  );

  /* ---- 案内文（Google Workspace の紹介） ---- */

  check(
    '紹介リンクの href が正しい',
    (await page.evaluate(`
      document.getElementById("portal-workspace-link").getAttribute("href")
    `)) === 'https://referworkspace.app.goo.gl/2KTq',
    await page.evaluate('document.getElementById("portal-workspace-link").getAttribute("href")'),
  );

  check(
    '紹介リンクは別タブ・noopener noreferrer',
    await page.evaluate(`(() => {
      const a = document.getElementById("portal-workspace-link");
      return a.target === "_blank" && a.rel.includes("noopener") && a.rel.includes("noreferrer");
    })()`),
    await page.evaluate('document.getElementById("portal-workspace-link").rel'),
  );

  /*
   * 「紹介である」ことは表示から落ちてはならない。
   * リンクと同じ段落の中に出ていることまで見る。
   */
  check(
    '【紹介リンク】がリンクと同じ段落に出ている',
    await page.evaluate(`(() => {
      const p = document.getElementById("portal-workspace-link").closest("p");
      return p.innerText.includes("【紹介リンク】");
    })()`),
    await page.evaluate(`
      document.getElementById("portal-workspace-link").closest("p").innerText
    `),
  );

  check(
    '有料サービスであることを明記している',
    await page.evaluate(`
      document.getElementById("portal-api-panel").innerText
        .includes("Google Workspace は有料サービス")
    `),
  );

  /*
   * 誤読の防止。
   * 「キーを取るには Workspace が要る」と読ませない。
   */
  check(
    'キー取得に Workspace が不要である旨を明記している',
    await page.evaluate(`
      document.getElementById("portal-api-panel").innerText
        .includes("Gemini APIキーの取得に Google Workspace は必要ありません")
    `),
  );

  check(
    '紹介ブロックは手順文と区切られている（区切り線を持つ別ブロック）',
    await page.evaluate(`(() => {
      const promo = document.querySelector("#portal-api-panel .auth-api-panel__promo");
      const s = getComputedStyle(promo);
      return promo !== null
        && promo.tagName === "ASIDE"
        && s.borderTopStyle === "solid"
        && parseFloat(s.borderTopWidth) >= 1;
    })()`),
  );

  /* 紹介が入力欄より前に出て、キーを入れに来た人を押し下げないこと。 */
  check(
    '紹介ブロックは入力欄より後ろにある',
    await page.evaluate(`
      document.getElementById("portal-api-form").compareDocumentPosition(
        document.querySelector("#portal-api-panel .auth-api-panel__promo")
      ) === Node.DOCUMENT_POSITION_FOLLOWING
    `),
  );

  /* 見出しの階層を飛ばさない（パネルの h2 の下に h3）。 */
  check(
    '紹介ブロックの見出しは h3',
    await page.evaluate(`
      document.getElementById("portal-api-promo-title").tagName === "H3"
      && document.getElementById("portal-api-title").tagName === "H2"
    `),
  );

  check(
    '表示切替でキーが読める形になる',
    await page.evaluate(`(() => {
      document.getElementById("portal-api-key-visibility").click();
      const shown = document.getElementById("portal-api-key").type === "text";
      document.getElementById("portal-api-key-visibility").click();
      return shown && document.getElementById("portal-api-key").type === "password";
    })()`),
  );

  /* ---- 保存する（疎通テストは成功を返す） ---- */

  await page.evaluate(`(() => {
    window.__geminiStatus = 200;
    document.getElementById("portal-api-key").value = ${JSON.stringify(VALID_KEY)};
    document.getElementById("portal-api-save").click();
  })()`);
  await page.sleep(500);

  check(
    '保存すると localStorage に JSON 1件で入る',
    (await page.evaluate('localStorage.getItem("tsam-api-keys")'))
      === JSON.stringify({ gemini: VALID_KEY }),
    await page.evaluate('localStorage.getItem("tsam-api-keys")'),
  );

  check(
    '保存キーは tsam-api-keys の1つだけ（プロバイダーごとに増やさない）',
    (await page.evaluate(`
      JSON.stringify(Object.keys(localStorage).filter((k) => /api|key/i.test(k)))
    `)) === JSON.stringify(['tsam-api-keys']),
    await page.evaluate('JSON.stringify(Object.keys(localStorage))'),
  );

  check(
    '保存後は伏せ字表示と「変更」「削除」に切り替わる',
    await page.evaluate(`
      document.getElementById("portal-api-saved").hidden === false
      && document.getElementById("portal-api-form").hidden === true
    `),
  );

  check(
    '伏せ字は先頭4文字＋伏せ字＋末尾4文字',
    (await page.evaluate('document.getElementById("portal-api-masked").textContent'))
      === `${VALID_KEY.slice(0, 4)}${'•'.repeat(VALID_KEY.length - 8)}${VALID_KEY.slice(-4)}`,
    await page.evaluate('document.getElementById("portal-api-masked").textContent'),
  );

  check(
    '伏せ字の中にキーの中身が出ていない',
    await page.evaluate(`
      !document.getElementById("portal-api-panel").innerText.includes(${JSON.stringify(VALID_KEY.slice(8, 30))})
    `),
  );

  check(
    '疎通に成功したので「接続を確認しました。」が出る',
    await page.evaluate(`
      document.getElementById("portal-api-message").innerText.includes("接続を確認しました。")
      && document.getElementById("portal-api-message").dataset.kind === "success"
    `),
    await page.evaluate('document.getElementById("portal-api-message").innerText'),
  );

  check(
    '保存が済むとバナーは即時に消える',
    await page.evaluate('document.getElementById("portal-api-key-banner").hidden === true'),
  );

  /* ---- キーの送り先を確かめる ---- */

  const fetchCalls = JSON.parse(await page.evaluate('JSON.stringify(window.__fetchCalls)'));

  check(
    '疎通テストは Gemini のモデル一覧を GET している',
    fetchCalls.some((c) => c.url === 'https://generativelanguage.googleapis.com/v1beta/models'),
    JSON.stringify(fetchCalls.map((c) => c.url)),
  );

  check(
    'キーはURLではなくヘッダー（x-goog-api-key）で送る',
    fetchCalls.some((c) => c.headers?.includes('x-goog-api-key') && c.headers.includes(VALID_KEY))
    && !fetchCalls.some((c) => c.url.includes(VALID_KEY)),
    JSON.stringify(fetchCalls.map((c) => c.url)),
  );

  check(
    'キーを当社サーバー（GAS）へ送っていない',
    !fetchCalls.some((c) => c.url.includes('script.google.com')
      && `${c.url}${c.body ?? ''}${c.headers ?? ''}`.includes(VALID_KEY)),
    JSON.stringify(fetchCalls.filter((c) => c.url.includes('script.google.com')).map((c) => c.body)),
  );

  /* ---- ログアウトしてもキーは残る ---- */

  await page.evaluate(`
    import('../auth/session.js').then((m) => m.signOut()).then(() => { window.__signedOut = true; })
  `);
  await page.sleep(500);

  check(
    'signOut がセッショントークンを消している（前提）',
    await page.evaluate('window.__signedOut === true && localStorage.getItem("tsam-auth-session") === null'),
  );

  check(
    'ログアウトしてもAPIキーは消えない',
    (await page.evaluate('localStorage.getItem("tsam-api-keys")'))
      === JSON.stringify({ gemini: VALID_KEY }),
    await page.evaluate('localStorage.getItem("tsam-api-keys")'),
  );

  /* ---- 削除は確認を挟む ---- */

  await page.evaluate('localStorage.setItem("tsam-auth-session", "stub-session-token")');
  await page.goto(`${origin}/portal/`, 1500);
  await page.evaluate('document.getElementById("portal-api-toggle").click()');
  await page.sleep(200);

  check(
    '保存済みなら再読み込み後もバナーは出ない',
    await page.evaluate('document.getElementById("portal-api-key-banner").hidden === true'),
  );

  await page.evaluate('document.getElementById("portal-api-delete").click()');
  await page.sleep(200);

  check(
    '削除を押すといきなり消さず、確認が出る',
    await page.evaluate(`
      document.getElementById("portal-api-confirm").hidden === false
      && localStorage.getItem("tsam-api-keys") !== null
    `),
  );

  await page.evaluate('document.getElementById("portal-api-delete-cancel").click()');
  await page.sleep(200);

  check(
    '「やめる」ならキーは残る',
    await page.evaluate(`
      document.getElementById("portal-api-confirm").hidden === true
      && localStorage.getItem("tsam-api-keys") !== null
    `),
  );

  await page.evaluate('document.getElementById("portal-api-delete").click()');
  await page.sleep(150);
  await page.evaluate('document.getElementById("portal-api-delete-confirm").click()');
  await page.sleep(250);

  check(
    '「削除する」でキーが消える',
    (await page.evaluate('localStorage.getItem("tsam-api-keys")')) === null,
    await page.evaluate('localStorage.getItem("tsam-api-keys")'),
  );

  check(
    '削除すると入力欄に戻り、バナーが再表示される',
    await page.evaluate(`
      document.getElementById("portal-api-form").hidden === false
      && document.getElementById("portal-api-saved").hidden === true
      && document.getElementById("portal-api-key-banner").hidden === false
    `),
  );

  /* ---- 形式が違っても保存は拒否しない ---- */

  await page.evaluate(`(() => {
    window.__geminiStatus = 200;
    document.getElementById("portal-api-key").value = ${JSON.stringify(ODD_KEY)};
    document.getElementById("portal-api-save").click();
  })()`);
  await page.sleep(500);

  check(
    '形式が違っても保存される（拒否しない）',
    (await page.evaluate('localStorage.getItem("tsam-api-keys")'))
      === JSON.stringify({ gemini: ODD_KEY }),
    await page.evaluate('localStorage.getItem("tsam-api-keys")'),
  );

  check(
    '形式が違うときは警告を添える',
    await page.evaluate(`
      document.getElementById("portal-api-message").innerText
        .includes("一般的なGemini APIキーの形式と異なります。")
    `),
    await page.evaluate('document.getElementById("portal-api-message").innerText'),
  );

  check(
    '警告があるときは「完了」と言い切らない',
    (await page.evaluate('document.getElementById("portal-api-message").dataset.kind')) === 'info',
    await page.evaluate('document.getElementById("portal-api-message").dataset.kind'),
  );

  /* ---- 疎通に失敗しても保存は残る ---- */

  await page.evaluate('document.getElementById("portal-api-change").click()');
  await page.sleep(150);

  await page.evaluate(`(() => {
    window.__geminiStatus = 403;
    document.getElementById("portal-api-key").value = ${JSON.stringify(VALID_KEY)};
    document.getElementById("portal-api-save").click();
  })()`);
  await page.sleep(500);

  check(
    '疎通に失敗するとエラー文言が出る',
    await page.evaluate(`
      document.getElementById("portal-api-message").innerText
        .includes("このAPIキーでは接続できませんでした。")
      && document.getElementById("portal-api-message").dataset.kind === "error"
    `),
    await page.evaluate('document.getElementById("portal-api-message").innerText'),
  );

  check(
    '疎通に失敗しても保存は残る（あとから直せる）',
    (await page.evaluate('localStorage.getItem("tsam-api-keys")'))
      === JSON.stringify({ gemini: VALID_KEY })
    && await page.evaluate('document.getElementById("portal-api-saved").hidden === false'),
    await page.evaluate('localStorage.getItem("tsam-api-keys")'),
  );

  /* ---- バナーの導線はパネルを開く ---- */

  await page.evaluate('localStorage.removeItem("tsam-api-keys")');
  await page.goto(`${origin}/portal/`, 1500);

  check(
    'キーが無ければバナーが戻る',
    await page.evaluate('document.getElementById("portal-api-key-banner").hidden === false'),
  );

  await page.evaluate('document.getElementById("portal-api-key-action").click()');
  await page.sleep(250);

  check(
    'バナーを押すと画面は移動せず、API設定パネルが開く',
    await page.evaluate(`
      location.pathname.endsWith("/portal/")
      && document.getElementById("portal-api-panel").hidden === false
      && document.getElementById("portal-api-toggle").getAttribute("aria-expanded") === "true"
    `),
    await page.evaluate('location.pathname'),
  );

  /* ---- 画面幅ごとの収まり ---- */

  for (const width of WIDTHS) {
    await page.setViewport(width, 900);
    await page.goto(`${origin}/portal/`, 1200);
    await page.evaluate('document.getElementById("portal-api-toggle").click()');
    await page.sleep(200);

    const apiOverflow = await page.evaluate(
      'document.documentElement.scrollWidth - document.documentElement.clientWidth',
    );
    check(`${width}px: API設定パネルを開いても横スクロールしない`, apiOverflow <= 0, apiOverflow);

    /*
     * 案内文の中身が枠から出ないこと。
     * 生のURLは1語が長く、折り返さないと 320px で溢れる。
     */
    check(
      `${width}px: 案内文と紹介ブロックがパネルの枠に収まる`,
      await page.evaluate(`(() => {
        const panel = document.getElementById("portal-api-panel").getBoundingClientRect();
        const parts = [...document.querySelectorAll(
          "#portal-api-panel .auth-api-panel__url, #portal-api-panel .auth-api-panel__promo")];
        return parts.length >= 2 && parts.every((el) => {
          const r = el.getBoundingClientRect();
          return r.left >= panel.left - 1 && r.right <= panel.right + 1;
        });
      })()`),
      await page.evaluate(`JSON.stringify({
        panel: document.getElementById("portal-api-panel").getBoundingClientRect().right,
        url: document.querySelector("#portal-api-panel .auth-api-panel__url").getBoundingClientRect().right,
        promo: document.querySelector("#portal-api-panel .auth-api-panel__promo").getBoundingClientRect().right,
      })`),
    );

    check(
      `${width}px: 帯の3つが1行に収まる`,
      await page.evaluate(`(() => {
        const a = document.getElementById("portal-account-toggle").getBoundingClientRect();
        const t = document.getElementById("portal-api-toggle").getBoundingClientRect();
        const l = document.getElementById("portal-logout").getBoundingClientRect();
        return Math.abs(a.top - l.top) < 24 && Math.abs(t.top - l.top) < 24
          && a.right <= t.left + 1 && t.right <= l.left + 1;
      })()`),
      await page.evaluate(`JSON.stringify({
        account: document.getElementById("portal-account-toggle").getBoundingClientRect(),
        api: document.getElementById("portal-api-toggle").getBoundingClientRect(),
        logout: document.getElementById("portal-logout").getBoundingClientRect(),
      })`),
    );
  }

  await page.clearViewport();

  /* 元の状態へ戻す。以降の検査は portalStub のままで動かす。 */
  await page.send('Page.removeScriptToEvaluateOnNewDocument', {
    identifier: apiStub.result.identifier,
  });
  await page.evaluate('localStorage.removeItem("tsam-api-keys")');
  await page.goto(`${origin}/portal/`, 1500);

  /* ---------------------------------------------------------------- */
  section('Portal のレイアウト（続き）');

  /* ---- テストからアプリ定義を注入して体裁を見る ---- */

  /*
   * 画面が使っているのと同じ描画経路（renderAppsGrid）へ定義を渡す。
   * DOM を手で組むと、実装が変わっても気づけない。
   */
  const INJECT_APPS = `[
    { id: 'voice', name: '音声録音・MP3変換', icon: '録', href: 'production-app/voice/' },
    { id: 'knowledge', name: 'ナレッジチャット', href: 'production-app/knowledge/' },
    { id: 'card', name: '名刺読み取り', href: 'production-app/card/' }
  ]`;

  await page.evaluate(`
    import('./portal.js').then((m) => m.renderAppsGrid(${INJECT_APPS},
      { stored: { version: 2, order: ['voice', 'knowledge', 'card'] } }))
  `);
  await page.sleep(250);

  check(
    '注入した3件がカードになる（残りは準備中のまま）',
    await page.evaluate(`
      document.querySelectorAll("#portal-apps .auth-app-card__link").length === 3
      && document.querySelectorAll("#portal-apps .auth-app-card--empty").length === 13
    `),
    await page.evaluate(`JSON.stringify({
      cards: document.querySelectorAll("#portal-apps .auth-app-card__link").length,
      empty: document.querySelectorAll("#portal-apps .auth-app-card--empty").length,
    })`),
  );

  check(
    'カードはアイコンと名前を持つ',
    await page.evaluate(`
      [...document.querySelectorAll("#portal-apps .auth-app-card__link")].every((link) =>
        link.querySelector(".auth-app-card__icon")
        && link.querySelector(".auth-app-card__name"))
    `),
  );

  /*
   * カードはリンクとグリップの2つだけを持つ。
   * リンクが1つであること（＝本体のどこを押しても同じ場所へ行く）は変わらない。
   */
  check(
    'カード本体は1つのリンク、その両肩に「外す」とグリップ',
    await page.evaluate(`
      [...document.querySelectorAll("#portal-apps .auth-app-card:not(.auth-app-card--empty)")].every((card) =>
        card.children.length === 3
        && card.firstElementChild.tagName === "A"
        && card.querySelectorAll("a").length === 1
        && card.querySelector(".auth-app-card__remove") !== null
        && card.lastElementChild.classList.contains("auth-app-card__grip"))
    `),
  );

  check(
    'href はサイトのルートからの相対パスとして解決される',
    await page.evaluate(`
      document.querySelector("#portal-apps .auth-app-card__link").getAttribute("href") === "../production-app/voice/"
    `),
    await page.evaluate('document.querySelector("#portal-apps .auth-app-card__link").getAttribute("href")'),
  );

  check(
    'カードの角丸が12px',
    await page.evaluate(`
      getComputedStyle(document.querySelector("#portal-apps .auth-app-card__link")).borderTopLeftRadius === "12px"
    `),
    await page.evaluate('getComputedStyle(document.querySelector("#portal-apps .auth-app-card__link")).borderTopLeftRadius'),
  );

  check(
    'カードの中身が中央寄せ',
    await page.evaluate(`
      getComputedStyle(document.querySelector("#portal-apps .auth-app-card__link")).textAlign === "center"
    `),
  );

  check(
    'アイコンが省略されたら名前の1文字目を使う',
    (await page.evaluate('document.querySelectorAll("#portal-apps .auth-app-card__icon")[1].textContent')) === 'ナ',
  );

  /* ---- 9件ならページ数が3になる ---- */

  /*
   * 8枠を1ページとするので、9件は ceil(9/8) = 2 ページに収まる。
   * 「3ページになる」ことを確かめるには 17 件が要る。
   * 依頼の「9件で3ページ」は 8枠×2ページ＝16枠 を超える件数のことなので、
   * 9件（=2ページ）と 17件（=3ページ）の両方を押さえる。
   */
  await page.evaluate(`
    import('./portal.js').then((m) => m.renderAppsGrid(
      Array.from({ length: 9 }, (unused, i) => ({ id: 'a' + i, name: 'App ' + i, href: 'x/' })),
      { stored: { version: 2, order: Array.from({ length: 9 }, (u, i) => 'a' + i) } }
    ))
  `);
  await page.sleep(250);

  check(
    '9件ならページ数は2（ceil(9/8)=2）',
    await page.evaluate(`
      document.querySelectorAll("#portal-apps .auth-apps__page").length === 2
      && document.querySelectorAll("#portal-apps-dots .auth-apps__dot").length === 2
      && document.querySelectorAll("#portal-apps .auth-app-card__link").length === 9
    `),
    await page.evaluate(`JSON.stringify({
      pages: document.querySelectorAll("#portal-apps .auth-apps__page").length,
      cards: document.querySelectorAll("#portal-apps .auth-app-card__link").length,
    })`),
  );

  await page.evaluate(`
    import('./portal.js').then((m) => m.renderAppsGrid(
      Array.from({ length: 17 }, (unused, i) => ({ id: 'b' + i, name: 'App ' + i, href: 'x/' })),
      { stored: { version: 2, order: Array.from({ length: 17 }, (u, i) => 'b' + i) } }
    ))
  `);
  await page.sleep(250);

  check(
    '17件ならページ数が3になる（3ページ目が自動で増える）',
    await page.evaluate(`
      document.querySelectorAll("#portal-apps .auth-apps__page").length === 3
      && document.querySelectorAll("#portal-apps-dots .auth-apps__dot").length === 3
    `),
    await page.evaluate('document.querySelectorAll("#portal-apps .auth-apps__page").length'),
  );

  check(
    'ページを増やしても1ページ目から始まる',
    await page.evaluate(`
      document.querySelectorAll("#portal-apps .auth-apps__page")[0].hidden === false
      && document.querySelectorAll("#portal-apps-dots .auth-apps__dot")[0].getAttribute("aria-current") === "true"
    `),
  );

  /* ---------------------------------------------------------------- */
  section('アプリの並べ替え（第2便）');

  /* 指定した件数のアプリを注入し、保存も消して初期状態から始める。 */
  const injectApps = async (count) => {
    await page.evaluate('localStorage.removeItem("tsam-app-layout")');
    await page.evaluate(`
      import('./portal.js').then((m) => m.renderAppsGrid(
        Array.from({ length: ${count} }, (unused, i) => ({
          id: 'app' + i, name: 'アプリ' + i, href: 'x/',
        })),
        { stored: { version: 2, order: Array.from({ length: ${count} }, (u, i) => 'app' + i) } },
      ))
    `);
    await page.sleep(250);
  };

  /* 画面上の並びを id で取り出す。 */
  const shownOrder = async () => JSON.parse(await page.evaluate(`
    JSON.stringify([...document.querySelectorAll("#portal-apps .auth-app-card[data-app-id]")]
      .map((c) => c.dataset.appId))
  `));

  const savedOrder = async () => {
    const raw = await page.evaluate('localStorage.getItem("tsam-app-layout")');
    return raw === null ? null : JSON.parse(raw);
  };

  /* 要素の中心座標。ドラッグの始点・終点に使う。 */
  const centerOf = async (selector) => JSON.parse(await page.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return "null";
    const r = el.getBoundingClientRect();
    return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) });
  })()`));

  const mouse = async (type, point, extra = {}) => {
    await page.send('Input.dispatchMouseEvent', {
      type, x: point.x, y: point.y, button: 'left', clickCount: 1, ...extra,
    });
  };

  /*
   * ポインターで掴んで運んで落とす。
   * 途中の座標も送る。1回で飛ばすと、実際の指の動きと違う経路になる。
   */
  const dragFromTo = async (fromSel, toSel, { release = true } = {}) => {
    const from = await centerOf(fromSel);
    const to = await centerOf(toSel);

    await mouse('mousePressed', from, { buttons: 1 });
    await page.sleep(60);
    await mouse('mouseMoved', { x: Math.round((from.x + to.x) / 2), y: Math.round((from.y + to.y) / 2) }, { buttons: 1 });
    await page.sleep(60);
    await mouse('mouseMoved', to, { buttons: 1 });
    await page.sleep(120);

    if (release) {
      await mouse('mouseReleased', to, { buttons: 0 });
      await page.sleep(200);
    }

    return to;
  };

  await injectApps(3);

  /* ---- グリップの有無 ---- */

  check(
    '実アプリの枠だけにグリップが付く',
    await page.evaluate(`
      document.querySelectorAll("#portal-apps .auth-app-card__grip").length === 3
      && document.querySelectorAll(".auth-app-card--empty .auth-app-card__grip").length === 0
    `),
    await page.evaluate('document.querySelectorAll("#portal-apps .auth-app-card__grip").length'),
  );

  check(
    '準備中の枠にグリップは無い',
    await page.evaluate(`
      [...document.querySelectorAll("#portal-apps .auth-app-card--empty")]
        .every((c) => c.querySelector("button") === null)
    `),
  );

  check(
    'グリップは button で aria-label を持つ',
    await page.evaluate(`(() => {
      const g = document.querySelector("#portal-apps .auth-app-card__grip");
      return g.tagName === "BUTTON" && g.type === "button"
        && g.getAttribute("aria-label") === "アプリ0 を移動";
    })()`),
    await page.evaluate('document.querySelector("#portal-apps .auth-app-card__grip").getAttribute("aria-label")'),
  );

  /* スクロールとの競合を構造的に断つ指定。 */
  check(
    'グリップに touch-action: none が効いている',
    (await page.evaluate(`
      getComputedStyle(document.querySelector("#portal-apps .auth-app-card__grip")).touchAction
    `)) === 'none',
    await page.evaluate('getComputedStyle(document.querySelector("#portal-apps .auth-app-card__grip")).touchAction'),
  );

  /* ---- グリップ以外からは始まらない ---- */

  /*
   * カード本体は `a`。押して離すと遷移してしまうため、
   * この検査のあいだだけ既定動作を止める（テスト用の足場）。
   */
  await page.evaluate(`
    window.__blockNav = (e) => { if (e.target.closest(".auth-app-card__link")) e.preventDefault(); };
    document.addEventListener("click", window.__blockNav, true);
  `);

  await dragFromTo('.auth-app-card[data-app-id="app0"] .auth-app-card__link',
    '.auth-app-card[data-app-id="app2"]');

  check(
    'カード本体からはドラッグが始まらない（並びが変わらない）',
    JSON.stringify(await shownOrder()) === JSON.stringify(['app0', 'app1', 'app2']),
    JSON.stringify(await shownOrder()),
  );

  check(
    'カード本体からのドラッグでは保存もされない',
    (await savedOrder()) === null,
  );

  await page.evaluate('document.removeEventListener("click", window.__blockNav, true)');

  /* ---- グリップで並べ替える ---- */

  await dragFromTo('.auth-app-card[data-app-id="app0"] .auth-app-card__grip',
    '.auth-app-card[data-app-id="app2"]');

  check(
    'グリップで掴んで落とすと並びが変わる（押しのけ方式）',
    JSON.stringify(await shownOrder()) === JSON.stringify(['app1', 'app2', 'app0']),
    JSON.stringify(await shownOrder()),
  );

  check(
    '落とした時点で保存される',
    JSON.stringify(await savedOrder()) === JSON.stringify({ version: 2, order: ['app1', 'app2', 'app0'] }),
    JSON.stringify(await savedOrder()),
  );

  check(
    'ドラッグが終わればゴーストは残らない',
    await page.evaluate('document.querySelector(".auth-app-card--ghost") === null'),
  );

  /* ---- 再読み込みで復元される ---- */

  await page.goto(`${origin}/portal/`, 1500);
  await page.evaluate(`
    import('./portal.js').then((m) => m.renderAppsGrid(
      Array.from({ length: 3 }, (unused, i) => ({ id: 'app' + i, name: 'アプリ' + i, href: 'x/' }))
    ))
  `);
  await page.sleep(250);

  check(
    '再読み込みしても並びが復元される',
    JSON.stringify(await shownOrder()) === JSON.stringify(['app1', 'app2', 'app0']),
    JSON.stringify(await shownOrder()),
  );

  /* ---- ドラッグ中のゴーストと穴 ---- */

  await injectApps(3);
  await dragFromTo('.auth-app-card[data-app-id="app0"] .auth-app-card__grip',
    '.auth-app-card[data-app-id="app2"]', { release: false });

  check(
    'ドラッグ中はゴーストがポインターに追従する',
    await page.evaluate(`(() => {
      const g = document.querySelector(".auth-app-card--ghost");
      if (!g) return false;
      const s = getComputedStyle(g);
      return s.position === "fixed" && s.pointerEvents === "none";
    })()`),
  );

  check(
    'ドラッグ中は掴んだ位置に穴が開く',
    await page.evaluate('document.querySelectorAll(".auth-app-card--dragging").length === 1'),
  );

  check(
    'ドラッグ中はまわりのカードが押しのけられて寄る（挿入位置がその場で見える）',
    JSON.stringify(await shownOrder()) === JSON.stringify(['app1', 'app2', 'app0']),
    JSON.stringify(await shownOrder()),
  );

  /* ---- Esc で取り消す ---- */

  await page.send('Input.dispatchKeyEvent', {
    type: 'keyDown', windowsVirtualKeyCode: 27, key: 'Escape', code: 'Escape',
  });
  await page.send('Input.dispatchKeyEvent', {
    type: 'keyUp', windowsVirtualKeyCode: 27, key: 'Escape', code: 'Escape',
  });
  await page.sleep(200);

  check(
    'Esc で元の位置へ戻る',
    JSON.stringify(await shownOrder()) === JSON.stringify(['app0', 'app1', 'app2']),
    JSON.stringify(await shownOrder()),
  );

  check(
    'Esc で取り消したら保存されない',
    (await savedOrder()) === null,
    JSON.stringify(await savedOrder()),
  );

  check(
    'Esc のあとゴーストも穴も消えている',
    await page.evaluate(`
      document.querySelector(".auth-app-card--ghost") === null
      && document.querySelectorAll(".auth-app-card--dragging").length === 0
    `),
  );

  /* 取り消したあとも、掴み直して操作を続けられる。 */
  await mouse('mouseReleased', await centerOf('.auth-apps'), { buttons: 0 });
  await page.sleep(100);

  /* ---- ページまたぎ移動 ---- */

  /*
   * 9件だとグリッドが縦に伸び、既定の高さではドットが画面の外に出る。
   * elementFromPoint は表示領域の外を拾えないため、ここだけ縦を広げる。
   * （実利用でも、ドットが見えていないところへは重ねられない。）
   */
  await page.setViewport(1024, 1200);
  await injectApps(9);

  check(
    '（前提）9件は2ページに分かれ、app8 が2ページ目にいる',
    await page.evaluate(`
      document.querySelectorAll("#portal-apps .auth-apps__page").length === 2
      && document.querySelectorAll("#portal-apps-page-2 .auth-app-card[data-app-id]").length === 1
    `),
  );

  /* 1ページ目の app0 を掴み、2ページ目のドットへ重ねてページを送る。 */
  const gripFrom = await centerOf('.auth-app-card[data-app-id="app0"] .auth-app-card__grip');
  const dot2 = await centerOf('#portal-apps-dots .auth-apps__dot:nth-child(2)');

  await mouse('mousePressed', gripFrom, { buttons: 1 });
  await page.sleep(60);
  await mouse('mouseMoved', dot2, { buttons: 1 });
  await page.sleep(300);

  check(
    'ドラッグ中にドットへ重ねるとそのページへ切り替わる',
    await page.evaluate(`
      document.querySelectorAll("#portal-apps .auth-apps__page")[1].hidden === false
    `),
  );

  check(
    'ページを送ってもドラッグは続いている',
    await page.evaluate('document.querySelector(".auth-app-card--ghost") !== null'),
  );

  /* そのまま2ページ目の枠へ落とす。 */
  const slotOnPage2 = await centerOf('#portal-apps-page-2 .auth-app-card:nth-child(2)');
  await mouse('mouseMoved', slotOnPage2, { buttons: 1 });
  await page.sleep(150);
  await mouse('mouseReleased', slotOnPage2, { buttons: 0 });
  await page.sleep(250);

  const crossed = await savedOrder();

  check(
    'ページをまたいで移動できる（app0 が末尾側へ動く）',
    crossed !== null && crossed.order[0] === 'app1'
    && crossed.order.indexOf('app0') >= 8,
    JSON.stringify(crossed),
  );

  await page.clearViewport();

  /* ---- 準備中の並びへ落とすと末尾扱い ---- */

  await injectApps(3);
  await dragFromTo('.auth-app-card[data-app-id="app0"] .auth-app-card__grip',
    '#portal-apps-page-1 .auth-app-card--empty');

  check(
    '準備中の枠へ落とすと末尾へ入る',
    JSON.stringify((await savedOrder())?.order) === JSON.stringify(['app1', 'app2', 'app0']),
    JSON.stringify(await savedOrder()),
  );

  /* ---- タッチ相当のポインター操作 ---- */

  await injectApps(3);

  const touchFrom = await centerOf('.auth-app-card[data-app-id="app0"] .auth-app-card__grip');
  const touchTo = await centerOf('.auth-app-card[data-app-id="app2"]');

  await page.send('Input.dispatchTouchEvent', {
    type: 'touchStart', touchPoints: [{ x: touchFrom.x, y: touchFrom.y, id: 1 }],
  });
  await page.sleep(80);
  await page.send('Input.dispatchTouchEvent', {
    type: 'touchMove', touchPoints: [{ x: touchTo.x, y: touchTo.y, id: 1 }],
  });
  await page.sleep(150);
  await page.send('Input.dispatchTouchEvent', {
    type: 'touchEnd', touchPoints: [],
  });
  await page.sleep(250);

  check(
    'タッチのポインターでも並べ替えられる',
    JSON.stringify(await shownOrder()) === JSON.stringify(['app1', 'app2', 'app0']),
    JSON.stringify(await shownOrder()),
  );

  check(
    'タッチでドラッグしても画面がスクロールしない',
    (await page.evaluate('window.scrollY')) === 0,
    await page.evaluate('window.scrollY'),
  );

  /* ---- キーボード操作 ---- */

  await injectApps(3);

  const pressOn = async (key, code, keyCode, text) => {
    await page.send('Input.dispatchKeyEvent', {
      type: 'keyDown', windowsVirtualKeyCode: keyCode, key, code, text,
    });
    await page.send('Input.dispatchKeyEvent', {
      type: 'keyUp', windowsVirtualKeyCode: keyCode, key, code,
    });
    await page.sleep(180);
  };

  await page.evaluate('document.querySelector(\'.auth-app-card__grip[data-app-id="app0"]\').focus()');
  await pressOn('Enter', 'Enter', 13, '\r');

  check(
    'Enter で移動モードに入る',
    await page.evaluate('document.querySelectorAll(".auth-app-card--moving").length === 1'),
  );

  check(
    '移動モードに入ったことを読み上げへ伝える',
    (await page.evaluate('document.getElementById("portal-apps-live").textContent')).includes('矢印キーで移動'),
    await page.evaluate('document.getElementById("portal-apps-live").textContent'),
  );

  await pressOn('ArrowRight', 'ArrowRight', 39);

  check(
    '矢印キーで位置が動く',
    JSON.stringify(await shownOrder()) === JSON.stringify(['app1', 'app0', 'app2']),
    JSON.stringify(await shownOrder()),
  );

  check(
    '移動のたびに現在位置を読み上げへ伝える',
    (await page.evaluate('document.getElementById("portal-apps-live").textContent')) === '2番目に移動',
    await page.evaluate('document.getElementById("portal-apps-live").textContent'),
  );

  check(
    '確定するまでは保存しない',
    (await savedOrder()) === null,
    JSON.stringify(await savedOrder()),
  );

  await pressOn('Enter', 'Enter', 13, '\r');

  check(
    'Enter で確定して保存される',
    JSON.stringify(await savedOrder()) === JSON.stringify({ version: 2, order: ['app1', 'app0', 'app2'] }),
    JSON.stringify(await savedOrder()),
  );

  check(
    '確定すると移動モードから抜ける',
    await page.evaluate('document.querySelectorAll(".auth-app-card--moving").length === 0'),
  );

  /* Esc で取り消す。 */
  await page.evaluate('document.querySelector(\'.auth-app-card__grip[data-app-id="app1"]\').focus()');
  await pressOn('Enter', 'Enter', 13, '\r');
  await pressOn('ArrowRight', 'ArrowRight', 39);
  await pressOn('Escape', 'Escape', 27);

  check(
    'Esc で移動を取り消し、並びが戻る',
    JSON.stringify(await shownOrder()) === JSON.stringify(['app1', 'app0', 'app2']),
    JSON.stringify(await shownOrder()),
  );

  check(
    'Esc で取り消したら保存も変わらない',
    JSON.stringify(await savedOrder()) === JSON.stringify({ version: 2, order: ['app1', 'app0', 'app2'] }),
    JSON.stringify(await savedOrder()),
  );

  check(
    'Space でも移動モードに入れる',
    await (async () => {
      await page.evaluate('document.querySelector(\'.auth-app-card__grip[data-app-id="app1"]\').focus()');
      await pressOn(' ', 'Space', 32, ' ');
      const inMode = await page.evaluate('document.querySelectorAll(".auth-app-card--moving").length === 1');
      await pressOn('Escape', 'Escape', 27);
      return inMode;
    })(),
  );

  /* ---- 初期配置に戻す ---- */

  check(
    '（前提）並べ替えた保存が残っている',
    (await savedOrder()) !== null,
  );

  await page.evaluate('document.getElementById("portal-apps-reset").click()');
  await page.sleep(200);

  check(
    '「初期配置に戻す」は確認を挟む',
    await page.evaluate(`
      document.getElementById("portal-apps-reset-confirm").hidden === false
      && localStorage.getItem("tsam-app-layout") !== null
    `),
  );

  await page.evaluate('document.getElementById("portal-apps-reset-confirm-no").click()');
  await page.sleep(200);

  check(
    '「やめる」なら保存は残る',
    await page.evaluate(`
      document.getElementById("portal-apps-reset-confirm").hidden === true
      && localStorage.getItem("tsam-app-layout") !== null
    `),
  );

  await page.evaluate('document.getElementById("portal-apps-reset").click()');
  await page.sleep(150);
  await page.evaluate('document.getElementById("portal-apps-reset-confirm-yes").click()');
  await page.sleep(250);

  check(
    '「戻す」で保存キーが消える',
    (await savedOrder()) === null,
    JSON.stringify(await savedOrder()),
  );

  check(
    'お気に入りが空になる（初期状態）',
    JSON.stringify(await shownOrder()) === JSON.stringify([]),
    JSON.stringify(await shownOrder()),
  );

  check(
    '外れたアプリはカタログへ戻る',
    (await page.evaluate('document.querySelectorAll("#portal-catalog .auth-app-card").length')) === 3,
    await page.evaluate('document.querySelectorAll("#portal-catalog .auth-app-card").length'),
  );

  await page.evaluate('localStorage.removeItem("tsam-app-layout")');

  /* ---------------------------------------------------------------- */
  section('お気に入りとカタログ（第2.5便）');

  /* 定義だけを渡す。保存が無いので、お気に入りは空・全件カタログになる。 */
  const injectCatalog = async (count) => {
    await page.evaluate('localStorage.removeItem("tsam-app-layout")');
    await page.evaluate(`
      import('./portal.js').then((m) => m.renderAppsGrid(
        Array.from({ length: ${count} }, (unused, i) => ({
          id: 'c' + i, name: 'カタログ' + i, href: 'https://example.com/' + i + '/',
        })),
        { stored: null },
      ))
    `);
    await page.sleep(250);
  };

  const catalogIds = async () => JSON.parse(await page.evaluate(`
    JSON.stringify([...document.querySelectorAll("#portal-catalog .auth-app-card")]
      .map((c) => c.dataset.appId))
  `));

  const favoriteIds = async () => JSON.parse(await page.evaluate(`
    JSON.stringify([...document.querySelectorAll("#portal-apps .auth-app-card[data-app-id]")]
      .map((c) => c.dataset.appId))
  `));

  /* ---- 初期状態 ---- */

  await injectCatalog(3);

  check(
    '初期状態はお気に入り0件・カタログ3件',
    JSON.stringify(await favoriteIds()) === JSON.stringify([])
    && JSON.stringify(await catalogIds()) === JSON.stringify(['c0', 'c1', 'c2']),
    JSON.stringify({ fav: await favoriteIds(), cat: await catalogIds() }),
  );

  check(
    'お気に入りが空でも16枠の「準備中」は並ぶ',
    (await page.evaluate('document.querySelectorAll("#portal-apps .auth-app-card--empty").length')) === 16,
  );

  check(
    'カタログの見出しは「全アプリ一覧」',
    (await page.evaluate('document.getElementById("portal-catalog-title").textContent.trim()')) === '全アプリ一覧',
  );

  check(
    'カタログは2列',
    await page.evaluate(`(() => {
      const cards = [...document.querySelectorAll("#portal-catalog .auth-catalog__page:not([hidden]) .auth-app-card")];
      const top = Math.min(...cards.map((c) => c.getBoundingClientRect().top));
      return cards.filter((c) => Math.abs(c.getBoundingClientRect().top - top) < 2).length === 2;
    })()`),
  );

  check(
    'カタログには埋め枠（準備中）が無い',
    (await page.evaluate('document.querySelectorAll("#portal-catalog .auth-app-card--empty").length')) === 0,
  );

  check(
    'カタログにグリップは付かない',
    (await page.evaluate('document.querySelectorAll("#portal-catalog .auth-app-card__grip").length')) === 0,
  );

  check(
    'カタログの各枠に「お気に入りに追加」があり、押下領域が44px以上',
    await page.evaluate(`(() => {
      const adds = [...document.querySelectorAll("#portal-catalog .auth-app-card__add")];
      return adds.length === 3
        && adds.every((b) => b.tagName === "BUTTON" && b.getBoundingClientRect().height >= 44);
    })()`),
    await page.evaluate('document.querySelector("#portal-catalog .auth-app-card__add")?.getBoundingClientRect().height'),
  );

  check(
    'カタログは1ページなのでページ送りを出さない',
    await page.evaluate('document.getElementById("portal-catalog-pager").hidden === true'),
  );

  check(
    '外部リンクは別タブ・noopener noreferrer',
    await page.evaluate(`
      [...document.querySelectorAll("#portal-catalog .auth-app-card__link")].every((a) =>
        a.target === "_blank" && a.rel.includes("noopener") && a.rel.includes("noreferrer"))
    `),
    await page.evaluate('document.querySelector("#portal-catalog .auth-app-card__link").rel'),
  );

  /* ---- 追加 ---- */

  await page.evaluate('document.querySelector(\'#portal-catalog .auth-app-card__add[data-app-id="c1"]\').click()');
  await page.sleep(250);

  check(
    '追加するとお気に入りの末尾へ入る',
    JSON.stringify(await favoriteIds()) === JSON.stringify(['c1']),
    JSON.stringify(await favoriteIds()),
  );

  check(
    '追加したアプリはカタログから消える',
    JSON.stringify(await catalogIds()) === JSON.stringify(['c0', 'c2']),
    JSON.stringify(await catalogIds()),
  );

  check(
    '追加した時点で保存される',
    (await page.evaluate('localStorage.getItem("tsam-app-layout")'))
      === JSON.stringify({ version: 2, order: ['c1'] }),
    await page.evaluate('localStorage.getItem("tsam-app-layout")'),
  );

  await page.evaluate('document.querySelector(\'#portal-catalog .auth-app-card__add[data-app-id="c0"]\').click()');
  await page.sleep(250);

  check(
    '2件目も末尾へ足される（途中へ割り込ませない）',
    JSON.stringify(await favoriteIds()) === JSON.stringify(['c1', 'c0']),
    JSON.stringify(await favoriteIds()),
  );

  /* ---- 解除 ---- */

  check(
    'お気に入りの枠に「外す」があり、押下領域が44px以上',
    await page.evaluate(`(() => {
      const b = document.querySelector('#portal-apps .auth-app-card__remove[data-app-id="c1"]');
      return b.tagName === "BUTTON"
        && b.getAttribute("aria-label") === "カタログ1 をお気に入りから外す"
        && b.getBoundingClientRect().height >= 44;
    })()`),
    await page.evaluate('document.querySelector("#portal-apps .auth-app-card__remove")?.getAttribute("aria-label")'),
  );

  check(
    '「外す」はグリップと対称の位置（左上／右上）にある',
    await page.evaluate(`(() => {
      const card = document.querySelector('#portal-apps .auth-app-card[data-app-id="c1"]').getBoundingClientRect();
      const rm = document.querySelector('#portal-apps .auth-app-card__remove[data-app-id="c1"]').getBoundingClientRect();
      const gp = document.querySelector('#portal-apps .auth-app-card__grip[data-app-id="c1"]').getBoundingClientRect();
      return Math.abs(rm.left - card.left) < 6 && Math.abs(gp.right - card.right) < 6
        && rm.right <= gp.left;
    })()`),
  );

  await page.evaluate('document.querySelector(\'#portal-apps .auth-app-card__remove[data-app-id="c1"]\').click()');
  await page.sleep(250);

  check(
    '外すとお気に入りから消える（確認は挟まない）',
    JSON.stringify(await favoriteIds()) === JSON.stringify(['c0']),
    JSON.stringify(await favoriteIds()),
  );

  check(
    '外したアプリはカタログの定義順の位置へ戻る',
    JSON.stringify(await catalogIds()) === JSON.stringify(['c1', 'c2']),
    JSON.stringify(await catalogIds()),
  );

  check(
    '外した時点で保存される',
    (await page.evaluate('localStorage.getItem("tsam-app-layout")'))
      === JSON.stringify({ version: 2, order: ['c0'] }),
    await page.evaluate('localStorage.getItem("tsam-app-layout")'),
  );

  /* ---- カタログ0件 ---- */

  await page.evaluate('document.querySelector(\'#portal-catalog .auth-app-card__add[data-app-id="c1"]\').click()');
  await page.sleep(200);
  await page.evaluate('document.querySelector(\'#portal-catalog .auth-app-card__add[data-app-id="c2"]\').click()');
  await page.sleep(250);

  check(
    '全部お気に入りに入れるとカタログは0件',
    JSON.stringify(await catalogIds()) === JSON.stringify([]),
    JSON.stringify(await catalogIds()),
  );

  check(
    'カタログ0件のときは一文だけ出す（枠は並べない）',
    await page.evaluate(`
      document.getElementById("portal-catalog-empty").hidden === false
      && document.getElementById("portal-catalog-empty").textContent.includes("すべてのアプリをお気に入りに追加済みです")
      && document.getElementById("portal-catalog").hidden === true
    `),
  );

  /* ---- 複合シナリオ（追加→並べ替え→解除） ---- */

  await injectCatalog(3);

  for (const id of ['c0', 'c1', 'c2']) {
    await page.evaluate(`document.querySelector('#portal-catalog .auth-app-card__add[data-app-id="${id}"]').click()`);
    await page.sleep(200);
  }

  check(
    '（前提）3件ともお気に入りに入った',
    JSON.stringify(await favoriteIds()) === JSON.stringify(['c0', 'c1', 'c2']),
    JSON.stringify(await favoriteIds()),
  );

  /* キーボードで c0 を2番目へ。 */
  await page.evaluate('document.querySelector(\'#portal-apps .auth-app-card__grip[data-app-id="c0"]\').focus()');
  await pressOn('Enter', 'Enter', 13, '\r');
  await pressOn('ArrowRight', 'ArrowRight', 39);
  await pressOn('Enter', 'Enter', 13, '\r');

  check(
    '並べ替えは従来どおり効く',
    JSON.stringify(await favoriteIds()) === JSON.stringify(['c1', 'c0', 'c2']),
    JSON.stringify(await favoriteIds()),
  );

  await page.evaluate('document.querySelector(\'#portal-apps .auth-app-card__remove[data-app-id="c0"]\').click()');
  await page.sleep(250);

  check(
    '並べ替えたあとに外しても、残りの並びは保たれる',
    JSON.stringify(await favoriteIds()) === JSON.stringify(['c1', 'c2'])
    && (await page.evaluate('localStorage.getItem("tsam-app-layout")'))
      === JSON.stringify({ version: 2, order: ['c1', 'c2'] }),
    await page.evaluate('localStorage.getItem("tsam-app-layout")'),
  );

  check(
    '外したものはカタログの定義順の位置へ戻る',
    JSON.stringify(await catalogIds()) === JSON.stringify(['c0']),
    JSON.stringify(await catalogIds()),
  );

  /* ---- v1 データのフォールバック ---- */

  await page.evaluate(`
    localStorage.setItem("tsam-app-layout", JSON.stringify({ version: 1, order: ["c2", "c1", "c0"] }))
  `);
  await page.evaluate(`
    import('./portal.js').then((m) => m.renderAppsGrid(
      Array.from({ length: 3 }, (unused, i) => ({
        id: 'c' + i, name: 'カタログ' + i, href: 'https://example.com/' + i + '/',
      }))
    ))
  `);
  await page.sleep(250);

  check(
    'v1 の保存はお気に入り空へフォールバックする',
    JSON.stringify(await favoriteIds()) === JSON.stringify([]),
    JSON.stringify(await favoriteIds()),
  );

  check(
    'そのとき全アプリがカタログに出る',
    JSON.stringify(await catalogIds()) === JSON.stringify(['c0', 'c1', 'c2']),
    JSON.stringify(await catalogIds()),
  );

  /* ---- カタログのページ送り（21件で2ページ） ---- */

  await page.evaluate('localStorage.removeItem("tsam-app-layout")');
  await page.evaluate(`
    import('./portal.js').then((m) => m.renderAppsGrid(
      Array.from({ length: 21 }, (unused, i) => ({
        id: 'p' + i, name: 'カタログ' + i, href: 'https://example.com/' + i + '/',
      })),
      { stored: null },
    ))
  `);
  await page.sleep(300);

  check(
    '21件ならカタログは2ページ（20件/ページ）',
    await page.evaluate(`
      document.querySelectorAll("#portal-catalog .auth-catalog__page").length === 2
      && document.querySelectorAll("#portal-catalog-dots .auth-apps__dot").length === 2
    `),
    await page.evaluate('document.querySelectorAll("#portal-catalog .auth-catalog__page").length'),
  );

  check(
    '1ページ目は20件、2ページ目は1件',
    await page.evaluate(`
      document.querySelectorAll("#portal-catalog-page-1 .auth-app-card").length === 20
      && document.querySelectorAll("#portal-catalog-page-2 .auth-app-card").length === 1
    `),
  );

  check(
    'カタログのページ送りが出る（1ページ目から）',
    await page.evaluate(`
      document.getElementById("portal-catalog-pager").hidden === false
      && document.querySelectorAll("#portal-catalog .auth-catalog__page")[0].hidden === false
      && document.querySelectorAll("#portal-catalog-dots .auth-apps__dot")[0].getAttribute("aria-current") === "true"
    `),
  );

  await page.evaluate('document.getElementById("portal-catalog-next").click()');
  await page.sleep(200);

  check(
    'カタログのページを送れる（aria-current も追従）',
    await page.evaluate(`
      document.querySelectorAll("#portal-catalog .auth-catalog__page")[1].hidden === false
      && document.querySelectorAll("#portal-catalog-dots .auth-apps__dot")[1].getAttribute("aria-current") === "true"
      && document.getElementById("portal-catalog-next").disabled === true
    `),
  );

  check(
    'お気に入り側のページ送りは巻き込まれない',
    await page.evaluate(`
      document.querySelectorAll("#portal-apps .auth-apps__page")[0].hidden === false
      && document.querySelectorAll("#portal-apps-dots .auth-apps__dot")[0].getAttribute("aria-current") === "true"
    `),
  );

  /* ---- アイコンのフォールバック ---- */

  await page.evaluate('localStorage.removeItem("tsam-app-layout")');
  await page.evaluate(`
    import('./portal.js').then((m) => m.renderAppsGrid([
      { id: 'img-ok', name: '読める', href: 'x/', icon: '../favicon-32x32.png' },
      { id: 'img-ng', name: '駄目な画像', href: 'x/', icon: 'http://localhost:9/none.svg' },
      { id: 'text', name: '文字アイコン', href: 'x/', icon: '録' }
    ], { stored: null }))
  `);
  await page.sleep(1200);

  check(
    '画像アイコンは読み込めたら表示され、文字は隠れる',
    await page.evaluate(`(() => {
      const icon = document.querySelector('#portal-catalog .auth-app-card[data-app-id="img-ok"] .auth-app-card__icon');
      return icon.classList.contains("auth-app-card__icon--image-ready")
        && icon.querySelector("img") !== null
        && getComputedStyle(icon.querySelector(".auth-app-card__icon-letter")).visibility === "hidden";
    })()`),
    await page.evaluate(`
      document.querySelector('#portal-catalog .auth-app-card[data-app-id="img-ok"] .auth-app-card__icon').className
    `),
  );

  check(
    '読み込みに失敗したら名前の1文字目へ落ちる',
    await page.evaluate(`(() => {
      const icon = document.querySelector('#portal-catalog .auth-app-card[data-app-id="img-ng"] .auth-app-card__icon');
      const letter = icon.querySelector(".auth-app-card__icon-letter");
      return icon.querySelector("img") === null
        && !icon.classList.contains("auth-app-card__icon--image-ready")
        && letter.textContent === "駄"
        && getComputedStyle(letter).visibility === "visible";
    })()`),
    await page.evaluate(`
      document.querySelector('#portal-catalog .auth-app-card[data-app-id="img-ng"] .auth-app-card__icon').innerHTML
    `),
  );

  check(
    '代替は色付きの角丸に出る',
    await page.evaluate(`(() => {
      const s = getComputedStyle(document.querySelector('#portal-catalog .auth-app-card[data-app-id="img-ng"] .auth-app-card__icon'));
      return s.borderTopLeftRadius === "12px" && s.backgroundColor !== "rgba(0, 0, 0, 0)";
    })()`),
  );

  check(
    '文字アイコンはそのまま出る（画像を読みに行かない）',
    await page.evaluate(`(() => {
      const icon = document.querySelector('#portal-catalog .auth-app-card[data-app-id="text"] .auth-app-card__icon');
      return icon.querySelector("img") === null
        && icon.querySelector(".auth-app-card__icon-letter").textContent === "録";
    })()`),
  );

  /* ---- 既定のレジストリ（仮データ3件） ---- */

  await page.evaluate('localStorage.removeItem("tsam-app-layout")');
  await page.goto(`${origin}/portal/`, 1500);
  await page.sleep(600);

  check(
    '既定のレジストリの3件がカタログに出る',
    JSON.stringify(await catalogIds()) === JSON.stringify(['202607No01', '202607No02', '202607No03']),
    JSON.stringify(await catalogIds()),
  );

  check(
    '仮データのアイコンは読み込みに失敗し、頭文字になる',
    await page.evaluate(`
      [...document.querySelectorAll("#portal-catalog .auth-app-card__icon")]
        .every((icon) => !icon.classList.contains("auth-app-card__icon--image-ready")
          && icon.querySelector(".auth-app-card__icon-letter").textContent !== "")
    `),
  );

  check(
    '仮データの外部リンクは別タブ・noopener noreferrer',
    await page.evaluate(`
      [...document.querySelectorAll("#portal-catalog .auth-app-card__link")].every((a) =>
        a.target === "_blank" && a.rel.includes("noopener") && a.rel.includes("noreferrer"))
    `),
  );

  await page.evaluate('localStorage.removeItem("tsam-app-layout")');

  /* ---------------------------------------------------------------- */
  section('スプレッドシートからのアプリ一覧（第3便）');

  /*
   * 実シートへは通信しない。
   * portalStub の window.fetch をさらに包み、CSV出力のURLだけを
   * こちらで差し替える。verifySession は内側のスタブがそのまま返す。
   */
  /*
   * 返す内容は localStorage 経由で渡す。
   * この差し替えは新しい文書ごとに実行されるため、window に置くと
   * 画面を開き直すたびに初期値へ戻ってしまう。
   */
  const sheetStub = await page.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      const innerFetch = window.fetch;

      window.fetch = (url, options) => {
        if (String(url).includes('docs.google.com/spreadsheets')) {
          let plan = null;

          try {
            plan = JSON.parse(localStorage.getItem('__test_sheet') ?? 'null');
          } catch {
            plan = null;
          }

          if (!plan || plan.csv === null) {
            return Promise.reject(new Error('blocked in test'));
          }

          return Promise.resolve(new Response(plan.csv, {
            status: plan.status ?? 200,
            headers: { 'Content-Type': 'text/csv' },
          }));
        }

        return innerFetch(url, options);
      };
    `,
  });

  const SHEET_CSV = [
    'アプリID,アプリ名,アプリURL,アイコンURL',
    'S1,シートのアプリ1,https://example.com/s1/,',
    'S2,"シートの, アプリ2",https://example.com/s2/,',
  ].join('\n');

  const setSheet = async (csv, status = 200) => {
    await page.evaluate(
      `localStorage.setItem('__test_sheet', ${JSON.stringify(JSON.stringify({ csv, status }))})`,
    );
  };

  const openPortal = async () => {
    await page.goto(`${origin}/portal/`, 1500);
    await page.sleep(500);
  };

  /* ---- 取得成功 → 描画の差し替えとキャッシュ ---- */

  await page.evaluate(`
    localStorage.removeItem("tsam-app-layout");
    localStorage.removeItem("tsam-app-registry-cache");
  `);
  await openPortal();
  await setSheet(SHEET_CSV);
  await openPortal();

  check(
    'シートから取れたらその一覧を表示する',
    JSON.stringify(await catalogIds()) === JSON.stringify(['S1', 'S2']),
    JSON.stringify(await catalogIds()),
  );

  check(
    '引用符付きの名前もそのまま出る',
    (await page.evaluate(`
      document.querySelector('#portal-catalog .auth-app-card[data-app-id="S2"] .auth-app-card__name').textContent
    `)) === 'シートの, アプリ2',
  );

  check(
    '取得できたらキャッシュへ控える',
    await page.evaluate(`(() => {
      const raw = localStorage.getItem("tsam-app-registry-cache");
      if (!raw) return false;
      const saved = JSON.parse(raw);
      return saved.version === 1 && saved.apps.length === 2
        && typeof saved.fetchedAt === "string";
    })()`),
    await page.evaluate('localStorage.getItem("tsam-app-registry-cache")'),
  );

  check(
    '取得できたときは警告を出さない',
    await page.evaluate('document.getElementById("portal-apps-message").hidden === true'),
  );

  /* ---- 取得失敗 → キャッシュで描く ---- */

  await setSheet(null);
  await openPortal();

  check(
    '取得に失敗してもキャッシュがあればその一覧を出す',
    JSON.stringify(await catalogIds()) === JSON.stringify(['S1', 'S2']),
    JSON.stringify(await catalogIds()),
  );

  check(
    'キャッシュで描いたときは「更新できませんでした」と伝える',
    await page.evaluate(`
      document.getElementById("portal-apps-message").hidden === false
      && document.getElementById("portal-apps-message").textContent.includes("前回取得した内容")
    `),
    await page.evaluate('document.getElementById("portal-apps-message").textContent'),
  );

  /* ---- 取得失敗＋キャッシュ無し → 組み込みの一覧で描く ---- */

  await page.evaluate('localStorage.removeItem("tsam-app-registry-cache")');
  await openPortal();

  check(
    'キャッシュも無ければ組み込みの仮データ3件で描く',
    JSON.stringify(await catalogIds()) === JSON.stringify(['202607No01', '202607No02', '202607No03']),
    JSON.stringify(await catalogIds()),
  );

  check(
    'そのときは「既定の一覧を表示しています」と伝える',
    await page.evaluate(`
      document.getElementById("portal-apps-message").hidden === false
      && document.getElementById("portal-apps-message").textContent.includes("既定の一覧")
    `),
    await page.evaluate('document.getElementById("portal-apps-message").textContent'),
  );

  /* 401（共有設定が未了）でも同じ扱いになる。 */
  await setSheet('<!DOCTYPE html><body>Sign in</body>', 401);
  await openPortal();

  check(
    '401（共有設定が未了）でも画面は組み込みの一覧で開く',
    JSON.stringify(await catalogIds()) === JSON.stringify(['202607No01', '202607No02', '202607No03'])
    && await page.evaluate('document.getElementById("portal-apps-message").hidden === false'),
    JSON.stringify(await catalogIds()),
  );

  /* ---- シートから消えたIDはお気に入りから外れる ---- */

  await setSheet(SHEET_CSV);
  await openPortal();
  await page.evaluate('document.querySelector(\'#portal-catalog .auth-app-card__add[data-app-id="S1"]\').click()');
  await page.sleep(200);
  await page.evaluate('document.querySelector(\'#portal-catalog .auth-app-card__add[data-app-id="S2"]\').click()');
  await page.sleep(250);

  check(
    '（前提）S1・S2 をお気に入りに入れた',
    JSON.stringify(await favoriteIds()) === JSON.stringify(['S1', 'S2']),
    JSON.stringify(await favoriteIds()),
  );

  /* シートから S1 を消す。 */
  await setSheet([
    'アプリID,アプリ名,アプリURL,アイコンURL',
    'S2,"シートの, アプリ2",https://example.com/s2/,',
  ].join('\n'));
  await openPortal();

  check(
    'シートから消えたIDはお気に入りから自動的に外れる',
    JSON.stringify(await favoriteIds()) === JSON.stringify(['S2']),
    JSON.stringify(await favoriteIds()),
  );

  check(
    '残ったアプリのお気に入りは保たれる（保存は書き換えない）',
    (await page.evaluate('localStorage.getItem("tsam-app-layout")'))
      === JSON.stringify({ version: 2, order: ['S1', 'S2'] }),
    await page.evaluate('localStorage.getItem("tsam-app-layout")'),
  );

  /* ---- シートの値を innerHTML へ流していない ---- */

  await setSheet([
    'アプリID,アプリ名,アプリURL,アイコンURL',
    'X1,<img src=x onerror=alert(1)>,https://example.com/x/,',
    'X2,普通,javascript:alert(1),',
  ].join('\n'));
  await page.evaluate(`
    localStorage.removeItem("tsam-app-layout");
    localStorage.removeItem("tsam-app-registry-cache");
  `);
  await openPortal();

  check(
    'タグを含む名前は文字として出る（要素にならない）',
    await page.evaluate(`(() => {
      const card = document.querySelector('#portal-catalog .auth-app-card[data-app-id="X1"]');
      const name = card.querySelector(".auth-app-card__name");
      return name.textContent === "<img src=x onerror=alert(1)>"
        && name.querySelector("img") === null
        && document.querySelectorAll("#portal-catalog img").length === 0;
    })()`),
    await page.evaluate(`
      document.querySelector('#portal-catalog .auth-app-card[data-app-id="X1"] .auth-app-card__name')?.innerHTML
    `),
  );

  check(
    'javascript: のURLの行は取り込まない',
    (await page.evaluate('document.querySelectorAll(\'#portal-catalog .auth-app-card[data-app-id="X2"]\').length')) === 0,
  );

  check(
    'リンクの href に javascript: が入らない',
    await page.evaluate(`
      [...document.querySelectorAll("#portal-catalog .auth-app-card__link")]
        .every((a) => /^https?:/i.test(a.getAttribute("href")))
    `),
  );

  /* ---- 後始末 ---- */

  await page.send('Page.removeScriptToEvaluateOnNewDocument', {
    identifier: sheetStub.result.identifier,
  });
  await page.evaluate(`
    localStorage.removeItem("tsam-app-layout");
    localStorage.removeItem("tsam-app-registry-cache");
    localStorage.removeItem("__test_sheet");
  `);
  await page.goto(`${origin}/portal/`, 1500);
  await page.sleep(400);

  /* ---- 画面幅ごとの体裁（常に2列・中央寄せ） ---- */

  const PORTAL_WIDTHS = [
    [320, 2],
    [375, 2],
    [768, 2],
    [1024, 2],
    [1440, 2],
  ];

  /* 同じ高さに並ぶカードの数を数えて、実際の列数を測る。 */
  const COLUMN_PROBE = `(() => {
    const cards = [...document.querySelectorAll("#portal-apps .auth-apps__page:not([hidden]) .auth-app-card")];
    const top = Math.min(...cards.map((c) => c.getBoundingClientRect().top));
    return cards.filter((c) => Math.abs(c.getBoundingClientRect().top - top) < 2).length;
  })()`;

  for (const [width, expected] of PORTAL_WIDTHS) {
    await page.setViewport(width, 900);
    await page.goto(`${origin}/portal/`, 1200);

    /* 遷移でカードは消えるため、幅ごとに入れ直す。 */
    await page.evaluate(`
      import('./portal.js').then((m) => m.renderAppsGrid(
        Array.from({ length: 3 }, (unused, i) => ({
          id: 'w' + i, name: 'テスト用アプリ' + (i + 1), href: 'x/',
        })),
        { stored: { version: 2, order: ['w0', 'w1', 'w2'] } }
      ))
    `);
    await page.sleep(250);

    check(
      `${width}px: アプリが${expected}列に並ぶ`,
      (await page.evaluate(COLUMN_PROBE)) === expected,
      await page.evaluate(COLUMN_PROBE),
    );

    /*
     * PCでも幅を広げない。min(360px, 100%) で中央へ置く。
     * 画面幅で列数や位置が変わると、同じアプリを別の位置で覚えることになる。
     */
    check(
      `${width}px: グリッドが min(360px,100%) で中央に置かれる`,
      await page.evaluate(`(() => {
        const grid = document.querySelector(".auth-apps").getBoundingClientRect();
        const shell = document.querySelector(".auth-shell").getBoundingClientRect();
        const expectedWidth = Math.min(360, shell.width);
        const leftGap = grid.left - shell.left;
        const rightGap = shell.right - grid.right;
        return Math.abs(grid.width - expectedWidth) <= 1
          && Math.abs(leftGap - rightGap) <= 1;
      })()`),
      await page.evaluate(`JSON.stringify({
        grid: Math.round(document.querySelector(".auth-apps").getBoundingClientRect().width),
        shell: Math.round(document.querySelector(".auth-shell").getBoundingClientRect().width),
      })`),
    );

    check(
      `${width}px: ページ送りが表示領域に収まる`,
      await page.evaluate(`(() => {
        const pager = document.getElementById("portal-apps-pager").getBoundingClientRect();
        return pager.left >= -1 && pager.right <= document.documentElement.clientWidth + 1;
      })()`),
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

    /*
     * 上部余白の再発検知。
     *
     * 縦センタリングを継承していると、内容が画面の高さより低いあいだ
     * ヘッダーバーが画面の1/3ほど下から始まる。
     * バーの上端がビューポート上端に接していることを、座標で押さえる。
     */
    check(
      `${width}px: ヘッダーバーがビューポート上端に接している`,
      await page.evaluate(`
        Math.abs(document.querySelector(".auth-portal-bar").getBoundingClientRect().top) < 1
      `),
      await page.evaluate(`
        document.querySelector(".auth-portal-bar").getBoundingClientRect().top
      `),
    );

    /*
     * メールアドレスを外したぶん帯には余裕がある。
     * 折り返さず1行に収まり、トグルとログアウトが重ならないことを見る。
     */
    check(
      `${width}px: ヘッダーバーが1行のまま崩れない`,
      await page.evaluate(`(() => {
        const toggle = document.getElementById("portal-account-toggle").getBoundingClientRect();
        const logout = document.getElementById("portal-logout").getBoundingClientRect();
        return Math.abs(toggle.top - logout.top) < 24 && toggle.right <= logout.left + 1;
      })()`),
      await page.evaluate(`JSON.stringify({
        toggle: document.getElementById("portal-account-toggle").getBoundingClientRect(),
        logout: document.getElementById("portal-logout").getBoundingClientRect(),
      })`),
    );

    /* 開いた状態でも横へあふれない。 */
    await page.evaluate('document.getElementById("portal-account-toggle").click()');
    await page.sleep(120);

    const openOverflow = await page.evaluate(
      'document.documentElement.scrollWidth - document.documentElement.clientWidth',
    );
    check(`${width}px: パネルを開いても横スクロールしない`, openOverflow <= 0, openOverflow);

    check(
      `${width}px: 開いたパネルが表示領域に収まる`,
      await page.evaluate(`(() => {
        const panel = document.getElementById("portal-account-panel").getBoundingClientRect();
        return panel.height > 0
          && panel.left >= -1
          && panel.right <= document.documentElement.clientWidth + 1;
      })()`),
    );
  }

  await page.clearViewport();

  /*
   * 内容が画面の高さに満たないときこそ、中央寄せの影響が出る。
   * アプリを入れずに高い画面で開き、それでも上端から始まることを見る。
   */
  await page.setViewport(1024, 1400);
  await page.goto(`${origin}/portal/`, 1200);

  check(
    '内容が短くても上端から詰める（縦センタリングを継承しない）',
    await page.evaluate(`
      Math.abs(document.querySelector(".auth-portal-bar").getBoundingClientRect().top) < 1
    `),
    await page.evaluate(`
      document.querySelector(".auth-portal-bar").getBoundingClientRect().top
    `),
  );

  check(
    'main の縦揃えが上端になっている',
    (await page.evaluate(`
      getComputedStyle(document.getElementById("main-content")).justifyContent
    `)) === 'flex-start',
  );

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

    /* 上端詰めは Portal だけの扱い。他の画面の縦センタリングは変えない。 */
    check(
      `${path} は縦センタリングのまま`,
      (await page.evaluate(`
        getComputedStyle(document.getElementById("main-content")).justifyContent
      `)) === 'center',
      await page.evaluate(`
        getComputedStyle(document.getElementById("main-content")).justifyContent
      `),
    );

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

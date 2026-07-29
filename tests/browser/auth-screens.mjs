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
 * この時点では auth/config.js の apiUrl が未設定である
 * ------------------------------------------------------------------
 * そのため通信は発生せず、API を呼ぶ操作は
 * 「この機能は現在ご利用いただけません。」で止まる。
 * それ自体も確認対象にする（未設定のまま公開しても
 * 画面が壊れず、案内が出ること）。
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
    '未公開の規約はリンクにせず「準備中」と明示している',
    await page.evaluate(`
      [...document.querySelectorAll(".auth-links__pending")].some((li) =>
        li.textContent.includes("利用規約") && li.textContent.includes("準備中"))
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
  section('未設定時の案内（apiUrl が空）');

  await page.goto(`${origin}/login/`);

  const notConfigured = await submitAndReadMessage('taro@example.com', 'Password-For-Test-2026');

  check(
    '通信せずに案内文を出す',
    notConfigured === 'この機能は現在ご利用いただけません。',
    notConfigured,
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

  /* 写しだけを偽造しても入れないこと。 */
  await page.evaluate(`
    localStorage.setItem("tsam-auth-session", "forged-token-value");
    localStorage.setItem("tsam-auth-profile", JSON.stringify({ email: "attacker@example.com", role: "admin" }));
  `);

  await page.goto(`${origin}/portal/`, 1500);

  check(
    'ブラウザ側の値を偽造してもPortalへ入れない',
    (await page.evaluate('location.pathname')).includes('/login/'),
    await page.evaluate('location.pathname'),
  );

  /*
   * 「確認が済むまで描画しない」ことは、配信されるHTMLそのもので確かめる。
   * 遷移が速いため画面を覗く方法では取り逃す。
   * hidden が最初から付いていれば、JS が動く前に中身が出ることはない。
   */
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

  await page.evaluate(`
    document.getElementById("request-email").value = "nobody@example.com";
    document.getElementById("request-form").requestSubmit();
  `);
  await page.sleep(400);

  check(
    'メール送信の案内は登録の有無を示さない文言',
    (await page.evaluate(
      'document.getElementById("request-message").querySelector(".auth-message__body")?.textContent ?? ""',
    )).includes('この機能は現在ご利用いただけません') === true,
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

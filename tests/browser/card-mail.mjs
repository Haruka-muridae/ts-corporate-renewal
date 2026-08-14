/*
 * 名刺メール配信アプリ（public/production-app/card-mail/）の実ブラウザ確認。
 *
 * 確かめること:
 *   - ページが読み込め、ESモジュールの import がすべて解決する（コンソールエラーなし）
 *   - guardPage を通過すると cm-loading が消え cm-content が出る
 *   - app.js が参照する全 DOM ID が存在し、初期表示で連携ボタンが出る
 *   - Google連携→宛先読み込みで、件数・通数・重複数・不正宛先一覧が正しく出る
 *   - 件名・本文・法令チェックがそろうまで送信ボタンが disabled のままである
 *   - 送信すると完了メッセージが出て、Gmailへの raw に To: が含まれない
 *   - 送信が途中で失敗しても、送信済み件数が分かり、再送で1通目を送り直さない
 *
 * ------------------------------------------------------------------
 * 本物の Google／TSAM AI 認証系へ通信しないこと
 * ------------------------------------------------------------------
 * このアプリは Google（Drive・Sheets・Gmail・GIS）と TSAM AI の認証系
 * （script.google.com）の計4+1系統と通信する。実際に叩くと、
 *   - 本物の名刺台帳やメールへ影響しかねない（Gmail送信は取り消せない）
 *   - 本番認証ログへ行が増える
 *   - GIS の同意画面はヘッドレスブラウザでは自動化できない
 * ため、すべて window.fetch と window.google.accounts.oauth2 の
 * 差し替えで賄う。差し替えは Page.addScriptToEvaluateOnNewDocument で、
 * ページ自身のスクリプトより先に実行させる（auth-screens.mjs の
 * portalStub と同じ手法。tests/e2e/voice-recorder/drive.spec.mjs が
 * Playwright の addInitScript で同じことをしている）。
 *
 * GIS の公式スクリプト（accounts.google.com/gsi/client）自体は、
 * window.google.accounts を差し替え時点で先に用意しておくことで
 * 「読み込み済み」と判定させ、そもそも <script> タグを挿入させない
 * （gis-loader.js の isGisLoaded()）。実際の通信もCSPの心配も要らない。
 * ------------------------------------------------------------------
 */

import { check, section, finish, fatal } from '../../public/apps/tests/helpers/assert.mjs';
import { startSuite } from '../../public/apps/tests/helpers/browser-harness.mjs';

/* auth-screens.mjs（20）や apps 側のスイートとポートが衝突しないよう離れた番号を使う。 */
const SUITE_INDEX = 21;

/*
 * app.js が起動時に document.getElementById で束ねる ID の一覧
 * （public/production-app/card-mail/app.js の `el` 組み立てと同じ並び）。
 * ここへ書き写すのは「実装が変わっても、この一覧だけは実装からコピーした
 * ものである」と分かるようにするため。
 */
const APP_DOM_IDS = [
  'cm-loading', 'cm-content',
  'cm-guidance', 'cm-guidance-text', 'cm-connect',
  'cm-recipients', 'cm-recipients-state',
  'cm-count-valid', 'cm-count-batches', 'cm-count-duplicates', 'cm-count-invalid',
  'cm-invalid-panel', 'cm-invalid-list', 'cm-reload',
  'cm-compose', 'cm-subject', 'cm-body', 'cm-legal-check',
  'cm-send', 'cm-progress', 'cm-message',
  'cm-disconnect',
];

/*
 * ページの実スクリプトより先に読み込ませるスタブ。
 *
 *   window.confirm            … 送信前の確認ダイアログ。既定は「OK」。
 *   window.google.accounts.oauth2 … GIS のトークンモデルを模す。
 *   window.fetch               … Google 3系統＋TSAM AI認証系をすべて肩代わりする。
 *
 * 状態は window.__cmDriveConfig / window.__cmGmail / window.__cmOAuthResponse /
 * window.__cmConfirmResult へ後から書き込んで挙動を変える（テスト側から
 * page.evaluate で更新する）。
 */
const STUB_SOURCE = `
window.__cmFetchCalls = [];
window.__cmConfirmCalls = [];
window.__cmConfirmResult = true;
window.__cmDriveConfig = null;
window.__cmGmail = { calls: 0, failOnCall: null, log: [] };
window.__cmOAuthResponse = null;

window.confirm = (message) => {
  window.__cmConfirmCalls.push(message);
  return window.__cmConfirmResult !== false;
};

window.google = {
  accounts: {
    oauth2: {
      initTokenClient: (config) => ({
        requestAccessToken: () => {
          const response = window.__cmOAuthResponse || {
            access_token: 'test-access-token',
            scope: 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/gmail.send',
            expires_in: 3600,
          };

          setTimeout(() => {
            if (response.error) {
              (config.error_callback || config.callback)(response);
            } else {
              config.callback(response);
            }
          }, 0);
        },
      }),
      hasGrantedAllScopes: (response, ...scopes) => {
        const granted = String(response?.scope ?? '').split(/\\s+/);
        return scopes.every((s) => granted.includes(s));
      },
    },
  },
};

function cmRespond(status, body) {
  return Promise.resolve(new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  }));
}

/* Gmail の raw（base64url）を復号する。送信内容の検査に使う。 */
function cmDecodeRaw(raw) {
  let base64 = String(raw).replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) base64 += '=';
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder('utf-8').decode(bytes);
}

window.fetch = (url, options) => {
  const urlText = String(url);
  window.__cmFetchCalls.push({ url: urlText, method: options?.method ?? 'GET' });

  /*
   * TSAM AI 認証系（guardPage の verifySession）。
   *
   * verifySession の宛先は auth-verify Worker（キャッシュ付き代理。
   * public/auth/config.js の verifyApiUrl）で、それ以外の action は
   * Apps Script 直。どちらも同じ応答形なので、ここでは両方の宛先を
   * 同じ分岐で受ける。URL だけで判定して Worker 宛を「想定外」に
   * 落とすと、宛先切替のたびにこのスイートが丸ごと死ぬ（2026-08-14 に
   * 実際に起きた。auth-screens.mjs の portalStub が action で判定して
   * いて無傷だったのと対照的だった）。
   */
  if (urlText.startsWith('https://script.google.com/')
    || urlText.startsWith('https://auth-verify.potenitas-lp.workers.dev')) {
    let body = {};
    try { body = JSON.parse(options?.body ?? '{}'); } catch { /* 空のまま扱う */ }

    if (body.action === 'verifySession') {
      return cmRespond(200, {
        success: true,
        data: { user: { email: 'taro@example.com', role: 'member' } },
      });
    }

    return cmRespond(200, { success: true, data: {} });
  }

  const filesBase = 'https://www.googleapis.com/drive/v3/files';

  if (urlText.startsWith(filesBase + '/')) {
    /*
     * getFileMeta（キャッシュ済みIDの検証）。このテストはキャッシュを
     * 当てにしないため常に404にする。resolveLedger 側は404を
     * 「キャッシュが古い」として検索へフォールバックするので、
     * 挙動としては壊れない（ledger.js の verifyCachedId）。
     */
    return cmRespond(404, { error: { errors: [{ reason: 'notFound' }], message: 'not found' } });
  }

  if (urlText.startsWith(filesBase + '?')) {
    const cfg = window.__cmDriveConfig || {};
    const q = new URL(urlText).searchParams.get('q') ?? '';

    for (const [name, id] of Object.entries(cfg.folders || {})) {
      if (q.includes("name='" + name + "'")) {
        return cmRespond(200, { files: id ? [{ id }] : [] });
      }
    }

    if (q.includes("name='名刺管理'")) {
      return cmRespond(200, { files: cfg.sheetId ? [{ id: cfg.sheetId }] : [] });
    }

    return cmRespond(200, { files: [] });
  }

  if (urlText.startsWith('https://sheets.googleapis.com/')) {
    const cfg = window.__cmDriveConfig || {};

    if (urlText.includes(encodeURIComponent('1:1'))) {
      return cmRespond(200, { values: [cfg.header || []] });
    }

    return cmRespond(200, { values: (cfg.column || []).map((v) => [v]) });
  }

  if (urlText === 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send') {
    const state = window.__cmGmail;
    state.calls += 1;

    let raw = '';
    try { raw = JSON.parse(options.body).raw; } catch { /* 壊れていれば空扱い */ }

    const decoded = cmDecodeRaw(raw);
    const ok = state.failOnCall !== state.calls;

    state.log.push({ ok, raw, decoded });

    if (!ok) {
      /* failStatus を指定すると 429 以外（401 等）でも失敗させられる。 */
      const status = state.failStatus || 429;
      const reason = status === 401 ? 'authError' : 'rateLimitExceeded';
      return cmRespond(status, { error: { errors: [{ reason }], message: 'stubbed failure' } });
    }

    return cmRespond(200, { id: 'msg-' + state.calls });
  }

  /* 想定外の宛先。本番へ実際に送らないよう、通しはせず失敗させる。 */
  return Promise.reject(new TypeError('unexpected fetch in test: ' + urlText));
};
`;

let suite = null;

try {
  suite = await startSuite(SUITE_INDEX);
  const { page, origin } = suite;

  /* ---------------------------------------------------------------- */
  section('準備（セッション・スタブの用意）');

  /*
   * localStorage は オリジン単位。card-mail のページへ行く前に、
   * 同じオリジンの適当なページでトークンを仕込んでおく。
   */
  await page.goto(`${origin}/login/`);
  await page.evaluate(`
    localStorage.clear();
    localStorage.setItem('tsam-auth-session', 'test-session-token');
  `);

  /* 以降のすべてのナビゲーションに、ページ自身のスクリプトより先に効く。 */
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: STUB_SOURCE });

  page.resetRequests();
  await page.goto(`${origin}/production-app/card-mail/`, 1500);

  /* ---------------------------------------------------------------- */
  section('1. 読み込みとコンソールエラー');

  check(
    'コンソールにエラーが出ない（import 解決・実行とも成功）',
    page.consoleErrors.length === 0,
    page.consoleErrors.join(' | '),
  );

  check(
    '本番の script.google.com 以外（TSAM AI 認証系）へは実際に送っていない',
    page.getRequests().every((u) => !u.includes('accounts.google.com') && !u.includes('gsi/client')),
    page.getRequests().filter((u) => u.includes('accounts.google.com')).join(' / '),
  );

  /* ---------------------------------------------------------------- */
  section('2. guardPage を通過すると本文が出る');

  check(
    '読み込み中の表示が消える',
    await page.evaluate('document.getElementById("cm-loading").hidden === true'),
  );

  check(
    '本文が表示される',
    await page.evaluate('document.getElementById("cm-content").hidden === false'),
  );

  /* ---------------------------------------------------------------- */
  section('3. app.js が参照するDOM要素がすべて存在する');

  for (const id of APP_DOM_IDS) {
    const exists = await page.evaluate(`document.getElementById(${JSON.stringify(id)}) !== null`);
    check(`#${id} が存在する`, exists);
  }

  /* ---------------------------------------------------------------- */
  section('4. 初期表示（連携前）');

  check(
    '「Googleと連携する」ボタンが出る',
    (await page.evaluate('document.getElementById("cm-connect").hidden === false'))
    && (await page.evaluate('document.getElementById("cm-connect").textContent.trim()')) === 'Googleと連携する',
  );

  check(
    '案内文が出る',
    (await page.evaluate('document.getElementById("cm-guidance-text").textContent'))
      .includes('Googleと連携すると'),
  );

  check(
    '宛先セクションはまだ出ていない',
    await page.evaluate('document.getElementById("cm-recipients").hidden === true'),
  );

  check(
    '本文入力セクションはまだ出ていない',
    await page.evaluate('document.getElementById("cm-compose").hidden === true'),
  );

  /* ---------------------------------------------------------------- */
  section('5. Google連携→宛先の読み込み（少数・重複と不正を含む）');

  /*
   * 生データ5件 → 有効3件（大文字小文字違いの重複を1件へまとめる）、
   * 重複1件、不正1件、になるように仕込む。
   */
  await page.evaluate(`
    window.__cmDriveConfig = {
      folders: { 'TSAM AI': 'root-folder-id', '名刺データ': 'app-folder-id' },
      sheetId: 'sheet-id-1',
      header: ['record_id', '氏名', 'メールアドレス'],
      column: [
        'taro@example.jp',
        'TARO@EXAMPLE.JP',
        'hanako@example.jp',
        'jiro@example.jp',
        'broken-address',
      ],
    };
  `);

  await page.evaluate('document.getElementById("cm-connect").click();');
  await page.sleep(500);

  check(
    '連携の案内が引っ込む（連携ボタンが消える）',
    await page.evaluate('document.getElementById("cm-connect").hidden === true'),
  );

  check(
    '送信できる宛先は3件',
    (await page.evaluate('document.getElementById("cm-count-valid").textContent')) === '3 件',
    await page.evaluate('document.getElementById("cm-count-valid").textContent'),
  );

  check(
    '送信通数は1通（100件ずつ）',
    (await page.evaluate('document.getElementById("cm-count-batches").textContent')) === '1 通（100件ずつ）',
    await page.evaluate('document.getElementById("cm-count-batches").textContent'),
  );

  check(
    '重複は1件',
    (await page.evaluate('document.getElementById("cm-count-duplicates").textContent')) === '1 件',
  );

  check(
    '不正な宛先は1件',
    (await page.evaluate('document.getElementById("cm-count-invalid").textContent')) === '1 件',
  );

  check(
    '不正な宛先の一覧に元の値が出る',
    (await page.evaluate(`
      JSON.stringify([...document.querySelectorAll("#cm-invalid-list li")].map((li) => li.textContent))
    `)) === JSON.stringify(['broken-address']),
  );

  check(
    '本文入力セクションが出る（送信できる宛先があるため）',
    await page.evaluate('document.getElementById("cm-compose").hidden === false'),
  );

  check(
    '不正な宛先がある旨の案内が出る（エラー表示ではない）',
    (await page.evaluate('document.getElementById("cm-message").textContent')).includes('おすすめします')
    && await page.evaluate('!document.getElementById("cm-message").classList.contains("cm-message--error")'),
  );

  check(
    'ドライブ／シートへは検索・読み取り（GET）だけで、作成のPOSTを出していない',
    (await page.evaluate(`
      JSON.stringify(window.__cmFetchCalls
        .filter((c) => c.url.includes('googleapis.com'))
        .map((c) => c.method))
    `)) === JSON.stringify(Array((await page.evaluate(
      'window.__cmFetchCalls.filter((c) => c.url.includes("googleapis.com")).length',
    ))).fill('GET')),
  );

  /* ---------------------------------------------------------------- */
  section('6. 送信ボタンは件名・本文・法令チェックがそろうまで disabled');

  check(
    '宛先はあるが件名・本文が空の時点では disabled',
    await page.evaluate('document.getElementById("cm-send").disabled === true'),
  );

  await page.evaluate(`
    document.getElementById("cm-subject").value = 'ご挨拶';
    document.getElementById("cm-subject").dispatchEvent(new Event('input'));
  `);

  check(
    '件名だけでは disabled のまま',
    await page.evaluate('document.getElementById("cm-send").disabled === true'),
  );

  await page.evaluate(`
    document.getElementById("cm-body").value = '平素より大変お世話になっております。';
    document.getElementById("cm-body").dispatchEvent(new Event('input'));
  `);

  check(
    '本文まで入れても、法令チェックが無ければ disabled のまま',
    await page.evaluate('document.getElementById("cm-send").disabled === true'),
  );

  await page.evaluate(`
    document.getElementById("cm-legal-check").checked = true;
    document.getElementById("cm-legal-check").dispatchEvent(new Event('change'));
  `);

  check(
    '3つがそろうと送信ボタンが押せるようになる',
    await page.evaluate('document.getElementById("cm-send").disabled === false'),
  );

  await page.evaluate(`
    document.getElementById("cm-legal-check").checked = false;
    document.getElementById("cm-legal-check").dispatchEvent(new Event('change'));
  `);

  check(
    '法令チェックを外すと再び disabled になる（逆方向も効く）',
    await page.evaluate('document.getElementById("cm-send").disabled === true'),
  );

  await page.evaluate(`
    document.getElementById("cm-legal-check").checked = true;
    document.getElementById("cm-legal-check").dispatchEvent(new Event('change'));
  `);

  /* ---------------------------------------------------------------- */
  section('7. 送信（正常系）');

  await page.evaluate('document.getElementById("cm-send").click();');
  await page.sleep(500);

  check(
    '送信前に確認ダイアログを出す',
    (await page.evaluate('window.__cmConfirmCalls.length')) === 1,
  );

  check(
    '確認文言に件数と通数が入る',
    (await page.evaluate('window.__cmConfirmCalls[0]'))
      .includes('3 件の宛先へ 1 通に分けてBCC送信します'),
    await page.evaluate('window.__cmConfirmCalls[0]'),
  );

  check(
    'Gmailへ1回だけ送信する',
    (await page.evaluate('window.__cmGmail.log.length')) === 1,
  );

  const firstRaw = await page.evaluate('window.__cmGmail.log[0].decoded');

  check('Bcc に宛先が入る', firstRaw.includes('taro@example.jp') && firstRaw.includes('hanako@example.jp'));
  check('To ヘッダーが無い（宛先を晒さない）', !/^To:/m.test(firstRaw), firstRaw.slice(0, 200));
  check('From ヘッダーが無い（Gmail側が入れる）', !/^From:/m.test(firstRaw));

  check(
    '完了メッセージが出る',
    (await page.evaluate('document.getElementById("cm-message").textContent'))
      .includes('送信が完了しました（3 件 / 1 通）'),
    await page.evaluate('document.getElementById("cm-message").textContent'),
  );

  check(
    '進捗表示は完了後に消える',
    await page.evaluate('document.getElementById("cm-progress").hidden === true'),
  );

  /* ---------------------------------------------------------------- */
  section('8. 宛先の読み込み直し（100件超で分割・重複なし）');

  /* 150件（重複・不正なし）。100件と50件の2通に割れることを見る。 */
  await page.evaluate(`
    window.__cmDriveConfig = {
      folders: { 'TSAM AI': 'root-folder-id', '名刺データ': 'app-folder-id' },
      sheetId: 'sheet-id-1',
      header: ['record_id', '氏名', 'メールアドレス'],
      column: Array.from({ length: 150 }, (_, i) => 'user' + i + '@example.com'),
    };
    /* 新しい送信の検証のため、Gmail側の記録をいったんリセットする。 */
    window.__cmGmail = { calls: 0, failOnCall: 2, log: [] };
  `);

  await page.evaluate('document.getElementById("cm-reload").click();');
  await page.sleep(500);

  check(
    '150件に更新される',
    (await page.evaluate('document.getElementById("cm-count-valid").textContent')) === '150 件',
  );

  check(
    '100件・50件の2通に分かれる',
    (await page.evaluate('document.getElementById("cm-count-batches").textContent')) === '2 通（100件ずつ）',
  );

  check(
    '重複0件・不正0件',
    (await page.evaluate('document.getElementById("cm-count-duplicates").textContent')) === '0 件'
    && (await page.evaluate('document.getElementById("cm-count-invalid").textContent')) === '0 件',
  );

  check(
    '件名・本文・法令チェックは読み込み直しても保持されている（送信ボタンが押せる）',
    await page.evaluate('document.getElementById("cm-send").disabled === false'),
  );

  /* ---------------------------------------------------------------- */
  section('9. 送信が途中（2通目）で失敗し、再送すると1通目を送り直さない');

  await page.evaluate('document.getElementById("cm-send").click();');
  await page.sleep(500);

  check(
    '2回目の確認ダイアログが150件・2通で出る',
    (await page.evaluate('window.__cmConfirmCalls[1]'))
      .includes('150 件の宛先へ 2 通に分けてBCC送信します'),
    await page.evaluate('window.__cmConfirmCalls[1]'),
  );

  check(
    '1通目は成功、2通目は失敗した状態で止まる',
    (await page.evaluate('window.__cmGmail.log.length')) === 2
    && (await page.evaluate('window.__cmGmail.log[0].ok')) === true
    && (await page.evaluate('window.__cmGmail.log[1].ok')) === false,
  );

  check(
    '送信済み件数（100件・1通）が案内に出る',
    (await page.evaluate('document.getElementById("cm-message").textContent'))
      .includes('送信が途中で失敗しました。100 件（1 通）までは送信済みです。'),
    await page.evaluate('document.getElementById("cm-message").textContent'),
  );

  check(
    '再送を促す文言も出る',
    (await page.evaluate('document.getElementById("cm-message").textContent'))
      .includes('もう一度「送信する」を押すと、残りの宛先だけに送信します。'),
  );

  check(
    '失敗後も送信ボタンは押せる状態に戻る',
    await page.evaluate('document.getElementById("cm-send").disabled === false'),
  );

  /* 次の送信は成功させる（レート制限が解けた想定）。呼び出し数は引き継ぐ。 */
  await page.evaluate('window.__cmGmail.failOnCall = null;');

  await page.evaluate('document.getElementById("cm-send").click();');
  await page.sleep(500);

  check(
    '3回目の確認ダイアログは残りの50件・1通だけ',
    (await page.evaluate('window.__cmConfirmCalls[2]'))
      .includes('50 件の宛先へ 1 通に分けてBCC送信します'),
    await page.evaluate('window.__cmConfirmCalls[2]'),
  );

  check(
    '再送信で新たに1回だけGmailへ送る（合計3回）',
    (await page.evaluate('window.__cmGmail.log.length')) === 3
    && (await page.evaluate('window.__cmGmail.log[2].ok')) === true,
  );

  const secondBatchRaw = await page.evaluate('window.__cmGmail.log[2].decoded');
  const firstBatchRaw = await page.evaluate('window.__cmGmail.log[0].decoded');

  check(
    '再送信された束には残り（101〜150件目）が入る',
    secondBatchRaw.includes('user100@example.com') && secondBatchRaw.includes('user149@example.com'),
  );

  check(
    '★1通目（0〜99件目）は再送信されない（再送の束に含まれない）',
    !secondBatchRaw.includes('user0@example.com') && !secondBatchRaw.includes('user99@example.com'),
    secondBatchRaw.slice(0, 200),
  );

  check(
    '1通目自体は最初の1回しか成功していない（送信済みログに1件だけ）',
    (await page.evaluate(`
      window.__cmGmail.log.filter((entry) => entry.ok && entry.decoded.includes('user0@example.com')).length
    `)) === 1,
  );

  check(
    '1通目・再送分を合わせて150件すべてが1回ずつ送られている',
    firstBatchRaw.includes('user0@example.com') && firstBatchRaw.includes('user99@example.com')
    && !firstBatchRaw.includes('user100@example.com'),
  );

  check(
    '完了メッセージは全体（150件・2通）で出る',
    (await page.evaluate('document.getElementById("cm-message").textContent'))
      .includes('送信が完了しました（150 件 / 2 通）'),
    await page.evaluate('document.getElementById("cm-message").textContent'),
  );

  check(
    '成功した送信のどれにも To: ヘッダーが無い',
    await page.evaluate(`
      window.__cmGmail.log.filter((e) => e.ok).every((e) => !/^To:/m.test(e.decoded))
    `),
  );

  /* ---------------------------------------------------------------- */
  section('10. 送信途中の401→再連携しても、送信済みの束を再送しない');

  /*
   * レビュー所見1の回帰。送信途中でトークンが切れて再連携したとき、
   * 連携ボタンが宛先の再読込（＝再開位置のリセット）を兼ねていると、
   * 案内どおりに操作しただけで送信済みの相手へ二重送信になる。
   * 「途中の再連携はトークンだけ取り直す」ことをここで固定する。
   */

  /* 120件（100件＋20件の2通）。2通目を401で失敗させる。 */
  await page.evaluate(`
    window.__cmDriveConfig = {
      folders: { 'TSAM AI': 'root-folder-id', '名刺データ': 'app-folder-id' },
      sheetId: 'sheet-id-1',
      header: ['record_id', '氏名', 'メールアドレス'],
      column: Array.from({ length: 120 }, (_, i) => 'retry' + i + '@example.com'),
    };
    window.__cmGmail = { calls: 0, failOnCall: 2, failStatus: 401, log: [] };
  `);

  await page.evaluate('document.getElementById("cm-reload").click();');
  await page.sleep(500);

  check(
    '120件・2通に更新される',
    (await page.evaluate('document.getElementById("cm-count-valid").textContent')) === '120 件'
    && (await page.evaluate('document.getElementById("cm-count-batches").textContent')) === '2 通（100件ずつ）',
  );

  await page.evaluate('document.getElementById("cm-send").click();');
  await page.sleep(500);

  check(
    '1通目は成功、2通目が401で止まる',
    (await page.evaluate('window.__cmGmail.log.length')) === 2
    && (await page.evaluate('window.__cmGmail.log[0].ok')) === true
    && (await page.evaluate('window.__cmGmail.log[1].ok')) === false,
  );

  check(
    '再連携の案内と連携ボタンが出る',
    (await page.evaluate('document.getElementById("cm-guidance-text").textContent')).includes('連携し直して')
    && (await page.evaluate('document.getElementById("cm-connect").hidden')) === false,
  );

  check(
    '送信済み（100件・1通）の案内が出る',
    (await page.evaluate('document.getElementById("cm-message").textContent'))
      .includes('100 件（1 通）までは送信済みです'),
    await page.evaluate('document.getElementById("cm-message").textContent'),
  );

  /* トークンが取り直せる状態に戻す（再連携後の送信は成功させる）。 */
  await page.evaluate('window.__cmGmail.failOnCall = null; window.__cmGmail.failStatus = null;');

  await page.evaluate('document.getElementById("cm-connect").click();');
  await page.sleep(500);

  check(
    '★再連携しても宛先を読み直さない（件数はそのまま・再開の案内が出る）',
    (await page.evaluate('document.getElementById("cm-count-valid").textContent')) === '120 件'
    && (await page.evaluate('document.getElementById("cm-message").textContent'))
      .includes('残りの 20 件から再開します'),
    await page.evaluate('document.getElementById("cm-message").textContent'),
  );

  await page.evaluate('document.getElementById("cm-send").click();');
  await page.sleep(500);

  check(
    '確認ダイアログは残りの20件・1通だけ',
    (await page.evaluate('window.__cmConfirmCalls[window.__cmConfirmCalls.length - 1]'))
      .includes('20 件の宛先へ 1 通に分けてBCC送信します'),
    await page.evaluate('window.__cmConfirmCalls[window.__cmConfirmCalls.length - 1]'),
  );

  check(
    '★送信済みの束（retry0〜99）を再送しない',
    (await page.evaluate('window.__cmGmail.log.length')) === 3
    && !(await page.evaluate('window.__cmGmail.log[2].decoded')).includes('retry0@example.com')
    && !(await page.evaluate('window.__cmGmail.log[2].decoded')).includes('retry99@example.com')
    && (await page.evaluate('window.__cmGmail.log[2].decoded')).includes('retry100@example.com')
    && (await page.evaluate('window.__cmGmail.log[2].decoded')).includes('retry119@example.com'),
  );

  check(
    '完了メッセージは全体（120件・2通）で出る',
    (await page.evaluate('document.getElementById("cm-message").textContent'))
      .includes('送信が完了しました（120 件 / 2 通）'),
  );

  check(
    '全束を送り終えたら送信ボタンは無効になる（無反応なボタンを残さない）',
    await page.evaluate('document.getElementById("cm-send").disabled === true'),
  );

  /* ---------------------------------------------------------------- */
  section('11. 最後までコンソールエラーが出ていない');

  check(
    '一連の操作を通してコンソールエラーが無い',
    page.consoleErrors.length === 0,
    page.consoleErrors.join(' | '),
  );

  finish();
} catch (error) {
  fatal(error);
} finally {
  if (suite) {
    await suite.close();
  }
}

/*
 * 接続情報の保存と復元を、**実際に起きる順序で**通す。
 *
 * ==================================================================
 * このスイートを分けた理由
 * ==================================================================
 * 実機で「保存はできているのに、復元できていないように見える」という
 * 壊れ方をした（2026-08-11）。前回のテストは writeConnection →
 * readConnection の往復だけを見ており、**それは通っていた。**
 *
 * すり抜けたのは、実際に起きる順序がその往復ではなかったからである。
 *
 *   保存 → 入力欄を空にする → ページを開き直す（モジュールも作り直される）
 *   → 復元 → **入力欄を触らずに**接続テストが動く
 *
 * ここではその順序をそのまま通す。パネルを本当に mount し、
 * ボタンを押し、GAS へ飛んだ要求に載っている接続キーを見る。
 * ==================================================================
 *
 * 「ページを開き直す」は、import にクエリを付けてモジュールを
 * 評価し直すことで再現する（モジュールのトップレベル変数も作り直される）。
 */

import { check, section, finish, fatal } from '../../public/apps/tests/helpers/assert.mjs';
import { installFakeIndexedDb } from '../helpers/fake-indexeddb.mjs';
import { installFakeNotifierDom, installFakeGasFetch } from '../helpers/fake-notifier-dom.mjs';

const PANEL = '../../public/apps/voice-recorder/notifier-panel.js';

const EXEC_URL = 'https://script.google.com/macros/s/AKfycbxeNexample/exec';
const CONNECT_KEY = 'connect-key-0123456789abcdefghijklmnop';

installFakeIndexedDb();

globalThis.location = {
  href: 'https://tsam-ai.example/production-app/voice-recorder/',
  search: '',
  hash: '',
  origin: 'https://tsam-ai.example',
};

globalThis.history = { replaceState() {} };

/** ページを1枚開く。読み込みごとにモジュールを評価し直す（＝リロード相当）。 */
async function openPage(reloadCount, fetchOptions = {}) {
  const dom = installFakeNotifierDom();
  const calls = installFakeGasFetch({ connectKey: CONNECT_KEY, ...fetchOptions });
  const panel = await import(`${PANEL}?reload=${reloadCount}`);

  await panel.mountNotifier();

  return { dom, calls, panel };
}

try {
  /* ================================================================ */
  section('保存 → 空表示化 → 開き直し → 復元（実機で踏んだ順序）');

  let page = await openPage(1);

  check('最初は未接続（URL欄が空）', page.dom.el('vr-nf-url').value === '');
  check('最初は「保存済み」を出さない', page.dom.el('vr-nf-key-state').hidden === true);
  check('最初は接続の設定が開いている', page.dom.el('vr-nf-connection').open === true);

  /* --- 手動で入力して［接続する］ --- */
  page.dom.el('vr-nf-url').value = EXEC_URL;
  page.dom.el('vr-nf-key').value = CONNECT_KEY;

  await page.dom.click('vr-nf-connect');

  check('接続キーが GAS へ飛んでいる',
    page.calls.some((call) => call.key === CONNECT_KEY), JSON.stringify(page.calls.map((c) => c.action)));
  check('★保存後は入力欄を空にする（秘密を画面に残さない）', page.dom.el('vr-nf-key').value === '');
  check('★空にしたぶん「保存済み」を出す', page.dom.el('vr-nf-key-state').hidden === false);
  check('「保存済み」と読める', page.dom.el('vr-nf-key-state').textContent === '保存済み');
  check('入力を促す文言を出さない（保存済みだと分かる）',
    page.dom.el('vr-nf-key').placeholder.includes('保存済み'));

  /* --- ページを開き直す（モジュールごと作り直す） --- */
  page = await openPage(2);

  check('★開き直すと URL が復元される', page.dom.el('vr-nf-url').value === EXEC_URL,
    page.dom.el('vr-nf-url').value);
  check('★接続キーは入力欄へ戻さない（DOM に秘密を置かない）',
    page.dom.el('vr-nf-key').value === '');
  check('★代わりに「保存済み」を出す（復元できたことが分かる）',
    page.dom.el('vr-nf-key-state').hidden === false);
  check('接続済みなら設定を畳む', page.dom.el('vr-nf-connection').open === false);

  /* --- ここが本題: 無入力のまま接続テストが成立するか --- */
  const before = page.calls.length;

  await page.dom.click('vr-nf-recheck');

  const rechecked = page.calls.slice(before);

  check('★入力せずに接続テストが動く', rechecked.length > 0, String(rechecked.length));
  /* health だけは接続キーを載せない（URLの正しさだけを見るため）。 */
  const keyed = rechecked.filter((call) => call.action !== 'health');

  check('★接続テストが復元した接続キーを使う',
    keyed.length > 0 && keyed.every((call) => call.key === CONNECT_KEY),
    JSON.stringify(rechecked.map((call) => `${call.action}:${call.key}`)));
  check('★接続キーが空で飛んでいない',
    keyed.some((call) => call.key === '' || call.key === null) === false,
    JSON.stringify(keyed.map((call) => `${call.action}:${call.key}`)));
  check('接続先も復元されている',
    rechecked.every((call) => call.url.startsWith(EXEC_URL)), rechecked[0]?.url);
  check('POST の疎通も確かめている', rechecked.some((call) => call.action === 'ping'));
  check('「接続できました」になる', page.dom.el('vr-nf-state-health').textContent === '接続できました',
    page.dom.el('vr-nf-state-health').textContent);

  /* ================================================================ */
  section('★接続済みで［接続する］を押しても行き止まりにならない');

  {
    /*
     * 復元後、接続キー欄は空に見える。そこで［接続する］を押したとき
     * 「接続キーを貼り付けてください。」で止まると、**利用者は詰む**
     * （V2 では接続キーを手元に控えていない）。実機でここに嵌まった。
     */
    const start = page.calls.length;

    page.dom.el('vr-nf-key').value = '';

    await page.dom.click('vr-nf-connect');

    const after = page.calls.slice(start);

    check('★キー未入力でも保存済みのキーで進む', after.length > 0, String(after.length));
    check('★保存済みのキーが使われる',
      after.filter((call) => call.action !== 'health').every((call) => call.key === CONNECT_KEY),
      JSON.stringify(after.map((call) => `${call.action}:${call.key}`)));
    check('入力を促すエラーにならない',
      page.dom.el('vr-nf-message').textContent.includes('接続キーを貼り付けて') === false,
      page.dom.el('vr-nf-message').textContent);
  }

  /* ================================================================ */
  section('★URLだけ差し替えても、キーは保たれる');

  {
    const other = 'https://script.google.com/macros/s/AKfycbzsFI9cOther/exec';
    const start = page.calls.length;

    page.dom.el('vr-nf-url').value = other;
    page.dom.el('vr-nf-key').value = '';

    await page.dom.click('vr-nf-connect');

    check('新しいURLへ繋ぎ直す',
      page.calls.slice(start).every((call) => call.url.startsWith(other)),
      page.calls.at(-1)?.url);

    page = await openPage(3);

    check('★開き直しても新しいURLが残る', page.dom.el('vr-nf-url').value === other);
    check('★キーも残っている（保存済み表示）', page.dom.el('vr-nf-key-state').hidden === false);

    const start2 = page.calls.length;

    await page.dom.click('vr-nf-recheck');

    check('★キーは元のまま使える',
      page.calls.slice(start2)
        .filter((call) => call.action !== 'health')
        .every((call) => call.key === CONNECT_KEY),
      JSON.stringify(page.calls.slice(start2).map((call) => `${call.action}:${call.key}`)));
  }

  /* ================================================================ */
  section('★確認に失敗しても保存される（根本原因そのもの）');

  {
    /*
     * ------------------------------------------------------------------
     * ここが実機で踏んだ穴である
     * ------------------------------------------------------------------
     * 以前は「読めることを確かめてから保存」していた。publicKey は
     * ライセンスが GAS へ届いていないと失敗するので、確認は必ずこける。
     * その結果、保存に**永久に到達しない**。
     *
     * 上の節は確認が成功する道しか通っておらず、この壊れ方をすり抜ける。
     * **確認が失敗する道を通すのが、この節の役目。**
     * ------------------------------------------------------------------
     */
    installFakeIndexedDb().reset();

    const failing = installFakeNotifierDom();

    installFakeGasFetch({ connectKey: CONNECT_KEY, publicKeyError: 'NO_LICENSE' });

    const panel = await import(`${PANEL}?reload=10`);

    await panel.mountNotifier();

    failing.el('vr-nf-url').value = EXEC_URL;
    failing.el('vr-nf-key').value = CONNECT_KEY;

    await failing.click('vr-nf-connect');

    check('確認は失敗している（前提）',
      failing.el('vr-nf-state-key').textContent === '未設定',
      failing.el('vr-nf-state-key').textContent);
    check('★それでも「保存済み」になる', failing.el('vr-nf-key-state').hidden === false);
    check('★失敗しても入力欄のURLを消さない', failing.el('vr-nf-url').value === EXEC_URL);
    check('ライセンス未着だと分かる案内を出す',
      failing.el('vr-nf-hint-key').textContent.includes('ご契約の情報がまだ'),
      failing.el('vr-nf-hint-key').textContent);

    /* --- 開き直す。ここで復元されなければ、実機と同じ壊れ方である。 --- */
    const reopened = installFakeNotifierDom();
    const calls = installFakeGasFetch({ connectKey: CONNECT_KEY });
    const fresh = await import(`${PANEL}?reload=11`);

    await fresh.mountNotifier();

    check('★確認に失敗した接続も、開き直すと復元される',
      reopened.el('vr-nf-url').value === EXEC_URL, reopened.el('vr-nf-url').value);
    check('★接続キーも残っている（保存済み表示）',
      reopened.el('vr-nf-key-state').hidden === false);

    const start = calls.length;

    await reopened.click('vr-nf-recheck');

    check('★無入力の接続テストが、保存済みのキーで通る',
      calls.slice(start)
        .filter((call) => call.action !== 'health')
        .every((call) => call.key === CONNECT_KEY),
      JSON.stringify(calls.slice(start).map((call) => `${call.action}:${call.key}`)));
  }

  /* ================================================================ */
  section('★未接続で接続キーが無ければ、きちんと止める');

  {
    installFakeIndexedDb().reset();

    const dom = installFakeNotifierDom();

    installFakeGasFetch({ connectKey: CONNECT_KEY });

    const panel = await import(`${PANEL}?reload=99`);

    await panel.mountNotifier();

    dom.el('vr-nf-url').value = EXEC_URL;
    dom.el('vr-nf-key').value = '';

    await dom.click('vr-nf-connect');

    check('保存済みが無ければ入力を促す',
      dom.el('vr-nf-message').textContent.includes('接続キーを貼り付けて'),
      dom.el('vr-nf-message').textContent);
    check('「保存済み」は出さない', dom.el('vr-nf-key-state').hidden === true);
  }

  /* ================================================================ */
  section('★ライセンスの引き渡しを、成功したら繰り返さない');

  {
    /*
     * ------------------------------------------------------------------
     * ここが「枠の食い合い」のブラウザ側の入口だった
     * ------------------------------------------------------------------
     * saveLicense が成功したら、ブラウザ側のライセンスキーは消す。
     * 消さないと、画面を開くたび・［接続テスト］のたびに引き渡しを
     * やり直し、その1回ごとに通知用シートがゲートの /v1/vapid を
     * 1回消費する。実機ではこれで1時間ぶんの上限を使い切った
     * （2026-08-11。GAS 側は tests/unit/notifier-template.mjs）。
     * ------------------------------------------------------------------
     */
    installFakeIndexedDb().reset();

    const dom = installFakeNotifierDom();
    const calls = installFakeGasFetch({ connectKey: CONNECT_KEY });
    const config = await import('../../public/apps/voice-recorder/notifier-config.js?reload=200');

    await config.writeConnection({ url: EXEC_URL, key: CONNECT_KEY });
    await config.writeLicenseKey('LK'.padEnd(43, 'q'));

    const panel = await import(`${PANEL}?reload=200`);

    await panel.mountNotifier();

    check('前提: 引き渡しが1回行われる',
      calls.filter((call) => call.action === 'saveLicense').length === 1,
      JSON.stringify(calls.map((call) => call.action)));

    const before = calls.length;

    await dom.click('vr-nf-recheck');
    await dom.click('vr-nf-recheck');

    check('★成功したあとは引き渡しを繰り返さない',
      calls.slice(before).some((call) => call.action === 'saveLicense') === false,
      JSON.stringify(calls.slice(before).map((call) => call.action)));
    check('引き渡し済みのキーは手元に残さない',
      (await config.readLicenseKey()) === '', await config.readLicenseKey());
  }

  /* ================================================================ */
  section('★ゲートの失敗を、次の一手が分かる文にする');

  {
    /*
     * 実機で「通知の鍵: 未設定（/v1/vapid -> RATE_LIMITED）」とだけ出た。
     * **待てば直るのか、こちらの落ち度なのかが利用者に分からない。**
     */
    installFakeIndexedDb().reset();

    const dom = installFakeNotifierDom();

    installFakeGasFetch({
      connectKey: CONNECT_KEY,
      publicKeyError: 'NOT_CONFIGURED',
      lastGateError: '/v1/vapid -> RATE_LIMITED',
    });

    const panel = await import(`${PANEL}?reload=201`);

    dom.el('vr-nf-url').value = EXEC_URL;
    dom.el('vr-nf-key').value = CONNECT_KEY;

    await panel.mountNotifier();
    await dom.click('vr-nf-connect');

    const hint = dom.el('vr-nf-hint-key').textContent;

    check('前提: 鍵は取れていない', dom.el('vr-nf-state-key').textContent === '未設定');
    check('★待てば直ると分かる', hint.includes('数分おいて'), hint);
    check('★次に何をすればよいか書いてある', hint.includes('接続テスト'), hint);
    check('切り分けのための符号は残す', hint.includes('/v1/vapid -> RATE_LIMITED'), hint);
    check('★「セットアップをやり直す」とは言わない', hint.includes('やり直') === false, hint);

    /* 符号の対応表に無いものは、そのまま出す（黙って握りつぶさない）。 */
    check('未知の符号もそのまま読める',
      panel.describeGateError('/v1/vapid -> WHAT_IS_THIS').includes('WHAT_IS_THIS'));
    check('5xx はサーバー側の問題だと分かる',
      panel.describeGateError('/v1/vapid -> HTTP_503').includes('通知サーバーで問題'),
      panel.describeGateError('/v1/vapid -> HTTP_503'));
    check('記録が無ければ何も出さない', panel.describeGateError('') === '');
  }

  /* ================================================================ */
  section('★接続の解除');

  {
    const dom = installFakeNotifierDom();

    installFakeGasFetch({ connectKey: CONNECT_KEY });

    const panel = await import(`${PANEL}?reload=100`);

    await panel.mountNotifier();

    dom.el('vr-nf-url').value = EXEC_URL;
    dom.el('vr-nf-key').value = CONNECT_KEY;
    await dom.click('vr-nf-connect');

    check('前提: 接続できている', dom.el('vr-nf-key-state').hidden === false);

    await dom.click('vr-nf-disconnect');

    check('解除するとURLが消える', dom.el('vr-nf-url').value === '');
    check('★解除すると「保存済み」も消える', dom.el('vr-nf-key-state').hidden === true);

    const reopened = installFakeNotifierDom();

    installFakeGasFetch({ connectKey: CONNECT_KEY });

    const fresh = await import(`${PANEL}?reload=101`);

    await fresh.mountNotifier();

    check('★開き直しても未接続のまま（復活しない）',
      reopened.el('vr-nf-url').value === '' && reopened.el('vr-nf-key-state').hidden === true);
  }

  finish();
} catch (error) {
  fatal(error);
}

/*
 * 録音アプリ側のカレンダー通知（public/apps/voice-recorder/）。
 *
 * ==================================================================
 * 対象はテスト環境である（2026-08-11 に移設）
 * ==================================================================
 * 通知は本番（/production-app/）から**テスト環境（/apps/）へ移した。**
 * 試験の先送りであって廃止ではない（docs/notifier-v2-resume.md）。
 *
 * このスイートは `tests/` 側に置いたままにしてある。中身は Node だけで
 * 動く純関数と文字列の検査であり、`public/apps/tests/` のランナーは
 * Chrome を要求する。**動かすのに要らないものを要求しない**方を採った。
 * ==================================================================
 *
 * 対象要件: recording_calendar_requirements.docx v1.0
 *   FR-15〜FR-20 / NFR-06 / 5.3
 *
 * ==================================================================
 * 配布用GAS（gas-notifier/）はここでは見ない
 * ==================================================================
 * V2 でテンプレート側の作りが変わったため、そちらは notifier-template
 * スイートへ分けた（tests/unit/notifier-template.mjs）。
 * 判定そのものは運営の Workers にあり、notifier-gate スイートが持つ。
 *
 * こちらで固定するのは3つ:
 *   1. 通知本文とURLの組み立て（純関数）
 *   2. 未ログインで通知を開いた経路（?eventId= の復元）
 *   3. 「録音を自動で始めるコードが混ざっていないこと」の文字列監視
 * ==================================================================
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { check, section, finish, fatal } from '../../public/apps/tests/helpers/assert.mjs';
import { REPO_ROOT } from '../helpers/gas-notifier-harness.mjs';
import { NOTIFIER_GATE_ORIGIN } from '../../workers/notifier-gate/origin.mjs';
import { installFakeIndexedDb } from '../helpers/fake-indexeddb.mjs';

/* notifier-config.js は import の時点では触らないが、読み込み前に置いておく。 */
const fakeDb = installFakeIndexedDb();

const APP_DIR = join(REPO_ROOT, 'public/apps/voice-recorder');

/*
 * 通知は移設したが、**`?eventId=` の引き継ぎは本番側に残っている。**
 * これは認証系の元画面復帰につながる話で、通知とは独立に効いているため、
 * 移設の巻き添えで消さなかった（public/production-app/voice-recorder/app.js
 * の `currentEventIdFromUrl` のコメント）。読む先だけ分ける。
 */
const PROD_DIR = join(REPO_ROOT, 'public/production-app/voice-recorder');

function readApp(name) {
  return readFileSync(join(APP_DIR, name), 'utf8');
}

function readProdApp(name) {
  return readFileSync(join(PROD_DIR, name), 'utf8');
}

/*
 * notifier-panel.js は location を読む。読み込み前に偽物を置く
 * （置かなくても import は通るが、値を変えて確かめられない）。
 */
let currentSearch = '';

globalThis.location = {
  get href() { return `https://tsam-ai.example/apps/voice-recorder/${currentSearch}`; },
  get search() { return currentSearch; },
  get origin() { return 'https://tsam-ai.example'; },
};

try {
  const messages = await import('../../public/apps/voice-recorder/notifier-messages.js');
  const panel = await import('../../public/apps/voice-recorder/notifier-panel.js');

  /* ================================================================ */
  section('通知の文言（FR-15 / FR-16 / 5.3）');

  {
    const start = new Date(2026, 7, 10, 10, 0, 0);
    const view = messages.buildNotification({ eventId: 'a', title: '定例MTG', startTime: start.toISOString(), timing: 5 });

    check('タイトルは予定名（FR-15）', view.title === '定例MTG');
    check('本文は「HH:MMから開始します。録音しますか？」（FR-16）',
      view.body === '10:00から開始します。録音しますか？');
    check('tag は eventId|timing', view.tag === 'a|5');

    check('0埋めする', messages.formatClock(new Date(2026, 7, 10, 9, 5, 0)) === '09:05');
    check('読めない時刻は空文字', messages.formatClock('いつか') === '');
    check('★時刻が読めないときは時刻抜きの本文にする',
      messages.buildNotification({ title: 'X', startTime: 'いつか' }).body === 'まもなく開始します。録音しますか？');
    check('★予定名が空でも空タイトルにしない',
      messages.buildNotification({ title: '   ' }).title === messages.FALLBACK_TITLE);

    const fallback = messages.buildFallbackNotification();
    check('取得できないときの表示がある（userVisibleOnly の約束）', fallback.title === messages.FALLBACK_TITLE);
    check('取得できないときも次の操作を示す', fallback.body.includes('録音アプリを開いて'));

    check('対象表示は「対象: 予定名（HH:MM開始）」（5.3）',
      messages.formatEventBanner({ title: '株式会社ABC 定例MTG', startTime: start.toISOString() })
        === '対象: 株式会社ABC 定例MTG（10:00開始）');
    check('予定名が無ければ対象表示を出さない', messages.formatEventBanner({ title: '' }) === '');
    check('時刻が読めなければ予定名だけ出す',
      messages.formatEventBanner({ title: 'A', startTime: '' }) === '対象: A');
  }

  /* ================================================================ */
  section('通知から開くURL（FR-17/18/19）');

  {
    const scope = 'https://tsam-ai.com/apps/voice-recorder/';

    check('eventId をクエリで渡す', messages.buildEventUrl(scope, 'abc') === `${scope}?eventId=abc`);
    check('★eventId をURLエンコードする',
      messages.buildEventUrl(scope, 'a b&c') === `${scope}?eventId=a%20b%26c`);
    check('eventId が無ければスコープだけを開く', messages.buildEventUrl(scope, '') === scope);

    check('スコープ配下の窓は自分の窓', messages.isAppClientUrl(`${scope}?eventId=x`, scope) === true);
    check('★別アプリの窓は自分の窓ではない',
      messages.isAppClientUrl('https://tsam-ai.com/production-app/card-ocr/', scope) === false);
    /*
     * `/apps/` と `/production-app/` は**同一オリジン**にある同名のアプリである。
     * 移設で両者の役割が入れ替わったが、**取り違えてはいけない**という
     * 性質は変わらない。いまは通知が `/apps/` 側にあるので、
     * 本番側の同名アプリを「自分の窓」と見なさないことを確かめる。
     */
    check('★本番側の同名アプリを自分の窓と見なさない',
      messages.isAppClientUrl('https://tsam-ai.com/production-app/voice-recorder/', scope) === false);
    check('スコープが空なら自分の窓とみなさない', messages.isAppClientUrl(scope, '') === false);
  }

  /* ================================================================ */
  section('未ログインで通知を開いた経路（?eventId= の復元）');

  {
    /*
     * 実機で踏んだ不具合: 未ログインで通知をクリックすると、
     * ログイン画面を挟んだ時点で ?eventId= が消え、戻ってきても
     * 「どの予定の通知だったのか」を出せなかった。
     *
     * 引き継ぎの本体は public/auth/session.js にあり、その検証は
     * frontend スイート（「ログイン画面への往復」）が持つ。
     * ここでは録音アプリ側が正しく渡しているかだけを見る。
     */
    currentSearch = '?eventId=abc123';
    check('URLから eventId を読める', panel.currentEventIdFromUrl() === 'abc123');

    currentSearch = '';
    check('eventId が無ければ空文字', panel.currentEventIdFromUrl() === '');

    currentSearch = '?debug=1';
    check('別のクエリだけなら空文字', panel.currentEventIdFromUrl() === '');

    currentSearch = '';

    const app = readProdApp('app.js');

    check('★戻り先を録音アプリにしている（Portal ではない）',
      app.includes("next: 'voiceRecorder'"));
    check('★guardPage へ eventId を渡している',
      app.includes('params: { eventId: currentEventIdFromUrl() }'));
    check('★guardPage より前に eventId を読む（認証で消える前に拾う）',
      app.indexOf('currentEventIdFromUrl()') < app.indexOf('if (!user)'));
    check('★元URLをそのまま引き継ぐ実装になっていない（任意URLを渡さない）',
      !app.includes('location.href') || !app.includes('next: location'));

    const session = readFileSync(join(REPO_ROOT, 'public/auth/session.js'), 'utf8');

    check('録音アプリが next の許可リストに入っている',
      session.includes("ALLOWED_NEXT = ['portal', 'voiceRecorder']"));
    check('★引き継ぐクエリは画面ごとの許可リストで縛っている',
      session.includes('NEXT_PARAM_RULES'));
    check('★eventId の形を正規表現で縛っている',
      session.includes('/^[A-Za-z0-9_-]{1,512}$/'));
  }

  /* ================================================================ */
  section('★配信物の見張り（FR-20 / NFR-06 / CSP）');

  {
    const sw = readApp('sw.js');
    const panel = readApp('notifier-panel.js');
    const client = readApp('notifier-client.js');
    const config = readApp('notifier-config.js');
    const html = readApp('index.html');
    const manifest = JSON.parse(readApp('manifest.webmanifest'));

    for (const [name, source] of [['sw.js', sw], ['notifier-panel.js', panel]]) {
      check(`★${name} に getUserMedia が出てこない（FR-20）`, !source.includes('getUserMedia'));
      check(`★${name} に MediaRecorder が出てこない（FR-20）`, !source.includes('MediaRecorder'));
      check(`★${name} に recorder.start が出てこない（NFR-06）`, !source.includes('recorder.start'));
      check(`★${name} が recorder/ を読み込まない`, !source.includes('./recorder/'));
    }

    check('★sw.js を module で登録しない', !panel.includes("type: 'module'"));
    check('sw.js の登録は import.meta.url からの相対', panel.includes("new URL('./sw.js', import.meta.url)"));
    /*
     * ------------------------------------------------------------------
     * 配置場所を直書きしない（**移設して初めて効いた性質**）
     * ------------------------------------------------------------------
     * 2026-08-11 に /production-app/ から /apps/ へ移したとき、
     * sw.js と notifier-panel.js は**1文字も直さずに動いた。**
     * 開く先も自分の窓かどうかの判定も `self.registration.scope` と
     * `import.meta.url` から作っているためである。
     *
     * 本番へ戻すときも同じでなければならないので、**どちらのパスも
     * 直書きされていないこと**を見る（片方だけ見ると、戻すときに
     * 逆向きの直書きが入り込む）。
     * ------------------------------------------------------------------
     */
    for (const [name, source] of [['sw.js', sw], ['notifier-panel.js', panel]]) {
      check(`★${name} に /production-app/ の直書きが無い`, !source.includes('/production-app/'));
      check(`★${name} に /apps/voice-recorder/ の直書きが無い`, !source.includes('/apps/voice-recorder/'));
    }
    check('sw.js は registration.scope から開く先を作る', sw.includes('self.registration.scope'));

    /* manifest だけは相対で書けない（scope は絶対パス）。移設のたびに直す。 */
    check('manifest の start_url は移設先のパス',
      manifest.start_url === '/apps/voice-recorder/');
    check('manifest の scope も同じ', manifest.scope === '/apps/voice-recorder/');
    check('manifest を index.html から読み込む', html.includes('rel="manifest"'));

    /*
     * ------------------------------------------------------------------
     * CSP は**本番のページ**を見る
     * ------------------------------------------------------------------
     * 通知はテスト環境（`/apps/`）へ移したが、テスト環境の index.html には
     * CSP が無い（この系はもともと持っていない）。**無いものは足さない。**
     *
     * 一方 CSP そのものは本番の配信物として引き続き守る対象なので、
     * 見る先だけを本番へ向ける。緩んだら気づけるようにしておく。
     * ------------------------------------------------------------------
     */
    const prodHtml = readProdApp('index.html');

    check('★本番の connect-src に script.google.com がある',
      prodHtml.includes('connect-src \'self\' https://www.googleapis.com https://script.google.com https://script.googleusercontent.com'));
    check('★本番の CSP に第三者ホストを足していない', !prodHtml.includes('https://cdn.'));
    check('★本番の worker-src は self のまま', prodHtml.includes("worker-src 'self'"));
    check('★テスト環境には CSP を足していない',
      html.includes('Content-Security-Policy') === false);

    check('★接続キーをコンソールへ出していない（sw.js）', !/console\.\w+\([^)]*key/.test(sw));
    check('★接続キーをコンソールへ出していない（panel）', !/console\.\w+\([^)]*\bkey\b/.test(panel));

    check('POST は text/plain（プリフライト回避）', client.includes("'Content-Type': 'text/plain;charset=utf-8'"));
    check('リダイレクトを追う（GASの302）', client.includes("redirect: 'follow'"));

    check('テンプレートのコピーURLが設定済み（TODOのままでない）',
      config.includes('https://docs.google.com/spreadsheets/d/') && config.includes('/copy'));
    check('★IndexedDB の名前が /apps/ と衝突しない形になっている',
      config.includes("DB_NAME = 'tsam-vr-notifier'"));
    check('sw.js の複製が同じ DB 名を使う', sw.includes("DB_NAME = 'tsam-vr-notifier'"));
    check('★sw.js の複製が同じ本文を作る',
      sw.includes('から開始します。録音しますか？'));
  }

  /* ================================================================ */
  section('★引き継ぎリンクの受け口（#setup=）');

  {
    const config = await import('../../public/apps/voice-recorder/notifier-config.js');

    function link(payload) {
      return `#setup=${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}`;
    }

    const valid = config.parseSetupFragment(link({
      execUrl: 'https://script.google.com/macros/s/AKfake123/exec',
      connectKey: 'k'.repeat(43),
    }));

    check('正しいリンクを読める', valid !== null && valid.key === 'k'.repeat(43), JSON.stringify(valid));
    check('URLは /exec まで', valid.url === 'https://script.google.com/macros/s/AKfake123/exec');

    /*
     * ★このリンクは誰でも作れる。信じて保存すると、以後この端末の
     * Service Worker が予定の内容を攻撃者のサーバーへ取りに行くことになる。
     */
    check('★別ドメインの execUrl を受け付けない',
      config.parseSetupFragment(link({
        execUrl: 'https://evil.example.com/macros/s/AK/exec',
        connectKey: 'k'.repeat(43),
      })) === null);
    check('★script.google.com に見せかけたドメインも受け付けない',
      config.parseSetupFragment(link({
        execUrl: 'https://script.google.com.evil.example/macros/s/AK/exec',
        connectKey: 'k'.repeat(43),
      })) === null);
    check('★http は受け付けない',
      config.parseSetupFragment(link({
        execUrl: 'http://script.google.com/macros/s/AK/exec',
        connectKey: 'k'.repeat(43),
      })) === null);
    check('★/exec 以外のパスを受け付けない',
      config.parseSetupFragment(link({
        execUrl: 'https://script.google.com/macros/s/AK/dev',
        connectKey: 'k'.repeat(43),
      })) === null);
    check('接続キーが空なら受け付けない',
      config.parseSetupFragment(link({
        execUrl: 'https://script.google.com/macros/s/AK/exec',
        connectKey: '',
      })) === null);
    check('壊れた base64 は受け付けない', config.parseSetupFragment('#setup=%%%') === null);
    check('#setup= が無ければ null', config.parseSetupFragment('#other=1') === null);

    check('ライセンスキーの形を見る',
      config.isLicenseKeyShaped('L'.repeat(43)) === true
      && config.isLicenseKeyShaped('short') === false);

    /*
     * ★テンプレートのコピーURL。
     * `/edit` のURLを貼ると、利用者が**運営のテンプレートを直接開いてしまう**
     * （閲覧者権限なので壊れはしないが、コピーが作られず先へ進めない）。
     * 差し替えのたびに間違えうるので、形で縛る。
     */
    check('テンプレートのコピーURLは /copy で終わる',
      /^https:\/\/docs\.google\.com\/spreadsheets\/d\/[\w-]+\/copy$/.test(config.TEMPLATE_COPY_URL),
      config.TEMPLATE_COPY_URL);
  }

  /* ================================================================ */
  section('★接続情報の永続化（実機で踏んだ根本）');

  {
    /*
     * 実機の症状: 手動入力して［接続する］→ リロードすると古い値へ戻る。
     * 原因は「確認してから保存」の順序で、確認に失敗すると保存へ到達せず、
     * さらに connection を捨てていたこと。
     *
     * **保存先と復元元が同じであること**を、実際に読み書きして確かめる。
     */
    const config = await import('../../public/apps/voice-recorder/notifier-config.js');

    fakeDb.reset();

    const pair = {
      url: 'https://script.google.com/macros/s/AKfycbxeNexample/exec',
      key: 'connect-key-0123456789abcdefghijklmnop',
    };

    check('最初は未接続', (await config.readConnection()) === null);

    await config.writeConnection(pair);

    const restored = await config.readConnection();

    check('保存した値が読み戻せる',
      restored?.url === pair.url && restored?.key === pair.key, JSON.stringify(restored));

    /* リロードの再現。開き直しても同じ値が出ること。 */
    const afterReload = await config.readConnection();

    check('★開き直しても同じ値（リロードで戻らない）',
      afterReload?.url === pair.url && afterReload?.key === pair.key, JSON.stringify(afterReload));

    /* 上書きが効くこと（別のデプロイへ繋ぎ直す場面）。 */
    const next = { url: 'https://script.google.com/macros/s/AKfycbzsFI9cOther/exec', key: 'another-key-abcdefghijklmnopqrstuvwx' };

    await config.writeConnection(next);
    check('★上書きすると新しい値になる', (await config.readConnection())?.url === next.url);

    await config.clearConnection();
    check('解除すると消える', (await config.readConnection()) === null);

    /* ライセンスキーも同じストアで往復すること。 */
    await config.writeLicenseKey('L'.repeat(43));
    check('ライセンスキーが読み戻せる', (await config.readLicenseKey()) === 'L'.repeat(43));

    await config.clearLicenseKey();
    check('ライセンスキーを消せる', (await config.readLicenseKey()) === '');

    check('接続とライセンスは別々に消える',
      (await config.readConnection()) === null && (await config.readLicenseKey()) === '');
  }

  /* ================================================================ */
  section('★Workspace 形式のURL（実機で接続できなかった形）');

  {
    const config = await import('../../public/apps/voice-recorder/notifier-config.js');

    const domainForm = 'https://script.google.com/a/macros/potenitas.com/s/AKfycbxeNexample/exec';
    const plainForm = 'https://script.google.com/macros/s/AKfycbxeNexample/exec';

    check('★/a/<ドメイン>/ 形式を素の形へ正規化する',
      config.normalizeGasUrl(domainForm) === plainForm, config.normalizeGasUrl(domainForm));
    check('正規化した形は受理される', config.isGasUrl(domainForm) === true);
    check('素の形はそのまま', config.normalizeGasUrl(plainForm) === plainForm);
    check('末尾スラッシュとクエリを落とす',
      config.normalizeGasUrl(`${plainForm}/?usp=x`) === plainForm);

    check('★別ドメインに見せかけた形は受理しない',
      config.isGasUrl('https://script.google.com.evil.example/a/macros/x/s/AK/exec') === false);

    /* 引き継ぎリンクでも同じ正規化が効くこと。 */
    const link = `#setup=${Buffer.from(JSON.stringify({
      execUrl: domainForm,
      connectKey: 'k'.repeat(43),
    }), 'utf8').toString('base64url')}`;

    check('★引き継ぎリンクの /a/ 形式も正規化して受理する',
      config.parseSetupFragment(link)?.url === plainForm,
      JSON.stringify(config.parseSetupFragment(link)));
  }

  /* ================================================================ */
  section('★URL の指紋（どのデプロイに繋いでいるか）');

  {
    const config = await import('../../public/apps/voice-recorder/notifier-config.js');

    const a = await config.execUrlDigest('https://script.google.com/macros/s/AAA/exec');
    const b = await config.execUrlDigest('https://script.google.com/macros/s/BBB/exec');

    check('12文字の16進を返す', /^[0-9a-f]{12}$/.test(a), a);
    check('★URLが違えば指紋も違う', a !== b);
    check('同じURLなら同じ指紋', a === await config.execUrlDigest('https://script.google.com/macros/s/AAA/exec'));
    check('空なら空', (await config.execUrlDigest('')) === '');
  }

  /* ================================================================ */
  section('★フロントの配線（Phase 4）');

  {
    const panel = readApp('notifier-panel.js');
    const client = readApp('notifier-client.js');
    const sw = readApp('sw.js');
    const html = readApp('index.html');

    check('★読み取り直後にフラグメントを消す',
      panel.includes('clearSetupFragment') && panel.includes('history.replaceState'));
    /* mountNotifier の中での順序を見る（定義位置ではなく呼び出し順）。 */
    const mount = panel.slice(panel.indexOf('export async function mountNotifier'));

    check('★引き継ぎ後に接続テストを自動実行する',
      mount.indexOf('applySetupFragment()') !== -1
      && mount.indexOf('applySetupFragment()') < mount.indexOf('await runChecks()'),
      String(mount.indexOf('applySetupFragment()')));
    check('★ライセンスは接続確立後に GAS へ渡す',
      panel.includes('pushLicenseToGas') && client.includes("'saveLicense'"));
    check('★渡せなかったらブラウザ側のキーを消さない',
      panel.includes('キーは消さない'));
    check('★渡し終えたらブラウザ側から消す', panel.includes('clearLicenseKey()'));
    check('認証系からライセンスを受け取る',
      panel.includes('issueNotifierLicense(sessionToken)'));
    check('★未ログインでも行き止まりにしない（案内を出す）',
      panel.includes('ログインし直してください'));
    check('★entitlement が無くても手続きは進める',
      panel.includes("result.entitled !== true"));

    check('直近の通知予定を出す', panel.includes('fetchUpcoming') && html.includes('vr-nf-upcoming'));
    check('テスト通知のボタンがある', panel.includes('handleTestNotification') && html.includes('vr-nf-test'));
    check('★通知が許可されていなければテスト通知を送らない',
      panel.includes("Notification.permission !== 'granted'"));
    check('ライセンス状態を出す', html.includes('vr-nf-license-state'));
    check('★expired のときだけ料金ページへ誘導する',
      panel.includes("link.hidden = summary.state !== 'expired'"));
    check('チェッカーは6項目', (html.match(/vr-nf-state-/g) || []).length === 6,
      String((html.match(/vr-nf-state-/g) || []).length));

    check('★Service Worker が endpoint を添えて pending を呼ぶ',
      sw.includes("gasGet(connection, 'pending', { endpoint: subscription.endpoint })"));
    check('★購読が無ければ pending を呼ばない', sw.includes('if (!subscription)'));

    check('★予定名は textContent で入れる（innerHTML を使わない）',
      /\.innerHTML/.test(panel) === false);

    /* ---- 実機で踏んだ順序の固定（2026-08-11） ---- */
    const connect = panel.slice(
      panel.indexOf('async function handleConnect'),
      panel.indexOf('async function handleDisconnect'),
    );

    check('★[接続する]は確認より先に保存する（リロードで消えない）',
      connect.indexOf('writeConnection(connection)') < connect.indexOf('runChecks()'),
      String(connect.indexOf('writeConnection(connection)')));
    check('★ライセンスの引き渡しを publicKey より先に行う（鶏卵を作らない）',
      connect.indexOf('pushLicenseToGas()') !== -1
      && connect.indexOf('pushLicenseToGas()') < connect.indexOf('runChecks()'));
    check('★失敗しても接続情報を捨てない',
      /catch[\s\S]*connection = null/.test(connect) === false, connect.slice(-400));

    const checks = panel.slice(panel.indexOf('async function runChecks'), panel.indexOf('function permissionLabel'));

    check('★接続テストで POST の疎通も見る', checks.includes('pingGas(connection)'));
    check('★シートの公開URLと接続先の指紋を突き合わせる',
      checks.includes('execUrlDigest(connection.url)') && checks.includes('execUrlDigest'));
    check('★ライセンス未着を「セットアップ未完了」と混ぜない',
      checks.includes('NotifierErrorCode.NO_LICENSE'));

    const html2 = readApp('index.html');

    check('★接続キー欄をパスワードマネージャに拾わせない',
      html2.includes('autocomplete="new-password"') && html2.includes('data-1p-ignore'),
      'autocomplete');
  }

  /* ================================================================ */
  section('★本番の CSP から通知ゲートが外れていること');

  {
    /*
     * ------------------------------------------------------------------
     * 使わない許可は置かない
     * ------------------------------------------------------------------
     * 通知をテスト環境へ移した時点で、本番の画面からゲートを呼ぶ経路は
     * 無くなった。`connect-src` の許可は攻撃面を増やすものではないが、
     * **必要が無い許可を残すと「なぜ在るのか」が読めなくなる。**
     *
     * 戻すときは足し直す（docs/notifier-v2-resume.md §4）。
     * そのときも `*.workers.dev` にはしない——workers.dev は誰でも使える
     * 共有ドメインで、他人の Worker まで許可することになる。
     * ------------------------------------------------------------------
     */
    const html = readProdApp('index.html');
    const csp = html.match(/Content-Security-Policy" content="([^"]+)"/)[1];
    const connectSrc = csp.split(';').map((part) => part.trim()).find((part) => part.startsWith('connect-src'));

    check('★connect-src から通知ゲートを外した',
      connectSrc.includes(NOTIFIER_GATE_ORIGIN) === false, connectSrc);
    check('★ワイルドカードで代用していない', csp.includes('workers.dev') === false, csp);
    check('既存の接続先は落としていない',
      connectSrc.includes('https://www.googleapis.com')
      && connectSrc.includes('https://script.google.com')
      && connectSrc.includes('https://script.googleusercontent.com'));
    check('★残ったのは3オリジンだけ',
      connectSrc.split(/\s+/).filter((value) => value.startsWith('https://')).length === 3,
      connectSrc);

    /*
     * 戻すときに足す先が分かるよう、手順書にオリジンが書いてあること。
     * **ここが消えると、戻す人はどのURLを足すのか分からなくなる。**
     */
    const resume = readFileSync(join(REPO_ROOT, 'docs/notifier-v2-resume.md'), 'utf8');

    check('★復帰手順書に再追加が書いてある', resume.includes('CSP'), 'notifier-v2-resume.md');
  }

  /* ================================================================ */
  section('★本番からは取り除かれていること（移設の裏側）');

  {
    /*
     * ==================================================================
     * 「移した」は「本番から消えた」と対で確かめる
     * ==================================================================
     * 移設は**2つの操作**でできている。片方だけ通ると、同じ実装が
     * 2か所に残る（`/apps/` と `/production-app/` は同一オリジンなので、
     * Service Worker のスコープと IndexedDB の名前が衝突しうる）。
     *
     * 上の節が「テスト環境に在ること」を見ているので、ここは
     * **「本番に無いこと」**だけを見る。
     * ==================================================================
     */
    const gone = ['notifier-client.js', 'notifier-config.js', 'notifier-messages.js',
      'notifier-panel.js', 'sw.js', 'manifest.webmanifest'];

    for (const name of gone) {
      check(`★本番に ${name} が無い`, existsSync(join(PROD_DIR, name)) === false);
      check(`テスト環境に ${name} がある`, existsSync(join(APP_DIR, name)) === true);
    }

    const prodHtml = readProdApp('index.html');
    const prodApp = readProdApp('app.js');

    check('★本番の HTML に通知パネルが無い', prodHtml.includes('vr-notifier-panel') === false);
    check('★本番の HTML に通知の部品（vr-nf-）が1つも無い',
      /vr-nf-/.test(prodHtml) === false);
    check('★本番の HTML に通知バナーが無い', prodHtml.includes('vr-event-banner') === false);
    check('★本番の HTML が manifest を読み込まない', prodHtml.includes('rel="manifest"') === false);
    /* 由来を説明するコメントには出てくるので、**import の形**で見る。 */
    check('★本番の app.js が notifier-panel.js を import しない',
      /from '\.\/notifier-[a-z]+\.js'/.test(prodApp) === false);
    check('★本番の app.js が mountNotifier を呼ばない',
      prodApp.includes('mountNotifier') === false);
    check('★本番の app.js が Service Worker を登録しない',
      prodApp.includes('serviceWorker.register') === false);
  }

  /* ================================================================ */
  section('★本番の既存機能が無傷であること（移設の巻き添えを見張る）');

  {
    /*
     * ------------------------------------------------------------------
     * 消しすぎていないか
     * ------------------------------------------------------------------
     * 通知を外す作業で、録音・Drive保存・ログインまで削ってしまうのが
     * いちばん怖い壊れ方である。**通知と同じファイルに同居している**
     * ため、範囲を1行間違えると起きる。
     *
     * ここは「残っていること」を見る。上の節と対で意味を持つ。
     * ------------------------------------------------------------------
     */
    const prodHtml = readProdApp('index.html');
    const prodApp = readProdApp('app.js');
    const prodCss = readProdApp('style.css');

    for (const id of ['vr-record-panel', 'vr-save-panel', 'vr-progress-panel', 'vr-result-panel',
      'vr-start', 'vr-stop', 'vr-save', 'vr-state-auth', 'vr-state-oauth',
      'vr-state-folder', 'vr-state-device', 'vr-main']) {
      check(`本番の HTML に ${id} が残っている`, prodHtml.includes(id));
    }

    check('録音の実装を読み込んでいる', prodApp.includes("from './recorder/recorder.js'"));
    check('Drive 保存を読み込んでいる', prodApp.includes("from './drive.js'"));
    check('ログインの門を通している', prodApp.includes('guardPage('));
    check('★戻り先は録音アプリのまま', prodApp.includes("next: 'voiceRecorder'"));

    /*
     * `?eventId=` の引き継ぎは**本番に残してある**（認証系の元画面復帰に
     * つながっており、通知とは独立に効いているため）。除去の可否は未承認。
     */
    check('★eventId の引き継ぎが残っている',
      prodApp.includes('params: { eventId: currentEventIdFromUrl() }'));
    check('★eventId の読み取りが本番の中で完結している',
      prodApp.includes('function currentEventIdFromUrl()'));

    check('録音のスタイルが残っている', prodCss.includes('.vr-panel'));
    check('★通知専用のスタイルは残していない', /#vr-nf-/.test(prodCss) === false);
  }

  finish();
} catch (error) {
  fatal(error);
}

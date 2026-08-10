/*
 * 録音アプリ側のカレンダー通知（public/production-app/voice-recorder/）。
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

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { check, section, finish, fatal } from '../../public/apps/tests/helpers/assert.mjs';
import { REPO_ROOT } from '../helpers/gas-notifier-harness.mjs';
import { NOTIFIER_GATE_ORIGIN } from '../../workers/notifier-gate/origin.mjs';

const APP_DIR = join(REPO_ROOT, 'public/production-app/voice-recorder');

function readApp(name) {
  return readFileSync(join(APP_DIR, name), 'utf8');
}

/*
 * notifier-panel.js は location を読む。読み込み前に偽物を置く
 * （置かなくても import は通るが、値を変えて確かめられない）。
 */
let currentSearch = '';

globalThis.location = {
  get href() { return `https://tsam-ai.example/production-app/voice-recorder/${currentSearch}`; },
  get search() { return currentSearch; },
  get origin() { return 'https://tsam-ai.example'; },
};

try {
  const messages = await import('../../public/production-app/voice-recorder/notifier-messages.js');
  const panel = await import('../../public/production-app/voice-recorder/notifier-panel.js');

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
    const scope = 'https://tsam-ai.com/production-app/voice-recorder/';

    check('eventId をクエリで渡す', messages.buildEventUrl(scope, 'abc') === `${scope}?eventId=abc`);
    check('★eventId をURLエンコードする',
      messages.buildEventUrl(scope, 'a b&c') === `${scope}?eventId=a%20b%26c`);
    check('eventId が無ければスコープだけを開く', messages.buildEventUrl(scope, '') === scope);

    check('スコープ配下の窓は自分の窓', messages.isAppClientUrl(`${scope}?eventId=x`, scope) === true);
    check('★別アプリの窓は自分の窓ではない',
      messages.isAppClientUrl('https://tsam-ai.com/production-app/card-ocr/', scope) === false);
    check('★テスト環境の同名アプリも自分の窓ではない',
      messages.isAppClientUrl('https://tsam-ai.com/apps/voice-recorder/', scope) === false);
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

    const app = readApp('app.js');

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
    check('★sw.js に /production-app/ の直書きが無い', !sw.includes('/production-app/'));
    check('★notifier-panel.js に /production-app/ の直書きが無い', !panel.includes('/production-app/'));
    check('sw.js は registration.scope から開く先を作る', sw.includes('self.registration.scope'));

    check('manifest の start_url は本番アプリのパス',
      manifest.start_url === '/production-app/voice-recorder/');
    check('manifest の scope も同じ', manifest.scope === '/production-app/voice-recorder/');
    check('manifest を index.html から読み込む', html.includes('rel="manifest"'));

    /*
     * ★CSP は変更しない。connect-src に script.google.com が既にあり、
     * 通知用GASもその範囲で動く。ここが変わっていたら、変更の理由を確かめること。
     */
    check('★CSP の connect-src に script.google.com がある',
      html.includes('connect-src \'self\' https://www.googleapis.com https://script.google.com https://script.googleusercontent.com'));
    check('★CSP に第三者ホストを足していない', !html.includes('https://cdn.'));
    check('★worker-src は self のまま', html.includes("worker-src 'self'"));

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
    const config = await import('../../public/production-app/voice-recorder/notifier-config.js');

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
  }

  /* ================================================================ */
  section('★CSP（承認済みの変更案どおり）');

  {
    const html = readApp('index.html');
    const csp = html.match(/Content-Security-Policy" content="([^"]+)"/)[1];
    const connectSrc = csp.split(';').map((part) => part.trim()).find((part) => part.startsWith('connect-src'));

    check('connect-src に通知ゲートを足した', connectSrc.includes(NOTIFIER_GATE_ORIGIN), connectSrc);
    check('★ワイルドカードにしない（他人の Worker を許可しない）',
      csp.includes('*.workers.dev') === false);
    check('★script-src には足していない',
      csp.split(';').map((part) => part.trim()).find((part) => part.startsWith('script-src'))
        .includes('workers.dev') === false);
    check('既存の接続先を落としていない',
      connectSrc.includes('https://www.googleapis.com')
      && connectSrc.includes('https://script.google.com')
      && connectSrc.includes('https://script.googleusercontent.com'));
    check('足したのは1オリジンだけ',
      connectSrc.split(/\s+/).filter((value) => value.startsWith('https://')).length === 4,
      connectSrc);
  }

  finish();
} catch (error) {
  fatal(error);
}

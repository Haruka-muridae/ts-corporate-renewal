/*
 * 配布用GAS テンプレート v2（gas-notifier/）。
 *
 * ==================================================================
 * V1 から変わったこと
 * ==================================================================
 * 判定と VAPID 署名は運営の Workers（notifier-gate）へ移した。
 * したがってここで確かめるのは「判定が正しいか」ではなく、
 * **テンプレートが配管として正しく振る舞うか**である。
 *
 *   1. 匿名化 — ゲートへ予定名・参加者・カレンダーIDを送らないこと
 *   2. ゲートの応答をキューへ反映すること（通信失敗でキューを壊さないこと）
 *   3. 送信 — ゲートの JWT が無ければ1通も送らないこと
 *   4. pending が購読（端末）単位であること（宿題 B-04）
 *   5. 新 action（syncNow / upcoming / sendTestNotification / regenerateConnectKey）
 *   6. ワンボタン公開が冪等で、トークンをクライアントへ渡さないこと
 *   7. セットアップに「エディタを開く工程」が存在しないこと
 * ==================================================================
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { check, section, finish, fatal } from '../../public/apps/tests/helpers/assert.mjs';
import {
  GATE_ORIGIN,
  REPO_ROOT,
  createNotifierEnvironment,
  createReadyNotifierEnvironment,
  installGateStub,
} from '../helpers/gas-notifier-harness.mjs';
import {
  FIXTURE_AUDIENCES,
  FIXTURE_LICENSE_KEY,
  captureGateResponses,
  installCapturedGateStub,
} from '../helpers/gate-fixtures.mjs';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const GAS_DIR = join(REPO_ROOT, 'gas-notifier');

function readGas(name) {
  return readFileSync(join(GAS_DIR, name), 'utf8');
}

/* 出欠つきの予定を1件作る。テストごとに書き換えたい部分だけ渡す。 */
function makeEvent({
  id = 'event-1',
  summary = '定例MTG',
  status = 'confirmed',
  responseStatus = 'accepted',
  startMs = null,
  allDay = null,
  attendees,
  organizer,
} = {}) {
  const event = { id, summary, status };

  if (allDay) {
    event.start = { date: allDay };
  } else {
    event.start = { dateTime: new Date(startMs ?? Date.UTC(2026, 7, 10, 1, 0, 0)).toISOString() };
  }

  if (attendees !== undefined) {
    event.attendees = attendees;
  } else if (responseStatus !== null) {
    event.attendees = [
      { email: 'other@example.com', responseStatus: 'accepted' },
      { email: 'owner@example.com', self: true, responseStatus },
    ];
  }

  if (organizer !== undefined) {
    event.organizer = organizer;
  }

  return event;
}

function subscription(suffix) {
  return {
    endpoint: `https://fcm.googleapis.com/fcm/send/${suffix}`,
    keys: { p256dh: `p256dh-${suffix}`, auth: `auth-${suffix}` },
  };
}

try {
  /* ================================================================ */
  section('★匿名化 — ゲートへ渡してよいものだけを渡す');

  {
    const env = createReadyNotifierEnvironment();
    const gas = env.api;
    const calls = installGateStub(env);

    env.setCalendarItems([
      makeEvent({ id: 'ev-a', summary: '株式会社ABC 取締役会' }),
      makeEvent({ id: 'ev-b', summary: '社外秘の打合せ', responseStatus: 'declined' }),
    ]);

    gas.syncCalendar_(env.getTime());

    const evaluate = calls.find((call) => call.path === '/v1/evaluate');
    const payload = JSON.stringify(evaluate.body);

    check('evaluate を呼ぶ', evaluate !== undefined);
    check('★予定名を送らない', payload.includes('取締役会') === false, payload);
    check('★別の予定名も送らない', payload.includes('社外秘') === false);
    check('★メールアドレスを送らない', payload.includes('example.com') === false);
    check('★カレンダーIDを送らない', payload.includes('primary') === false);
    check('★予定IDそのものを送らない', payload.includes('ev-a') === false, payload);

    const allowed = ['eid', 'feature', 'startAt', 'status', 'allDay', 'cancelled', 'timingMin'];

    check(
      '★骨格の項目が許可された名前だけ',
      evaluate.body.events.every((event) => Object.keys(event).every((key) => allowed.includes(key))),
      JSON.stringify(evaluate.body.events[0]),
    );
    check('出欠は解決済みで渡す', evaluate.body.events[1].status === 'declined');
    check('終日かどうかを渡す', evaluate.body.events[0].allDay === false);
    check('設定は timingMin という名前で渡す', evaluate.body.settings.timingMin === 5);

    check(
      'eid は base64url',
      evaluate.body.events.every((event) => /^[A-Za-z0-9_-]+$/.test(event.eid)),
    );
    check('予定が違えば eid も違う', evaluate.body.events[0].eid !== evaluate.body.events[1].eid);

    /* 鍵が違えば同じ予定でも別の eid になる（運営側で突き合わせられない）。 */
    const other = createReadyNotifierEnvironment();
    const otherCalls = installGateStub(other);

    other.setCalendarItems([makeEvent({ id: 'ev-a' })]);
    other.api.syncCalendar_(other.getTime());

    check(
      '★利用者が違えば同じ予定でも eid が変わる',
      otherCalls[0].body.events[0].eid !== evaluate.body.events[0].eid,
    );

    check('★HMAC の鍵はシートに書かれない',
      JSON.stringify(env.readSheet('settings')).includes(env.properties.EID_HMAC_KEY) === false);
  }

  /* ================================================================ */
  section('送信済み一覧（sentDigest）');

  {
    const env = createReadyNotifierEnvironment();
    const gas = env.api;
    const calls = installGateStub(env);

    gas.tableAppend_('sent_log', {
      key: 'k1', eid: 'EID-1', eventId: 'ev-a', feature: 'calendar', timing: 5,
      title: '重役会議', startTime: env.getTime() + HOUR, sentAt: env.getTime() - MINUTE,
      purpose: 'calendar', fetchedBy: '',
    });

    env.setCalendarItems([makeEvent({ id: 'ev-a' })]);
    gas.syncCalendar_(env.getTime());

    const digest = calls.find((call) => call.path === '/v1/evaluate').body.sentDigest;

    check('送信済みをゲートへ渡す（再通知の判定に要る）', digest.length === 1);
    check('★送信済みにも予定名を含めない',
      JSON.stringify(digest).includes('重役会議') === false, JSON.stringify(digest));
    check('渡すのは eid / feature / timing / 開始時刻',
      Object.keys(digest[0]).sort().join(',') === 'eid,feature,startAt,timing');

    /* 古すぎる記録は渡さない（送る量を無闇に増やさない）。 */
    env.advance(8 * DAY);
    env.clearFetchHandlers();

    const later = installGateStub(env);
    gas.syncCalendar_(env.getTime());

    check('保持期間より古い送信済みは渡さない',
      later.find((call) => call.path === '/v1/evaluate').body.sentDigest.length === 0);
  }

  /* ================================================================ */
  section('ゲートの応答をキューへ反映する');

  {
    const env = createReadyNotifierEnvironment();
    const gas = env.api;
    const start = env.getTime() + HOUR;

    installGateStub(env);
    env.setCalendarItems([makeEvent({ id: 'ev-a', startMs: start })]);

    gas.syncCalendar_(env.getTime());

    const queue = env.readSheet('notify_queue');

    check('キューに1件入る', queue.length === 1, JSON.stringify(queue));
    check('予定名はシート側に残る（外へ出ないだけ）', queue[0].title === '定例MTG');
    check('通知予定時刻はゲートの答えを使う', Number(queue[0].notifyAt) === start - 5 * MINUTE);
    check('元の予定IDもシートに持つ（通知から開くときに要る）', queue[0].eventId === 'ev-a');
    check('eid も持つ（ゲートとの突き合わせに使う）', String(queue[0].eid).length > 10);

    /* remove で返ってきたものはキューから消える。 */
    env.clearFetchHandlers();
    installGateStub(env, {
      evaluate: (body) => ({ notify: [], remove: body.events.map((event) => event.eid) }),
    });

    gas.syncCalendar_(env.getTime());

    check('remove の eid はキューから消える', env.readSheet('notify_queue').length === 0);
  }

  {
    /* 通信に失敗したときにキューを壊さないこと。 */
    const env = createReadyNotifierEnvironment();
    const gas = env.api;

    installGateStub(env);
    env.setCalendarItems([makeEvent({ id: 'ev-a', startMs: env.getTime() + HOUR })]);
    gas.syncCalendar_(env.getTime());

    check('前提: キューに1件ある', env.readSheet('notify_queue').length === 1);

    env.clearFetchHandlers();
    installGateStub(env, { evaluateStatus: 429 });

    const summary = gas.syncCalendar_(env.getTime());

    check('★判定を受け取れなければキューに触らない', env.readSheet('notify_queue').length === 1);
    check('失敗を呼び出し側へ伝える', summary.error !== '');
  }

  {
    /* ライセンスキーが無ければゲートを呼ばない。 */
    const env = createReadyNotifierEnvironment({ licenseKey: '' });
    const gas = env.api;
    const calls = installGateStub(env);

    env.setCalendarItems([makeEvent()]);

    const summary = gas.syncCalendar_(env.getTime());

    check('ライセンスが無ければゲートを呼ばない', calls.length === 0);
    check('理由が分かる', summary.error === 'NO_LICENSE', summary.error);
  }

  /* ================================================================ */
  section('送信（ゲートの署名が要る）');

  {
    const env = createReadyNotifierEnvironment();
    const gas = env.api;

    installGateStub(env);

    gas.upsertSubscription_(subscription('one'), env.getTime());
    gas.tableAppend_('notify_queue', {
      key: 'k1', eid: 'EID-1', eventId: 'ev-a', feature: 'calendar', timing: 5,
      title: '定例MTG', startTime: env.getTime() + 5 * MINUTE, notifyAt: env.getTime() - MINUTE,
      updatedAt: env.getTime(),
    });

    env.clearFetchCalls();

    const result = gas.sendDueNotifications_(env.getTime());

    check('1件送る', result.delivered === 1, JSON.stringify(result));

    const push = env.fetchCalls.find((call) => String(call.url).includes('fcm.googleapis.com/fcm/send'));

    check('Push を送る', push !== undefined);
    check('ゲートが発行した JWT を使う',
      push.options.headers.Authorization.includes('fake.jwt.value'), push.options.headers.Authorization);
    check('aud ごとの JWT を選ぶ',
      push.options.headers.Authorization.includes('https://fcm.googleapis.com'));
    check('公開鍵も添える', push.options.headers.Authorization.includes('FAKE-VAPID-PUBLIC-KEY'));
    check('本文を送らない（tickle）', push.options.payload === undefined);
    check('TTL は5分', push.options.headers.TTL === '300');

    check('sent_log へ記録する', env.readSheet('sent_log').length === 1);
    check('★送った行はキューから消える', env.readSheet('notify_queue').length === 0);
  }

  {
    /* 期限切れなどで署名を得られないときは1通も送らない。 */
    const env = createReadyNotifierEnvironment();
    const gas = env.api;

    installGateStub(env, { vapidStatus: 402 });

    gas.upsertSubscription_(subscription('one'), env.getTime());
    gas.tableAppend_('notify_queue', {
      key: 'k1', eid: 'EID-1', eventId: 'ev-a', feature: 'calendar', timing: 5,
      title: '定例MTG', startTime: env.getTime() + 5 * MINUTE, notifyAt: env.getTime() - MINUTE,
      updatedAt: env.getTime(),
    });

    env.clearFetchCalls();

    const result = gas.sendDueNotifications_(env.getTime());

    check('★署名が無ければ1通も送らない', result.delivered === 0);
    check('Push を試みない',
      env.fetchCalls.some((call) => String(call.url).includes('fcm.googleapis.com/fcm/send')) === false);
    check('★送れなければ sent_log に書かない', env.readSheet('sent_log').length === 0);
    check('★キューも残る（次の tick で再試行できる）', env.readSheet('notify_queue').length === 1);
  }

  {
    /* JWT は期限まで使い回す（毎分ゲートを叩かない）。 */
    const env = createReadyNotifierEnvironment();
    const gas = env.api;
    const calls = installGateStub(env);

    gas.upsertSubscription_(subscription('one'), env.getTime());

    gas.sendTickle_(env.getTime());
    gas.sendTickle_(env.getTime() + MINUTE);

    check('vapid は1回しか呼ばない',
      calls.filter((call) => call.path === '/v1/vapid').length === 1,
      String(calls.filter((call) => call.path === '/v1/vapid').length));

    env.advance(13 * HOUR);
    gas.sendTickle_(env.getTime());

    check('期限が切れたら取り直す',
      calls.filter((call) => call.path === '/v1/vapid').length === 2);
  }

  /* ================================================================ */
  section('★pending は購読（端末）単位（宿題 B-04）');

  {
    const env = createReadyNotifierEnvironment();
    const gas = env.api;
    const key = env.properties.CONNECT_KEY;

    installGateStub(env);

    const first = gas.upsertSubscription_(subscription('pc1'), env.getTime());
    const second = gas.upsertSubscription_(subscription('pc2'), env.getTime());

    check('購読ごとに subId が付く', first.subId !== second.subId);

    gas.tableAppend_('sent_log', {
      key: 'k1', eid: 'EID-1', eventId: 'ev-a', feature: 'calendar', timing: 5,
      title: '定例MTG', startTime: env.getTime() + 5 * MINUTE, sentAt: env.getTime(),
      purpose: 'calendar', fetchedBy: '',
    });

    const one = env.readOutput(gas.doGet({
      parameter: { action: 'pending', key, endpoint: subscription('pc1').endpoint },
    }));

    check('1台目に本文が届く', one.data.notifications.length === 1, JSON.stringify(one));

    const oneAgain = env.readOutput(gas.doGet({
      parameter: { action: 'pending', key, endpoint: subscription('pc1').endpoint },
    }));

    check('同じ端末が2回取りには来られない（二重表示の防止）', oneAgain.data.notifications.length === 0);

    const two = env.readOutput(gas.doGet({
      parameter: { action: 'pending', key, endpoint: subscription('pc2').endpoint },
    }));

    check('★2台目にも本文が届く（V1 はここが空だった）', two.data.notifications.length === 1,
      JSON.stringify(two));
    check('取得済みは購読ごとに記録される',
      String(env.readSheet('sent_log')[0].fetchedBy).split(',').length === 2,
      String(env.readSheet('sent_log')[0].fetchedBy));

    const noEndpoint = env.readOutput(gas.doGet({ parameter: { action: 'pending', key } }));

    check('★endpoint を省略した要求は受け付けない', noEndpoint.error.code === 'INVALID_REQUEST');

    const unknown = env.readOutput(gas.doGet({
      parameter: { action: 'pending', key, endpoint: 'https://fcm.googleapis.com/fcm/send/nope' },
    }));

    check('未登録の endpoint も受け付けない', unknown.error.code === 'INVALID_REQUEST');

    /* 古い通知は拾わない（会議が終わってから出しても混乱するだけ）。 */
    env.advance(11 * MINUTE);

    const third = gas.upsertSubscription_(subscription('pc3'), env.getTime());

    check('前提: 3台目を登録した', third.created === true);

    const stale = env.readOutput(gas.doGet({
      parameter: { action: 'pending', key, endpoint: subscription('pc3').endpoint },
    }));

    check('10分より古い通知は渡さない', stale.data.notifications.length === 0);
  }

  /* ================================================================ */
  section('新しい action');

  {
    const env = createReadyNotifierEnvironment();
    const gas = env.api;
    const key = env.properties.CONNECT_KEY;

    installGateStub(env);
    env.setCalendarItems([makeEvent({ id: 'ev-a', startMs: env.getTime() + HOUR })]);

    const sync = env.readOutput(gas.doPost({
      postData: { contents: JSON.stringify({ action: 'syncNow', key }) },
    }));

    check('syncNow が同期する', sync.ok === true && sync.data.added === 1, JSON.stringify(sync));
    check('syncNow は件数を返す', sync.data.queued === 1);
    check('ライセンスの状態も返す', sync.data.licenseState === 'active');

    const upcoming = env.readOutput(gas.doGet({ parameter: { action: 'upcoming', key } }));

    check('upcoming が予定を返す', upcoming.data.upcoming.length === 1, JSON.stringify(upcoming));
    check('upcoming は予定名と時刻を返す（自分の画面に出すため）',
      upcoming.data.upcoming[0].title === '定例MTG' && upcoming.data.upcoming[0].notifyAt !== '');

    gas.upsertSubscription_(subscription('one'), env.getTime());

    const test = env.readOutput(gas.doPost({
      postData: { contents: JSON.stringify({ action: 'sendTestNotification', key }) },
    }));

    check('sendTestNotification が送る', test.ok === true && test.data.delivered === 1, JSON.stringify(test));
    check('テスト通知も sent_log を経由する（Service Worker に分岐が要らない）',
      env.readSheet('sent_log').some((row) => row.purpose === 'test'));

    const regenerated = env.readOutput(gas.doPost({
      postData: { contents: JSON.stringify({ action: 'regenerateConnectKey', key }) },
    }));

    check('regenerateConnectKey が新しいキーを返す', regenerated.data.key !== key);
    check('★古いキーは使えなくなる',
      env.readOutput(gas.doGet({ parameter: { action: 'upcoming', key } })).error.code === 'UNAUTHORIZED');
    check('新しいキーで使える',
      env.readOutput(gas.doGet({ parameter: { action: 'upcoming', key: regenerated.data.key } })).ok === true);
  }

  {
    /* テスト通知はゲートの許可が要る（1日1回の制限はゲート側）。 */
    const env = createReadyNotifierEnvironment();
    const gas = env.api;

    installGateStub(env, { testNotifyStatus: 429 });
    gas.upsertSubscription_(subscription('one'), env.getTime());

    const denied = env.readOutput(gas.doPost({
      postData: { contents: JSON.stringify({ action: 'sendTestNotification', key: env.properties.CONNECT_KEY }) },
    }));

    check('ゲートが断ればテスト通知を送らない', denied.ok === false, JSON.stringify(denied));
    check('通知そのものは記録しない', env.readSheet('sent_log').length === 0);
  }

  /* ================================================================ */
  section('ライセンスキーの受け取り（saveLicense）');

  {
    const env = createReadyNotifierEnvironment({ licenseKey: '' });
    const gas = env.api;
    const key = env.properties.CONNECT_KEY;

    installGateStub(env);

    const saved = env.readOutput(gas.doPost({
      postData: { contents: JSON.stringify({ action: 'saveLicense', key, licenseKey: 'LK'.padEnd(43, 'y') }) },
    }));

    check('保存できる', saved.ok === true, JSON.stringify(saved));
    check('保存と同時に公開鍵を取り寄せる', saved.data.publicKey === 'FAKE-VAPID-PUBLIC-KEY');
    check('Script Properties に入る', env.properties.LICENSE_KEY === 'LK'.padEnd(43, 'y'));

    const bad = env.readOutput(gas.doPost({
      postData: { contents: JSON.stringify({ action: 'saveLicense', key, licenseKey: 'short' }) },
    }));

    check('形の違うキーは受け付けない', bad.error.code === 'INVALID_REQUEST');

    const noKey = env.readOutput(gas.doPost({
      postData: { contents: JSON.stringify({ action: 'saveLicense', licenseKey: 'LK'.padEnd(43, 'z') }) },
    }));

    check('★接続キー無しでは保存できない', noKey.error.code === 'UNAUTHORIZED');

    /* 別のライセンスを入れたら、前のキーで受け取った署名は捨てる。 */
    env.properties.VAPID_JWTS_JSON = '{"https://fcm.googleapis.com":"old"}';

    gas.doPost({
      postData: { contents: JSON.stringify({ action: 'saveLicense', key, licenseKey: 'LK'.padEnd(43, 'w') }) },
    });

    check('★ライセンスが変わったら古い署名を捨てる',
      String(env.properties.VAPID_JWTS_JSON).includes('"old"') === false,
      env.properties.VAPID_JWTS_JSON);
  }

  /* ================================================================ */
  section('API の守り（接続キーと health）');

  {
    const env = createReadyNotifierEnvironment();
    const gas = env.api;
    const key = env.properties.CONNECT_KEY;

    installGateStub(env);

    const health = env.readOutput(gas.doGet({ parameter: { action: 'health' } }));

    check('health は接続キー無しで読める', health.ok === true);
    check('★health に接続キーを含めない', JSON.stringify(health).includes(key) === false);
    check('★health にライセンスキーを含めない',
      JSON.stringify(health).includes(env.properties.LICENSE_KEY) === false);
    check('health に予定の情報を含めない',
      Object.keys(health.data).sort().join(',')
        === 'configured,deployedVersion,execUrlDigest,lastGateError,lastTickAt,licensed,ok,triggerActive,version',
      Object.keys(health.data).sort().join(','));

    check('★接続キー無しでは設定を読めない',
      env.readOutput(gas.doGet({ parameter: { action: 'getSettings' } })).error.code === 'UNAUTHORIZED');
    check('★間違った接続キーも通さない',
      env.readOutput(gas.doGet({ parameter: { action: 'getSettings', key: 'wrong' } })).error.code === 'UNAUTHORIZED');
    check('正しい接続キーなら読める',
      env.readOutput(gas.doGet({ parameter: { action: 'getSettings', key } })).ok === true);

    check('★管理用の関数は action から呼べない',
      gas.ALLOWED_POST_ACTIONS.includes('deployWebApp') === false
      && gas.ALLOWED_GET_ACTIONS.includes('tick') === false);

    check('★設定の応答にライセンスキーそのものを入れない',
      JSON.stringify(env.readOutput(gas.doGet({ parameter: { action: 'getSettings', key } })))
        .includes(env.properties.LICENSE_KEY) === false);
  }

  /* ================================================================ */
  section('★ワンボタン公開（冪等・トークンを渡さない）');

  {
    const env = createNotifierEnvironment({ serviceUrl: '' });
    const gas = env.api;

    gas.setupNotifier();

    const url = 'https://script.google.com/macros/s/AKdeployed/exec';
    let deployments = { deployments: [] };
    const requests = [];

    env.onFetch((target, options) => {
      if (String(target).indexOf('https://script.googleapis.com/') !== 0) {
        return null;
      }

      requests.push({ url: String(target), method: options.method, options });

      if (options.method === 'get') {
        return { status: 200, body: deployments };
      }

      if (String(target).includes('/versions')) {
        return { status: 200, body: { versionNumber: 3 } };
      }

      return { status: 200, body: { entryPoints: [{ webApp: { url } }] } };
    });

    const first = gas.deployWebApp();

    check('公開できる', first.ok === true && first.url === url, JSON.stringify(first));
    check('新規作成として扱う', first.created === true);
    check('公開URLを覚える', env.properties.WEBAPP_URL === url);
    check('★アクセストークンをサーバー側でしか使わない',
      JSON.stringify(first).includes('FAKE-OAUTH-TOKEN') === false, JSON.stringify(first));
    check('Apps Script API に Bearer で渡している',
      requests[0].options.headers.Authorization === 'Bearer FAKE-OAUTH-TOKEN');

    /* 2回目。既存デプロイがあるので update 経路になる。 */
    deployments = {
      deployments: [
        /* @HEAD は versionNumber を持たない。**選んではいけない。** */
        { deploymentId: 'HEAD', deploymentConfig: {}, entryPoints: [{ webApp: { url } }] },
        { deploymentId: 'DEP-1', deploymentConfig: { versionNumber: 2 }, entryPoints: [{ webApp: { url } }] },
      ],
    };
    requests.length = 0;

    const second = gas.deployWebApp();

    check('2回目も成功する', second.ok === true);
    check('★2回目は update 経路（URLが変わらない）', second.created === false && second.url === url);
    check('★update の宛先は @HEAD ではない',
      requests.some((request) => request.method === 'put' && request.url.includes('/deployments/DEP-1')),
      requests.map((request) => `${request.method} ${request.url}`).join(' / '));
    check('新しいバージョンを作ってから update する',
      requests.findIndex((request) => request.url.includes('/versions'))
      < requests.findIndex((request) => request.method === 'put'));

    /*
     * ★部分失敗でバージョンが増えないこと。
     *
     * versions.create が通ったあとで deployments 側が失敗すると、
     * 使われないバージョンだけが残る。ウィザードは API の許可待ちで
     * 5秒ごとに呼ぶため、作り直していると失敗のあいだ増え続ける。
     */
    env.clearFetchHandlers();
    requests.length = 0;

    let createdVersions = 0;

    env.onFetch((target, options) => {
      if (String(target).indexOf('https://script.googleapis.com/') !== 0) {
        return null;
      }

      requests.push({ url: String(target), method: options.method, options });

      if (options.method === 'get') {
        return { status: 200, body: { deployments: [] } };
      }

      if (String(target).includes('/versions')) {
        createdVersions += 1;
        return { status: 200, body: { versionNumber: 10 + createdVersions } };
      }

      /* デプロイ側だけが落ちる。 */
      return { status: 500, body: { error: { message: 'boom' } } };
    });

    const failedOnce = gas.deployWebApp();

    check('デプロイ側の失敗は失敗として返す', failedOnce.ok === false, JSON.stringify(failedOnce));
    check('作ったバージョンを控える', env.properties.PENDING_VERSION === '11',
      env.properties.PENDING_VERSION);

    gas.deployWebApp();
    gas.deployWebApp();

    check('★再試行でバージョンを作り直さない（増殖しない）', createdVersions === 1,
      String(createdVersions));
    check('★控えたバージョンを使い回す',
      requests.filter((request) => request.method === 'put' || (request.method === 'post' && !request.url.includes('/versions')))
        .every((request) => JSON.parse(request.options.payload).versionNumber === 11
          || JSON.parse(request.options.payload).deploymentConfig?.versionNumber === 11),
      requests.map((request) => request.options.payload).join(' | '));

    /* 復帰したら控えを使い切って消す。 */
    env.clearFetchHandlers();
    env.onFetch((target, options) => {
      if (String(target).indexOf('https://script.googleapis.com/') !== 0) {
        return null;
      }

      if (options.method === 'get') {
        return { status: 200, body: { deployments: [] } };
      }

      if (String(target).includes('/versions')) {
        createdVersions += 1;
        return { status: 200, body: { versionNumber: 99 } };
      }

      return { status: 200, body: { entryPoints: [{ webApp: { url } }] } };
    });

    const recovered = gas.deployWebApp();

    check('復帰したら公開できる', recovered.ok === true, JSON.stringify(recovered));
    check('★復帰時もバージョンを作り直さない', createdVersions === 1, String(createdVersions));
    check('使い切った控えは消す', env.properties.PENDING_VERSION === '');
    check('公開したバージョンを記録する', env.properties.DEPLOYED_VERSION === '11');

    /* API が未許可のとき。 */
    env.clearFetchHandlers();
    env.onFetch((target) => {
      if (String(target).indexOf('https://script.googleapis.com/') !== 0) {
        return null;
      }

      return { status: 403, body: { error: { message: 'API not enabled' } } };
    });

    const denied = gas.deployWebApp();

    check('★403 は API 未許可として返す', denied.ok === false && denied.status === 'API_DISABLED',
      JSON.stringify(denied));
    check('例外にしない（ウィザードが次の手を案内できる）', typeof denied.message === 'string');
  }

  /* ================================================================ */
  section('★403 の見分け（直す場所が2か所ある）');

  {
    /*
     * 実機で「利用者設定は有効なのに 403 が続く」状態に嵌まった（2026-08-11）。
     * 403 の本文を捨てていたため、直す場所が
     *   利用者設定（script.google.com/home/usersettings）なのか
     *   GCP プロジェクト（Apps Script API が未有効）なのか
     * を区別できなかった。**区別してから案内する。**
     */
    function deployWith(status, body) {
      const env = createNotifierEnvironment({ serviceUrl: '' });

      env.api.setupNotifier();
      env.onFetch((target) => {
        if (String(target).indexOf('https://script.googleapis.com/') !== 0) {
          return null;
        }

        return { status, body };
      });

      return { env, result: env.api.deployWebApp() };
    }

    /* 1) 利用者設定が OFF のときの文面。 */
    const userOff = deployWith(403, {
      error: {
        code: 403,
        status: 'PERMISSION_DENIED',
        message: 'User has not enabled the Apps Script API. Enable it by visiting '
          + 'https://script.google.com/home/usersettings then retry.',
      },
    });

    check('利用者設定の 403 は API_DISABLED', userOff.result.status === 'API_DISABLED',
      JSON.stringify(userOff.result));
    check('案内URLを取り出す',
      userOff.result.helpUrl === 'https://script.google.com/home/usersettings',
      userOff.result.helpUrl);

    /* 2) GCP プロジェクトで未有効のときの文面（SERVICE_DISABLED）。 */
    const gcpOff = deployWith(403, {
      error: {
        code: 403,
        status: 'PERMISSION_DENIED',
        message: 'Apps Script API has not been used in project 123456789012 before or it is '
          + 'disabled. Enable it by visiting https://console.developers.google.com/apis/api/'
          + 'script.googleapis.com/overview?project=123456789012 then retry.',
        details: [{ reason: 'SERVICE_DISABLED' }],
      },
    });

    check('★GCP 側の 403 は別種として返す', gcpOff.result.status === 'API_DISABLED_GCP',
      JSON.stringify(gcpOff.result));
    check('★有効化URLをそのままボタンにできる',
      gcpOff.result.helpUrl.indexOf('https://console.developers.google.com/apis/api/') === 0,
      gcpOff.result.helpUrl);
    check('プロジェクト番号が案内URLに残る', gcpOff.result.helpUrl.includes('123456789012'));

    /* 3) reason だけで判定できること（文面が変わっても効くように）。 */
    const byReason = deployWith(403, {
      error: { code: 403, message: '（文面が変わった場合）', details: [{ reason: 'SERVICE_DISABLED' }] },
    });

    check('★文面が変わっても reason で見分ける', byReason.result.status === 'API_DISABLED_GCP');

    /* 4) 403 以外は従来どおり。 */
    const other = deployWith(500, { error: { code: 500, message: 'boom' } });

    check('403 以外は API_ERROR', other.result.status === 'API_ERROR', JSON.stringify(other.result));

    /*
     * 5) ログは種別ごとの1行だけにする（宿題 B-07・済）。
     *
     * 原因の切り分けのあいだは生の応答を4000文字まで出していた。原因が
     * 確定した（GCP プロジェクトで API 未有効）ので恒久化しない。
     * **出す内容を自分で決めていない**のがよくない——Google 側の文面が
     * 変われば何が出るか分からず、将来そこへ個人情報が乗る保証も無い。
     */
    check('★生の応答をログへ流し込まない',
      gcpOff.env.logs.some((line) => line.includes('一時デバッグ')) === false,
      gcpOff.env.logs.join(' | ').slice(0, 200));
    check('★種別が分かる1行は残す',
      gcpOff.env.logs.some((line) => line.includes('API_DISABLED_GCP')),
      gcpOff.env.logs.join(' | ').slice(0, 200));
    check('★ログにアクセストークンを出さない',
      gcpOff.env.logs.some((line) => line.includes('FAKE-OAUTH-TOKEN')) === false);
  }

  /* ================================================================ */
  section('★公開URLの扱い（実機で踏んだ壊れ方）');

  {
    const env = createNotifierEnvironment({ serviceUrl: 'https://script.google.com/a/macros/potenitas.com/s/AKghost/exec' });
    const gas = env.api;

    gas.setupNotifier();

    /*
     * 実機の症状: 一度も公開していないのに deployed が true になり、
     * ウィザードが公開を飛ばして引き継ぎの画面へ直行した。
     * getService().getUrl() が値を返していたため。
     */
    check('★未公開なら公開URLは空（getUrl を見ない）', gas.webAppUrl_() === '', gas.webAppUrl_());
    check('★未公開なら deployed は false', gas.getSetupStatus().deployed === false);
    check('★未公開なら引き継ぎリンクを出さない', gas.getHandoffLink().ok === false);

    env.properties.WEBAPP_URL = 'https://script.google.com/macros/s/AKreal/exec';

    check('保存されていれば公開URLになる', gas.webAppUrl_() === 'https://script.google.com/macros/s/AKreal/exec');
    check('保存されていれば deployed は true', gas.getSetupStatus().deployed === true);
  }

  {
    const env = createNotifierEnvironment();
    const gas = env.api;

    /* Workspace のアカウントで返る形。匿名アクセスで使えないことがある。 */
    check('★/a/<ドメイン>/ 形式を素の形へ正規化する',
      gas.normalizeExecUrl_('https://script.google.com/a/macros/potenitas.com/s/AKfycbxeN/exec')
        === 'https://script.google.com/macros/s/AKfycbxeN/exec');
    check('素の形はそのまま',
      gas.normalizeExecUrl_('https://script.google.com/macros/s/AKfycbxeN/exec')
        === 'https://script.google.com/macros/s/AKfycbxeN/exec');
    check('読めない形は空', gas.normalizeExecUrl_('https://example.com/exec') === '');
    check('空も空', gas.normalizeExecUrl_('') === '');
  }

  {
    /* 公開時に正規化した形で保存されること。 */
    const env = createNotifierEnvironment({ serviceUrl: '' });
    const gas = env.api;

    gas.setupNotifier();

    env.onFetch((target, options) => {
      if (String(target).indexOf('https://script.googleapis.com/') !== 0) {
        return null;
      }

      if (options.method === 'get') {
        return { status: 200, body: { deployments: [] } };
      }

      if (String(target).includes('/versions')) {
        return { status: 200, body: { versionNumber: 7 } };
      }

      return {
        status: 200,
        body: {
          entryPoints: [
            { webApp: { url: 'https://script.google.com/a/macros/potenitas.com/s/AKdeployed/exec' } },
          ],
        },
      };
    });

    const result = gas.deployWebApp();

    check('★公開URLは正規化して保存する',
      result.url === 'https://script.google.com/macros/s/AKdeployed/exec', result.url);
    check('保存先も正規化済み',
      env.properties.WEBAPP_URL === 'https://script.google.com/macros/s/AKdeployed/exec');
  }

  /* ================================================================ */
  section('★ゲートの実応答を、そのまま読めること（二重定義の見張り）');

  {
    /*
     * ------------------------------------------------------------------
     * 本物の Worker が返した JSON を、そのまま GAS へ流す
     * ------------------------------------------------------------------
     * 応答の形は Workers 側（ok()）と Gate.gs 側（取り出し）の2か所にあり、
     * 片方だけ変えても両方のテストが通ってしまう。
     * Phase 2 に同じ事故が起きている（gas-auth は success、Workers は ok）。
     *
     * ここでは整形せずに流す。形が食い違えば、この節が落ちる。
     * ------------------------------------------------------------------
     */
    const fixtures = await captureGateResponses();

    /* --- まず、応答の形そのものを固定する --- */
    check('vapid は 200', fixtures.vapid.status === 200, String(fixtures.vapid.status));
    check('★vapid の項目は ok / publicKey / jwts / expiresAt / licenseState',
      Object.keys(fixtures.vapid.body).sort().join(',') === 'expiresAt,jwts,licenseState,ok,publicKey',
      Object.keys(fixtures.vapid.body).sort().join(','));
    check('★evaluate の項目は ok / notify / remove / licenseState',
      Object.keys(fixtures.evaluate.body).sort().join(',') === 'licenseState,notify,ok,remove',
      Object.keys(fixtures.evaluate.body).sort().join(','));
    check('★入れ子（data）にしていない',
      fixtures.vapid.body.data === undefined && fixtures.evaluate.body.data === undefined);
    check('★成功の印は ok（success ではない）',
      fixtures.vapid.body.ok === true && fixtures.vapid.body.success === undefined);

    /* --- その応答を GAS に読ませる --- */
    const env = createReadyNotifierEnvironment({ licenseKey: FIXTURE_LICENSE_KEY });
    const gas = env.api;

    installCapturedGateStub(env, fixtures);

    const vapid = gas.gateVapid_(FIXTURE_AUDIENCES, env.getTime());

    check('★Gate.gs が本物の応答から公開鍵を取り出せる',
      vapid.ok === true && vapid.publicKey === fixtures.vapid.body.publicKey,
      `${vapid.ok} / ${String(vapid.publicKey).slice(0, 12)}`);
    check('★JWT も宛先ごとに取り出せる',
      FIXTURE_AUDIENCES.every((audience) => typeof vapid.jwts[audience] === 'string'),
      Object.keys(vapid.jwts).join(','));
    check('公開鍵を保存する', env.properties.VAPID_PUBLIC_B64URL === fixtures.vapid.body.publicKey);
    check('★有効期限を数値として保存する（0 のままにしない）',
      Number(env.properties.VAPID_EXPIRES_AT) > env.getTime(),
      env.properties.VAPID_EXPIRES_AT);
    /* 記録が無い状態は「未設定」でも「空文字」でもよい（消すときに書き足さない）。 */
    check('失敗の記録を残さない', !env.properties.LAST_GATE_ERROR, String(env.properties.LAST_GATE_ERROR));

    /* --- evaluate 側も同じ応答で通す --- */
    const withEvent = await captureGateResponses({
      events: [{
        eid: 'EID-FIXTURE',
        feature: 'calendar',
        startAt: new Date(env.getTime() + HOUR).toISOString(),
        status: 'accepted',
        allDay: false,
        cancelled: false,
      }],
    });

    check('本物の evaluate が1件返す', withEvent.evaluate.body.notify.length === 1,
      JSON.stringify(withEvent.evaluate.body));

    const env2 = createReadyNotifierEnvironment({ licenseKey: FIXTURE_LICENSE_KEY });

    installCapturedGateStub(env2, withEvent);

    const evaluated = env2.api.gateEvaluate_({
      settings: { accepted: true, tentative: true, needsAction: true, declined: false, timedOnly: true, timingMin: 5 },
      events: [],
      sentDigest: [],
    });

    check('★Gate.gs が本物の応答から判定を取り出せる',
      evaluated.ok === true && evaluated.notify.length === 1, JSON.stringify(evaluated));
    check('★ライセンスの状態も取り出せる', evaluated.licenseState === 'active', evaluated.licenseState);

    /*
     * ほかの節が使う手書きの偽ゲート（installGateStub）が、本物と同じ形か。
     * **ここがずれると、他の全部が作り話の上で緑になる。**
     */
    const handMade = createReadyNotifierEnvironment();
    let stubbed = null;

    installGateStub(handMade);
    handMade.onFetch(() => null);
    handMade.api.gateVapid_(['https://fcm.googleapis.com'], handMade.getTime());
    stubbed = handMade.fetchCalls.length > 0 ? handMade.fetchCalls : null;

    check('手書きの偽ゲートも呼ばれている（前提）', stubbed !== null);
    check('★手書きの偽ゲートの公開鍵の置き場所が本物と同じ',
      handMade.properties.VAPID_PUBLIC_B64URL !== undefined
      && handMade.properties.VAPID_PUBLIC_B64URL !== '',
      String(handMade.properties.VAPID_PUBLIC_B64URL));
    check('★手書きの偽ゲートでも有効期限が入る（形が同じ証拠）',
      Number(handMade.properties.VAPID_EXPIRES_AT) > handMade.getTime(),
      handMade.properties.VAPID_EXPIRES_AT);
  }

  {
    /*
     * 200 でも中身が使えない場合。**形が食い違ったときの壊れ方**である。
     * 既定値を書いて成功として返すと「鍵が無い」結果だけが残り、原因が消える。
     */
    const env = createReadyNotifierEnvironment();
    const gas = env.api;

    installGateStub(env);
    env.clearFetchHandlers();

    env.onFetch((url) => {
      if (String(url).indexOf(GATE_ORIGIN) !== 0) {
        return null;
      }

      /* 入れ子にしてしまった場合（Phase 2 の事故と同じ形）。 */
      return { status: 200, body: { ok: true, data: { publicKey: 'X', jwts: {}, expiresAt: '' } } };
    });

    const result = gas.gateVapid_(['https://fcm.googleapis.com'], env.getTime());

    check('★取り出せなければ失敗として返す', result.ok === false, JSON.stringify(result));
    check('理由が分かる', result.error === 'BAD_PAYLOAD', result.error);
    check('★空の既定値を保存しない', env.properties.VAPID_PUBLIC_B64URL === undefined,
      String(env.properties.VAPID_PUBLIC_B64URL));
    check('★失敗を記録して画面から辿れるようにする',
      String(env.properties.LAST_GATE_ERROR).includes('BAD_PAYLOAD'),
      env.properties.LAST_GATE_ERROR);

    const health = env.readOutput(gas.doGet({ parameter: { action: 'health' } }));

    check('health から失敗の符号が読める',
      String(health.data.lastGateError).includes('BAD_PAYLOAD'), JSON.stringify(health.data));
    check('★health に応答本文を出さない', JSON.stringify(health).includes('"publicKey"') === false);
  }

  /* ================================================================ */
  section('★鍵が取れないときに、呼び出しを増やさないこと（枠の食い合い）');

  {
    /*
     * ==================================================================
     * 実機で起きた「抜け出せない」状態
     * ==================================================================
     * ゲートの /v1/vapid には1キーあたりの上限がある。ところが
     * **失敗するほど呼び出しが増える**作りになっていた。
     *
     *   1. saveLicense が鍵の先取りに失敗すると action ごと失敗を返す
     *   2. 録音アプリは「引き渡せなかった」と解釈し、ブラウザ側の
     *      ライセンスキーを消さない
     *   3. 画面を開くたび・［接続テスト］のたびに saveLicense をやり直す
     *      → /v1/vapid を1回消費
     *   4. その直後の publicKey でもう1回消費
     *
     * 正規の操作2回で1時間ぶんの上限（当時4回）を使い切り、以後すべて
     * RATE_LIMITED。**成功しないと呼び出しが減らないのに、呼べないから
     * 成功しない。** 上限を上げるだけでは同じ罠が残るので、
     * 「1操作あたり何回ゲートを呼ぶか」をここで固定する。
     * ==================================================================
     */
    const env = createReadyNotifierEnvironment({ licenseKey: '' });
    const gas = env.api;
    const key = env.properties.CONNECT_KEY;
    const licenseKey = 'LK'.padEnd(43, 'z');

    /* ゲートは上限に当たっている（窓の残りは30分と告げてくる）。 */
    const calls = installGateStub(env, {
      vapidStatus: 429,
      vapidError: 'RATE_LIMITED',
      vapidRetryAfterSec: 1800,
    });

    function vapidCalls() {
      return calls.filter((call) => call.path === '/v1/vapid').length;
    }

    /* --- 1回目の［接続する］。saveLicense → publicKey の順に来る。 --- */
    const saved = env.readOutput(gas.doPost({
      postData: { contents: JSON.stringify({ action: 'saveLicense', key: key, licenseKey: licenseKey }) },
    }));

    check('★鍵が取れなくても saveLicense は成功を返す', saved.ok === true, JSON.stringify(saved));
    check('★預かったことを伝える', saved.data.saved === true);
    check('★取れなかった理由を添える', saved.data.gateError === 'RATE_LIMITED', saved.data.gateError);
    check('ライセンスキーは保存されている', env.properties.LICENSE_KEY === licenseKey);
    check('前提: ここまでで1回だけ呼んでいる', vapidCalls() === 1, String(vapidCalls()));

    const afterSave = vapidCalls();

    const first = env.readOutput(gas.doGet({ parameter: { action: 'publicKey', key: key } }));

    check('鍵はまだ無い（前提）', first.ok === false, JSON.stringify(first));
    check('★直後の publicKey はゲートを呼び直さない', vapidCalls() === afterSave, String(vapidCalls()));

    /* --- 利用者は当然もう一度押す。ここで増えないことが本題。 --- */
    for (let i = 0; i < 5; i += 1) {
      gas.doPost({ postData: { contents: JSON.stringify({ action: 'saveLicense', key: key, licenseKey: licenseKey }) } });
      gas.doGet({ parameter: { action: 'publicKey', key: key } });
    }

    check('★何度押してもゲートの呼び出しは増えない', vapidCalls() === 1, String(vapidCalls()));
    check('待つべき時刻を覚えている',
      Number(env.properties.VAPID_RETRY_AT) === env.getTime() + 1800 * 1000,
      env.properties.VAPID_RETRY_AT);
    check('理由も覚えている', env.properties.VAPID_RETRY_CODE === 'RATE_LIMITED');

    /* --- tick も同じ枠を使う。ここからも増やさない。 --- */
    gas.tick();

    check('★tick も待っている間はゲートを呼ばない', vapidCalls() === 1, String(vapidCalls()));

    /* --- 告げられた時刻より前は、まだ呼ばない --- */
    env.advance(1799 * 1000);
    gas.doGet({ parameter: { action: 'publicKey', key: key } });

    check('★1秒前でも呼ばない', vapidCalls() === 1, String(vapidCalls()));

    /* --- 窓が明けたら、1回だけ試す --- */
    env.advance(2 * 1000);
    gas.doGet({ parameter: { action: 'publicKey', key: key } });

    check('★窓が明けたら試す', vapidCalls() === 2, String(vapidCalls()));
  }

  {
    /*
     * ゲートが秒数を返さない場合（古いゲートに繋いでいるとき）。
     * **当てずっぽうで再試行しない**ことは同じにする。
     */
    const env = createReadyNotifierEnvironment();
    const gas = env.api;

    const calls = installGateStub(env, { vapidStatus: 429, vapidError: 'RATE_LIMITED' });

    gas.gateVapid_(['https://fcm.googleapis.com'], env.getTime());
    gas.gateVapid_(['https://fcm.googleapis.com'], env.getTime());

    check('★秒数が無くても待つ', calls.length === 1, String(calls.length));
    check('待ちは10分（既定）',
      Number(env.properties.VAPID_RETRY_AT) === env.getTime() + 10 * 60 * 1000,
      env.properties.VAPID_RETRY_AT);

    env.advance(10 * 60 * 1000 + 1);
    gas.gateVapid_(['https://fcm.googleapis.com'], env.getTime());

    check('10分後には試す', calls.length === 2, String(calls.length));
  }

  {
    /*
     * 一時的な不調（500 / 通信断）は短く空ける。上限とは事情が違い、
     * 1分後には直っていることが多い。
     */
    const env = createReadyNotifierEnvironment();
    const gas = env.api;

    const calls = installGateStub(env, { vapidStatus: 500, vapidError: 'SERVER_ERROR' });

    gas.gateVapid_(['https://fcm.googleapis.com'], env.getTime());

    check('待ちは1分', Number(env.properties.VAPID_RETRY_AT) === env.getTime() + 60 * 1000,
      env.properties.VAPID_RETRY_AT);

    env.advance(30 * 1000);
    gas.gateVapid_(['https://fcm.googleapis.com'], env.getTime());
    check('30秒後はまだ呼ばない', calls.length === 1, String(calls.length));

    env.advance(31 * 1000);
    gas.gateVapid_(['https://fcm.googleapis.com'], env.getTime());
    check('1分後には呼ぶ', calls.length === 2, String(calls.length));
  }

  {
    /*
     * ライセンスが未設定のときは待たせない。
     * **ゲートを呼んでもいない**（gateFetch_ が手前で返す）ので待つ理由が無く、
     * 待たせると録音アプリからキーが届いた直後に取りに行けなくなる。
     */
    const env = createReadyNotifierEnvironment({ licenseKey: '' });
    const gas = env.api;
    const calls = installGateStub(env);

    const result = gas.gateVapid_(['https://fcm.googleapis.com'], env.getTime());

    check('前提: ライセンス未設定で失敗する', result.ok === false && result.error === 'NO_LICENSE', result.error);
    check('ゲートは呼んでいない', calls.length === 0, String(calls.length));
    check('★待ち時間を作らない', (env.properties.VAPID_RETRY_AT || '0') === '0',
      String(env.properties.VAPID_RETRY_AT));

    /* キーが届いたら、その場で取りに行ける。 */
    env.properties.LICENSE_KEY = 'LK'.padEnd(43, 'y');
    gas.gateVapid_(['https://fcm.googleapis.com'], env.getTime());

    check('★キーが届いたら待たずに取りに行く', calls.length === 1, String(calls.length));
  }

  {
    /* 成功したら待ちは消える（次の取り直しが遅れない）。 */
    const env = createReadyNotifierEnvironment();
    const gas = env.api;

    env.properties.VAPID_RETRY_AT = String(env.getTime() - 1);
    env.properties.VAPID_RETRY_CODE = 'RATE_LIMITED';

    installGateStub(env);
    gas.gateVapid_(['https://fcm.googleapis.com'], env.getTime());

    check('★成功したら待ちを捨てる', env.properties.VAPID_RETRY_AT === '0', env.properties.VAPID_RETRY_AT);
    check('理由も捨てる', env.properties.VAPID_RETRY_CODE === '');
  }

  {
    /* 別のライセンスに入れ替えたら、前のキーで断られた事情は無関係になる。 */
    const env = createReadyNotifierEnvironment({ licenseKey: 'LK'.padEnd(43, 'a') });
    const gas = env.api;
    const key = env.properties.CONNECT_KEY;

    env.properties.VAPID_RETRY_AT = String(env.getTime() + 30 * 60 * 1000);
    env.properties.VAPID_RETRY_CODE = 'RATE_LIMITED';

    const calls = installGateStub(env);

    gas.doPost({
      postData: { contents: JSON.stringify({ action: 'saveLicense', key: key, licenseKey: 'LK'.padEnd(43, 'b') }) },
    });

    check('★ライセンスを入れ替えたら待たずに取りに行く', calls.length === 1, String(calls.length));
    check('待ちも捨てられている', env.properties.VAPID_RETRY_AT === '0', env.properties.VAPID_RETRY_AT);
  }

  /* ================================================================ */
  section('★失敗の記録は、その相手が直ったときだけ消えること');

  {
    /*
     * ------------------------------------------------------------------
     * evaluate の成功が vapid の失敗を消してしまっていた
     * ------------------------------------------------------------------
     * 実機では evaluate は1分ごとに成功し、vapid だけが失敗し続けた。
     * 記録は1つしか無く、成功のたびに空にしていたため、
     * **画面に出たり消えたりして原因が読めなかった**（2026-08-11）。
     * ------------------------------------------------------------------
     */
    const env = createReadyNotifierEnvironment();
    const gas = env.api;

    installGateStub(env, { vapidStatus: 429, vapidError: 'RATE_LIMITED' });

    gas.gateVapid_(['https://fcm.googleapis.com'], env.getTime());

    check('前提: vapid の失敗が記録されている',
      env.properties.LAST_GATE_ERROR === '/v1/vapid -> RATE_LIMITED', env.properties.LAST_GATE_ERROR);

    gas.gateEvaluate_({ settings: {}, events: [], sentDigest: [] });

    check('★evaluate が成功しても vapid の失敗は残る',
      env.properties.LAST_GATE_ERROR === '/v1/vapid -> RATE_LIMITED', env.properties.LAST_GATE_ERROR);

    const health = env.readOutput(gas.doGet({ parameter: { action: 'health' } }));

    check('health からも読める', health.data.lastGateError === '/v1/vapid -> RATE_LIMITED',
      JSON.stringify(health.data.lastGateError));

    /* 直ったら消える。 */
    env.clearFetchHandlers();
    installGateStub(env);
    env.advance(11 * 60 * 1000);
    gas.gateVapid_(['https://fcm.googleapis.com'], env.getTime());

    check('★vapid が直れば消える', env.properties.LAST_GATE_ERROR === '', env.properties.LAST_GATE_ERROR);
  }

  {
    /*
     * キャッシュで足りている間はゲートを呼ばない。**それでも記録は消す。**
     * 呼ばないことを理由に古い失敗が残り続けると、直っているのに
     * 画面には「失敗しています」と出たままになる。
     */
    const env = createReadyNotifierEnvironment();
    const gas = env.api;

    installGateStub(env);
    gas.gateVapid_(['https://fcm.googleapis.com'], env.getTime());

    /* 鍵は手元にある状態のまま、過去の失敗だけを残す。 */
    env.properties.LAST_GATE_ERROR = '/v1/vapid -> RATE_LIMITED';

    const cached = gas.gateVapid_(['https://fcm.googleapis.com'], env.getTime());

    check('前提: キャッシュで足りている', cached.ok === true && cached.publicKey !== '');
    check('★キャッシュで足りるなら失敗の記録は消す', env.properties.LAST_GATE_ERROR === '',
      env.properties.LAST_GATE_ERROR);
  }

  {
    /* 別の相手の失敗は、勝手に消さない。 */
    const env = createReadyNotifierEnvironment();
    const gas = env.api;

    installGateStub(env, { evaluateStatus: 429 });

    gas.gateEvaluate_({ settings: {}, events: [], sentDigest: [] });

    check('前提: evaluate の失敗が記録されている',
      env.properties.LAST_GATE_ERROR === '/v1/evaluate -> RATE_LIMITED', env.properties.LAST_GATE_ERROR);

    env.clearFetchHandlers();
    installGateStub(env);
    gas.gateVapid_(['https://fcm.googleapis.com'], env.getTime());

    check('★vapid が成功しても evaluate の失敗は消えない',
      env.properties.LAST_GATE_ERROR === '/v1/evaluate -> RATE_LIMITED', env.properties.LAST_GATE_ERROR);
  }

  /* ================================================================ */
  section('★どのデプロイに繋いでいるかを答える');

  {
    const env = createReadyNotifierEnvironment();
    const gas = env.api;
    const key = env.properties.CONNECT_KEY;

    installGateStub(env);
    env.properties.WEBAPP_URL = 'https://script.google.com/macros/s/AKreal/exec';
    env.properties.DEPLOYED_VERSION = '7';

    const health = env.readOutput(gas.doGet({ parameter: { action: 'health' } }));

    check('health が公開URLの指紋を返す', /^[0-9a-f]{12}$/.test(health.data.execUrlDigest),
      health.data.execUrlDigest);
    check('★health に公開URLそのものは入れない',
      JSON.stringify(health).includes('AKreal') === false, JSON.stringify(health));
    check('health が公開のバージョンを返す', health.data.deployedVersion === '7');

    const ping = env.readOutput(gas.doPost({
      postData: { contents: JSON.stringify({ action: 'ping', key }) },
    }));

    check('★POST の疎通確認ができる', ping.ok === true, JSON.stringify(ping));
    check('ping も同じ指紋を返す', ping.data.execUrlDigest === health.data.execUrlDigest);
    check('★接続キー無しでは ping できない',
      env.readOutput(gas.doPost({ postData: { contents: JSON.stringify({ action: 'ping' }) } }))
        .error.code === 'UNAUTHORIZED');

    /* URLが変われば指紋も変わる（＝古いデプロイを見分けられる）。 */
    env.properties.WEBAPP_URL = 'https://script.google.com/macros/s/AKother/exec';

    check('★URLが違えば指紋も違う',
      env.readOutput(gas.doGet({ parameter: { action: 'health' } })).data.execUrlDigest
        !== health.data.execUrlDigest);
  }

  {
    /* ライセンス未着と「セットアップ未完了」を混ぜないこと（鶏卵の可視化）。 */
    const env = createReadyNotifierEnvironment({ licenseKey: '' });
    const gas = env.api;

    installGateStub(env);

    const denied = env.readOutput(gas.doGet({
      parameter: { action: 'publicKey', key: env.properties.CONNECT_KEY },
    }));

    check('★ライセンス未着は NO_LICENSE で返す（NOT_CONFIGURED にしない）',
      denied.error.code === 'NO_LICENSE', JSON.stringify(denied));

    env.properties.LICENSE_KEY = 'LK'.padEnd(43, 'x');

    check('ライセンスが届いていれば鍵を返す',
      env.readOutput(gas.doGet({ parameter: { action: 'publicKey', key: env.properties.CONNECT_KEY } })).ok === true);
  }

  /* ================================================================ */
  section('引き継ぎリンク');

  {
    const env = createReadyNotifierEnvironment();
    const gas = env.api;

    const handoff = gas.getHandoffLink();

    check('リンクを作れる', handoff.ok === true, JSON.stringify(handoff));
    check('録音アプリのURLへ向ける',
      handoff.link.indexOf('https://tsam-ai.com/production-app/voice-recorder/#setup=') === 0,
      handoff.link);

    const encoded = handoff.link.split('#setup=')[1];
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));

    check('接続先と接続キーを載せる',
      payload.execUrl !== '' && payload.connectKey === env.properties.CONNECT_KEY);
    check('★ライセンスキーは載せない（逆向きに録音アプリから届く）',
      JSON.stringify(payload).includes(env.properties.LICENSE_KEY) === false, JSON.stringify(payload));
    check('★秘密はフラグメントに置く（サーバーへ送信されない）',
      handoff.link.includes('?') === false);

    env.properties.WEBAPP_URL = '';

    check('未公開ならリンクを出さない', gas.getHandoffLink().ok === false);
  }

  /* ================================================================ */
  section('セットアップ（冪等・鍵・トリガー）');

  {
    const env = createNotifierEnvironment();
    const gas = env.api;

    check('セットアップ前はトリガーが無い', env.getTriggers().length === 0);

    gas.setupNotifier();

    check('4つのシートができる',
      ['settings', 'subscriptions', 'notify_queue', 'sent_log']
        .every((name) => env.book.getSheetByName(name) !== null));
    check('毎分トリガーができる', env.getTriggers().length === 1);
    check('トリガーの関数は tick', env.getTriggers()[0].getHandlerFunction() === 'tick');
    check('間隔は1分', env.getTriggers()[0].minutes === 1);
    check('★VAPID の鍵を作らない（ゲートが持つ）',
      env.properties.VAPID_PRIVATE_PEM === undefined);
    check('匿名化の鍵ができる', String(env.properties.EID_HMAC_KEY).length > 40);
    check('★匿名化の鍵は base64url', /^[A-Za-z0-9_-]+$/.test(env.properties.EID_HMAC_KEY));
    check('接続キーができる', env.properties.CONNECT_KEY.length > 40);
    check('★接続キーも base64url', /^[A-Za-z0-9_-]+$/.test(env.properties.CONNECT_KEY));

    const eidKey = env.properties.EID_HMAC_KEY;
    const connectKey = env.properties.CONNECT_KEY;

    gas.setupNotifier();

    check('★2回目の実行で匿名化の鍵を作り直さない', env.properties.EID_HMAC_KEY === eidKey);
    check('★2回目の実行で接続キーを作り直さない', env.properties.CONNECT_KEY === connectKey);
    check('★2回目の実行でトリガーが増えない', env.getTriggers().length === 1);
    check('★2回目の実行でシートが増えない', env.book.sheets.length === 4);
    check('2回目でも設定は保たれる', gas.readSettings_().timing === 5);

    const status = gas.getSetupStatus();

    check('状態チェッカーが匿名化の鍵を見る', status.eidKey === true);
    check('状態チェッカーがトリガーを見る', status.trigger === true);
    /* この環境は setupNotifier() だけを実行しており、まだ公開していない。 */
    check('★セットアップだけでは公開済みにならない', status.deployed === false);
    check('状態チェッカーがライセンスを見る', status.license === false);
    check('★状態チェッカーに接続キーを含めない',
      JSON.stringify(status).includes(connectKey) === false);
  }

  /* ================================================================ */
  section('★セットアップに手作業の工程が残っていないこと（§5.4）');

  {
    const sidebar = readGas('SidebarSetup.html');
    const code = readGas('Code.gs');
    const setup = readGas('Setup.gs');
    const readme = readGas('README.md');

    check('★jsrsasign の貼り付けファイルが存在しない',
      readdirHas('lib_jsrsasign.gs') === false);

    for (const [name, source] of [['SidebarSetup.html', sidebar], ['Code.gs', code], ['Setup.gs', setup]]) {
      check(`★${name} に jsrsasign が出てこない`, source.includes('jsrsasign') === false);
      check(`★${name} に「貼り付け」の指示が無い`, source.includes('貼り付けて') === false);
    }

    check('★ウィザードに公開ボタンがある', sidebar.includes('deployWebApp()'));
    check('★ウィザードに引き継ぎリンクがある', sidebar.includes('getHandoffLink()'));
    check('★API 未許可を検出して設定ページへ誘導する',
      sidebar.includes('API_DISABLED') && sidebar.includes('script.google.com/home/usersettings'));
    check('★GCP 側の未有効にも別の案内を出す',
      sidebar.includes('API_DISABLED_GCP') && sidebar.includes('panel-gcp'));
    check('★Google が示す有効化URLをボタンにする', sidebar.includes('result.helpUrl'));
    check('★自動検出のポーリングがある', sidebar.includes('startApiPolling'));
    check('★行き止まりにしない（手動デプロイの折りたたみが残っている）',
      sidebar.includes('うまくいかないときは') && sidebar.includes('デプロイを管理'));

    /*
     * ------------------------------------------------------------------
     * GCP 分岐は手動公開を主経路にする（2026-08-11 の実機で決めた）
     * ------------------------------------------------------------------
     * Workspace の既定プロジェクト（`sys-` で始まる）では、自動公開まで
     * 進めるのに「プロジェクト作成 → API を2つ有効化 → 切替 → 再承認」が要る。
     * 一般の利用者に求める工程ではない。手動デプロイなら1分で同じ結果になる。
     * ------------------------------------------------------------------
     */
    const gcpPanel = sidebar.slice(
      sidebar.indexOf('<section id="panel-gcp"'),
      sidebar.indexOf('<!-- 状態4'),
    );

    check('★GCP 分岐は手動公開を先に出す',
      gcpPanel.indexOf('新しいデプロイ') < gcpPanel.indexOf('<details>'),
      String(gcpPanel.indexOf('新しいデプロイ')));
    check('★GCP の自力設定は折りたたみへ入れる',
      gcpPanel.includes('<details>') && gcpPanel.includes('技術者向け'));
    check('★カレンダー API の有効化も手順に含める',
      gcpPanel.includes('Google カレンダー API'), 'Advanced Calendar Service が要る');
    check('★手動で公開したあとの出口がある', gcpPanel.includes('gcp-recheck'));
    check('★GCP 分岐では待たない（再承認でサイドバーが開き直されるため）',
      /API_DISABLED_GCP'\)\s*\{[^}]*\}[\s\S]{0,400}?showPanel\('gcp'\);\s*return;/.test(sidebar),
      'startApiPolling が残っていないか');

    /*
     * 公開したあとにコードを貼り替える場面のほうが多い。
     * 更新の導線が「うまくいかないときは」の中にしか無いのは誤りだった。
     */
    const donePanel = sidebar.slice(
      sidebar.indexOf('<section id="panel-done"'),
      sidebar.indexOf('<p class="msg"'),
    );

    check('★完了画面に更新の導線がある', donePanel.includes('run-update'));
    check('★完了画面から「デプロイを管理」へ辿れる',
      donePanel.includes('デプロイを管理') && donePanel.includes('新バージョン'));
    check('★「新しいデプロイ」を選ばせない注意がある',
      donePanel.includes('「新しいデプロイ」は選ばないでください'));
    /* 「使わない」と書いたコメントに引っかからないよう、代入の形で見る。 */
    check('★接続キーを innerHTML で入れない', /\.innerHTML/.test(sidebar) === false);

    /*
     * README は「jsrsasign の工程が消えた」という経緯を残しているので、
     * 語そのものの有無では見ない。**手順として残っていないこと**を見る。
     */
    check('★README の手順に貼り付け先ファイルが残っていない',
      readme.includes('lib_jsrsasign.gs') === false, 'README');
    check('★README に外部ライブラリを同梱しないと書いてある',
      readme.includes('同梱する外部ライブラリは**無い**'));
  }

  /* ================================================================ */
  section('★GASの権限（NFR-01 / NFR-02 / DR-04）');

  {
    const manifest = JSON.parse(readGas('appsscript.json'));

    /*
     * ★スコープの一覧を丸ごと固定する。
     *
     * oauthScopes を明示すると Apps Script の自動スコープ判定が無効になり、
     * 「コードが使う権限を1つ残らず自分で並べる」責任がこちらへ移る。
     * 実機では script.container.ui の書き漏らしで Ui.showSidebar が例外になった。
     *
     * 件数だけを見ると、1つ落として1つ足しても通ってしまう。
     * 中身の集合で固定し、増減はこのテストを直す判断とセットにする。
     */
    const EXPECTED_SCOPES = [
      'https://www.googleapis.com/auth/calendar.events.readonly',
      'https://www.googleapis.com/auth/script.container.ui',
      'https://www.googleapis.com/auth/script.deployments',
      'https://www.googleapis.com/auth/script.external_request',
      'https://www.googleapis.com/auth/script.projects',
      'https://www.googleapis.com/auth/script.scriptapp',
      'https://www.googleapis.com/auth/spreadsheets.currentonly',
    ];

    check('★スコープは7つ（NFR-02）', manifest.oauthScopes.length === 7,
      manifest.oauthScopes.join(' / '));
    check('★スコープの一覧が想定どおり（増減はこのテストとセットで直す）',
      JSON.stringify(manifest.oauthScopes.slice().sort()) === JSON.stringify(EXPECTED_SCOPES),
      manifest.oauthScopes.slice().sort().join(' / '));
    check('★増えた2つはワンボタン公開のためだけ（projects / deployments）',
      manifest.oauthScopes.includes('https://www.googleapis.com/auth/script.projects')
      && manifest.oauthScopes.includes('https://www.googleapis.com/auth/script.deployments'));
    check('カレンダーは読み取りのみ',
      manifest.oauthScopes.includes('https://www.googleapis.com/auth/calendar.events.readonly'));
    check('★カレンダーの書き込み権限を持たない',
      !manifest.oauthScopes.some((scope) => /auth\/calendar$/.test(scope)));
    check('★スプレッドシートは currentonly（他のファイルを開けない）',
      manifest.oauthScopes.includes('https://www.googleapis.com/auth/spreadsheets.currentonly'));
    check('★Drive 全体の権限を持たない',
      !manifest.oauthScopes.some((scope) => scope.includes('auth/drive')));
    check('★メール送信の権限を持たない',
      !manifest.oauthScopes.some((scope) => scope.includes('send_mail')));
    check('★データへの経路は増えていない',
      !manifest.oauthScopes.some((scope) => /userinfo|drive|gmail|contacts/.test(scope)));
    check('Calendar Advanced Service を使う',
      manifest.dependencies.enabledAdvancedServices[0].userSymbol === 'Calendar');
    check('ウェブアプリは匿名アクセス（Service Worker から叩くため）',
      manifest.webapp.access === 'ANYONE_ANONYMOUS');
    check('実行は公開した本人', manifest.webapp.executeAs === 'USER_DEPLOYING');

    /*
     * ★「なぜこの数なのか」を文書から消させない。
     * appsscript.json は素の JSON でコメントを書けないため、理由の置き場は README だけ。
     */
    const readme = readGas('README.md');

    check('★README にスコープの理由が書かれている',
      readme.includes('script.container.ui') && readme.includes('自動スコープ判定'));
    check('★README に追加した2スコープの理由がある',
      readme.includes('script.deployments'));
  }

  /* ================================================================ */
  section('★設計意図の移送（docs との対応）');

  {
    const notes = readFileSync(join(REPO_ROOT, 'docs/notifier-design-notes.md'), 'utf8');

    check('設計ノートに対応表がある', notes.includes('コードとこの文書の対応表'));
    check('B-04 の理由が書かれている', notes.includes('B-04'));
    check('B-05 の理由が書かれている', notes.includes('B-05'));
    check('匿名化の理由が書かれている', notes.includes('EID_HMAC_KEY'));
    check('引き継ぎ方向の理由が書かれている', notes.includes('saveLicense'));
    check('★公開されうる場所なので秘密を書かない', /AKfy[A-Za-z0-9_-]{20,}/.test(notes) === false);

    /* ゲートのURLは正本を参照している（notifier-gate スイートが一致を見る）。 */
    check('Gate.gs がゲートのオリジンを持つ',
      readGas('Gate.gs').includes('https://notifier-gate.potenitas-lp.workers.dev'));
  }

  finish();
} catch (error) {
  fatal(error);
}

/* gas-notifier/ に指定のファイルがあるか。 */
function readdirHas(name) {
  try {
    readFileSync(join(GAS_DIR, name), 'utf8');
    return true;
  } catch {
    return false;
  }
}

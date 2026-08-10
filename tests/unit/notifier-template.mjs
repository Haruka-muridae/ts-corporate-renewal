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
  REPO_ROOT,
  createNotifierEnvironment,
  createReadyNotifierEnvironment,
  installGateStub,
} from '../helpers/gas-notifier-harness.mjs';

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
      Object.keys(health.data).sort().join(',') === 'configured,lastTickAt,licensed,ok,triggerActive,version');

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
    env.setServiceUrl('');

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
    check('状態チェッカーが公開を見る', status.deployed === true);
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
    check('★自動検出のポーリングがある', sidebar.includes('startApiPolling'));
    check('★行き止まりにしない（手動デプロイの折りたたみが残っている）',
      sidebar.includes('うまくいかないときは') && sidebar.includes('デプロイを管理'));
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

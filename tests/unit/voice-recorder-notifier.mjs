/*
 * 録音アプリのカレンダー通知（gas-notifier/ と production-app/voice-recorder/）。
 *
 * 対象要件: recording_calendar_requirements.docx v1.0
 *   FR-03〜FR-20 / DR-01〜04 / NFR-01/02/04/05/06 / AC-01〜09
 *
 * ==================================================================
 * ここで見るのは「ブラウザが要らない部分」だけ
 * ==================================================================
 * Service Worker の登録・Push の受信・通知の表示は実ブラウザでしか
 * 動かないため、AC-01〜09 は利用者が実機で確かめる
 * （docs/calendar-notifier-setup.md の「動作確認」）。
 *
 * こちらで固定するのは次の4つ:
 *   1. 通知対象の判定（要件書 §6 の順序と各条件）
 *   2. 送信の集約・二重送信の防止・失効購読の削除
 *   3. API の入出力（接続キー、health に予定を含めないこと）
 *   4. 通知本文とURLの組み立て（純関数）
 * さらに「録音を自動で始めるコードが混ざっていないこと」を文字列で見張る。
 * ==================================================================
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { check, section, finish, fatal } from '../../public/apps/tests/helpers/assert.mjs';
import {
  REPO_ROOT,
  createNotifierEnvironment,
  createReadyNotifierEnvironment,
} from '../helpers/gas-notifier-harness.mjs';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const APP_DIR = join(REPO_ROOT, 'public/production-app/voice-recorder');

function readApp(name) {
  return readFileSync(join(APP_DIR, name), 'utf8');
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

try {
  const messages = await import('../../public/production-app/voice-recorder/notifier-messages.js');

  /* ================================================================ */
  section('§6 通知対象の判定（decideEvent_）');

  {
    const env = createReadyNotifierEnvironment();
    const gas = env.api;
    const settings = gas.readSettings_();

    check('既定は 参加予定=ON（FR-06）', settings.accepted === true);
    check('既定は 仮参加=ON（FR-06）', settings.tentative === true);
    check('既定は 未回答=ON（FR-06）', settings.needsAction === true);
    check('★既定は 辞退=OFF（FR-06）', settings.declined === false);
    check('既定は 時間指定のみ=ON（FR-07）', settings.timedOnly === true);
    check('既定の通知タイミングは5分前（FR-11）', settings.timing === 5);

    check('accepted の時間指定予定は通知する（AC-01）',
      gas.decideEvent_(makeEvent({ responseStatus: 'accepted' }), settings).include === true);
    check('★declined は通知しない（AC-02）',
      gas.decideEvent_(makeEvent({ responseStatus: 'declined' }), settings).include === false);
    check('needsAction は通知する（AC-03）',
      gas.decideEvent_(makeEvent({ responseStatus: 'needsAction' }), settings).include === true);
    check('tentative は通知する（FR-05）',
      gas.decideEvent_(makeEvent({ responseStatus: 'tentative' }), settings).include === true);

    check('★終日予定は通知しない（AC-04）',
      gas.decideEvent_(makeEvent({ allDay: '2026-08-10' }), settings).include === false);
    check('終日予定の除外理由が all-day である',
      gas.decideEvent_(makeEvent({ allDay: '2026-08-10' }), settings).reason === 'all-day');

    const relaxed = { ...settings, timedOnly: false };
    check('「時間指定のみ」を外すと終日予定も対象になる（FR-07）',
      gas.decideEvent_(makeEvent({ allDay: '2026-08-10' }), relaxed).include === true);

    check('★削除済みは通知しない（FR-14）',
      gas.decideEvent_(makeEvent({ status: 'cancelled' }), settings).include === false);

    /*
     * ★判定の順序。削除済みの終日予定は「終日だから」ではなく
     * 「削除済みだから」で落ちなければ、キューから消す処理へ回らない。
     */
    check('★削除済みの終日予定は cancelled と判定される（順序の固定）',
      gas.decideEvent_(makeEvent({ status: 'cancelled', allDay: '2026-08-10' }), settings).reason === 'cancelled');

    check('★自分が出席者に居ない予定は通知しない',
      gas.decideEvent_(makeEvent({
        attendees: [{ email: 'other@example.com', responseStatus: 'accepted' }],
      }), settings).include === false);

    check('自分が居ない理由は not-attendee',
      gas.decideEvent_(makeEvent({
        attendees: [{ email: 'other@example.com', responseStatus: 'accepted' }],
      }), settings).reason === 'not-attendee');

    check('★attendees が無い自作の単独予定は通知する（一人予定の取りこぼし防止）',
      gas.decideEvent_(makeEvent({ attendees: undefined, responseStatus: null, organizer: { self: true } }), settings)
        .include === true);

    check('attendees も organizer も自分でない予定は通知しない',
      gas.decideEvent_(makeEvent({ attendees: undefined, responseStatus: null, organizer: { email: 'x@example.com' } }), settings)
        .include === false);

    check('★responseStatus が空の自分は needsAction として扱う',
      gas.selfResponseStatus_(makeEvent({ responseStatus: '' })) === 'needsAction');

    check('未知の responseStatus も needsAction へ寄せる',
      gas.selfResponseStatus_(makeEvent({ responseStatus: 'unknown-value' })) === 'needsAction');

    check('null を渡しても落ちない', gas.decideEvent_(null, settings).include === false);
    check('start が無い予定は通知しない',
      gas.decideEvent_({ id: 'x', status: 'confirmed', start: {} }, { ...settings, timedOnly: false }).include === false);
  }

  /* ================================================================ */
  section('開始時刻と通知予定時刻');

  {
    const env = createReadyNotifierEnvironment();
    const gas = env.api;
    const startMs = Date.UTC(2026, 7, 10, 1, 0, 0);

    check('時間指定の開始時刻を読める',
      gas.eventStartMs_(makeEvent({ startMs })) === startMs);

    /*
     * ★終日予定は「スクリプトのタイムゾーンでの0時」。
     * new Date('2026-08-10') は UTC の0時になり、日本時間では前日9時になる。
     */
    check('★終日予定はローカル0時として読む',
      gas.eventStartMs_(makeEvent({ allDay: '2026-08-10' })) === new Date(2026, 7, 10).getTime());

    check('読めない開始時刻は NaN', Number.isNaN(gas.eventStartMs_({ start: { date: 'いつか' } })));

    check('5分前の通知予定時刻', gas.computeNotifyAt_(startMs, 5) === startMs - 5 * MINUTE);
    check('15分前の通知予定時刻', gas.computeNotifyAt_(startMs, 15) === startMs - 15 * MINUTE);
    check('★0（開始時刻）は開始時刻そのもの（FR-10）', gas.computeNotifyAt_(startMs, 0) === startMs);

    check('予定名が空なら既定の文言にする', gas.eventTitle_({ summary: '   ' }) === '（タイトルなし）');
    check('予定名は前後の空白を落とす', gas.eventTitle_({ summary: ' 定例 ' }) === '定例');
  }

  /* ================================================================ */
  section('設定の正規化（シートを手で編集されても壊れない）');

  {
    const env = createReadyNotifierEnvironment();
    const gas = env.api;

    check('★文字列の false を true にしない',
      gas.normalizeSettings_({ declined: 'false' }).declined === false);
    check('文字列の true は true', gas.normalizeSettings_({ declined: 'true' }).declined === true);
    check('TRUE（大文字）も true', gas.normalizeSettings_({ declined: 'TRUE' }).declined === true);
    check('空欄は既定値へ戻す', gas.normalizeSettings_({ declined: '' }).declined === false);
    check('未知の文字列も既定値へ戻す', gas.normalizeSettings_({ accepted: 'あ' }).accepted === true);

    check('選択肢に無いタイミングは既定へ戻す', gas.normalizeSettings_({ timing: 7 }).timing === 5);
    check('★上限を超える値も既定へ戻す', gas.normalizeSettings_({ timing: 1440 }).timing === 5);
    check('負の値も既定へ戻す', gas.normalizeSettings_({ timing: -5 }).timing === 5);
    check('数値でない値も既定へ戻す', gas.normalizeSettings_({ timing: 'すぐ' }).timing === 5);
    check('10分前は受け付ける', gas.normalizeSettings_({ timing: 10 }).timing === 10);
    check('文字列の "15" も受け付ける', gas.normalizeSettings_({ timing: '15' }).timing === 15);
    check('0（開始時刻）は受け付ける', gas.normalizeSettings_({ timing: 0 }).timing === 0);

    const saved = gas.writeSettings_({ declined: true, timing: 15 });
    check('保存した値が読み戻せる', gas.readSettings_().declined === true && gas.readSettings_().timing === 15);
    check('保存の戻り値も正規化済み', saved.declined === true && saved.timing === 15);
    check('★渡さなかった項目は現在値を残す', gas.writeSettings_({ timing: 0 }).declined === true);
  }

  /* ================================================================ */
  section('同期とキュー（FR-13 / FR-14 / DR-03）');

  {
    const now = Date.UTC(2026, 7, 10, 0, 0, 0);
    const env = createReadyNotifierEnvironment({ now });
    const gas = env.api;
    const settings = gas.readSettings_();
    const startMs = now + 2 * HOUR;

    gas.applyCalendarItems_([makeEvent({ id: 'a', startMs })], settings, now);

    let queue = env.readSheet('notify_queue');
    check('対象の予定がキューへ入る', queue.length === 1);
    check('キューのキーは eventId|timing', queue[0].key === 'a|5');
    check('通知予定時刻は開始の5分前', queue[0].notifyAt === startMs - 5 * MINUTE);
    check('★開始時刻は数値（エポックミリ秒）で持つ', typeof queue[0].startTime === 'number');

    /* 開始時刻が動いたら通知予定時刻も引き直す（FR-13）。 */
    gas.applyCalendarItems_([makeEvent({ id: 'a', startMs: startMs + 30 * MINUTE })], settings, now);
    queue = env.readSheet('notify_queue');
    check('★開始時刻の変更で行が増えない（upsert）', queue.length === 1);
    check('★通知予定時刻が引き直される（FR-13）',
      queue[0].notifyAt === startMs + 30 * MINUTE - 5 * MINUTE);

    /* 削除（FR-14）。 */
    gas.applyCalendarItems_([makeEvent({ id: 'a', status: 'cancelled', startMs })], settings, now);
    check('★削除済みになった予定はキューから消える（FR-14）',
      env.readSheet('notify_queue').length === 0);

    /* 出欠を辞退へ変えた場合も消える。 */
    gas.applyCalendarItems_([makeEvent({ id: 'b', startMs })], settings, now);
    gas.applyCalendarItems_([makeEvent({ id: 'b', startMs, responseStatus: 'declined' })], settings, now);
    check('★辞退へ変えた予定もキューから消える',
      env.readSheet('notify_queue').length === 0);

    /* タイミング変更で古い行が残らない。 */
    gas.applyCalendarItems_([makeEvent({ id: 'c', startMs })], settings, now);
    const retimed = gas.writeSettings_({ timing: 15 });
    gas.applyCalendarItems_([makeEvent({ id: 'c', startMs })], retimed, now);
    queue = env.readSheet('notify_queue');
    check('★タイミングを変えても二重にならない', queue.length === 1);
    check('新しいタイミングのキーになっている', queue[0].key === 'c|15');

    /* 一覧に出てこない行は消さない（開始済みの予定を消してしまわないため）。 */
    gas.applyCalendarItems_([], retimed, now);
    check('★一覧に無いだけでは消さない', env.readSheet('notify_queue').length === 1);

    /* 7日より古い行は消す（DR-03）。 */
    gas.applyCalendarItems_([], retimed, now + 8 * DAY);
    check('★開始から7日を過ぎた行は消える（DR-03）',
      env.readSheet('notify_queue').length === 0);
  }

  /* ================================================================ */
  section('Calendar API の呼び方（FR-04 / NFR-02）');

  {
    const now = Date.UTC(2026, 7, 10, 0, 0, 0);
    const env = createReadyNotifierEnvironment({ now });

    env.setCalendarItems([makeEvent({ id: 'z', startMs: now + HOUR })]);
    env.api.syncCalendar_(now);

    const call = env.getCalendarCalls()[0];

    check('primary カレンダーを見る', call.calendarId === 'primary');
    check('★singleEvents: true（繰り返しを1件ずつに展開する）', call.options.singleEvents === true);
    check('★showDeleted: true（削除済みを拾ってキューから消すため）', call.options.showDeleted === true);
    check('先読みは24時間', new Date(call.options.timeMax).getTime() - new Date(call.options.timeMin).getTime() === DAY);
    check('同期結果がキューへ入る', env.readSheet('notify_queue').length === 1);
  }

  /* ================================================================ */
  section('送信（FR-12 / NFR-04 / AC-08）');

  {
    const now = Date.UTC(2026, 7, 10, 0, 0, 0);
    const env = createReadyNotifierEnvironment({ now });
    const gas = env.api;

    gas.upsertSubscription_({
      endpoint: 'https://push.example.test/aaa',
      keys: { p256dh: 'PPP', auth: 'AAA' },
    }, now);

    const settings = gas.readSettings_();

    /* 期限が来た予定を3件そろえる。 */
    gas.applyCalendarItems_([
      makeEvent({ id: 'e1', startMs: now + 4 * MINUTE }),
      makeEvent({ id: 'e2', startMs: now + 4 * MINUTE }),
      makeEvent({ id: 'e3', startMs: now + 4 * MINUTE }),
    ], settings, now);

    check('3件がキューに入っている', env.readSheet('notify_queue').length === 3);
    check('3件とも期限が来ている', gas.collectDueRows_(now).length === 3);

    env.clearFetchCalls();
    const sent = gas.sendDueNotifications_(now);

    check('★期限の来た3件に対して Push は1通だけ（1 tick 1購読1通）',
      env.fetchCalls.length === 1, `実測 ${env.fetchCalls.length} 通`);
    check('送信先は購読のエンドポイント', env.fetchCalls[0].url === 'https://push.example.test/aaa');
    check('★本文を送らない（tickle）', env.fetchCalls[0].options.payload === undefined);
    check('POST で送る', env.fetchCalls[0].options.method === 'post');
    check('TTL ヘッダーを付ける', env.fetchCalls[0].options.headers.TTL === '300');
    check('Authorization は vapid スキーム',
      env.fetchCalls[0].options.headers.Authorization.indexOf('vapid t=') === 0);
    check('公開鍵を k= で添える',
      env.fetchCalls[0].options.headers.Authorization.includes(`k=${env.properties.VAPID_PUBLIC_B64URL}`));
    check('例外を出さずに処理する（muteHttpExceptions）',
      env.fetchCalls[0].options.muteHttpExceptions === true);

    check('3件とも sent_log へ記録される', sent.recorded === 3);
    check('★記録後は期限判定から外れる（二重送信の防止・AC-08）',
      gas.collectDueRows_(now).length === 0);

    env.clearFetchCalls();
    gas.sendDueNotifications_(now);
    check('★同じ時刻でもう一度呼んでも送らない', env.fetchCalls.length === 0);

    /* JWT の中身。 */
    const signed = env.jsrsasign.signed[env.jsrsasign.signed.length - 1];
    check('署名アルゴリズムは ES256', signed.algorithm === 'ES256');
    check('JWT ヘッダーの alg も ES256', signed.header.alg === 'ES256');
    check('★aud はエンドポイントの origin（パスを含めない）',
      signed.payload.aud === 'https://push.example.test');
    check('sub は mailto:（実行ユーザーのメール）', signed.payload.sub === 'mailto:owner@example.com');
    check('exp は12時間後', signed.payload.exp === Math.floor((now + 12 * HOUR) / 1000));
  }

  /* ================================================================ */
  section('送信の失敗と購読の失効');

  {
    const now = Date.UTC(2026, 7, 10, 0, 0, 0);
    const env = createReadyNotifierEnvironment({ now });
    const gas = env.api;

    gas.upsertSubscription_({ endpoint: 'https://push.example.test/gone', keys: { p256dh: 'P', auth: 'A' } }, now);
    gas.upsertSubscription_({ endpoint: 'https://push.example.test/ok', keys: { p256dh: 'P', auth: 'A' } }, now);

    check('購読は2件', env.readSheet('subscriptions').length === 2);
    check('★同じ endpoint の再登録で行が増えない',
      gas.upsertSubscription_({ endpoint: 'https://push.example.test/ok', keys: { p256dh: 'P2', auth: 'A2' } }, now).created === false
      && env.readSheet('subscriptions').length === 2);

    env.onFetch((url) => (url.endsWith('/gone') ? { status: 410, body: 'gone' } : { status: 201 }));

    gas.applyCalendarItems_([makeEvent({ id: 'x', startMs: now + 4 * MINUTE })], gas.readSettings_(), now);
    gas.sendDueNotifications_(now);

    check('★410 の購読は削除される', env.readSheet('subscriptions').length === 1);
    check('残るのは成功した購読', env.readSheet('subscriptions')[0].endpoint === 'https://push.example.test/ok');
    check('1件でも届けば sent_log へ記録する', env.readSheet('sent_log').length === 1);
  }

  {
    /* 全滅したときは記録しない（次の tick で自然に再試行される。NFR-04）。 */
    const now = Date.UTC(2026, 7, 10, 0, 0, 0);
    const env = createReadyNotifierEnvironment({ now });
    const gas = env.api;

    gas.upsertSubscription_({ endpoint: 'https://push.example.test/err', keys: { p256dh: 'P', auth: 'A' } }, now);
    env.onFetch(() => ({ status: 500, body: 'boom' }));

    gas.applyCalendarItems_([makeEvent({ id: 'y', startMs: now + 4 * MINUTE })], gas.readSettings_(), now);
    const result = gas.sendDueNotifications_(now);

    check('★誰にも届かなければ sent_log へ書かない（NFR-04）', result.recorded === 0);
    check('★次の tick で再試行できる（キューに残る）', gas.collectDueRows_(now).length === 1);
    check('500 では購読を消さない', env.readSheet('subscriptions').length === 1);
    check('失敗の理由を購読の行へ残す', String(env.readSheet('subscriptions')[0].lastError).indexOf('500') === 0);
  }

  {
    /* 連絡先が取れない環境では https の URI へ落とす（スコープを増やさない）。 */
    const now = Date.UTC(2026, 7, 10, 0, 0, 0);
    const env = createReadyNotifierEnvironment({ now, email: '' });
    const gas = env.api;

    gas.upsertSubscription_({ endpoint: 'https://push.example.test/a', keys: { p256dh: 'P', auth: 'A' } }, now);
    gas.applyCalendarItems_([makeEvent({ id: 'q', startMs: now + 4 * MINUTE })], gas.readSettings_(), now);
    gas.sendDueNotifications_(now);

    const signed = env.jsrsasign.signed[env.jsrsasign.signed.length - 1];
    check('★メールが取れないときは https の連絡先URIを sub にする（NFR-02）',
      signed.payload.sub === 'https://tsam-ai.com/production-app/voice-recorder/');
  }

  /* ================================================================ */
  section('tick（同期の間隔と多重実行）');

  {
    const now = Date.UTC(2026, 7, 10, 0, 0, 0);
    const env = createReadyNotifierEnvironment({ now });

    env.setCalendarItems([makeEvent({ id: 't1', startMs: now + HOUR })]);

    env.api.tick();
    check('最初の tick で同期する', env.getCalendarCalls().length === 1);
    check('最終tick時刻を記録する', String(env.properties.LAST_TICK_AT) === String(now));

    env.setTime(now + MINUTE);
    env.api.tick();
    check('★1分後の tick では同期しない（5分間隔）', env.getCalendarCalls().length === 1);

    env.setTime(now + 5 * MINUTE);
    env.api.tick();
    check('5分たてば同期する', env.getCalendarCalls().length === 2);
    check('tick のあともロックは解放されている', env.api.LockService.getScriptLock().hasLock() === false);
  }

  /* ================================================================ */
  section('API（接続キーと入出力）');

  {
    const now = Date.UTC(2026, 7, 10, 0, 0, 0);
    const env = createReadyNotifierEnvironment({ now });
    const gas = env.api;
    const key = env.properties.CONNECT_KEY;

    const health = env.readOutput(gas.doGet({ parameter: { action: 'health' } }));
    check('★health は接続キー無しで読める', health.ok === true);
    check('health は版を返す', health.data.version === gas.NOTIFIER_VERSION);
    check('health はトリガーの稼働を返す', health.data.triggerActive === true);
    check('★health に予定の内容を含めない', JSON.stringify(health).includes('MTG') === false);
    check('★health に接続キーを含めない', JSON.stringify(health).includes(key) === false);

    check('★接続キーが無いと publicKey は返さない',
      env.readOutput(gas.doGet({ parameter: { action: 'publicKey' } })).error.code === 'UNAUTHORIZED');
    check('★誤った接続キーも拒む',
      env.readOutput(gas.doGet({ parameter: { action: 'publicKey', key: 'wrong' } })).error.code === 'UNAUTHORIZED');
    check('正しい接続キーなら公開鍵を返す',
      env.readOutput(gas.doGet({ parameter: { action: 'publicKey', key } })).data.publicKey
        === env.properties.VAPID_PUBLIC_B64URL);

    check('★未知の action は拒む',
      env.readOutput(gas.doGet({ parameter: { action: 'listSecrets', key } })).error.code === 'INVALID_ACTION');
    check('★管理用の関数名を action にしても通らない',
      env.readOutput(gas.doGet({ parameter: { action: 'setupNotifier', key } })).error.code === 'INVALID_ACTION');
    check('★tick も action からは呼べない',
      env.readOutput(gas.doPost({ postData: { contents: JSON.stringify({ action: 'tick', key }) } })).error.code
        === 'INVALID_ACTION');

    check('本文が無い POST は拒む',
      env.readOutput(gas.doPost({})).error.code === 'INVALID_REQUEST');
    check('壊れた JSON の POST は拒む',
      env.readOutput(gas.doPost({ postData: { contents: '{' } })).error.code === 'INVALID_REQUEST');

    const settingsOut = env.readOutput(gas.doGet({ parameter: { action: 'getSettings', key } }));
    check('設定を取得できる（FR-08）', settingsOut.data.settings.timing === 5);

    const savedOut = env.readOutput(gas.doPost({
      postData: { contents: JSON.stringify({ action: 'saveSettings', key, settings: { timing: 99, declined: 'true' } }) },
    }));
    check('★保存時にサーバー側で正規化する（画面の値を信じない）',
      savedOut.data.settings.timing === 5 && savedOut.data.settings.declined === true);

    const subOut = env.readOutput(gas.doPost({
      postData: {
        contents: JSON.stringify({
          action: 'saveSubscription',
          key,
          subscription: { endpoint: 'https://push.example.test/api', keys: { p256dh: 'P', auth: 'A' } },
        }),
      },
    }));
    check('購読を登録できる', subOut.ok === true && subOut.data.created === true);
    check('http の endpoint は拒む（NFR-01）',
      env.readOutput(gas.doPost({
        postData: {
          contents: JSON.stringify({
            action: 'saveSubscription',
            key,
            subscription: { endpoint: 'http://push.example.test/x', keys: { p256dh: 'P', auth: 'A' } },
          }),
        },
      })).error.code === 'SERVER_ERROR');
  }

  /* ================================================================ */
  section('pending と event（FR-15/16 と 5.3）');

  {
    const now = Date.UTC(2026, 7, 10, 0, 0, 0);
    const env = createReadyNotifierEnvironment({ now });
    const gas = env.api;
    const key = env.properties.CONNECT_KEY;
    const startMs = now + 4 * MINUTE;

    gas.upsertSubscription_({ endpoint: 'https://push.example.test/p', keys: { p256dh: 'P', auth: 'A' } }, now);
    gas.applyCalendarItems_([makeEvent({ id: 'p1', summary: '株式会社ABC 定例MTG', startMs })], gas.readSettings_(), now);
    gas.sendDueNotifications_(now);

    const first = env.readOutput(gas.doGet({ parameter: { action: 'pending', key } }));
    check('未取得の通知を返す', first.data.notifications.length === 1);
    check('予定名を返す（FR-15）', first.data.notifications[0].title === '株式会社ABC 定例MTG');
    check('開始時刻は ISO 文字列で返す',
      new Date(first.data.notifications[0].startTime).getTime() === startMs);

    const second = env.readOutput(gas.doGet({ parameter: { action: 'pending', key } }));
    check('★一度取得したら二度目は返さない（同じ通知を出し続けない）',
      second.data.notifications.length === 0);

    /* 10分より古い通知は出さない。 */
    const stale = createReadyNotifierEnvironment({ now });
    stale.api.upsertSubscription_({ endpoint: 'https://push.example.test/s', keys: { p256dh: 'P', auth: 'A' } }, now);
    stale.api.applyCalendarItems_([makeEvent({ id: 's1', startMs })], stale.api.readSettings_(), now);
    stale.api.sendDueNotifications_(now);
    stale.setTime(now + 11 * MINUTE);

    check('★送信から10分を過ぎた通知は返さない',
      stale.readOutput(stale.api.doGet({
        parameter: { action: 'pending', key: stale.properties.CONNECT_KEY },
      })).data.notifications.length === 0);

    const found = env.readOutput(gas.doGet({ parameter: { action: 'event', key, id: 'p1' } }));
    check('eventId から予定名を引ける（5.3）', found.data.event.title === '株式会社ABC 定例MTG');
    check('eventId から開始時刻を引ける',
      new Date(found.data.event.startTime).getTime() === startMs);
    check('知らない eventId は NOT_FOUND',
      env.readOutput(gas.doGet({ parameter: { action: 'event', key, id: 'nope' } })).error.code === 'NOT_FOUND');
    check('★接続キー無しでは予定を引けない',
      env.readOutput(gas.doGet({ parameter: { action: 'event', id: 'p1' } })).error.code === 'UNAUTHORIZED');
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
    check('VAPID の秘密鍵ができる', String(env.properties.VAPID_PRIVATE_PEM).includes('PRIVATE KEY'));
    check('VAPID の公開鍵ができる', env.properties.VAPID_PUBLIC_B64URL.length > 80);
    check('★公開鍵は base64url（+ / = を含まない）',
      /^[A-Za-z0-9_-]+$/.test(env.properties.VAPID_PUBLIC_B64URL));
    check('接続キーができる', env.properties.CONNECT_KEY.length > 40);
    check('★接続キーも base64url', /^[A-Za-z0-9_-]+$/.test(env.properties.CONNECT_KEY));
    check('★秘密鍵はシートに書かれない',
      JSON.stringify(env.readSheet('settings')).includes('PRIVATE') === false);

    const publicKey = env.properties.VAPID_PUBLIC_B64URL;
    const connectKey = env.properties.CONNECT_KEY;

    gas.setupNotifier();

    check('★2回目の実行で鍵を作り直さない', env.properties.VAPID_PUBLIC_B64URL === publicKey);
    check('★2回目の実行で接続キーを作り直さない', env.properties.CONNECT_KEY === connectKey);
    check('★2回目の実行でトリガーが増えない', env.getTriggers().length === 1);
    check('★2回目の実行でシートが増えない', env.book.sheets.length === 4);
    check('2回目でも設定は保たれる', gas.readSettings_().timing === 5);

    check('EC の secp256r1 で鍵を作る（P-256）',
      env.jsrsasign.generated[0].algorithm === 'EC' && env.jsrsasign.generated[0].curve === 'secp256r1');

    const status = gas.getSetupStatus();
    check('状態チェッカーが鍵を見る', status.keys === true);
    check('状態チェッカーがトリガーを見る', status.trigger === true);
    check('状態チェッカーが公開を見る', status.deployed === true);
    check('★状態チェッカーに接続キーを含めない',
      JSON.stringify(status).includes(connectKey) === false);

    env.setServiceUrl('');
    check('未デプロイなら接続コードのURLは空', gas.getConnectionCode().url === '');

    check('jsrsasign の検証が通る', gas.verifyJsrsasign().includes('ES256'));
    check('接続キーを作り直すと変わる', gas.resetConnectionKey().key !== connectKey);
  }

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
  section('★GASの権限（NFR-01 / NFR-02 / DR-04）');

  {
    const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'gas-notifier/appsscript.json'), 'utf8'));

    check('★スコープはちょうど4つ（NFR-02）', manifest.oauthScopes.length === 4,
      manifest.oauthScopes.join(' / '));
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
    check('Calendar Advanced Service を使う',
      manifest.dependencies.enabledAdvancedServices[0].userSymbol === 'Calendar');
    check('ウェブアプリは匿名アクセス（Service Worker から叩くため）',
      manifest.webapp.access === 'ANYONE_ANONYMOUS');
    check('実行は公開した本人', manifest.webapp.executeAs === 'USER_DEPLOYING');

    const lib = readFileSync(join(REPO_ROOT, 'gas-notifier/lib_jsrsasign.gs'), 'utf8');
    const stubAt = lib.indexOf('var navigator');
    const bodyAt = lib.indexOf('jsrsasign-all-min.js の中身を貼る');

    check('★GAS用スタブが本体の貼り付け位置より上にある', stubAt !== -1 && stubAt < bodyAt);
    /*
     * 呼び出しの形（末尾の括弧）で見る。スタブのコメントには
     * 「Math.randomフォールバックを使わせないため」という説明文があり、
     * 単なる部分一致にすると、その説明ごと不合格になる。
     */
    check('★乱数は Utilities.getUuid() 由来（Math.random() を呼ばない）',
      lib.includes('Utilities.getUuid()') && !lib.includes('Math.random('));
    check('MIT ライセンス表記がある', lib.includes('MIT License'));
  }

  finish();
} catch (error) {
  fatal(error);
}

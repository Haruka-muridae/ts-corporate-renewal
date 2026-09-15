/*
 * Push Assistant の Service Worker（workers/push-assistant/public/sw.js）の試験。
 *
 * 仕様: docs/specs/push-assistant-mvp-v1.md §8-5・§8-6（通知タップ）、§12 試験H。
 *
 * ==================================================================
 * node:vm で偽の ServiceWorkerGlobalScope を作る理由
 * ==================================================================
 * sw.js は旧式（クラシック）の Service Worker で import を持たない。
 * ブラウザを起動せずに動作を確かめるため、`self` を偽の global object
 * にした専用コンテキストへソースを読み込み、addEventListener で
 * 登録されたハンドラを直接呼び出して検証する。
 * ==================================================================
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import { check, section, finish, fatal } from '../../public/apps/tests/helpers/assert.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(here, '..', '..');
const SW_PATH = join(REPO_ROOT, 'workers/push-assistant/public/sw.js');
const SCOPE = 'https://tsam-ai.com/push-assistant/';

const SW_SOURCE = readFileSync(SW_PATH, 'utf8');

/**
 * sw.js を偽の self の中で走らせる。
 *
 * addEventListener を差し替えて登録内容を捕まえ、fire() でイベントを
 * 発火する。event.waitUntil に渡された Promise を待ってから戻すので、
 * push / notificationclick / pushsubscriptionchange の非同期処理を
 * 呼び出し側で await できる。
 */
function loadSw({ fetchImpl } = {}) {
  const listeners = {};
  const notifications = [];
  const opened = [];
  const state = { skipWaitingCalled: false, claimed: false };
  let matchAllResult = [];

  const sandbox = { console };

  sandbox.self = sandbox;
  sandbox.atob = atob;
  sandbox.URL = URL;

  sandbox.addEventListener = (type, handler) => {
    (listeners[type] ||= []).push(handler);
  };

  sandbox.registration = {
    scope: SCOPE,
    showNotification(title, options) {
      notifications.push({ title, options });
      return Promise.resolve();
    },
    pushManager: {
      subscribe() {
        return Promise.resolve({
          toJSON: () => ({ endpoint: 'https://example.test/ep', keys: { p256dh: 'p', auth: 'a' } }),
        });
      },
    },
  };

  sandbox.clients = {
    matchAll() {
      return Promise.resolve(matchAllResult);
    },
    openWindow(url) {
      opened.push(url);
      return Promise.resolve(null);
    },
    claim() {
      state.claimed = true;
      return Promise.resolve();
    },
  };

  sandbox.skipWaiting = () => {
    state.skipWaitingCalled = true;
  };

  sandbox.fetch = fetchImpl ?? (() => Promise.reject(new Error('fetch is not stubbed in this test')));

  const context = vm.createContext(sandbox);

  new vm.Script(SW_SOURCE, { filename: SW_PATH }).runInContext(context);

  async function fire(type, eventObj) {
    const handlers = listeners[type] || [];
    let captured = null;

    eventObj.waitUntil = (promise) => {
      captured = Promise.resolve(promise);
    };

    for (const handler of handlers) {
      handler(eventObj);
    }

    if (captured) {
      await captured;
    }
  }

  return {
    listeners,
    notifications,
    opened,
    state,
    fire,
    setMatchAllResult(list) {
      matchAllResult = list;
    },
  };
}

try {
  /* ================================================================ */
  section('push: ペイロードから通知を作る（§8-5・試験H）');

  {
    const sw = loadSw();

    await sw.fire('push', {
      data: {
        json: () => ({
          v: 1,
          kind: 'event',
          title: '定例MTG',
          body: '10分後に開始します',
          url: 'https://meet.google.com/abc',
          tag: 'pa:e1:10',
        }),
      },
    });

    check('showNotification が1回呼ばれる', sw.notifications.length === 1, sw.notifications.length);
    check('タイトルはペイロードのまま', sw.notifications[0]?.title === '定例MTG');
    check('本文もペイロードのまま', sw.notifications[0]?.options?.body === '10分後に開始します');
    check('data.url がそのまま渡る', sw.notifications[0]?.options?.data?.url === 'https://meet.google.com/abc');
    check('tag が渡る', sw.notifications[0]?.options?.tag === 'pa:e1:10');
    check('renotify は false', sw.notifications[0]?.options?.renotify === false);
  }

  /* ================================================================ */
  section('★push: 不正な URL は scope に置き換える（試験G・§8-6）');

  {
    const sw = loadSw();

    await sw.fire('push', {
      data: { json: () => ({ title: 'X', url: 'javascript:alert(1)' }) },
    });

    check('scope に置き換わる', sw.notifications[0]?.options?.data?.url === SCOPE, sw.notifications[0]?.options?.data?.url);

    const sw2 = loadSw();

    await sw2.fire('push', {
      data: { json: () => ({ title: 'X', url: 'data:text/html,evil' }) },
    });

    check('data: URL も scope に置き換わる', sw2.notifications[0]?.options?.data?.url === SCOPE);

    const sw3 = loadSw();

    await sw3.fire('push', {
      data: { json: () => ({ title: 'X', url: '//example.net/x' }) },
    });

    check('プロトコル相対 URL も scope に置き換わる（絶対 http(s) 以外は拒否）', sw3.notifications[0]?.options?.data?.url === SCOPE);
  }

  /* ================================================================ */
  section('★push: ペイロード無しでも例外にならない（userVisibleOnly の約束）');

  {
    const sw = loadSw();

    await sw.fire('push', {});

    check('通知は出る', sw.notifications.length === 1);
    check('url は scope', sw.notifications[0]?.options?.data?.url === SCOPE);
    check('タイトルは案内文', sw.notifications[0]?.title === 'Push Assistant を開く', sw.notifications[0]?.title);
  }

  /* ================================================================ */
  section('★push: JSON でないデータでも例外にならない');

  {
    const sw = loadSw();

    await sw.fire('push', { data: { json: () => { throw new Error('invalid json'); } } });

    check('通知は出る', sw.notifications.length === 1);
    check('url は scope', sw.notifications[0]?.options?.data?.url === SCOPE);
  }

  /* ================================================================ */
  section('notificationclick: 同じ URL の窓が無ければ openWindow（試験H）');

  {
    const sw = loadSw();

    sw.setMatchAllResult([]);

    await sw.fire('notificationclick', {
      notification: { data: { url: 'https://meet.google.com/abc' }, close: () => {} },
    });

    check('openWindow が1回だけ呼ばれる', sw.opened.length === 1, JSON.stringify(sw.opened));
    check('その URL が渡る', sw.opened[0] === 'https://meet.google.com/abc');
  }

  /* ================================================================ */
  section('★notificationclick: 同じ URL の窓があれば focus し、openWindow は呼ばない（試験H）');

  {
    const sw = loadSw();
    const focusCalls = [];

    sw.setMatchAllResult([
      { url: 'https://meet.google.com/abc', focus: () => { focusCalls.push('abc'); return Promise.resolve(); } },
      { url: 'https://example.com/other', focus: () => { focusCalls.push('other'); return Promise.resolve(); } },
    ]);

    await sw.fire('notificationclick', {
      notification: { data: { url: 'https://meet.google.com/abc' }, close: () => {} },
    });

    check('一致する窓の focus だけが呼ばれる', focusCalls.length === 1 && focusCalls[0] === 'abc', JSON.stringify(focusCalls));
    check('★他の URL は開かれない・openWindow も呼ばれない', sw.opened.length === 0);
  }

  /* ================================================================ */
  section('notificationclick: 通知を閉じる・不正な URL は scope へ');

  {
    const sw = loadSw();
    let closed = false;

    sw.setMatchAllResult([]);

    await sw.fire('notificationclick', {
      notification: { data: { url: 'javascript:alert(1)' }, close: () => { closed = true; } },
    });

    check('close() が呼ばれる', closed === true);
    check('不正な URL は scope を開く', sw.opened[0] === SCOPE, sw.opened[0]);
  }

  {
    const sw = loadSw();

    sw.setMatchAllResult([]);

    await sw.fire('notificationclick', {
      notification: { data: null, close: () => {} },
    });

    check('data が無ければ scope を開く', sw.opened[0] === SCOPE, sw.opened[0]);
  }

  /* ================================================================ */
  section('pushsubscriptionchange: 再購読して api/subscriptions へ送る（§8-6）');

  {
    const calls = [];
    const sw = loadSw({
      fetchImpl(url, init) {
        calls.push({ url: String(url), init });

        if (String(url).includes('api/me')) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, vapidPublicKey: 'AAAA' }) });
        }

        return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
      },
    });

    await sw.fire('pushsubscriptionchange', {});

    check('api/me を scope からの相対で呼ぶ',
      calls.some((c) => c.url === 'https://tsam-ai.com/push-assistant/api/me'), JSON.stringify(calls.map((c) => c.url)));
    check('api/subscriptions へ POST する',
      calls.some((c) => c.url === 'https://tsam-ai.com/push-assistant/api/subscriptions' && c.init?.method === 'POST'));
    check('本文に subscription を含める',
      JSON.parse(calls.find((c) => c.url.includes('api/subscriptions'))?.init?.body ?? '{}').subscription?.endpoint
        === 'https://example.test/ep');
  }

  section('pushsubscriptionchange: api/me が失敗しても例外にならない');

  {
    const sw = loadSw({
      fetchImpl: () => Promise.resolve({ ok: false, json: () => Promise.resolve({}) }),
    });

    let threw = false;

    try {
      await sw.fire('pushsubscriptionchange', {});
    } catch {
      threw = true;
    }

    check('例外にならない（catch で吸収する）', threw === false);
  }

  /* ================================================================ */
  section('install / activate（キャッシュを持たない・§8-6）');

  {
    const sw = loadSw();

    await sw.fire('install', {});
    check('skipWaiting が呼ばれる', sw.state.skipWaitingCalled === true);

    await sw.fire('activate', {});
    check('clients.claim が呼ばれる', sw.state.claimed === true);
  }

  finish();
} catch (error) {
  fatal(error);
}

/*
 * ゲート（notifier-gate）の**実際の応答**を取り出して、両側のテストで共用する。
 *
 * ==================================================================
 * なぜ必要か
 * ==================================================================
 * ゲートは Cloudflare Workers、テンプレートは Apps Script で、別々に動く。
 * 応答の形は**2か所で別々に書かれている**（Workers の `ok()` と、
 * Gate.gs の取り出し）。片方だけ変えても、どちらのテストも通ってしまう。
 *
 * 同じ組み合わせで Phase 2 に事故が起きている。gas-auth は
 * `{success:true, data}` を返すのに、Workers 側は `{ok:true, data}` を
 * 見ていた。**両方のテストが緑のまま、本番だけが動かなかった。**
 *
 * そこで、**本物の Worker を走らせて得た応答**をフィクスチャにし、
 * それを GAS 側のテストへそのまま流す。どちらかの形が変われば、
 * もう片方のテストが落ちる。
 * ==================================================================
 *
 * ここで作る鍵は毎回その場で生成する。リポジトリにも環境変数にも置かない。
 */

import worker from '../../workers/notifier-gate/src/index.mjs';
import { hashLicenseKey, licenseCacheKey } from '../../workers/notifier-gate/src/license.mjs';

export const FIXTURE_LICENSE_KEY = `LK${'x'.repeat(41)}`;
export const FIXTURE_ORIGIN = 'https://notifier-gate.potenitas-lp.workers.dev';

/** GAS の primeVapid_ が実際に送る宛先。 */
export const FIXTURE_AUDIENCES = [
  'https://fcm.googleapis.com',
  'https://updates.push.services.mozilla.com',
  'https://web.push.apple.com',
];

function createKv() {
  const store = new Map();

  return {
    async get(key) { return store.get(key) ?? null; },
    async put(key, value) { store.set(key, value); },
  };
}

/**
 * 本物の Worker を走らせて、各エンドポイントの応答をそのまま取り出す。
 *
 * ライセンスは KV へ active を直接置く（認証系 GAS を呼ばせないため）。
 * 戻り値は「HTTPの状態」と「本文（パース済み）」の組。
 */
export async function captureGateResponses({ events = [], sentDigest = [] } = {}) {
  const kv = createKv();
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);

  const env = {
    LICENSE_CACHE: kv,
    VAPID_PRIVATE_KEY: Buffer.from(await crypto.subtle.exportKey('pkcs8', pair.privateKey)).toString('base64'),
    VAPID_PUBLIC_KEY: Buffer.from(await crypto.subtle.exportKey('raw', pair.publicKey)).toString('base64url'),
    VAPID_SUBJECT: 'https://tsam-ai.com/production-app/voice-recorder/',
    ALLOWED_ORIGINS: 'https://tsam-ai.com',
    AUTH_GAS_URL: 'https://example.invalid/exec',
    AUTH_GAS_SHARED_SECRET: 'shared-secret-for-fixture-0123456789',
  };

  await kv.put(
    licenseCacheKey(await hashLicenseKey(FIXTURE_LICENSE_KEY)),
    JSON.stringify({
      v: 1, state: 'active', plan: 'basic', checkedAt: Date.now(), activeConfirmedAt: Date.now(),
    }),
  );

  async function call(path, body) {
    const response = await worker.fetch(
      new Request(FIXTURE_ORIGIN + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ licenseKey: FIXTURE_LICENSE_KEY, ...body }),
      }),
      env,
    );

    return { status: response.status, body: await response.json() };
  }

  const health = await worker.fetch(new Request(`${FIXTURE_ORIGIN}/v1/health`), env);

  return {
    env,
    vapid: await call('/v1/vapid', { audiences: FIXTURE_AUDIENCES }),
    evaluate: await call('/v1/evaluate', {
      settings: {
        accepted: true, tentative: true, needsAction: true, declined: false, timedOnly: true, timingMin: 5,
      },
      events,
      sentDigest,
    }),
    testNotify: await call('/v1/test-notify', {}),
    health: { status: health.status, body: await health.json() },
  };
}

/**
 * 取り出した応答を、そのまま GAS の UrlFetchApp へ返す偽物にする。
 *
 * **本文を書き換えない。** ここで整形すると、二重定義のずれを
 * 見張るという目的が消える。
 */
export function installCapturedGateStub(env, fixtures) {
  const calls = [];

  env.onFetch((url, options) => {
    if (String(url).indexOf(FIXTURE_ORIGIN) !== 0) {
      return null;
    }

    const path = String(url).slice(FIXTURE_ORIGIN.length);

    calls.push({ path, body: JSON.parse(options.payload) });

    if (path === '/v1/vapid') {
      return { status: fixtures.vapid.status, body: fixtures.vapid.body };
    }

    if (path === '/v1/evaluate') {
      return { status: fixtures.evaluate.status, body: fixtures.evaluate.body };
    }

    if (path === '/v1/test-notify') {
      return { status: fixtures.testNotify.status, body: fixtures.testNotify.body };
    }

    return { status: 404, body: { ok: false, error: { code: 'INVALID_ACTION', message: '' } } };
  });

  return calls;
}

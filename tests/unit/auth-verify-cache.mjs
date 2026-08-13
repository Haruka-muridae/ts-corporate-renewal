/*
 * セッション検証の代理 Worker（workers/auth-verify/）。
 *
 * ==================================================================
 * ここで固定するもの
 * ==================================================================
 *   1. キャッシュ命中で GAS を叩かないこと（速さの根拠）
 *   2. 期限が切れたら必ず GAS へ問い合わせること
 *      （stale-while-revalidate を採らない ＝ 失効反映が最大 TTL で済む）
 *   3. **判定できないときに「無効」と答えないこと**
 *      ここが崩れると、GAS の障害のたびに全利用者のトークンが消える
 *   4. 応答の形が gas-auth と一致すること（宛先差し替えだけで済む根拠）
 *   5. 生のセッショントークンが KV のキーにも値にも現れないこと
 *
 * Workers ランタイムも Chrome も要らない。src/*.mjs は WebCrypto と
 * fetch/Request/Response しか使っておらず、Node 22 にどちらもある。
 * 実時間も実通信も使わない（now と fetchImpl を差し替える）。
 * ==================================================================
 */

import { check, section, finish, fatal } from '../../public/apps/tests/helpers/assert.mjs';

try {
  const base = '../../workers/auth-verify/src';

  const { FRESH_MS, GRACE_MS, NEGATIVE_MS } = await import(`${base}/constants.mjs`);
  const { OUTCOME, askGas, isAcceptableToken, verifySession } = await import(`${base}/verify.mjs`);
  const { cacheKey, tokenHash } = await import(`${base}/cache.mjs`);
  const worker = (await import(`${base}/index.mjs`)).default;

  const TOKEN = 'session-token-for-test-0123456789';
  const GAS_URL = 'https://script.google.com/macros/s/dummy/exec';

  const USER = { userId: 'usr_1', email: 'someone@example.com', role: 'member' };

  /* 偽の KV。put/get だけあればよい。 */
  function fakeKv() {
    const store = new Map();

    return {
      store,
      async get(key) { return store.has(key) ? store.get(key) : null; },
      async put(key, value) { store.set(key, String(value)); },
    };
  }

  /* 偽の fetch。呼ばれた回数を数える。 */
  function fakeFetch(handler) {
    const state = { calls: 0 };

    const impl = async (...args) => {
      state.calls += 1;
      return handler(...args);
    };

    impl.state = state;
    return impl;
  }

  const okResponse = (data) => ({
    ok: true,
    async json() { return { success: true, data }; },
  });

  const invalidResponse = () => ({
    ok: true,
    async json() { return { success: false, error: { code: 'SESSION_INVALID', message: '切れました' } }; },
  });

  const validData = { user: USER, expiresAt: new Date(Date.now() + 12 * 3600_000).toISOString(), remember: false };

  /* ================================================================ */
  section('トークンの足切り');

  check('空文字は受け付けない', isAcceptableToken('') === false);
  check('空白だけは受け付けない', isAcceptableToken('   ') === false);
  check('257文字は受け付けない', isAcceptableToken('a'.repeat(257)) === false);
  check('256文字は受け付ける', isAcceptableToken('a'.repeat(256)) === true);

  {
    const fetchImpl = fakeFetch(async () => okResponse(validData));
    const result = await verifySession('', { kv: fakeKv(), gasUrl: GAS_URL, fetchImpl });

    check('★形が不正なら GAS を叩かずに落とす',
      result.outcome === OUTCOME.INVALID && fetchImpl.state.calls === 0);
  }

  /* ================================================================ */
  section('キャッシュの命中と再検証');

  {
    const kv = fakeKv();
    const now = 1_000_000_000_000;
    const fetchImpl = fakeFetch(async () => okResponse({
      user: USER,
      expiresAt: new Date(now + 12 * 3600_000).toISOString(),
      remember: false,
    }));

    const first = await verifySession(TOKEN, { kv, gasUrl: GAS_URL, now, fetchImpl });
    check('初回は GAS へ照会して有効を返す',
      first.outcome === OUTCOME.VALID && first.source === 'origin' && fetchImpl.state.calls === 1);

    const second = await verifySession(TOKEN, { kv, gasUrl: GAS_URL, now: now + 60_000, fetchImpl });
    check('★TTL 内の2回目は GAS を叩かない',
      second.outcome === OUTCOME.VALID && second.source === 'cache' && fetchImpl.state.calls === 1);

    const third = await verifySession(TOKEN, { kv, gasUrl: GAS_URL, now: now + FRESH_MS + 1, fetchImpl });
    check('★TTL 経過後は必ず GAS へ問い合わせる（stale を返さない）',
      third.outcome === OUTCOME.VALID && third.source === 'origin' && fetchImpl.state.calls === 2);
  }

  /* ================================================================ */
  section('セッション自身の期限');

  {
    const kv = fakeKv();
    const now = 1_000_000_000_000;
    /* 残り 5 分しかないセッション。TTL（30分）より短い。 */
    const fetchImpl = fakeFetch(async () => okResponse({
      user: USER,
      expiresAt: new Date(now + 5 * 60_000).toISOString(),
      remember: false,
    }));

    await verifySession(TOKEN, { kv, gasUrl: GAS_URL, now, fetchImpl });

    const after = await verifySession(TOKEN, { kv, gasUrl: GAS_URL, now: now + 6 * 60_000, fetchImpl });

    check('★キャッシュが新しくても、セッションの期限が来たら無効',
      after.outcome === OUTCOME.INVALID && after.source === 'expired' && fetchImpl.state.calls === 1);
  }

  /* ================================================================ */
  section('無効の短期記憶');

  {
    const kv = fakeKv();
    const now = 1_000_000_000_000;
    const fetchImpl = fakeFetch(async () => invalidResponse());

    const first = await verifySession(TOKEN, { kv, gasUrl: GAS_URL, now, fetchImpl });
    check('GAS が無効と答えたら無効', first.outcome === OUTCOME.INVALID);

    const second = await verifySession(TOKEN, { kv, gasUrl: GAS_URL, now: now + 1_000, fetchImpl });
    check('★無効も短時間は覚える（GAS の増幅器にしない）',
      second.outcome === OUTCOME.INVALID && second.source === 'cache-negative' && fetchImpl.state.calls === 1);

    const third = await verifySession(TOKEN, { kv, gasUrl: GAS_URL, now: now + NEGATIVE_MS + 1, fetchImpl });
    check('短期記憶が切れたら問い合わせ直す', fetchImpl.state.calls === 2 && third.outcome === OUTCOME.INVALID);
  }

  /* ================================================================ */
  section('★判定できないときに「無効」と答えない');

  /*
   * ここが最重要。フロントは invalid を受け取るとトークンを消す。
   * GAS の障害・応答形の異常・設定漏れで invalid を返すと、
   * 障害のたびに全利用者が強制ログアウトになる。
   */

  {
    const fetchImpl = fakeFetch(async () => { throw new TypeError('failed to fetch'); });
    const result = await verifySession(TOKEN, { kv: fakeKv(), gasUrl: GAS_URL, fetchImpl });

    check('★GAS へ届かず、キャッシュも無いときは unavailable（invalid ではない）',
      result.outcome === OUTCOME.UNAVAILABLE);
  }

  {
    const fetchImpl = fakeFetch(async () => ({ ok: false, status: 500, async json() { return {}; } }));
    const result = await verifySession(TOKEN, { kv: fakeKv(), gasUrl: GAS_URL, fetchImpl });

    check('★GAS が 5xx でも unavailable', result.outcome === OUTCOME.UNAVAILABLE);
  }

  {
    /* GAS は実行時エラーで HTML を返すことがある。無効と読み違えない。 */
    const fetchImpl = fakeFetch(async () => ({
      ok: true,
      async json() { throw new SyntaxError('Unexpected token <'); },
    }));
    const result = await verifySession(TOKEN, { kv: fakeKv(), gasUrl: GAS_URL, fetchImpl });

    check('★JSON でない応答を「無効」と解釈しない', result.outcome === OUTCOME.UNAVAILABLE);
  }

  {
    const fetchImpl = fakeFetch(async () => ({
      ok: true,
      async json() { return { success: false, error: { code: 'SERVER_ERROR', message: 'x' } }; },
    }));
    const result = await verifySession(TOKEN, { kv: fakeKv(), gasUrl: GAS_URL, fetchImpl });

    check('★SESSION_INVALID 以外の失敗コードは unavailable', result.outcome === OUTCOME.UNAVAILABLE);
  }

  {
    const result = await askGas(TOKEN, { gasUrl: '' });
    check('★GAS の URL が未設定でも unavailable（invalid ではない）',
      result.outcome === OUTCOME.UNAVAILABLE && result.reason === 'not_configured');
  }

  /* ================================================================ */
  section('GAS 不通時の継続（grace）');

  {
    const kv = fakeKv();
    const now = 1_000_000_000_000;
    let down = false;

    const fetchImpl = fakeFetch(async () => {
      if (down) {
        throw new TypeError('failed to fetch');
      }

      return okResponse({
        user: USER,
        expiresAt: new Date(now + 30 * 24 * 3600_000).toISOString(),
        remember: true,
      });
    });

    await verifySession(TOKEN, { kv, gasUrl: GAS_URL, now, fetchImpl });
    down = true;

    const inGrace = await verifySession(TOKEN, {
      kv, gasUrl: GAS_URL, now: now + FRESH_MS + 1, fetchImpl,
    });
    check('★GAS 不通でも grace 内なら通し続ける',
      inGrace.outcome === OUTCOME.VALID && inGrace.source === 'grace');

    const afterGrace = await verifySession(TOKEN, {
      kv, gasUrl: GAS_URL, now: now + GRACE_MS + 1, fetchImpl,
    });
    check('★grace を過ぎたら通さないが、無効とも言わない',
      afterGrace.outcome === OUTCOME.UNAVAILABLE);
  }

  /* ================================================================ */
  section('KV が使えなくても動く');

  {
    const fetchImpl = fakeFetch(async () => okResponse(validData));
    const result = await verifySession(TOKEN, { kv: null, gasUrl: GAS_URL, fetchImpl });

    check('KV 無しでも GAS 直行で成立する（遅くなるだけ）',
      result.outcome === OUTCOME.VALID && result.source === 'origin');
  }

  {
    const broken = {
      async get() { throw new Error('kv down'); },
      async put() { throw new Error('kv down'); },
    };
    const fetchImpl = fakeFetch(async () => okResponse(validData));
    const result = await verifySession(TOKEN, { kv: broken, gasUrl: GAS_URL, fetchImpl });

    check('KV が例外を投げても検証は成立する', result.outcome === OUTCOME.VALID);
  }

  /* ================================================================ */
  section('★生のトークンを KV へ残さない');

  {
    const kv = fakeKv();
    const fetchImpl = fakeFetch(async () => okResponse(validData));

    await verifySession(TOKEN, { kv, gasUrl: GAS_URL, fetchImpl });

    const keys = [...kv.store.keys()];
    const values = [...kv.store.values()];

    check('KV に記録が作られている', keys.length === 1);
    check('★キー名に生トークンが現れない', keys.every((key) => !key.includes(TOKEN)));
    check('★値に生トークンが現れない', values.every((value) => !value.includes(TOKEN)));

    const expected = cacheKey(await tokenHash(TOKEN));
    check('キーはトークンの SHA-256 から作る', keys[0] === expected);
  }

  /* ================================================================ */
  section('応答の形が gas-auth と一致する');

  /*
   * public/auth/api.js の readResult は payload.success と payload.data
   * しか見ない。宛先を差し替えるだけで済むことを、ここで機械的に固定する。
   */

  const callWorker = async (body, env) => worker.fetch(
    new Request('https://auth-verify.example/', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8', Origin: 'https://tsam-ai.com' },
      body: JSON.stringify(body),
    }),
    env,
  );

  {
    const env = {
      ALLOWED_ORIGINS: 'https://tsam-ai.com',
      AUTH_GAS_URL: GAS_URL,
      VERIFY_CACHE: fakeKv(),
    };

    globalThis.fetch = async () => okResponse(validData);

    const response = await callWorker({ action: 'verifySession', sessionToken: TOKEN }, env);
    const payload = await response.json();

    check('成功は 200', response.status === 200);
    check('★成功の形は { success: true, data: { user } }',
      payload.success === true && payload.data && payload.data.user.userId === 'usr_1');
    check('CORS が許可オリジンへ返る',
      response.headers.get('Access-Control-Allow-Origin') === 'https://tsam-ai.com');
    check('経路上にキャッシュさせない', response.headers.get('Cache-Control') === 'no-store');
  }

  {
    const env = {
      ALLOWED_ORIGINS: 'https://tsam-ai.com',
      AUTH_GAS_URL: GAS_URL,
      VERIFY_CACHE: fakeKv(),
    };

    globalThis.fetch = async () => invalidResponse();

    const response = await callWorker({ action: 'verifySession', sessionToken: TOKEN }, env);
    const payload = await response.json();

    check('★無効は 200 + SESSION_INVALID（フロントがトークンを消す経路）',
      response.status === 200 && payload.success === false
      && payload.error.code === 'SESSION_INVALID');
  }

  {
    const env = {
      ALLOWED_ORIGINS: 'https://tsam-ai.com',
      AUTH_GAS_URL: GAS_URL,
      VERIFY_CACHE: fakeKv(),
    };

    globalThis.fetch = async () => { throw new TypeError('failed to fetch'); };

    const response = await callWorker({ action: 'verifySession', sessionToken: TOKEN }, env);

    check('★判定できないときは 5xx（api.js が NETWORK として扱いトークンを残す）',
      response.status >= 500);
  }

  {
    const env = { ALLOWED_ORIGINS: 'https://tsam-ai.com', AUTH_GAS_URL: '' };
    const response = await callWorker({ action: 'verifySession', sessionToken: TOKEN }, env);
    const payload = await response.json();

    check('★設定漏れも 5xx。SESSION_INVALID にしない',
      response.status >= 500 && payload.error.code !== 'SESSION_INVALID');
  }

  {
    const env = { ALLOWED_ORIGINS: 'https://tsam-ai.com', AUTH_GAS_URL: GAS_URL };
    const response = await callWorker({ action: 'login', email: 'a@example.com' }, env);
    const payload = await response.json();

    check('検証以外の操作は受け付けない', payload.error.code === 'INVALID_ACTION');
  }

  {
    const env = { ALLOWED_ORIGINS: 'https://tsam-ai.com', AUTH_GAS_URL: GAS_URL };
    const response = await worker.fetch(
      new Request('https://auth-verify.example/', { method: 'GET' }),
      env,
    );

    check('GET は受け付けない', response.status === 405);
  }

  {
    const env = { ALLOWED_ORIGINS: 'https://tsam-ai.com', AUTH_GAS_URL: GAS_URL };
    const response = await worker.fetch(
      new Request('https://auth-verify.example/', {
        method: 'OPTIONS',
        headers: { Origin: 'https://evil.example' },
      }),
      env,
    );

    check('許可していないオリジンへ CORS を返さない',
      response.headers.get('Access-Control-Allow-Origin') === null);
  }

  finish();
} catch (error) {
  fatal(error);
}

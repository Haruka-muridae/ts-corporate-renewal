/*
 * Stripe Webhook 中継（workers/stripe-relay/）。
 *
 * ==================================================================
 * ここで固定するもの
 * ==================================================================
 *   1. 署名検証（合格・不一致・形式不正・許容時間・複数 v1）
 *   2. 設定不足なら 503 で止まり、GAS を呼ばない
 *   3. 既定（async）では **GAS の応答を待たずに 200** を返し、転送は後で行う
 *   4. sync では GAS の結果を待ち、失敗なら 500（Stripe に再送させる）
 *   5. GAS の 302 を追う指定になっている（redirect: 'follow'）
 *   6. 許可していない種別は GAS へ運ばない
 *   7. 応答・ログ・転送先 URL 以外に合言葉と署名シークレットが出ない
 *
 * Workers ランタイムも Chrome も要らない。WebCrypto と fetch/Request/Response
 * だけを使っており、Node 22 にどちらもある。
 * ==================================================================
 */

import { check, section, finish, fatal } from '../../public/apps/tests/helpers/assert.mjs';

import {
  computeSignature,
  parseSignatureHeader,
  timingSafeEqualHex,
  verifyStripeSignature,
} from '../../workers/stripe-relay/src/signature.mjs';
import {
  MAX_BODY_BYTES,
  allowedEventTypes,
  buildGasUrl,
  handleRequest,
  missingConfig,
  peekEvent,
} from '../../workers/stripe-relay/src/index.mjs';

const WEBHOOK_SECRET = 'whsec_test_relay_secret_0000000000';
const URL_KEY = 'url-key-for-relay-testing-0123456789';
const GAS_URL = 'https://script.google.com/macros/s/DEPLOYMENT_ID_FOR_TEST/exec';
const NOW_MS = Date.UTC(2026, 7, 20, 12, 0, 0);

function baseEnv(overrides = {}) {
  return {
    GAS_URL,
    GAS_URL_KEY: URL_KEY,
    STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
    ALLOWED_EVENT_TYPES: 'checkout.session.completed,invoice.paid',
    RELAY_MODE: 'async',
    ...overrides,
  };
}

function eventBody(id = 'evt_relay_1', type = 'checkout.session.completed') {
  return JSON.stringify({ id, type, data: { object: { id: 'cs_1' } } });
}

async function signedHeader(body, { secret = WEBHOOK_SECRET, nowMs = NOW_MS } = {}) {
  const timestamp = Math.floor(nowMs / 1000);
  const signature = await computeSignature(secret, timestamp, body);
  return `t=${timestamp},v1=${signature}`;
}

function makeRequest(body, header, { method = 'POST', path = '/' } = {}) {
  const headers = { 'Content-Type': 'application/json' };

  if (header !== null) {
    headers['Stripe-Signature'] = header;
  }

  return new Request(`https://stripe-relay.example.workers.dev${path}`, {
    method,
    headers,
    body: method === 'POST' ? body : undefined,
  });
}

/* GAS の偽物。呼ばれた URL と本文を記録し、任意の応答を返す。 */
function fakeGas({ status = 200, body = { success: true, data: { received: true, status: 'processed' } }, delayMs = 0, throwError = null } = {}) {
  const calls = [];

  const fetchImpl = async (url, options) => {
    calls.push({ url, options });

    if (throwError) {
      throw throwError;
    }

    if (delayMs > 0) {
      await new Promise((resolvePromise) => { setTimeout(resolvePromise, delayMs); });
    }

    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  };

  return { calls, fetchImpl };
}

/* waitUntil に渡された Promise を集める偽の ctx。 */
function fakeCtx() {
  const pending = [];

  return {
    pending,
    waitUntil(promise) {
      pending.push(promise);
    },
  };
}

/* console の出力を捕まえる（秘密が出ていないことの確認用）。 */
function captureConsole() {
  const lines = [];
  const original = { log: console.log, error: console.error };

  console.log = (...args) => { lines.push(args.join(' ')); };
  console.error = (...args) => { lines.push(args.join(' ')); };

  return {
    lines,
    restore() {
      console.log = original.log;
      console.error = original.error;
    },
  };
}

try {
  /* ---------------------------------------------------------------- */
  section('署名ヘッダーの解釈');

  check(
    't と v1 を取り出せる',
    (() => {
      const parsed = parseSignatureHeader('t=1700000000,v1=abc,v0=def');
      return parsed && parsed.timestamp === 1700000000 && parsed.signatures.length === 1 && parsed.signatures[0] === 'abc';
    })(),
  );

  check(
    'v1 が複数あれば全部拾う（鍵の入れ替え期間）',
    parseSignatureHeader('t=1,v1=aa,v1=bb').signatures.length === 2,
  );

  check('空文字は null', parseSignatureHeader('') === null);
  check('t が無ければ null', parseSignatureHeader('v1=aa') === null);
  check('v1 が無ければ null', parseSignatureHeader('t=1') === null);
  check('t が数字でなければ null', parseSignatureHeader('t=abc,v1=aa') === null);

  check('定数時間比較: 一致', timingSafeEqualHex('abcd', 'abcd') === true);
  check('定数時間比較: 不一致', timingSafeEqualHex('abcd', 'abce') === false);
  check('定数時間比較: 長さ違い', timingSafeEqualHex('abcd', 'abc') === false);

  /* ---------------------------------------------------------------- */
  section('署名の検証');

  const body = eventBody();
  const goodHeader = await signedHeader(body);

  check(
    '正しい署名なら合格',
    (await verifyStripeSignature(body, goodHeader, WEBHOOK_SECRET, { nowMs: NOW_MS })).ok === true,
  );

  check(
    '本文が1文字でも違えば不合格',
    (await verifyStripeSignature(`${body} `, goodHeader, WEBHOOK_SECRET, { nowMs: NOW_MS })).ok === false,
  );

  check(
    '鍵が違えば不合格',
    (await verifyStripeSignature(body, goodHeader, 'whsec_other', { nowMs: NOW_MS })).ok === false,
  );

  check(
    '鍵が空なら不合格（理由 secret-missing）',
    (await verifyStripeSignature(body, goodHeader, '', { nowMs: NOW_MS })).reason === 'secret-missing',
  );

  check(
    '許容時間（300秒）を超えた署名は不合格',
    (await verifyStripeSignature(body, goodHeader, WEBHOOK_SECRET, { nowMs: NOW_MS + 301 * 1000 })).reason === 'timestamp-out-of-tolerance',
  );

  check(
    '許容時間内なら合格',
    (await verifyStripeSignature(body, goodHeader, WEBHOOK_SECRET, { nowMs: NOW_MS + 299 * 1000 })).ok === true,
  );

  check(
    '複数 v1 のうち1つが合えば合格',
    (await verifyStripeSignature(body, `${goodHeader.replace('v1=', `v1=${'0'.repeat(64)},v1=`)}`, WEBHOOK_SECRET, { nowMs: NOW_MS })).ok === true,
  );

  check(
    '署名が大文字でも合格（16進の大小を区別しない）',
    (await verifyStripeSignature(body, goodHeader.replace(/v1=([0-9a-f]+)/, (m, hex) => `v1=${hex.toUpperCase()}`), WEBHOOK_SECRET, { nowMs: NOW_MS })).ok === true,
  );

  /* ---------------------------------------------------------------- */
  section('設定と補助関数');

  check('設定が揃っていれば不足なし', missingConfig(baseEnv()).length === 0);
  check(
    '不足している名前を列挙する（値は含めない）',
    (() => {
      const missing = missingConfig({ GAS_URL });
      return missing.length === 2 && missing.includes('GAS_URL_KEY') && missing.includes('STRIPE_WEBHOOK_SECRET');
    })(),
  );

  check(
    '許可種別はカンマ区切りで読む',
    allowedEventTypes({ ALLOWED_EVENT_TYPES: ' a.b , c.d ,' }).join('|') === 'a.b|c.d',
  );
  check('許可種別が空なら制限しない', allowedEventTypes({}).length === 0);

  check('本文から id と type を読む', (() => {
    const info = peekEvent(eventBody('evt_x', 'invoice.paid'));
    return info && info.id === 'evt_x' && info.type === 'invoice.paid';
  })());
  check('id の形式が不正なら null', peekEvent(JSON.stringify({ id: '../x', type: 'a' })) === null);
  check('JSON でなければ null', peekEvent('not json') === null);

  check(
    '転送先 URL に path・k・sig が付く',
    (() => {
      const url = new URL(buildGasUrl(baseEnv(), 't=1,v1=aa'));
      return url.origin + url.pathname === GAS_URL
        && url.searchParams.get('path') === 'stripe-webhook'
        && url.searchParams.get('k') === URL_KEY
        && url.searchParams.get('sig') === 't=1,v1=aa';
    })(),
  );

  /* ---------------------------------------------------------------- */
  section('要求の処理: 受け付けない場合');

  {
    const gas = fakeGas();
    const res = await handleRequest(makeRequest(body, goodHeader, { method: 'GET', path: '/' }), baseEnv(), fakeCtx(), { fetchImpl: gas.fetchImpl, nowMs: NOW_MS });
    check('GET は 405', res.status === 405);
    check('GET では GAS を呼ばない', gas.calls.length === 0);
  }

  {
    const gas = fakeGas();
    const res = await handleRequest(makeRequest(body, goodHeader), baseEnv({ STRIPE_WEBHOOK_SECRET: '' }), fakeCtx(), { fetchImpl: gas.fetchImpl, nowMs: NOW_MS });
    check('設定不足は 503', res.status === 503);
    check('設定不足では GAS を呼ばない', gas.calls.length === 0);
  }

  {
    const gas = fakeGas();
    const res = await handleRequest(makeRequest(body, null), baseEnv(), fakeCtx(), { fetchImpl: gas.fetchImpl, nowMs: NOW_MS });
    check('署名ヘッダーが無ければ 400', res.status === 400);
    check('署名が無ければ GAS を呼ばない', gas.calls.length === 0);
  }

  {
    const gas = fakeGas();
    const badHeader = `t=${Math.floor(NOW_MS / 1000)},v1=${'0'.repeat(64)}`;
    const res = await handleRequest(makeRequest(body, badHeader), baseEnv(), fakeCtx(), { fetchImpl: gas.fetchImpl, nowMs: NOW_MS });
    check('署名が不正なら 400', res.status === 400);
    check('不正な署名では GAS を呼ばない', gas.calls.length === 0);
  }

  {
    const gas = fakeGas();
    const big = JSON.stringify({ id: 'evt_big', type: 'invoice.paid', pad: 'x'.repeat(MAX_BODY_BYTES) });
    const res = await handleRequest(makeRequest(big, await signedHeader(big)), baseEnv(), fakeCtx(), { fetchImpl: gas.fetchImpl, nowMs: NOW_MS });
    check('大きすぎる本文は 413', res.status === 413);
    check('大きすぎる本文では GAS を呼ばない', gas.calls.length === 0);
  }

  {
    const gas = fakeGas();
    const broken = 'not json';
    const res = await handleRequest(makeRequest(broken, await signedHeader(broken)), baseEnv(), fakeCtx(), { fetchImpl: gas.fetchImpl, nowMs: NOW_MS });
    check('署名は正しいが本文が壊れていれば 400', res.status === 400);
    check('壊れた本文では GAS を呼ばない', gas.calls.length === 0);
  }

  {
    const gas = fakeGas();
    const other = eventBody('evt_other', 'payment_intent.succeeded');
    const res = await handleRequest(makeRequest(other, await signedHeader(other)), baseEnv(), fakeCtx(), { fetchImpl: gas.fetchImpl, nowMs: NOW_MS });
    const json = await res.json();
    check('許可していない種別でも Stripe には 200', res.status === 200);
    check('許可していない種別は転送しない', json.relayed === false && gas.calls.length === 0);
  }

  {
    const gas = fakeGas();
    const other = eventBody('evt_other2', 'payment_intent.succeeded');
    const ctx = fakeCtx();
    await handleRequest(makeRequest(other, await signedHeader(other)), baseEnv({ ALLOWED_EVENT_TYPES: '' }), ctx, { fetchImpl: gas.fetchImpl, nowMs: NOW_MS });
    await Promise.all(ctx.pending);
    check('許可種別が空なら全部転送する', gas.calls.length === 1);
  }

  /* ---------------------------------------------------------------- */
  section('要求の処理: async（既定）は先に 200 を返す');

  {
    /* GAS が 5 秒かかっても、応答はそれを待たない。 */
    const gas = fakeGas({ delayMs: 5000 });
    const ctx = fakeCtx();
    const started = Date.now();
    const res = await handleRequest(makeRequest(body, goodHeader), baseEnv(), ctx, { fetchImpl: gas.fetchImpl, nowMs: NOW_MS });
    const elapsed = Date.now() - started;
    const json = await res.json();

    check('200 を返す', res.status === 200);
    check('received: true を返す', json.received === true && json.relayed === true);
    check('GAS の応答を待たずに返す（1秒未満）', elapsed < 1000, `${elapsed}ms`);
    check('転送は waitUntil に渡される', ctx.pending.length === 1);
    check('GAS の呼び出しは始まっている', gas.calls.length === 1);

    const call = gas.calls[0];
    const target = new URL(call.url);

    check('GAS へは POST', call.options.method === 'POST');
    check('本文をそのまま転送する', call.options.body === body);
    check('302 を追う指定（redirect: follow）', call.options.redirect === 'follow');
    check('合言葉を k に載せる', target.searchParams.get('k') === URL_KEY);
    check('署名ヘッダーを sig に載せる', target.searchParams.get('sig') === goodHeader);
    check('path=stripe-webhook を付ける', target.searchParams.get('path') === 'stripe-webhook');

    /* 後片付け（タイマーを残さない）。 */
    await Promise.all(ctx.pending);
  }

  {
    /* GAS が失敗を返しても、Stripe への 200 は変わらない（再送は不要。照会で守られている）。 */
    const gas = fakeGas({ body: { success: false, error: { code: 'INVALID_REQUEST', message: 'x' } } });
    const ctx = fakeCtx();
    const captured = captureConsole();
    let res;

    try {
      res = await handleRequest(makeRequest(body, goodHeader), baseEnv(), ctx, { fetchImpl: gas.fetchImpl, nowMs: NOW_MS });
      await Promise.all(ctx.pending);
    } finally {
      captured.restore();
    }

    check('GAS が失敗しても async では 200', res.status === 200);
    check(
      'GAS の失敗はログに残る（イベント ID と理由）',
      captured.lines.some((line) => line.includes('evt_relay_1') && line.includes('INVALID_REQUEST')),
      captured.lines.join('\n'),
    );
    check(
      'ログに合言葉も署名シークレットも出ない',
      !captured.lines.join('\n').includes(URL_KEY) && !captured.lines.join('\n').includes(WEBHOOK_SECRET),
    );
  }

  {
    /* GAS に到達できなくても例外にならない。 */
    const gas = fakeGas({ throwError: new TypeError('fetch failed') });
    const ctx = fakeCtx();
    const captured = captureConsole();
    let res;

    try {
      res = await handleRequest(makeRequest(body, goodHeader), baseEnv(), ctx, { fetchImpl: gas.fetchImpl, nowMs: NOW_MS });
      await Promise.all(ctx.pending);
    } finally {
      captured.restore();
    }

    check('GAS に到達できなくても async では 200', res.status === 200);
    check(
      '到達不能はログに残る',
      captured.lines.some((line) => line.includes('gas-unreachable')),
    );
  }

  /* ---------------------------------------------------------------- */
  section('要求の処理: sync は GAS の結果を待つ');

  {
    const gas = fakeGas();
    const res = await handleRequest(makeRequest(body, goodHeader), baseEnv({ RELAY_MODE: 'sync' }), fakeCtx(), { fetchImpl: gas.fetchImpl, nowMs: NOW_MS });
    const json = await res.json();
    check('GAS 成功なら 200', res.status === 200 && json.gasOk === true);
  }

  {
    const gas = fakeGas({ body: { success: false, error: { code: 'SERVER_ERROR', message: 'x' } } });
    const captured = captureConsole();
    let res;

    try {
      res = await handleRequest(makeRequest(body, goodHeader), baseEnv({ RELAY_MODE: 'sync' }), fakeCtx(), { fetchImpl: gas.fetchImpl, nowMs: NOW_MS });
    } finally {
      captured.restore();
    }

    const json = await res.json();
    check('GAS 失敗なら 500（Stripe に再送させる）', res.status === 500 && json.gasOk === false);
    check('応答に理由コードだけを含める', json.reason === 'SERVER_ERROR');
  }

  {
    /* GAS が JSON でない HTML（認可エラー画面など）を返した場合。 */
    const gas = fakeGas({ status: 200, body: '<html>Authorization needed</html>' });
    const captured = captureConsole();
    let res;

    try {
      res = await handleRequest(makeRequest(body, goodHeader), baseEnv({ RELAY_MODE: 'sync' }), fakeCtx(), { fetchImpl: gas.fetchImpl, nowMs: NOW_MS });
    } finally {
      captured.restore();
    }

    check('GAS が JSON 以外を返せば失敗扱い', res.status === 500);
  }

  /* ---------------------------------------------------------------- */
  section('health');

  {
    const res = await handleRequest(makeRequest('', null, { method: 'GET', path: '/health' }), baseEnv(), fakeCtx(), { nowMs: NOW_MS });
    const json = await res.json();
    check('設定が揃っていれば 200', res.status === 200 && json.ok === true && json.missing.length === 0);
  }

  {
    const res = await handleRequest(makeRequest('', null, { method: 'GET', path: '/health' }), baseEnv({ GAS_URL_KEY: '' }), fakeCtx(), { nowMs: NOW_MS });
    const json = await res.json();
    const text = JSON.stringify(json);
    check('不足があれば 503 で名前を返す', res.status === 503 && json.missing.includes('GAS_URL_KEY'));
    check('health の応答に秘密の値は無い', !text.includes(WEBHOOK_SECRET) && !text.includes(URL_KEY));
  }

  /* ---------------------------------------------------------------- */
  section('秘密情報の漏れがないこと');

  {
    const gas = fakeGas({ body: { success: false, error: { code: 'INVALID_REQUEST', message: 'x' } } });
    const responses = [];

    for (const env of [baseEnv(), baseEnv({ RELAY_MODE: 'sync' })]) {
      const ctx = fakeCtx();
      const res = await handleRequest(makeRequest(body, goodHeader), env, ctx, { fetchImpl: gas.fetchImpl, nowMs: NOW_MS });
      responses.push(await res.text());
      await Promise.all(ctx.pending);
    }

    const badRes = await handleRequest(makeRequest(body, 't=1,v1=00'), baseEnv(), fakeCtx(), { fetchImpl: gas.fetchImpl, nowMs: NOW_MS });
    responses.push(await badRes.text());

    const all = responses.join('\n');
    check('どの応答にも合言葉が含まれない', !all.includes(URL_KEY));
    check('どの応答にも署名シークレットが含まれない', !all.includes(WEBHOOK_SECRET));
    check('どの応答にも GAS の URL が含まれない', !all.includes('script.google.com'));
  }

  finish();
} catch (error) {
  fatal(error);
}

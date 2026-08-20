/**
 * stripe-relay — Stripe Webhook を Apps Script（gas-auth）へ中継する薄い Worker。
 *
 * ==================================================================
 * なぜ必要か（2026-08-17 の配信失敗）
 * ==================================================================
 * Apps Script の Web アプリは POST に対して script.googleusercontent.com
 * への 302 を返す。Stripe はリダイレクトを追わず、3xx を「失敗」と数える
 * （公式: 「Webhook リクエストへのリダイレクト応答は失敗と見なされます」）。
 * そのため GAS の URL を Stripe に直接登録する構成（STRIPE_SETUP.md 構成A）
 * では、処理が成功していても配信はすべて失敗として記録され、
 * 連続失敗が続くとエンドポイントが無効化される。
 *
 * この Worker は Stripe と GAS の間に立ち、
 *   1. Stripe-Signature を検証する（GAS はヘッダーを受け取れないため）
 *   2. **Stripe へ即座に 200 を返す**
 *   3. 応答のあとで GAS へ転送する（302 はここで追う）
 * の3つだけを行う。本文は解釈も変更もしない。
 * ==================================================================
 *
 * ==================================================================
 * 先に 200 を返しても安全な理由
 * ==================================================================
 * GAS 側は受信本文を信用せず、event.id で Stripe API へ照会した結果だけを
 * 処理に使う（gas-auth/Webhook.gs）。冪等性も stripe_events シートで
 * 担保している。したがって中継が 200 を返したあとに GAS 側が失敗しても、
 * 不正な処理は起きない。失敗したイベントは Stripe ダッシュボードから
 * 「再送」するか、GAS の system_error_logs から追う。
 * 同期で GAS の結果を待ちたい場合は RELAY_MODE=sync にする（§設定）。
 * ==================================================================
 *
 * 設定（wrangler.jsonc の vars / secrets）:
 *   GAS_URL                 … Apps Script の /exec URL（var。秘密ではない）
 *   GAS_URL_KEY             … /exec?k= に付ける合言葉（secret）
 *   STRIPE_WEBHOOK_SECRET   … whsec_…（secret。この中継用エンドポイントのもの）
 *   ALLOWED_EVENT_TYPES     … 転送するイベント種別（var、カンマ区切り、空なら全部）
 *   RELAY_MODE              … async（既定）| sync
 */

import { verifyStripeSignature } from './signature.mjs';

export const RELAY_VERSION = '1.0.0';

/* 想定外に大きい本文は読まない（gas-auth/Main.gs の parsePostBody_ と同じ上限）。 */
export const MAX_BODY_BYTES = 100 * 1000;

/* GAS の応答待ちの上限。コールドスタート（実測 35 秒）を見込む。 */
const GAS_TIMEOUT_MS = 60 * 1000;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json;charset=UTF-8',
      'Cache-Control': 'no-store',
    },
  });
}

/** 設定の不足を列挙する。値は返さない。 */
export function missingConfig(env) {
  const missing = [];

  if (!env || typeof env.GAS_URL !== 'string' || env.GAS_URL.trim() === '') {
    missing.push('GAS_URL');
  }

  if (!env || typeof env.GAS_URL_KEY !== 'string' || env.GAS_URL_KEY.trim() === '') {
    missing.push('GAS_URL_KEY');
  }

  if (!env || typeof env.STRIPE_WEBHOOK_SECRET !== 'string' || env.STRIPE_WEBHOOK_SECRET.trim() === '') {
    missing.push('STRIPE_WEBHOOK_SECRET');
  }

  return missing;
}

/** 転送対象のイベント種別。空配列なら制限しない。 */
export function allowedEventTypes(env) {
  return String((env && env.ALLOWED_EVENT_TYPES) || '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value !== '');
}

/** 本文から id と type だけを読む。壊れていれば null。 */
export function peekEvent(rawBody) {
  try {
    const parsed = JSON.parse(rawBody);

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }

    const id = typeof parsed.id === 'string' ? parsed.id.trim() : '';
    const type = typeof parsed.type === 'string' ? parsed.type.trim() : '';

    if (!/^evt_[A-Za-z0-9_]+$/.test(id)) {
      return null;
    }

    return { id, type };
  } catch {
    return null;
  }
}

/** GAS へ送る URL を組み立てる。合言葉と署名はクエリに載せる（GAS の仕様）。 */
export function buildGasUrl(env, signatureHeader) {
  const target = new URL(env.GAS_URL);

  target.searchParams.set('path', 'stripe-webhook');
  target.searchParams.set('k', env.GAS_URL_KEY);
  target.searchParams.set('sig', signatureHeader);

  return target.toString();
}

/**
 * GAS へ転送し、結果を要約して返す。例外は投げない（waitUntil の中で使う）。
 * 戻り値にも、ログにも、URL（合言葉を含む）は出さない。
 */
export async function forwardToGas(env, rawBody, signatureHeader, { fetchImpl = fetch } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GAS_TIMEOUT_MS);

  try {
    const response = await fetchImpl(buildGasUrl(env, signatureHeader), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: rawBody,
      /* GAS の 302 はここで追う。Stripe には見せない。 */
      redirect: 'follow',
      signal: controller.signal,
    });

    const text = await response.text();
    let parsed = null;

    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }

    const gasOk = Boolean(parsed && parsed.success === true);
    const code = parsed && parsed.error && parsed.error.code ? String(parsed.error.code) : '';
    const status = parsed && parsed.data && parsed.data.status ? String(parsed.data.status) : '';

    return {
      ok: gasOk,
      httpStatus: response.status,
      gasStatus: status,
      errorCode: code,
      reason: gasOk ? '' : (code || `http-${response.status}`),
    };
  } catch (error) {
    const aborted = error && error.name === 'AbortError';

    return {
      ok: false,
      httpStatus: 0,
      gasStatus: '',
      errorCode: '',
      reason: aborted ? 'gas-timeout' : 'gas-unreachable',
    };
  } finally {
    clearTimeout(timer);
  }
}

function logForward(eventInfo, result) {
  /* イベント ID と種別は秘密ではない。本文・URL・鍵は書かない。 */
  const line = `[stripe-relay] ${eventInfo.id} ${eventInfo.type} -> `
    + (result.ok ? `ok (${result.gasStatus || 'processed'})` : `failed (${result.reason})`);

  if (result.ok) {
    console.log(line);
  } else {
    console.error(line);
  }
}

/**
 * 要求の処理本体。テストから直接呼べるよう、fetch と時刻を差し替え可能にしてある。
 */
export async function handleRequest(request, env, ctx, {
  fetchImpl = fetch,
  nowMs = Date.now(),
} = {}) {
  const url = new URL(request.url);

  if (request.method === 'GET' && url.pathname === '/health') {
    const missing = missingConfig(env);

    return json({
      ok: missing.length === 0,
      version: RELAY_VERSION,
      /* 名前だけ。値は返さない。 */
      missing,
    }, missing.length === 0 ? 200 : 503);
  }

  if (request.method !== 'POST') {
    return json({ ok: false, error: 'method-not-allowed' }, 405);
  }

  const missing = missingConfig(env);

  if (missing.length > 0) {
    console.error(`[stripe-relay] 設定が不足しています: ${missing.join(', ')}`);
    return json({ ok: false, error: 'not-configured' }, 503);
  }

  const signatureHeader = request.headers.get('stripe-signature') || '';
  const rawBody = await request.text();

  if (rawBody.length > MAX_BODY_BYTES) {
    return json({ ok: false, error: 'payload-too-large' }, 413);
  }

  const verdict = await verifyStripeSignature(rawBody, signatureHeader, env.STRIPE_WEBHOOK_SECRET, { nowMs });

  if (!verdict.ok) {
    console.error(`[stripe-relay] 署名検証に失敗しました: ${verdict.reason}`);
    return json({ ok: false, error: 'invalid-signature' }, 400);
  }

  const eventInfo = peekEvent(rawBody);

  if (!eventInfo) {
    return json({ ok: false, error: 'invalid-payload' }, 400);
  }

  /*
   * 購読していない種別が届いた場合（Stripe 側の設定漏れ等）は GAS まで
   * 運ばない。GAS 側も未対応種別は ignored として記録だけするが、
   * そのためにシートを開く往復は無駄なので、ここで止める。
   */
  const allowed = allowedEventTypes(env);

  if (allowed.length > 0 && allowed.indexOf(eventInfo.type) === -1) {
    console.log(`[stripe-relay] ${eventInfo.id} ${eventInfo.type} -> skipped (not allowed)`);
    return json({ received: true, relayed: false, reason: 'event-type-not-allowed' });
  }

  const forward = () => forwardToGas(env, rawBody, signatureHeader, { fetchImpl })
    .then((result) => {
      logForward(eventInfo, result);
      return result;
    });

  if (String(env.RELAY_MODE || '').toLowerCase() === 'sync') {
    const result = await forward();

    /*
     * 同期モードでも、GAS 側の「処理の失敗」は Stripe に 500 で伝える。
     * 署名・設定の問題ではなく、Stripe に再送させる価値があるため。
     */
    return json(
      { received: true, relayed: true, gasOk: result.ok, reason: result.reason },
      result.ok ? 200 : 500,
    );
  }

  /* 既定: Stripe には先に 200 を返し、GAS への転送は応答後に続ける。 */
  if (ctx && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(forward());
  } else {
    forward();
  }

  return json({ received: true, relayed: true });
}

export default {
  async fetch(request, env, ctx) {
    try {
      return await handleRequest(request, env, ctx);
    } catch (error) {
      console.error(`[stripe-relay] 想定外のエラー: ${error && error.message}`);
      return json({ ok: false, error: 'server-error' }, 500);
    }
  },
};

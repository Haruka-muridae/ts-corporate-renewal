/**
 * notifier-gate — カレンダー通知 V2 のライセンスゲート兼判定サーバー。
 *
 * ==================================================================
 * サイト配信の Worker とは別サービスである
 * ==================================================================
 * リポジトリ直下の wrangler.jsonc は tsam-ai.com（OpenNext / Next.js）の
 * ものであり、こちらは workers/notifier-gate/wrangler.jsonc を使う
 * **独立したサービス**。同居している系を片方の都合で変えないという
 * CLAUDE.md の境界規則をそのまま適用している。
 * ==================================================================
 *
 * ==================================================================
 * このサーバーが受け取ってよいもの / 受け取らないもの
 * ==================================================================
 * 受け取る: ライセンスキー、設定（出欠フィルタと通知タイミング）、
 *           予定の骨格（ハッシュ化済み ID・開始時刻・出欠・終日・削除済み）
 * 受け取らない: 予定名・説明・参加者・メールアドレス・カレンダー ID
 *
 * 後者は「送らないよう気をつける」ではなく、
 * evaluate.mjs の validateEvents が**許可した項目以外を含む要求を拒否する**
 * ことで守っている（要件 DR-03/04）。
 * ==================================================================
 *
 * エンドポイントの一覧は workers/notifier-gate/README.md §2。
 */

import {
  GATE_VERSION,
  DEFAULT_PUSH_HOSTS,
  LICENSE_STATE,
  MAX_EVENTS,
  RATE_LIMITS,
} from './constants.mjs';
import { ERRORS, corsHeaders, fail, ok } from './http.mjs';
import { collectSecrets, inPhase, logFailure } from './diagnostics.mjs';
import {
  evaluateEvents,
  validateEvents,
  validateSentDigest,
} from './evaluate.mjs';
import {
  hashLicenseKey,
  isLicenseKeyShaped,
  normalizeLicenseKey,
  resolveLicense,
} from './license.mjs';
import { consumeRateLimit } from './ratelimit.mjs';
import { importVapidPrivateKey, issueJwts, normalizeAudiences, normalizeBase64Url } from './vapid.mjs';

/* 想定外に大きい本文は読まない（gas-auth/Main.gs の parsePostBody_ と同じ考え）。 */
const MAX_BODY_BYTES = 256 * 1024;

/**
 * 読み込み済みの秘密鍵。
 *
 * isolate が使い回される間は importKey をやり直さない。要求ごとに
 * 読み直しても動くが、5分ごと × 利用者数の回数だけ無駄な処理になる。
 *
 * **シークレットの文字列も一緒に覚える。** 鍵だけを覚えると、
 * 鍵をローテーションしても生きている isolate が古い鍵で署名し続け、
 * 「新しい購読にだけ届かない」という追いにくい状態になる。
 */
let cachedPrivateKey = { secret: '', key: null };

const handler = {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }

    /*
     * 失敗をログへ書くとき、この要求のライセンスキーも伏せ字の対象にする。
     * catch から見えるようにここで持つ（値は使わない）。
     */
    let bodyLicenseKey = '';

    try {
      /*
       * health だけ GET を許す。運用者が curl で疎通を見るための窓であり、
       * ライセンスも本文も要らない（返すのは版だけ）。
       */
      if (url.pathname === '/v1/health') {
        return ok({ version: GATE_VERSION }, { request, env });
      }

      if (request.method !== 'POST') {
        return fail(ERRORS.INVALID_ACTION, { status: 405, request, env });
      }

      const body = await readJsonBody(request);

      if (!body) {
        return fail(ERRORS.INVALID_REQUEST, { request, env });
      }

      bodyLicenseKey = typeof body.licenseKey === 'string' ? body.licenseKey : '';

      if (url.pathname === '/v1/evaluate') {
        return await handleEvaluate(body, request, env);
      }

      if (url.pathname === '/v1/vapid') {
        return await handleVapid(body, request, env);
      }

      if (url.pathname === '/v1/test-notify') {
        return await handleTestNotify(body, request, env);
      }

      return fail(ERRORS.INVALID_ACTION, { status: 404, request, env });
    } catch (error) {
      /*
       * **応答には内部情報を出さない。ログには出す。**
       * 読む相手が違うため（diagnostics.mjs の冒頭）。
       * 秘密は logFailure が伏せる。
       */
      logFailure({
        path: url.pathname,
        error,
        secrets: collectSecrets(env, bodyLicenseKey),
      });

      return fail(ERRORS.SERVER_ERROR, { status: 500, request, env });
    }
  },
};

export default handler;

/** 本文を JSON として読む。読めなければ null。 */
async function readJsonBody(request) {
  const text = await request.text();

  if (text.length === 0 || text.length > MAX_BODY_BYTES) {
    return null;
  }

  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * ライセンスの入口。全エンドポイントで同じ順に通す。
 *
 * 順序（形の検査 → レート制限 → 検証）には理由がある。
 * レート制限を検証より**先**に置くことで、壊れたテンプレートが
 * 認証系 GAS を叩き続ける事態を Workers 側で止められる。
 */
async function gate({ body, env, scope, nowMs, request }) {
  const licenseKey = normalizeLicenseKey(body.licenseKey);

  if (!isLicenseKeyShaped(licenseKey)) {
    return { response: fail(ERRORS.UNAUTHORIZED, { status: 401, request, env }) };
  }

  const hash = await inPhase('hash-license', () => hashLicenseKey(licenseKey));
  const limit = RATE_LIMITS[scope];
  const rate = await inPhase('rate-limit', () => consumeRateLimit({
    kv: env.LICENSE_CACHE,
    scope,
    hash,
    limit: limit.limit,
    windowSec: limit.windowSec,
    nowMs,
  }));

  if (!rate.allowed) {
    return { response: fail(ERRORS.RATE_LIMITED, { status: 429, request, env }) };
  }

  const license = await inPhase('license-verify', () => resolveLicense({ licenseKey, env, nowMs }));

  return { license, hash };
}

/**
 * 判定（5分ごとに利用者の GAS から呼ばれる）。
 *
 * 期限切れのときは空の判定を返す（エラーにはしない）。GAS 側は
 * licenseState を見て画面表示を変えるだけでよく、通知は自然に止まる。
 */
async function handleEvaluate(body, request, env) {
  const nowMs = Date.now();
  const gated = await gate({ body, env, scope: 'evaluate', nowMs, request });

  if (gated.response) {
    return gated.response;
  }

  if (gated.license.state === LICENSE_STATE.EXPIRED) {
    return ok({ notify: [], remove: [], licenseState: LICENSE_STATE.EXPIRED }, { request, env });
  }

  const eventsCheck = validateEvents(body.events);

  if (!eventsCheck.ok) {
    return fail(['INVALID_REQUEST', eventsCheck.message], { request, env });
  }

  if (body.events.length > MAX_EVENTS) {
    return fail(['INVALID_REQUEST', '予定の件数が多すぎます。'], { request, env });
  }

  const digestCheck = validateSentDigest(body.sentDigest);

  if (!digestCheck.ok) {
    return fail(['INVALID_REQUEST', digestCheck.message], { request, env });
  }

  const result = evaluateEvents({
    settings: body.settings,
    events: body.events,
    sentDigest: body.sentDigest,
    nowMs,
  });

  return ok({
    notify: result.notify,
    /* 表に出すのは eid だけ。除外の理由は運営側の判断材料であって、応答には要らない。 */
    remove: result.remove.map((entry) => entry.eid),
    licenseState: gated.license.state,
  }, { request, env });
}

/**
 * VAPID の公開鍵と JWT（24時間に1回程度、利用者の GAS から呼ばれる）。
 *
 * **期限切れには発行しない。** ここが「解約したら push を送れなくなる」
 * 仕組みの実体である（判定だけ止めても、テンプレートを改造すれば
 * 自前の判定で送れてしまうため、署名の側でも止める）。
 */
async function handleVapid(body, request, env) {
  const nowMs = Date.now();
  const gated = await gate({ body, env, scope: 'vapid', nowMs, request });

  if (gated.response) {
    return gated.response;
  }

  if (gated.license.state === LICENSE_STATE.EXPIRED) {
    return fail(ERRORS.LICENSE_EXPIRED, { status: 402, request, env });
  }

  /* 素の base64 で登録されていても直して返す（vapid.mjs の normalizeBase64Url）。 */
  const publicKey = normalizeBase64Url(env.VAPID_PUBLIC_KEY);
  const subject = String(env.VAPID_SUBJECT || '').trim();

  if (publicKey === '' || subject === '' || String(env.VAPID_PRIVATE_KEY || '').trim() === '') {
    return fail(ERRORS.NOT_CONFIGURED, { status: 500, request, env });
  }

  const hosts = pushHosts(env);
  const audiences = normalizeAudiences(body.audiences, hosts);

  if (!audiences.ok) {
    return fail(['INVALID_REQUEST', audiences.message], { request, env });
  }

  const secret = String(env.VAPID_PRIVATE_KEY);

  /*
   * 段階を分けておく。実機では「/v1/vapid が 500」としか分からず、
   * 鍵の読み込みで落ちたのか署名で落ちたのかを切り分けられなかった。
   */
  if (cachedPrivateKey.secret !== secret) {
    cachedPrivateKey = {
      secret,
      key: await inPhase('import-key', () => importVapidPrivateKey(secret)),
    };
  }

  const issued = await inPhase('sign', () => issueJwts({
    privateKey: cachedPrivateKey.key,
    audiences: audiences.list,
    subject,
    nowMs,
  }));

  return ok({
    publicKey,
    jwts: issued.jwts,
    expiresAt: issued.expiresAt,
    licenseState: gated.license.state,
  }, { request, env });
}

/**
 * テスト通知の許可判定（利用者が設定画面のボタンを押したとき）。
 *
 * 実際の push を送るのは利用者の GAS（購読を持っているのはそちら）。
 * ここは「送ってよいか」だけを答える。1日1回に制限しているのは、
 * ボタン連打で自分の端末へ通知が積み上がるのを防ぐため。
 */
async function handleTestNotify(body, request, env) {
  const nowMs = Date.now();
  const gated = await gate({ body, env, scope: 'testNotify', nowMs, request });

  if (gated.response) {
    return gated.response;
  }

  if (gated.license.state === LICENSE_STATE.EXPIRED) {
    return fail(ERRORS.LICENSE_EXPIRED, { status: 402, request, env });
  }

  return ok({ licenseState: gated.license.state }, { request, env });
}

/** JWT を発行してよい push サービスのホスト。vars で上書きできる。 */
function pushHosts(env) {
  const configured = String(env.ALLOWED_PUSH_HOSTS || '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value !== '');

  return configured.length > 0 ? configured : DEFAULT_PUSH_HOSTS;
}

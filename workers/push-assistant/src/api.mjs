/**
 * HTTP API（仕様書 §7）。
 *
 * ==================================================================
 * CSRF は Origin 照合で止める
 * ==================================================================
 * セッションは Cookie なので、他サイトのページから
 * `fetch('https://tsam-ai.com/push-assistant/api/auth/disconnect', {method:'POST', credentials:'include'})`
 * を仕掛けられる余地がある。SameSite=Lax でほぼ止まるが、
 * **状態を変える要求（POST/PUT/DELETE）は Origin ヘッダも見る。**
 *
 * Origin が「無い」場合も拒否する。ブラウザは POST に必ず付けるので、
 * 無いのはブラウザ以外（curl など）であり、この API に用は無い。
 * ==================================================================
 *
 * ==================================================================
 * 認証と「Google 接続」は別のもの
 * ==================================================================
 *   ログイン（pa_session）… 誰であるか。Cookie の署名だけで分かる
 *   Google 接続（google_tokens）… カレンダーを読めるか
 *
 * ログインしているが接続が切れている（invalid_grant 後）状態が普通に
 * あるので、/api/me は両方を別の項目（loggedIn / calendarConnected /
 * tokenInvalid）で返す。画面はこれを見て「再接続してください」を出す。
 * ==================================================================
 */

import {
  CALENDAR_SCOPE,
  DEFAULT_LEAD_MINUTES,
  EVENTS_LOOKAHEAD_MS,
  GOOGLE_SCOPES,
  LEAD_OPTIONS,
  LEAD_VALUES,
  MAX_BODY_BYTES,
  MAX_EVENTS_RESPONSE,
  MAX_LEAD_SELECTION,
  NOTIFICATION_HISTORY_LIMIT,
  OAUTH_COOKIE,
  OAUTH_MAX_AGE_SEC,
  SERVICE_NAME,
  SERVICE_VERSION,
  SESSION_COOKIE,
  SESSION_MAX_AGE_SEC,
} from './constants.mjs';
import {
  ConfigError,
  allowedEmails,
  appOrigin,
  appUrl,
  basePath,
  optional,
  redirectUri,
  required,
} from './config.mjs';
import { ERRORS, fail, ok, redirect } from './http.mjs';
import {
  decryptString,
  encryptString,
  importEncryptionKey,
  randomBase64Url,
  sha256Base64Url,
} from './crypto-util.mjs';
import { buildSetCookie, importSigningKey, parseCookies, signValue, verifyValue } from './session.mjs';
import { buildAuthUrl, exchangeCode, parseIdToken, revokeToken } from './google-oauth.mjs';
import { ensureAccessToken } from './access-token.mjs';
import { listUpcomingEvents } from './calendar.mjs';
import { resolveOpenUrl } from './open-url.mjs';
import { planNotifications } from './schedule.mjs';
import { notificationKey } from './store.mjs';
import { importVapidPrivateKey, normalizeBase64Url } from './vapid.mjs';
import { sendWebPush } from './webpush.mjs';

/**
 * 読み込み済みの鍵。isolate が使い回される間は importKey をやり直さない。
 *
 * **元の文字列も一緒に覚える**（notifier-gate/index.mjs と同じ理由）。
 * 鍵だけ覚えると、シークレットを差し替えたあとも生きている isolate が
 * 古い鍵を使い続け、「新しい購読にだけ届かない」追いにくい状態になる。
 */
const keyCache = { session: { secret: '', key: null }, encryption: { secret: '', key: null }, vapid: { secret: '', key: null } };

async function cachedKey(slot, secret, importer) {
  if (keyCache[slot].secret !== secret || keyCache[slot].key === null) {
    keyCache[slot] = { secret, key: await importer(secret) };
  }

  return keyCache[slot].key;
}

/**
 * API を 1 本受ける。
 *
 * path は base path を剥がした後のもの（`/api/me` など）。
 * store は D1 実装、テストでは偽物（index.mjs が決める）。
 */
export async function handleApi({ request, url, path, env, store, nowMs, fetchImpl, log }) {
  const method = request.method.toUpperCase();
  /* 末尾スラッシュの有無を吸収する（仕様書 §7）。 */
  const route = path.length > 1 ? path.replace(/\/+$/, '') : path;

  /*
   * health は **GET だけ**。運用者が curl で疎通を見るための窓であり、
   * 状態を変えない。POST を素通しすると、Origin 照合の前に応答する経路が
   * 1 本できてしまう（下の照合はこの分岐より後ろにある）。
   * GET 以外はここで拾わず、Origin 照合を経て 404 になる。
   */
  if (route === '/api/health' && method === 'GET') {
    return ok({ service: SERVICE_NAME, version: SERVICE_VERSION });
  }

  /*
   * 状態を変える要求は Origin を見る。**ルーティングより先に置く。**
   * 後ろに置くと、経路ごとに書き忘れが起きうる。
   */
  if (method === 'POST' || method === 'PUT' || method === 'DELETE') {
    const origin = request.headers.get('Origin');
    let expected;

    try {
      expected = appOrigin(env);
    } catch (error) {
      return configFailure(error, log);
    }

    if (origin !== expected) {
      log('warn', 'FORBIDDEN_ORIGIN', `route=${route}`);
      return fail(ERRORS.FORBIDDEN_ORIGIN);
    }
  }

  try {
    if (route === '/api/auth/start' && method === 'GET') {
      return await handleAuthStart({ env, nowMs });
    }

    if (route === '/api/auth/callback' && method === 'GET') {
      return await handleAuthCallback({ request, url, env, store, nowMs, fetchImpl, log });
    }

    if (route === '/api/auth/logout' && method === 'POST') {
      return handleLogout({ env });
    }

    if (route === '/api/auth/disconnect' && method === 'POST') {
      return await handleDisconnect({ request, env, store, nowMs, fetchImpl, log });
    }

    if (route === '/api/me' && method === 'GET') {
      return await handleMe({ request, env, store, nowMs, log });
    }

    if (route === '/api/settings' && method === 'PUT') {
      return await handleSettings({ request, env, store, nowMs });
    }

    if (route === '/api/events' && method === 'GET') {
      return await handleEvents({ request, env, store, nowMs, fetchImpl, log });
    }

    if (route === '/api/subscriptions' && method === 'POST') {
      return await handleSubscribe({ request, env, store, nowMs, log });
    }

    if (route === '/api/subscriptions' && method === 'DELETE') {
      return await handleUnsubscribe({ request, env, store, nowMs });
    }

    if (route === '/api/push/test' && method === 'POST') {
      return await handlePushTest({ request, env, store, nowMs, fetchImpl, log });
    }

    if (route === '/api/notifications' && method === 'GET') {
      return await handleNotifications({ request, env, store, nowMs });
    }

    return fail(ERRORS.NOT_FOUND);
  } catch (error) {
    if (error instanceof ConfigError) {
      return configFailure(error, log);
    }

    /* 応答には内部情報を出さない。ログには種類だけ残す（notifier-gate と同じ）。 */
    log('error', 'API_CRASHED', `route=${route} name=${error?.name ?? 'Error'}`);

    return fail(ERRORS.SERVER_ERROR);
  }
}

/** 設定漏れ。**名前だけ**をログへ残す（値は ConfigError も持っていない）。 */
function configFailure(error, log) {
  if (error instanceof ConfigError) {
    log('error', 'NOT_CONFIGURED', `missing=${error.missing}`);
    return fail(ERRORS.NOT_CONFIGURED);
  }

  log('error', 'API_CRASHED', `name=${error?.name ?? 'Error'}`);

  return fail(ERRORS.SERVER_ERROR);
}

/* ================= セッション ================= */

/** Cookie からログイン中の利用者を取る。ログインしていなければ null。 */
async function readSession({ request, env, nowMs }) {
  const cookies = parseCookies(request.headers.get('Cookie'));
  const token = cookies[SESSION_COOKIE];

  if (!token) {
    return null;
  }

  const key = await cachedKey('session', required(env, 'SESSION_SECRET'), importSigningKey);
  const verified = await verifyValue(key, token, { nowMs });

  if (!verified.ok || typeof verified.value.sub !== 'string' || verified.value.sub === '') {
    return null;
  }

  return { sub: verified.value.sub, email: verified.value.email ?? '' };
}

/** ログイン必須の入口。未ログインなら 401 を返す。 */
async function requireSession({ request, env, nowMs }) {
  const session = await readSession({ request, env, nowMs });

  return session ?? null;
}

function sessionCookiePath(env) {
  return `${basePath(env)}/`;
}

function oauthCookiePath(env) {
  return `${basePath(env)}/api/auth/`;
}

/* ================= 本文 ================= */

/**
 * JSON 本文を読む。読めなければ null（呼び出し側が INVALID_REQUEST にする）。
 *
 * **上限はバイト数で見る。** 文字数で見ると、日本語（UTF-8 で 3 バイト）や
 * 絵文字（4 バイト）を並べた本文が上限の 3〜4 倍まで通る。
 */
async function readJsonBody(request) {
  const text = await request.text();
  const byteLength = new TextEncoder().encode(text).length;

  if (byteLength === 0 || byteLength > MAX_BODY_BYTES) {
    return null;
  }

  try {
    const parsed = JSON.parse(text);

    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/* ================= 認証 ================= */

/**
 * 同意画面へ送る。
 *
 * state と PKCE の code_verifier は**署名付き Cookie に入れる**。
 * D1 に置く案もあるが、認可の途中で捨てられる（利用者が閉じる）ほうが
 * 普通なので、掃除の要らない Cookie のほうが単純。10 分で切れる。
 */
async function handleAuthStart({ env, nowMs }) {
  const clientId = required(env, 'GOOGLE_CLIENT_ID');
  const sessionKey = await cachedKey('session', required(env, 'SESSION_SECRET'), importSigningKey);

  const state = randomBase64Url(16);
  const verifier = randomBase64Url(32);
  const challenge = await sha256Base64Url(verifier);

  const cookie = await signValue(sessionKey, {
    state,
    verifier,
    exp: Math.floor(nowMs / 1000) + OAUTH_MAX_AGE_SEC,
  });

  return redirect(
    buildAuthUrl({
      clientId,
      redirectUri: redirectUri(env),
      state,
      codeChallenge: challenge,
      scopes: GOOGLE_SCOPES,
    }),
    {
      extraHeaders: {
        'Set-Cookie': buildSetCookie(OAUTH_COOKIE, cookie, {
          path: oauthCookiePath(env),
          maxAgeSec: OAUTH_MAX_AGE_SEC,
        }),
      },
    },
  );
}

/**
 * 同意画面からの戻り。
 *
 * **失敗しても JSON を返さない。** ここへ来るのはブラウザのトップレベル
 * 遷移なので、生の JSON が画面に出ると利用者は何も分からない。
 * 画面へ戻して `?error=` で伝える（仕様書 §7）。
 */
async function handleAuthCallback({ request, url, env, store, nowMs, fetchImpl, log }) {
  const home = appUrl(env);
  const clearOauth = buildSetCookie(OAUTH_COOKIE, '', { path: oauthCookiePath(env), maxAgeSec: 0 });

  const back = (code) => redirect(`${home}?error=${encodeURIComponent(code)}`, {
    extraHeaders: { 'Set-Cookie': clearOauth },
  });

  if (url.searchParams.get('error')) {
    /* 利用者が「キャンセル」を押した等。Google の error 値は分類語なので出してよい。 */
    log('info', 'OAUTH_DENIED', '');
    return back('OAUTH_DENIED');
  }

  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');

  if (!code || !state) {
    return back('INVALID_REQUEST');
  }

  const sessionKey = await cachedKey('session', required(env, 'SESSION_SECRET'), importSigningKey);
  const cookies = parseCookies(request.headers.get('Cookie'));
  const verified = await verifyValue(sessionKey, cookies[OAUTH_COOKIE] ?? '', { nowMs });

  if (!verified.ok) {
    log('warn', 'OAUTH_STATE_MISSING', `reason=${verified.reason}`);
    return back('SESSION_EXPIRED');
  }

  if (verified.value.state !== state) {
    /* state 不一致＝別の誰かに認可フローを始めさせられた可能性。無言で捨てる。 */
    log('warn', 'OAUTH_STATE_MISMATCH', '');
    return back('INVALID_REQUEST');
  }

  const clientId = required(env, 'GOOGLE_CLIENT_ID');
  const clientSecret = required(env, 'GOOGLE_CLIENT_SECRET');

  const exchanged = await exchangeCode({
    code,
    clientId,
    clientSecret,
    redirectUri: redirectUri(env),
    codeVerifier: String(verified.value.verifier ?? ''),
    fetchImpl,
  });

  if (!exchanged.ok) {
    log('warn', 'OAUTH_EXCHANGE_FAILED', `status=${exchanged.status} error=${exchanged.error}`);
    return back('OAUTH_FAILED');
  }

  /*
   * ------------------------------------------------------------------
   * カレンダーの読み取りが許可されたか（仕様書 §4-3）
   * ------------------------------------------------------------------
   * Google の同意画面は**スコープごとにチェックを外せる。** openid と email
   * だけ許可して calendar.events.readonly を外したまま進むと、接続は成功し、
   * その後の tick が毎分 403 を出し続ける（利用者からは「通知が来ない」
   * としか見えない）。**接続の時点で断る。**
   * ------------------------------------------------------------------
   */
  if (!exchanged.tokens.scope.split(/\s+/).includes(CALENDAR_SCOPE)) {
    log('warn', 'OAUTH_SCOPE_MISSING', '');
    return back('SCOPE_NOT_GRANTED');
  }

  const claims = parseIdToken(exchanged.tokens.idToken, { clientId, nowMs });

  if (!claims.ok) {
    log('warn', 'OAUTH_ID_TOKEN_REJECTED', `reason=${claims.reason}`);
    return back('OAUTH_FAILED');
  }

  /*
   * ------------------------------------------------------------------
   * 許可された利用者か（deny by default）
   * ------------------------------------------------------------------
   * **D1 に行を作る前に断る。** 後で消す作りにすると、断った相手の
   * リフレッシュトークンが一瞬でも保存される。ここで返せば、
   * こちらに残るのは「拒否した」というログ 1 行だけになる。
   *
   * ALLOWED_EMAILS が空なら誰も通らない（config.mjs の allowedEmails）。
   * 未確認のアドレス（email_verified が false）も通さない。他人の
   * アドレスを騙った Google アカウントを弾くため。
   * ------------------------------------------------------------------
   */
  const allowList = allowedEmails(env);
  const email = claims.claims.email.trim().toLowerCase();

  if (!claims.claims.emailVerified || email === '' || !allowList.includes(email)) {
    /* **アドレスをログに書かない。** 拒否した事実と理由の分類だけ残す。 */
    log('warn', 'OAUTH_NOT_ALLOWED', `verified=${claims.claims.emailVerified} listed=${allowList.includes(email)}`);
    return back('NOT_ALLOWED');
  }

  if (!store) {
    return back('NOT_CONFIGURED');
  }

  const encryptionKey = await cachedKey(
    'encryption',
    required(env, 'TOKEN_ENCRYPTION_KEY'),
    importEncryptionKey,
  );

  const nowIso = new Date(nowMs).toISOString();

  await store.upsertUser({ id: claims.claims.sub, email: claims.claims.email, nowIso });

  /*
   * refresh_token が返らないことがある（prompt=consent を付けているので
   * 通常は返るが、Google 側の都合で省かれる例が報告されている）。
   * **既存の値が使えるならそれを残す。** 消してしまうと、再接続するまで
   * 通知が止まる。
   */
  let refreshTokenEnc = '';

  if (exchanged.tokens.refreshToken !== '') {
    refreshTokenEnc = await encryptString(encryptionKey, exchanged.tokens.refreshToken);
  } else {
    const existing = await store.getTokens(claims.claims.sub);

    if (!existing?.refreshTokenEnc) {
      log('warn', 'OAUTH_NO_REFRESH_TOKEN', '');
      return back('NO_REFRESH_TOKEN');
    }

    refreshTokenEnc = existing.refreshTokenEnc;
  }

  await store.saveTokens(
    claims.claims.sub,
    {
      refreshTokenEnc,
      accessTokenEnc: await encryptString(encryptionKey, exchanged.tokens.accessToken),
      accessTokenExpiresAt: new Date(nowMs + exchanged.tokens.expiresInSec * 1000).toISOString(),
      scope: exchanged.tokens.scope,
    },
    nowIso,
  );

  const session = await signValue(sessionKey, {
    sub: claims.claims.sub,
    email: claims.claims.email,
    iat: Math.floor(nowMs / 1000),
    exp: Math.floor(nowMs / 1000) + SESSION_MAX_AGE_SEC,
  });

  log('info', 'OAUTH_CONNECTED', `user=${claims.claims.sub}`);

  const response = redirect(home);

  /* Set-Cookie は 2 行必要（セッション発行と、途中状態の削除）。 */
  response.headers.append(
    'Set-Cookie',
    buildSetCookie(SESSION_COOKIE, session, {
      path: sessionCookiePath(env),
      maxAgeSec: SESSION_MAX_AGE_SEC,
    }),
  );
  response.headers.append('Set-Cookie', clearOauth);

  return response;
}

/** ログアウト。**データは消さない**（仕様書 §7）。再ログインで元に戻る。 */
function handleLogout({ env }) {
  return ok({}, {
    extraHeaders: {
      'Set-Cookie': buildSetCookie(SESSION_COOKIE, '', {
        path: sessionCookiePath(env),
        maxAgeSec: 0,
      }),
    },
  });
}

/**
 * 接続解除。Google 側の失効を試みてから、こちらのデータを全部消す。
 *
 * 順序が逆だと、消した後に失効へ失敗しても復旧できない。
 * 失効に失敗しても削除は続ける（§7。Google 側は利用者が自分で取り消せる）。
 */
async function handleDisconnect({ request, env, store, nowMs, fetchImpl, log }) {
  const session = await requireSession({ request, env, nowMs });

  if (!session) {
    return fail(ERRORS.UNAUTHORIZED);
  }

  if (!store) {
    return fail(ERRORS.NOT_CONFIGURED);
  }

  const tokens = await store.getTokens(session.sub);

  if (tokens?.refreshTokenEnc) {
    try {
      const encryptionKey = await cachedKey(
        'encryption',
        required(env, 'TOKEN_ENCRYPTION_KEY'),
        importEncryptionKey,
      );

      const refreshToken = await decryptString(encryptionKey, tokens.refreshTokenEnc);
      const revoked = await revokeToken({ token: refreshToken, fetchImpl });

      log('info', 'REVOKE_RESULT', `status=${revoked.status}`);
    } catch (error) {
      /* 復号も失効も失敗してよい。削除は必ず行う。 */
      log('warn', 'REVOKE_SKIPPED', `name=${error?.name ?? 'Error'}`);
    }
  }

  await store.deleteUserData(session.sub);

  log('info', 'DISCONNECTED', `user=${session.sub}`);

  return ok({}, {
    extraHeaders: {
      'Set-Cookie': buildSetCookie(SESSION_COOKIE, '', {
        path: sessionCookiePath(env),
        maxAgeSec: 0,
      }),
    },
  });
}

/* ================= 画面の初期化 ================= */

/**
 * 画面が最初に叩く。**未ログインでも 200 を返す**（loggedIn: false）。
 *
 * ここを 401 にすると、画面は「エラー」と「未ログイン」を区別するために
 * 状態コードで分岐することになる。ログインしていないのは正常な状態なので、
 * 本文で伝える。
 */
async function handleMe({ request, env, store, nowMs, log }) {
  const session = await readSession({ request, env, nowMs });

  /*
   * 公開鍵は購読に要る。**未設定でも 500 にしない。**
   * ここで落とすと画面が何も描けなくなる。空文字を返し、
   * 画面側は「通知を有効にできません」を出す（仕様書 §7 の補足）。
   */
  const vapidPublicKey = normalizeBase64Url(optional(env, 'VAPID_PUBLIC_KEY', ''));

  const base = {
    loggedIn: false,
    user: null,
    calendarConnected: false,
    tokenInvalid: false,
    settings: { notifyEnabled: true, leadMinutes: DEFAULT_LEAD_MINUTES },
    vapidPublicKey,
    subscriptionCount: 0,
    leadOptions: LEAD_OPTIONS,
  };

  if (!session) {
    return ok(base);
  }

  if (!store) {
    return fail(ERRORS.NOT_CONFIGURED);
  }

  const user = await store.getUser(session.sub);

  if (!user) {
    /*
     * Cookie は生きているが行が無い＝接続解除の後に古い Cookie で来た。
     * 未ログイン扱いにして Cookie を消す。
     */
    log('info', 'SESSION_ORPHANED', '');

    return ok(base, {
      extraHeaders: {
        'Set-Cookie': buildSetCookie(SESSION_COOKIE, '', {
          path: sessionCookiePath(env),
          maxAgeSec: 0,
        }),
      },
    });
  }

  const tokens = await store.getTokens(session.sub);

  return ok({
    ...base,
    loggedIn: true,
    user: { email: user.email || session.email },
    calendarConnected: Boolean(tokens) && !tokens.invalidAt,
    tokenInvalid: Boolean(tokens?.invalidAt),
    settings: { notifyEnabled: user.notifyEnabled, leadMinutes: user.leadMinutes },
    subscriptionCount: await store.countActiveSubscriptions(session.sub),
  });
}

/* ================= 設定 ================= */

/**
 * 通知設定の保存。
 *
 * **LEAD_OPTIONS にある値しか受け付けない。** 任意の分数を通すと、
 * LOOKAHEAD_MS（1 時間）を超える lead を指定されたときに
 * 「設定はできたが通知は来ない」状態になる（Calendar 取得窓の外）。
 */
async function handleSettings({ request, env, store, nowMs }) {
  const session = await requireSession({ request, env, nowMs });

  if (!session) {
    return fail(ERRORS.UNAUTHORIZED);
  }

  if (!store) {
    return fail(ERRORS.NOT_CONFIGURED);
  }

  const body = await readJsonBody(request);

  if (!body || typeof body.notifyEnabled !== 'boolean' || !Array.isArray(body.leadMinutes)) {
    return fail(ERRORS.INVALID_REQUEST);
  }

  const leadMinutes = [];

  for (const value of body.leadMinutes) {
    const lead = Number(value);

    if (!LEAD_VALUES.includes(lead) || leadMinutes.includes(lead)) {
      return fail(ERRORS.INVALID_REQUEST);
    }

    leadMinutes.push(lead);
  }

  if (leadMinutes.length < 1 || leadMinutes.length > MAX_LEAD_SELECTION) {
    return fail(ERRORS.INVALID_REQUEST);
  }

  const settings = { notifyEnabled: body.notifyEnabled, leadMinutes };

  await store.updateSettings(session.sub, settings, new Date(nowMs).toISOString());

  /* 保存後の値を返す（画面はこれで自分の状態を上書きする）。 */
  return ok({ settings });
}

/* ================= 予定 ================= */

/**
 * 今後 24 時間の予定。
 *
 * **Calendar が落ちても 502 を返すだけで、他の API は動き続ける**（完成条件 I）。
 * 画面は予定の欄だけを「取得できませんでした」にして、設定や履歴は出せる。
 */
async function handleEvents({ request, env, store, nowMs, fetchImpl, log }) {
  const session = await requireSession({ request, env, nowMs });

  if (!session) {
    return fail(ERRORS.UNAUTHORIZED);
  }

  if (!store) {
    return fail(ERRORS.NOT_CONFIGURED);
  }

  const user = await store.getUser(session.sub);

  if (!user) {
    return fail(ERRORS.UNAUTHORIZED);
  }

  const encryptionKey = await cachedKey(
    'encryption',
    required(env, 'TOKEN_ENCRYPTION_KEY'),
    importEncryptionKey,
  );

  const token = await ensureAccessToken({
    store,
    userId: session.sub,
    clientId: required(env, 'GOOGLE_CLIENT_ID'),
    clientSecret: required(env, 'GOOGLE_CLIENT_SECRET'),
    encryptionKey,
    nowMs,
    nowIso: new Date(nowMs).toISOString(),
    fetchImpl,
  });

  if (!token.ok) {
    if (token.code === 'NOT_CONNECTED') {
      return fail(ERRORS.NOT_CONNECTED);
    }

    if (token.code === 'TOKEN_INVALID') {
      return fail(ERRORS.TOKEN_INVALID);
    }

    log('warn', 'EVENTS_TOKEN_FAILED', `status=${token.status ?? 0}`);

    return fail(ERRORS.CALENDAR_ERROR);
  }

  const calendar = await listUpcomingEvents({
    accessToken: token.accessToken,
    timeMinMs: nowMs,
    timeMaxMs: nowMs + EVENTS_LOOKAHEAD_MS,
    fetchImpl,
  });

  if (!calendar.ok) {
    log('warn', 'EVENTS_CALENDAR_FAILED', `code=${calendar.code} status=${calendar.status}`);

    /* UNAUTHENTICATED も 502 にする。画面から見れば「取れなかった」で同じ。 */
    return fail(ERRORS.CALENDAR_ERROR);
  }

  const events = calendar.events.slice(0, MAX_EVENTS_RESPONSE);
  const home = appUrl(env);

  const plans = planNotifications({
    events,
    leadMinutes: user.leadMinutes,
    nowMs,
    appUrl: home,
  });

  /* 通知の現状を 1 回の問い合わせでまとめて引く。 */
  const statuses = await store.findNotificationStatuses(
    session.sub,
    plans.map((plan) => ({
      eventId: plan.eventId,
      eventStart: plan.eventStart,
      leadMinutes: plan.leadMinutes,
    })),
  );

  const plansByEvent = new Map();

  for (const plan of plans) {
    const list = plansByEvent.get(plan.eventId) ?? [];

    list.push({
      leadMinutes: plan.leadMinutes,
      notifyAt: new Date(plan.notifyAtMs).toISOString(),
      /* 表に行が無ければ「これから作られる」＝planned（仕様書 §7）。 */
      status: statuses[notificationKey(plan.eventId, plan.eventStart, plan.leadMinutes)] ?? 'planned',
    });

    plansByEvent.set(plan.eventId, list);
  }

  const items = events.map((event) => {
    /*
     * 開く URL は resolveOpenUrl を直接呼ぶ。planNotifications の結果からは
     * 取れない（**終日予定はそもそも予定表に載らない**）が、画面には
     * 終日予定も出すため。判定規則は同じ関数なので食い違わない。
     */
    const resolved = resolveOpenUrl(event, { appUrl: home });

    return {
      id: event.id,
      title: event.title,
      start: event.start,
      end: event.end,
      allDay: event.allDay,
      openUrl: resolved.url,
      urlSource: resolved.source,
      notifications: event.allDay ? [] : (plansByEvent.get(event.id) ?? []),
    };
  });

  return ok({ items });
}

/* ================= 購読 ================= */

/**
 * 購読の登録。
 *
 * endpoint は **https のみ**（仕様書 §7）。http を通すと、
 * 送信のたびに平文で push を投げる相手を利用者が指定できてしまう。
 */
async function handleSubscribe({ request, env, store, nowMs, log }) {
  const session = await requireSession({ request, env, nowMs });

  if (!session) {
    return fail(ERRORS.UNAUTHORIZED);
  }

  if (!store) {
    return fail(ERRORS.NOT_CONFIGURED);
  }

  const body = await readJsonBody(request);
  const subscription = body?.subscription;

  if (!subscription || typeof subscription !== 'object') {
    return fail(ERRORS.INVALID_REQUEST);
  }

  const endpoint = typeof subscription.endpoint === 'string' ? subscription.endpoint.trim() : '';
  const p256dh = subscription.keys?.p256dh;
  const auth = subscription.keys?.auth;

  if (!isHttpsUrl(endpoint) || typeof p256dh !== 'string' || typeof auth !== 'string') {
    return fail(ERRORS.INVALID_REQUEST);
  }

  if (p256dh.length < 80 || p256dh.length > 200 || auth.length < 16 || auth.length > 64) {
    /* 長さで粗く弾く。中身の妥当性は送信時に encryptPayload が見る。 */
    return fail(ERRORS.INVALID_REQUEST);
  }

  const result = await store.upsertSubscription({
    userId: session.sub,
    endpoint,
    p256dh,
    auth,
    userAgent: typeof body.userAgent === 'string' ? body.userAgent.slice(0, 200) : '',
    nowIso: new Date(nowMs).toISOString(),
  });

  if (result?.reassignedFrom) {
    /*
     * 端末の持ち主が変わった。**endpoint は書かない**（購読の宛先は秘密で、
     * ログから拾えば第三者が push を打てる材料になる）。
     * 利用者 ID だけ残し、「誰の通知が止まったか」を後から追えるようにする。
     */
    log('warn', 'SUBSCRIPTION_REASSIGNED', `from=${result.reassignedFrom} to=${session.sub}`);
  }

  return ok({ subscriptionCount: await store.countActiveSubscriptions(session.sub) });
}

async function handleUnsubscribe({ request, env, store, nowMs }) {
  const session = await requireSession({ request, env, nowMs });

  if (!session) {
    return fail(ERRORS.UNAUTHORIZED);
  }

  if (!store) {
    return fail(ERRORS.NOT_CONFIGURED);
  }

  const body = await readJsonBody(request);
  const endpoint = typeof body?.endpoint === 'string' ? body.endpoint.trim() : '';

  if (!isHttpsUrl(endpoint)) {
    return fail(ERRORS.INVALID_REQUEST);
  }

  /* 自分の購読しか消えない（store 側で user_id を条件に入れてある）。 */
  await store.deleteSubscription(session.sub, endpoint);

  return ok({ subscriptionCount: await store.countActiveSubscriptions(session.sub) });
}

function isHttpsUrl(text) {
  try {
    return new URL(text).protocol === 'https:';
  } catch {
    return false;
  }
}

/* ================= テスト通知 ================= */

/**
 * 自分の全購読へテスト通知。
 *
 * ここが通れば「鍵・購読・端末」が揃っていることが分かる。
 * 通知そのものの経路を確かめる唯一の手段なので、履歴（notifications 表）
 * には残さない（本物の通知と混ざると履歴が読みにくくなる）。
 */
async function handlePushTest({ request, env, store, nowMs, fetchImpl, log }) {
  const session = await requireSession({ request, env, nowMs });

  if (!session) {
    return fail(ERRORS.UNAUTHORIZED);
  }

  if (!store) {
    return fail(ERRORS.NOT_CONFIGURED);
  }

  const vapid = await loadVapid(env);
  const subscriptions = await store.listActiveSubscriptions(session.sub);
  const nowIso = new Date(nowMs).toISOString();
  const home = appUrl(env);

  const payload = {
    v: 1,
    kind: 'test',
    title: 'Push Assistant',
    body: 'テスト通知です。タップするとアプリが開きます。',
    url: home,
    tag: 'pa:test',
  };

  let sent = 0;
  let failed = 0;

  for (const subscription of subscriptions) {
    const outcome = await sendWebPush({ subscription, payload, vapid, fetchImpl, nowMs });

    if (outcome.ok) {
      sent += 1;
      await store.recordSubscriptionResult(subscription.id, { ok: true }, nowIso);
      continue;
    }

    failed += 1;

    if (outcome.gone) {
      await store.disableSubscription(subscription.id, nowIso);
    } else {
      await store.recordSubscriptionResult(subscription.id, { ok: false }, nowIso);
    }

    log('warn', 'TEST_PUSH_FAILED', `status=${outcome.status} error=${outcome.error}`);
  }

  return ok({ sent, failed });
}

/** VAPID の鍵一式を用意する。api.mjs と index.mjs（Cron）の両方が使う。 */
export async function loadVapid(env) {
  const secret = required(env, 'VAPID_PRIVATE_KEY');

  return {
    privateKey: await cachedKey('vapid', secret, importVapidPrivateKey),
    publicKey: normalizeBase64Url(required(env, 'VAPID_PUBLIC_KEY')),
    subject: required(env, 'VAPID_SUBJECT'),
  };
}

/* ================= 履歴 ================= */

async function handleNotifications({ request, env, store, nowMs }) {
  const session = await requireSession({ request, env, nowMs });

  if (!session) {
    return fail(ERRORS.UNAUTHORIZED);
  }

  if (!store) {
    return fail(ERRORS.NOT_CONFIGURED);
  }

  const rows = await store.listNotifications(session.sub, NOTIFICATION_HISTORY_LIMIT);

  return ok({
    items: rows.map((row) => ({
      id: row.id,
      title: row.title,
      notifyAt: row.notifyAt,
      leadMinutes: row.leadMinutes,
      status: row.status,
      openUrl: row.openUrl,
      urlSource: row.urlSource,
      sentAt: row.sentAt,
      attempts: row.attempts,
      lastError: row.lastError,
    })),
  });
}

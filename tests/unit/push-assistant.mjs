/*
 * Push Assistant のバックエンド（workers/push-assistant/）。
 *
 * ==================================================================
 * ここで固定するもの（仕様書 §12 の A〜G, I, J）
 * ==================================================================
 *   A  Calendar 予定の取得と正規化
 *   B  10分前通知の判定
 *   C  開始時刻通知の判定
 *   D  通知済みの予定を再送しない（runTick を 2 回。送信 1 回）
 *   E  conference URL の抽出
 *   F  description URL の抽出
 *   G  不正 URL の拒否
 *   I  Calendar エラーで全体が落ちない（1 人目 500 → 2 人目は届く）
 *   J  送信失敗からの再実行（503 → pending/attempts=1 → 次 tick で成功、410 → 無効化）
 *
 *   H は tests/unit/push-assistant-sw.mjs（Service Worker 側）が受け持つ。
 *
 * 加えて、**Web Push の暗号化を往復で確かめる。**
 * ここが間違っていると「送信は 201、通知は出ない」という
 * いちばん追いにくい壊れ方をする。テスト側で受信者の鍵を作り、
 * RFC 8291 の手順で自力で復号して平文の一致を見る。
 * ==================================================================
 *
 * Workers ランタイムも Chrome も要らない。src/*.mjs は WebCrypto と
 * fetch/Request/Response しか使っておらず、Node 22 にどちらもある。
 */

import { check, section, finish, fatal } from '../../public/apps/tests/helpers/assert.mjs';

import {
  DEFAULT_LEAD_MINUTES,
  DUE_GRACE_MS,
  LEAD_OPTIONS,
  MAX_ATTEMPTS,
  MAX_BODY_BYTES,
  MAX_NOTIFY_BODY_LENGTH,
  MAX_TITLE_LENGTH,
  MAX_USERS_PER_TICK,
  STALE_PENDING_MS,
  STUCK_SENDING_MS,
} from '../../workers/push-assistant/src/constants.mjs';
import { appUrl, basePath, redirectUri } from '../../workers/push-assistant/src/config.mjs';
import {
  base64ToBytes,
  base64UrlEncode,
  decryptString,
  encryptString,
  importEncryptionKey,
  randomBase64Url,
  sha256Base64Url,
  timingSafeEqual,
} from '../../workers/push-assistant/src/crypto-util.mjs';
import {
  buildSetCookie,
  importSigningKey,
  parseCookies,
  signValue,
  verifyValue,
} from '../../workers/push-assistant/src/session.mjs';
import {
  buildAuthUrl,
  parseIdToken,
  refreshAccessToken,
} from '../../workers/push-assistant/src/google-oauth.mjs';
import { listUpcomingEvents, normalizeEvent } from '../../workers/push-assistant/src/calendar.mjs';
import {
  extractUrls,
  isAllowedUrl,
  resolveOpenUrl,
} from '../../workers/push-assistant/src/open-url.mjs';
import { planNotifications } from '../../workers/push-assistant/src/schedule.mjs';
import {
  buildDefaultBody,
  formatJstTime,
  renderNotification,
} from '../../workers/push-assistant/src/template.mjs';
import {
  MAX_PLAINTEXT_BYTES,
  buildVapidAuthorization,
  encryptPayload,
  sendWebPush,
} from '../../workers/push-assistant/src/webpush.mjs';
import { allowedEmails } from '../../workers/push-assistant/src/config.mjs';
import { runTick } from '../../workers/push-assistant/src/tick.mjs';
import { importVapidPrivateKey } from '../../workers/push-assistant/src/vapid.mjs';
import worker from '../../workers/push-assistant/src/index.mjs';

import { createFakeStore } from '../helpers/push-assistant-fake-store.mjs';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

/* 基準時刻。テストの中で now を動かすので固定値にする。 */
const NOW = Date.UTC(2026, 7, 26, 9, 0, 0);

const APP_URL = 'https://tsam-ai.com/push-assistant/';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/* ================= 小道具 ================= */

function concat(parts) {
  let length = 0;

  for (const part of parts) {
    length += part.length;
  }

  const out = new Uint8Array(length);
  let offset = 0;

  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }

  return out;
}

async function hmac(keyBytes, dataBytes) {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);

  return new Uint8Array(await crypto.subtle.sign('HMAC', key, dataBytes));
}

async function hkdf(salt, ikm, info, length) {
  const prk = await hmac(salt, ikm);
  const okm = await hmac(prk, concat([info, Uint8Array.of(0x01)]));

  return okm.slice(0, length);
}

/** Calendar API の生の予定を 1 件つくる。 */
function rawEvent(overrides = {}) {
  return {
    id: 'ev1',
    status: 'confirmed',
    summary: '定例会議',
    start: { dateTime: new Date(NOW + HOUR).toISOString() },
    end: { dateTime: new Date(NOW + HOUR + 30 * MINUTE).toISOString() },
    htmlLink: 'https://calendar.google.com/event?eid=abc',
    ...overrides,
  };
}

/** fetch の偽物。URL の断片で応答を選ぶ。 */
function createFetch(routes) {
  const calls = [];

  const fetchImpl = async (url, options = {}) => {
    const href = String(url);

    calls.push({ url: href, options });

    for (const route of routes) {
      if (href.includes(route.match)) {
        if (typeof route.handler === 'function') {
          return route.handler({ url: href, options, calls });
        }

        return route.handler;
      }
    }

    throw new Error(`偽 fetch に登録されていない宛先: ${href}`);
  };

  fetchImpl.calls = calls;

  return fetchImpl;
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/* ================= 本体 ================= */

async function run() {
  /* ---------------------------------------------------------------- */
  section('設定 — URL の組み立て');

  {
    const env = { APP_ORIGIN: 'https://tsam-ai.com', APP_BASE_PATH: '/push-assistant' };

    check(
      'リダイレクト URI は Google Cloud Console に登録する値と一致する',
      redirectUri(env) === 'https://tsam-ai.com/push-assistant/api/auth/callback',
      redirectUri(env),
    );
    check('アプリの URL は末尾スラッシュ付き', appUrl(env) === APP_URL, appUrl(env));
    check('APP_BASE_PATH 未設定でも既定値へ倒す', basePath({}) === '/push-assistant', basePath({}));
    check(
      '末尾スラッシュ付きの APP_ORIGIN でも二重にならない',
      appUrl({ APP_ORIGIN: 'https://tsam-ai.com/', APP_BASE_PATH: '/push-assistant' }) === APP_URL,
    );
  }

  /* ---------------------------------------------------------------- */
  section('A — Calendar の取得と正規化');

  {
    const normalized = normalizeEvent(rawEvent());

    check('id と title を取り出す', normalized?.id === 'ev1' && normalized.title === '定例会議', JSON.stringify(normalized));
    check('start は ISO', normalized.start === new Date(NOW + HOUR).toISOString(), normalized.start);
    check('時間指定の予定は allDay=false', normalized.allDay === false);

    const cancelled = normalizeEvent(rawEvent({ status: 'cancelled' }));

    check('cancelled は除外（null）', cancelled === null);

    const allDay = normalizeEvent(rawEvent({ start: { date: '2026-08-27' }, end: { date: '2026-08-28' } }));

    check('date だけの予定は allDay=true', allDay?.allDay === true, JSON.stringify(allDay));

    const untitled = normalizeEvent(rawEvent({ summary: '' }));

    check('タイトルが空でも通知に出せる文字列になる', untitled.title === '(タイトルなし)', untitled.title);
  }

  {
    const fetchImpl = createFetch([
      {
        match: 'calendar/v3',
        handler: jsonResponse({ items: [rawEvent(), rawEvent({ id: 'ev2', status: 'cancelled' })] }),
      },
    ]);

    const result = await listUpcomingEvents({
      accessToken: 'at-1',
      timeMinMs: NOW,
      timeMaxMs: NOW + HOUR,
      fetchImpl,
    });

    check('取得に成功する', result.ok === true && result.events.length === 1, JSON.stringify(result));

    const request = fetchImpl.calls[0];

    check('singleEvents=true で単発に展開させる', request.url.includes('singleEvents=true'));
    check('fields で要る項目だけに絞る', request.url.includes('fields='));
    check(
      'アクセストークンは Authorization ヘッダで渡す',
      request.options.headers.Authorization === 'Bearer at-1',
      JSON.stringify(request.options.headers),
    );
  }

  {
    const unauthorized = await listUpcomingEvents({
      accessToken: 'at-1',
      timeMinMs: NOW,
      timeMaxMs: NOW + HOUR,
      fetchImpl: createFetch([{ match: 'calendar/v3', handler: jsonResponse({}, 401) }]),
    });

    check('401 は UNAUTHENTICATED として区別する', unauthorized.code === 'UNAUTHENTICATED', JSON.stringify(unauthorized));

    const broken = await listUpcomingEvents({
      accessToken: 'at-1',
      timeMinMs: NOW,
      timeMaxMs: NOW + HOUR,
      fetchImpl: createFetch([{ match: 'calendar/v3', handler: jsonResponse({}, 500) }]),
    });

    check('500 は CALENDAR_ERROR', broken.code === 'CALENDAR_ERROR' && broken.status === 500, JSON.stringify(broken));

    const offline = await listUpcomingEvents({
      accessToken: 'at-1',
      timeMinMs: NOW,
      timeMaxMs: NOW + HOUR,
      fetchImpl: async () => { throw new Error('接続できません'); },
    });

    check('通信断でも例外を投げず CALENDAR_ERROR を返す', offline.ok === false && offline.code === 'CALENDAR_ERROR');
  }

  /* ---------------------------------------------------------------- */
  section('B / C — 通知タイミングの判定');

  {
    /* 10 分後に始まる予定を、いま（NOW）判定する。 */
    const events = [normalizeEvent(rawEvent({ start: { dateTime: new Date(NOW + 10 * MINUTE).toISOString() } }))];

    const plans = planNotifications({ events, leadMinutes: [10], nowMs: NOW, appUrl: APP_URL });

    check('B: 10分前ちょうどは due', plans.length === 1 && plans[0].due === 'due', JSON.stringify(plans));
    check('B: notifyAt は開始の 10 分前', plans[0].notifyAtMs === NOW, String(plans[0].notifyAtMs));

    const early = planNotifications({ events, leadMinutes: [10], nowMs: NOW - MINUTE, appUrl: APP_URL });

    check('B: 11 分前はまだ future', early[0].due === 'future', JSON.stringify(early));
  }

  {
    /* 開始時刻ちょうどの通知（lead=0）。 */
    const events = [normalizeEvent(rawEvent({ start: { dateTime: new Date(NOW).toISOString() } }))];

    const onTime = planNotifications({ events, leadMinutes: [0], nowMs: NOW, appUrl: APP_URL });

    check('C: 開始時刻ちょうどは due', onTime[0].due === 'due', JSON.stringify(onTime));

    const late = planNotifications({
      events,
      leadMinutes: [0],
      nowMs: NOW + DUE_GRACE_MS - MINUTE,
      appUrl: APP_URL,
    });

    check('C: 猶予の中（Cron の遅れ）はまだ due', late[0].due === 'due', JSON.stringify(late));

    const tooLate = planNotifications({
      events,
      leadMinutes: [0],
      nowMs: NOW + DUE_GRACE_MS + MINUTE,
      appUrl: APP_URL,
    });

    check('C: 猶予を超えたら stale（送らない）', tooLate[0].due === 'stale', JSON.stringify(tooLate));
  }

  {
    const allDay = normalizeEvent(rawEvent({ start: { date: '2026-08-26' }, end: { date: '2026-08-27' } }));

    check(
      '終日予定は通知の対象にしない',
      planNotifications({ events: [allDay], leadMinutes: [10, 0], nowMs: NOW, appUrl: APP_URL }).length === 0,
    );

    const both = planNotifications({
      events: [normalizeEvent(rawEvent({ start: { dateTime: new Date(NOW + 10 * MINUTE).toISOString() } }))],
      leadMinutes: [10, 0],
      nowMs: NOW,
      appUrl: APP_URL,
    });

    check('lead を 2 つ選ぶと 2 件計画される', both.length === 2, JSON.stringify(both.map((p) => p.leadMinutes)));
    check(
      '同じ予定なら開く URL は同じ',
      both[0].openUrl === both[1].openUrl,
    );
  }

  /* ---------------------------------------------------------------- */
  section('E / F — 開く URL の決定');

  {
    const withMeet = normalizeEvent(rawEvent({
      conferenceData: {
        entryPoints: [
          { entryPointType: 'phone', uri: 'tel:+81-3-0000-0000' },
          { entryPointType: 'video', uri: 'https://meet.google.com/abc-defg-hij' },
        ],
      },
      description: 'https://example.com/other',
    }));

    const resolved = resolveOpenUrl(withMeet, { appUrl: APP_URL });

    check(
      'E: conference の video を最優先で採る',
      resolved.url === 'https://meet.google.com/abc-defg-hij' && resolved.source === 'conference',
      JSON.stringify(resolved),
    );
    check('E: 電話の entryPoint は採らない', resolved.url.startsWith('https://'));

    const hangout = normalizeEvent(rawEvent({ hangoutLink: 'https://meet.google.com/old-style' }));

    check(
      'E: conferenceData が無ければ hangoutLink',
      resolveOpenUrl(hangout, { appUrl: APP_URL }).source === 'conference',
    );
  }

  {
    const html = normalizeEvent(rawEvent({
      description: '<p>参加は <a href="https://zoom.us/j/123?pwd=a&amp;b=c">こちら</a></p>',
    }));

    check(
      'F: HTML の href を拾い、実体参照を戻す',
      html.urls[0] === 'https://zoom.us/j/123?pwd=a&b=c',
      JSON.stringify(html.urls),
    );

    const plain = normalizeEvent(rawEvent({ description: '会議室が変わりました。https://example.com/room/12 をご確認ください。' }));

    check('F: 素の本文の URL も拾う', plain.urls[0] === 'https://example.com/room/12', JSON.stringify(plain.urls));

    const punctuated = extractUrls('詳細は https://example.com/a. をどうぞ');

    check('F: 末尾の句読点は URL に含めない', punctuated[0] === 'https://example.com/a', JSON.stringify(punctuated));

    const fullWidth = extractUrls('詳細（https://example.com/x）です');

    check('F: 全角括弧の中の URL も正しく切り出す', fullWidth[0] === 'https://example.com/x', JSON.stringify(fullWidth));

    const duplicated = extractUrls('<a href="https://a.example/">A</a> https://a.example/ https://b.example/');

    check('F: 重複は 1 本にまとめる', duplicated.length === 2, JSON.stringify(duplicated));

    const descriptionOnly = normalizeEvent(rawEvent({ description: 'https://example.com/doc' }));

    check(
      'F: conference が無ければ description の URL を使う',
      resolveOpenUrl(descriptionOnly, { appUrl: APP_URL }).source === 'description',
    );
  }

  /* ---------------------------------------------------------------- */
  section('G — 不正な URL を拒否する');

  {
    const rejected = [
      ['javascript:', 'javascript:alert(1)'],
      ['data:', 'data:text/html,<script>1</script>'],
      ['ftp:', 'ftp://example.com/file'],
      ['mailto:', 'mailto:someone@example.com'],
      ['認証情報つき', 'https://user:pass@example.com/'],
      ['利用者名だけ', 'https://user@example.com/'],
      ['制御文字', 'https://example.com/\nSet-Cookie: x=1'],
      ['相対 URL', '/push-assistant/'],
      ['空文字', ''],
      ['長すぎる', `https://example.com/${'a'.repeat(2100)}`],
    ];

    for (const [label, value] of rejected) {
      check(`G: ${label} は拒否`, isAllowedUrl(value) === false, value.slice(0, 60));
    }

    check('G: 普通の https は通す', isAllowedUrl('https://example.com/a?b=c#d') === true);
    check('G: http も通す（社内ツール等）', isAllowedUrl('http://example.com/') === true);
  }

  {
    /* 拒否は「その候補を捨てて次へ」であって、通知を止めることではない。 */
    const event = normalizeEvent(rawEvent({
      description: 'javascript:alert(1)',
      location: 'javascript:alert(2)',
    }));

    const resolved = resolveOpenUrl(event, { appUrl: APP_URL });

    check(
      'G: 不正な候補は飛ばして htmlLink へ落ちる',
      resolved.source === 'calendar' && resolved.url === 'https://calendar.google.com/event?eid=abc',
      JSON.stringify(resolved),
    );

    const nothing = resolveOpenUrl({ urls: [], htmlLink: '' }, { appUrl: APP_URL });

    check('G: 候補が全滅してもアプリの URL に落ちる', nothing.source === 'app' && nothing.url === APP_URL);
  }

  /* ---------------------------------------------------------------- */
  section('暗号 — セッション Cookie とトークンの保管');

  {
    const key = await importSigningKey('セッションの共有秘密（32バイト以上の乱数を想定）');
    const token = await signValue(key, { sub: '1234', email: 'a@example.com', exp: Math.floor(NOW / 1000) + 60 });

    const good = await verifyValue(key, token, { nowMs: NOW });

    check('署名した値を読み戻せる', good.ok === true && good.value.sub === '1234', JSON.stringify(good));

    const tampered = `${token.slice(0, -2)}xy`;

    check('署名を書き換えた値は通らない', (await verifyValue(key, tampered, { nowMs: NOW })).ok === false);

    const expired = await verifyValue(key, token, { nowMs: NOW + 61 * 1000 });

    check('期限切れは通らない（Cookie の Max-Age に頼らない）', expired.ok === false && expired.reason === 'EXPIRED');

    const otherKey = await importSigningKey('まったく別のセッション秘密（こちらも十分に長い値）');

    check('別の鍵では通らない', (await verifyValue(otherKey, token, { nowMs: NOW })).ok === false);

    /*
     * **短い鍵を受け入れない。** wrangler secret put は貼り付けに失敗しても
     * Success と表示するため、空・途中で切れた値がそのまま登録されうる。
     */
    for (const [label, value] of [['空', ''], ['1 文字', 'x'], ['16 バイト', 'a'.repeat(16)]]) {
      let message = '';

      try {
        await importSigningKey(value);
      } catch (error) {
        message = error.message;
      }

      check(`SESSION_SECRET が ${label} なら拒否`, message.includes('SESSION_SECRET'), message);
      check(`拒否のメッセージに値を入れない（${label}）`, value === '' || message.includes(value) === false, message);
    }

    check('32 文字の base64 でない値も長さで通る', Boolean(await importSigningKey('a'.repeat(32))));

    /* base64 で登録された 32 バイト（44 文字）は当然通る。 */
    check('base64 の 32 バイトは通る', Boolean(await importSigningKey(base64UrlEncode(new Uint8Array(32).fill(1)))));

    /* base64 として読める短い値は、復号後の長さでも UTF-8 でも 32 未満なら弾く。 */
    let shortBase64 = "";

    try {
      await importSigningKey(base64UrlEncode(new Uint8Array(8)));
    } catch (error) {
      shortBase64 = error.message;
    }

    check('base64 の 8 バイト（11 文字）は拒否', shortBase64.includes('SESSION_SECRET'), shortBase64);

    check('壊れた形は MALFORMED', (await verifyValue(key, 'ゴミ', { nowMs: NOW })).reason === 'MALFORMED');
  }

  {
    const cookies = parseCookies('pa_session=abc.def; other=1; pa_session=zzz');

    check('Cookie を名前で引ける', cookies.pa_session === 'abc.def', JSON.stringify(cookies));
    check('同名は最初のものを採る', cookies.pa_session !== 'zzz');

    const header = buildSetCookie('pa_session', 'v', { path: '/push-assistant/', maxAgeSec: 100 });

    check('HttpOnly を付ける', header.includes('HttpOnly'), header);
    check('Secure を付ける', header.includes('Secure'), header);
    check('SameSite=Lax を付ける', header.includes('SameSite=Lax'), header);
    check('Path を /push-assistant/ に絞る', header.includes('Path=/push-assistant/'), header);

    const cleared = buildSetCookie('pa_session', '', { path: '/push-assistant/', maxAgeSec: 0 });

    check('削除は Max-Age=0', cleared.includes('Max-Age=0'), cleared);
  }

  {
    /* 32 バイトの鍵（テスト用の固定値。本番はシークレット）。 */
    const keyText = base64UrlEncode(new Uint8Array(32).fill(7));
    const key = await importEncryptionKey(keyText);

    const secretValue = '1//0e-リフレッシュトークンのような値';
    const encrypted = await encryptString(key, secretValue);

    check('暗号文に元の値が残らない', encrypted.includes('リフレッシュ') === false);
    check('復号すると元に戻る', (await decryptString(key, encrypted)) === secretValue);

    const again = await encryptString(key, secretValue);

    check('同じ値でも毎回違う暗号文（IV が乱数）', again !== encrypted);

    let rejected = false;

    try {
      const other = await importEncryptionKey(base64UrlEncode(new Uint8Array(32).fill(9)));
      await decryptString(other, encrypted);
    } catch {
      rejected = true;
    }

    check('別の鍵では復号できない', rejected === true);

    let shortKeyRejected = '';

    try {
      await importEncryptionKey(base64UrlEncode(new Uint8Array(16)));
    } catch (error) {
      shortKeyRejected = error.message;
    }

    check('16 バイトの鍵は名前を挙げて拒否', shortKeyRejected.includes('TOKEN_ENCRYPTION_KEY'), shortKeyRejected);
    check('拒否のメッセージに鍵の中身を入れない', shortKeyRejected.includes('AAAA') === false, shortKeyRejected);
  }

  {
    check(
      '定数時間比較は長さ違いを false にする',
      timingSafeEqual(Uint8Array.of(1, 2), Uint8Array.of(1, 2, 3)) === false,
    );
    check('同じ内容なら true', timingSafeEqual(Uint8Array.of(1, 2), Uint8Array.of(1, 2)) === true);

    const verifier = randomBase64Url(32);
    const challenge = await sha256Base64Url(verifier);

    check('PKCE の code_verifier は base64url', /^[A-Za-z0-9_-]+$/.test(verifier), verifier);
    check('code_challenge は 43 文字（SHA-256 の base64url）', challenge.length === 43, challenge);
  }

  /* ---------------------------------------------------------------- */
  section('OAuth — 同意画面と id_token');

  {
    const url = buildAuthUrl({
      clientId: 'client-123.apps.googleusercontent.com',
      redirectUri: 'https://tsam-ai.com/push-assistant/api/auth/callback',
      state: 'st',
      codeChallenge: 'ch',
      scopes: ['openid', 'email', 'https://www.googleapis.com/auth/calendar.events.readonly'],
    });

    const parsed = new URL(url);

    check('同意画面は accounts.google.com', parsed.host === 'accounts.google.com', parsed.host);
    check('access_type=offline（リフレッシュトークンを得る）', parsed.searchParams.get('access_type') === 'offline');
    check('prompt=consent（再接続でも必ず得る）', parsed.searchParams.get('prompt') === 'consent');
    check('PKCE は S256', parsed.searchParams.get('code_challenge_method') === 'S256');
    check(
      'スコープは calendar.events.readonly まで（書き込み権限を求めない）',
      parsed.searchParams.get('scope').includes('calendar.events.readonly')
      && parsed.searchParams.get('scope').includes('calendar.readonly ') === false,
      parsed.searchParams.get('scope'),
    );
  }

  {
    const makeIdToken = (claims) => `x.${base64UrlEncode(encoder.encode(JSON.stringify(claims)))}.y`;

    const good = parseIdToken(
      makeIdToken({
        iss: 'https://accounts.google.com',
        aud: 'client-123',
        exp: Math.floor(NOW / 1000) + 600,
        sub: 'sub-1',
        email: 'a@example.com',
      }),
      { clientId: 'client-123', nowMs: NOW },
    );

    check('正しい id_token から sub を取れる', good.ok === true && good.claims.sub === 'sub-1', JSON.stringify(good));

    const shortIssuer = parseIdToken(
      makeIdToken({ iss: 'accounts.google.com', aud: 'client-123', exp: Math.floor(NOW / 1000) + 600, sub: 's' }),
      { clientId: 'client-123', nowMs: NOW },
    );

    check('iss は 2 種類とも受け付ける', shortIssuer.ok === true);

    const badIssuer = parseIdToken(
      makeIdToken({ iss: 'https://evil.example', aud: 'client-123', exp: Math.floor(NOW / 1000) + 600, sub: 's' }),
      { clientId: 'client-123', nowMs: NOW },
    );

    check('別の発行者は拒否', badIssuer.ok === false && badIssuer.reason === 'BAD_ISSUER');

    const badAudience = parseIdToken(
      makeIdToken({ iss: 'accounts.google.com', aud: 'other', exp: Math.floor(NOW / 1000) + 600, sub: 's' }),
      { clientId: 'client-123', nowMs: NOW },
    );

    check('別のクライアント ID 向けは拒否', badAudience.reason === 'BAD_AUDIENCE');

    const expired = parseIdToken(
      makeIdToken({ iss: 'accounts.google.com', aud: 'client-123', exp: Math.floor(NOW / 1000) - 1, sub: 's' }),
      { clientId: 'client-123', nowMs: NOW },
    );

    check('期限切れは拒否', expired.reason === 'EXPIRED');
  }

  {
    const invalidGrant = await refreshAccessToken({
      refreshToken: 'rt',
      clientId: 'c',
      clientSecret: 's',
      fetchImpl: createFetch([{ match: 'oauth2.googleapis.com/token', handler: jsonResponse({ error: 'invalid_grant' }, 400) }]),
    });

    check(
      'invalid_grant を他の失敗と区別する',
      invalidGrant.ok === false && invalidGrant.invalidGrant === true,
      JSON.stringify(invalidGrant),
    );

    const temporary = await refreshAccessToken({
      refreshToken: 'rt',
      clientId: 'c',
      clientSecret: 's',
      fetchImpl: createFetch([{ match: 'oauth2.googleapis.com/token', handler: jsonResponse({ error: 'backend_error' }, 500) }]),
    });

    check('5xx は invalidGrant ではない（後でやり直す）', temporary.invalidGrant === false, JSON.stringify(temporary));

    const okResult = await refreshAccessToken({
      refreshToken: 'rt',
      clientId: 'c',
      clientSecret: 's',
      fetchImpl: createFetch([
        { match: 'oauth2.googleapis.com/token', handler: jsonResponse({ access_token: 'at-new', expires_in: 3599 }) },
      ]),
    });

    check('成功するとアクセストークンを返す', okResult.ok === true && okResult.accessToken === 'at-new');
    check('refresh_token が無ければ空文字', okResult.refreshToken === '', okResult.refreshToken);

    const rotated = await refreshAccessToken({
      refreshToken: 'rt-old',
      clientId: 'c',
      clientSecret: 's',
      fetchImpl: createFetch([
        { match: 'oauth2.googleapis.com/token', handler: jsonResponse({ access_token: 'at-new', refresh_token: 'rt-new', expires_in: 3599 }) },
      ]),
    });

    check('新しい refresh_token が返れば拾う', rotated.refreshToken === 'rt-new', rotated.refreshToken);
  }

  /* ---------------------------------------------------------------- */
  section('Web Push — RFC 8291 の暗号化を往復で確かめる');

  const receiver = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const receiverPublic = new Uint8Array(await crypto.subtle.exportKey('raw', receiver.publicKey));
  const receiverAuth = crypto.getRandomValues(new Uint8Array(16));

  const subscriptionKeys = {
    p256dh: base64UrlEncode(receiverPublic),
    auth: base64UrlEncode(receiverAuth),
  };

  /** テスト側で RFC 8291 の受信側手順をなぞる。 */
  async function decryptWebPush(body) {
    const salt = body.slice(0, 16);
    const recordSize = new DataView(body.buffer, body.byteOffset + 16, 4).getUint32(0, false);
    const keyLength = body[20];
    const serverPublic = body.slice(21, 21 + keyLength);
    const ciphertext = body.slice(21 + keyLength);

    const serverKey = await crypto.subtle.importKey('raw', serverPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const shared = new Uint8Array(
      await crypto.subtle.deriveBits({ name: 'ECDH', public: serverKey }, receiver.privateKey, 256),
    );

    const keyInfo = concat([encoder.encode('WebPush: info'), Uint8Array.of(0x00), receiverPublic, serverPublic]);
    const ikm = await hkdf(receiverAuth, shared, keyInfo, 32);

    const cek = await hkdf(salt, ikm, concat([encoder.encode('Content-Encoding: aes128gcm'), Uint8Array.of(0)]), 16);
    const nonce = await hkdf(salt, ikm, concat([encoder.encode('Content-Encoding: nonce'), Uint8Array.of(0)]), 12);

    const aesKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['decrypt']);
    const record = new Uint8Array(
      await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, aesKey, ciphertext),
    );

    return {
      recordSize,
      keyLength,
      delimiter: record[record.length - 1],
      plaintext: decoder.decode(record.slice(0, record.length - 1)),
    };
  }

  {
    const message = JSON.stringify({
      v: 1,
      kind: 'event',
      title: '定例会議',
      body: '18:00 開始（あと10分）',
      url: 'https://meet.google.com/abc-defg-hij',
      tag: 'pa:ev1:10',
    });

    const { body } = await encryptPayload({ ...subscriptionKeys, plaintext: message });

    const decrypted = await decryptWebPush(body);

    check('★受信者の鍵で復号でき、平文が一致する', decrypted.plaintext === message, decrypted.plaintext.slice(0, 80));
    check('rs は 4096', decrypted.recordSize === 4096, String(decrypted.recordSize));
    check('keyid は 65 バイトの非圧縮公開鍵', decrypted.keyLength === 65, String(decrypted.keyLength));
    check('単一レコードの区切りは 0x02', decrypted.delimiter === 2, String(decrypted.delimiter));
    check('本文は salt(16)+rs(4)+idlen(1)+key(65) の後ろに暗号文', body.length > 86 && body.length < 4096);

    const again = await encryptPayload({ ...subscriptionKeys, plaintext: message });

    check('毎回違う暗号文（salt と一時鍵が乱数）', base64UrlEncode(again.body) !== base64UrlEncode(body));
  }

  {
    let rejected = '';

    try {
      await encryptPayload({ p256dh: base64UrlEncode(new Uint8Array(10)), auth: subscriptionKeys.auth, plaintext: 'x' });
    } catch (error) {
      rejected = error.message;
    }

    check('壊れた p256dh は長さを挙げて拒否', rejected.includes('p256dh'), rejected);

    let tooLong = '';

    try {
      await encryptPayload({ ...subscriptionKeys, plaintext: 'あ'.repeat(2000) });
    } catch (error) {
      tooLong = error.message;
    }

    check('4KB を超える本文は組み立てない', tooLong.includes('上限'), tooLong);

    /*
     * ------------------------------------------------------------------
     * 上限は 4096 ではなく 3993
     * ------------------------------------------------------------------
     * push サービスが見るのは**ヘッダ込みの本文サイズ**。
     * salt(16)+rs(4)+idlen(1)+keyid(65) の 86 バイトと、
     * GCM の認証タグ 16、区切り 1 を引いた残りしか平文に使えない。
     * ここを 4096-16-1 にしていると、境界付近のペイロードが
     * 「送信は試みるが必ず 413」という直りようのない形で失敗する。
     * ------------------------------------------------------------------
     */
    check('平文の上限は 3993 バイト', MAX_PLAINTEXT_BYTES === 3993, String(MAX_PLAINTEXT_BYTES));

    const atLimit = await encryptPayload({ ...subscriptionKeys, plaintext: 'a'.repeat(MAX_PLAINTEXT_BYTES) });

    check('★上限ちょうどは通り、本文全体が 4096 に収まる', atLimit.body.length === 4096, String(atLimit.body.length));

    let overLimit = '';

    try {
      await encryptPayload({ ...subscriptionKeys, plaintext: 'a'.repeat(MAX_PLAINTEXT_BYTES + 1) });
    } catch (error) {
      overLimit = error.message;
    }

    check('1 バイト超えたら組み立てない', overLimit.includes('上限'), overLimit);
    check('拒否のメッセージに本文を入れない', tooLong.includes('あああ') === false, tooLong);
  }

  /* VAPID の鍵ペア（テストの中で作る）。 */
  const vapidPair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const vapidPkcs8 = base64UrlEncode(new Uint8Array(await crypto.subtle.exportKey('pkcs8', vapidPair.privateKey)));
  const vapidPublicBytes = new Uint8Array(await crypto.subtle.exportKey('raw', vapidPair.publicKey));

  const vapid = {
    privateKey: await importVapidPrivateKey(vapidPkcs8),
    publicKey: base64UrlEncode(vapidPublicBytes),
    subject: APP_URL,
  };

  {
    const authorization = await buildVapidAuthorization({
      endpoint: 'https://fcm.googleapis.com/fcm/send/abcdef',
      privateKey: vapid.privateKey,
      publicKeyBase64Url: vapid.publicKey,
      subject: APP_URL,
      nowMs: NOW,
    });

    check('スキームは vapid', authorization.startsWith('vapid t='), authorization.slice(0, 20));

    const parts = authorization.slice('vapid '.length).split(', ');
    const jwt = parts[0].slice('t='.length);
    const key = parts[1].slice('k='.length);

    check('k= は VAPID 公開鍵（base64url の 65 バイト）', key === vapid.publicKey, key.slice(0, 16));

    const [header, claims, signature] = jwt.split('.');
    const decodedClaims = JSON.parse(decoder.decode(base64ToBytes(claims)));

    check('aud は endpoint の origin（パスを含めない）', decodedClaims.aud === 'https://fcm.googleapis.com', decodedClaims.aud);
    check('sub は連絡先 URI', decodedClaims.sub === APP_URL, decodedClaims.sub);
    check(
      'exp は 12 時間以内（RFC 8292 の上限 24 時間より短い）',
      decodedClaims.exp > NOW / 1000 && decodedClaims.exp <= NOW / 1000 + 12 * 3600,
      String(decodedClaims.exp),
    );

    const verified = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      vapidPair.publicKey,
      base64ToBytes(signature),
      encoder.encode(`${header}.${claims}`),
    );

    check('署名は VAPID 公開鍵で検証できる', verified === true);
  }

  {
    const subscription = { id: 1, endpoint: 'https://fcm.googleapis.com/fcm/send/abc', ...subscriptionKeys };

    const sent = [];

    const okResult = await sendWebPush({
      subscription,
      payload: { v: 1, kind: 'test' },
      vapid,
      nowMs: NOW,
      fetchImpl: async (url, options) => {
        sent.push(options);
        return new Response(null, { status: 201 });
      },
    });

    check('201 は成功', okResult.ok === true && okResult.status === 201, JSON.stringify(okResult));
    check('Content-Encoding: aes128gcm', sent[0].headers['Content-Encoding'] === 'aes128gcm');
    check('Content-Type: application/octet-stream', sent[0].headers['Content-Type'] === 'application/octet-stream');
    check('TTL を付ける', sent[0].headers.TTL === '600', sent[0].headers.TTL);
    check('Urgency: high（時刻に間に合わせる通知）', sent[0].headers.Urgency === 'high');
    check('Authorization は vapid スキーム', String(sent[0].headers.Authorization).startsWith('vapid t='));

    const gone = await sendWebPush({
      subscription,
      payload: {},
      vapid,
      nowMs: NOW,
      fetchImpl: async () => new Response(null, { status: 410 }),
    });

    check('410 は gone（購読を無効化する）', gone.gone === true && gone.retryable === false, JSON.stringify(gone));

    const temporary = await sendWebPush({
      subscription,
      payload: {},
      vapid,
      nowMs: NOW,
      fetchImpl: async () => new Response(null, { status: 503 }),
    });

    check('503 は retryable', temporary.retryable === true && temporary.gone === false, JSON.stringify(temporary));

    const rejected = await sendWebPush({
      subscription,
      payload: {},
      vapid,
      nowMs: NOW,
      fetchImpl: async () => new Response(null, { status: 400 }),
    });

    check('400 は再試行しない（送り直しても直らない）', rejected.retryable === false && rejected.gone === false);

    const offline = await sendWebPush({
      subscription,
      payload: {},
      vapid,
      nowMs: NOW,
      fetchImpl: async () => { throw new Error('接続できません'); },
    });

    check('通信断は例外にせず retryable', offline.ok === false && offline.retryable === true);
  }

  /* ---------------------------------------------------------------- */
  section('D / I / J — runTick');

  /* tick を回すための道具立て。 */
  const encryptionKey = await importEncryptionKey(base64UrlEncode(new Uint8Array(32).fill(3)));
  const refreshTokenEnc = await encryptString(encryptionKey, 'refresh-token-value');

  /**
   * tick 1 回ぶんの一式を組む。
   *
   * calendarItems … 利用者 ID ごとに返す予定（配列 or {status} で失敗）
   * pushResponses … push endpoint ごとに順に返す状態コード
   */
  function createTickWorld({ users, calendarByUser, pushPlan, overrides }) {
    const seedUsers = [];
    const seedTokens = [];
    const seedSubscriptions = [];

    for (const user of users) {
      seedUsers.push({
        id: user.id,
        email: `${user.id}@example.com`,
        leadMinutes: user.leadMinutes ?? [10],
        notifyTitle: user.notifyTitle ?? '',
        notifyBody: user.notifyBody ?? '',
        notifyUrl: user.notifyUrl ?? '',
      });
      seedTokens.push({
        userId: user.id,
        refreshTokenEnc,
        /* アクセストークンのキャッシュを有効にして、refresh を呼ばせない。 */
        accessTokenEnc: user.accessTokenEnc ?? null,
        accessTokenExpiresAt: user.accessTokenExpiresAt ?? '',
      });
      seedSubscriptions.push({
        userId: user.id,
        endpoint: `https://fcm.googleapis.com/fcm/send/${user.id}`,
        ...subscriptionKeys,
      });
    }

    const store = createFakeStore({
      users: seedUsers,
      tokens: seedTokens,
      subscriptions: seedSubscriptions,
      overrides: overrides ?? [],
    });

    const pushCalls = [];
    const pushBodies = [];

    const fetchImpl = createFetch([
      {
        match: 'oauth2.googleapis.com/token',
        handler: () => jsonResponse({ access_token: 'at-fresh', expires_in: 3600 }),
      },
      {
        match: 'calendar/v3',
        handler: ({ options }) => {
          /* どの利用者かはアクセストークンでは分からないので、順番で決める。 */
          const index = fetchImpl.calls.filter((call) => call.url.includes('calendar/v3')).length - 1;
          const userId = users[Math.min(index, users.length - 1)].id;
          const plan = calendarByUser[userId];

          void options;

          if (plan && plan.status) {
            return jsonResponse({}, plan.status);
          }

          return jsonResponse({ items: plan ?? [] });
        },
      },
      {
        match: 'fcm.googleapis.com/fcm/send/',
        handler: ({ url, options }) => {
          pushCalls.push(url);
          /* 暗号化済みの本文。テンプレート試験はこれを復号して中身を確かめる。 */
          pushBodies.push(options?.body ?? null);

          const status = typeof pushPlan === 'function' ? pushPlan(url, pushCalls.length) : 201;

          return new Response(null, { status });
        },
      },
    ]);

    return { store, fetchImpl, pushCalls, pushBodies };
  }

  function tickArgs(world, nowMs) {
    return {
      store: world.store,
      vapid,
      encryptionKey,
      clientId: 'client-123',
      clientSecret: 'secret',
      appUrl: APP_URL,
      nowMs,
      fetchImpl: world.fetchImpl,
      log: () => {},
    };
  }

  {
    /* D: 10 分前になった予定を 2 回の tick で 1 回だけ送る。 */
    const world = createTickWorld({
      users: [{ id: 'u1', leadMinutes: [10] }],
      calendarByUser: {
        u1: [rawEvent({
          id: 'ev-d',
          start: { dateTime: new Date(NOW + 10 * MINUTE).toISOString() },
          conferenceData: { entryPoints: [{ entryPointType: 'video', uri: 'https://meet.google.com/ddd' }] },
        })],
      },
    });

    const first = await runTick(tickArgs(world, NOW));

    check('D: 1 回目の tick で 1 件送る', first.sent === 1 && first.planned === 1, JSON.stringify(first));
    check('D: push は 1 回だけ呼ばれた', world.pushCalls.length === 1, String(world.pushCalls.length));

    const second = await runTick(tickArgs(world, NOW + MINUTE));

    check('D: 2 回目の tick では送らない', second.sent === 0 && second.planned === 0, JSON.stringify(second));
    check('D: push の呼び出し回数は 1 のまま', world.pushCalls.length === 1, String(world.pushCalls.length));

    const rows = await world.store.listNotifications('u1', 10);

    check('D: 履歴は 1 行だけ', rows.length === 1, JSON.stringify(rows.map((r) => r.status)));
    check('D: 状態は sent', rows[0].status === 'sent', rows[0].status);
    check(
      'D: 開く URL は conference のもの',
      rows[0].openUrl === 'https://meet.google.com/ddd' && rows[0].urlSource === 'conference',
      JSON.stringify(rows[0]),
    );
  }

  {
    /*
     * リスケ（開始時刻の変更）は別キーになるので改めて通知される（§8-4）。
     *
     * **同じ store を使い回す。** 履歴を引き継いだ状態でないと、
     * 「二重通知防止をすり抜けた」のか「そもそも履歴が無かった」のかを
     * 区別できない。fetch だけを差し替えて、2 回目に別の開始時刻を返させる。
     */
    const world = createTickWorld({
      users: [{ id: 'u1', leadMinutes: [0] }],
      calendarByUser: { u1: [rawEvent({ id: 'ev-r', start: { dateTime: new Date(NOW).toISOString() } })] },
    });

    const first = await runTick(tickArgs(world, NOW));

    check('リスケ前に 1 回送っている', first.sent === 1, JSON.stringify(first));

    /* 予定が 30 分後へ動いた。store（履歴）はそのまま。 */
    const movedFetch = createFetch([
      {
        match: 'calendar/v3',
        handler: () => jsonResponse({
          items: [rawEvent({ id: 'ev-r', start: { dateTime: new Date(NOW + 30 * MINUTE).toISOString() } })],
        }),
      },
      {
        match: 'fcm.googleapis.com/fcm/send/',
        handler: ({ url }) => {
          world.pushCalls.push(url);
          return new Response(null, { status: 201 });
        },
      },
    ]);

    const after = await runTick({ ...tickArgs(world, NOW + 30 * MINUTE), fetchImpl: movedFetch });

    check('リスケ後は改めて通知される（キーに開始時刻が入る）', after.sent === 1, JSON.stringify(after));
    check(
      '履歴は 2 行になる（古い行も残る）',
      world.store._notifications.length === 2,
      JSON.stringify(world.store._notifications.map((row) => row.eventStart)),
    );
  }

  {
    /* I: 1 人目の Calendar が 500 でも、2 人目には届く。 */
    const world = createTickWorld({
      users: [{ id: 'u1', leadMinutes: [10] }, { id: 'u2', leadMinutes: [10] }],
      calendarByUser: {
        u1: { status: 500 },
        u2: [rawEvent({ id: 'ev-i', start: { dateTime: new Date(NOW + 10 * MINUTE).toISOString() } })],
      },
    });

    const result = await runTick(tickArgs(world, NOW));

    check('I: 1 人目の失敗は errors に数える', result.errors === 1, JSON.stringify(result));
    check('I: 2 人目には送信される', result.sent === 1, JSON.stringify(result));
    check('I: 送信先は 2 人目の endpoint', world.pushCalls[0].endsWith('/u2'), world.pushCalls[0]);
    check('I: 2 人とも処理を試みた', result.users === 2, String(result.users));
  }

  {
    /* I の別形: store が投げても次の利用者へ進む。 */
    const world = createTickWorld({
      users: [{ id: 'u1', leadMinutes: [10] }, { id: 'u2', leadMinutes: [10] }],
      calendarByUser: {
        u1: [rawEvent({ id: 'ev-x', start: { dateTime: new Date(NOW + 10 * MINUTE).toISOString() } })],
        u2: [rawEvent({ id: 'ev-y', start: { dateTime: new Date(NOW + 10 * MINUTE).toISOString() } })],
      },
    });

    const original = world.store.claimDueNotifications.bind(world.store);

    world.store.claimDueNotifications = async (userId, nowMs, limit) => {
      if (userId === 'u1') {
        throw new TypeError('想定外の障害');
      }

      return original(userId, nowMs, limit);
    };

    const result = await runTick(tickArgs(world, NOW));

    check('I: 想定外の例外でも tick 全体は落ちない', result.errors === 1 && result.sent === 1, JSON.stringify(result));
  }

  {
    /* J: 503 → pending / attempts=1 → 次の tick で成功。 */
    let attempt = 0;

    const world = createTickWorld({
      users: [{ id: 'u1', leadMinutes: [10] }],
      calendarByUser: {
        u1: [rawEvent({ id: 'ev-j', start: { dateTime: new Date(NOW + 10 * MINUTE).toISOString() } })],
      },
      pushPlan: () => {
        attempt += 1;
        return attempt === 1 ? 503 : 201;
      },
    });

    const first = await runTick(tickArgs(world, NOW));

    check('J: 503 では sent にならない', first.sent === 0 && first.failed === 0, JSON.stringify(first));

    const pending = world.store._notifications[0];

    check('J: 状態は pending に戻る', pending.status === 'pending', pending.status);
    check('J: attempts は 1', pending.attempts === 1, String(pending.attempts));

    const second = await runTick(tickArgs(world, NOW + MINUTE));

    check('J: 次の tick で送信に成功する', second.sent === 1, JSON.stringify(second));
    check('J: 状態は sent、attempts は 2', pending.status === 'sent' && pending.attempts === 2, JSON.stringify(pending));
  }

  {
    /* J: 410 を受けたら購読を無効化する。 */
    const world = createTickWorld({
      users: [{ id: 'u1', leadMinutes: [10] }],
      calendarByUser: {
        u1: [rawEvent({ id: 'ev-g', start: { dateTime: new Date(NOW + 10 * MINUTE).toISOString() } })],
      },
      pushPlan: () => 410,
    });

    const result = await runTick(tickArgs(world, NOW));

    check('J: 410 は再試行しない（failed）', result.failed === 1 && result.sent === 0, JSON.stringify(result));
    check('J: 購読が無効化される', world.store._subscriptions[0].disabledAt !== null, JSON.stringify(world.store._subscriptions[0]));

    /* 無効化された購読しか無い利用者は、次の tick の対象から外れる。 */
    const next = await runTick(tickArgs(world, NOW + MINUTE));

    check('J: 送り先が無くなった利用者は tick の対象外', next.users === 0, JSON.stringify(next));
  }

  {
    /* J: 再試行の上限。MAX_ATTEMPTS に達したら failed。 */
    const world = createTickWorld({
      users: [{ id: 'u1', leadMinutes: [10] }],
      calendarByUser: {
        u1: [rawEvent({ id: 'ev-m', start: { dateTime: new Date(NOW + 10 * MINUTE).toISOString() } })],
      },
      pushPlan: () => 503,
    });

    for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
      await runTick(tickArgs(world, NOW + i * MINUTE));
    }

    const row = world.store._notifications[0];

    check(
      `J: ${MAX_ATTEMPTS} 回で打ち切る（failed）`,
      row.status === 'failed' && row.attempts === MAX_ATTEMPTS,
      JSON.stringify(row),
    );
    check('J: 失敗の理由を残す', row.lastError.includes('503'), row.lastError);
  }

  {
    /* J: 時間でも打ち切る（STALE_PENDING_MS）。 */
    const world = createTickWorld({
      users: [{ id: 'u1', leadMinutes: [10] }],
      calendarByUser: {
        u1: [rawEvent({ id: 'ev-s', start: { dateTime: new Date(NOW + 10 * MINUTE).toISOString() } })],
      },
      pushPlan: () => 503,
    });

    await runTick(tickArgs(world, NOW));

    /* notify_at から STALE_PENDING_MS 以上たった状態で、もう一度。 */
    const late = await runTick(tickArgs(world, NOW + STALE_PENDING_MS + MINUTE));

    check(
      'J: 古くなった pending は attempts に関係なく failed',
      late.failed === 1 && world.store._notifications[0].status === 'failed',
      JSON.stringify(world.store._notifications[0]),
    );
  }

  {
    /* 遅れすぎた予定は skipped として履歴に残す（送らない）。 */
    const world = createTickWorld({
      users: [{ id: 'u1', leadMinutes: [0] }],
      calendarByUser: {
        u1: [rawEvent({ id: 'ev-skip', start: { dateTime: new Date(NOW - DUE_GRACE_MS - MINUTE).toISOString() } })],
      },
    });

    const result = await runTick(tickArgs(world, NOW));

    check('遅れすぎた予定は skipped', result.skipped === 1 && result.sent === 0, JSON.stringify(result));
    check('push は呼ばれない', world.pushCalls.length === 0);
    check('履歴には残る', world.store._notifications[0].status === 'skipped');
  }

  {
    /* invalid_grant を受けたら、その利用者を以後の対象から外す。 */
    const store = createFakeStore({
      users: [{ id: 'u1', leadMinutes: [10] }],
      tokens: [{ userId: 'u1', refreshTokenEnc }],
      subscriptions: [{ userId: 'u1', endpoint: 'https://fcm.googleapis.com/fcm/send/u1', ...subscriptionKeys }],
    });

    const fetchImpl = createFetch([
      { match: 'oauth2.googleapis.com/token', handler: () => jsonResponse({ error: 'invalid_grant' }, 400) },
    ]);

    const result = await runTick({
      store,
      vapid,
      encryptionKey,
      clientId: 'c',
      clientSecret: 's',
      appUrl: APP_URL,
      nowMs: NOW,
      fetchImpl,
      log: () => {},
    });

    check('invalid_grant は errors に数える', result.errors === 1, JSON.stringify(result));
    check('google_tokens に invalid_at が立つ', store._tokens.get('u1').invalidAt !== null);

    const next = await runTick({
      store,
      vapid,
      encryptionKey,
      clientId: 'c',
      clientSecret: 's',
      appUrl: APP_URL,
      nowMs: NOW + MINUTE,
      fetchImpl,
      log: () => {},
    });

    check('以後 tick の対象から外れる（Google を叩き続けない）', next.users === 0, JSON.stringify(next));
  }

  {
    /*
     * 送信の途中で isolate が落ちると 'sending' のまま残る。
     * **拾い直せないと、その通知は永久に届かない。**
     */
    const world = createTickWorld({
      users: [{ id: 'u1', leadMinutes: [10] }],
      calendarByUser: {
        u1: [rawEvent({ id: 'ev-stuck', start: { dateTime: new Date(NOW + 10 * MINUTE).toISOString() } })],
      },
    });

    /* 1 回目: claim した直後に落ちた状態を作る。 */
    const original = world.store.listActiveSubscriptions.bind(world.store);

    world.store.listActiveSubscriptions = async () => {
      throw new TypeError('送信の直前で落ちた');
    };

    await runTick(tickArgs(world, NOW));

    world.store.listActiveSubscriptions = original;

    const stuck = world.store._notifications[0];

    check('落ちた行は sending のまま残る', stuck.status === 'sending', stuck.status);

    /* すぐの tick では拾わない（送信中かもしれないので二重送信しない）。 */
    const soon = await runTick(tickArgs(world, NOW + MINUTE));

    check('直後の tick では拾い直さない（二重送信を避ける）', soon.sent === 0, JSON.stringify(soon));

    /* STUCK_SENDING_MS を超えたら拾い直す。 */
    const later = await runTick(tickArgs(world, NOW + STUCK_SENDING_MS + MINUTE));

    check('★取り残された sending は拾い直して送る', later.sent === 1, JSON.stringify(later));
    check('状態は sent になる', stuck.status === 'sent', stuck.status);
  }

  {
    /*
     * ------------------------------------------------------------------
     * 利用者が上限を超えても、次の分には後ろの人へ順番が回る
     * ------------------------------------------------------------------
     * id 順に固定していると、MAX_USERS_PER_TICK を超えた瞬間に
     * **後ろの人へ永久に順番が回らない**（毎分同じ先頭を処理し続ける）。
     * しかも「特定の人にだけ通知が来ない」としか見えず、ログにも出ない。
     * ------------------------------------------------------------------
     */
    const world = createTickWorld({
      users: [{ id: 'u1' }, { id: 'u2' }, { id: 'u3' }],
      calendarByUser: { u1: [], u2: [], u3: [] },
    });

    const first = await runTick({ ...tickArgs(world, NOW), maxUsers: 2 });

    check('1 回目は 2 人だけ処理する', first.users === 2, JSON.stringify(first));

    const touchedFirst = [...world.store._users.values()]
      .filter((user) => user.lastTickAt !== null)
      .map((user) => user.id);

    check('処理した人に印が付く', touchedFirst.length === 2, JSON.stringify(touchedFirst));

    const second = await runTick({ ...tickArgs(world, NOW + MINUTE), maxUsers: 2 });

    check('2 回目も 2 人処理する', second.users === 2, JSON.stringify(second));

    const everyone = [...world.store._users.values()].every((user) => user.lastTickAt !== null);

    check('★2 回の tick で 3 人全員に順番が回る', everyone === true, JSON.stringify([...world.store._users.values()].map((u) => [u.id, u.lastTickAt])));

    /* 一番古い印の人が先頭に来る。 */
    const order = await world.store.listActiveUsers(3);

    check('並び順は最後に処理した時刻の古い順', order[0].id === 'u1' || order[0].id === 'u2', JSON.stringify(order.map((u) => u.id)));
  }

  {
    /* 失敗した人にも印が付く（居座って後ろの順番を食い潰さないこと）。 */
    const world = createTickWorld({
      users: [{ id: 'u1' }],
      calendarByUser: { u1: { status: 500 } },
    });

    await runTick(tickArgs(world, NOW));

    check('失敗した利用者にも last_tick_at が付く', world.store._users.get('u1').lastTickAt !== null);
  }

  check('subrequest 予算に収まる人数にしてある（15 × 3 = 45 < 50）', MAX_USERS_PER_TICK === 15, String(MAX_USERS_PER_TICK));

  {
    /*
     * ------------------------------------------------------------------
     * 11. Google がリフレッシュトークンを差し替えてきたら、それを保存する
     * ------------------------------------------------------------------
     * 捨てると、古いほうが失効した時点で invalid_grant になり、
     * 利用者からは「急に接続が切れた」に見える（原因も追いにくい）。
     * ------------------------------------------------------------------
     */
    const store = createFakeStore({
      users: [{ id: 'u1', leadMinutes: [10] }],
      tokens: [{ userId: 'u1', refreshTokenEnc }],
      subscriptions: [{ userId: 'u1', endpoint: 'https://fcm.googleapis.com/fcm/send/u1', ...subscriptionKeys }],
    });

    const fetchImpl = createFetch([
      {
        match: 'oauth2.googleapis.com/token',
        handler: () => jsonResponse({ access_token: 'at-1', refresh_token: 'rt-rotated', expires_in: 3599 }),
      },
      { match: 'calendar/v3', handler: () => jsonResponse({ items: [] }) },
    ]);

    await runTick({
      store,
      vapid,
      encryptionKey,
      clientId: 'c',
      clientSecret: 's',
      appUrl: APP_URL,
      nowMs: NOW,
      fetchImpl,
      log: () => {},
    });

    const saved = store._tokens.get('u1');

    check('★新しいリフレッシュトークンを保存する', (await decryptString(encryptionKey, saved.refreshTokenEnc)) === 'rt-rotated');
    check('保存は暗号化して行う', saved.refreshTokenEnc.includes('rt-rotated') === false, saved.refreshTokenEnc);
  }

  {
    /* 返ってこなかったときは既存のリフレッシュトークンを潰さない。 */
    const store = createFakeStore({
      users: [{ id: 'u1', leadMinutes: [10] }],
      tokens: [{ userId: 'u1', refreshTokenEnc }],
      subscriptions: [{ userId: 'u1', endpoint: 'https://fcm.googleapis.com/fcm/send/u1', ...subscriptionKeys }],
    });

    await runTick({
      store,
      vapid,
      encryptionKey,
      clientId: 'c',
      clientSecret: 's',
      appUrl: APP_URL,
      nowMs: NOW,
      fetchImpl: createFetch([
        { match: 'oauth2.googleapis.com/token', handler: () => jsonResponse({ access_token: 'at-1', expires_in: 3599 }) },
        { match: 'calendar/v3', handler: () => jsonResponse({ items: [] }) },
      ]),
      log: () => {},
    });

    check('返ってこなければ既存の値を残す', (await decryptString(encryptionKey, store._tokens.get('u1').refreshTokenEnc)) === 'refresh-token-value');
  }

  {
    /* 通知オフの利用者は対象外。 */
    const store = createFakeStore({
      users: [{ id: 'u1', notifyEnabled: false }],
      tokens: [{ userId: 'u1', refreshTokenEnc }],
      subscriptions: [{ userId: 'u1', endpoint: 'https://fcm.googleapis.com/fcm/send/u1', ...subscriptionKeys }],
    });

    check('通知オフは listActiveUsers に出ない', (await store.listActiveUsers(MAX_USERS_PER_TICK)).length === 0);
  }

  /* ---------------------------------------------------------------- */
  section('HTTP — エンドポイント');

  const sessionSecret = 'テスト用のセッション秘密（十分に長い値）';

  async function makeSessionCookie(sub, email = 'a@example.com') {
    const key = await importSigningKey(sessionSecret);

    return signValue(key, {
      sub,
      email,
      iat: Math.floor(NOW / 1000),
      exp: Math.floor(NOW / 1000) + 3600,
    });
  }

  {
    const response = await worker.fetch(
      new Request('https://tsam-ai.com/push-assistant/api/health'),
      {},
    );
    const body = await response.json();

    check('health は 200', response.status === 200 && body.ok === true, JSON.stringify(body));
    check('health はサービス名を返す', body.service === 'push-assistant', JSON.stringify(body));
    check('X-Content-Type-Options を付ける', response.headers.get('X-Content-Type-Options') === 'nosniff');
    /*
     * frame-ancestors は <meta> では無視される指令なので、**ヘッダで返す**
     * 必要がある（http.mjs の SECURITY_HEADERS）。
     */
    check(
      'CSP ヘッダで frame-ancestors を禁じる',
      response.headers.get('Content-Security-Policy') === "frame-ancestors 'none'",
      response.headers.get('Content-Security-Policy'),
    );
    check('X-Frame-Options: DENY も返す（古い実装の保険）', response.headers.get('X-Frame-Options') === 'DENY');
    check('Referrer-Policy を付ける', response.headers.get('Referrer-Policy') === 'no-referrer');
    check('API はキャッシュさせない', response.headers.get('Cache-Control') === 'no-store');
  }

  {
    const response = await worker.fetch(
      new Request('https://tsam-ai.com/push-assistant/api/health/'),
      {},
    );

    check('末尾スラッシュ付きでも同じ経路', response.status === 200);
  }

  {
    /*
     * 9. health は GET だけ。POST は Origin 照合を経てから 404 になる
     * （照合より前に応答する経路を 1 本も作らない）。
     */
    const env = { APP_ORIGIN: "https://tsam-ai.com" };

    const noOrigin = await worker.fetch(
      new Request("https://tsam-ai.com/push-assistant/api/health", { method: "POST" }),
      env,
    );

    check('health への POST は Origin が無ければ 403', noOrigin.status === 403, String(noOrigin.status));

    const withOrigin = await worker.fetch(
      new Request("https://tsam-ai.com/push-assistant/api/health", {
        method: "POST",
        headers: { Origin: "https://tsam-ai.com" },
      }),
      env,
    );

    check('★health への POST は 200 を返さない（GET 専用）', withOrigin.status === 404, String(withOrigin.status));
  }

  {
    const response = await worker.fetch(
      new Request('https://tsam-ai.com/push-assistant/api/me'),
      { APP_ORIGIN: 'https://tsam-ai.com', VAPID_PUBLIC_KEY: 'BPublicKeyPlaceholder' },
    );
    const body = await response.json();

    check('未ログインでも /api/me は 200', response.status === 200, String(response.status));
    check('loggedIn は false', body.loggedIn === false, JSON.stringify(body));
    check('user は null', body.user === null);
    check('VAPID 公開鍵を返す（購読に要る）', body.vapidPublicKey === 'BPublicKeyPlaceholder', body.vapidPublicKey);
    check(
      'leadOptions は仕様どおり',
      JSON.stringify(body.leadOptions) === JSON.stringify(LEAD_OPTIONS),
      JSON.stringify(body.leadOptions),
    );
    check(
      '既定の設定を返す',
      JSON.stringify(body.settings.leadMinutes) === JSON.stringify(DEFAULT_LEAD_MINUTES),
      JSON.stringify(body.settings),
    );
  }

  {
    const cookie = await makeSessionCookie('u1');

    const store = createFakeStore({
      users: [{ id: 'u1', email: 'a@example.com', leadMinutes: [10] }],
      tokens: [{ userId: 'u1', refreshTokenEnc }],
      subscriptions: [{ userId: 'u1', endpoint: 'https://fcm.googleapis.com/fcm/send/u1', ...subscriptionKeys }],
    });

    const env = {
      APP_ORIGIN: 'https://tsam-ai.com',
      APP_BASE_PATH: '/push-assistant',
      SESSION_SECRET: sessionSecret,
      VAPID_PUBLIC_KEY: 'BPublicKeyPlaceholder',
      __STORE: store,
      __NOW_MS: NOW,
    };

    const response = await worker.fetch(
      new Request('https://tsam-ai.com/push-assistant/api/me', { headers: { Cookie: `pa_session=${cookie}` } }),
      env,
    );
    const body = await response.json();

    check('ログイン中は loggedIn=true', body.loggedIn === true, JSON.stringify(body));
    check('メールアドレスを返す', body.user.email === 'a@example.com');
    check('Google 接続あり', body.calendarConnected === true && body.tokenInvalid === false);
    check('購読数を返す', body.subscriptionCount === 1, String(body.subscriptionCount));
  }

  {
    /* 接続が切れている（invalid_at あり）状態。 */
    const cookie = await makeSessionCookie('u1');

    const store = createFakeStore({
      users: [{ id: 'u1' }],
      tokens: [{ userId: 'u1', refreshTokenEnc, invalidAt: '2026-08-26T00:00:00.000Z' }],
    });

    const response = await worker.fetch(
      new Request('https://tsam-ai.com/push-assistant/api/me', { headers: { Cookie: `pa_session=${cookie}` } }),
      {
        APP_ORIGIN: 'https://tsam-ai.com',
        SESSION_SECRET: sessionSecret,
        __STORE: store,
        __NOW_MS: NOW,
      },
    );
    const body = await response.json();

    check('tokenInvalid を伝える（再接続を促せる）', body.tokenInvalid === true && body.calendarConnected === false, JSON.stringify(body));
  }

  {
    /* Origin 照合。 */
    const env = { APP_ORIGIN: 'https://tsam-ai.com', SESSION_SECRET: sessionSecret };

    const wrong = await worker.fetch(
      new Request('https://tsam-ai.com/push-assistant/api/auth/logout', {
        method: 'POST',
        headers: { Origin: 'https://evil.example' },
      }),
      env,
    );
    const wrongBody = await wrong.json();

    check('Origin が違う POST は 403', wrong.status === 403 && wrongBody.error.code === 'FORBIDDEN_ORIGIN', JSON.stringify(wrongBody));

    const missing = await worker.fetch(
      new Request('https://tsam-ai.com/push-assistant/api/auth/logout', { method: 'POST' }),
      env,
    );

    check('Origin が無い POST も 403（ブラウザ以外）', missing.status === 403);

    const right = await worker.fetch(
      new Request('https://tsam-ai.com/push-assistant/api/auth/logout', {
        method: 'POST',
        headers: { Origin: 'https://tsam-ai.com', Cookie: `pa_session=${await makeSessionCookie('u1')}` },
      }),
      { ...env, APP_BASE_PATH: '/push-assistant', __NOW_MS: NOW },
    );

    check('Origin が合えば通る', right.status === 200, String(right.status));
    check(
      'ログアウトは Cookie を消す',
      String(right.headers.get('Set-Cookie')).includes('Max-Age=0'),
      right.headers.get('Set-Cookie'),
    );

    const unauthenticated = await worker.fetch(
      new Request('https://tsam-ai.com/push-assistant/api/push/test', {
        method: 'POST',
        headers: { Origin: 'https://tsam-ai.com' },
      }),
      env,
    );

    check('未ログインの POST は 401', unauthenticated.status === 401, String(unauthenticated.status));
  }

  {
    /* I の後半: /api/events が 502 でも /api/me は 200 のまま。 */
    const cookie = await makeSessionCookie('u1');

    const store = createFakeStore({
      users: [{ id: 'u1', email: 'a@example.com' }],
      tokens: [{
        userId: 'u1',
        refreshTokenEnc,
        accessTokenEnc: await encryptString(encryptionKey, 'at-cached'),
        accessTokenExpiresAt: new Date(NOW + HOUR).toISOString(),
      }],
    });

    const env = {
      APP_ORIGIN: 'https://tsam-ai.com',
      APP_BASE_PATH: '/push-assistant',
      SESSION_SECRET: sessionSecret,
      TOKEN_ENCRYPTION_KEY: base64UrlEncode(new Uint8Array(32).fill(3)),
      GOOGLE_CLIENT_ID: 'client-123',
      GOOGLE_CLIENT_SECRET: 'secret',
      VAPID_PUBLIC_KEY: 'BPublicKeyPlaceholder',
      __STORE: store,
      __NOW_MS: NOW,
      __FETCH: createFetch([{ match: 'calendar/v3', handler: () => jsonResponse({}, 500) }]),
    };

    const events = await worker.fetch(
      new Request('https://tsam-ai.com/push-assistant/api/events', { headers: { Cookie: `pa_session=${cookie}` } }),
      env,
    );
    const eventsBody = await events.json();

    check(
      'I: Calendar が落ちたら 502 と CALENDAR_ERROR',
      events.status === 502 && eventsBody.error.code === 'CALENDAR_ERROR',
      JSON.stringify(eventsBody),
    );

    const me = await worker.fetch(
      new Request('https://tsam-ai.com/push-assistant/api/me', { headers: { Cookie: `pa_session=${cookie}` } }),
      env,
    );

    check('I: /api/me は 200 のまま（画面は他の部分を描ける）', me.status === 200, String(me.status));
  }

  {
    /* /api/events の成功時（フロントとの契約: items 配列）。 */
    const cookie = await makeSessionCookie('u1');

    const store = createFakeStore({
      users: [{ id: 'u1', leadMinutes: [10] }],
      tokens: [{
        userId: 'u1',
        refreshTokenEnc,
        accessTokenEnc: await encryptString(encryptionKey, 'at-cached'),
        accessTokenExpiresAt: new Date(NOW + HOUR).toISOString(),
      }],
    });

    const env = {
      APP_ORIGIN: 'https://tsam-ai.com',
      APP_BASE_PATH: '/push-assistant',
      SESSION_SECRET: sessionSecret,
      TOKEN_ENCRYPTION_KEY: base64UrlEncode(new Uint8Array(32).fill(3)),
      GOOGLE_CLIENT_ID: 'client-123',
      GOOGLE_CLIENT_SECRET: 'secret',
      __STORE: store,
      __NOW_MS: NOW,
      __FETCH: createFetch([{
        match: 'calendar/v3',
        handler: () => jsonResponse({
          items: [
            rawEvent({
              id: 'ev-list',
              start: { dateTime: new Date(NOW + 2 * HOUR).toISOString() },
              end: { dateTime: new Date(NOW + 3 * HOUR).toISOString() },
              conferenceData: { entryPoints: [{ entryPointType: 'video', uri: 'https://meet.google.com/list' }] },
            }),
            rawEvent({ id: 'ev-allday', start: { date: '2026-08-27' }, end: { date: '2026-08-28' } }),
          ],
        }),
      }])
    };

    const response = await worker.fetch(
      new Request('https://tsam-ai.com/push-assistant/api/events', { headers: { Cookie: `pa_session=${cookie}` } }),
      env,
    );
    const body = await response.json();

    check('items 配列で返す', response.status === 200 && Array.isArray(body.items), JSON.stringify(body).slice(0, 120));
    check('2 件返る', body.items.length === 2, String(body.items.length));
    check(
      '開く URL と出所を添える',
      body.items[0].openUrl === 'https://meet.google.com/list' && body.items[0].urlSource === 'conference',
      JSON.stringify(body.items[0]),
    );
    check(
      '表に行が無ければ planned',
      body.items[0].notifications.length === 1 && body.items[0].notifications[0].status === 'planned',
      JSON.stringify(body.items[0].notifications),
    );
    check('終日予定は通知の予定を持たない', body.items[1].allDay === true && body.items[1].notifications.length === 0);
    check(
      '上書きが無ければ customTitle/customUrl は空文字',
      body.items[0].customTitle === '' && body.items[0].customUrl === '',
      JSON.stringify(body.items[0]),
    );
  }

  /* ---------------------------------------------------------------- */
  section('上書き — 予定ごとの通知タイトルと URL（§7・§9）');

  {
    /* resolveOpenUrl: 上書き URL は最優先で source='custom'。 */
    const event = normalizeEvent(rawEvent({
      conferenceData: { entryPoints: [{ entryPointType: 'video', uri: 'https://meet.google.com/auto' }] },
    }));

    const custom = resolveOpenUrl(event, { appUrl: APP_URL, overrideUrl: 'https://example.com/custom' });

    check(
      '★上書き URL は conference より優先され source=custom',
      custom.url === 'https://example.com/custom' && custom.source === 'custom',
      JSON.stringify(custom),
    );

    const jsUrl = resolveOpenUrl(event, { appUrl: APP_URL, overrideUrl: 'javascript:alert(1)' });

    check(
      '★不正な上書き（javascript:）は無視して従来の優先順位へ',
      jsUrl.source === 'conference' && jsUrl.url === 'https://meet.google.com/auto',
      JSON.stringify(jsUrl),
    );

    check('空の上書きは無視', resolveOpenUrl(event, { appUrl: APP_URL, overrideUrl: '' }).source === 'conference');
    check('上書き未指定でも従来どおり（後方互換）', resolveOpenUrl(event, { appUrl: APP_URL }).source === 'conference');
  }

  {
    /* globalUrl（notify_url）: override の次に最優先。conference より先。 */
    const event = normalizeEvent(rawEvent({
      conferenceData: { entryPoints: [{ entryPointType: 'video', uri: 'https://meet.google.com/auto' }] },
    }));

    const global = resolveOpenUrl(event, { appUrl: APP_URL, globalUrl: 'https://example.com/global' });

    check(
      '★globalUrl は conference より優先され source=global',
      global.url === 'https://example.com/global' && global.source === 'global',
      JSON.stringify(global),
    );

    const overrideWins = resolveOpenUrl(event, {
      appUrl: APP_URL,
      overrideUrl: 'https://example.com/custom',
      globalUrl: 'https://example.com/global',
    });

    check(
      '★override は globalUrl より優先（custom）',
      overrideWins.url === 'https://example.com/custom' && overrideWins.source === 'custom',
      JSON.stringify(overrideWins),
    );

    const badGlobal = resolveOpenUrl(event, { appUrl: APP_URL, globalUrl: 'javascript:alert(1)' });

    check(
      '★不正な globalUrl は無視して従来の自動抽出へ',
      badGlobal.source === 'conference' && badGlobal.url === 'https://meet.google.com/auto',
      JSON.stringify(badGlobal),
    );

    check(
      '空の globalUrl は無視（従来どおり）',
      resolveOpenUrl(event, { appUrl: APP_URL, globalUrl: '' }).source === 'conference',
    );

    /* 候補が全滅していても globalUrl があれば app には落ちない。 */
    const onlyGlobal = resolveOpenUrl(
      { urls: [], htmlLink: '' },
      { appUrl: APP_URL, globalUrl: 'https://example.com/g' },
    );

    check('候補が全滅でも globalUrl を採る', onlyGlobal.source === 'global' && onlyGlobal.url === 'https://example.com/g');
  }

  {
    /* planNotifications: globalUrl 指定で全予定の openUrl が globalUrl・source='global'。 */
    const events = [normalizeEvent(rawEvent({
      id: 'ev-g1',
      start: { dateTime: new Date(NOW + 10 * MINUTE).toISOString() },
      conferenceData: { entryPoints: [{ entryPointType: 'video', uri: 'https://meet.google.com/auto' }] },
    }))];

    const withGlobal = planNotifications({
      events,
      leadMinutes: [10],
      nowMs: NOW,
      appUrl: APP_URL,
      globalUrl: 'https://example.com/global',
    });

    check(
      '★planNotifications: globalUrl が全予定の openUrl になり source=global',
      withGlobal[0].openUrl === 'https://example.com/global' && withGlobal[0].urlSource === 'global',
      JSON.stringify(withGlobal[0]),
    );

    /* override があれば globalUrl より override 優先。 */
    const overrideOverGlobal = planNotifications({
      events,
      leadMinutes: [10],
      nowMs: NOW,
      appUrl: APP_URL,
      globalUrl: 'https://example.com/global',
      overrides: new Map([['ev-g1', { title: '', url: 'https://example.com/room' }]]),
    });

    check(
      '★planNotifications: override は globalUrl より優先（custom）',
      overrideOverGlobal[0].openUrl === 'https://example.com/room' && overrideOverGlobal[0].urlSource === 'custom',
      JSON.stringify(overrideOverGlobal[0]),
    );

    /* globalUrl 空なら従来の自動抽出。 */
    const noGlobal = planNotifications({ events, leadMinutes: [10], nowMs: NOW, appUrl: APP_URL, globalUrl: '' });

    check(
      'globalUrl 空なら従来どおり conference',
      noGlobal[0].urlSource === 'conference',
      JSON.stringify(noGlobal[0]),
    );
  }

  {
    /* planNotifications: 上書きでタイトルと URL が変わる。 */
    const events = [normalizeEvent(rawEvent({
      id: 'ev-ov',
      start: { dateTime: new Date(NOW + 10 * MINUTE).toISOString() },
      conferenceData: { entryPoints: [{ entryPointType: 'video', uri: 'https://meet.google.com/auto' }] },
    }))];

    const both = planNotifications({
      events,
      leadMinutes: [10],
      nowMs: NOW,
      appUrl: APP_URL,
      overrides: new Map([['ev-ov', { title: '面談（重要）', url: 'https://example.com/room' }]]),
    });

    check('★上書きタイトルが通知タイトルになる', both[0].title === '面談（重要）', JSON.stringify(both[0]));
    check(
      '★上書き URL が openUrl になり source=custom',
      both[0].openUrl === 'https://example.com/room' && both[0].urlSource === 'custom',
      JSON.stringify(both[0]),
    );

    const titleOnly = planNotifications({
      events,
      leadMinutes: [10],
      nowMs: NOW,
      appUrl: APP_URL,
      overrides: new Map([['ev-ov', { title: 'タイトルだけ', url: '' }]]),
    });

    check(
      'タイトルだけ上書きなら URL は自動抽出のまま',
      titleOnly[0].title === 'タイトルだけ' && titleOnly[0].urlSource === 'conference',
      JSON.stringify(titleOnly[0]),
    );

    const none = planNotifications({ events, leadMinutes: [10], nowMs: NOW, appUrl: APP_URL });

    check(
      'overrides 未指定なら従来どおり',
      none[0].title === '定例会議' && none[0].urlSource === 'conference',
      JSON.stringify(none[0]),
    );
  }

  {
    /* store.upsertOverride: 解除・pending への反映・sent は触らない。 */
    const store = createFakeStore({ users: [{ id: 'u1' }] });
    const iso = new Date(NOW).toISOString();

    await store.insertNotificationIfAbsent({
      userId: 'u1',
      eventId: 'ev-ov',
      eventStart: new Date(NOW + 10 * MINUTE).toISOString(),
      leadMinutes: 10,
      notifyAt: new Date(NOW).toISOString(),
      title: '自動タイトル',
      openUrl: 'https://meet.google.com/auto',
      urlSource: 'conference',
      status: 'pending',
      nowIso: iso,
    });

    const saved = await store.upsertOverride('u1', 'ev-ov', { title: '手動タイトル', url: 'https://example.com/x' }, iso);

    check('upsertOverride は保存値を返す', saved.title === '手動タイトル' && saved.url === 'https://example.com/x', JSON.stringify(saved));
    check('getOverride で読める', (await store.getOverride('u1', 'ev-ov'))?.url === 'https://example.com/x');

    const pending = store._notifications.find((row) => row.eventId === 'ev-ov');

    check(
      '★pending の通知へ上書きが即時反映される',
      pending.title === '手動タイトル' && pending.openUrl === 'https://example.com/x' && pending.urlSource === 'custom',
      JSON.stringify(pending),
    );

    const listed = await store.listOverrides('u1', ['ev-ov', 'ev-none']);

    check('listOverrides は該当分だけ Map で返す', listed.get('ev-ov')?.url === 'https://example.com/x' && !listed.has('ev-none'), JSON.stringify([...listed]));
    check('listOverrides の空 eventIds は空 Map', (await store.listOverrides('u1', [])).size === 0);

    const cleared = await store.upsertOverride('u1', 'ev-ov', { title: '', url: '' }, iso);

    check(
      '★両方空で解除（行削除）',
      cleared.title === '' && cleared.url === '' && (await store.getOverride('u1', 'ev-ov')) === null,
      JSON.stringify(cleared),
    );
    check('解除では pending 行は触らない（上書きが残る）', pending.title === '手動タイトル' && pending.urlSource === 'custom');
  }

  {
    /* upsertOverride は送信済み（sent）の通知を書き換えない。 */
    const store = createFakeStore({ users: [{ id: 'u1' }] });
    const iso = new Date(NOW).toISOString();

    await store.insertNotificationIfAbsent({
      userId: 'u1',
      eventId: 'ev-sent',
      eventStart: new Date(NOW).toISOString(),
      leadMinutes: 10,
      notifyAt: new Date(NOW).toISOString(),
      title: '元タイトル',
      openUrl: 'https://meet.google.com/orig',
      urlSource: 'conference',
      status: 'sent',
      nowIso: iso,
    });

    await store.upsertOverride('u1', 'ev-sent', { title: '新タイトル', url: 'https://example.com/y' }, iso);

    const row = store._notifications.find((item) => item.eventId === 'ev-sent');

    check('★送信済みの通知は上書きで変えない', row.title === '元タイトル' && row.openUrl === 'https://meet.google.com/orig', JSON.stringify(row));
  }

  {
    /* GET /api/events: 上書き設定後、customTitle/customUrl と openUrl(custom) を反映。 */
    const cookie = await makeSessionCookie('u1');

    const store = createFakeStore({
      users: [{ id: 'u1', leadMinutes: [10] }],
      tokens: [{
        userId: 'u1',
        refreshTokenEnc,
        accessTokenEnc: await encryptString(encryptionKey, 'at-cached'),
        accessTokenExpiresAt: new Date(NOW + HOUR).toISOString(),
      }],
      overrides: [{ userId: 'u1', eventId: 'ev-list', title: '上書き文', url: 'https://example.com/ov' }],
    });

    const env = {
      APP_ORIGIN: 'https://tsam-ai.com',
      APP_BASE_PATH: '/push-assistant',
      SESSION_SECRET: sessionSecret,
      TOKEN_ENCRYPTION_KEY: base64UrlEncode(new Uint8Array(32).fill(3)),
      GOOGLE_CLIENT_ID: 'client-123',
      GOOGLE_CLIENT_SECRET: 'secret',
      __STORE: store,
      __NOW_MS: NOW,
      __FETCH: createFetch([{
        match: 'calendar/v3',
        handler: () => jsonResponse({
          items: [
            rawEvent({
              id: 'ev-list',
              start: { dateTime: new Date(NOW + 2 * HOUR).toISOString() },
              end: { dateTime: new Date(NOW + 3 * HOUR).toISOString() },
              conferenceData: { entryPoints: [{ entryPointType: 'video', uri: 'https://meet.google.com/list' }] },
            }),
          ],
        }),
      }]),
    };

    const response = await worker.fetch(
      new Request('https://tsam-ai.com/push-assistant/api/events', { headers: { Cookie: `pa_session=${cookie}` } }),
      env,
    );
    const body = await response.json();

    check(
      '★GET /api/events は customTitle/customUrl を返す',
      body.items[0].customTitle === '上書き文' && body.items[0].customUrl === 'https://example.com/ov',
      JSON.stringify(body.items[0]),
    );
    check(
      '★openUrl/urlSource が上書き反映（custom、conference を上書き）',
      body.items[0].openUrl === 'https://example.com/ov' && body.items[0].urlSource === 'custom',
      JSON.stringify(body.items[0]),
    );
  }

  {
    /* PUT /api/events/override（フロントとの契約: 保存後の override を返す）。 */
    const cookie = await makeSessionCookie('u1');
    const store = createFakeStore({ users: [{ id: 'u1' }] });

    const env = {
      APP_ORIGIN: 'https://tsam-ai.com',
      APP_BASE_PATH: '/push-assistant',
      SESSION_SECRET: sessionSecret,
      __STORE: store,
      __NOW_MS: NOW,
    };

    const put = (body, headers) => worker.fetch(
      new Request('https://tsam-ai.com/push-assistant/api/events/override', {
        method: 'PUT',
        headers: { Origin: 'https://tsam-ai.com', Cookie: `pa_session=${cookie}`, 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
      }),
      env,
    );

    const good = await put({ eventId: 'ev1', title: '  こんにちは  ', url: 'https://example.com/a' });
    const goodBody = await good.json();

    check(
      '正常保存: 200 で trim 済みの保存値を返す',
      good.status === 200 && goodBody.override.eventId === 'ev1'
        && goodBody.override.title === 'こんにちは' && goodBody.override.url === 'https://example.com/a',
      JSON.stringify(goodBody),
    );
    check('store に反映される', (await store.getOverride('u1', 'ev1'))?.url === 'https://example.com/a');

    check('eventId 欠落は 400', (await put({ title: 'x' })).status === 400);
    check('eventId が空文字は 400', (await put({ eventId: '   ', title: 'x' })).status === 400);
    check('★javascript: URL は 400', (await put({ eventId: 'ev1', url: 'javascript:alert(1)' })).status === 400);
    check('ftp: URL も 400', (await put({ eventId: 'ev1', url: 'ftp://example.com/x' })).status === 400);

    const cleared = await put({ eventId: 'ev1', title: '', url: '' });
    const clearedBody = await cleared.json();

    check(
      '両方空で解除（title/url は空、行は消える）',
      clearedBody.override.title === '' && clearedBody.override.url === ''
        && (await store.getOverride('u1', 'ev1')) === null,
      JSON.stringify(clearedBody),
    );

    const unauth = await worker.fetch(
      new Request('https://tsam-ai.com/push-assistant/api/events/override', {
        method: 'PUT',
        headers: { Origin: 'https://tsam-ai.com', 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventId: 'ev1' }),
      }),
      env,
    );

    check('未ログインは 401', unauth.status === 401, String(unauth.status));

    const badOrigin = await worker.fetch(
      new Request('https://tsam-ai.com/push-assistant/api/events/override', {
        method: 'PUT',
        headers: { Origin: 'https://evil.example', Cookie: `pa_session=${cookie}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventId: 'ev1' }),
      }),
      env,
    );

    check('Origin 不一致は 403', badOrigin.status === 403, String(badOrigin.status));
  }

  {
    /* deleteUserData（接続解除）で event_overrides も消える。 */
    const store = createFakeStore({
      users: [{ id: 'u1' }, { id: 'u2' }],
      overrides: [
        { userId: 'u1', eventId: 'ev-a', title: 'A', url: 'https://example.com/a' },
        { userId: 'u2', eventId: 'ev-b', title: 'B', url: 'https://example.com/b' },
      ],
    });

    await store.deleteUserData('u1');

    check('★解除した利用者の上書きは消える', (await store.getOverride('u1', 'ev-a')) === null);
    check('他利用者の上書きは残る', (await store.getOverride('u2', 'ev-b'))?.title === 'B');
  }

  {
    /* PUT /api/settings（フロントとの契約: 保存後の settings を返す）。 */
    const cookie = await makeSessionCookie('u1');
    const store = createFakeStore({ users: [{ id: 'u1' }] });

    const env = {
      APP_ORIGIN: 'https://tsam-ai.com',
      APP_BASE_PATH: '/push-assistant',
      SESSION_SECRET: sessionSecret,
      __STORE: store,
      __NOW_MS: NOW,
    };

    const put = (body) => worker.fetch(
      new Request('https://tsam-ai.com/push-assistant/api/settings', {
        method: 'PUT',
        headers: { Origin: 'https://tsam-ai.com', Cookie: `pa_session=${cookie}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
      env,
    );

    const good = await put({ notifyEnabled: true, leadMinutes: [10, 0] });
    const goodBody = await good.json();

    check('保存後の設定を返す', good.status === 200 && goodBody.settings.notifyEnabled === true, JSON.stringify(goodBody));
    check('leadMinutes をそのまま返す', JSON.stringify(goodBody.settings.leadMinutes) === '[10,0]', JSON.stringify(goodBody.settings));
    check('store に反映される', JSON.stringify(store._users.get('u1').leadMinutes) === '[10,0]');

    check('LEAD_OPTIONS に無い値は 400', (await put({ notifyEnabled: true, leadMinutes: [7] })).status === 400);
    check('重複した lead は 400', (await put({ notifyEnabled: true, leadMinutes: [10, 10] })).status === 400);
    check('空の配列は 400', (await put({ notifyEnabled: true, leadMinutes: [] })).status === 400);
    check('notifyEnabled が真偽値でなければ 400', (await put({ notifyEnabled: 'yes', leadMinutes: [10] })).status === 400);

    /* notify_url（タップで開く URL、§9）。空 or http/https のみ保存。 */
    const savedUrl = await (await put({
      notifyEnabled: true,
      leadMinutes: [10],
      notifyUrl: 'https://example.com/global',
    })).json();

    check('★notifyUrl を保存して返す', savedUrl.settings.notifyUrl === 'https://example.com/global', JSON.stringify(savedUrl.settings));
    check('store に notifyUrl が反映される', store._users.get('u1').notifyUrl === 'https://example.com/global', JSON.stringify(store._users.get('u1')));

    /* 省略時は既存値を保つ（後方互換）。 */
    const keptUrl = await (await put({ notifyEnabled: true, leadMinutes: [0] })).json();
    check('★notifyUrl を省略しても既存値を保つ', keptUrl.settings.notifyUrl === 'https://example.com/global', JSON.stringify(keptUrl.settings));

    /* 空文字で消せる。 */
    const clearedUrl = await (await put({ notifyEnabled: true, leadMinutes: [10], notifyUrl: '' })).json();
    check('★空文字で notifyUrl を消せる', clearedUrl.settings.notifyUrl === '', JSON.stringify(clearedUrl.settings));

    /* javascript: は 400（isAllowedUrl が最後の関門。§9）。 */
    check('★javascript: の notifyUrl は 400', (await put({ notifyEnabled: true, leadMinutes: [10], notifyUrl: 'javascript:alert(1)' })).status === 400);
    check('ftp: の notifyUrl も 400', (await put({ notifyEnabled: true, leadMinutes: [10], notifyUrl: 'ftp://example.com/x' })).status === 400);
    check('相対 URL の notifyUrl は 400', (await put({ notifyEnabled: true, leadMinutes: [10], notifyUrl: '/push-assistant/' })).status === 400);
    check('notifyUrl が文字列でなければ 400', (await put({ notifyEnabled: true, leadMinutes: [10], notifyUrl: 123 })).status === 400);

    /* /api/me にも notifyUrl が載る。 */
    await put({ notifyEnabled: true, leadMinutes: [10], notifyUrl: 'https://example.com/me' });

    const meAfter = await worker.fetch(
      new Request('https://tsam-ai.com/push-assistant/api/me', { headers: { Cookie: `pa_session=${cookie}` } }),
      env,
    );
    const meAfterBody = await meAfter.json();

    check('★/api/me に notifyUrl が載る', meAfterBody.settings.notifyUrl === 'https://example.com/me', JSON.stringify(meAfterBody.settings));
  }

  {
    /* 購読の登録と削除（フロントとの契約: subscriptionCount を返す）。 */
    const cookie = await makeSessionCookie('u1');
    const store = createFakeStore({ users: [{ id: 'u1' }] });

    const env = {
      APP_ORIGIN: 'https://tsam-ai.com',
      APP_BASE_PATH: '/push-assistant',
      SESSION_SECRET: sessionSecret,
      __STORE: store,
      __NOW_MS: NOW,
    };

    const subscribe = (subscription) => worker.fetch(
      new Request('https://tsam-ai.com/push-assistant/api/subscriptions', {
        method: 'POST',
        headers: { Origin: 'https://tsam-ai.com', Cookie: `pa_session=${cookie}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscription, userAgent: 'test-agent' }),
      }),
      env,
    );

    const endpoint = 'https://fcm.googleapis.com/fcm/send/xyz';

    const created = await subscribe({ endpoint, keys: subscriptionKeys });
    const createdBody = await created.json();

    check('購読を登録できる', created.status === 200 && createdBody.subscriptionCount === 1, JSON.stringify(createdBody));

    const again = await subscribe({ endpoint, keys: subscriptionKeys });

    check('同じ endpoint は増えない（upsert）', (await again.json()).subscriptionCount === 1);

    check('http の endpoint は 400', (await subscribe({ endpoint: 'http://a.example/x', keys: subscriptionKeys })).status === 400);
    check('keys が無ければ 400', (await subscribe({ endpoint })).status === 400);

    const removed = await worker.fetch(
      new Request('https://tsam-ai.com/push-assistant/api/subscriptions', {
        method: 'DELETE',
        headers: { Origin: 'https://tsam-ai.com', Cookie: `pa_session=${cookie}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint }),
      }),
      env,
    );

    check('削除すると 0 件になる', (await removed.json()).subscriptionCount === 0);

    /*
     * ------------------------------------------------------------------
     * 14. 上限は**バイト数**で見る
     * ------------------------------------------------------------------
     * 文字数で見ていると、日本語（UTF-8 で 1 文字 3 バイト）を並べた本文が
     * 上限の 3 倍まで通る。
     *
     * **この試験は「サイズ以外は正しい本文」を送る。** 購読の形が
     * 壊れていると、サイズを見なくても INVALID_REQUEST になってしまい、
     * 400 がサイズ検査に由来するのか形の検査に由来するのか区別できない。
     * ------------------------------------------------------------------
     */
    /* 文字数では上限の半分以下。UTF-8 では 3 倍に膨らんで上限を超える。 */
    const filler = "あ".repeat(Math.floor(MAX_BODY_BYTES * 0.45));
    const fillerBytes = new TextEncoder().encode(filler).length;

    check(
      '試験の前提: 文字数は上限内、バイト数は上限超',
      filler.length < MAX_BODY_BYTES && fillerBytes > MAX_BODY_BYTES,
      `chars=${filler.length} bytes=${fillerBytes} limit=${MAX_BODY_BYTES}`,
    );

    const huge = await worker.fetch(
      new Request("https://tsam-ai.com/push-assistant/api/subscriptions", {
        method: "POST",
        headers: {
          Origin: "https://tsam-ai.com",
          Cookie: `pa_session=${cookie}`,
          "Content-Type": "application/json",
        },
        /* 購読そのものは正しい形。**大きさ以外に断る理由が無い。** */
        body: JSON.stringify({
          subscription: { endpoint, keys: subscriptionKeys },
          userAgent: "test-agent",
          note: filler,
        }),
      }),
      env,
    );

    check('★多バイト文字で膨らんだ本文は上限で弾く', huge.status === 400, String(huge.status));

    /* 同じ形で小さければ通る（弾いた理由が大きさであることの裏取り）。 */
    const small = await worker.fetch(
      new Request("https://tsam-ai.com/push-assistant/api/subscriptions", {
        method: "POST",
        headers: {
          Origin: "https://tsam-ai.com",
          Cookie: `pa_session=${cookie}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          subscription: { endpoint, keys: subscriptionKeys },
          userAgent: "test-agent",
          note: "あ",
        }),
      }),
      env,
    );

    check('同じ形でも小さければ通る（断った理由は大きさ）', small.status === 200, String(small.status));
  }

  {
    /*
     * ------------------------------------------------------------------
     * 4. 端末の持ち主が変わるときは、無言で移さない
     * ------------------------------------------------------------------
     * endpoint は端末を指すので、使い回せば別の利用者から同じ値が来る。
     * 移すこと自体は正しい（前の持ち主へ通知が飛び続けるほうが害が大きい）が、
     * **これは「他人の endpoint を送れば、その端末を自分のものにできる」
     * 操作でもあり、相手は理由も分からず通知が止まる。**
     * 旧行を消して作り直し、警告ログを残す。
     * ------------------------------------------------------------------
     */
    const endpoint = "https://fcm.googleapis.com/fcm/send/shared-device";

    const store = createFakeStore({
      users: [{ id: "u1" }, { id: "u2" }],
      subscriptions: [{ userId: "u1", endpoint, ...subscriptionKeys }],
    });

    const env = {
      APP_ORIGIN: "https://tsam-ai.com",
      APP_BASE_PATH: "/push-assistant",
      SESSION_SECRET: sessionSecret,
      __STORE: store,
      __NOW_MS: NOW,
    };

    check('移す前は u1 のもの', (await store.countActiveSubscriptions('u1')) === 1);

    const lines = [];
    const originalLog = console.log;

    console.log = (...args) => { lines.push(args.join(" ")); };

    let response;

    try {
      response = await worker.fetch(
        new Request("https://tsam-ai.com/push-assistant/api/subscriptions", {
          method: "POST",
          headers: {
            Origin: "https://tsam-ai.com",
            Cookie: `pa_session=${await makeSessionCookie("u2")}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ subscription: { endpoint, keys: subscriptionKeys } }),
        }),
        env,
      );
    } finally {
      console.log = originalLog;
    }

    check('登録そのものは成功する', response.status === 200, String(response.status));
    check('★旧所有者の購読は 0 件になる', (await store.countActiveSubscriptions('u1')) === 0);
    check('新所有者の購読は 1 件', (await store.countActiveSubscriptions('u2')) === 1);

    const warned = lines.find((line) => line.includes("SUBSCRIPTION_REASSIGNED"));

    check('★所有者の変更を警告ログに残す', Boolean(warned), JSON.stringify(lines));
    check('旧・新の利用者 ID を書く', String(warned).includes('from=u1') && String(warned).includes('to=u2'), warned);
    check(
      '★endpoint はログに書かない（購読の宛先は秘密）',
      String(warned).includes("fcm.googleapis.com") === false,
      warned,
    );

    /* 旧行を消して作り直しているので、履歴（id）は引き継がない。 */
    check('行は作り直される', store._subscriptions.length === 1 && store._subscriptions[0].userId === 'u2');
  }

  {
    /* 同じ利用者の再登録は、従来どおりの upsert（警告も出さない）。 */
    const endpoint = "https://fcm.googleapis.com/fcm/send/same-owner";

    const store = createFakeStore({
      users: [{ id: "u1" }],
      subscriptions: [{ userId: "u1", endpoint, ...subscriptionKeys }],
    });

    const result = await store.upsertSubscription({
      userId: "u1",
      endpoint,
      ...subscriptionKeys,
      userAgent: "x",
      nowIso: new Date(NOW).toISOString(),
    });

    check('同じ利用者なら reassignedFrom は null', result.reassignedFrom === null, JSON.stringify(result));
    check('件数は増えない', store._subscriptions.length === 1);
  }

  {
    /* テスト通知（フロントとの契約: sent / failed）。 */
    const cookie = await makeSessionCookie('u1');

    const store = createFakeStore({
      users: [{ id: 'u1' }],
      subscriptions: [
        { userId: 'u1', endpoint: 'https://fcm.googleapis.com/fcm/send/ok', ...subscriptionKeys },
        { userId: 'u1', endpoint: 'https://fcm.googleapis.com/fcm/send/gone', ...subscriptionKeys },
      ],
    });

    const env = {
      APP_ORIGIN: 'https://tsam-ai.com',
      APP_BASE_PATH: '/push-assistant',
      SESSION_SECRET: sessionSecret,
      VAPID_PRIVATE_KEY: vapidPkcs8,
      VAPID_PUBLIC_KEY: base64UrlEncode(vapidPublicBytes),
      VAPID_SUBJECT: APP_URL,
      __STORE: store,
      __NOW_MS: NOW,
      __FETCH: createFetch([{
        match: 'fcm.googleapis.com/fcm/send/',
        handler: ({ url }) => new Response(null, { status: url.endsWith('/gone') ? 410 : 201 }),
      }]),
    };

    const response = await worker.fetch(
      new Request('https://tsam-ai.com/push-assistant/api/push/test', {
        method: 'POST',
        headers: { Origin: 'https://tsam-ai.com', Cookie: `pa_session=${cookie}` },
      }),
      env,
    );
    const body = await response.json();

    check('sent と failed を返す', body.sent === 1 && body.failed === 1, JSON.stringify(body));
    check('410 の購読は無効化される', store._subscriptions[1].disabledAt !== null, JSON.stringify(store._subscriptions[1]));
  }

  {
    /* 履歴。 */
    const cookie = await makeSessionCookie('u1');
    const store = createFakeStore({ users: [{ id: 'u1' }] });

    await store.insertNotificationIfAbsent({
      userId: 'u1',
      eventId: 'ev-h',
      eventStart: new Date(NOW).toISOString(),
      leadMinutes: 10,
      notifyAt: new Date(NOW - 10 * MINUTE).toISOString(),
      title: '過去の会議',
      openUrl: 'https://meet.google.com/h',
      urlSource: 'conference',
      status: 'sent',
      nowIso: new Date(NOW).toISOString(),
    });

    const response = await worker.fetch(
      new Request('https://tsam-ai.com/push-assistant/api/notifications', {
        headers: { Cookie: `pa_session=${cookie}` },
      }),
      {
        APP_ORIGIN: 'https://tsam-ai.com',
        APP_BASE_PATH: '/push-assistant',
        SESSION_SECRET: sessionSecret,
        __STORE: store,
        __NOW_MS: NOW,
      },
    );
    const body = await response.json();

    check('履歴を items で返す', response.status === 200 && body.items.length === 1, JSON.stringify(body));
    check('必要な項目が揃っている', body.items[0].title === '過去の会議' && body.items[0].status === 'sent', JSON.stringify(body.items[0]));
  }

  {
    /* 他人のデータへ到達できないこと。 */
    const cookie = await makeSessionCookie('u2');

    const store = createFakeStore({ users: [{ id: 'u1' }, { id: 'u2' }] });

    await store.insertNotificationIfAbsent({
      userId: 'u1',
      eventId: 'ev-secret',
      eventStart: new Date(NOW).toISOString(),
      leadMinutes: 10,
      notifyAt: new Date(NOW).toISOString(),
      title: '他人の会議',
      openUrl: 'https://meet.google.com/secret',
      urlSource: 'conference',
      status: 'sent',
      nowIso: new Date(NOW).toISOString(),
    });

    const response = await worker.fetch(
      new Request('https://tsam-ai.com/push-assistant/api/notifications', {
        headers: { Cookie: `pa_session=${cookie}` },
      }),
      {
        APP_ORIGIN: 'https://tsam-ai.com',
        APP_BASE_PATH: '/push-assistant',
        SESSION_SECRET: sessionSecret,
        __STORE: store,
        __NOW_MS: NOW,
      },
    );
    const body = await response.json();

    check('★他人の通知履歴は見えない', body.items.length === 0, JSON.stringify(body));
    check('本文に他人の予定名が出ない', JSON.stringify(body).includes('他人の会議') === false);
  }

  {
    /* 認証の入口。 */
    const response = await worker.fetch(
      new Request('https://tsam-ai.com/push-assistant/api/auth/start'),
      {
        APP_ORIGIN: 'https://tsam-ai.com',
        APP_BASE_PATH: '/push-assistant',
        GOOGLE_CLIENT_ID: 'client-123',
        SESSION_SECRET: sessionSecret,
        __NOW_MS: NOW,
      },
    );

    check('Google へ 302', response.status === 302, String(response.status));

    const location = new URL(response.headers.get('Location'));

    check('宛先は accounts.google.com', location.host === 'accounts.google.com');
    check(
      'redirect_uri は本番の値',
      location.searchParams.get('redirect_uri') === 'https://tsam-ai.com/push-assistant/api/auth/callback',
      location.searchParams.get('redirect_uri'),
    );

    const setCookie = response.headers.get('Set-Cookie');

    check('途中状態 Cookie を発行する', String(setCookie).startsWith('pa_oauth='), setCookie);
    check(
      '途中状態 Cookie は /api/auth/ に絞る',
      String(setCookie).includes('Path=/push-assistant/api/auth/'),
      setCookie,
    );
    check('10 分で切れる', String(setCookie).includes('Max-Age=600'), setCookie);
    check(
      'code_verifier は Cookie の中（URL には challenge だけ）',
      location.searchParams.get('code_challenge') !== null
      && location.href.includes('code_verifier') === false,
    );
  }

  {
    /*
     * 同意画面からの戻り。**ここが通らないと誰もログインできない**が、
     * 手で確かめるには本物の Google が要る。トークンエンドポイントを
     * 差し替えて、Cookie の発行と保存までを一周させる。
     */
    const store = createFakeStore({});

    const oauthKey = await importSigningKey(sessionSecret);
    const oauthCookie = await signValue(oauthKey, {
      state: 'state-1',
      verifier: 'verifier-1',
      exp: Math.floor(NOW / 1000) + 600,
    });

    const idToken = `x.${base64UrlEncode(encoder.encode(JSON.stringify({
      iss: 'https://accounts.google.com',
      aud: 'client-123',
      exp: Math.floor(NOW / 1000) + 600,
      sub: 'sub-new',
      email: 'new@example.com',
      email_verified: true,
    })))}.y`;

    const tokenCalls = [];

    const env = {
      APP_ORIGIN: 'https://tsam-ai.com',
      APP_BASE_PATH: '/push-assistant',
      SESSION_SECRET: sessionSecret,
      TOKEN_ENCRYPTION_KEY: base64UrlEncode(new Uint8Array(32).fill(3)),
      GOOGLE_CLIENT_ID: 'client-123',
      GOOGLE_CLIENT_SECRET: 'secret',
      ALLOWED_EMAILS: ' New@Example.com , other@example.com ',
      __STORE: store,
      __NOW_MS: NOW,
      __FETCH: createFetch([{
        match: 'oauth2.googleapis.com/token',
        handler: ({ options }) => {
          tokenCalls.push(String(options.body));

          return jsonResponse({
            access_token: 'at-1',
            refresh_token: 'rt-1',
            expires_in: 3599,
            scope: 'openid email https://www.googleapis.com/auth/calendar.events.readonly',
            id_token: idToken,
          });
        },
      }]),
    };

    const response = await worker.fetch(
      new Request('https://tsam-ai.com/push-assistant/api/auth/callback?code=abc&state=state-1', {
        headers: { Cookie: `pa_oauth=${oauthCookie}` },
      }),
      env,
    );

    check('成功したら画面へ 302', response.status === 302, String(response.status));
    check('行き先はアプリの URL（error 無し）', response.headers.get('Location') === APP_URL, response.headers.get('Location'));

    const setCookies = response.headers.getSetCookie();

    check('Set-Cookie は 2 本（発行と途中状態の削除）', setCookies.length === 2, JSON.stringify(setCookies));
    check('セッション Cookie を発行する', setCookies.some((line) => line.startsWith('pa_session=')), JSON.stringify(setCookies));
    check(
      '途中状態 Cookie を消す',
      setCookies.some((line) => line.startsWith('pa_oauth=') && line.includes('Max-Age=0')),
      JSON.stringify(setCookies),
    );

    check('PKCE の code_verifier を送っている', tokenCalls[0].includes('code_verifier=verifier-1'), tokenCalls[0].slice(0, 120));
    check('利用者の行ができる', store._users.get('sub-new')?.email === 'new@example.com');

    const savedTokens = store._tokens.get('sub-new');

    check('トークンを保存する', Boolean(savedTokens), JSON.stringify(savedTokens));
    check('★リフレッシュトークンは平文で保存しない', savedTokens.refreshTokenEnc.includes('rt-1') === false, savedTokens.refreshTokenEnc);

    const encryptionKeyForCheck = await importEncryptionKey(base64UrlEncode(new Uint8Array(32).fill(3)));

    check(
      '復号すれば元のリフレッシュトークンに戻る',
      (await decryptString(encryptionKeyForCheck, savedTokens.refreshTokenEnc)) === 'rt-1',
    );
    check('アクセストークンも暗号化されている', savedTokens.accessTokenEnc.includes('at-1') === false);
    check(
      '許可リストは大文字小文字と前後空白を無視して照合する',
      store._users.has('sub-new'),
      'ALLOWED_EMAILS に " New@Example.com " と書いても new@example.com が通ること',
    );
  }

  {
    /* state が合わなければ、交換に進まずに画面へ戻す。 */
    const store = createFakeStore({});
    const oauthKey = await importSigningKey(sessionSecret);
    const oauthCookie = await signValue(oauthKey, {
      state: 'state-1',
      verifier: 'verifier-1',
      exp: Math.floor(NOW / 1000) + 600,
    });

    let tokenCalled = false;

    const response = await worker.fetch(
      new Request('https://tsam-ai.com/push-assistant/api/auth/callback?code=abc&state=state-OTHER', {
        headers: { Cookie: `pa_oauth=${oauthCookie}` },
      }),
      {
        APP_ORIGIN: 'https://tsam-ai.com',
        APP_BASE_PATH: '/push-assistant',
        SESSION_SECRET: sessionSecret,
        TOKEN_ENCRYPTION_KEY: base64UrlEncode(new Uint8Array(32).fill(3)),
        GOOGLE_CLIENT_ID: 'client-123',
        GOOGLE_CLIENT_SECRET: 'secret',
        ALLOWED_EMAILS: 'new@example.com',
        __STORE: store,
        __NOW_MS: NOW,
        __FETCH: async () => { tokenCalled = true; return jsonResponse({}); },
      },
    );

    check('★state 不一致ではコード交換に進まない', tokenCalled === false);
    check(
      '画面へ error 付きで戻す',
      response.status === 302 && String(response.headers.get('Location')).includes('error=INVALID_REQUEST'),
      response.headers.get('Location'),
    );
    check('利用者は作られない', store._users.size === 0, String(store._users.size));
  }

  {
    /*
     * ==================================================================
     * 2 / 12. 許可リストとスコープ
     * ==================================================================
     * この Worker は公開パスに置かれており、**URL を知っていれば
     * 誰でも Google ログインへ進める。** 許可されていない相手の
     * リフレッシュトークンをこちらの D1 に抱えないよう、
     * **行を作る前に**断る。
     * ==================================================================
     */
    const makeToken = (claims) => `x.${base64UrlEncode(encoder.encode(JSON.stringify({
      iss: "https://accounts.google.com",
      aud: "client-123",
      exp: Math.floor(NOW / 1000) + 600,
      sub: "sub-x",
      ...claims,
    })))}.y`;

    async function callback({ allowedEmailsVar, claims, scope }) {
      const store = createFakeStore({});
      const oauthKey = await importSigningKey(sessionSecret);
      const oauthCookie = await signValue(oauthKey, {
        state: "st",
        verifier: "vr",
        exp: Math.floor(NOW / 1000) + 600,
      });

      const response = await worker.fetch(
        new Request("https://tsam-ai.com/push-assistant/api/auth/callback?code=abc&state=st", {
          headers: { Cookie: `pa_oauth=${oauthCookie}` },
        }),
        {
          APP_ORIGIN: "https://tsam-ai.com",
          APP_BASE_PATH: "/push-assistant",
          SESSION_SECRET: sessionSecret,
          TOKEN_ENCRYPTION_KEY: base64UrlEncode(new Uint8Array(32).fill(3)),
          GOOGLE_CLIENT_ID: "client-123",
          GOOGLE_CLIENT_SECRET: "secret",
          ALLOWED_EMAILS: allowedEmailsVar,
          __STORE: store,
          __NOW_MS: NOW,
          __FETCH: createFetch([{
            match: "oauth2.googleapis.com/token",
            handler: () => jsonResponse({
              access_token: "at-1",
              refresh_token: "rt-1",
              expires_in: 3599,
              scope: scope ?? "openid email https://www.googleapis.com/auth/calendar.events.readonly",
              id_token: makeToken(claims),
            }),
          }]),
        },
      );

      return { store, location: String(response.headers.get("Location")) };
    }

    {
      const { store, location } = await callback({
        allowedEmailsVar: "someone@example.com",
        claims: { email: "intruder@example.com", email_verified: true },
      });

      check('★許可リストに無いアドレスは NOT_ALLOWED', location.includes('error=NOT_ALLOWED'), location);
      check('★断った相手の行を D1 に作らない', store._users.size === 0 && store._tokens.size === 0);
    }

    {
      const { store, location } = await callback({
        allowedEmailsVar: "",
        claims: { email: "anyone@example.com", email_verified: true },
      });

      check('★ALLOWED_EMAILS が空なら誰も通さない（deny by default）', location.includes('error=NOT_ALLOWED'), location);
      check('設定漏れでも行は作らない', store._users.size === 0);
    }

    {
      const { location } = await callback({
        allowedEmailsVar: "someone@example.com",
        claims: { email: "someone@example.com", email_verified: false },
      });

      check('★email_verified が false なら通さない', location.includes('error=NOT_ALLOWED'), location);
    }

    {
      const { location } = await callback({
        allowedEmailsVar: "someone@example.com",
        claims: { email: "SomeOne@Example.COM", email_verified: true },
      });

      check('大文字混じりでも小文字にそろえて照合する', location.includes('error=') === false, location);
    }

    {
      const { store, location } = await callback({
        allowedEmailsVar: "someone@example.com",
        claims: { email: "someone@example.com", email_verified: true },
        scope: "openid email",
      });

      check('★カレンダーのスコープが外されていたら SCOPE_NOT_GRANTED', location.includes('error=SCOPE_NOT_GRANTED'), location);
      check('スコープ不足でも行は作らない', store._users.size === 0);
    }

    check('許可リストは小文字・前後空白を落として読む', JSON.stringify(allowedEmails({ ALLOWED_EMAILS: ' A@b.com , C@D.com ' })) === '["a@b.com","c@d.com"]', JSON.stringify(allowedEmails({ ALLOWED_EMAILS: ' A@b.com , C@D.com ' })));
    check('未設定なら空の配列（誰も通さない）', allowedEmails({}).length === 0);
  }

  {
    /* 利用者が同意画面でキャンセルした場合。 */
    const response = await worker.fetch(
      new Request('https://tsam-ai.com/push-assistant/api/auth/callback?error=access_denied'),
      {
        APP_ORIGIN: 'https://tsam-ai.com',
        APP_BASE_PATH: '/push-assistant',
        SESSION_SECRET: sessionSecret,
        __NOW_MS: NOW,
      },
    );

    check(
      'キャンセルは画面へ戻す（JSON を見せない）',
      response.status === 302 && String(response.headers.get('Location')).includes('error=OAUTH_DENIED'),
      response.headers.get('Location'),
    );
  }

  {
    /* 設定漏れは NOT_CONFIGURED（500）になる。 */
    const response = await worker.fetch(
      new Request('https://tsam-ai.com/push-assistant/api/auth/start'),
      { APP_ORIGIN: 'https://tsam-ai.com' },
    );
    const body = await response.json();

    check('設定漏れは NOT_CONFIGURED', response.status === 500 && body.error.code === 'NOT_CONFIGURED', JSON.stringify(body));
  }

  {
    const response = await worker.fetch(
      new Request('https://tsam-ai.com/push-assistant/api/unknown'),
      {},
    );

    check('未知の API は 404', response.status === 404, String(response.status));
  }

  {
    /* 静的ファイル。ASSETS は偽物で差し替える。 */
    const requested = [];

    const env = {
      APP_BASE_PATH: '/push-assistant',
      ASSETS: {
        async fetch(request) {
          requested.push(new URL(request.url).pathname);

          return new Response('<!doctype html>', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          });
        },
      },
    };

    const response = await worker.fetch(new Request('https://tsam-ai.com/push-assistant/'), env);

    check('assets へは接頭辞を剥がして渡す', requested[0] === '/', requested[0]);
    check('HTML は no-cache', response.headers.get('Cache-Control') === 'no-cache', response.headers.get('Cache-Control'));
    check('静的ファイルにも nosniff を付ける', response.headers.get('X-Content-Type-Options') === 'nosniff');
    check(
      '★静的 HTML にも frame-ancestors ヘッダが乗る（meta では効かないため）',
      response.headers.get('Content-Security-Policy') === "frame-ancestors 'none'",
      response.headers.get('Content-Security-Policy'),
    );
    check('静的 HTML にも X-Frame-Options: DENY', response.headers.get('X-Frame-Options') === 'DENY');

    await worker.fetch(new Request('https://tsam-ai.com/push-assistant/sw.js'), env);

    check('sw.js も接頭辞を剥がす', requested[1] === '/sw.js', requested[1]);

    const sw = await worker.fetch(new Request('https://tsam-ai.com/push-assistant/sw.js'), env);

    check('sw.js は no-cache（古い SW を残さない）', sw.headers.get('Cache-Control') === 'no-cache');

    const missing = await worker.fetch(new Request('https://tsam-ai.com/push-assistant/nope.js'), {
      APP_BASE_PATH: '/push-assistant',
      ASSETS: { async fetch() { return new Response('', { status: 404 }); } },
    });

    check('assets に無ければ素の 404（JSON にしない）', missing.status === 404);
    check('404 の本文は JSON ではない', (await missing.text()).startsWith('{') === false);
  }

  {
    const response = await worker.fetch(
      new Request('https://tsam-ai.com/push-assistant'),
      { APP_BASE_PATH: '/push-assistant' },
    );

    check('末尾スラッシュ無しは 308 で寄せる', response.status === 308, String(response.status));
    check('行き先は末尾スラッシュ付き', response.headers.get('Location') === '/push-assistant/');
  }

  /* ================================================================ */
  section('OAuth クライアント ID は Push Assistant 専用（仕様書 §4-1）');
  /* ================================================================ */
  {
    /*
     * 2026-08-26 に録音アプリ共有クライアントから**専用クライアント**へ切り替えた
     * （レビュー指摘 1: 既存アプリと calendar スコープを共有しない）。
     * ここでは (1) TODO のままでない (2) Web クライアント ID の形式である
     * (3) **録音アプリ・Meeting Assistant とは別の ID である**ことを固定する。
     * 専用に保つのが目的なので、他アプリと同一に戻ったら気づけるようにする。
     */
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, resolve } = await import('node:path');

    const here = dirname(fileURLToPath(import.meta.url));
    const read = (rel) => readFileSync(resolve(here, '../..', rel), 'utf8');
    const pick = (text) => (text.match(/[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com/) ?? [''])[0];

    const wranglerId = pick(read('workers/push-assistant/wrangler.jsonc'));
    const recorderId = pick(read('public/production-app/voice-recorder/config.js'));
    const meetingId = pick(read('public/meeting-assistant/config.js'));

    check('wrangler.jsonc にクライアント ID がある（TODO のままではない）', wranglerId !== '', wranglerId);
    check('Web クライアント ID の形式である', /^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/.test(wranglerId), wranglerId);
    check('録音アプリとは別の専用 ID である', wranglerId !== recorderId, `${wranglerId} / ${recorderId}`);
    check('Meeting Assistant とも別の専用 ID である', wranglerId !== meetingId, `${wranglerId} / ${meetingId}`);
  }

  /* ---------------------------------------------------------------- */
  section('通知テンプレート — renderNotification（純関数。仕様書 §8）');
  /* ================================================================ */
  {
    /* NOW = 2026-08-26 09:00 UTC = 18:00 JST。10 分前通知の予定。 */
    const evt = {
      title: '定例会議',
      url: 'https://meet.google.com/abc',
      startMs: NOW,
      leadMinutes: 10,
    };

    const withTitle = renderNotification({ template: { title: 'オンライン予定です', body: '' }, event: evt });
    check('template.title 非空ならそれをタイトルにする', withTitle.title === 'オンライン予定です', withTitle.title);

    const emptyTitle = renderNotification({ template: { title: '', body: '' }, event: evt });
    check('template.title 空なら event.title を使う', emptyTitle.title === '定例会議', emptyTitle.title);

    const trimmed = renderNotification({ template: { title: '  問いかけ  ', body: '' }, event: evt });
    check('template.title は前後の空白を除去する', trimmed.title === '問いかけ', JSON.stringify(trimmed.title));

    check('template.body 空なら既定文（HH:MM 開始（あと N 分））', emptyTitle.body === '18:00 開始（あと10分）', emptyTitle.body);

    const replaced = renderNotification({
      template: { title: '', body: '{time} に {title}。リンク: {url}' },
      event: evt,
    });
    check(
      '{time}{title}{url} を置換する',
      replaced.body === '18:00 に 定例会議。リンク: https://meet.google.com/abc',
      replaced.body,
    );

    const lead0 = renderNotification({ template: { title: '', body: '' }, event: { ...evt, leadMinutes: 0 } });
    check('lead=0 の既定文は「HH:MM 開始」', lead0.body === '18:00 開始', lead0.body);

    const badTime = renderNotification({ template: { title: '', body: '開始は「{time}」' }, event: { ...evt, startMs: NaN } });
    check('無効な時刻の {time} は空文字', badTime.body === '開始は「」', badTime.body);

    const unknown = renderNotification({ template: { title: '', body: '{title} / {unknown}' }, event: evt });
    check('未知の {xxx} はそのまま残す', unknown.body === '定例会議 / {unknown}', unknown.body);

    const longTitle = renderNotification({ template: { title: 'あ'.repeat(200), body: '' }, event: evt });
    check('タイトルは MAX_TITLE_LENGTH で切る', longTitle.title.length === MAX_TITLE_LENGTH, String(longTitle.title.length));

    const longBody = renderNotification({ template: { title: '', body: '{url}'.repeat(200) }, event: evt });
    check('本文は置換後に MAX_NOTIFY_BODY_LENGTH で切る', longBody.body.length === MAX_NOTIFY_BODY_LENGTH, String(longBody.body.length));

    check('formatJstTime: 09:00 UTC は JST 18:00', formatJstTime(NOW) === '18:00', formatJstTime(NOW));
    check('formatJstTime: 無効な時刻は空文字', formatJstTime(NaN) === '', formatJstTime(NaN));
    check(
      'buildDefaultBody: 時刻不明・lead>0 は「まもなく開始（N分前）」',
      buildDefaultBody({ startMs: NaN, leadMinutes: 10 }) === 'まもなく開始（10分前）',
      buildDefaultBody({ startMs: NaN, leadMinutes: 10 }),
    );
  }

  /* ---------------------------------------------------------------- */
  section('通知テンプレート — PUT /api/settings と /api/me');
  /* ================================================================ */
  {
    const cookie = await makeSessionCookie('u1');
    const store = createFakeStore({ users: [{ id: 'u1' }] });

    const env = {
      APP_ORIGIN: 'https://tsam-ai.com',
      APP_BASE_PATH: '/push-assistant',
      SESSION_SECRET: sessionSecret,
      __STORE: store,
      __NOW_MS: NOW,
    };

    const put = (payload) => worker.fetch(
      new Request('https://tsam-ai.com/push-assistant/api/settings', {
        method: 'PUT',
        headers: { Origin: 'https://tsam-ai.com', Cookie: `pa_session=${cookie}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }),
      env,
    );

    const me = () => worker.fetch(
      new Request('https://tsam-ai.com/push-assistant/api/me', { headers: { Cookie: `pa_session=${cookie}` } }),
      env,
    );

    const saved = await (await put({
      notifyEnabled: true,
      leadMinutes: [10],
      notifyTitle: '  問いかけ  ',
      notifyBody: '{time} 開始 → {url}',
    })).json();

    check('テンプレートを保存して返す（title は trim）', saved.settings.notifyTitle === '問いかけ', JSON.stringify(saved.settings));
    check('本文テンプレートを返す', saved.settings.notifyBody === '{time} 開始 → {url}', JSON.stringify(saved.settings));
    check(
      'store に反映される',
      store._users.get('u1').notifyTitle === '問いかけ' && store._users.get('u1').notifyBody === '{time} 開始 → {url}',
      JSON.stringify(store._users.get('u1')),
    );

    const meBody = await (await me()).json();
    check(
      '/api/me にテンプレートが載る',
      meBody.settings.notifyTitle === '問いかけ' && meBody.settings.notifyBody === '{time} 開始 → {url}',
      JSON.stringify(meBody.settings),
    );

    /* 省略したら既存値を保つ（後方互換）。 */
    const kept = await (await put({ notifyEnabled: true, leadMinutes: [0] })).json();
    check(
      'テンプレートを省いても既存値を保つ（後方互換）',
      kept.settings.notifyTitle === '問いかけ' && kept.settings.notifyBody === '{time} 開始 → {url}',
      JSON.stringify(kept.settings),
    );
    check('省略時も leadMinutes は更新される', JSON.stringify(kept.settings.leadMinutes) === '[0]', JSON.stringify(kept.settings));

    /* 空文字で消せる。 */
    const cleared = await (await put({ notifyEnabled: true, leadMinutes: [10], notifyTitle: '', notifyBody: '' })).json();
    check('空文字を送るとテンプレートを消せる', cleared.settings.notifyTitle === '' && cleared.settings.notifyBody === '', JSON.stringify(cleared.settings));

    /* 上限は 400 ではなく切り詰め。 */
    const clipped = await (await put({
      notifyEnabled: true,
      leadMinutes: [10],
      notifyTitle: 'あ'.repeat(200),
      notifyBody: 'x'.repeat(800),
    })).json();
    check('長いタイトルは 120 文字に切り詰める', clipped.settings.notifyTitle.length === MAX_TITLE_LENGTH, String(clipped.settings.notifyTitle.length));
    check('長い本文は 500 文字に切り詰める', clipped.settings.notifyBody.length === MAX_NOTIFY_BODY_LENGTH, String(clipped.settings.notifyBody.length));

    /* 文字列でなければ 400（レビュー: 型を素通ししない）。 */
    check('notifyTitle が文字列でなければ 400', (await put({ notifyEnabled: true, leadMinutes: [10], notifyTitle: 123 })).status === 400);
    check('notifyBody が文字列でなければ 400', (await put({ notifyEnabled: true, leadMinutes: [10], notifyBody: {} })).status === 400);
  }

  /* ---------------------------------------------------------------- */
  section('通知タイトル・タップ URL — runTick で通知に反映（§8-8・§9）');
  /* ================================================================ */
  {
    /* 復号のための道具は上の Web Push 節で用意した decryptWebPush / subscriptionKeys を使う。 */
    const readPayload = async (body) => JSON.parse((await decryptWebPush(body)).plaintext);

    /*
     * A: notify_title はタイトルに反映される。**本文は常に既定（時刻）**で、
     * notify_body を設定していても本文には出ない（画面の簡素化。§15）。
     */
    const world = createTickWorld({
      users: [{ id: 'u1', leadMinutes: [10], notifyTitle: '会議のお知らせ', notifyBody: '{time} 開始。{title} → {url}' }],
      calendarByUser: {
        u1: [rawEvent({
          id: 'ev-t',
          summary: '定例会議',
          start: { dateTime: new Date(NOW + 10 * MINUTE).toISOString() },
          conferenceData: { entryPoints: [{ entryPointType: 'video', uri: 'https://meet.google.com/xyz' }] },
        })],
      },
    });

    const res = await runTick(tickArgs(world, NOW));
    check('タイトル: 1 件送る', res.sent === 1, JSON.stringify(res));

    const payload = await readPayload(world.pushBodies[0]);
    check('タイトルは notify_title', payload.title === '会議のお知らせ', payload.title);
    check(
      '★本文は既定（時刻）。notify_body を設定していても本文には出ない',
      payload.body === '18:10 開始（あと10分）',
      payload.body,
    );

    /* B: event_overrides はテンプレートタイトルより優先（override.title > notify_title、override.url がタップ先）。 */
    const world2 = createTickWorld({
      users: [{ id: 'u1', leadMinutes: [10], notifyTitle: 'グローバル問いかけ', notifyBody: '{title} / {url}' }],
      calendarByUser: {
        u1: [rawEvent({ id: 'ev-ov', summary: '素の予定名', start: { dateTime: new Date(NOW + 10 * MINUTE).toISOString() } })],
      },
      overrides: [{ userId: 'u1', eventId: 'ev-ov', title: '個別タイトル', url: 'https://example.com/custom' }],
    });

    const res2 = await runTick(tickArgs(world2, NOW));
    check('上書き併用: 1 件送る', res2.sent === 1, JSON.stringify(res2));

    const payload2 = await readPayload(world2.pushBodies[0]);
    check('上書きタイトルはテンプレより優先（override.title > notify_title）', payload2.title === '個別タイトル', payload2.title);
    check('本文は既定（notify_body は出ない）', payload2.body === '18:10 開始（あと10分）', payload2.body);
    check('タップ先 URL は上書き URL', payload2.url === 'https://example.com/custom', payload2.url);

    /* C: notify_title 空 → タイトルは予定名。本文は既定。 */
    const world3 = createTickWorld({
      users: [{ id: 'u1', leadMinutes: [0], notifyTitle: '', notifyBody: 'まもなく: {title}' }],
      calendarByUser: {
        u1: [rawEvent({ id: 'ev-b', summary: '朝会', start: { dateTime: new Date(NOW).toISOString() } })],
      },
    });

    await runTick(tickArgs(world3, NOW));
    const payload3 = await readPayload(world3.pushBodies[0]);
    check('notify_title 空なら予定名がタイトル', payload3.title === '朝会', payload3.title);
    check('notify_body だけ設定でも本文は既定（lead=0）', payload3.body === '18:00 開始', payload3.body);

    /* D: 未設定なら従来どおり（回帰）。 */
    const world4 = createTickWorld({
      users: [{ id: 'u1', leadMinutes: [10] }],
      calendarByUser: {
        u1: [rawEvent({ id: 'ev-def', summary: '会議', start: { dateTime: new Date(NOW + 10 * MINUTE).toISOString() } })],
      },
    });

    await runTick(tickArgs(world4, NOW));
    const payload4 = await readPayload(world4.pushBodies[0]);
    check('未設定なら従来のタイトル（予定名）', payload4.title === '会議', payload4.title);
    check('未設定なら従来の既定本文', payload4.body === '18:10 開始（あと10分）', payload4.body);

    /*
     * E: notify_url（globalUrl）→ 全予定のタップ先が notify_url（source='global'）。
     * conference があっても notify_url が勝つ。
     */
    const world5 = createTickWorld({
      users: [{ id: 'u1', leadMinutes: [10], notifyUrl: 'https://example.com/global' }],
      calendarByUser: {
        u1: [rawEvent({
          id: 'ev-gu',
          summary: '定例会議',
          start: { dateTime: new Date(NOW + 10 * MINUTE).toISOString() },
          conferenceData: { entryPoints: [{ entryPointType: 'video', uri: 'https://meet.google.com/xyz' }] },
        })],
      },
    });

    await runTick(tickArgs(world5, NOW));
    const payload5 = await readPayload(world5.pushBodies[0]);
    check('★notify_url があればタップ先は notify_url（conference より優先）', payload5.url === 'https://example.com/global', payload5.url);

    const rows5 = await world5.store.listNotifications('u1', 10);
    check('★notify_url の url_source は global', rows5[0].urlSource === 'global', JSON.stringify(rows5[0]));

    /* F: override があれば notify_url より override 優先。 */
    const world6 = createTickWorld({
      users: [{ id: 'u1', leadMinutes: [10], notifyUrl: 'https://example.com/global' }],
      calendarByUser: {
        u1: [rawEvent({ id: 'ev-guo', summary: '面談', start: { dateTime: new Date(NOW + 10 * MINUTE).toISOString() } })],
      },
      overrides: [{ userId: 'u1', eventId: 'ev-guo', title: '', url: 'https://example.com/room' }],
    });

    await runTick(tickArgs(world6, NOW));
    const payload6 = await readPayload(world6.pushBodies[0]);
    check('★override は notify_url より優先（タップ先は override URL）', payload6.url === 'https://example.com/room', payload6.url);
  }

  /* ---------------------------------------------------------------- */
  section('通知タイトル・タップ URL — テスト通知（handlePushTest）');
  /* ================================================================ */
  {
    const readPayload = async (body) => JSON.parse((await decryptWebPush(body)).plaintext);

    async function pushTest(seedUser) {
      const cookie = await makeSessionCookie('u1');
      const store = createFakeStore({
        users: [{ id: 'u1', ...seedUser }],
        tokens: [{ userId: 'u1', refreshTokenEnc }],
        subscriptions: [{ userId: 'u1', endpoint: 'https://fcm.googleapis.com/fcm/send/u1', ...subscriptionKeys }],
      });

      const sentBodies = [];

      const env = {
        APP_ORIGIN: 'https://tsam-ai.com',
        APP_BASE_PATH: '/push-assistant',
        SESSION_SECRET: sessionSecret,
        VAPID_PRIVATE_KEY: vapidPkcs8,
        VAPID_PUBLIC_KEY: vapid.publicKey,
        VAPID_SUBJECT: APP_URL,
        __STORE: store,
        __NOW_MS: NOW,
        __FETCH: async (url, options) => {
          sentBodies.push(options?.body ?? null);
          return new Response(null, { status: 201 });
        },
      };

      const response = await worker.fetch(
        new Request('https://tsam-ai.com/push-assistant/api/push/test', {
          method: 'POST',
          headers: { Origin: 'https://tsam-ai.com', Cookie: `pa_session=${cookie}` },
        }),
        env,
      );

      return { response, sentBodies };
    }

    /* notify_title があればタイトルに反映。タップ先は notify_url。本文は固定文言。 */
    const withTitle = await pushTest({
      notifyTitle: 'テストの問いかけ',
      notifyUrl: 'https://example.com/global',
      notifyBody: '本文: {title} {url}',
    });
    check('テスト通知: 送信は 200', withTitle.response.status === 200, String(withTitle.response.status));

    const p = await readPayload(withTitle.sentBodies[0]);
    check('テスト通知にも notify_title が載る', p.title === 'テストの問いかけ', p.title);
    check('★テスト通知のタップ先は notify_url', p.url === 'https://example.com/global', p.url);
    check('★notify_body を設定してもテスト通知の本文には出ない（固定文言）', p.body === 'テスト通知です。タップするとアプリが開きます。', p.body);

    /* 未設定なら従来の固定文言・アプリ URL。 */
    const plain = await pushTest({});
    const p2 = await readPayload(plain.sentBodies[0]);
    check('未設定のテスト通知は固定タイトル', p2.title === 'Push Assistant', p2.title);
    check('未設定のテスト通知は固定本文', p2.body === 'テスト通知です。タップするとアプリが開きます。', p2.body);
    check('未設定のテスト通知のタップ先はアプリ URL', p2.url === 'https://tsam-ai.com/push-assistant/', p2.url);
  }

  finish();
}

run().catch(fatal);

/*
 * カレンダー通知 V2 のライセンスゲート（workers/notifier-gate/）。
 *
 * ==================================================================
 * ここで固定するもの
 * ==================================================================
 *   1. 通知対象の判定（要件書 §6 の順序と各条件）— V1 のテストからの移植
 *   2. リスケ時の再通知（宿題 B-05 の解決。時刻差のマトリクス）
 *   3. ライセンス状態の遷移（active / grace / expired とキャッシュ）
 *   4. VAPID JWT が公開鍵で検証できること（jsrsasign を捨てた置き換えの確認）
 *   5. **予定名などが運営サーバーへ届かないこと**（要件 DR-03/04）
 *
 * Workers ランタイムも Chrome も要らない。src/*.mjs は WebCrypto と
 * fetch/Request/Response しか使っておらず、Node 22 にどちらもある。
 * ==================================================================
 */

import { check, section, finish, fatal } from '../../public/apps/tests/helpers/assert.mjs';

import {
  DEFAULT_SETTINGS,
  LICENSE_CACHE_TTL_MS,
  LICENSE_CONTINUATION_MAX_MS,
  RENOTIFY_THRESHOLD_MS,
} from '../../workers/notifier-gate/src/constants.mjs';
import {
  decideEvent,
  evaluateEvents,
  normalizeSettings,
  validateEvents,
  validateSentDigest,
} from '../../workers/notifier-gate/src/evaluate.mjs';
import {
  hashLicenseKey,
  licenseCacheKey,
  resolveLicense,
} from '../../workers/notifier-gate/src/license.mjs';
import {
  base64ToBytes,
  importVapidPrivateKey,
  isAllowedAudience,
  normalizeAudiences,
  signJwt,
} from '../../workers/notifier-gate/src/vapid.mjs';
import worker from '../../workers/notifier-gate/src/index.mjs';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

/* 基準時刻。テストの中で now を動かすので固定値にする。 */
const NOW = Date.UTC(2026, 7, 10, 9, 0, 0);
const START = Date.UTC(2026, 7, 10, 10, 0, 0);

const SETTINGS = { ...DEFAULT_SETTINGS };

/** 骨格を1件つくる。テストごとに変えたい部分だけ渡す。 */
function makeEvent(overrides = {}) {
  return {
    eid: 'e1',
    startAt: new Date(START).toISOString(),
    status: 'accepted',
    allDay: false,
    cancelled: false,
    ...overrides,
  };
}

/**
 * KV の偽物。
 *
 * TTL は再現しない。期限切れの挙動は「レコードを消す」ことで表現する
 * （Cloudflare の TTL も結局そうなるため、判定の筋は変わらない）。
 */
function createKv() {
  const store = new Map();

  return {
    store,
    async get(key) {
      const found = store.get(key);
      return found === undefined ? null : found;
    },
    async put(key, value) {
      store.set(key, value);
    },
  };
}

/* ライセンスキーは base64url の文字だけで 22〜128 文字。 */
function makeLicenseKey(suffix) {
  return `LK${'x'.repeat(40)}${suffix}`;
}

async function run() {
  section('判定 — 要件書 §6 の順序');

  {
    const accepted = decideEvent(makeEvent(), SETTINGS);
    check('出席（accepted）は通る', accepted.include === true, accepted.reason);

    const declined = decideEvent(makeEvent({ status: 'declined' }), SETTINGS);
    check('欠席（declined）は既定で除外される', declined.include === false && declined.reason === 'status-off', declined.reason);

    const declinedOn = decideEvent(makeEvent({ status: 'declined' }), { ...SETTINGS, declined: true });
    check('欠席を ON にすれば通る', declinedOn.include === true, declinedOn.reason);

    const allDay = decideEvent(makeEvent({ allDay: true }), SETTINGS);
    check('終日予定は「時間指定のみ」ON で除外される', allDay.include === false && allDay.reason === 'all-day', allDay.reason);

    const allDayOff = decideEvent(makeEvent({ allDay: true }), { ...SETTINGS, timedOnly: false });
    check('「時間指定のみ」OFF なら終日予定も通る', allDayOff.include === true, allDayOff.reason);

    /*
     * 順序の証明。削除済みの終日予定を「終日だから除外」で止めると、
     * キューに残ったままになる（V1 の CalendarSync.gs 冒頭のコメント）。
     */
    const cancelledAllDay = decideEvent(makeEvent({ allDay: true, cancelled: true }), SETTINGS);
    check(
      '削除済みは終日判定より先に見る（reason は cancelled）',
      cancelledAllDay.include === false && cancelledAllDay.reason === 'cancelled',
      cancelledAllDay.reason,
    );

    const notAttendee = decideEvent(makeEvent({ status: '' }), SETTINGS);
    check('出欠が取れない予定は除外される', notAttendee.include === false && notAttendee.reason === 'not-attendee', notAttendee.reason);

    const unknownFeature = decideEvent(makeEvent({ feature: 'unknown-thing' }), SETTINGS);
    check(
      '未登録の feature は通さない',
      unknownFeature.include === false && unknownFeature.reason === 'unknown-feature',
      unknownFeature.reason,
    );
  }

  section('設定の正規化');

  {
    const normalized = normalizeSettings({ declined: 'false', timedOnly: 'true', timingMin: '10' });
    check('文字列の false は false になる', normalized.declined === false);
    check('文字列の true は true になる', normalized.timedOnly === true);
    check('文字列の数値は数値になる', normalized.timingMin === 10);

    check('選択肢に無い timing は既定へ戻る', normalizeSettings({ timingMin: 7 }).timingMin === DEFAULT_SETTINGS.timingMin);
    check('timing 0（開始時刻ちょうど）は許可される', normalizeSettings({ timingMin: 0 }).timingMin === 0);
    check('壊れた入力でも既定に落ちる', normalizeSettings(null).accepted === true);
  }

  section('通知予定時刻');

  {
    const result = evaluateEvents({ settings: SETTINGS, events: [makeEvent()], sentDigest: [], nowMs: NOW });

    check('通知は1件', result.notify.length === 1, JSON.stringify(result.notify));
    check(
      'notifyAt は開始時刻の5分前',
      result.notify[0].notifyAt === new Date(START - 5 * MINUTE).toISOString(),
      result.notify[0].notifyAt,
    );
    check('feature の既定値は calendar', result.notify[0].feature === 'calendar');

    const perEvent = evaluateEvents({
      settings: SETTINGS,
      events: [makeEvent({ feature: 'calendar', timingMin: 15 })],
      sentDigest: [],
      nowMs: NOW,
    });
    check(
      'イベント単位の timingMin が効く',
      perEvent.notify[0].notifyAt === new Date(START - 15 * MINUTE).toISOString(),
      perEvent.notify[0].notifyAt,
    );

    const excluded = evaluateEvents({
      settings: SETTINGS,
      events: [makeEvent({ status: 'declined' })],
      sentDigest: [],
      nowMs: NOW,
    });
    check('除外された予定は remove に入る', excluded.notify.length === 0 && excluded.remove.length === 1);
    check('remove の理由が分かる', excluded.remove[0].reason === 'status-off', excluded.remove[0].reason);
  }

  section('B-05 — リスケされたときの再通知');

  {
    /* 「開始時刻 START の予定を5分前通知で送った」という記録。 */
    const sentDigest = [{ eid: 'e1', feature: 'calendar', timing: 5, startAt: new Date(START).toISOString() }];

    const cases = [
      { label: '変更なし', delta: 0, expectNotify: false },
      { label: '4分後ろへ（閾値未満）', delta: 4 * MINUTE, expectNotify: false },
      { label: '5分後ろへ（閾値ちょうど）', delta: 5 * MINUTE, expectNotify: true },
      { label: '60分後ろへ', delta: 60 * MINUTE, expectNotify: true },
      { label: '60分前へ（過去方向）', delta: -60 * MINUTE, expectNotify: true },
      { label: '4分前へ（過去方向・閾値未満）', delta: -4 * MINUTE, expectNotify: false },
    ];

    for (const item of cases) {
      const startAt = new Date(START + item.delta).toISOString();
      const result = evaluateEvents({
        settings: SETTINGS,
        events: [makeEvent({ startAt })],
        sentDigest,
        nowMs: NOW,
      });

      check(
        `${item.label} → ${item.expectNotify ? '再通知する' : '再通知しない'}`,
        (result.notify.length === 1) === item.expectNotify,
        JSON.stringify(result.notify),
      );
    }

    check('閾値は5分', RENOTIFY_THRESHOLD_MS === 5 * MINUTE);

    const cancelled = evaluateEvents({
      settings: SETTINGS,
      events: [makeEvent({ cancelled: true })],
      sentDigest,
      nowMs: NOW,
    });
    check(
      '送信済みの予定が削除されたら remove で返す',
      cancelled.notify.length === 0 && cancelled.remove[0].reason === 'cancelled',
      JSON.stringify(cancelled.remove),
    );

    const sameStart = evaluateEvents({
      settings: SETTINGS,
      events: [makeEvent()],
      sentDigest,
      nowMs: NOW,
    });
    check(
      '送信済みはキューからも消す（remove に入る）',
      sameStart.remove.length === 1 && sameStart.remove[0].reason === 'already-sent',
      JSON.stringify(sameStart.remove),
    );

    /* timing を 5 → 10 に変えたら別の通知になる（V1 の queueKey_ と同じ考え）。 */
    const otherTiming = evaluateEvents({
      settings: { ...SETTINGS, timingMin: 10 },
      events: [makeEvent()],
      sentDigest,
      nowMs: NOW,
    });
    check('timing を変えたら別の通知として出る', otherTiming.notify.length === 1, JSON.stringify(otherTiming.notify));

    /*
     * 微修正の積み重ね。比較の相手は「送信時点の開始時刻」なので、
     * 4分ずらしを2回（＝元から8分）すれば再通知される。
     */
    const drifted = evaluateEvents({
      settings: SETTINGS,
      events: [makeEvent({ startAt: new Date(START + 8 * MINUTE).toISOString() })],
      sentDigest,
      nowMs: NOW,
    });
    check('4分ずらしを重ねて8分になれば再通知される', drifted.notify.length === 1, JSON.stringify(drifted.notify));

    const stale = evaluateEvents({
      settings: SETTINGS,
      events: [makeEvent({ startAt: new Date(NOW - 30 * 24 * HOUR).toISOString() })],
      sentDigest: [],
      nowMs: NOW,
    });
    check('保持期間より古い骨格は捨てる', stale.notify.length === 0 && stale.remove[0].reason === 'stale');
  }

  section('匿名化 — 運営サーバーが受け取らないもの');

  {
    const forbidden = ['summary', 'title', 'description', 'attendees', 'email', 'calendarId', 'eventId'];

    for (const field of forbidden) {
      const result = validateEvents([makeEvent({ [field]: 'なにか' })]);
      check(`events に ${field} があれば拒否する`, result.ok === false, result.message);
    }

    check('正しい骨格は受理する', validateEvents([makeEvent()]).ok === true);
    check('eid が空なら拒否する', validateEvents([makeEvent({ eid: '' })]).ok === false);
    check('events が配列でなければ拒否する', validateEvents({}).ok === false);

    check(
      'sentDigest に title があれば拒否する',
      validateSentDigest([{ eid: 'e1', timing: 5, startAt: '', title: 'X' }]).ok === false,
    );
    check('sentDigest の省略は許す', validateSentDigest(undefined).ok === true);

    /* 判定の出力にも予定名の類が現れないこと（応答経由で漏れないことの念押し）。 */
    const result = evaluateEvents({ settings: SETTINGS, events: [makeEvent()], sentDigest: [], nowMs: NOW });
    const keys = Object.keys(result.notify[0]);
    check(
      '判定の出力は eid / feature / timing / 時刻だけ',
      keys.every((key) => ['eid', 'feature', 'timing', 'startAt', 'notifyAt'].includes(key)),
      keys.join(','),
    );
  }

  section('ライセンス — 状態の遷移');

  {
    /** 認証系 GAS の偽物。answer を差し替えて挙動を変える。 */
    function createAuthGas(answer) {
      const calls = [];

      return {
        calls,
        fetchImpl: async (url, init) => {
          calls.push(JSON.parse(init.body));

          if (answer.throws) {
            throw new Error('network down');
          }

          if (answer.html) {
            return new Response('<html>エラー</html>', { status: 200 });
          }

          if (answer.status && answer.status !== 200) {
            return new Response('', { status: answer.status });
          }

          return new Response(
            JSON.stringify({ ok: true, data: { valid: answer.valid, plan: answer.plan ?? 'basic', status: 'active' } }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        },
      };
    }

    const baseEnv = () => ({
      LICENSE_CACHE: createKv(),
      AUTH_GAS_URL: 'https://example.invalid/exec',
      AUTH_GAS_SHARED_SECRET: 'shared',
    });

    {
      const env = baseEnv();
      const gas = createAuthGas({ valid: true });
      const first = await resolveLicense({ licenseKey: makeLicenseKey('1'), env, nowMs: NOW, fetchImpl: gas.fetchImpl });

      check('有効なライセンスは active', first.state === 'active' && first.reason === 'verified', JSON.stringify(first));
      check('plan が返る', first.plan === 'basic');

      const second = await resolveLicense({ licenseKey: makeLicenseKey('1'), env, nowMs: NOW + MINUTE, fetchImpl: gas.fetchImpl });
      check('6時間以内はキャッシュで答える', second.state === 'active' && second.reason === 'cache', JSON.stringify(second));
      check('キャッシュ中は認証系を呼ばない', gas.calls.length === 1, String(gas.calls.length));

      const later = await resolveLicense({
        licenseKey: makeLicenseKey('1'),
        env,
        nowMs: NOW + LICENSE_CACHE_TTL_MS + MINUTE,
        fetchImpl: gas.fetchImpl,
      });
      check('6時間を過ぎたら問い合わせ直す', later.reason === 'verified' && gas.calls.length === 2, String(gas.calls.length));

      check('ライセンスキーは本文で渡す', gas.calls[0].licenseKey === makeLicenseKey('1'));
      check('action は verifyNotifierLicense', gas.calls[0].action === 'verifyNotifierLicense');
      check('共有シークレットを添える', gas.calls[0].secret === 'shared');
    }

    {
      const env = baseEnv();
      const gas = createAuthGas({ valid: false });
      const result = await resolveLicense({ licenseKey: makeLicenseKey('2'), env, nowMs: NOW, fetchImpl: gas.fetchImpl });

      check('無効なライセンスは expired', result.state === 'expired', JSON.stringify(result));
    }

    {
      /* 解約の反映: 一度 active になった後、認証系が「無効」に変わる。 */
      const env = baseEnv();
      const key = makeLicenseKey('3');
      let valid = true;
      const fetchImpl = async () => new Response(
        JSON.stringify({ ok: true, data: { valid, plan: 'basic', status: 'active' } }),
        { status: 200 },
      );

      const before = await resolveLicense({ licenseKey: key, env, nowMs: NOW, fetchImpl });
      valid = false;

      const cached = await resolveLicense({ licenseKey: key, env, nowMs: NOW + HOUR, fetchImpl });
      const after = await resolveLicense({ licenseKey: key, env, nowMs: NOW + LICENSE_CACHE_TTL_MS + MINUTE, fetchImpl });

      check('解約前は active', before.state === 'active');
      check('解約直後はキャッシュのぶん active のまま', cached.state === 'active', JSON.stringify(cached));
      check('キャッシュ期限（6時間）を過ぎると expired', after.state === 'expired', JSON.stringify(after));
    }

    {
      /* 認証系が落ちたとき。直前まで有効だったキーだけ猶予に入る。 */
      const env = baseEnv();
      const key = makeLicenseKey('4');

      await resolveLicense({ licenseKey: key, env, nowMs: NOW, fetchImpl: createAuthGas({ valid: true }).fetchImpl });

      const down = createAuthGas({ throws: true });
      const graceAt = NOW + LICENSE_CACHE_TTL_MS + MINUTE;
      const grace = await resolveLicense({ licenseKey: key, env, nowMs: graceAt, fetchImpl: down.fetchImpl });

      check('照会不通なら grace', grace.state === 'grace', JSON.stringify(grace));

      const stillGrace = await resolveLicense({ licenseKey: key, env, nowMs: graceAt + MINUTE, fetchImpl: down.fetchImpl });
      check('猶予中は問い合わせ直さない（10分間隔）', stillGrace.state === 'grace' && down.calls.length === 1, String(down.calls.length));

      const recovered = await resolveLicense({
        licenseKey: key,
        env,
        nowMs: graceAt + 11 * MINUTE,
        fetchImpl: createAuthGas({ valid: true }).fetchImpl,
      });
      check('認証系が復帰したら active へ戻る', recovered.state === 'active', JSON.stringify(recovered));

      const record = JSON.parse(await env.LICENSE_CACHE.get(licenseCacheKey(await hashLicenseKey(key))));
      check('復帰時に猶予の起点が引き直される', record.activeConfirmedAt === graceAt + 11 * MINUTE, JSON.stringify(record));
    }

    {
      /* 猶予の上限。起点は「最後に active を確認できた時刻」。 */
      const env = baseEnv();
      const key = makeLicenseKey('5');

      await resolveLicense({ licenseKey: key, env, nowMs: NOW, fetchImpl: createAuthGas({ valid: true }).fetchImpl });

      const down = createAuthGas({ throws: true });

      await resolveLicense({ licenseKey: key, env, nowMs: NOW + LICENSE_CACHE_TTL_MS + MINUTE, fetchImpl: down.fetchImpl });

      const withinGrace = await resolveLicense({
        licenseKey: key,
        env,
        nowMs: NOW + LICENSE_CONTINUATION_MAX_MS - HOUR,
        fetchImpl: down.fetchImpl,
      });
      check('上限内なら grace のまま', withinGrace.state === 'grace', JSON.stringify(withinGrace));

      const exhausted = await resolveLicense({
        licenseKey: key,
        env,
        nowMs: NOW + LICENSE_CONTINUATION_MAX_MS + MINUTE,
        fetchImpl: down.fetchImpl,
      });
      check(
        '上限を超えたら expired',
        exhausted.state === 'expired' && exhausted.reason === 'grace-exhausted',
        JSON.stringify(exhausted),
      );
      check(
        '猶予切れのレコードは書き直さない（復帰時にやり直せるように）',
        JSON.parse(await env.LICENSE_CACHE.get(licenseCacheKey(await hashLicenseKey(key)))).state === 'grace',
      );
    }

    {
      /*
       * KV の結果整合性。反映待ちで**古いレコードを読んだ colo**が
       * 猶予の起点を後ろへずらさないこと。
       *
       * 起点を「照会に失敗した時刻」にしていた実装では、ここで
       * 打ち切り時刻が伸び、不通が続くかぎり失効しなくなっていた。
       */
      const env = baseEnv();
      const key = makeLicenseKey('J');
      const cacheKey = licenseCacheKey(await hashLicenseKey(key));

      await resolveLicense({ licenseKey: key, env, nowMs: NOW, fetchImpl: createAuthGas({ valid: true }).fetchImpl });

      /* 反映前のレコード（照会成功時のもの）を控えておく。 */
      const staleRecord = await env.LICENSE_CACHE.get(cacheKey);

      const down = createAuthGas({ throws: true });

      /* colo A が猶予を書き込む。 */
      await resolveLicense({ licenseKey: key, env, nowMs: NOW + LICENSE_CACHE_TTL_MS + MINUTE, fetchImpl: down.fetchImpl });

      /* colo B はまだ古いレコードを読む。しかも上限の直前に。 */
      await env.LICENSE_CACHE.put(cacheKey, staleRecord);

      const late = await resolveLicense({
        licenseKey: key,
        env,
        nowMs: NOW + LICENSE_CONTINUATION_MAX_MS - MINUTE,
        fetchImpl: down.fetchImpl,
      });
      check('古いレコードを読んでも grace のまま（起点は動かない）', late.state === 'grace', JSON.stringify(late));

      const written = JSON.parse(await env.LICENSE_CACHE.get(cacheKey));
      check(
        '古いレコードを読んだ colo も同じ起点を書く',
        written.activeConfirmedAt === NOW,
        JSON.stringify(written),
      );

      const afterLimit = await resolveLicense({
        licenseKey: key,
        env,
        nowMs: NOW + LICENSE_CONTINUATION_MAX_MS + MINUTE,
        fetchImpl: down.fetchImpl,
      });
      check(
        '打ち切り時刻は伸びない',
        afterLimit.state === 'expired' && afterLimit.reason === 'grace-exhausted',
        JSON.stringify(afterLimit),
      );
    }

    {
      /* 起点を持たない壊れたレコードは猶予に入れない（fail closed）。 */
      const env = baseEnv();
      const key = makeLicenseKey('K');

      await env.LICENSE_CACHE.put(
        licenseCacheKey(await hashLicenseKey(key)),
        JSON.stringify({ v: 1, state: 'grace', plan: 'basic', checkedAt: NOW, activeConfirmedAt: 0 }),
      );

      const result = await resolveLicense({
        licenseKey: key,
        env,
        nowMs: NOW + HOUR,
        fetchImpl: createAuthGas({ throws: true }).fetchImpl,
      });

      check('起点の無い grace レコードは expired', result.state === 'expired' && result.reason === 'unverified', JSON.stringify(result));
    }

    {
      /* 一度も検証できていないキーには猶予を与えない（fail closed）。 */
      const env = baseEnv();
      const down = createAuthGas({ throws: true });
      const result = await resolveLicense({ licenseKey: makeLicenseKey('6'), env, nowMs: NOW, fetchImpl: down.fetchImpl });

      check('未検証のキーは猶予に入らず expired', result.state === 'expired' && result.reason === 'unverified', JSON.stringify(result));
    }

    {
      /* Apps Script は不調時に HTML を返す。これを「無効」と読まないこと。 */
      const env = baseEnv();
      const key = makeLicenseKey('7');

      await resolveLicense({ licenseKey: key, env, nowMs: NOW, fetchImpl: createAuthGas({ valid: true }).fetchImpl });

      const html = createAuthGas({ html: true });
      const result = await resolveLicense({
        licenseKey: key,
        env,
        nowMs: NOW + LICENSE_CACHE_TTL_MS + MINUTE,
        fetchImpl: html.fetchImpl,
      });

      check('HTML が返ってきたら「無効」ではなく「不通」', result.state === 'grace', JSON.stringify(result));
    }

    {
      const env = baseEnv();
      const called = [];
      const result = await resolveLicense({
        licenseKey: 'これは不正な形',
        env,
        nowMs: NOW,
        fetchImpl: async () => { called.push(1); return new Response('{}'); },
      });

      check('形式の違うキーは expired', result.state === 'expired' && result.reason === 'malformed-key', JSON.stringify(result));
      check('形式の違うキーで認証系を呼ばない', called.length === 0);
    }

    {
      const env = { ...baseEnv(), AUTH_GAS_SHARED_SECRET: '' };
      const result = await resolveLicense({ licenseKey: makeLicenseKey('8'), env, nowMs: NOW, fetchImpl: async () => new Response('{}') });

      check('共有シークレット未設定は猶予を与えず expired', result.state === 'expired', JSON.stringify(result));
    }

    {
      /* KV に生のライセンスキーが現れないこと。 */
      const env = baseEnv();
      const key = makeLicenseKey('9');

      await resolveLicense({ licenseKey: key, env, nowMs: NOW, fetchImpl: createAuthGas({ valid: true }).fetchImpl });

      const stored = Array.from(env.LICENSE_CACHE.store.entries())
        .map(([name, value]) => `${name} ${value}`)
        .join('\n');

      check('KV のキーにも値にも生のライセンスキーを書かない', stored.includes(key) === false, stored);
    }
  }

  section('VAPID — WebCrypto での ES256 署名');

  {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const pkcs8 = Buffer.from(await crypto.subtle.exportKey('pkcs8', pair.privateKey)).toString('base64');

    const imported = await importVapidPrivateKey(pkcs8);
    const jwt = await signJwt({
      privateKey: imported,
      audience: 'https://fcm.googleapis.com',
      subject: 'https://tsam-ai.com/production-app/voice-recorder/',
      nowMs: NOW,
    });

    const [headerPart, claimsPart, signaturePart] = jwt.split('.');
    const header = JSON.parse(Buffer.from(base64ToBytes(headerPart)).toString('utf8'));
    const claims = JSON.parse(Buffer.from(base64ToBytes(claimsPart)).toString('utf8'));

    check('alg は ES256', header.alg === 'ES256' && header.typ === 'JWT', JSON.stringify(header));
    check('aud は push サービスの origin', claims.aud === 'https://fcm.googleapis.com');
    check('sub は運営の連絡先', claims.sub === 'https://tsam-ai.com/production-app/voice-recorder/');
    check('exp は12時間後', claims.exp === Math.floor((NOW + 12 * HOUR) / 1000), String(claims.exp));

    /* 署名の生バイトが64バイト（r||s）であること＝DER でラップされていないこと。 */
    check('署名は r||s の64バイト', base64ToBytes(signaturePart).length === 64, String(base64ToBytes(signaturePart).length));

    const verified = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      pair.publicKey,
      base64ToBytes(signaturePart),
      new TextEncoder().encode(`${headerPart}.${claimsPart}`),
    );
    check('公開鍵で署名を検証できる', verified === true);

    const pem = `-----BEGIN PRIVATE KEY-----\n${pkcs8}\n-----END PRIVATE KEY-----`;
    check('PEM 形式でも読める', (await importVapidPrivateKey(pem)) !== null);

    const jwk = JSON.stringify(await crypto.subtle.exportKey('jwk', pair.privateKey));
    check('JWK 形式でも読める', (await importVapidPrivateKey(jwk)) !== null);
  }

  section('VAPID — aud の制限');

  {
    const hosts = ['fcm.googleapis.com', 'notify.windows.com'];

    check('既知の push サービスは許可', isAllowedAudience('https://fcm.googleapis.com', hosts) === true);
    check('サブドメインも許可', isAllowedAudience('https://wns2-by3p.notify.windows.com', hosts) === true);
    check('http は不可', isAllowedAudience('http://fcm.googleapis.com', hosts) === false);
    check('パス付きは不可', isAllowedAudience('https://fcm.googleapis.com/fcm/send/abc', hosts) === false);
    check('未知のホストは不可', isAllowedAudience('https://evil.example.com', hosts) === false);
    check('似せたホストは不可', isAllowedAudience('https://fcm.googleapis.com.evil.example', hosts) === false);

    const normalized = normalizeAudiences(
      ['https://fcm.googleapis.com', 'https://fcm.googleapis.com'],
      hosts,
    );
    check('重複した aud は1つにまとめる', normalized.ok === true && normalized.list.length === 1, JSON.stringify(normalized));
    check('空の配列は拒否', normalizeAudiences([], hosts).ok === false);
    check('1つでも許可外があれば全体を拒否', normalizeAudiences(['https://fcm.googleapis.com', 'https://evil.example'], hosts).ok === false);
  }

  section('HTTP — エンドポイント');

  {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const pkcs8 = Buffer.from(await crypto.subtle.exportKey('pkcs8', pair.privateKey)).toString('base64');

    const kv = createKv();
    const env = {
      LICENSE_CACHE: kv,
      AUTH_GAS_URL: 'https://example.invalid/exec',
      AUTH_GAS_SHARED_SECRET: 'shared',
      VAPID_PRIVATE_KEY: pkcs8,
      VAPID_PUBLIC_KEY: 'BPublicKeyPlaceholder',
      VAPID_SUBJECT: 'https://tsam-ai.com/production-app/voice-recorder/',
      ALLOWED_ORIGINS: 'https://tsam-ai.com',
    };

    /* 認証系を呼ばせないため、KV へ判定結果を直接置く。 */
    async function seedLicense(key, state) {
      await kv.put(
        licenseCacheKey(await hashLicenseKey(key)),
        JSON.stringify({
          v: 1,
          state,
          plan: 'basic',
          checkedAt: Date.now(),
          activeConfirmedAt: state === 'expired' ? 0 : Date.now(),
        }),
      );
    }

    function post(path, body, headers = {}) {
      return worker.fetch(
        new Request(`https://api.potenitas.com${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8', ...headers },
          body: JSON.stringify(body),
        }),
        env,
      );
    }

    {
      const response = await worker.fetch(new Request('https://api.potenitas.com/v1/health'), env);
      const body = await response.json();
      check('health は版を返す', response.status === 200 && body.ok === true && typeof body.version === 'string', JSON.stringify(body));
      check('health に予定の情報は無い', Object.keys(body).join(',') === 'ok,version', Object.keys(body).join(','));
    }

    {
      const response = await worker.fetch(new Request('https://api.potenitas.com/v1/unknown', { method: 'POST', body: '{}' }), env);
      check('未知のパスは 404', response.status === 404);
    }

    {
      const response = await worker.fetch(new Request('https://api.potenitas.com/v1/evaluate'), env);
      check('evaluate への GET は 405', response.status === 405);
    }

    {
      const response = await post('/v1/evaluate', { licenseKey: 'short' });
      const body = await response.json();
      check('形式の違うライセンスキーは 401', response.status === 401 && body.error.code === 'UNAUTHORIZED', JSON.stringify(body));
    }

    {
      const key = makeLicenseKey('A');
      await seedLicense(key, 'active');

      const response = await post('/v1/evaluate', {
        licenseKey: key,
        settings: SETTINGS,
        events: [makeEvent({ startAt: new Date(Date.now() + HOUR).toISOString() })],
        sentDigest: [],
      });
      const body = await response.json();

      check('active なら判定を返す', response.status === 200 && body.ok === true && body.notify.length === 1, JSON.stringify(body));
      check('licenseState を返す', body.licenseState === 'active');
      check('remove は eid の配列', Array.isArray(body.remove));
    }

    {
      const key = makeLicenseKey('B');
      await seedLicense(key, 'active');

      const response = await post('/v1/evaluate', {
        licenseKey: key,
        settings: SETTINGS,
        events: [{ ...makeEvent(), summary: '取締役会' }],
        sentDigest: [],
      });
      const body = await response.json();

      check('予定名を混ぜた要求は拒否する', response.status === 400 && body.error.code === 'INVALID_REQUEST', JSON.stringify(body));
      check('拒否の文面に値そのものを含めない', JSON.stringify(body).includes('取締役会') === false, JSON.stringify(body));
    }

    {
      const key = makeLicenseKey('C');
      await seedLicense(key, 'expired');

      const response = await post('/v1/evaluate', {
        licenseKey: key,
        settings: SETTINGS,
        events: [makeEvent()],
        sentDigest: [],
      });
      const body = await response.json();

      check(
        'expired の evaluate は空の判定を返す',
        response.status === 200 && body.ok === true && body.notify.length === 0 && body.licenseState === 'expired',
        JSON.stringify(body),
      );
    }

    {
      const key = makeLicenseKey('D');
      await seedLicense(key, 'expired');

      const response = await post('/v1/vapid', { licenseKey: key, audiences: ['https://fcm.googleapis.com'] });
      const body = await response.json();

      check('expired には VAPID JWT を発行しない', response.status === 402 && body.error.code === 'LICENSE_EXPIRED', JSON.stringify(body));
    }

    {
      const key = makeLicenseKey('E');
      await seedLicense(key, 'grace');

      const response = await post('/v1/vapid', { licenseKey: key, audiences: ['https://fcm.googleapis.com'] });
      const body = await response.json();

      check('grace には発行する', response.status === 200 && body.ok === true, JSON.stringify(body));
      check('公開鍵を返す', body.publicKey === 'BPublicKeyPlaceholder');
      check('aud ごとの JWT を返す', typeof body.jwts['https://fcm.googleapis.com'] === 'string');
      check('有効期限を返す', typeof body.expiresAt === 'string');
    }

    {
      const key = makeLicenseKey('F');
      await seedLicense(key, 'active');

      const response = await post('/v1/test-notify', { licenseKey: key });
      const body = await response.json();
      check('test-notify は許可を返す', response.status === 200 && body.ok === true, JSON.stringify(body));

      const second = await post('/v1/test-notify', { licenseKey: key });
      check('test-notify は1日1回に制限する', second.status === 429, String(second.status));
    }

    {
      const key = makeLicenseKey('G');
      await seedLicense(key, 'active');

      const payload = { licenseKey: key, settings: SETTINGS, events: [], sentDigest: [] };

      await post('/v1/evaluate', payload);
      await post('/v1/evaluate', payload);
      const third = await post('/v1/evaluate', payload);

      check('evaluate は1分2回に制限する', third.status === 429, String(third.status));
    }

    {
      const key = makeLicenseKey('H');
      await seedLicense(key, 'active');

      const allowed = await post('/v1/test-notify', { licenseKey: key }, { Origin: 'https://tsam-ai.com' });
      check('許可オリジンには CORS ヘッダーを返す', allowed.headers.get('Access-Control-Allow-Origin') === 'https://tsam-ai.com');

      const other = await post('/v1/test-notify', { licenseKey: makeLicenseKey('I') }, { Origin: 'https://evil.example' });
      check('許可外オリジンには CORS ヘッダーを返さない', other.headers.get('Access-Control-Allow-Origin') === null);
    }

    {
      const response = await post('/v1/evaluate', {});
      check('licenseKey が無ければ 401', response.status === 401);

      const broken = await worker.fetch(
        new Request('https://api.potenitas.com/v1/evaluate', { method: 'POST', body: 'これは JSON ではない' }),
        env,
      );
      check('本文が JSON でなければ 400', broken.status === 400);
    }

    {
      const response = await worker.fetch(
        new Request('https://api.potenitas.com/v1/evaluate', {
          method: 'OPTIONS',
          headers: { Origin: 'https://tsam-ai.com' },
        }),
        env,
      );
      check('プリフライトは 204', response.status === 204);
      check('プリフライトにも CORS ヘッダー', response.headers.get('Access-Control-Allow-Origin') === 'https://tsam-ai.com');
    }
  }

  finish();
}

try {
  await run();
} catch (error) {
  fatal(error);
}

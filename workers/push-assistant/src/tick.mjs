/**
 * Cron（毎分）の本体（仕様書 §8-3）。
 *
 * ==================================================================
 * 1 人の失敗を全体へ波及させない（完成条件 I）
 * ==================================================================
 * 利用者ごとの処理を **try/catch で 1 人ずつ囲む。** ここを省くと、
 * 誰か 1 人の Calendar が 500 を返しただけで scheduled 全体が落ち、
 * その分の通知が全員ぶん飛ぶ。しかも Cron は次の分に再実行されるので、
 * 同じ人で毎回落ち続ける＝**恒久的に全員へ通知が届かなくなる**。
 *
 * 「エラーは数えて次へ進む」を守るために、下の各段階は
 * 例外ではなく戻り値で失敗を伝える設計にしてある
 * （calendar.mjs / webpush.mjs / access-token.mjs）。
 * catch は「想定外」だけを受け止める最後の網である。
 * ==================================================================
 *
 * ==================================================================
 * ログに秘密を入れない
 * ==================================================================
 * log(level, code, detail) の detail に入れてよいのは、
 * **利用者 ID・件数・HTTP ステータス・分類語**だけ。
 * 予定名・URL・トークン・購読の鍵は入れない（仕様書 §10）。
 * 予定名を入れたくなるが、wrangler tail は運用者の画面に流れ続けるため、
 * そこに他人の会議名が出てよい理由が無い。
 * ==================================================================
 */

import {
  LOOKAHEAD_MS,
  LOOKBEHIND_MS,
  MAX_ATTEMPTS,
  MAX_USERS_PER_TICK,
  STALE_PENDING_MS,
} from './constants.mjs';
import { ensureAccessToken } from './access-token.mjs';
import { listUpcomingEvents } from './calendar.mjs';
import { planNotifications } from './schedule.mjs';
import { renderNotification } from './template.mjs';
import { sendWebPush } from './webpush.mjs';

/** 何もしない log（呼び出し側が渡さなかったとき用）。 */
const NO_LOG = () => {};

/**
 * 1 tick ぶんを実行する。
 *
 * @param {{ store: object, env: object, vapid: object, encryptionKey: CryptoKey,
 *           clientId: string, clientSecret: string, appUrl: string,
 *           nowMs: number, fetchImpl?: typeof fetch, log?: Function }} input
 * @returns {Promise<{users:number, planned:number, sent:number, failed:number, skipped:number, errors:number}>}
 */
export async function runTick({
  store,
  vapid,
  encryptionKey,
  clientId,
  clientSecret,
  appUrl,
  nowMs,
  fetchImpl = fetch,
  log = NO_LOG,
  maxUsers = MAX_USERS_PER_TICK,
}) {
  const nowIso = new Date(nowMs).toISOString();
  const summary = { users: 0, planned: 0, sent: 0, failed: 0, skipped: 0, errors: 0 };

  const users = await store.listActiveUsers(maxUsers);

  summary.users = users.length;

  for (const user of users) {
    try {
      const result = await runForUser({
        store,
        user,
        vapid,
        encryptionKey,
        clientId,
        clientSecret,
        appUrl,
        nowMs,
        nowIso,
        fetchImpl,
        log,
      });

      summary.planned += result.planned;
      summary.sent += result.sent;
      summary.failed += result.failed;
      summary.skipped += result.skipped;
      summary.errors += result.errors;
    } catch (error) {
      /*
       * ここへ来るのは想定外（store が投げた等）。**次の利用者へ進む。**
       * 例外の message には入力の断片が混ざりうるので、name だけ残す。
       */
      summary.errors += 1;
      log('error', 'USER_TICK_CRASHED', `user=${user.id} name=${error?.name ?? 'Error'}`);
    }

    /*
     * **成功・失敗にかかわらず印を付ける。** 失敗した人だけ印が付かないと、
     * その人が毎分先頭に居座り、MAX_USERS_PER_TICK を超えた分の
     * 後ろの利用者へ順番が回らなくなる（store.listActiveUsers の並び順）。
     * ここが落ちても tick 全体は止めない。
     */
    try {
      await store.touchUserTick(user.id, nowIso);
    } catch (error) {
      log('warn', 'TOUCH_TICK_FAILED', `user=${user.id} name=${error?.name ?? 'Error'}`);
    }
  }

  log('info', 'TICK_DONE', formatSummary(summary));

  return summary;
}

/** 利用者 1 人ぶん。 */
async function runForUser({
  store,
  user,
  vapid,
  encryptionKey,
  clientId,
  clientSecret,
  appUrl,
  nowMs,
  nowIso,
  fetchImpl,
  log,
}) {
  const result = { planned: 0, sent: 0, failed: 0, skipped: 0, errors: 0 };

  /* ---- 1. アクセストークン ---- */

  const token = await ensureAccessToken({
    store,
    userId: user.id,
    clientId,
    clientSecret,
    encryptionKey,
    nowMs,
    nowIso,
    fetchImpl,
  });

  if (!token.ok) {
    result.errors += 1;
    log('warn', `TOKEN_${token.code}`, `user=${user.id}${token.status ? ` status=${token.status}` : ''}`);
    return result;
  }

  /* ---- 2. Calendar ---- */

  const calendar = await listUpcomingEvents({
    accessToken: token.accessToken,
    timeMinMs: nowMs - LOOKBEHIND_MS,
    timeMaxMs: nowMs + LOOKAHEAD_MS,
    fetchImpl,
  });

  if (!calendar.ok) {
    /*
     * 401 は「取り直せば直る」種類。次の tick では access_token_expires_at が
     * 残っていても refresh から始まるよう、キャッシュを無効化しておく…
     * ということはしない。**期限は Google が付けた値であり、401 は
     * 権限剥奪などトークン以外の理由でも起きる。** 次の tick で同じ結果に
     * なるだけで害は無いので、状態を書き換えずに数えて戻る。
     */
    result.errors += 1;
    log('warn', calendar.code, `user=${user.id} status=${calendar.status}`);
    return result;
  }

  /* ---- 3. 通知の予定表 → 行の作成 ---- */

  /*
   * 予定ごとの手動上書き（仕様書 §7・§9）を先に引く。
   * **行を作る前に上書きを確定させる。** これが無いと、利用者が通知の
   * 前に文章や URL を直しても、due になったときに作られる行は自動抽出の
   * ままになり、上書きが効かない（画面と実際の通知が食い違う）。
   * 上書きが無い予定は空 Map になり、従来どおり自動抽出で作られる。
   */
  const overrides = await store.listOverrides(
    user.id,
    calendar.events.map((event) => event.id),
  );

  const plans = planNotifications({
    events: calendar.events,
    leadMinutes: user.leadMinutes,
    nowMs,
    appUrl,
    overrides,
    /* 全予定共通の「タップで開く URL」（notify_url、仕様書 §9）。空なら自動抽出。 */
    globalUrl: String(user.notifyUrl ?? ''),
  });

  for (const plan of plans) {
    if (plan.due === 'future') {
      /* まだ先。行は作らない（仕様書 §8-4）。 */
      continue;
    }

    const inserted = await store.insertNotificationIfAbsent({
      userId: user.id,
      eventId: plan.eventId,
      eventStart: plan.eventStart,
      leadMinutes: plan.leadMinutes,
      notifyAt: new Date(plan.notifyAtMs).toISOString(),
      title: plan.title,
      openUrl: plan.openUrl,
      urlSource: plan.urlSource,
      status: plan.due === 'due' ? 'pending' : 'skipped',
      nowIso,
    });

    if (!inserted) {
      /* すでにある＝過去の tick で作った。二重通知防止（試験 D）。 */
      continue;
    }

    if (plan.due === 'due') {
      result.planned += 1;
    } else {
      result.skipped += 1;
    }
  }

  /* ---- 4. 送信対象の確保 ---- */

  const claimed = await store.claimDueNotifications(user.id, nowMs);

  if (claimed.length === 0) {
    return result;
  }

  const subscriptions = await store.listActiveSubscriptions(user.id);

  /* ---- 5. 送信 ---- */

  /*
   * 通知テンプレート（グローバル。仕様書 §8）。title は notify_title を使う
   * （空なら予定名。§8-8）。
   *
   * **body は常に空文字を渡す＝既定本文（「HH:MM 開始（あと N 分）」）に固定する。**
   * 画面の簡素化（§15）で本文テンプレートの入力欄を撤去したため、既存利用者の
   * notify_body に値が残っていても通知本文には出さない。notify_body 列と
   * renderNotification の置換ロジックは DB 後方互換・将来用に残すが、ここでは使わない。
   */
  const template = {
    title: String(user.notifyTitle ?? ''),
    body: '',
  };

  /*
   * ------------------------------------------------------------------
   * event_overrides は通知テンプレートより優先（仕様書 §8-7）
   * ------------------------------------------------------------------
   * 上書きタイトルがある予定では、グローバルなテンプレートタイトル（問いかけ）
   * ではなく上書きタイトルを出す。notifications.title は行の作成時に
   * 上書きが反映済みなので、その予定については template.title を空にして渡し、
   * event.title（＝上書き後のタイトル）を採らせる。
   *
   * テンプレートタイトルが未設定なら、どのみち event.title を使うので
   * 上書きの引き直しは要らない（無駄な D1 アクセスを避ける）。
   * 上書き URL は notifications.open_url に反映済みで、本文の `{url}` にも
   * そのまま入る。
   * ------------------------------------------------------------------
   */
  const overrideTitles = template.title !== ''
    ? await store.listOverrides(user.id, claimed.map((notification) => notification.eventId))
    : new Map();

  for (const notification of claimed) {
    const override = overrideTitles.get?.(notification.eventId) ?? null;
    const hasOverrideTitle = Boolean(override && String(override.title ?? '') !== '');

    const rendered = renderNotification({
      template: {
        title: hasOverrideTitle ? '' : template.title,
        body: template.body,
      },
      event: {
        title: notification.title,
        url: notification.openUrl,
        startMs: Date.parse(notification.eventStart),
        leadMinutes: notification.leadMinutes,
      },
    });

    const outcome = await deliver({
      store,
      subscriptions,
      notification,
      title: rendered.title,
      body: rendered.body,
      vapid,
      nowMs,
      nowIso,
      fetchImpl,
    });

    if (outcome.sent) {
      await store.markNotificationSent(notification.id, nowIso);
      result.sent += 1;
      log('info', 'NOTIFY_SENT', `user=${user.id} id=${notification.id} lead=${notification.leadMinutes}`);
      continue;
    }

    const attempts = notification.attempts + 1;
    const notifyAtMs = Date.parse(notification.notifyAt);
    const tooOld = Number.isFinite(notifyAtMs) && nowMs - notifyAtMs >= STALE_PENDING_MS;

    if (!outcome.retryable || attempts >= MAX_ATTEMPTS || tooOld) {
      await store.markNotificationFailed(
        notification.id,
        { attempts, lastError: outcome.reason },
        nowIso,
      );
      result.failed += 1;
      log('warn', 'NOTIFY_FAILED', `user=${user.id} id=${notification.id} reason=${outcome.reason} attempts=${attempts}`);
      continue;
    }

    /* 送り直す。pending に戻すので次の tick が拾う（試験 J）。 */
    await store.markNotificationRetry(
      notification.id,
      { attempts, lastError: outcome.reason },
      nowIso,
    );
    log('info', 'NOTIFY_RETRY', `user=${user.id} id=${notification.id} reason=${outcome.reason} attempts=${attempts}`);
  }

  return result;
}

/**
 * 1 件の通知を、その利用者の全購読へ送る。
 *
 * **1 台でも成功すれば「送れた」とする。** 端末を複数持っている人の
 * うち 1 台が壊れた購読でも、通知そのものは届いている。全滅したときだけ
 * 再試行の対象にする。
 */
async function deliver({ store, subscriptions, notification, title, body, vapid, nowMs, nowIso, fetchImpl }) {
  if (subscriptions.length === 0) {
    return { sent: false, retryable: false, reason: 'NO_SUBSCRIPTION' };
  }

  const payload = {
    v: 1,
    kind: 'event',
    /* タイトル・本文は renderNotification（template.mjs）で作って渡される。 */
    title,
    body,
    url: notification.openUrl,
    /* 同じ通知を OS 側でも重ねない（仕様書 §8-5）。 */
    tag: `pa:${notification.eventId}:${notification.leadMinutes}`,
    notificationId: notification.id,
  };

  let sent = false;
  let retryable = false;
  let reason = 'UNKNOWN';

  for (const subscription of subscriptions) {
    const outcome = await sendWebPush({ subscription, payload, vapid, fetchImpl, nowMs });

    if (outcome.ok) {
      sent = true;
      await store.recordSubscriptionResult(subscription.id, { ok: true }, nowIso);
      continue;
    }

    if (outcome.gone) {
      /* 購読はもう存在しない。無効化して二度と送らない（試験 J）。 */
      await store.disableSubscription(subscription.id, nowIso);
    } else {
      await store.recordSubscriptionResult(subscription.id, { ok: false }, nowIso);
    }

    retryable = retryable || outcome.retryable;
    reason = `${outcome.error}:${outcome.status}`;
  }

  return { sent, retryable, reason };
}

function formatSummary(summary) {
  return Object.entries(summary)
    .map(([name, value]) => `${name}=${value}`)
    .join(' ');
}

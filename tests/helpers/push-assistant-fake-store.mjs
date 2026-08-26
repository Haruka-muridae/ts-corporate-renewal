/*
 * Push Assistant の store（workers/push-assistant/src/store.mjs）の偽物。
 *
 * ------------------------------------------------------------------
 * D1 を Node で再現しない
 * ------------------------------------------------------------------
 * SQL を解釈する偽 D1 を書けば「本物の SQL」を試験できるが、
 * それは **SQLite の実装を書くことに等しい。** 労力に見合わず、
 * しかも本物と挙動が違えば試験の意味が無くなる。
 *
 * ここで固めたいのは SQL ではなく **tick の筋**である。
 *   - 同じキーの通知を 2 回作らない（試験 D）
 *   - 1 人の失敗が他へ波及しない（試験 I）
 *   - 送信失敗が pending に戻り、次の tick で送られる（試験 J）
 * これらは store のインターフェース越しに再現できる。
 *
 * SQL 自体は本番投入時の疎通（README §5 の /api/health と初回ログイン）で
 * 確かめる。**この割り切りは README §8 に書いてある。**
 * ------------------------------------------------------------------
 *
 * インターフェースは createD1Store が返すものと同じにしてある。
 * 片方だけメソッドを足すと本番かテストのどちらかが落ちる。
 */

import { STUCK_SENDING_MS } from '../../workers/push-assistant/src/constants.mjs';
import { notificationKey } from '../../workers/push-assistant/src/store.mjs';

/**
 * インメモリ store を作る。
 *
 * @param {{ users?: object[], tokens?: object[], subscriptions?: object[], overrides?: object[] }} seed
 */
export function createFakeStore(seed = {}) {
  const users = new Map();
  const tokens = new Map();
  const subscriptions = [];
  const notifications = [];
  /* 予定ごとの上書き。キーは `${userId} ${eventId}`。 */
  const overrides = new Map();

  let nextSubscriptionId = 1;
  let nextNotificationId = 1;

  for (const user of seed.users ?? []) {
    users.set(user.id, {
      id: user.id,
      email: user.email ?? '',
      notifyEnabled: user.notifyEnabled ?? true,
      leadMinutes: user.leadMinutes ?? [10],
      /* 通知テンプレート（migration 0003）。既定は未設定（空）。 */
      notifyTitle: user.notifyTitle ?? '',
      notifyBody: user.notifyBody ?? '',
      lastTickAt: user.lastTickAt ?? null,
      createdAt: user.createdAt ?? '2026-08-26T00:00:00.000Z',
      updatedAt: user.updatedAt ?? '2026-08-26T00:00:00.000Z',
    });
  }

  for (const token of seed.tokens ?? []) {
    tokens.set(token.userId, {
      userId: token.userId,
      refreshTokenEnc: token.refreshTokenEnc ?? '',
      accessTokenEnc: token.accessTokenEnc ?? '',
      accessTokenExpiresAt: token.accessTokenExpiresAt ?? '',
      scope: token.scope ?? '',
      invalidAt: token.invalidAt ?? null,
      lastError: token.lastError ?? '',
      updatedAt: token.updatedAt ?? '2026-08-26T00:00:00.000Z',
    });
  }

  for (const override of seed.overrides ?? []) {
    overrides.set(`${override.userId} ${override.eventId}`, {
      title: override.title ?? '',
      url: override.url ?? '',
    });
  }

  for (const subscription of seed.subscriptions ?? []) {
    subscriptions.push({
      id: nextSubscriptionId,
      userId: subscription.userId,
      endpoint: subscription.endpoint,
      p256dh: subscription.p256dh,
      auth: subscription.auth,
      userAgent: subscription.userAgent ?? '',
      createdAt: '2026-08-26T00:00:00.000Z',
      lastSuccessAt: null,
      failureCount: 0,
      disabledAt: subscription.disabledAt ?? null,
    });
    nextSubscriptionId += 1;
  }

  const store = {
    /* 検査用に中身を覗く口（本物には無い）。 */
    _users: users,
    _tokens: tokens,
    _subscriptions: subscriptions,
    _notifications: notifications,
    _overrides: overrides,

    async upsertUser({ id, email, nowIso }) {
      const existing = users.get(id);

      if (existing) {
        existing.email = email;
        existing.updatedAt = nowIso;
        return;
      }

      users.set(id, {
        id,
        email,
        notifyEnabled: true,
        leadMinutes: [10],
        notifyTitle: '',
        notifyBody: '',
        lastTickAt: null,
        createdAt: nowIso,
        updatedAt: nowIso,
      });
    },

    async getUser(userId) {
      const found = users.get(userId);

      return found ? { ...found, leadMinutes: [...found.leadMinutes] } : null;
    },

    async updateSettings(userId, { notifyEnabled, leadMinutes, notifyTitle, notifyBody }, nowIso) {
      const user = users.get(userId);

      if (!user) {
        return;
      }

      user.notifyEnabled = notifyEnabled;
      user.leadMinutes = [...leadMinutes];

      /* 本物の SQL と同じく、文字列で来たときだけ更新（省略なら既存値を保つ）。 */
      if (typeof notifyTitle === 'string') {
        user.notifyTitle = notifyTitle;
      }

      if (typeof notifyBody === 'string') {
        user.notifyBody = notifyBody;
      }

      user.updatedAt = nowIso;
    },

    async saveTokens(userId, values, nowIso) {
      tokens.set(userId, {
        userId,
        refreshTokenEnc: values.refreshTokenEnc,
        accessTokenEnc: values.accessTokenEnc,
        accessTokenExpiresAt: values.accessTokenExpiresAt,
        scope: values.scope,
        /* 本物の SQL と同じく、再接続で invalid を消す。 */
        invalidAt: null,
        lastError: '',
        updatedAt: nowIso,
      });
    },

    async getTokens(userId) {
      const found = tokens.get(userId);

      return found ? { ...found } : null;
    },

    async updateAccessToken(userId, { accessTokenEnc, accessTokenExpiresAt, refreshTokenEnc }, nowIso) {
      const found = tokens.get(userId);

      if (!found) {
        return;
      }

      found.accessTokenEnc = accessTokenEnc;
      found.accessTokenExpiresAt = accessTokenExpiresAt;

      /* 渡されたときだけ差し替える（本物の SQL と同じ。空で潰さない）。 */
      if (refreshTokenEnc) {
        found.refreshTokenEnc = refreshTokenEnc;
      }

      found.updatedAt = nowIso;
    },

    async markTokenInvalid(userId, reason, nowIso) {
      const found = tokens.get(userId);

      if (!found) {
        return;
      }

      found.invalidAt = nowIso;
      found.lastError = String(reason).slice(0, 200);
      found.updatedAt = nowIso;
    },

    async deleteUserData(userId) {
      users.delete(userId);
      tokens.delete(userId);

      for (let i = subscriptions.length - 1; i >= 0; i -= 1) {
        if (subscriptions[i].userId === userId) {
          subscriptions.splice(i, 1);
        }
      }

      for (let i = notifications.length - 1; i >= 0; i -= 1) {
        if (notifications[i].userId === userId) {
          notifications.splice(i, 1);
        }
      }

      /* 本物の store と同じく event_overrides もこの利用者ぶん消す。 */
      for (const key of [...overrides.keys()]) {
        if (key.startsWith(`${userId} `)) {
          overrides.delete(key);
        }
      }
    },

    async upsertSubscription({ userId, endpoint, p256dh, auth, userAgent, nowIso }) {
      const existingIndex = subscriptions.findIndex((row) => row.endpoint === endpoint);
      const existing = existingIndex < 0 ? null : subscriptions[existingIndex];

      if (existing && existing.userId === userId) {
        /* 同じ利用者の再登録。従来どおりの upsert。 */
        existing.p256dh = p256dh;
        existing.auth = auth;
        existing.userAgent = userAgent ?? '';
        existing.failureCount = 0;
        existing.disabledAt = null;
        return { reassignedFrom: null };
      }

      let reassignedFrom = null;

      if (existing) {
        /* 所有者が変わる。旧行は削除して作り直す（本物の store と同じ）。 */
        reassignedFrom = existing.userId;
        subscriptions.splice(existingIndex, 1);
      }

      subscriptions.push({
        id: nextSubscriptionId,
        userId,
        endpoint,
        p256dh,
        auth,
        userAgent: userAgent ?? '',
        createdAt: nowIso,
        lastSuccessAt: null,
        failureCount: 0,
        disabledAt: null,
      });

      nextSubscriptionId += 1;

      return { reassignedFrom };
    },

    async deleteSubscription(userId, endpoint) {
      const index = subscriptions.findIndex(
        (row) => row.userId === userId && row.endpoint === endpoint,
      );

      if (index < 0) {
        return false;
      }

      subscriptions.splice(index, 1);

      return true;
    },

    async listActiveSubscriptions(userId) {
      return subscriptions
        .filter((row) => row.userId === userId && row.disabledAt === null)
        .map((row) => ({ id: row.id, endpoint: row.endpoint, p256dh: row.p256dh, auth: row.auth }));
    },

    async disableSubscription(subscriptionId, nowIso) {
      const found = subscriptions.find((row) => row.id === subscriptionId);

      if (found) {
        found.disabledAt = nowIso;
      }
    },

    async recordSubscriptionResult(subscriptionId, { ok }, nowIso) {
      const found = subscriptions.find((row) => row.id === subscriptionId);

      if (!found) {
        return;
      }

      if (ok) {
        found.lastSuccessAt = nowIso;
        found.failureCount = 0;
      } else {
        found.failureCount += 1;
      }
    },

    async countActiveSubscriptions(userId) {
      return subscriptions.filter((row) => row.userId === userId && row.disabledAt === null).length;
    },

    async listActiveUsers(limit) {
      const out = [];

      for (const user of users.values()) {
        if (!user.notifyEnabled) {
          continue;
        }

        const token = tokens.get(user.id);

        if (!token || token.invalidAt) {
          continue;
        }

        const hasSubscription = subscriptions.some(
          (row) => row.userId === user.id && row.disabledAt === null,
        );

        if (!hasSubscription) {
          continue;
        }

        out.push({
          id: user.id,
          leadMinutes: [...user.leadMinutes],
          notifyTitle: user.notifyTitle ?? '',
          notifyBody: user.notifyBody ?? '',
          lastTickAt: user.lastTickAt,
        });
      }

      /* 本物の SQL と同じ: COALESCE(last_tick_at, '') ASC, id ASC。 */
      out.sort((a, b) => {
        const left = a.lastTickAt ?? '';
        const right = b.lastTickAt ?? '';

        if (left !== right) {
          return left < right ? -1 : 1;
        }

        return a.id < b.id ? -1 : 1;
      });

      return out.slice(0, limit).map((row) => ({
        id: row.id,
        leadMinutes: row.leadMinutes,
        notifyTitle: row.notifyTitle,
        notifyBody: row.notifyBody,
      }));
    },

    async touchUserTick(userId, nowIso) {
      const user = users.get(userId);

      if (user) {
        user.lastTickAt = nowIso;
      }
    },

    async insertNotificationIfAbsent(row) {
      const key = notificationKey(row.eventId, row.eventStart, row.leadMinutes);

      const exists = notifications.some(
        (item) => item.userId === row.userId
          && notificationKey(item.eventId, item.eventStart, item.leadMinutes) === key,
      );

      if (exists) {
        return false;
      }

      notifications.push({
        id: nextNotificationId,
        userId: row.userId,
        eventId: row.eventId,
        eventStart: row.eventStart,
        leadMinutes: row.leadMinutes,
        notifyAt: row.notifyAt,
        title: row.title,
        openUrl: row.openUrl,
        urlSource: row.urlSource,
        status: row.status,
        attempts: 0,
        lastError: '',
        sentAt: null,
        createdAt: row.nowIso,
        updatedAt: row.nowIso,
      });

      nextNotificationId += 1;

      return true;
    },

    async claimDueNotifications(userId, nowMs, limit = 5) {
      const nowIso = new Date(nowMs).toISOString();
      /* 取り残された sending も拾い直す（本物の SQL と同じ条件）。 */
      const stuckBefore = new Date(nowMs - STUCK_SENDING_MS).toISOString();

      const claimed = [];

      for (const row of notifications) {
        if (claimed.length >= limit) {
          break;
        }

        if (row.userId !== userId || row.notifyAt > nowIso) {
          continue;
        }

        const claimable = row.status === 'pending'
          || (row.status === 'sending' && row.updatedAt <= stuckBefore);

        if (!claimable) {
          continue;
        }

        row.status = 'sending';
        row.updatedAt = nowIso;
        claimed.push({ ...row });
      }

      return claimed;
    },

    async markNotificationSent(id, nowIso) {
      const row = notifications.find((item) => item.id === id);

      if (!row) {
        return;
      }

      row.status = 'sent';
      row.sentAt = nowIso;
      row.attempts += 1;
      row.lastError = '';
      row.updatedAt = nowIso;
    },

    async markNotificationRetry(id, { attempts, lastError }, nowIso) {
      const row = notifications.find((item) => item.id === id);

      if (!row) {
        return;
      }

      row.status = 'pending';
      row.attempts = attempts;
      row.lastError = String(lastError).slice(0, 200);
      row.updatedAt = nowIso;
    },

    async markNotificationFailed(id, { attempts, lastError }, nowIso) {
      const row = notifications.find((item) => item.id === id);

      if (!row) {
        return;
      }

      row.status = 'failed';
      row.attempts = attempts;
      row.lastError = String(lastError).slice(0, 200);
      row.updatedAt = nowIso;
    },

    async listNotifications(userId, limit) {
      return notifications
        .filter((row) => row.userId === userId)
        .slice()
        .reverse()
        .slice(0, limit)
        .map((row) => ({ ...row }));
    },

    async findNotificationStatuses(userId, keys) {
      const wanted = new Set(
        (keys ?? []).map((key) => notificationKey(key.eventId, key.eventStart, key.leadMinutes)),
      );

      const out = {};

      for (const row of notifications) {
        if (row.userId !== userId) {
          continue;
        }

        const key = notificationKey(row.eventId, row.eventStart, row.leadMinutes);

        if (wanted.has(key)) {
          out[key] = row.status;
        }
      }

      return out;
    },

    /* ---------------- 予定ごとの上書き ---------------- */

    async listOverrides(userId, eventIds) {
      const ids = new Set(
        (eventIds ?? []).filter((id) => typeof id === 'string' && id !== ''),
      );

      const map = new Map();

      for (const id of ids) {
        const found = overrides.get(`${userId} ${id}`);

        if (found) {
          map.set(id, { title: found.title, url: found.url });
        }
      }

      return map;
    },

    async getOverride(userId, eventId) {
      const found = overrides.get(`${userId} ${eventId}`);

      return found ? { title: found.title, url: found.url } : null;
    },

    async upsertOverride(userId, eventId, { title, url }, nowIso) {
      const cleanTitle = String(title ?? '');
      const cleanUrl = String(url ?? '');
      const key = `${userId} ${eventId}`;

      if (cleanTitle === '' && cleanUrl === '') {
        overrides.delete(key);
        return { title: '', url: '' };
      }

      overrides.set(key, { title: cleanTitle, url: cleanUrl });

      /* 本物の SQL と同じ: pending の通知だけへ即時反映する。 */
      for (const row of notifications) {
        if (row.userId !== userId || row.eventId !== eventId || row.status !== 'pending') {
          continue;
        }

        if (cleanTitle !== '') {
          row.title = cleanTitle;
          row.updatedAt = nowIso;
        }

        if (cleanUrl !== '') {
          row.openUrl = cleanUrl;
          row.urlSource = 'custom';
          row.updatedAt = nowIso;
        }
      }

      return { title: cleanTitle, url: cleanUrl };
    },
  };

  return store;
}

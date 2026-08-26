/**
 * D1 への読み書きを 1 か所に閉じ込める（仕様書 §6）。
 *
 * ==================================================================
 * SQL を他のモジュールへ漏らさない
 * ==================================================================
 * api.mjs と tick.mjs が直接 db.prepare() を書くと、
 * **`WHERE user_id = ?` を 1 か所書き忘れるだけで他人の予定が見える。**
 * ここを通す形にしておけば、その検査を 1 ファイルの読み合わせで済ませられる。
 * 実際、下のすべての読み書きは user_id で絞ってある（仕様書 §10）。
 *
 * 併せて、テストが同じインターフェースの偽物
 * （tests/helpers/push-assistant-fake-store.mjs）を差し込めるようになる。
 * D1 の SQL を Node で再現するのは無理があるので、tick の試験は
 * 偽 store で行い、SQL 自体は本番投入時の疎通で確かめる（README §5）。
 * ==================================================================
 *
 * ------------------------------------------------------------------
 * 時刻は ISO 文字列で持つ
 * ------------------------------------------------------------------
 * SQLite に日付型は無い。`new Date(ms).toISOString()` は桁数が固定
 * （YYYY-MM-DDTHH:mm:ss.sssZ）なので、**文字列の大小比較がそのまま
 * 時刻の前後になる。** notify_at <= ? の比較はこれに依存している。
 * 別の書式（`Date.toString()` など）を混ぜないこと。
 * ------------------------------------------------------------------
 */

import { MAX_NOTIFICATIONS_PER_USER_TICK, STUCK_SENDING_MS } from './constants.mjs';

/** 通知 1 件を一意に指すキー（仕様書 §8-4 の UNIQUE と同じ組み合わせ）。 */
export function notificationKey(eventId, eventStart, leadMinutes) {
  /* 区切りに NUL を使う。event_id にも ISO 時刻にも現れない文字である。 */
  return `${eventId}\u0000${eventStart}\u0000${Number(leadMinutes)}`;
}

/** ISO 文字列へ。store の外から渡る時刻はすべてこれを通す。 */
export function toIso(ms) {
  return new Date(ms).toISOString();
}

/** lead_minutes 列（JSON 文字列）を配列へ。壊れていても落とさない。 */
function parseLeadMinutes(text, fallback) {
  try {
    const parsed = JSON.parse(String(text));

    if (Array.isArray(parsed)) {
      return parsed.map(Number).filter((value) => Number.isInteger(value) && value >= 0);
    }
  } catch {
    /* 落ちない。既定値へ倒す（設定が壊れていても通知は出したい）。 */
  }

  return fallback;
}

function toUser(row, defaultLeadMinutes) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    email: row.email ?? '',
    notifyEnabled: Number(row.notify_enabled) === 1,
    leadMinutes: parseLeadMinutes(row.lead_minutes, defaultLeadMinutes),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toTokens(row) {
  if (!row) {
    return null;
  }

  return {
    userId: row.user_id,
    refreshTokenEnc: row.refresh_token_enc,
    accessTokenEnc: row.access_token_enc ?? '',
    accessTokenExpiresAt: row.access_token_expires_at ?? '',
    scope: row.scope ?? '',
    invalidAt: row.invalid_at ?? null,
    lastError: row.last_error ?? '',
    updatedAt: row.updated_at,
  };
}

function toNotification(row) {
  return {
    id: row.id,
    eventId: row.event_id,
    eventStart: row.event_start,
    leadMinutes: Number(row.lead_minutes),
    notifyAt: row.notify_at,
    title: row.title,
    openUrl: row.open_url,
    urlSource: row.url_source,
    status: row.status,
    attempts: Number(row.attempts ?? 0),
    lastError: row.last_error ?? '',
    sentAt: row.sent_at ?? null,
    createdAt: row.created_at,
  };
}

/**
 * D1 を使う実装を作る。
 *
 * `defaultLeadMinutes` は、lead_minutes 列が壊れていたときの逃げ先。
 * constants.mjs を import せず引数で受けるのは、この層を「SQL と型変換」
 * だけに保つため（通知の方針は tick.mjs / api.mjs 側にある）。
 */
export function createD1Store(db, { defaultLeadMinutes = [10] } = {}) {
  if (!db) {
    throw new Error('D1 バインディング DB がありません。');
  }

  return {
    /* ---------------- 利用者 ---------------- */

    /** 初回ログインで作り、以後はメールアドレスだけ更新する。 */
    async upsertUser({ id, email, nowIso }) {
      await db
        .prepare(
          `INSERT INTO users (id, email, notify_enabled, lead_minutes, created_at, updated_at)
           VALUES (?, ?, 1, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET email = excluded.email, updated_at = excluded.updated_at`,
        )
        .bind(id, email, JSON.stringify(defaultLeadMinutes), nowIso, nowIso)
        .run();
    },

    async getUser(userId) {
      const row = await db.prepare('SELECT * FROM users WHERE id = ?').bind(userId).first();

      return toUser(row, defaultLeadMinutes);
    },

    async updateSettings(userId, { notifyEnabled, leadMinutes }, nowIso) {
      await db
        .prepare('UPDATE users SET notify_enabled = ?, lead_minutes = ?, updated_at = ? WHERE id = ?')
        .bind(notifyEnabled ? 1 : 0, JSON.stringify(leadMinutes), nowIso, userId)
        .run();
    },

    /* ---------------- Google トークン ---------------- */

    /**
     * 接続（再接続）時に呼ぶ。
     *
     * **invalid_at と last_error をここで消す。** 再接続の目的は
     * 「使えなくなった状態から復帰すること」であり、消し忘れると
     * 接続し直しても tick が対象外にし続ける（listActiveUsers が弾く）。
     */
    async saveTokens(userId, { refreshTokenEnc, accessTokenEnc, accessTokenExpiresAt, scope }, nowIso) {
      await db
        .prepare(
          `INSERT INTO google_tokens
             (user_id, refresh_token_enc, access_token_enc, access_token_expires_at, scope,
              invalid_at, last_error, updated_at)
           VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)
           ON CONFLICT(user_id) DO UPDATE SET
             refresh_token_enc = excluded.refresh_token_enc,
             access_token_enc = excluded.access_token_enc,
             access_token_expires_at = excluded.access_token_expires_at,
             scope = excluded.scope,
             invalid_at = NULL,
             last_error = NULL,
             updated_at = excluded.updated_at`,
        )
        .bind(userId, refreshTokenEnc, accessTokenEnc, accessTokenExpiresAt, scope, nowIso)
        .run();
    },

    async getTokens(userId) {
      const row = await db.prepare('SELECT * FROM google_tokens WHERE user_id = ?').bind(userId).first();

      return toTokens(row);
    },

    /**
     * アクセストークンを差し替える。
     *
     * refreshTokenEnc が渡されたときだけリフレッシュトークンも更新する
     * （Google はローテーションすることがある。google-oauth.mjs）。
     * **渡されなかったら触らない。** 空文字で上書きすると、
     * 次の更新で復号できず invalid_at が立って再接続が要る。
     */
    async updateAccessToken(userId, { accessTokenEnc, accessTokenExpiresAt, refreshTokenEnc }, nowIso) {
      if (refreshTokenEnc) {
        await db
          .prepare(
            `UPDATE google_tokens
               SET access_token_enc = ?, access_token_expires_at = ?, refresh_token_enc = ?, updated_at = ?
             WHERE user_id = ?`,
          )
          .bind(accessTokenEnc, accessTokenExpiresAt, refreshTokenEnc, nowIso, userId)
          .run();
        return;
      }

      await db
        .prepare(
          `UPDATE google_tokens
             SET access_token_enc = ?, access_token_expires_at = ?, updated_at = ?
           WHERE user_id = ?`,
        )
        .bind(accessTokenEnc, accessTokenExpiresAt, nowIso, userId)
        .run();
    },

    /** invalid_grant 等。以後この利用者は tick の対象から外れる（再接続が要る）。 */
    async markTokenInvalid(userId, reason, nowIso) {
      await db
        .prepare('UPDATE google_tokens SET invalid_at = ?, last_error = ?, updated_at = ? WHERE user_id = ?')
        .bind(nowIso, String(reason).slice(0, 200), nowIso, userId)
        .run();
    },

    /**
     * 接続解除。**この利用者の行をすべて消す。**
     *
     * ON DELETE CASCADE を当てにしない。D1（SQLite）は既定で
     * 外部キー制約を強制しないことがあり、users だけ消えて
     * 子テーブルが孤児として残ると、次に同じ Google アカウントで
     * 接続したときに古い購読へ通知が飛ぶ。明示的に順番に消す。
     */
    async deleteUserData(userId) {
      await db.batch([
        db.prepare('DELETE FROM event_overrides WHERE user_id = ?').bind(userId),
        db.prepare('DELETE FROM notifications WHERE user_id = ?').bind(userId),
        db.prepare('DELETE FROM push_subscriptions WHERE user_id = ?').bind(userId),
        db.prepare('DELETE FROM google_tokens WHERE user_id = ?').bind(userId),
        db.prepare('DELETE FROM users WHERE id = ?').bind(userId),
      ]);
    },

    /* ---------------- 購読 ---------------- */

    /**
     * 購読を登録する。endpoint が一意キー。
     *
     * ==================================================================
     * 所有者が変わる場合を「無言の upsert」にしない
     * ==================================================================
     * endpoint は端末を指すので、1 台を使い回せば別の利用者から
     * 同じ値が来る（家族での共用、社用端末のアカウント切り替え）。
     * 前の持ち主へ通知が飛び続けるほうが害が大きいので、移すこと自体は正しい。
     *
     * だが **これは「他人の endpoint を送れば、その端末を自分のものにできる」
     * 操作でもある。** 攻撃としての実害は薄い（奪った側の通知が相手の端末へ
     * 出るだけで、相手の予定は見えない）が、**相手は理由も分からずに
     * 通知が止まる。** 無言でやってよい変更ではない。
     *
     * そこで、所有者が変わるときは
     *   - 旧行を削除してから新規挿入する（履歴を引き継がない）
     *   - 呼び出し側が warn ログを残せるよう reassignedFrom を返す
     * とする。**endpoint そのものはログに書かない**（購読の宛先は秘密）。
     * ==================================================================
     *
     * 同じ利用者なら従来どおりの upsert。failure_count と disabled_at を
     * 戻す（再登録＝復活）。
     */
    async upsertSubscription({ userId, endpoint, p256dh, auth, userAgent, nowIso }) {
      const existing = await db
        .prepare('SELECT id, user_id FROM push_subscriptions WHERE endpoint = ?')
        .bind(endpoint)
        .first();

      const previousOwner = existing && existing.user_id !== userId ? existing.user_id : null;

      if (previousOwner !== null) {
        /*
         * 旧行を消してから入れ直す。UPDATE で user_id を書き換えると
         * created_at と last_success_at が前の持ち主のものとして残り、
         * 「いつからこの端末なのか」が読めなくなる。
         */
        await db.batch([
          db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').bind(endpoint),
          db
            .prepare(
              `INSERT INTO push_subscriptions
                 (user_id, endpoint, p256dh, auth, user_agent, created_at, failure_count, disabled_at)
               VALUES (?, ?, ?, ?, ?, ?, 0, NULL)`,
            )
            .bind(userId, endpoint, p256dh, auth, userAgent ?? '', nowIso),
        ]);

        return { reassignedFrom: previousOwner };
      }

      await db
        .prepare(
          `INSERT INTO push_subscriptions
             (user_id, endpoint, p256dh, auth, user_agent, created_at, failure_count, disabled_at)
           VALUES (?, ?, ?, ?, ?, ?, 0, NULL)
           ON CONFLICT(endpoint) DO UPDATE SET
             p256dh = excluded.p256dh,
             auth = excluded.auth,
             user_agent = excluded.user_agent,
             failure_count = 0,
             disabled_at = NULL`,
        )
        .bind(userId, endpoint, p256dh, auth, userAgent ?? '', nowIso)
        .run();

      return { reassignedFrom: null };
    },

    /** 自分の購読だけ消す（他人の endpoint を指定されても消えない）。 */
    async deleteSubscription(userId, endpoint) {
      const result = await db
        .prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?')
        .bind(userId, endpoint)
        .run();

      return Number(result?.meta?.changes ?? 0) > 0;
    },

    async listActiveSubscriptions(userId) {
      const result = await db
        .prepare(
          `SELECT id, endpoint, p256dh, auth FROM push_subscriptions
           WHERE user_id = ? AND disabled_at IS NULL ORDER BY id`,
        )
        .bind(userId)
        .all();

      return (result?.results ?? []).map((row) => ({
        id: row.id,
        endpoint: row.endpoint,
        p256dh: row.p256dh,
        auth: row.auth,
      }));
    },

    /** 404/410 を受けた購読を送信対象から外す。行は履歴として残す。 */
    async disableSubscription(subscriptionId, nowIso) {
      await db
        .prepare('UPDATE push_subscriptions SET disabled_at = ? WHERE id = ?')
        .bind(nowIso, subscriptionId)
        .run();
    },

    async recordSubscriptionResult(subscriptionId, { ok }, nowIso) {
      if (ok) {
        await db
          .prepare('UPDATE push_subscriptions SET last_success_at = ?, failure_count = 0 WHERE id = ?')
          .bind(nowIso, subscriptionId)
          .run();
        return;
      }

      await db
        .prepare('UPDATE push_subscriptions SET failure_count = failure_count + 1 WHERE id = ?')
        .bind(subscriptionId)
        .run();
    },

    async countActiveSubscriptions(userId) {
      const row = await db
        .prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ? AND disabled_at IS NULL')
        .bind(userId)
        .first();

      return Number(row?.n ?? 0);
    },

    /* ---------------- tick の対象 ---------------- */

    /**
     * 通知の対象になりうる利用者（仕様書 §8-3-1）。
     *
     * 3 条件すべてを SQL 側で絞る。Worker 側で絞ると、対象外の利用者の
     * 行まで読み込むことになり、D1 の読み取り行数（Free で 500 万/日）を
     * 無駄に使う。
     *
     * ------------------------------------------------------------------
     * 並び順は「最後に処理した時刻の古い順」
     * ------------------------------------------------------------------
     * id 順に固定すると、利用者が MAX_USERS_PER_TICK を超えた瞬間に
     * **後ろの利用者へ永久に順番が回らなくなる**（毎分同じ先頭 15 人を
     * 処理し続ける）。しかも症状は「特定の人にだけ通知が来ない」で、
     * ログには何も出ない。
     *
     * last_tick_at の昇順にすれば、処理された人は列の最後尾へ回る。
     * NULL（一度も処理していない）は COALESCE で最優先にする。
     * ------------------------------------------------------------------
     */
    async listActiveUsers(limit) {
      const result = await db
        .prepare(
          `SELECT u.id AS id, u.lead_minutes AS lead_minutes
             FROM users u
             JOIN google_tokens t ON t.user_id = u.id
            WHERE u.notify_enabled = 1
              AND t.invalid_at IS NULL
              AND EXISTS (
                SELECT 1 FROM push_subscriptions s
                 WHERE s.user_id = u.id AND s.disabled_at IS NULL
              )
            ORDER BY COALESCE(u.last_tick_at, '') ASC, u.id ASC
            LIMIT ?`,
        )
        .bind(limit)
        .all();

      return (result?.results ?? []).map((row) => ({
        id: row.id,
        leadMinutes: parseLeadMinutes(row.lead_minutes, defaultLeadMinutes),
      }));
    },

    /**
     * 「この分で処理した」印を付ける。
     *
     * **成功・失敗にかかわらず更新する。** 失敗した人だけ印が付かないと、
     * その人が毎分先頭に居座り、後ろの人の順番を食い潰す。
     */
    async touchUserTick(userId, nowIso) {
      await db
        .prepare('UPDATE users SET last_tick_at = ? WHERE id = ?')
        .bind(nowIso, userId)
        .run();
    },

    /* ---------------- 通知 ---------------- */

    /**
     * まだ無ければ作る（仕様書 §8-4 の二重通知防止）。
     *
     * UNIQUE 制約 + INSERT OR IGNORE が要。**「先に SELECT して無ければ
     * INSERT」にしてはいけない。** Cron が重なると両方の SELECT が
     * 「無い」を見て 2 行入り、2 回通知される。
     */
    async insertNotificationIfAbsent(row) {
      const result = await db
        .prepare(
          `INSERT OR IGNORE INTO notifications
             (user_id, event_id, event_start, lead_minutes, notify_at, title, open_url, url_source,
              status, attempts, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
        )
        .bind(
          row.userId,
          row.eventId,
          row.eventStart,
          row.leadMinutes,
          row.notifyAt,
          row.title,
          row.openUrl,
          row.urlSource,
          row.status,
          row.nowIso,
          row.nowIso,
        )
        .run();

      return Number(result?.meta?.changes ?? 0) > 0;
    },

    /**
     * 送信対象を原子的に確保する（仕様書 §8-3-4）。
     *
     * SELECT で候補を挙げ、**1 件ずつ条件付き UPDATE** で pending → sending に
     * 移す。UPDATE の changes が 0 なら、他の tick が先に取った＝こちらは送らない。
     * これが「Cron が重複起動しても二重送信しない」の実体である。
     *
     * ------------------------------------------------------------------
     * 取り残された 'sending' も拾い直す
     * ------------------------------------------------------------------
     * pending しか拾わないと、送信の途中で isolate が落ちた行が
     * **永久に sending のまま残り、二度と送られない**（constants.mjs の
     * STUCK_SENDING_MS）。updated_at が古い sending も候補に入れる。
     *
     * 二重送信にはならない。UPDATE の条件にも同じ時刻を入れてあるので、
     * 先に取ったほうが updated_at を今にした時点で、後続の条件は成立しない。
     * ------------------------------------------------------------------
     */
    async claimDueNotifications(userId, nowMs, limit = MAX_NOTIFICATIONS_PER_USER_TICK) {
      const nowIso = toIso(nowMs);
      const stuckBefore = toIso(nowMs - STUCK_SENDING_MS);

      const found = await db
        .prepare(
          `SELECT id, event_id, event_start, lead_minutes, notify_at, title, open_url, url_source,
                  status, attempts, last_error, sent_at, created_at
             FROM notifications
            WHERE user_id = ?
              AND notify_at <= ?
              AND (status = 'pending' OR (status = 'sending' AND updated_at <= ?))
            ORDER BY notify_at
            LIMIT ?`,
        )
        .bind(userId, nowIso, stuckBefore, limit)
        .all();

      const claimed = [];

      for (const row of found?.results ?? []) {
        const result = await db
          .prepare(
            `UPDATE notifications SET status = 'sending', updated_at = ?
              WHERE id = ? AND user_id = ?
                AND (status = 'pending' OR (status = 'sending' AND updated_at <= ?))`,
          )
          .bind(nowIso, row.id, userId, stuckBefore)
          .run();

        if (Number(result?.meta?.changes ?? 0) > 0) {
          claimed.push({ ...toNotification(row), status: 'sending' });
        }
      }

      return claimed;
    },

    async markNotificationSent(id, nowIso) {
      await db
        .prepare(
          `UPDATE notifications
              SET status = 'sent', sent_at = ?, attempts = attempts + 1, last_error = NULL, updated_at = ?
            WHERE id = ?`,
        )
        .bind(nowIso, nowIso, id)
        .run();
    },

    /** 送り直す（pending へ戻す）。 */
    async markNotificationRetry(id, { attempts, lastError }, nowIso) {
      await db
        .prepare(
          `UPDATE notifications SET status = 'pending', attempts = ?, last_error = ?, updated_at = ?
            WHERE id = ?`,
        )
        .bind(attempts, String(lastError).slice(0, 200), nowIso, id)
        .run();
    },

    async markNotificationFailed(id, { attempts, lastError }, nowIso) {
      await db
        .prepare(
          `UPDATE notifications SET status = 'failed', attempts = ?, last_error = ?, updated_at = ?
            WHERE id = ?`,
        )
        .bind(attempts, String(lastError).slice(0, 200), nowIso, id)
        .run();
    },

    async listNotifications(userId, limit) {
      const result = await db
        .prepare(
          `SELECT id, event_id, event_start, lead_minutes, notify_at, title, open_url, url_source,
                  status, attempts, last_error, sent_at, created_at
             FROM notifications
            WHERE user_id = ?
            ORDER BY created_at DESC, id DESC
            LIMIT ?`,
        )
        .bind(userId, limit)
        .all();

      return (result?.results ?? []).map(toNotification);
    },

    /**
     * 画面に出す予定の「通知の状態」を引く。
     *
     * event_id で粗く引いてから JS 側で完全一致を取る。SQL に
     * (event_id, event_start, lead_minutes) の組を並べると
     * プレースホルダが 3 倍になり、D1 の上限（100）に近づくため。
     */
    async findNotificationStatuses(userId, keys) {
      const eventIds = Array.from(new Set((keys ?? []).map((key) => key.eventId)));

      if (eventIds.length === 0) {
        return {};
      }

      const placeholders = eventIds.map(() => '?').join(',');

      const result = await db
        .prepare(
          `SELECT event_id, event_start, lead_minutes, status FROM notifications
            WHERE user_id = ? AND event_id IN (${placeholders})`,
        )
        .bind(userId, ...eventIds)
        .all();

      const wanted = new Set(
        (keys ?? []).map((key) => notificationKey(key.eventId, key.eventStart, key.leadMinutes)),
      );

      const out = {};

      for (const row of result?.results ?? []) {
        const key = notificationKey(row.event_id, row.event_start, row.lead_minutes);

        if (wanted.has(key)) {
          out[key] = row.status;
        }
      }

      return out;
    },

    /* ---------------- 予定ごとの上書き（仕様書 §6・§7・§9） ---------------- */

    /**
     * 複数予定の上書きをまとめて引く。
     *
     * findNotificationStatuses と同じ流儀で、event_id を IN 句の
     * プレースホルダで渡す（3 倍にならないので D1 の上限に余裕がある）。
     * 戻り値は Map<eventId, { title, url }>。eventIds が空なら空 Map。
     */
    async listOverrides(userId, eventIds) {
      const ids = Array.from(
        new Set((eventIds ?? []).filter((id) => typeof id === 'string' && id !== '')),
      );

      const map = new Map();

      if (ids.length === 0) {
        return map;
      }

      const placeholders = ids.map(() => '?').join(',');

      const result = await db
        .prepare(
          `SELECT event_id, custom_title, custom_url FROM event_overrides
            WHERE user_id = ? AND event_id IN (${placeholders})`,
        )
        .bind(userId, ...ids)
        .all();

      for (const row of result?.results ?? []) {
        map.set(row.event_id, { title: row.custom_title ?? '', url: row.custom_url ?? '' });
      }

      return map;
    },

    async getOverride(userId, eventId) {
      const row = await db
        .prepare('SELECT custom_title, custom_url FROM event_overrides WHERE user_id = ? AND event_id = ?')
        .bind(userId, eventId)
        .first();

      return row ? { title: row.custom_title ?? '', url: row.custom_url ?? '' } : null;
    },

    /**
     * 上書きを保存する（無ければ作り、あれば更新する）。
     *
     * ------------------------------------------------------------------
     * 両方空なら解除（行を消す）
     * ------------------------------------------------------------------
     * custom_title と custom_url が両方空文字なら、その予定は
     * 「上書きなし」に戻る。空文字の行を残しても意味は同じだが、
     * 「行が無い＝自動抽出」と一意に読めるほうが後から追いやすい。
     *
     * ------------------------------------------------------------------
     * まだ送っていない通知（pending）へ即時反映する
     * ------------------------------------------------------------------
     * 通知の行は due になった tick で初めて作られる（仕様書 §8-4）。
     * だが「10 分前」の通知が **すでに pending として作られた後**に
     * 利用者が文章や URL を直す場合がある。その pending 行を放置すると、
     * 画面では新しい設定なのに届く通知だけ古い、という食い違いが出る。
     * そこで、custom_title があれば title を、custom_url があれば
     * open_url と url_source='custom' を、pending の行へ即座に反映する。
     *
     * **解除（両方空）のときは pending 行を触らない。** 自動抽出値へ戻すには
     * 予定本体（conference/description 等）が要り、ここには無い。次に
     * due になる分から planNotifications が自動抽出で作り直す（tick が
     * listOverrides で空を得るため）。すでに作られた pending 行は
     * 上書きが載ったまま残るが、害は「解除前の上書きで 1 回届く」程度で、
     * 送信済みでもないので実運用上は次の予定から正しく戻る。
     * ------------------------------------------------------------------
     */
    async upsertOverride(userId, eventId, { title, url }, nowIso) {
      const cleanTitle = String(title ?? '');
      const cleanUrl = String(url ?? '');

      if (cleanTitle === '' && cleanUrl === '') {
        await db
          .prepare('DELETE FROM event_overrides WHERE user_id = ? AND event_id = ?')
          .bind(userId, eventId)
          .run();

        return { title: '', url: '' };
      }

      await db
        .prepare(
          `INSERT INTO event_overrides (user_id, event_id, custom_title, custom_url, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(user_id, event_id) DO UPDATE SET
             custom_title = excluded.custom_title,
             custom_url = excluded.custom_url,
             updated_at = excluded.updated_at`,
        )
        .bind(userId, eventId, cleanTitle, cleanUrl, nowIso)
        .run();

      if (cleanTitle !== '') {
        await db
          .prepare(
            `UPDATE notifications SET title = ?, updated_at = ?
              WHERE user_id = ? AND event_id = ? AND status = 'pending'`,
          )
          .bind(cleanTitle, nowIso, userId, eventId)
          .run();
      }

      if (cleanUrl !== '') {
        await db
          .prepare(
            `UPDATE notifications SET open_url = ?, url_source = 'custom', updated_at = ?
              WHERE user_id = ? AND event_id = ? AND status = 'pending'`,
          )
          .bind(cleanUrl, nowIso, userId, eventId)
          .run();
      }

      return { title: cleanTitle, url: cleanUrl };
    },
  };
}

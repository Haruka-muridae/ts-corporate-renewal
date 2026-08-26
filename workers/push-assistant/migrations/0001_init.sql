-- Push Assistant の初期スキーマ（仕様書 §6）。
--
-- 適用:
--   wrangler d1 migrations apply push_assistant --local  --config workers/push-assistant/wrangler.jsonc
--   wrangler d1 migrations apply push_assistant --remote --config workers/push-assistant/wrangler.jsonc
--
-- ------------------------------------------------------------------
-- 時刻はすべて ISO 8601（UTC、ミリ秒つき）の TEXT
-- ------------------------------------------------------------------
-- SQLite に日付型は無い。`new Date(ms).toISOString()` は桁数が固定
-- （YYYY-MM-DDTHH:mm:ss.sssZ）なので、**文字列の大小比較がそのまま
-- 時刻の前後になる。** notify_at <= ? の絞り込みはこれに依存している。
-- 別の書式を混ぜると、比較が静かに壊れる（エラーにならない）。
-- ------------------------------------------------------------------

CREATE TABLE users (
  id TEXT PRIMARY KEY,                       -- Google の sub（id_token のクレーム）
  email TEXT,
  notify_enabled INTEGER NOT NULL DEFAULT 1,
  -- JSON 配列（分前）。将来 [5,10,30] のような複数通知へ拡張する受け皿。
  lead_minutes TEXT NOT NULL DEFAULT '[10]',
  -- 最後に tick で処理した時刻。**順番待ちの公平さのためだけにある。**
  -- listActiveUsers はこの古い順に並べるので、利用者が
  -- MAX_USERS_PER_TICK を超えても、次の分には後ろの人へ順番が回る。
  -- NULL は「一度も処理していない」＝最優先。
  last_tick_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE google_tokens (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  -- AES-256-GCM で暗号化した値（鍵は Workers Secret の TOKEN_ENCRYPTION_KEY）。
  -- **平文で入れない。** D1 の中身はダッシュボードから読める（仕様書 §10）。
  refresh_token_enc TEXT NOT NULL,
  access_token_enc TEXT,
  access_token_expires_at TEXT,
  scope TEXT,
  -- invalid_grant 等で使えなくなった時刻。NULL でない行は tick の対象外
  -- （再接続してもらうしかない）。
  invalid_at TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE push_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- endpoint が端末の一意キー。別の利用者が同じ endpoint を登録したら
  -- 所有者を移す（端末の使い回し。仕様書 §7）。
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_agent TEXT,
  created_at TEXT NOT NULL,
  last_success_at TEXT,
  failure_count INTEGER NOT NULL DEFAULT 0,
  -- 404/410 を受けた購読。送信対象から外すが、行は履歴として残す。
  disabled_at TEXT
);

CREATE INDEX idx_push_subscriptions_user ON push_subscriptions(user_id);

CREATE TABLE notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL,
  event_start TEXT NOT NULL,
  lead_minutes INTEGER NOT NULL,             -- 0 = 開始時刻、10 = 10分前
  notify_at TEXT NOT NULL,
  title TEXT NOT NULL,
  open_url TEXT NOT NULL,
  url_source TEXT NOT NULL,                  -- conference | description | location | calendar | app
  status TEXT NOT NULL,                      -- pending | sending | sent | failed | skipped
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  sent_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- ------------------------------------------------------------------
  -- 二重通知防止キー（仕様書 §8-4）
  -- ------------------------------------------------------------------
  -- INSERT OR IGNORE と対で使う。「先に SELECT して無ければ INSERT」では
  -- Cron が重なったときに 2 行入り、2 回通知される。**制約側で止める。**
  --
  -- event_start をキーに含めているので、予定がリスケされれば別キーになり、
  -- 新しい時刻で改めて通知される。
  -- ------------------------------------------------------------------
  UNIQUE (user_id, event_id, event_start, lead_minutes)
);

CREATE INDEX idx_notifications_due ON notifications(status, notify_at);
CREATE INDEX idx_notifications_user ON notifications(user_id, created_at DESC);

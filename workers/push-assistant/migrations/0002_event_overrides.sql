-- Push Assistant: 予定ごとの通知上書き（仕様書 §6・§7・§9）。
--
-- 適用:
--   wrangler d1 migrations apply push_assistant --local  --config workers/push-assistant/wrangler.jsonc
--   wrangler d1 migrations apply push_assistant --remote --config workers/push-assistant/wrangler.jsonc
--
-- 0001 は本番適用済みなので編集しない。この 0002 を追加で当てる。
--
-- ------------------------------------------------------------------
-- 何を持つか
-- ------------------------------------------------------------------
-- 利用者が「次回の予定」一覧で、予定ごとに
--   custom_title … 通知に表示する文章（空 = 予定タイトルを使う）
--   custom_url   … タップで開く URL（空 = 自動抽出を使う。http/https のみ保存）
-- を手で上書きしたもの。空文字は「上書きしない」を意味し、両方空なら行ごと消す
-- （store.upsertOverride）。行が無い予定は従来どおり自動抽出で通知する。
--
-- ------------------------------------------------------------------
-- ON DELETE CASCADE は当てにしない
-- ------------------------------------------------------------------
-- 0001 の他テーブルと同じ方針。D1（SQLite）は既定で外部キー制約を
-- 強制しないことがあるため、接続解除では store.deleteUserData が
-- この表も明示的に DELETE する。ここでは参照制約を張らない。
-- ------------------------------------------------------------------

CREATE TABLE event_overrides (
  user_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  custom_title TEXT NOT NULL DEFAULT '',   -- 空 = 予定タイトルを使う
  custom_url TEXT NOT NULL DEFAULT '',      -- 空 = 自動抽出を使う（http/https のみ保存）
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, event_id)
);

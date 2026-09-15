-- Push Assistant: 利用者ごとの通知テンプレート（仕様書 §6・§7・§8）。
--
-- 適用:
--   wrangler d1 migrations apply push_assistant --local  --config workers/push-assistant/wrangler.jsonc
--   wrangler d1 migrations apply push_assistant --remote --config workers/push-assistant/wrangler.jsonc
--
-- 0001 / 0002 は本番適用済みなので編集しない。この 0003 を追加で当てる。
--
-- ------------------------------------------------------------------
-- 何を持つか
-- ------------------------------------------------------------------
-- 利用者が 1 つだけ持つ「通知テンプレート」。**予定ごとではなくグローバル**で、
-- 全予定の通知に一律適用する（利用者の要望: 問いかけは共通・URL を表示）。
--   notify_title … 全予定共通の通知タイトル（＝問いかけ文）。空 = 従来どおり
--                  予定タイトル（または event_overrides の custom_title）を使う。
--   notify_body  … 本文テンプレート。`{url}` `{title}` `{time}` を置換する。
--                  空 = 従来の既定文（「HH:MM 開始（あと N 分）」）。
--
-- event_overrides（予定ごとの上書き）はこのテンプレートより優先する。
-- 個別に変えたい予定だけ上書きし、それ以外はテンプレートが当たる（§8-7）。
--
-- NOT NULL DEFAULT '' なので、既存行にも安全に列が足せる（空 = 未設定）。

ALTER TABLE users ADD COLUMN notify_title TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN notify_body TEXT NOT NULL DEFAULT '';

-- PostgREST 経由でアクセスするロールへの権限付与。
--
-- なぜ必要か
--   RLS を有効にしても、その前段にテーブルへの権限（GRANT）の判定がある。
--   マイグレーションで作成した表には既定の権限が付かず、service_role からも
--   「permission denied for table」になるため、明示的に与える。
--
-- 与える相手
--   service_role のみ。サーバー側の処理だけがこれらの表を読み書きする。
--   anon と authenticated には**与えない**。RLS のポリシーが無いことに加えて
--   権限自体も無いため、anon キーが漏れてもこれらの表には触れられない。
--   （管理画面も、Supabase Auth でログインさせたうえでサーバー側を経由して読む）

grant usage on schema public to service_role;

grant select, insert, update, delete
  on public.events, public.applications, public.payments,
     public.webhook_events, public.email_logs
  to service_role;

-- 以降このマイグレーション以外で表を足したときも、同じ権限が付くようにする。
alter default privileges in schema public
  grant select, insert, update, delete on tables to service_role;

-- anon / authenticated に既定の権限が付いている場合に備えて明示的に剥がす。
-- 付いていなければ何も起きない。
revoke all on public.events         from anon, authenticated;
revoke all on public.applications   from anon, authenticated;
revoke all on public.payments       from anon, authenticated;
revoke all on public.webhook_events from anon, authenticated;
revoke all on public.email_logs     from anon, authenticated;

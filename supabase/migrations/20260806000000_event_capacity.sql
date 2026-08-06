-- 定員を設定し、申込フローを自動で止められるようにする。
--
-- なぜ列を使うか
--   capacity 列は初期スキーマ（20260731000000_event_app_init.sql）に定義済みで、
--   これまで null（定員なし）のまま運用してきた。定員はイベントごとに変わる値で、
--   環境変数や設定ファイルに置くと複数開催で共有できず、変更のたびに
--   デプロイが要る。イベント行に持たせる。
--
-- 判定
--   「支払済み（applications.status = 'paid'）の件数 >= events.capacity」で満席。
--   決済待ち（awaiting）は数えない。返金されると status が 'refunded' に変わり、
--   件数から外れて席が空く。
--   capacity が null のイベントは定員なしとして扱い、従来どおり止めない。
--
-- 対象
--   初回イベント（20260731000100_seed_first_event.sql で登録した行）。
--   2回目以降のイベントは、登録するマイグレーションで capacity を入れること。

update public.events
   set capacity = 30
 where name = 'TSAMビジネス&フレンド交流会'
   and event_date = timestamptz '2026-08-30 14:30:00+09';

-- Googleカレンダーを開催日の真実源にするための列と、同期状態テーブル。
--
-- なぜ必要か
--   開催日はこれまで「マイグレーションで1行ずつ登録する」運用だった（仕様書10章）。
--   主催者が会場（渋谷CAFE）を予約するたびにマイグレーションを足すのは現実的でなく、
--   カレンダーと events の内容もすぐ食い違う。主催者のカレンダーにある予約を
--   そのまま開催日として取り込み、予定を消せば受付も止まる形にする。
--
--   そのために必要なのは次の2つ。
--     * events 側に「どのカレンダー予定から来た行か」を持たせること（再同期の突き合わせ）
--     * 同期をいつ・どの結果で行ったかを1か所に持つこと（TTL制御と障害の検知）
--
-- 既存の行との共存
--   既存の初回イベント（20260731000100 で登録した行）は google_calendar_event_id が
--   null のまま残る。同期処理は「未リンクかつ開催日時が一致する行」を見つけたら
--   その行にIDを付けて引き取るため、重複した行を作らずに移行できる。

-- ------------------------------------------------------------------
-- events への追加列
-- ------------------------------------------------------------------
alter table public.events
  -- カレンダー予定のID。手動で登録した行は null（＝同期の対象外）。
  add column if not exists google_calendar_event_id text,
  -- この行をカレンダーと最後に突き合わせた時刻。障害時の鮮度の目安。
  add column if not exists synced_at timestamptz,
  -- 自動では解決できない事象の記録（支払済みがある回の日時変更・削除）。
  -- 参加者への連絡は手動で行うため、管理画面に出す文言をそのまま入れる。
  add column if not exists sync_warning text,
  add column if not exists sync_warning_at timestamptz;

-- 同じカレンダー予定から2行作らないための一意制約。
--
-- 制約ではなく一意索引にしているのは、`add constraint` に if not exists が無く、
-- 既存様式（20260731000400）のように drop してから add し直す必要があるため。
-- 索引なら再実行しても安全に書ける。
--
-- null は互いに重複扱いにならない（Postgres の既定）ため、
-- 手動登録の行（null）は何行あっても構わない。
create unique index if not exists events_google_calendar_event_id_key
  on public.events (google_calendar_event_id);

-- ------------------------------------------------------------------
-- calendar_sync_state
-- ------------------------------------------------------------------
-- 同期の実行間隔（TTL）と最後の結果を持つ1行だけの表。
--
-- なぜ表に持つか
--   同期の契機は「読まれたときに、前回から一定時間たっていれば実行する」方式で、
--   cron もキューも使わない（この構成に前例がないため）。複数のリクエストが
--   同時に来ても1本だけ実行させたいので、last_synced_at への条件付き更新
--   （last_synced_at < now - TTL の行だけを更新し、更新できたリクエストだけが実行する）を
--   ロック代わりにする。プロセス内の変数では、Workers のように実行環境が
--   複数に分かれる構成で効かない。
--
--   Google 側の障害が続いても、TTL の分だけ自然に間隔が空く（バックオフを兼ねる）。
create table if not exists public.calendar_sync_state (
  key            text        primary key,
  -- 既定を epoch にしておくと、初回は必ず「TTL を過ぎている」と判定される。
  last_synced_at timestamptz not null default timestamptz 'epoch',
  -- 直近の結果（成功件数、または失敗の理由）。管理画面に出して障害に気づく手掛かりにする。
  last_status    text        not null default ''
);

-- 同期処理は行を作らず更新だけを行う（更新できた＝ロックを取れた、と判定するため）。
-- 対象の行がここに無いと同期が永久に走らないので、初期行をここで入れる。
insert into public.calendar_sync_state (key)
values ('calendar')
on conflict (key) do nothing;

-- ------------------------------------------------------------------
-- 権限とRLS
-- ------------------------------------------------------------------
-- 20260731000200 の alter default privileges により、この表にも service_role の
-- 権限は自動で付く。それでも明示するのは、既定権限の設定が失われた環境へ
-- 適用したときに「permission denied for table」で原因が分かりにくくなるため。
grant select, insert, update, delete on public.calendar_sync_state to service_role;

-- anon / authenticated には与えない（他の表と同じ扱い）。
revoke all on public.calendar_sync_state from anon, authenticated;

-- ポリシーは作らない。service role キーを使うサーバー側からのみ読み書きする。
alter table public.calendar_sync_state enable row level security;

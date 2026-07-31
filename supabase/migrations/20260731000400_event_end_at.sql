-- 開催の終了時刻を持たせる。
--
-- 仕様書1章の開催日時は「14:30〜16:00」だが、events には開始時刻しか
-- 列が無かった。そのため参加確定メールに終了時刻を出せていない。
-- 詳細ページ（静的HTML）にだけ終了時刻がある状態は、記載の食い違いを生む。
--
-- 既存の行があるうちに追加するため、まず null 許容で足し、値を入れてから
-- 制約を付ける。

alter table public.events
  add column if not exists event_end_at timestamptz;

-- 初回イベントの終了時刻（2026年8月30日 16:00 JST）。
update public.events
   set event_end_at = timestamptz '2026-08-30 16:00:00+09'
 where event_end_at is null
   and event_date = timestamptz '2026-08-30 14:30:00+09';

-- 終了は開始より後であること。
alter table public.events
  drop constraint if exists events_end_after_start;

alter table public.events
  add constraint events_end_after_start
  check (event_end_at is null or event_end_at > event_date);

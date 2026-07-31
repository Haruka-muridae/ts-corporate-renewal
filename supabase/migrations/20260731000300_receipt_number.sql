-- 受付番号の発行（実装仕様書 5.3）。
--
-- なぜ関数にするか
--   受付番号は「そのイベントの中で連番」かつ「一意」。アプリ側で
--   「今の最大値 + 1」を求めてから書き込むと、Webhook が同時に複数届いたときに
--   同じ番号を2件に振ってしまう。採番と書き込みを1つのトランザクションに閉じ、
--   イベント行のロックで直列化する。
--
-- 冪等性
--   すでに発行済みの申込に対しては、新しい番号を振らずに既存の番号を返す。
--   同じ Webhook を2回受けても番号が変わらない（受入条件5）。

create or replace function public.assign_receipt_number(p_application_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event_id  uuid;
  v_existing  text;
  v_next      integer;
  v_number    text;
begin
  select event_id, receipt_number
    into v_event_id, v_existing
    from public.applications
   where id = p_application_id;

  if v_event_id is null then
    raise exception '申込が見つかりません: %', p_application_id;
  end if;

  -- すでに振ってあれば、それをそのまま返す。
  if v_existing is not null then
    return v_existing;
  end if;

  -- 同じイベントの採番を直列化する。
  -- ここで待たせることで「最大値の取得」と「書き込み」の間に割り込まれない。
  perform 1 from public.events where id = v_event_id for update;

  select coalesce(max(substring(receipt_number from '[0-9]+$')::integer), 0) + 1
    into v_next
    from public.applications
   where event_id = v_event_id
     and receipt_number is not null;

  v_number := 'TSAM-' || lpad(v_next::text, 4, '0');

  update public.applications
     set receipt_number = v_number
   where id = p_application_id;

  return v_number;
end;
$$;

-- サーバー側（service_role）からのみ呼ぶ。
revoke all on function public.assign_receipt_number(uuid) from public, anon, authenticated;
grant execute on function public.assign_receipt_number(uuid) to service_role;

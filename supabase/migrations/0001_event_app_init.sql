-- 交流会申込・Stripe決済アプリの初期スキーマ（実装仕様書 8章）
--
-- 適用方法は docs/event-app-database.md を参照。
--
-- 方針
--   * 割引ルールはアプリのコード内定数（lib/event/pricing.mjs）で持つ。
--     このスキーマにはルールを置かない。フェーズ2で管理画面化する際に移行する。
--   * 割引の内訳は payments に列として保存する。申込時点のスナップショットとし、
--     あとからルール定数を変えても過去の記録は変わらないようにする。
--   * 金額はすべて円単位の整数で持つ。JPY は最小通貨単位が円のため、
--     Stripe の unit_amount にそのまま渡せる。
--   * 一般公開ルートからは anon キーでこれらの表に触らせない。
--     書き込みはすべてサーバー側（service role）で行う。末尾のRLSを参照。

-- ------------------------------------------------------------------
-- events
-- ------------------------------------------------------------------
create table if not exists public.events (
  id                 uuid primary key default gen_random_uuid(),
  name               text        not null,
  description        text,
  event_date         timestamptz not null,
  venue              text        not null,
  -- 定員は設けない運用のため null を許す。
  -- 受付の締めは主催者が status で手動操作する（仕様書1章）。
  capacity           integer,
  base_price         integer     not null default 11000,
  min_price          integer     not null default 3300,
  apply_start_at     timestamptz not null,
  apply_end_at       timestamptz not null,
  is_published       boolean     not null default false,
  cancel_policy_text text        not null default '',
  policy_version     text        not null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  constraint events_price_range check (min_price > 0 and min_price <= base_price),
  constraint events_apply_period check (apply_end_at > apply_start_at)
);

-- ------------------------------------------------------------------
-- applications
-- ------------------------------------------------------------------
create type public.application_status as enum (
  'received',      -- 申込受付済み
  'awaiting',      -- 決済待ち
  'paid',          -- 支払済み
  'failed',        -- 決済失敗
  'expired',       -- 決済期限切れ
  'refunded'       -- 返金済み（例外対応）
);

create type public.age_group as enum ('18-23', '24+');

create table if not exists public.applications (
  id                   uuid primary key default gen_random_uuid(),
  event_id             uuid not null references public.events(id) on delete restrict,

  -- 受付番号は支払済みになった時点で発行する。それまでは null。
  -- 同じイベント内で重複しないことを一意制約で担保する。
  receipt_number       text,

  name                 text not null,
  name_kana            text not null,
  email                text not null,
  phone                text not null,
  company              text not null,
  department           text,
  job_title            text,

  -- 割引判定に使う属性。選択肢の妥当性はアプリ側で検証する
  -- （割引テーブルと選択肢を1か所で持つため、ここでは列挙型にしない）。
  industry             text not null,
  industry_other_text  text,
  occupation           text not null,
  occupation_other_text text,
  position             text not null,
  age_group            public.age_group not null,

  -- 出禁の自己申告。true なら 55,000円固定（割引は無効）。
  is_banned_declared   boolean not null default false,

  status               public.application_status not null default 'received',

  -- 同意した日時と、そのとき提示していたポリシーの版。
  agreed_at            timestamptz not null,
  policy_version       text        not null,

  -- 譲渡対応。参加者はメールで申し出て、管理者が管理画面で書き換える。
  is_transferred       boolean not null default false,
  transferred_at       timestamptz,
  original_name        text,
  original_email       text,
  admin_memo           text,

  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  constraint applications_receipt_unique unique (event_id, receipt_number),

  -- 「その他」を選んだときだけ自由記述を持つ。取り違えを防ぐ。
  constraint applications_industry_other check (
    (industry = 'other') = (industry_other_text is not null and industry_other_text <> '')
  ),
  constraint applications_occupation_other check (
    (occupation = 'other') = (occupation_other_text is not null and occupation_other_text <> '')
  ),

  -- 譲渡済みなら、いつ・誰からを必ず残す。
  constraint applications_transfer_record check (
    is_transferred = false
    or (transferred_at is not null and original_name is not null and original_email is not null)
  )
);

create index if not exists applications_event_status_idx
  on public.applications (event_id, status);
create index if not exists applications_email_idx
  on public.applications (email);

-- ------------------------------------------------------------------
-- payments
-- ------------------------------------------------------------------
create type public.payment_status as enum (
  'pending',
  'succeeded',
  'failed',
  'expired',
  'refunded'
);

create table if not exists public.payments (
  id                         uuid primary key default gen_random_uuid(),
  application_id             uuid not null references public.applications(id) on delete restrict,

  -- 申込時点のスナップショット。あとで割引ルールを変えてもここは変わらない。
  base_price                 integer not null,
  discount_industry          integer not null default 0,
  discount_occupation        integer not null default 0,
  discount_position          integer not null default 0,
  discount_age               integer not null default 0,
  discount_total             integer not null default 0,
  final_price                integer not null,
  currency                   text    not null default 'jpy',

  stripe_checkout_session_id text,
  stripe_payment_intent_id   text,
  payment_status             public.payment_status not null default 'pending',
  paid_at                    timestamptz,
  refunded_amount            integer,
  refunded_at                timestamptz,

  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now(),

  -- 金額は円単位の整数。負の額や小数は持たない。
  constraint payments_amounts_non_negative check (
    base_price >= 0
    and discount_industry >= 0 and discount_occupation >= 0
    and discount_position >= 0 and discount_age >= 0
    and discount_total >= 0 and final_price > 0
  ),

  -- 内訳の合計が割引合計と一致すること。
  constraint payments_discount_total check (
    discount_total = discount_industry + discount_occupation
                     + discount_position + discount_age
  ),

  constraint payments_currency check (currency = 'jpy'),

  -- Checkout Session は申込ごとに1つ。二重に作らない。
  constraint payments_session_unique unique (stripe_checkout_session_id)
);

create index if not exists payments_application_idx
  on public.payments (application_id);
create index if not exists payments_status_idx
  on public.payments (payment_status);

-- ------------------------------------------------------------------
-- webhook_events
-- ------------------------------------------------------------------
-- 冪等性の担保。同じ Stripe Event ID を2回受け取っても、
-- 受付番号の再発行やメールの再送をしない。
create table if not exists public.webhook_events (
  id              uuid primary key default gen_random_uuid(),
  stripe_event_id text        not null unique,
  event_type      text        not null,
  received_at     timestamptz not null default now(),
  processed       boolean     not null default false,
  result          text
);

-- ------------------------------------------------------------------
-- email_logs
-- ------------------------------------------------------------------
create table if not exists public.email_logs (
  id             uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.applications(id) on delete restrict,
  mail_type      text not null,
  sent_at        timestamptz not null default now(),
  status         text not null
);

create index if not exists email_logs_application_idx
  on public.email_logs (application_id);

-- ------------------------------------------------------------------
-- updated_at の自動更新
-- ------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger events_set_updated_at
  before update on public.events
  for each row execute function public.set_updated_at();

create trigger applications_set_updated_at
  before update on public.applications
  for each row execute function public.set_updated_at();

create trigger payments_set_updated_at
  before update on public.payments
  for each row execute function public.set_updated_at();

-- ------------------------------------------------------------------
-- RLS
-- ------------------------------------------------------------------
-- 全表でRLSを有効にし、ポリシーは作らない。
-- service role キー（サーバー側のみで使用）はRLSを迂回するため、
-- 申込の作成・更新・参照はすべてサーバー側の処理を通ることになる。
-- anon キーが漏れても、これらの表は読めない。
alter table public.events         enable row level security;
alter table public.applications   enable row level security;
alter table public.payments       enable row level security;
alter table public.webhook_events enable row level security;
alter table public.email_logs     enable row level security;

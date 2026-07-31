# 交流会申込アプリ データベース適用手順

実装仕様書8章のスキーマを Supabase に適用する手順。SQLは `supabase/` に置いてある。

| ファイル | 内容 |
| --- | --- |
| `supabase/migrations/0001_event_app_init.sql` | 表・型・制約・トリガー・RLSの作成 |
| `supabase/seed/0001_first_event.sql` | 初回イベント1件の登録 |

## 1. Supabase側で必要な作業

### 1-1. プロジェクトの用意

既存の認証システム（`gas-auth/`）とは別に、交流会アプリ用のプロジェクトを新規に作るか、
同じプロジェクトのまま `public` スキーマに追加するかを決める。**別プロジェクトを推奨**する。
権限の分離ができ、片方の障害や設定変更がもう片方に及ばないため。

### 1-2. SQLの実行

Supabaseダッシュボードの **SQL Editor** で、次の順に実行する。

1. `supabase/migrations/0001_event_app_init.sql` の全文を貼り付けて実行
2. `supabase/seed/0001_first_event.sql` の全文を貼り付けて実行

`0001_event_app_init.sql` は表の作成に `if not exists` を使っているが、型
（`create type`）とトリガーには付いていない。**同じSQLを2回実行するとエラーになる**。
やり直すときは、先に次を実行してから貼り直すこと。

```sql
drop table if exists public.email_logs, public.webhook_events,
                     public.payments, public.applications, public.events cascade;
drop type  if exists public.payment_status, public.application_status, public.age_group;
drop function if exists public.set_updated_at() cascade;
```

seed（`0001_first_event.sql`）は二重登録を避ける書き方にしてあるため、
何度実行しても行は増えない。

### 1-3. 実行前に決めておく値

`supabase/seed/0001_first_event.sql` の中に、まだ確定していない値が1つある。

* `apply_start_at`（受付開始日時）… 仮に `2026-08-01 00:00:00+09` を入れてある。
  確定したら書き換えるか、登録後に `update` する。

`apply_end_at` は仕様どおり開催当日の開始時刻（2026-08-30 14:30 JST）にしてある。

### 1-4. キーの取得

ダッシュボードの **Project Settings → API** から次を控える。

* Project URL
* `anon` public キー
* `service_role` secret キー

`service_role` キーはRLSを迂回する。**サーバー側でのみ使い、フロントエンドのコード・
リポジトリ・ログに書かない**（受入条件12）。

## 2. Vercelに登録する環境変数

仕様書13章のうち、この段階で必要なのは Supabase の3つ。残りは実装順序3以降で使う。

| 変数名 | 値 | 用途 |
| --- | --- | --- |
| `SUPABASE_URL` | Project URL | サーバー側からの接続 |
| `SUPABASE_ANON_KEY` | anon public キー | 管理画面のログイン（Supabase Auth） |
| `SUPABASE_SERVICE_ROLE_KEY` | service_role secret キー | 申込の作成・更新・参照（RLSを迂回） |

`SUPABASE_SERVICE_ROLE_KEY` には `NEXT_PUBLIC_` を付けない。付けるとブラウザに
配信されるバンドルへ埋め込まれる。

## 3. 設計上の要点

### 割引ルールはDBに持たない

割引額はアプリのコード内定数（`lib/event/pricing.mjs`）にある。DBには
汎用のルールエンジンを作らない（仕様書8章）。フェーズ2で管理画面化するときに移行する。

### 割引内訳は payments に列で保存する

`discount_industry` / `discount_occupation` / `discount_position` / `discount_age` /
`discount_total` / `final_price` を申込ごとに保存する。申込時点のスナップショットであり、
あとから割引ルールの定数を変えても過去の記録は変わらない。

`payments_discount_total` 制約で「内訳の合計＝割引合計」を DB 側でも担保している。

### 金額は円単位の整数

JPY は最小通貨単位が円のため、`final_price` をそのまま Stripe の `unit_amount` に渡せる
（仕様書5.1）。小数は持たない。

### RLSは有効、ポリシーは作らない

全表で RLS を有効にし、ポリシーを1つも作っていない。`service_role` キーは RLS を迂回する
ため、読み書きは必ずサーバー側の処理を通る。`anon` キーが漏れてもこれらの表は読めない。

管理画面（実装順序7）でログイン中の管理者に直接読ませたくなった場合は、そのときに
管理者限定のポリシーを追加する。現時点では、管理画面もサーバー側を経由して読む前提。

### 受付番号

`applications.receipt_number` は支払済みになった時点で発行する。それまでは `null`。
`unique (event_id, receipt_number)` により、同じイベント内での重複を DB 側で防ぐ。
Webhook を二重に受け取っても再発行されないことは、`webhook_events.stripe_event_id` の
一意制約と合わせて担保する（受入条件5）。

## 4. 注意点

### 開催日時が2か所になる

詳細ページ（`public/event/index.html`）は静的HTMLのままにする方針のため、開催日時は
「静的HTMLの1か所」と「`events.event_date`」の2か所に持つことになる。次回開催時は
**両方**を更新すること。

将来、詳細ページを Next のページに移す判断をすれば、DB の1か所に集約できる。

### capacity 列は使わない

定員を設けない運用のため `capacity` は `null` のままにする。列自体は仕様書8章の
定義に合わせて残してある。受付の締めは主催者が手動で行う。

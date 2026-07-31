# 交流会申込アプリ データベース

実装仕様書8章のスキーマ。SQLは `supabase/migrations/` に置いてある。

**適用済み**。プロジェクト `tsam-event`（東京リージョン / ref `ixxxlmfhrtommsfiumlz`）に
Supabase CLI で適用してある。以降のスキーマ変更もマイグレーションで管理する。

| ファイル | 内容 |
| --- | --- |
| `supabase/migrations/20260731000000_event_app_init.sql` | 表・型・制約・トリガー・RLSの作成 |
| `supabase/migrations/20260731000100_seed_first_event.sql` | 初回イベント1件の登録 |
| `supabase/migrations/20260731000200_grant_service_role.sql` | service_role への権限付与 |

## 1. Supabase側の状態

### 1-1. プロジェクト

既存の認証システム（`gas-auth/`）とは別プロジェクトにしてある。権限を分離でき、
片方の障害や設定変更がもう片方に及ばないため。

* 名称: `tsam-event`
* リージョン: ap-northeast-1（東京）
* ref: `ixxxlmfhrtommsfiumlz`

### 1-2. マイグレーションの適用

Supabase CLI で適用する。ダッシュボードのSQL Editorに貼り付ける運用はしない
（適用履歴が残らず、環境間で食い違うため）。

```bash
export SUPABASE_ACCESS_TOKEN=<個人アクセストークン>
export SUPABASE_DB_PASSWORD=<データベースのパスワード>

supabase link --project-ref ixxxlmfhrtommsfiumlz
supabase db push          # 未適用のマイグレーションだけが流れる
supabase migration list   # ローカルとリモートの適用状況を突き合わせる
```

適用済みのマイグレーションは再実行されない。**すでに適用したファイルは編集しない**こと。
変更が必要なときは新しいマイグレーションを追加する。

`supabase db diff` はシャドウDBの作成にDockerが必要なため、この環境では使えない。
適用状況の確認は `supabase migration list` で行う。

### 1-3. まだ確定していない値

`20260731000100_seed_first_event.sql` の `apply_start_at`（受付開始日時）に
仮の値 `2026-08-01 00:00:00+09` を入れてある。確定したら、このファイルを編集せず、
`update` を行う新しいマイグレーションを追加する。

`apply_end_at` は仕様どおり開催当日の開始時刻（2026-08-30 14:30 JST）。

### 1-4. 権限の設計

マイグレーションで作成した表には既定の権限が付かない。RLS の判定より前に
テーブル権限の判定があるため、`service_role` からも
「permission denied for table」になる。`20260731000200_grant_service_role.sql` で
`service_role` にのみ権限を与えている。

`anon` と `authenticated` には与えず、既定で付いていた分は剥がしている。
RLS（ポリシーなし）と権限の両方で塞いでいるため、anonキーが漏れてもこれらの表には
触れられない。anon キーでの読み取りが 401 になることを確認済み。

## 2. 環境変数

ローカルは `.env.local`、本番は Vercel の環境変数。どちらも登録済み。

| 変数名 | 用途 |
| --- | --- |
| `SUPABASE_URL` | Project URL |
| `SUPABASE_ANON_KEY` | 管理画面のログイン（Supabase Auth） |
| `SUPABASE_SERVICE_ROLE_KEY` | 申込の作成・更新・参照（RLSと権限を通過できる唯一のロール） |

`SUPABASE_SERVICE_ROLE_KEY` には `NEXT_PUBLIC_` を付けない。付けるとブラウザに
配信されるバンドルへ埋め込まれる（受入条件12）。

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

全表で RLS を有効にし、ポリシーを1つも作っていない。`service_role` は RLS を迂回するため、
読み書きは必ずサーバー側の処理を通る。

管理画面（実装順序7）でログイン中の管理者に直接読ませたくなった場合は、そのときに
管理者限定のポリシーと権限を追加する。現時点では、管理画面もサーバー側を経由して読む前提。

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

### is_published は false のまま

初回イベントは `is_published = false` で登録してある。申込フォーム（実装順序3）が
できて受付を開始する段階で `true` にする。

# 交流会申込アプリ データベース

実装仕様書8章のスキーマ。SQLは `supabase/migrations/` に置いてある。

**全件適用済み**（2026-08-06 に `supabase migration list` で確認）。
プロジェクト `tsam-event`（東京リージョン / ref `ixxxlmfhrtommsfiumlz`）に Supabase CLI で
適用してある。以降のスキーマ変更もマイグレーションで管理する。

| ファイル | 内容 | 適用状況 |
| --- | --- | --- |
| `20260731000000_event_app_init.sql` | 表・型・制約・トリガー・RLSの作成 | 適用済み |
| `20260731000100_seed_first_event.sql` | 初回イベント1件の登録 | 適用済み |
| `20260731000200_grant_service_role.sql` | service_role への権限付与 | 適用済み |
| `20260731000300_receipt_number.sql` | 受付番号を採番するDB関数 | 適用済み |
| `20260731000400_event_end_at.sql` | 開催の終了時刻の列を追加 | 適用済み |
| `20260806000000_event_capacity.sql` | 初回イベントの定員を30に設定 | 適用済み |

適用状況はリポジトリからは分からない。追加したときは、このファイルに行を足し、
`supabase migration list` で突き合わせた結果を書くこと。

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

**使い分け**: 表・関数・既定値など「環境を作り直したら必要になるもの」はマイグレーション
（CLI）で入れ、`is_published` の切り替えのように「その回かぎりの運用操作」だけを
ダッシュボードで行う。定員（`capacity`）は前者に含めている。

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

### capacity 列で定員を持つ

`capacity` に人数を入れると、その人数に達した時点で申込フローが自動で止まる。
初回イベントは `20260806000000_event_capacity.sql` で **30** を設定した。

`null` にしておくと定員なしとして扱い、止めない。定員を設けない回はこれまでどおり
`null` のままでよい。

**`0` や負数、小数を入れても定員なしに倒れる**（`lib/event/capacity.mjs` の `isSoldOut`）。
満席扱いにすると受付が丸ごと止まり、しかも原因が分かりにくいためそう決めてある。
つまり **`capacity = 0` で受付を閉じることはできない**。閉じたいときは `apply_end_at`
（受付期間）を過ぎた時刻に更新すること。設定ミスは管理画面で気づける
（定員なしのときは「支払済み N 件」とだけ出て、「/ 30 名」が出ない）。

判定は「支払済み（`applications.status = 'paid'`）の件数 >= `capacity`」。
決済待ち（`awaiting`）は席として数えない。詳しくは下の「定員に達したときの運用」を参照。

2回目以降のイベントを登録するマイグレーションでは、`capacity` を明示すること。

### is_published は false のまま

初回イベントは `is_published = false` で登録してある。申込フォーム（実装順序3）が
できて受付を開始する段階で `true` にする。

---

## 5. 定員に達したときの運用

### 何が自動で起きるか

支払済みが `capacity` に達すると、次の3か所が同時に受け付けなくなる。デプロイも
設定変更も要らない。

| 場所 | 挙動 |
|---|---|
| `/event/apply/`（表示） | フォームを出さず「満席になりました」の案内に変わる |
| 申込フォームの送信 | 保存せず「定員に達したため…」を返す |
| 「決済へ進む」 | Checkout Session を作らず申込ページへ戻す |

3段にしてあるのは、表示だけでは防げない経路があるため。満席になる前に開いたままの
タブ、確認画面のURLを直接開く、サーバーアクションへの再送のいずれも、最後の
「決済へ進む」で止まる。

### 手で行うこと

**静的ページ（`/event/`）の切り替えは自動では起きない。** `public/event/index.html`
の `data-event-status` を `"full"` に書き換えてデプロイする。

```html
<p class="event-status" id="event-status" data-event-status="full">
```

切り替えるまでの間、LP は「受付中」のまま、申込ページは満席、という状態になる。
この不整合は許容する運用としている。管理画面が定員到達を検知すると、この手順を
促す案内を出す。

### 定員を超えたとき

非同期決済（PayPay など）は `checkout.session.completed` の時点ではまだ確定して
おらず、`checkout.session.async_payment_succeeded` を待って支払済みになる。この間は
席として数えないため、**定員をわずかに超えることがある**。

超過は管理画面が警告で知らせる。対応は次のとおり。

1. 管理画面の一覧で、超過分にあたる申込を決める（申込日時の新しい順が基本）
2. Stripe ダッシュボードから該当の決済を返金する
3. `charge.refunded` の Webhook が届き、`applications.status` が `refunded` に変わる
4. 支払済みの件数が減り、**席は自動的に空く**。アプリ側の操作は要らない

返金した参加者には、別途メールで連絡すること。アプリからの自動通知はない。

### 定員を変えるとき

`events.capacity` を更新する。マイグレーションを1本追加するのが基本。急ぎのときは
Supabase の SQL エディタから直接更新してもよいが、**次回の環境再構築で失われる**ため、
後からマイグレーションに残すこと。

定員を増やすと、その場で申込フローが再開する。デプロイは要らない。静的ページの
`data-event-status` は手で戻す。

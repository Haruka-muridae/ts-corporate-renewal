# 受入条件の確認記録（実装仕様書12章）

Stripe テストモードで、実際のカード決済を含めて通しで確認した結果。
確認日: 2026-08-01（再確認。BOM混入の修正後）

確認方法は、ローカルで本番ビルドを動かし（`next start`）、`stripe listen` で
Webhook を転送し、実ブラウザ（CDP経由）で申込フォームから Stripe Checkout の
決済完了まで操作する形で行った。

## 結果

| # | 条件 | 結果 | 確認内容 |
| --- | --- | --- | --- |
| 1 | 3.4の全テストケースで計算結果が一致する | ok | 単体テスト62件（全990通りの総当たりを含む）。通し確認では生命保険×営業×一般社員×24歳以上＝7,700円 |
| 2 | 出禁「該当する」で55,000円に固定され、割引が無効になる | ok | 割引が最大になる組み合わせ（IT×エンジニア×経営者×18〜23歳）で申し込んでも55,000円。割引合計0。確認画面に内訳も理由も出さない |
| 3 | ブラウザ側で金額を改ざんしても決済額に反映されない | ok | 隠しフィールド `amount=100` などをDOMに差し込んで送信 → DBもStripeも7,700円 |
| 4 | Stripe Checkoutで決済でき、Webhookで「支払済み」に更新される | ok | テストカード4242…で決済 → status=paid、受付番号 TSAM-0001 発行 |
| 5 | 同一Webhookを2回受信してもメール・受付番号が重複しない | ok | 実イベントを正しい署名で再送 → 応答200、メール1件のまま、受付番号も不変 |
| 6 | 決済完了後に参加確定メールとStripe領収書が届く | **条件付き** | 参加確定メールは Gmail API で送信し、実際の受信も確認済み。Stripe領収書は `receipt_email` が設定され領収書URLも発行されるが、**領収書メールは未送信**。ダッシュボードの設定が必要（下記） |
| 7 | `async_payment_succeeded` 経由でも4〜6が成立する（PayPay想定） | ok | completed(unpaid)では支払済みにせず受付番号も出さない → async_payment_succeeded で支払済み・受付番号 TSAM-0002・メール1通 |
| 8 | 同意チェック3つが未チェックだと決済へ進めない。同意日時・ポリシー版が保存される | ok | 未チェックで送信 → 3件のエラーで遷移せず。同意後は agreed_at とポリシー版1.0を保存 |
| 9 | Stripeから手動返金するとステータスが「返金済み（例外対応）」になる | ok | Refunds APIで返金 → charge.refunded 受信 → status=refunded、返金額7,700を記録 |
| 10 | 管理画面は未ログインでアクセスできない。一覧・詳細・CSV(2種)が機能する | ok | 未ログイン: 画面はログインへ307、CSVは401。ログイン後は一覧・詳細・CSV2種とも200 |
| 11 | 管理画面から申込者情報を書き換えて参加確定メールを再送できる | ok | 譲渡として書き換え（受付番号と支払額は不変）→ 再送成功 |
| 12 | シークレットキーがフロントエンド・リポジトリに露出しない | ok | ビルド後の `.next/static` 全13ファイルを検査し、STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET / SUPABASE_SERVICE_ROLE_KEY / GOOGLE_CLIENT_SECRET / GMAIL_REFRESH_TOKEN のいずれも含まれないことを確認 |

単体テストは全1056件が成功している（`npm run test:auth-system`）。

## 条件6が「条件付き」である理由

Stripe の領収書メールは、ダッシュボードで有効にしないと送信されない。
テストモードで決済した請求 `ch_3TzIvACL3niUmYGZ1bPrNcAF` を確認したところ、
`receipt_email` に `architect@potenitas.com` は設定されているものの
`receipt_number` が付いておらず、**領収書メールは送信されていない**。
Stripe は領収書を送信した時点で `receipt_number` を採番するため、
これが未採番＝未送信の確かな手掛かりになる。

設定を入れれば送信される。**コード側の対応は不要**。

Checkout Session に `customer_email` を渡しているため、設定を入れれば
その宛先に届く。

| 環境 | 設定画面 |
| --- | --- |
| テスト | <https://dashboard.stripe.com/test/settings/emails> |
| 本番 | <https://dashboard.stripe.com/settings/emails> |

「Successful payments」をオンにする。テストと本番は別管理のため、両方で操作する。

## 本番切替の手順

本番公開までの一連の手順は docs/production-cutover.md にまとめてある。
DNSのBefore/After、Webhookエンドポイントの登録、実行順のチェックリストを含む。

# Apps Script 反映ログ

Apps Script プロジェクトはリポジトリの外にある。
`gas-auth/*.gs` を push しても本番へは反映されない。

実際に貼り替えたのがいつで、どこまで済んでいるかを、ここだけで管理する。

---

## 運用ルール

**Claude は、自分の判断で「完了」と書かない。**

リポジトリの外で起きたことは観測できない。にもかかわらず完了として扱うと、
本当は未反映のまま「反映済み」の記録だけが残る。
逆に、完了しているものを毎回「未了」と表示し続けると、
本当に未了の作業が発生したときに、その中へ埋もれて見落とす。

したがって、この表へ追記するのは
**利用者が反映を終えて報告したときだけ**とする。

報告を受けていない状態について Claude が述べるときは、次の形式を使う。

> GAS反映状況: 不明（`<日付>` の報告時点で `<内容>` まで完了の連絡あり）

「報告者確認」の列には、反映した事実ではなく
**何を見て正常と判断したか**を書く。
あとで挙動が変わったとき、いつの時点まで正常だったかを遡れるようにするため。

---

## 反映履歴

| 日付 | 反映ファイル | setupAuthSystem() | デプロイ更新 | 報告者確認 |
| --- | --- | --- | --- | --- |
| 2026-07-31 | Consent.gs / Legal.gs / LegalSeed.gs（新規3）<br>Config.gs / Main.gs / Setup.gs / Store.gs / Stripe.gs（上書き5） | 実行済み | 済み | `/pricing/` で同意チェックボックス4件が表示され、テスト決済の Checkout イベントに metadata（`tos_version` / `tos_agreed_at` / `agreed_items`）が記録された<br>「TSAM AI 法務文書」スプレッドシートが作成され、terms 24行 / privacy 17行 / tokusho 26行が投入された |
| 2026-08-10 | Notifier.gs（新規1）<br>Config.gs / Main.gs / Users.gs / Setup.gs（上書き4） | 実行済み | 済み | `users` シートのヘッダーが17列になり、末尾Q列に `notifier_license_key` が追加された（既存A〜P列の位置は不変）<br>Script Properties に `NOTIFIER_SHARED_SECRET` を設定（Cloudflare の `AUTH_GAS_SHARED_SECRET` と同値） |

---

## 反映の手順

1. Apps Script エディタで対象ファイルを貼り替える（新規は同名でファイルを作る）
2. 必要なら `setupAuthSystem()` を実行する
   （シート・スプレッドシートが増えた回だけ。既存データは上書きされない）
3. **「デプロイを管理」からバージョンを更新する。**
   「新しいデプロイ」を選ぶと `/exec` URL が変わり、`auth/config.js` と食い違う
4. 反映内容と確認結果を Claude へ報告する（Claude が上の表へ追記する）

関連: [../MANUAL_SETUP_CHECKLIST.md](../MANUAL_SETUP_CHECKLIST.md) A節 /
[../AUTH_SETUP.md](../AUTH_SETUP.md) / [../gas-auth/README.md](../gas-auth/README.md)

---

## 未反映の予定: Stripe Webhook 中継対応（2026-08-20 時点・**未実施**）

ブランチ `feat/stripe-webhook-relay` にあるもの。Stripe の配信失敗（2026-08-17〜、
**8/26 06:25 UTC に無効化予告**）への対応。経緯と全体手順は
[instructions/2026-08-20-stripe-webhook-relay.md](instructions/2026-08-20-stripe-webhook-relay.md)。

### 変更ファイル

| ファイル | 種別 | 変更内容 |
| --- | --- | --- |
| `Webhook.gs` | 上書き | `checkout.session.completed` で `mode` が `subscription` でない／契約IDが無い Session を `ignored` にする（交流会アプリの決済を会員登録しない）。設定 `STRIPE_WEBHOOK_REQUIRE_SIGNATURE` で署名無しを拒否 |
| `Users.gs` | 上書き | `findUserByAnyIdentity_()` を追加（Webhook の利用者検索を 1 回の読みに） |
| `Store.gs` | 上書き | `updateCells_()` を 1 レンジ書き込みに（応答時間の短縮） |
| `Config.gs` | 上書き | `DEFAULT_SETTINGS` に `STRIPE_WEBHOOK_REQUIRE_SIGNATURE`（既定 FALSE）を追加 |
| `Setup.gs` | 上書き | 上記設定の説明文 |

**貼り替えるのは上の 5 ファイルだけ。** 新規ファイルは無い。

### 手順

1. 5 ファイルを貼り替える
2. `setupAuthSystem()` を実行する（設定シートに `STRIPE_WEBHOOK_REQUIRE_SIGNATURE` の行を足すため。既存データは上書きされない）
3. Script Properties に `STRIPE_WEBHOOK_SECRET` を入れる（中継用エンドポイントの `whsec_…`。Worker 側と同じ値）
4. **「デプロイを管理」からバージョンを更新する**（新規デプロイを作らない。URL が変わると Worker の `GAS_URL` と `auth-verify` の `AUTH_GAS_URL` が食い違う）
5. Worker（`workers/stripe-relay/`）のデプロイと Stripe 側の切替は README §3 のとおり
6. 切替後、`stripe_events` に `processed` が増え、Stripe ダッシュボードの配信が 200 になることを確認
7. 中継だけが呼ぶ状態になったら設定シートの `STRIPE_WEBHOOK_REQUIRE_SIGNATURE` を `TRUE` に
8. 結果を Claude へ報告する（上の反映履歴へ追記する）

### 戻すとき

`STRIPE_WEBHOOK_REQUIRE_SIGNATURE` を `FALSE` に戻せば、旧来どおり署名無しを受け付ける。
ファイルを前の版へ戻してもシートの追加行は害にならない。

---

## 未反映の予定: カレンダー通知 V2（2026-08-10 時点・**未実施**）

ブランチ `feat/notifier-v2-license-gate` にあるもの。
main へのマージ前に貼り替える必要は無い。**マージ後、Workers のデプロイと
足並みを揃えて実施する。**

### 変更ファイル

| ファイル | 種別 | 変更内容 |
| --- | --- | --- |
| `Notifier.gs` | **新規** | ライセンスの発行（`issueNotifierLicense`）と照会（`verifyNotifierLicense`） |
| `Config.gs` | 上書き | `users` に Q列 `notifier_license_key` を追加／`NOTIFIER_ENTITLEMENT` 設定を追加／`NOTIFIER_SHARED_SECRET` を秘密キーへ登録／action ホワイトリストに2件追加 |
| `Main.gs` | 上書き | 追加した2 action の振り分け |
| `Users.gs` | 上書き | `notifierLicenseKey` の読み書き |
| `Setup.gs` | 上書き | `NOTIFIER_ENTITLEMENT` の説明文 |

**貼り替えるのは上の5ファイルだけ。** ほかのファイルは変更していない。

### 手順

1. **Script Property を1つ足す**

   プロジェクトの設定 → スクリプト プロパティ →
   `NOTIFIER_SHARED_SECRET` に推測困難な文字列（32文字以上）を入れる。
   **同じ値を Cloudflare 側の `AUTH_GAS_SHARED_SECRET` にも入れる**
   （[../workers/notifier-gate/README.md](../workers/notifier-gate/README.md) §5-2）。
   片方だけ設定した状態では、ライセンス照会が常に失敗する。

2. **5ファイルを貼り替える**（`Notifier.gs` は同名で新規作成）

3. **`setupAuthSystem()` を実行する。**

   `users` シートのヘッダー行を17列へ広げるために必要。
   **既存の行は上書きされない**（Q列は空欄のまま＝未発行と同じ扱い）。
   設定シートには `NOTIFIER_ENTITLEMENT`（初期値 `all_active`）が1行増える。

4. **「デプロイを管理」からバージョンを更新する**（新規デプロイを作らない）

5. **疎通を確かめる**

   - ログイン後の画面から `issueNotifierLicense` を呼び、43文字のキーが返ること
   - `users` シートの Q列に同じ値が入り、**2回目も同じ値**が返ること
   - Workers から `/v1/evaluate` を叩いて `licenseState: "active"` が返ること

6. 結果を Claude へ報告する（上の反映履歴へ追記する）

### 戻すとき

Q列を消す必要は無い（空欄でも既存の処理は動く）。
ファイルを前の版へ戻し、デプロイのバージョンを戻せばよい。
`NOTIFIER_SHARED_SECRET` を消すと照会が全部失敗するようになるので、
Workers を止めるまでは残しておくこと。

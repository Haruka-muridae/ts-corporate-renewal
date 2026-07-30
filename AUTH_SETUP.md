# 認証システム セットアップ手順

TSAM AI の本番用ログイン・Portal・決済連携（`gas-auth/` と `/login/` `/portal/` ほか）の
初期構築手順。

決済（Stripe）側の設定は [STRIPE_SETUP.md](./STRIPE_SETUP.md)、
公開・デプロイは [DEPLOYMENT.md](./DEPLOYMENT.md)、
安全性の前提と限界は [SECURITY_NOTES.md](./SECURITY_NOTES.md) を参照。

> **既存の `/apps/` とは別物です。**
> `/apps/` はテスト環境として維持し、この手順では触りません。
> `apps/AUTH_SETUP.md` は `/apps/` の Google ログイン用で、本書とは無関係です。

---

## 全体像

```text
ブラウザ（静的ファイル）                Google Apps Script            Google Drive
  /login/  /pricing/  /portal/  ──►  gas-auth（Webアプリ）  ──►  マイドライブ
  /password/setup/  /password/reset/        │                       └ TSAM AI
  /payment/success/  /payment/cancel/       │                           └ Auth
  /logout/                                  │                               ├ TSAM AI ユーザー管理
                                            ▼                               ├ TSAM AI 認証ログ
                                        Stripe API                          └ TSAM AI 認証設定
```

秘密情報（Stripe秘密鍵・各種シークレット）は **Apps Script の Script Properties にのみ** 置く。
リポジトリにも、スプレッドシートにも入れない。

---

## 手順

### 1. Apps Script プロジェクトを作る

1. <https://script.google.com/> で「新しいプロジェクト」を作る。
2. プロジェクト名を付ける（例: `TSAM AI Auth`）。
3. `gas-auth/` 配下の `.gs` ファイルをすべて貼り付ける。
   ファイル名は拡張子を除いた名前で作る（`Config`、`Crypto`、`Login` …）。
4. 「プロジェクトの設定」→「`appsscript.json` マニフェスト ファイルをエディタで表示する」を有効にし、
   `gas-auth/appsscript.json` の内容で置き換える。

> **既存の `gas/`（お気に入り機能）とは別プロジェクトにすること。**
> 同じプロジェクトに入れると `CONFIG` などの名前が衝突し、両方が壊れる。

`clasp` を使う場合:

```bash
cd gas-auth
clasp create --type standalone --title "TSAM AI Auth"
clasp push
```

### 2. `setupAuthSystem()` を実行する

1. エディタで関数 `setupAuthSystem` を選び、「実行」。
2. 初回は権限の承認を求められる。以下すべてを許可する。
   - スプレッドシートの表示・管理
   - Google ドライブのファイルの表示・管理
   - 外部サービスへの接続（Stripe API 用）
   - メールの送信（パスワード案内用）
3. 実行ログに、作成されたフォルダIDとスプレッドシートIDが出る。

このとき自動で行われること:

| 内容 | 備考 |
| --- | --- |
| マイドライブに `TSAM AI` / `Auth` フォルダを作成 | すでにあれば再利用する |
| ユーザー管理・認証ログ・認証設定の3ファイルを作成 | すでにあれば再利用する |
| 必要なシートとヘッダーを作成 | 既存のデータ行には触らない |
| 各IDを Script Properties へ保存 | 以降は名前検索を行わない |
| `SESSION_SECRET` / `TOKEN_SECRET` / `PASSWORD_PEPPER` / `STRIPE_WEBHOOK_URL_KEY` を生成 | **既存の値は絶対に上書きしない** |
| `architect@potenitas.com` の管理者レコードを作成 | パスワードは未設定（`pending`） |
| 管理者の初期設定トークンを発行 | メールで案内を送る |

**何度実行しても重複しません。** 設定を足したあとに再実行して構いません。

### 3. 公開URLを設定する

`setupAuthSystem()` だけでは、メールに載せるURLを決められません。
認証設定スプレッドシート（`TSAM AI 認証設定` → `settings` シート）で
`APP_BASE_URL` に公開サイトの基底URLを入れます。

```text
APP_BASE_URL = https://tsam-ai.com/
```

末尾のスラッシュを付けてください。これを入れると、以下が自動で決まります。

| 設定キー | 未設定時の解決先 |
| --- | --- |
| `LOGIN_URL` | `APP_BASE_URL` + `login/` |
| `PORTAL_URL` | `APP_BASE_URL` + `portal/` |
| `SUCCESS_URL` | `APP_BASE_URL` + `payment/success/` |
| `CANCEL_URL` | `APP_BASE_URL` + `payment/cancel/` |
| `PASSWORD_SETUP_URL` | `APP_BASE_URL` + `password/setup/` |
| `PASSWORD_RESET_URL` | `APP_BASE_URL` + `password/reset/` |

個別に上書きしたい場合だけ、それぞれのキーに直接URLを入れます。

> **`APP_BASE_URL` が空のままだと、パスワード案内メールは送信されません。**
> URLを組み立てられないためです。この場合、利用者への応答は変わりませんが
> `system_error_logs` シートに記録が残ります。

### 4. Web アプリとしてデプロイする

1. 「デプロイ」→「新しいデプロイ」→ 種類「ウェブアプリ」。
2. 設定:
   - 説明: 任意（例: `v1`）
   - 次のユーザーとして実行: **自分**
   - アクセスできるユーザー: **全員**
3. デプロイして表示される `https://script.google.com/macros/s/.../exec` を控える。

> アクセスを「全員」にするのは、ログイン前の利用者がこのAPIを呼ぶためです。
> APIは action ホワイトリスト方式で、`setupAuthSystem()` などの管理関数は
> Web から実行できません。

### 5. フロント側にAPI URLを設定する

[auth/config.js](auth/config.js) の `apiUrl` に、控えた `/exec` URL を貼ります。

```js
export const AUTH_CONFIG = Object.freeze({
  apiUrl: 'https://script.google.com/macros/s/AKfycb.../exec',
  ...
});
```

- **書き換えるのはこの1か所だけ**です。HTMLや他のJSへ直接書かないでください。
- この値は秘密ではありません。コミットして構いません。
- 空のあいだは各画面が「この機能は現在ご利用いただけません。」と案内して止まります
  （画面自体は壊れません）。

### 6. Stripe を設定する

[STRIPE_SETUP.md](./STRIPE_SETUP.md) を参照してください。
料金プランの登録（`plans` シート）と、Webhook の設定が必要です。

### 7. 管理者パスワードを設定する

`setupAuthSystem()` の時点で `architect@potenitas.com` 宛に
初期設定の案内メールが送られています。

メールが届いていれば、記載のURLからパスワードを設定してください。
最低12文字です（`PASSWORD_MIN_LENGTH` で変更可）。

**メールが届かない場合**、エディタから次のいずれかを実行します。

| 関数 | 動作 |
| --- | --- |
| `sendAdminSetupLink()` | 案内メールを送り直す |
| `printAdminSetupLink()` | 初期設定URLを **実行ログへ出力する** |

`printAdminSetupLink()` は緊急手段です。
URLにトークンが含まれるため、**使用後は Apps Script の実行ログを削除してください**。

いずれの場合も、古いトークンはその場で無効になります。

> 初期パスワードはコードにもドキュメントにも書きません。
> 管理者自身が設定するまで、管理者アカウントはログインできない状態（`pending`）です。

### 8. 設定を点検する

エディタから `checkAuthSetup()` を実行します。
必要な Script Properties とURLの設定状況が一覧で出ます
（秘密情報の値そのものは出力されません）。

```text
  OK  ユーザー管理スプレッドシート（AUTH_USER_SPREADSHEET_ID）
  OK  セッション署名用シークレット（SESSION_SECRET）
  未設定  Stripe シークレットキー（STRIPE_SECRET_KEY）
  ...
  APP_BASE_URL = https://tsam-ai.com/
  有効なプラン: 1 件
```

### 9. パスワードハッシュの反復回数を決める

エディタから `benchmarkPasswordHashing()` を実行し、実測してください。

```text
PBKDF2-HMAC-SHA256 の所要時間
  1000 回: xxx ms
  5000 回: xxx ms
  10000 回: xxx ms
  20000 回: xxx ms
```

**ログイン1回あたり 0.5〜1.5 秒に収まる最大の値**を選び、
`settings` シートの `PBKDF2_ITERATIONS` に入れます（既定は 10000）。

反復回数を変えても既存利用者は締め出されません。
次回ログイン成功時に、新しい回数で静かに作り直されます。

理由と限界は [SECURITY_NOTES.md](./SECURITY_NOTES.md) を参照してください。

---

## Script Properties 一覧

`setupAuthSystem()` が自動で入れるもの:

| キー | 内容 |
| --- | --- |
| `AUTH_ROOT_FOLDER_ID` | `TSAM AI` フォルダのID |
| `AUTH_FOLDER_ID` | `Auth` フォルダのID |
| `AUTH_USER_SPREADSHEET_ID` | ユーザー管理スプレッドシートのID |
| `AUTH_LOG_SPREADSHEET_ID` | 認証ログスプレッドシートのID |
| `AUTH_CONFIG_SPREADSHEET_ID` | 認証設定スプレッドシートのID |
| `SESSION_SECRET` | セッショントークンのハッシュ用 |
| `TOKEN_SECRET` | 一時トークンのハッシュ用 |
| `PASSWORD_PEPPER` | パスワードハッシュの追加鍵 |
| `STRIPE_WEBHOOK_URL_KEY` | Webhook URL に付ける合言葉 |

**手動で入れるもの:**

| キー | 内容 | 必須 |
| --- | --- | --- |
| `STRIPE_SECRET_KEY` | Stripe のシークレットキー（`sk_...`） | 決済を使うなら必須 |
| `STRIPE_WEBHOOK_SECRET` | Stripe の署名シークレット（`whsec_...`） | 中継を置く場合のみ |
| `APP_BASE_URL` | 公開サイトの基底URL | `settings` シートでも可 |
| `LOGIN_URL` / `PORTAL_URL` | 個別に上書きしたい場合 | 任意 |

> `SESSION_SECRET` / `TOKEN_SECRET` / `PASSWORD_PEPPER` を変更・削除すると、
> **既存のセッション・トークン・パスワードがすべて無効になります。**
> `PASSWORD_PEPPER` を失うと、全利用者がパスワード再設定を強いられます。
> Script Properties のバックアップを取ってください。

---

## 認証設定シートの一覧

`TSAM AI 認証設定` → `settings` シート。

| キー | 既定値 | 内容 |
| --- | --- | --- |
| `PASSWORD_MIN_LENGTH` | `12` | パスワードの最低文字数 |
| `PASSWORD_MAX_LENGTH` | `128` | パスワードの最大文字数 |
| `PBKDF2_ITERATIONS` | `10000` | ハッシュの反復回数（下限1000） |
| `LOGIN_FAILURE_LIMIT` | `5` | 連続失敗の上限回数 |
| `LOCK_DURATION_MINUTES` | `15` | ロック時間（分） |
| `SESSION_TTL_HOURS` | `12` | 通常ログインの有効期限 |
| `REMEMBER_SESSION_TTL_DAYS` | `30` | ログイン保持時の有効期限 |
| `INITIAL_TOKEN_TTL_HOURS` | `72` | 初期設定トークンの有効期限 |
| `RESET_TOKEN_TTL_MINUTES` | `60` | 再設定トークンの有効期限 |
| `TRIALING_ALLOWED` | `TRUE` | `trialing` を利用可能として扱うか |
| `PAST_DUE_ALLOWED` | `FALSE` | `past_due` を利用可能として扱うか |
| `APP_BASE_URL` | （空） | 公開サイトの基底URL |
| `LOGIN_URL` ほか | （空） | 個別のURL上書き |
| `MAIL_SENDER_NAME` | `TSAM AI` | メールの送信者名 |
| `MAIL_ENABLED` | `TRUE` | メール送信の有効・無効 |
| `CHECKOUT_HOURLY_LIMIT` | `60` | Checkout の1時間あたり作成上限 |

**秘密情報はこのシートに書かないでください。**
`STRIPE_SECRET_KEY` などのキーを書いても、コード側が読まないよう遮断しています
（`Config.gs` の `SECRET_KEYS`）。

---

## スプレッドシート構成

### TSAM AI ユーザー管理

| シート | 内容 |
| --- | --- |
| `users` | 利用者（A〜P の16列） |
| `password_tokens` | 初期設定・再設定トークン（ハッシュのみ） |
| `sessions` | セッション（ハッシュのみ） |
| `stripe_events` | 受信済み Stripe イベント（冪等性の記録） |

`users` の列:

| 列 | 項目 | 備考 |
| --- | --- | --- |
| A | `user_id` | `usr_` + UUID |
| B | `email` | 小文字・前後空白除去済み |
| C | `password_hash` | `pbkdf2$sha256$<反復回数>$<16進>` |
| D | `password_salt` | 利用者ごとに異なる16進32文字 |
| E | `role` | `admin` / `member` |
| F | `stripe_customer_id` | |
| G | `stripe_subscription_id` | |
| H | `subscription_status` | Stripe の契約状態 |
| I | `payment_exempt` | `TRUE` なら決済確認を省略 |
| J | `account_status` | `pending` / `active` / `suspended` / `disabled` / `locked` |
| K | `last_login_at` | |
| L | `login_failure_count` | |
| M | `locked_until` | |
| N | `password_updated_at` | |
| O | `created_at` | |
| P | `updated_at` | |

### TSAM AI 認証ログ

| シート | 内容 |
| --- | --- |
| `login_logs` | ログイン試行（メールはマスク済み） |
| `admin_action_logs` | 管理操作・Webhook 由来の変更 |
| `system_error_logs` | 想定外のエラー |

パスワード・ハッシュ・トークンは記録しません。

### TSAM AI 認証設定

| シート | 内容 |
| --- | --- |
| `settings` | 上記の設定一覧 |
| `plans` | 料金プランと Stripe Price ID |

---

## 契約状態とアカウント状態

**混同しないでください。** 別の軸です。

### 契約状態（`subscription_status`）— Stripe 由来

| 値 | 既定の扱い |
| --- | --- |
| `active` | 利用可 |
| `trialing` | 利用可（`TRIALING_ALLOWED` で変更可） |
| `past_due` | **利用不可**（`PAST_DUE_ALLOWED` で変更可） |
| `canceled` / `unpaid` / `incomplete_expired` / `paused` | 利用不可 |
| `exempt` | 管理者用の表示値。`payment_exempt = TRUE` と併用する |

> `past_due` を初期値で利用不可にしています。
> 支払いが確認できない状態での利用を許すかは事業判断のため、
> 運用開始前に方針を決めて `PAST_DUE_ALLOWED` を設定してください。

> `subscription_status` に `exempt` と書いても、`payment_exempt` が `FALSE` なら
> ログインできません。免除は `payment_exempt` 列だけで判断します。

### アカウント状態（`account_status`）— こちら側の運用

| 値 | 意味 |
| --- | --- |
| `pending` | 作成済み・パスワード未設定。ログイン不可 |
| `active` | 通常。ログイン可 |
| `suspended` | 一時停止。ログイン不可。再設定リンクも送らない |
| `disabled` | 無効化。ログイン不可 |
| `locked` | 予約（ロックは `locked_until` 列で管理） |

契約が切れてもアカウントは無効化しません。
再契約したときに同じパスワードで戻れるようにするためです。

---

## ログイン判定の順序

```text
1. メールアドレス正規化（前後空白除去・小文字化）
2. ユーザー検索
3. ロック状態確認        → ロック中なら照合せずに終了
4. アカウント状態確認    → active 以外なら終了
5. パスワード照合        → 不一致なら失敗回数を+1
6. payment_exempt 確認   → TRUE なら契約確認を省略
7. subscription_status 確認
8. セッション発行
```

利用者に返るのは次の2つだけです。

- `メールアドレスまたはパスワードが正しくありません。`
- `ログインを一時的に制限しています。時間をおいて再度お試しください。`

未登録・契約切れ・停止中などの内部理由は画面に出しません。
本当の理由は `login_logs` の `failure_reason_code` にだけ残ります。

存在しないメールアドレスに対しても、実在する場合と同じだけの
ハッシュ計算を行います（応答時間の差から登録の有無を推測させないため）。

---

## 動作確認

### 自動テスト

```bash
npm run test:auth-system            # 全部（Chrome が必要）
npm run test:auth-system:unit       # Node のみ
npm run test:auth-system:browser    # 実ブラウザのみ
npm test                            # 既存 /apps/ 分も含めて全部
```

`gas-auth/*.gs` は Node 上の偽 Apps Script 環境で実行されます
（[tests/helpers/gas-harness.mjs](tests/helpers/gas-harness.mjs)）。
本番のスプレッドシートには一切書き込みません。

### Apps Script 上での確認

エディタから実行します。

| 関数 | 内容 |
| --- | --- |
| `checkAuthSetup()` | 設定の抜けを点検（書き込みなし） |
| `benchmarkPasswordHashing()` | ハッシュの所要時間を実測（書き込みなし） |
| `selfTestAuthFlow()` | 作成→設定→ログイン→検証→ログアウトの通し確認 |

`selfTestAuthFlow()` は **本番のスプレッドシートへ一時的に書き込みます**。
実行後に作成した行は自動で削除しますが、
終了後にユーザー管理シートへ余分な行が残っていないか確認してください。

### 手動での通し確認

1. `/login/` を開き、未登録のメールアドレスでログイン → 定型文が出る
2. `/pricing/` からプランを選び、Stripe のテストカードで決済
   （`4242 4242 4242 4242` / 任意の将来日 / 任意のCVC）
3. `/payment/success/` が表示される
4. 案内メールが届く → URLからパスワードを設定
5. `/login/` から新しいパスワードでログイン → `/portal/` へ入れる
6. `/portal/` からログアウト → 再度 `/portal/` を開くと `/login/` へ戻される
7. 誤ったパスワードで5回失敗 → ロックの文言が出る

---

## 定期実行（任意）

古い行を掃除する関数があります。トリガーで月1回程度実行してください。

| 関数 | 内容 |
| --- | --- |
| `cleanupExpiredSessions()` | 7日以上前に期限切れ・失効したセッション行を削除 |
| `cleanupExpiredTokens()` | 30日以上前の使用済み・期限切れトークン行を削除 |

必須ではありません。数十人規模なら行数が問題になるまでに時間があります。

---

## トラブルシューティング

| 症状 | 原因と対処 |
| --- | --- |
| 画面に「この機能は現在ご利用いただけません。」 | `auth/config.js` の `apiUrl` が未設定、または `/exec` の形式でない |
| 「サーバーでエラーが発生しました」 | `setupAuthSystem()` 未実行。Script Properties を `checkAuthSetup()` で確認 |
| 案内メールが届かない | `APP_BASE_URL` 未設定、または `MAIL_ENABLED=FALSE`。`system_error_logs` を確認 |
| メールの送信上限に達した | Gmail の1日あたり送信数の上限（無料アカウントは100通程度） |
| ログインが遅い | `PBKDF2_ITERATIONS` が大きすぎる。`benchmarkPasswordHashing()` で調整 |
| 「アクセスが集中しています」 | `LOCK_TIMEOUT`。同時実行が重なっている。時間をおく |
| 決済後に利用者が作られない | Webhook が届いていない。[STRIPE_SETUP.md](./STRIPE_SETUP.md) の確認手順へ |
| 全員がログインできなくなった | `PASSWORD_PEPPER` / `SESSION_SECRET` が変わっていないか確認 |

---

## 将来の移行について

このMVPは Apps Script + スプレッドシートで組んでいます。
利用者が数百人規模になる、または以下が必要になった時点で移行を検討してください。

- 応答速度（スプレッドシートの全件走査が重くなる）
- 十分な反復回数のパスワードハッシュ（Apps Script では上げられない）
- HTTPヘッダーを読む必要のある処理（Webhook の標準署名検証など）
- 監査要件のあるログ

移行しやすいように、次の構造にしてあります。

- 画面は `auth/api.js` だけを通して通信する。
  APIの実装が変わっても、呼び出し側は `api.js` の差し替えで済む。
- セッションは「サーバーが持つ不透明なトークン」であり、
  形式に依存した処理を画面側に持たせていない。
- パスワードハッシュは `pbkdf2$sha256$<反復回数>$<値>` の形式で、
  アルゴリズムを値の中に持つ。別方式を足しても既存利用者を壊さない。
- 利用者データはスプレッドシートなので、CSV でそのまま持ち出せる。

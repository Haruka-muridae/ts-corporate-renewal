# gas-auth — 認証・決済バックエンド（Google Apps Script）

TSAM AI の本番用ログイン、セッション、パスワード管理、Stripe 連携を担う
Apps Script プロジェクト。

セットアップ手順は [../AUTH_SETUP.md](../AUTH_SETUP.md)、
Stripe の設定は [../STRIPE_SETUP.md](../STRIPE_SETUP.md)、
安全性の前提と限界は [../SECURITY_NOTES.md](../SECURITY_NOTES.md)。

> **`gas/`（お気に入り機能）とは別のプロジェクトです。**
> 同じ Apps Script プロジェクトへ入れると `CONFIG` などの名前が衝突し、
> 両方が壊れます。必ず別プロジェクトにしてください。

---

## ファイル

| ファイル | 役割 |
| --- | --- |
| `Main.gs` | `doGet` / `doPost`。action ホワイトリスト、例外処理 |
| `Config.gs` | 定数、列定義、設定値の3層解決（設定シート→Script Properties→既定値） |
| `Util.gs` | 文字列・時刻・メール正規化・マスキング |
| `Response.gs` | JSON レスポンスとエラー文言の一覧 |
| `Crypto.gs` | 乱数、PBKDF2、HMAC、定数時間比較、Stripe 署名検証 |
| `Store.gs` | スプレッドシート読み書き、`withLock_`（入れ子対応） |
| `Setup.gs` | `setupAuthSystem()`、管理者レコード、`checkAuthSetup()` |
| `Users.gs` | 利用者の検索・作成・更新、利用可否の判定 |
| `Password.gs` | ハッシュ化・照合・強度検証・ダミー照合 |
| `Tokens.gs` | 初期設定／再設定トークンの発行・検証・無効化 |
| `Sessions.gs` | セッションの発行・検証・失効 |
| `Login.gs` | ログイン判定、失敗制限、パスワード設定・再設定 |
| `Stripe.gs` | Stripe API クライアント、Checkout Session、プラン |
| `Webhook.gs` | Webhook 受信、真正性確認、冪等性、イベント処理 |
| `Mailer.gs` | メール送信 |
| `MailTemplates.gs` | メール本文のひな形（文面を直すのはここだけ） |
| `Logs.gs` | 認証ログ・管理操作ログ・エラーログ |
| `Tests.gs` | 実環境でしか測れないこと（速度計測、通し確認） |
| `appsscript.json` | マニフェスト（スコープ、Webアプリ設定） |

ロジックの自動テストは Node 側（[../tests/](../tests/)）にあります。
`.gs` を偽の Apps Script 環境で読み込んで実行するため、
本番のスプレッドシートには一切書き込みません。

```bash
npm run test:auth-system:unit
```

---

## API

すべて JSON を返します。

```jsonc
// 成功
{ "success": true, "data": { } }

// 失敗
{ "success": false, "error": { "code": "AUTH_FAILED", "message": "…" } }
```

### GET

| action | 内容 |
| --- | --- |
| `health` | 疎通確認 |
| `listPlans` | 有効な料金プラン（**Price ID は含まない**） |
| `publicConfig` | パスワード最低文字数、各URL、決済導線の有無 |

### POST（`text/plain` の JSON 本文）

| action | 内容 |
| --- | --- |
| `login` | `{ email, password, remember }` → セッショントークン |
| `verifySession` | `{ sessionToken }` → 利用者情報 |
| `logout` | `{ sessionToken }` → セッション失効 |
| `setupPassword` | `{ token, password, passwordConfirm }` 初期設定 |
| `resetPassword` | `{ token, password, passwordConfirm }` 再設定 |
| `requestPasswordReset` | `{ email }` → 常に成功を返す |
| `createCheckoutSession` | `{ planCode, email }` → Stripe の決済画面URL |
| `checkoutStatus` | `{ checkoutSessionId }` → 決済状態（判定には使わない） |

### POST（Webhook）

```text
POST /exec?path=stripe-webhook&k=＜合言葉＞
```

本文は Stripe の JSON。詳細は [../STRIPE_SETUP.md](../STRIPE_SETUP.md)。

---

## 手動実行する関数

エディタから実行します。**Web からは呼べません**（action ホワイトリスト外）。

| 関数 | 内容 | 書き込み |
| --- | --- | --- |
| `setupAuthSystem()` | 初期セットアップ（冪等） | あり |
| `checkAuthSetup()` | 設定の点検 | なし |
| `sendAdminSetupLink()` | 管理者の初期設定メールを再送 | あり |
| `printAdminSetupLink()` | 初期設定URLを実行ログへ出力（緊急用） | あり |
| `benchmarkPasswordHashing()` | ハッシュ所要時間の実測 | なし |
| `selfTestAuthFlow()` | 通し確認（作った行は自動削除） | あり |
| `cleanupExpiredSessions()` | 古いセッション行の削除 | あり |
| `cleanupExpiredTokens()` | 古いトークン行の削除 | あり |

`printAdminSetupLink()` は URL にトークンを含みます。
**使用後は Apps Script の実行ログを削除してください。**

---

## 設計メモ

### 設定値の3層

```text
認証設定スプレッドシート（settings シート）   ← 運用中に変えたい値
        ↓ 無ければ
Script Properties                             ← 秘密情報と各種ID
        ↓ 無ければ
Config.gs の DEFAULT_SETTINGS                 ← 出荷時の既定値
```

秘密情報キー（`SECRET_KEYS`）は設定シートから読みません。
誤って設定シートへ書いても、コードは参照しません。

### 失敗理由を返さない

画面へ返すのは `AUTH_FAILED`（定型文）と `LOCKED` だけです。
未登録・契約切れ・停止中を区別して返すと、
アカウントの存在や状態を外部から調べられます。

本当の理由は `login_logs` の `failure_reason_code` にのみ残します。

### 排他制御は入れ子で呼んでよい

`withLock_()` は深さを数え、最外周だけが実際のロックを取ります。
Apps Script のロックはスクリプト単位のため、
素直に二重取得すると自分自身を待ってタイムアウトします。

```js
withLock_(function () {
  // この中でさらに withLock_ を呼んでも安全
  createUser_({ ... });
  issueToken_(userId, TOKEN_TYPE.INITIAL_SETUP);
});
```

### 全件走査で足りる規模

`users` や `sessions` は毎回全行を読んで探しています。
想定利用者は数十人のため、これで十分です。

数百人規模になったら、索引シートの導入か、
別の基盤への移行を検討してください
（[../AUTH_SETUP.md](../AUTH_SETUP.md) の「将来の移行について」）。

### ES5 寄りの書き方

`var` と `function` 宣言を使い、既存の `gas/` に合わせています。
Apps Script は V8 で新しい構文も動きますが、
2つのプロジェクトで書き方を揃えるほうが読み違えが減ります。

---

## 変更するときの注意

| 変更したいもの | 触るファイル |
| --- | --- |
| メールの文面 | `MailTemplates.gs` だけ |
| エラー文言 | `Response.gs` の `ERRORS` |
| 列の追加 | `Config.gs` の `HEADERS` と `*_COL` の両方 |
| 設定項目の追加 | `Config.gs` の `DEFAULT_SETTINGS` と `Setup.gs` の説明文 |
| 処理する Stripe イベント | `Webhook.gs` の `HANDLED_EVENTS` |
| API の追加 | `Config.gs` のホワイトリストと `Main.gs` の `dispatchPost_` |

列を足したら `HEADERS` と `*_COL` を必ず両方直してください。
片方だけだと、ずれた列を読み書きします
（自動テストの `setup` スイートが食い違いを検出します）。

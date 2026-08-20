# stripe-relay — Stripe Webhook → Apps Script 中継

認証システム（`gas-auth/`）向けの Stripe Webhook を受け取り、署名を検証してから
Apps Script の `/exec?path=stripe-webhook` へ転送する Cloudflare Worker。
[`../../STRIPE_SETUP.md`](../../STRIPE_SETUP.md) の「構成B」の実体です。

---

## 1. なぜ必要か

2026-08-17 06:25 UTC から、Stripe → Apps Script の配信が全件失敗していました
（33 件 other errors / 3 件 timeout。8/26 に無効化予告）。

原因は Apps Script の仕様です。Web アプリは POST に対して
`script.googleusercontent.com` への **302** を返し、Stripe は
**3xx を失敗として数え、リダイレクトを追いません**（Stripe 公式 docs
「Webhook リクエストへのリダイレクト応答は失敗と見なされます」）。
GAS 側のコードは正常に動いていても、Stripe から見ると毎回失敗になります。

この Worker は次の 3 つだけを行います。

| # | 処理 | 理由 |
| --- | --- | --- |
| 1 | `Stripe-Signature` を HMAC-SHA256 で検証 | GAS は HTTP ヘッダーを受け取れず、単体では署名検証できない |
| 2 | **Stripe へ即座に 200 を返す** | 3xx を見せない。GAS のコールドスタート（実測 35 秒）やロック待ちで Stripe をタイムアウトさせない |
| 3 | 応答のあとで GAS へ転送（`redirect: 'follow'`） | 302 はここで吸収する |

本文は解釈も変更もしません。**真正性の本命は GAS 側の Stripe API 照会**
（`gas-auth/Webhook.gs`: 受信本文からは `event.id` だけを採り、
`GET /v1/events/{id}` の結果だけを処理に使う）であり、この Worker が先に
200 を返しても不正な処理は起きません。

---

## 2. エンドポイント

| メソッド / パス | 内容 |
| --- | --- |
| `POST /`（任意のパス） | Stripe からの Webhook。署名不正は 400、設定不足は 503、受理は 200 |
| `GET /health` | 設定の有無（名前のみ、値は返さない）。不足があれば 503 |

応答の例:

```json
{ "received": true, "relayed": true }
{ "received": true, "relayed": false, "reason": "event-type-not-allowed" }
{ "ok": false, "error": "invalid-signature" }
```

---

## 3. デプロイ手順（運用者が行う）

**前提**: Cloudflare の `wrangler login` 済み。Stripe の画面は左上のアカウントが
`https://tsam-ai.com/` であることを毎回確認する（`docs/production-cutover.md` の注意）。

### 3-1. Worker をデプロイする

```bash
npm run deploy:stripe-relay
```

出力された URL（`https://stripe-relay.<subdomain>.workers.dev`）を控える。

### 3-2. Stripe にエンドポイントを登録する（本番モード）

<https://dashboard.stripe.com/webhooks> → **エンドポイントを追加**

- URL: 3-1 で控えた Worker の URL（末尾は `/` でも無しでも可）
- 送信するイベント（**この 5 種だけ**。「すべてのイベント」にしない）

  ```text
  checkout.session.completed
  customer.subscription.updated
  customer.subscription.deleted
  invoice.paid
  invoice.payment_failed
  ```

- 作成後、「署名シークレット」（`whsec_…`）を**表示してその場で控える**。

### 3-3. secrets を登録する

```bash
npx wrangler secret put STRIPE_WEBHOOK_SECRET --config workers/stripe-relay/wrangler.jsonc
npx wrangler secret put GAS_URL_KEY --config workers/stripe-relay/wrangler.jsonc
```

- `STRIPE_WEBHOOK_SECRET` … 3-2 で控えた `whsec_…`（**中継用エンドポイントのもの**。
  旧 GAS 直接登録のエンドポイントや `stripe listen` の値とは別）
- `GAS_URL_KEY` … Apps Script の Script Properties `STRIPE_WEBHOOK_URL_KEY` と同じ値

> **PowerShell の非表示プロンプトへの貼り付けは無言で失敗することがある。**
> 登録後に `GET /health` で `missing` が空になることを必ず確認する
> （値は返らない。名前が消えていれば入っている）。

### 3-4. 疎通を確かめる

```bash
curl -s https://stripe-relay.<subdomain>.workers.dev/health
# → {"ok":true,"version":"1.0.0","missing":[]}
```

Stripe ダッシュボードの新しいエンドポイントで「テストイベントを送信」
（または本番の再送）→ 配信結果が **200** になること。
Apps Script 側は `stripe_events` シートに行が増えること、
`system_error_logs` に `署名検証に失敗` が出ていないこと。

### 3-5. 旧エンドポイントを片付ける

Stripe 上の **GAS の URL を直接登録した旧エンドポイント**（`…/exec?path=stripe-webhook&k=…`）
を無効化または削除する。残すと同じイベントが 2 経路で届き、GAS 側は冪等性で
二重処理こそしないが、302 の失敗記録と警告メールが続く。

### 3-6. GAS 側を署名必須にする（任意・推奨）

中継だけが GAS を呼ぶ状態になったら、認証設定シートの
`STRIPE_WEBHOOK_REQUIRE_SIGNATURE` を `TRUE` にする。署名クエリの無い
直接 POST を GAS が拒否するようになる（合言葉が漏れても照会前に止まる）。

---

## 4. 設定

| 名前 | 種別 | 内容 |
| --- | --- | --- |
| `GAS_URL` | var | Apps Script の `/exec` URL。`auth-verify` の `AUTH_GAS_URL` と同じ |
| `ALLOWED_EVENT_TYPES` | var | 転送するイベント種別（カンマ区切り）。空なら全部転送 |
| `RELAY_MODE` | var | `async`（既定）: 先に 200 → 転送。`sync`: GAS の結果を待ち、失敗なら 500 |
| `GAS_URL_KEY` | secret | `/exec?k=` の合言葉 |
| `STRIPE_WEBHOOK_SECRET` | secret | 中継用エンドポイントの署名シークレット |

`RELAY_MODE=sync` は切替直後の動作確認に便利だが、GAS のコールドスタート時に
Stripe 側がタイムアウトすることがある。確認が済んだら `async` に戻す。

---

## 5. テスト

```bash
node tests/run.mjs stripe-relay
```

Workers ランタイムは不要（WebCrypto と fetch/Request/Response だけを使う）。
署名の合否・許容時間・設定不足・イベント種別の絞り込み・async/sync の挙動・
**応答や例外に合言葉と署名シークレットが出ないこと**を固定している。

---

## 6. ログ

イベント ID と種別、GAS の応答コードだけを出す。本文・URL（合言葉を含む）・
シークレットは出さない。失敗は `console.error`（Cloudflare の Observability で
`[stripe-relay]` を検索）。

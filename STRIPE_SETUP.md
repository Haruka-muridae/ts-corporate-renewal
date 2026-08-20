# Stripe 設定手順

TSAM AI の決済連携（Checkout と Webhook）の設定手順。

前提として [AUTH_SETUP.md](./AUTH_SETUP.md) の手順1〜5が終わっていること。

---

## 1. Stripe アカウントと商品

1. <https://dashboard.stripe.com/> にログインする。
2. **テストモード**のまま作業を始める（右上のトグル）。
3. 「商品カタログ」→「商品を追加」。
   - 商品名: 例 `TSAM AI スタンダード`
   - 料金体系: **継続**（サブスクリプション）
   - 請求期間: 月次 または 年次
   - 金額: 実際の価格
4. 作成後、料金（Price）の ID を控える。`price_` で始まる。

---

## 2. シークレットキーを登録する

1. Stripe の「開発者」→「APIキー」。
2. **シークレットキー**（`sk_test_...` / 本番は `sk_live_...`）を表示してコピー。
3. Apps Script の「プロジェクトの設定」→「スクリプト プロパティ」で追加。

```text
プロパティ: STRIPE_SECRET_KEY
値:         sk_test_...
```

> **公開可能キー（`pk_...`）は使いません。**
> このシステムは Stripe.js を読み込まず、Checkout Session の作成を
> すべてサーバー側（Apps Script）で行うためです。
>
> シークレットキーをリポジトリ・スプレッドシート・フロントエンドへ
> 置かないでください。`auth/config.js` にも入れません。

---

## 3. 料金プランを登録する

`TSAM AI 認証設定` スプレッドシートの `plans` シートに1行足します。

| 列 | 項目 | 例 | 備考 |
| --- | --- | --- | --- |
| A | `plan_code` | `standard` | 画面から送られる識別子。英数字で |
| B | `plan_name` | `スタンダード` | 画面に出る名前 |
| C | `stripe_price_id` | `price_1AbC...` | 手順1で控えたID |
| D | `amount` | `9800` | 表示用の金額。課金額は Stripe 側が正 |
| E | `currency` | `jpy` | |
| F | `interval` | `month` | `month` または `year` |
| G | `features` | 機能を改行区切りで | セル内改行は Alt+Enter |
| H | `enabled` | `TRUE` | `FALSE` の行は画面に出ない |

**D列の金額は表示のためだけの値です。**
実際に請求される金額は Stripe の Price が決めます。
両者がずれると利用者の不信を招くため、Price を変更したらこの列も直してください。

### Price ID をフロントへ出さない理由

料金プラン画面が受け取るのは `plan_code` `plan_name` `amount` `currency` `interval` `features` だけで、
**`stripe_price_id` は返しません。**

画面が Price ID を持つと、開発者ツールで書き換えて
別の（安い）Price で決済させられます。
プランコードから Price ID への対応付けは、サーバー側だけが知っています。

---

## 4. Webhook を設定する

### 前提：Apps Script の制約

**Apps Script の `doPost(e)` には HTTP リクエストヘッダーが渡りません。**
Stripe が付ける `Stripe-Signature` ヘッダーを Apps Script 単体では受け取れず、
一般的な署名検証をそのままの形では実装できません。

そこで、次の三重で真正性を確認しています。

| # | 方法 | 必須 | 内容 |
| --- | --- | --- | --- |
| 1 | URLの合言葉 | ○ | Webhook URL の `?k=` を Script Properties の値と定数時間で比較 |
| 2 | **Stripe API への照会** | ○ | 受信本文からは `event.id` だけを採り、`GET /v1/events/{id}` の結果だけを処理に使う |
| 3 | 署名検証 | 中継を置く場合 | HMAC-SHA256 で `Stripe-Signature` を検証 |

**2 が本質的な検証です。** 攻撃者は自分では Stripe アカウント内に
イベントを作れないため、偽の本文を送っても照会に失敗して処理が止まります。
本文の中身は一切信用していません（本文を差し替えても、照会結果だけが使われることを
自動テストで確認しています）。

以下、構成A（中継なし）と構成B（中継あり）のどちらかを選びます。

> **2026-08-20 以降は構成B を使ってください。** 構成A は Apps Script の 302 を
> Stripe が失敗と数えるため、本番では配信が全件失敗扱いになり、9 日連続で
> エンドポイントが無効化されます（2026-08-17 に実際に発生。
> [docs/instructions/2026-08-20-stripe-webhook-relay.md](docs/instructions/2026-08-20-stripe-webhook-relay.md)）。
> 中継の実体はこのリポジトリの [`workers/stripe-relay/`](workers/stripe-relay/README.md) にあります。

---

### 構成A: Apps Script へ直接送る（テストモードの一時確認のみ・**本番非推奨**）

1. Apps Script の「プロジェクトの設定」→「スクリプト プロパティ」で
   `STRIPE_WEBHOOK_URL_KEY` の値をコピーする
   （`setupAuthSystem()` が自動生成しています）。
2. Stripe の「開発者」→「Webhook」→「エンドポイントを追加」。
3. エンドポイントURL:

   ```text
   https://script.google.com/macros/s/＜デプロイID＞/exec?path=stripe-webhook&k=＜合言葉＞
   ```

4. 送信するイベントを選ぶ:

   ```text
   checkout.session.completed
   customer.subscription.updated
   customer.subscription.deleted
   invoice.paid
   invoice.payment_failed
   ```

5. 保存する。

> **このURLは秘密情報として扱ってください。**
> 合言葉が含まれます。共有・スクリーンショット・課題管理システムへの貼り付けを避けてください。
> 漏れた場合は Script Properties の `STRIPE_WEBHOOK_URL_KEY` を新しい値に変え、
> Stripe 側のURLも更新してください（`randomToken_()` の戻り値などを使う）。

#### 既知の制約：配信が「失敗」と表示されることがある

Apps Script の Web アプリは、POST に対して
`script.googleusercontent.com` への **302 リダイレクトを返します**。
Stripe はリダイレクトを追わず 3xx を失敗と数えるため
（公式: 「Webhook リクエストへのリダイレクト応答は失敗と見なされます」）、
**処理は成功しているのに Stripe のダッシュボードでは失敗と表示されます**。
本番モードでは連続失敗の警告メールが届き、**9 日で無効化**されます。

その場合の挙動:

- Stripe は同じイベントを再送します（最大3日間）。
- こちらは `stripe_events` シートで受信済みイベントを記録しているため、
  **再送されても二重処理は起きません**（冪等性を自動テストで確認済み）。
- 結果として、利用者の登録は正しく1回だけ行われます。

本番では構成B を選んでください。構成A はテストモードで一時的に動作を見るときだけに使います。

---

### 構成B: 中継を置く（**本番はこちら**）

Cloudflare Workers に薄い中継を置きます。中継が署名を検証し、
**Stripe へ即座に 200 を返してから**、署名をクエリに載せて Apps Script へ転送します
（302 は中継が追います）。

実装はリポジトリの [`workers/stripe-relay/`](workers/stripe-relay/README.md) にあり、
デプロイ手順・Stripe 側の登録・secrets の入れ方はその README §3 にまとめてあります。
要点だけ書くと:

1. `npm run deploy:stripe-relay` で Worker を出す。
2. Stripe（本番モード）に Worker の URL をエンドポイントとして登録し、
   イベントは上の 5 種だけを購読する。署名シークレット（`whsec_...`）を控える。
3. Worker の secrets に `STRIPE_WEBHOOK_SECRET`（2 の値）と
   `GAS_URL_KEY`（Script Properties の `STRIPE_WEBHOOK_URL_KEY` と同じ値）を入れる。
4. Apps Script の Script Properties にも `STRIPE_WEBHOOK_SECRET` を入れる
   （GAS 側でも同じ署名を検証するため。値は 2 と同じ）。
5. 旧エンドポイント（GAS の URL を直接登録したもの）を無効化する。
6. 中継だけが GAS を呼ぶ状態になったら、認証設定シートの
   `STRIPE_WEBHOOK_REQUIRE_SIGNATURE` を `TRUE` にする。

以下は中継の最小形（参考。実際のコードは `workers/stripe-relay/src/index.mjs`）:

```js
/*
 * Stripe → この中継 → Apps Script
 * 署名ヘッダーをクエリへ移し替えるだけ。本文は変更しない。
 * GAS_URL と URL_KEY は Workers の環境変数に置く。
 */
export default {
  async fetch(request, env) {
    if (request.method !== 'POST') {
      return new Response('method not allowed', { status: 405 });
    }

    const signature = request.headers.get('stripe-signature') ?? '';
    const body = await request.text();

    const target = new URL(env.GAS_URL);
    target.searchParams.set('path', 'stripe-webhook');
    target.searchParams.set('k', env.URL_KEY);
    target.searchParams.set('sig', signature);

    const upstream = await fetch(target.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      redirect: 'follow',
    });

    /* Stripe には中継の結果を素直に返す。 */
    return new Response(await upstream.text(), { status: upstream.status });
  },
};
```

この構成では、署名が付いているため Apps Script 側が
HMAC-SHA256 で検証します（`Crypto.gs` の `verifyStripeSignature_`）。
署名が不正なリクエストは、Stripe API への照会に進む前に拒否されます。

中継は署名の転送だけを行い、本文の中身は解釈しません。
中継が壊れても、Apps Script 側の照会による検証（#2）は生きています。

---

## 5. 動作確認

### Checkout

1. `/pricing/` を開く。プランが表示されることを確認する。
2. 「このプランで申し込む」を押す。
3. Stripe の決済画面へ移動する。
4. テストカードで決済する。

```text
カード番号: 4242 4242 4242 4242
有効期限:   任意の将来日（例 12/34）
CVC:        任意の3桁
```

5. `/payment/success/` へ戻る。

### Webhook

Stripe CLI を使うと確認が早くなります。

```bash
stripe login
stripe trigger checkout.session.completed
```

確認する場所:

| 確認先 | 期待する内容 |
| --- | --- |
| Stripe ダッシュボードの Webhook ログ | イベントが送信されている |
| `TSAM AI ユーザー管理` の `stripe_events` シート | `processing_status = processed` の行がある |
| 同 `users` シート | 決済したメールアドレスの行がある（`account_status = pending`） |
| 決済したメールアドレスの受信箱 | パスワード初期設定の案内が届いている |
| 同 `admin_action_logs` シート | `user_created` の記録がある |

### 冪等性

Stripe ダッシュボードの Webhook ログから、同じイベントを「再送信」してください。

- `stripe_events` の行が増えないこと
- `users` の行が増えないこと
- 案内メールが再送されないこと

### 契約の更新・解約・支払失敗

Stripe ダッシュボードで対象のサブスクリプションを操作し、
`users` シートの `subscription_status` が追随することを確認します。

| 操作 | 期待する `subscription_status` |
| --- | --- |
| 支払い成功（`invoice.paid`） | `active` |
| 支払い失敗（`invoice.payment_failed`） | `past_due` |
| 解約（`customer.subscription.deleted`） | `canceled` |
| 試用開始（`customer.subscription.updated`） | `trialing` |

解約後、その利用者がログインできなくなることも確認してください
（`account_status` は `active` のまま。再契約で戻れるようにするため）。

### 不正な署名の拒否

構成Bの場合、`sig` を書き換えたリクエストを送ると
`INVALID_REQUEST` が返り、`stripe_events` に行が作られないことを確認します。

構成Aの場合、`k` を書き換えたリクエストが拒否されることを確認します。

```bash
curl -X POST "https://script.google.com/macros/s/＜デプロイID＞/exec?path=stripe-webhook&k=wrong" \
  -H "Content-Type: application/json" \
  -d '{"id":"evt_test","type":"checkout.session.completed"}'
```

`{"success":false,"error":{"code":"INVALID_REQUEST",...}}` が返ります。

---

## 6. 本番へ切り替える

1. Stripe をライブモードに切り替える。
2. ライブモードで商品と料金を作り直す（テストの Price ID は使えません）。
3. `plans` シートの `stripe_price_id` をライブの値へ更新する。
4. `STRIPE_SECRET_KEY` をライブのシークレットキー（`sk_live_...`）へ更新する。
5. ライブモードで Webhook エンドポイントを作り直す。
   - 構成Bの場合、署名シークレットも新しくなるため `STRIPE_WEBHOOK_SECRET` を更新する。
6. `checkAuthSetup()` を実行して設定を確認する。
7. 実際のカードで1件だけ通し確認を行い、必要なら返金する。

> テストモードとライブモードは、キー・Price ID・Webhook シークレットが
> すべて別です。片方だけ切り替えると決済が通りません。

---

## 処理しているイベント

| イベント | 処理内容 |
| --- | --- |
| `checkout.session.completed` | 利用者を作成（または既存を更新）し、初期設定トークンを発行してメール送信 |
| `customer.subscription.updated` | `subscription_status` を更新 |
| `customer.subscription.deleted` | `subscription_status` を `canceled` に |
| `invoice.paid` | `subscription_status` を `active` に |
| `invoice.payment_failed` | `subscription_status` を `past_due` に |

これ以外のイベントは、受信を記録して無視します（`processing_status = ignored`）。

`checkout.session.completed` でも、`mode` が `subscription` でない、または契約IDの無い
Session は無視します（`ignored`、理由を `error_message` に記録）。同じ Stripe アカウントに
同居する交流会アプリ（一回払い）の決済完了が届いても、参加者を会員として登録しないためです。

### 重複登録の防止

`checkout.session.completed` では、次の順で既存利用者を探します。

1. メールアドレス（正規化後）
2. Stripe の顧客ID（`customer`）
3. Stripe の契約ID（`subscription`）

どれかで見つかれば、新規作成せずに契約情報を更新します。
メールアドレスを変えて再購入されても、同じ顧客IDなら1人として扱います。

パスワードが未設定のまま再購入された場合だけ、案内メールを送り直します。
設定済みの利用者には送りません（アカウント乗っ取りの手口になり得るため）。

---

## トラブルシューティング

| 症状 | 原因と対処 |
| --- | --- |
| プランが表示されない | `plans` シートの `enabled` が `TRUE` か、`stripe_price_id` が入っているか |
| 「決済手続きを開始できませんでした」 | `STRIPE_SECRET_KEY` を確認。`system_error_logs` シートに詳細が残る |
| 「この機能は現在ご利用いただけません」 | `STRIPE_SECRET_KEY` が未設定 |
| Checkout で「No such price」 | テスト／ライブのモード違い、または Price ID の誤り |
| 決済は通ったが利用者が作られない | Webhook が届いていない。Stripe の Webhook ログを確認 |
| Webhook が 302 で失敗表示 | 構成Aの既知の制約。再送で処理される（上記参照） |
| Webhook が `INVALID_REQUEST` | URLの `k` の値、または署名を確認 |
| Webhook が `NOT_CONFIGURED` | `STRIPE_WEBHOOK_URL_KEY` が未設定。`setupAuthSystem()` を実行 |
| 案内メールが届かない | `APP_BASE_URL` 未設定の可能性。[AUTH_SETUP.md](./AUTH_SETUP.md) 手順3 |
| 「アクセスが集中しています」 | `CHECKOUT_HOURLY_LIMIT` に達した。設定シートで調整 |

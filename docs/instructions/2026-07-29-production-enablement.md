# 本番稼働までの残作業

対象: TSAM AI 認証・Portal・Stripe 決済連携（`auth/` `gas-auth/` `login/` ほか）

コードとテストは完成しているが、**外部サービス側の設定が空のため現状では動作しない**。
本書は「誰が・どこで・何をすれば埋まるか」だけを、実行順にまとめたもの。

手順の詳細は既存ドキュメントにあるため、本書は**参照のまとめ**とし、重複を書かない。

| 参照先 | 内容 |
| --- | --- |
| [../../MANUAL_SETUP_CHECKLIST.md](../../MANUAL_SETUP_CHECKLIST.md) | 全作業のチェックリスト（A〜G） |
| [../../AUTH_SETUP.md](../../AUTH_SETUP.md) | Apps Script のセットアップ、Script Properties、設定シート |
| [../../STRIPE_SETUP.md](../../STRIPE_SETUP.md) | Stripe の商品・キー・Webhook |
| [../../DEPLOYMENT.md](../../DEPLOYMENT.md) | 公開構成、デプロイ、ロールバック |
| [../../SECURITY_NOTES.md](../../SECURITY_NOTES.md) | 守れること・守れないこと |

---

## 残作業は3つ

| # | 空いているもの | 埋める人 | 埋める場所 | これが空だとどうなるか |
| --- | --- | --- | --- | --- |
| 1 | Apps Script が未デプロイ | Google アカウント保有者 | script.google.com | API が存在せず、全画面が「この機能は現在ご利用いただけません。」 |
| 2 | `auth/config.js` の `apiUrl` が空 | リポジトリへコミットできる人 | `auth/config.js` | 同上（通信そのものが発生しない） |
| 3 | Stripe が未登録 | Stripe アカウント保有者 | dashboard.stripe.com ＋ 設定シート | 料金プランが表示されず、申し込みできない |

**1 → 2 → 3 の順で埋める。** 2 は 1 の完了後でないと値が決まらない。

---

## 1. Apps Script のデプロイ

**誰が**: Google アカウント（Drive とスプレッドシートを作れる権限）を持つ運用者
**どこで**: <https://script.google.com/>

| 手順 | 参照 |
| --- | --- |
| 新規プロジェクトを作る（既存の `gas/` とは**別プロジェクト**） | AUTH_SETUP.md 手順1 |
| `gas-auth/*.gs` の18ファイルと `appsscript.json` を貼り付ける | gas-auth/README.md |
| `setupAuthSystem()` を実行し、4種類の権限を承認する | AUTH_SETUP.md 手順2 |
| 認証設定シートの `APP_BASE_URL` に `https://tsam-ai.com/` を入力 | AUTH_SETUP.md 手順3 |
| `benchmarkPasswordHashing()` で `PBKDF2_ITERATIONS` を決める | AUTH_SETUP.md 手順9 |
| ウェブアプリとしてデプロイ（実行=自分／アクセス=全員）し `/exec` URL を控える | AUTH_SETUP.md 手順4 |
| `checkAuthSetup()` で設定の抜けを確認 | AUTH_SETUP.md 手順8 |

このとき Drive に `マイドライブ/TSAM AI/Auth/` と3つのスプレッドシートが作られる。
`SESSION_SECRET` `TOKEN_SECRET` `PASSWORD_PEPPER` `STRIPE_WEBHOOK_URL_KEY` も自動生成される。

> **`APP_BASE_URL` が空のままだと、パスワード案内メールが送信されない。**
> URL を組み立てられないため。利用者への応答は変わらないが `system_error_logs` に残る。

> **`PASSWORD_PEPPER` を失うと全利用者がパスワード再設定を強いられる。**
> Script Properties のバックアップを取ること。

---

## 2. `apiUrl` の設定

**誰が**: リポジトリへコミットできる人
**どこで**: [`auth/config.js`](../../auth/config.js) の `AUTH_CONFIG.apiUrl`

手順1で控えた `/exec` URL を貼り、コミットして `main` へ反映する。

```js
export const AUTH_CONFIG = Object.freeze({
  apiUrl: 'https://script.google.com/macros/s/AKfycb.../exec',
  ...
});
```

- **書き換えるのはこの1か所だけ。** HTML や他の JS へ直接書かない
- この値は秘密ではない。コミットしてよい
- `isApiConfigured()` が `https://script.google.com/macros/s/.../exec` の形式のみ受け付けるため、
  誤った値を入れても通信は発生しない

反映後、`/login/` を開いて「この機能は現在ご利用いただけません。」が消えることを確認する。

---

## 3. Stripe の登録

**誰が**: Stripe アカウントの管理権限を持つ人
**どこで**: <https://dashboard.stripe.com/>（テストモードから）＋ 認証設定スプレッドシート

| 手順 | 参照 |
| --- | --- |
| テストモードのシークレットキー（`sk_test_...`）を取得 | STRIPE_SETUP.md 手順2 |
| Script Properties へ `STRIPE_SECRET_KEY` として登録 | STRIPE_SETUP.md 手順2 |
| 商品と料金（継続課金）を作成し Price ID を控える | STRIPE_SETUP.md 手順1 |
| 認証設定シートの `plans` へ登録し `enabled = TRUE` にする | STRIPE_SETUP.md 手順3 |
| Webhook エンドポイントを登録（URL に `?path=stripe-webhook&k=<合言葉>`） | STRIPE_SETUP.md 手順4 |
| テストカードで決済し、利用者作成とメール送信を確認 | STRIPE_SETUP.md 手順5 |
| ライブモードへ切り替え（キー・Price ID・Webhook をすべて作り直す） | STRIPE_SETUP.md 手順6 |

> **Webhook の URL は秘密情報として扱う。** 合言葉が含まれる。
> 漏れた場合は `STRIPE_WEBHOOK_URL_KEY` を変え、Stripe 側の URL も更新する。

> Apps Script が 302 を返すため、Stripe 側で「配信失敗」と表示されることがある。
> 処理自体は成功しており、再送されても冪等性により二重処理は起きない。
> 表示上の失敗が許容できない場合は STRIPE_SETUP.md の構成B（中継）を採る。

---

## 段階的に公開する場合の注意

3つすべてが揃うまで公開しない、という判断が最も安全だが、
段階的に公開する場合は次の状態になる。

| 状態 | `/login/` | `/pricing/` |
| --- | --- | --- |
| 1〜3 すべて未実施 | ログインを試みると「この機能は現在ご利用いただけません。」 | 同じ文言 |
| 1・2 のみ完了（Stripe 未登録） | **既存利用者はログインできる** | 「現在お申し込みいただけるプランがありません。」 |
| すべて完了 | 正常 | 正常 |

**どの状態でも、ログイン画面の「サービスを申し込む」ボタンは常に表示される。**
`/pricing/` へ遷移してから、申し込めないことが分かる導線になっている。

サーバーは `publicConfig` で `checkoutAvailable`（Stripe 設定済みかつ有効プランあり）を
返しているが、**現在どの画面もこの値を使っていない**。
申し込み導線を出し分けたい場合は、この値を参照する実装が別途必要になる。

---

## 公開後に定期的に見る場所

| 頻度 | 確認先 |
| --- | --- |
| 週次 | `TSAM AI 認証ログ` → `system_error_logs`（Webhook・メールの失敗） |
| 週次 | `TSAM AI ユーザー管理` → `stripe_events` に `failed` の行がないか |
| 月次 | `login_logs` の失敗が特定アカウントに集中していないか |
| 随時 | Stripe ダッシュボードの Webhook 配信状況 |

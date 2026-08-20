# Stripe Webhook 配信失敗（2026-08-17〜）の原因と切替手順

**期限: 2026-08-26 06:25 UTC（15:25 JST）。** それまでに切り替えないと、Stripe が
認証システム向けエンドポイントへのイベント送信を停止する。

---

## 1. 何が起きているか

Stripe から「本番エンドポイントへの送信が 2026-08-17 06:25:48 UTC 以降 36 回失敗
（33 件 other errors / 3 件 timeout）」の警告が届いた。対象は Apps Script（`gas-auth`）の
`/exec?path=stripe-webhook&k=…`。

### 原因（確度: 高）

Apps Script の Web アプリは POST に対して `script.googleusercontent.com` への **302** を返す。
Stripe は **3xx を失敗と数え、リダイレクトを追わない**
（公式 docs「Webhook リクエストへのリダイレクト応答は失敗と見なされます」）。

- `gas-auth` のコードに 4xx/5xx や未捕捉例外を返す経路は無い。すべて
  `ContentService` の JSON で終わる（`Response.gs`）。つまり **GAS 側の処理は動いており、
  Stripe から見た応答だけが失敗**になっている。
- この制約は `STRIPE_SETUP.md` に「既知の制約」として以前から書かれていた。
- 警告の内訳に「HTTP ステータスエラー」が 0 件であることも、4xx/5xx ではなく
  リダイレクト系の失敗であることと整合する。

### なぜ 8/17 から

`gas-auth/` の変更は 8/13（`keepAlive()` 追加。Webhook と無関係）が最後で、8/17 前後に変更は無い。
同じ Stripe アカウントで交流会アプリの本番決済が 8/17〜19 に発生しており、
**本番モードのイベントがこのエンドポイントへ初めて配信された時期**と一致する。
Stripe は連続失敗の開始から 9 日で無効化する（8/17 + 9 日 = 8/26 で一致）。

### タイムアウト 3 件

GAS のコールドスタート（実測 35 秒）、`ScriptLock` の最大 20 秒待ち、
Stripe API 照会・シート全件読み・`MailApp` の同期実行が応答前に積み上がるため。
Stripe は決済 1 件で複数イベントを同時に送るので、後続がロック待ちで詰まる。

---

## 2. 対処（このブランチで実装済み）

| 区分 | 内容 | 場所 |
| --- | --- | --- |
| 中継 Worker | 署名検証 → **即 200** → `waitUntil` で GAS へ転送（302 はここで追う） | `workers/stripe-relay/` |
| GAS 防御 | `checkout.session.completed` で `mode≠subscription` / 契約ID無しを `ignored` に（交流会の決済で会員を作らない） | `gas-auth/Webhook.gs` |
| GAS 防御 | 設定 `STRIPE_WEBHOOK_REQUIRE_SIGNATURE=TRUE` で署名無しの要求を拒否 | `gas-auth/Webhook.gs` / `Config.gs` / `Setup.gs` |
| GAS 性能 | 利用者検索を 1 回の読みに、複数セル更新を 1 レンジ書き込みに | `gas-auth/Users.gs` / `Store.gs` |
| テスト | 中継 66 件、GAS 側に 19 件追加（`tests/unit/stripe-relay.mjs` / `tests/unit/stripe.mjs`） | `node tests/run.mjs stripe-relay` / `stripe` |

---

## 3. 切替手順（運用者が行う。順番どおりに）

**Stripe の画面を開くたびに、左上のアカウントが `https://tsam-ai.com/` で本番モードであることを確認する。**

### 3-1. 先に確認しておくこと（5 分）

- [ ] Stripe ダッシュボード → Webhooks → 警告対象エンドポイントの「購読イベント」。
      `checkout.session.completed` を含むか、「すべてのイベント」になっていないか
- [ ] Apps Script → Script Properties → `STRIPE_SECRET_KEY` が `sk_live_` か `sk_test_` か
      （先頭だけ見る。値は控えない）
- [ ] **`TSAM AI ユーザー管理` の `users` シートに、交流会参加者のメールアドレスが
      作られていないか。** 作られていれば、その行は本人へ案内が飛んでいる可能性がある
      （`admin_action_logs` の `user_created` と、`stripe_events` の該当イベントで確認）
- [ ] `stripe_events` シートに 8/17 以降の行があるか（あれば「処理は動いていて応答だけ失敗」の確定）

### 3-2. GAS を貼り替える

[gas-deployment-log.md「未反映の予定: Stripe Webhook 中継対応」](../gas-deployment-log.md) の手順 1〜4。
**「デプロイを管理」からバージョン更新**（新規デプロイを作らない）。

### 3-3. Worker を出し、Stripe を切り替える

[workers/stripe-relay/README.md §3](../../workers/stripe-relay/README.md) の 3-1〜3-5。

```bash
npm run deploy:stripe-relay
npx wrangler secret put STRIPE_WEBHOOK_SECRET --config workers/stripe-relay/wrangler.jsonc
npx wrangler secret put GAS_URL_KEY --config workers/stripe-relay/wrangler.jsonc
curl -s https://stripe-relay.<subdomain>.workers.dev/health   # missing が [] になること
```

> `wrangler secret put` は PowerShell で貼り付けに失敗しても Success と出る
> （2026-08-20 のシークレットローテーションで実際に起きた）。`/health` で必ず確認する。

### 3-4. 確認

- [ ] Stripe の新エンドポイントでテストイベント送信 → **200**
- [ ] 8/17 以降に失敗したイベントを Stripe から「再送」→ 200。`stripe_events` に
      `duplicate` か `processed` が増える（二重処理はしない）
- [ ] `system_error_logs` に `署名検証に失敗` が無い
- [ ] 旧エンドポイント（GAS URL 直接）を無効化。警告メールが止まる

### 3-5. 仕上げ

- [ ] 認証設定シート `STRIPE_WEBHOOK_REQUIRE_SIGNATURE` を `TRUE`
- [ ] `docs/gas-deployment-log.md` の反映履歴へ追記（Claude に報告）

---

## 4. 戻し方

- Stripe のエンドポイント URL を GAS の URL に戻せば旧構成に戻る（302 の失敗表示は再発する）
- GAS 側は `STRIPE_WEBHOOK_REQUIRE_SIGNATURE=FALSE` で署名無しを再び受け付ける
- Worker は `wrangler delete --config workers/stripe-relay/wrangler.jsonc` で消せる

---

## 5. やっていないこと（判断が要るもの）

- Stripe ダッシュボード・Apps Script 管理画面・Cloudflare への操作（すべて認証済み操作のため、
  運用者または Codex 境界で行う）
- `users` シートに交流会参加者が誤登録されていた場合の後始末（該当があれば個別に判断）
- GAS 側の「受信記録だけして即返し、時間主導トリガーで処理」への分離（中継で応答は
  解決するため今回は見送り）

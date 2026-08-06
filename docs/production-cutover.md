# 本番切替チェックリスト

> ## ⚠️ この文書は現行構成を記していない
>
> **これは 2026-08-01 に行った「GitHub Pages → Vercel」切替の記録である。**
> その後さらに移行が起きており、**現在は Cloudflare（OpenNext）で配信されている。**
>
> 実環境の応答ヘッダーで確認した根拠（2026-08-06）:
>
> ```
> Server: cloudflare
> CF-RAY: ...
> CF-Cache-Status: HIT      ← Cloudflare のプロキシを通っている
> x-opennext: 1             ← OpenNext。Vercel は出さない
> x-powered-by: Next.js
> （x-vercel-id / x-vercel-cache は、静的パス・Next.js ルート・404 のいずれにも無い）
> ```
>
> したがって、この文書のうち **Vercel を前提にした記述（手順2・3、DNS の値
> `76.76.21.21` / `cname.vercel-dns.com`、「プロキシを DNS only にする」）は、
> 現在の状態と一致しない。** 実際、プロキシはオンになっている。
>
> **`main` へのマージが公開につながる点は変わらない**（`main` にしか無いファイルが
> 本番で 200 を返すことで確認済み）。ただしその実行主体は Vercel ではなく、
> ビルドと公開の設定は**リポジトリ内に無い**（`wrangler.*` / `open-next.config.*` /
> `vercel.json` はどのブランチにも存在しない）。Cloudflare のダッシュボード側にある。
>
> **現行構成の詳細は追って文書化する。** それまで、切り戻しやデプロイの操作を
> この文書の手順で行わないこと（ダッシュボードの画面が異なる）。
> 関連: [DEPLOYMENT.md](../DEPLOYMENT.md) も Vercel 前提のままで、同じく陳腐化している。

交流会申込アプリを本番公開するときの手順。**上から順に実行する。**

すべての操作は事業者側で行う。各手順に「戻し方」を書いてある。

---

## ✅ 本番切替は完了している（2026-08-01）

**全8手順を完走し、受付を開始済み。** 以下は実施記録として残す。
次回のイベントや、同じ構成で別のサイトを立てるときの手順書として使える。

| 手順 | 状態 |
| --- | --- |
| 1. main へのマージ | ✅ 完了 |
| 2. Vercel に本番ドメインを登録 | ✅ 完了 |
| 3. DNS の切り替え | ✅ 完了 |
| 4. 切替の確認（Pages無効化・wwwリダイレクト含む） | ✅ 完了 |
| 5. 本番 Webhook エンドポイントの登録 | ✅ 完了 |
| 6. 本番キーへの切り替え・領収書メールの有効化 | ✅ 完了 |
| 7. 受付の開始 | ✅ 完了 |
| 8. 本番での動作確認（実決済テスト） | ✅ 完了 |

### 現在の状態

* `https://tsam-ai.com/` は Vercel から配信（GitHub Pages は無効化済み）
* `https://tsam-ai.com/event/` は**受付中**（`data-event-status="open"` /
  `APPLY_URL='/event/apply/'` / `events.is_published=true`）
* Stripe は**本番キー**。Webhook は `https://tsam-ai.com/event/api/stripe/webhook/`
* 受入条件12項目すべて合格（`docs/event-acceptance.md`）

### 受付を閉じるとき

1. `public/event/index.html` の `data-event-status` を `closed`（受付期間の終了）
   または `full`（申込状況による受付終了）にして push する（デプロイに1〜2分）
2. `events.is_published` を `false` にする（即時。サーバー側の受付判定はこちら）

**急いで止めるときは 2 を先に行う。** 2だけで新規の申し込みは保存されなくなる
（すでに決済済みのものには影響しない）。1はページの見た目を合わせるための操作。

---

## ⚠️ Stripe を操作する前に毎回確認すること

**このダッシュボードには複数のアカウントとサンドボックスがある。**
確認したところ、少なくとも次の2つのアカウントが存在する。

* `haruka-muridae.github.io`
* `tsam-ai.com` ← **交流会で使うのはこちら**

さらに、それぞれにサンドボックス（テスト環境）が複数ある。

**Stripe の画面を開いたら、操作を始める前に必ず画面左上のアカウント名を見て、
`https://tsam-ai.com/` になっていることを確認する。**
違っていれば、左上のアカウント切替から選び直す。

別のアカウントで設定してしまうと、次のような分かりにくい失敗になる。

* Webhookを別アカウントに登録 → 決済は成立するのに「支払済み」にならない
* キーを別アカウントのものにする → 決済画面で認証に失敗する
* 領収書メールを別アカウントで有効化 → 設定したのに届かない

以下の手順では、Stripeを触るステップの冒頭に同じ確認を再掲している。

---

## 事前の確認（切替日より前に済ませておく）✅ 完了（2026-08-01）

- [x] **DNSのTTLを短縮する**（切替の24時間以上前）
  Cloudflare で `tsam-ai.com` の A レコード4件と `www` の CNAME の TTL を
  **300秒（5分）以下**にする。すでに300秒であれば操作不要。
  → 4件とも TTL=300 だったため、**操作は不要だった**。

- [x] **Stripe 本番アカウントの明細書表記プレフィックスを確認する**
  **▶ 先に左上のアカウントが `https://tsam-ai.com/` であることを確認する**
  <https://dashboard.stripe.com/settings/public>
  カード明細は「プレフィックス* 参加費」の形になる。サフィックス（参加費 /
  ｻﾝｶﾋ / EVENT）はコード側で指定済み。

> **領収書メールの有効化は、後述の「6. 本番の Stripe キーへ切り替え」に置いた。**
> テスト環境（サンドボックス）ではこの設定が変更できず、送信の確認も
> できないため、本番キーへ切り替える工程でまとめて行う。

---

## 1. main へのマージ ✅ 完了（2026-08-01）

> マージコミット `2c228ab`。コンフリクトは想定どおり `auth/keystore.js` の1件のみで、
> `public/auth/keystore.js` へ移して解消した。あわせて
> `tests/unit/frontend.mjs` の import パスを `public/` 経由へ直した。
> `npm run build` と `npm test`（1445件）が通ることを確認済み。
> **`feat/vercel-migration` ブランチはローカル・リモートとも削除済み。以後の作業は main に一本化する。**

**⚠️ この手順を実行すると、DNSを切り替えるまでの間 `tsam-ai.com` が壊れる。**
GitHub Pages はリポジトリのルートを配信するが、`feat/vercel-migration` では
静的サイト一式を `public/` へ移しているため、マージした瞬間に `/`・`/apps/`・
`/legal/` などが404になる。**マージは切替当日、DNS切替の直前に行う。**

### 1-1. コンフリクトの状況（2026-08-01 時点）

`main` は分岐後に16コミット進んでいる。マージ時のコンフリクトは**1件だけ**。

| 種別 | 内容 | 解消方法 |
| --- | --- | --- |
| ファイルの位置 | `auth/keystore.js` が `main` で新規追加された。`feat/vercel-migration` では `auth/` を `public/auth/` へ移動済み | `public/auth/keystore.js` として配置する |

`main` が変更した既存ファイル（`auth/auth.css` / `index.html` /
`portal/index.html` / `portal/portal.js`）は、Git が移動を追跡するため
`public/` 側へ自動で反映される。

### 1-2. 手順

```bash
git switch main
git pull
git merge feat/vercel-migration
# → auth/keystore.js の位置についてコンフリクトが出る
git mv auth/keystore.js public/auth/keystore.js   # 位置を直す
git add -A
git commit
npm run build        # 通ること
npm test             # 通ること
git push origin main
```

マージ前に、あらためてコンフリクトだけを確認したい場合:

```bash
git fetch origin
git merge-tree --write-tree origin/main feat/vercel-migration | grep CONFLICT
```

**戻し方**: push 前なら `git merge --abort`。push 後は `git revert -m 1 <マージのコミット>`。

---

## 2. Vercel に本番ドメインを登録する ✅ 完了（2026-08-01）

<https://vercel.com/architect-3362s-projects/ts-corporate-renewal/settings/domains>

- [x] `tsam-ai.com` を追加する
- [x] `www.tsam-ai.com` を追加する（`tsam-ai.com` へのリダイレクトを選ぶ）

追加すると、Vercel が**設定すべきDNSレコードの値を画面に表示する**。
次の手順ではその表示値を使う。下の「想定値」と食い違う場合は、
**Vercelの画面に出た値を優先する**。

この時点ではまだDNSを変えていないため、`tsam-ai.com` は現行サイトのまま。
Vercel の画面上は「Invalid Configuration」と表示されるが、正常。

**戻し方**: ドメインを削除する。現行サイトには影響しない。

---

## 3. DNS の切り替え（Cloudflare） ✅ 完了（2026-08-01）

DNSは **Cloudflare** で管理されている（ネームサーバー: `alexia.ns.cloudflare.com` /
`ernest.ns.cloudflare.com`）。

<https://dash.cloudflare.com/> → `tsam-ai.com` → **DNS** → **Records**

### Before（現在。GitHub Pages 向け）

| 種別 | 名前 | 値 | TTL |
| --- | --- | --- | --- |
| A | `tsam-ai.com`（`@`） | `185.199.108.153` | 300 |
| A | `tsam-ai.com`（`@`） | `185.199.109.153` | 300 |
| A | `tsam-ai.com`（`@`） | `185.199.110.153` | 300 |
| A | `tsam-ai.com`（`@`） | `185.199.111.153` | 300 |
| CNAME | `www` | `haruka-muridae.github.io` | 300 |

### After（Vercel 向け）

| 種別 | 名前 | 値 | TTL | プロキシ |
| --- | --- | --- | --- | --- |
| A | `tsam-ai.com`（`@`） | `76.76.21.21` | Auto | **DNS only（グレーの雲）** |
| CNAME | `www` | `cname.vercel-dns.com` | Auto | **DNS only（グレーの雲）** |

### 操作

- [x] **A レコード4件をすべて削除**する（185.199.x.153）
- [x] **A レコードを1件追加**する: 名前 `@` / 値 `76.76.21.21`
- [x] **`www` の CNAME を編集**し、値を `cname.vercel-dns.com` に変える
- [x] 追加・変更した2件とも、**プロキシを「DNS only」（グレーの雲）にする**

> **プロキシをオンにしない理由**: Cloudflareのプロキシ（オレンジの雲）を通すと、
> VercelのTLS証明書の発行と自動更新が失敗することがある。Vercel側で証明書を
> 扱わせるため、DNS only にする。

> **値の確認**: `76.76.21.21` と `cname.vercel-dns.com` は Vercel の標準値。
> 手順2でVercelの画面に表示された値と必ず突き合わせること。

**戻し方**: 上の Before の表のとおりに戻す。TTLが300秒のため、
数分で現行サイトへ戻る。

---

## 4. 切替の確認 ✅ 完了（2026-08-01）

- [x] `https://tsam-ai.com/` が現行のコーポレートサイトとして表示される
- [x] `https://tsam-ai.com/apps/` が表示される
- [x] `https://tsam-ai.com/legal/tokusho/` が表示される
- [x] `https://tsam-ai.com/login/` `https://tsam-ai.com/portal/` が表示される
- [x] `https://tsam-ai.com/event/` が交流会の詳細ページとして表示される
- [x] `https://tsam-ai.com/event/legal.html` が表示される
- [x] `https://tsam-ai.com/event/admin/login/` が表示される
- [x] 応答ヘッダーの `Server` が `Vercel` になっている
      （`curl -sI https://tsam-ai.com/ | findstr /i server`）

> 全21パスで200を確認。TLS証明書の検証も正常（`ssl_verify_result=0`）。
> 配信は `X-Vercel-Id: hnd1`（東京リージョン）。
> DNSは 8.8.8.8 と 1.1.1.1 の両方で新しい値に反映済み。

証明書の発行に数分かかることがある。その間は接続エラーになる。

- [x] **GitHub Pages を無効にする**（切替が安定してから）
  <https://github.com/Haruka-muridae/ts-corporate-renewal/settings/pages>
  Custom domain を削除し、Unpublish した（2026-08-01）。
  あわせてリポジトリのルートから `CNAME` も削除済み。

- [x] **`www` を apex へのリダイレクトにする**
  <https://vercel.com/architect-3362s-projects/ts-corporate-renewal/settings/domains>
  `https://www.tsam-ai.com/` → 308 → `https://tsam-ai.com/` を確認（2026-08-01）。
  配下のパス（`/event/` など）も追従する。

---

## 5. 本番 Webhook エンドポイントの登録（Stripe） ✅ 完了（2026-08-01）

**▶ 先に画面左上のアカウントが `https://tsam-ai.com/` であることを確認する。**
アカウントが複数あり、別のアカウントに登録すると通知が届かない。

<https://dashboard.stripe.com/webhooks>（**本番モード**であることを確認。
テスト/本番の切替は画面右上）

- [x] 左上のアカウント名が `https://tsam-ai.com/` である
- [x] 画面が**本番モード**である（テストモードの表示が出ていない）
- [x] **Add endpoint** を押す
- [x] **Endpoint URL** に次を入力する

```
https://tsam-ai.com/event/api/stripe/webhook/
```

> **⚠️ 末尾のスラッシュは必須。**
> スラッシュ無しのURLに送られると308リダイレクトになり、Stripeは
> リダイレクトを追わないため通知が届かない。決済は成立するのに
> 「支払済み」にならず、受付番号も参加確定メールも出ない状態になる。

- [x] **Select events** で次の**5種類だけ**を選ぶ

```
checkout.session.completed
checkout.session.async_payment_succeeded
checkout.session.async_payment_failed
checkout.session.expired
charge.refunded
```

- [x] 作成後、**Signing secret**（`whsec_` で始まる値）を表示して控える

### 5-1. Vercel へ登録

<https://vercel.com/architect-3362s-projects/ts-corporate-renewal/settings/environment-variables>

- [x] `STRIPE_WEBHOOK_SECRET` を新規追加し、上で控えた `whsec_…` を貼る
- [x] 環境は **Production / Preview / Development** の3つにチェック
- [x] **貼り付け時に前後の空白や改行が入らないよう注意**
      （BOMや空白はアプリ側で除去するようにしてあるが、混入させないに越したことはない）

> ローカル開発で使う `stripe listen` の `whsec_…` とは**別の値**。
> 取り違えると署名検証に失敗し、通知がすべて拒否される。

### 5-2. 署名検証の稼働確認 ✅ 完了（2026-08-01）

環境変数を登録したあと、**必ず再デプロイする**（環境変数は既存のデプロイに
反映されない）。反映されると、署名の無いPOSTへの応答が
`500 not configured` から `400 invalid signature` に変わる。

偽の「支払済み」通知を8パターン送り、すべて400で拒否されることを確認済み。

| 送ったもの | 応答 |
| --- | --- |
| 署名ヘッダーなし / 空 | 400 |
| 時刻だけ / 署名だけ | 400 |
| でたらめな署名 / 長さは正しいが値が違う署名 | 400 |
| **別のシークレットで正しく署名** | 400 |
| **古い時刻（リプレイ）** | 400 |
| GETでのアクセス | 405（POST専用として正しい） |

エンドポイントのURLを知られても、偽の通知で「支払済み」にはできない。

正常系（正しい署名で200）は本番の実決済でのみ確認できる。手順8で確認する。

---

## 6. 本番の Stripe キーへ切り替え・領収書メールの有効化 ✅ 完了（2026-08-01）

**▶ 先に画面左上のアカウントが `https://tsam-ai.com/` であることを確認する。**

### 6-1. 領収書メールを有効にする

<https://dashboard.stripe.com/settings/emails>（**本番モード**）

- [x] 左上のアカウント名が `https://tsam-ai.com/` である
- [x] **Customer emails** の **Successful payments** を**オン**にする

> **テスト環境では確認できない。**
> サンドボックスではこの設定がグレーアウトして変更できず、
> 決済詳細からの手動送信（`receipt_email` の再設定）でも領収書は送られない。
> 未返金の請求でも `receipt_number` が採番されないことを確認済み。
> したがって、**領収書メールが実際に届くことの確認は、この工程と
> 「8. 本番での動作確認」の実決済でのみ行える**。
>
> アプリ側の準備（Checkout Session に `customer_email` を渡す）は完了している。
> コードの変更は不要で、この設定だけで送信されるようになる。

### 6-2. キーを差し替える

<https://dashboard.stripe.com/apikeys>（**本番モード**）

- [x] 左上のアカウント名が `https://tsam-ai.com/` である
- [x] `STRIPE_SECRET_KEY` を本番の `sk_live_…` に更新
- [x] `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` を本番の `pk_live_…` に更新
- [x] `NEXT_PUBLIC_BASE_URL` を `https://tsam-ai.com/event` に更新

いずれも Vercel の環境変数画面で行う。3環境すべてに設定する。

- [x] **環境変数を変えたら再デプロイする**
      （環境変数は既存のデプロイには反映されない）
      Deployments → 最新のデプロイ → **Redeploy**

---

## 7. 受付の開始 ✅ 完了（2026-08-01）

ここまでで仕組みは動く状態になる。受付を開けるのは最後。

- [x] **申込フォームへの導線を有効にする**
      `public/event/script.js` の `APPLY_URL` を `/event/apply/` にする
- [x] **受付状態を「受付中」にする**
      `public/event/index.html` の `data-event-status` を `open` にする
- [x] **イベントを公開する**
      Supabase の `events` テーブルで、対象イベントの `is_published` を `true` にする
      <https://supabase.com/dashboard/project/ixxxlmfhrtommsfiumlz/editor>
- [x] 変更をコミットして push（Vercelが自動デプロイする）

### 受付を閉じるとき

`public/event/index.html` の `data-event-status` を `closed`（受付期間の終了）
または `full`（申込状況による受付終了）にして push する。

---

## 8. 本番での動作確認 ✅ 完了（2026-08-01）

**▶ Stripeを見るときは、左上のアカウントが `https://tsam-ai.com/` であることを確認する。**

実際のお金が動く。金額の小さいイベントを別に用意するのではなく、
本番のイベントで1件申し込み、確認後に返金する。

- [x] `https://tsam-ai.com/event/` から申し込み、**実際のカードで1件決済する**
- [x] 受付番号が表示される
- [x] 参加確定メールが届く
- [x] **Stripeの領収書メールが届く（受入条件6の最終確認。ここでしか確認できない）**
      届かない場合は 6-1 の設定を見直す。Stripeダッシュボードの
      該当の支払い詳細で `receipt_number` が採番されているかも確認できる
- [x] 管理画面（`https://tsam-ai.com/event/admin/`）に申込が並ぶ
- [x] Stripeダッシュボードから**その1件を返金**し、管理画面のステータスが
      「返金済み（例外対応）」になる
- [x] 管理画面から申込を削除するか、テストと分かるメモを残す

### 実施結果（2026-08-01）

**3Dセキュアを含む決済**が成立し、全項目が確認できた。
Webhook の記録も想定どおり2件だけ残った。

```
checkout.session.completed  → 支払済みに更新（受付番号 TSAM-0001）／メール送信済み
charge.refunded             → 返金済み（例外対応）に更新しました
```

領収書メールは**着信までに遅延があった**が届いた。すぐ来ないことがあるため、
届かないと判断する前に数分待つこと。

### テスト申込のデータ

**記録として残す判断とした**（事業者判断、2026-08-01）。削除していない。

| 受付番号 | 状態 | 内容 |
| --- | --- | --- |
| （未発行） | `awaiting` | 決済へ進んだが完了しなかったもの。支払は発生していない |
| `TSAM-0001` | `refunded` | 実決済テスト。3,300円を決済し全額返金済み |

**次の申込者の受付番号は `TSAM-0002` から始まる。**
名札印刷用CSVは支払済み（`paid`）のみを対象にしているため、
返金済みのこの1件は自動的に除外される。当日の名簿に混ざる心配はない。

---

## 想定される不具合と切り分け

| 症状 | 最初に見るところ |
| --- | --- |
| 決済は成立するが「支払済み」にならない | Webhookの登録URLの**末尾スラッシュ**。次に、登録先が `https://tsam-ai.com/` のアカウントか。Stripeダッシュボードの該当エンドポイントで配信履歴を見る |
| Webhookが401/400で失敗する | `STRIPE_WEBHOOK_SECRET` の取り違え（ローカル用と本番用） |
| 決済画面で認証に失敗する | キーが別アカウントのものになっていないか（左上のアカウント名） |
| 領収書メールが届かない | 6-1の設定。テスト環境では設定自体ができないため、本番でのみ確認できる |
| 管理画面にログインできない | 環境変数の値に空白やBOMが混ざっていないか。画面に「設定に問題がある可能性があります」と出た場合は設定側 |
| 参加確定メールが届かない | 管理画面の申込者詳細から再送できる。`GMAIL_REFRESH_TOKEN` の失効も疑う |
| サイト全体が404 | DNSの切替とmainへのマージの順序。マージ済みでDNS未切替だとこの状態になる |

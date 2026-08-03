# デプロイ手順

TSAM AI コーポレートサイト、本番認証システム、交流会申込アプリの公開手順。

---

## 現在の公開構成

```text
GitHub リポジトリ（main ブランチ）
        │
        ▼  Vercel（Next.js。push で自動ビルド・自動デプロイ）
https://tsam-ai.com/
```

**2026年8月1日に GitHub Pages から Vercel へ切り替えました**
（実施記録: [docs/production-cutover.md](docs/production-cutover.md)）。
GitHub Pages は無効化済みで、リポジトリのルートに `CNAME` はありません。
`www.tsam-ai.com` は Vercel の設定で apex へ308リダイレクトします。

切替の理由は、交流会申込アプリが Stripe の Webhook 受信と Checkout Session の作成に
サーバー側の実行環境を必要とするためです。静的配信では動きません。

### 配信されるもの

`public/` 配下はビルドされず、そのままのパスで配信されます。

| パス | 実体 |
| --- | --- |
| `/` | コーポレートサイト（`public/index.html`） |
| `/css/` `/js/` `/assets/` | コーポレートサイトの資産 |
| `/apps/` | **テスト環境**（`public/apps/`） |
| `/login/` `/pricing/` `/portal/` `/logout/` | 本番認証系（`public/login/` など） |
| `/password/setup/` `/password/reset/` | 同上 |
| `/payment/success/` `/payment/cancel/` | 同上 |
| `/auth/` | 本番認証系の共通JS・CSS |
| `/legal/` | 法務ページ（生成物。直接編集しない） |
| `/event/` `/event/legal.html` | 交流会の詳細ページ（静的のまま） |
| `/potenitas/` | Potenitas LP |
| `/event/apply/` `/event/admin/` `/event/api/` | **Next.js のルート**（`app/event/`） |

### 配信されないもの

| パス | 理由 |
| --- | --- |
| `/gas-auth/` | Apps Script のソース。手動でコピーする（下記） |
| `/tests/` | テストコード |
| `/app/` `/lib/` `/supabase/` | ソース。ビルドされた結果が `/event/...` として配信される |
| `/lp-draft/` `/components/` `/content/` `/types/` `/potenitas-lp/` | 未公開のLP用 |
| `/docs/` | 設計ドキュメント |

> GitHub Pages の時代と違い、`public/` の外にあるファイルは
> **公開URLからは読めません**（`/docs/...` は404）。
> 一方、`public/apps/tests/` のように `public/` の中にあるものは、
> テストコードであっても **URLを直接叩けば読めます。**
> どちらにせよリポジトリ自体は GitHub にあります。
> **秘密情報を入れないこと**（Script Properties と Vercel の環境変数に置く運用です）。

---

## Next.js について（重要）

**Next.js が配信の本体です。** `public/` の静的ファイルは Next.js が配信し、
`app/event/` 配下のページ・サーバーアクション・ルートハンドラが動的な部分を担います。

構成上、次の2点は変更する前に [next.config.ts](next.config.ts) 冒頭のコメントと
[docs/vercel-migration.md](docs/vercel-migration.md) を読んでください。
どちらも実際に事故を起こした結果、こうしてあります。

- **`basePath` を使わない。** `basePath: "/event"` は `public/` 配下の静的ファイルにも
  効くため、ルート（`/`）が404になります。
- **rewrites は `fallback` で返す。** `afterFiles` にするとルートハンドラより先に
  評価され、`/event/api/...` が `index.html` への書き換えに飲まれて404になります。

`.github/workflows/nextjs.yml.disabled` は GitHub Pages 時代の名残です。
**有効化しないでください。** Pages への公開を再開させるもので、現在の構成とは両立しません。

---

## デプロイ

特別な操作はありません。`main` へマージすれば、Vercel が自動でビルドして
1〜2分で反映されます。**マージはそのまま本番公開です。**

Pull Request を作るとプレビューURLが発行されます。本番へ入れる前の確認に使えます。

> **環境変数を変えたときは再デプロイが必要です。**
> 既存のデプロイには反映されません（Deployments → 最新のデプロイ → Redeploy）。

### 公開前の確認

```bash
npm run build            # ビルドが通ること
npm run typecheck        # 型エラーが無いこと
npm run lint             # 追加分に警告が無いこと
npm test                 # /apps/ 分と、本番認証系・交流会アプリの両方
```

`npm run lint` は `public/apps/` 配下の既存ファイル（ベンダーバンドルやビルド済み成果物を
含む）由来のエラーを多数報告します。移行前からの状態で、CI が実行するのは `npm test` だけです。
**自分が触った範囲に新しい警告を足さないこと**を基準にしてください。

`npm test` は Chrome を起動します。
見つからない場合は環境変数 `CHROME_PATH` を設定してください。

### ローカルでの確認

```bash
npm run dev
```

<http://localhost:3000/login/> や <http://localhost:3000/event/apply/> を開きます。

- 本番と同じく、`public/` の静的ファイルと Next.js のルートが同居した状態になります。
- `file://` では ES モジュールが読めません。必ず HTTP サーバー経由で開いてください。
- API を呼ぶ操作は、`public/auth/config.js` の `apiUrl` が設定済みでないと
  「この機能は現在ご利用いただけません。」で止まります（想定どおりの挙動です）。
- 交流会アプリは `.env.local` の環境変数が必要です（下記）。
  Stripe の Webhook をローカルで受けるには次を使います。

```bash
stripe listen --forward-to http://127.0.0.1:3000/event/api/stripe/webhook/
```

### HTTPS・ドメイン

証明書は Vercel が発行・更新します。リポジトリ側の設定はありません。

DNS は Cloudflare で管理しています。`tsam-ai.com` の A レコード（`76.76.21.21`）と
`www` の CNAME（`cname.vercel-dns.com`）は、いずれも **プロキシを「DNS only」**に
してあります。オレンジの雲を通すと Vercel の証明書の発行・更新が失敗することがあります。

---

## Apps Script のデプロイ

### 初回

[AUTH_SETUP.md](./AUTH_SETUP.md) の手順1〜5を参照してください。要点のみ:

1. スタンドアロンの Apps Script プロジェクトを作る
   （`/apps/` が使っているものとは **別プロジェクト**）
2. `gas-auth/*.gs` を貼り付ける（拡張子を除いた名前で）
3. `appsscript.json` を差し替える
4. `setupAuthSystem()` を実行して権限を承認する
5. 「デプロイ」→「新しいデプロイ」→ ウェブアプリ
   - 実行するユーザー: **自分**
   - アクセスできるユーザー: **全員**
6. `/exec` URL を `public/auth/config.js` の `apiUrl` へ貼る

### 更新するとき

コードを直したら、必ず **デプロイし直す**必要があります。
エディタで保存しただけでは、公開中の Web アプリには反映されません。

```text
デプロイ → デプロイを管理 → 既存のデプロイの「編集」（鉛筆アイコン）
       → バージョン「新バージョン」 → デプロイ
```

**「新しいデプロイ」ではなく「デプロイを管理」から既存を編集してください。**
新規に作ると `/exec` URL が変わり、以下の更新が必要になります。

- `public/auth/config.js` の `apiUrl`
- Stripe の Webhook エンドポイントURL（本番認証系のもの。
  交流会アプリの Webhook は Vercel 側で受けるため無関係です）

### clasp を使う場合

```bash
cd gas-auth
clasp push
clasp deploy --deploymentId <既存のデプロイID> --description "v2"
```

---

## リリース手順（推奨）

1. 作業ブランチで実装する
2. `npm run build` と `npm test` が全件成功することを確認する
3. Pull Request を作り、**Vercel のプレビューURLで確認する**
4. Apps Script を変更した場合は更新し、既存デプロイを新バージョンへ更新する
5. `checkAuthSetup()` で設定を点検する
6. ステージング相当の確認
   - Stripe をテストモードのままにして、通し確認を行う
   - 管理者アカウントでログイン・ログアウトを確認する
7. `main` へマージする（force push しない）。マージした時点で本番へ出ます
8. 1〜2分後、本番URLで確認する
   - `/` が表示される
   - `/login/` が表示され、`/portal/` が未ログインで `/login/` へ戻る
   - `/apps/` が従来どおり動く（回帰確認）
   - `/event/` と `/event/apply/` が表示される
9. Stripe をライブモードへ切り替える（[STRIPE_SETUP.md](./STRIPE_SETUP.md) 手順6）

---

## ロールバック

### サイト（Vercel）

**急ぐときは Vercel の Deployments 画面から、直前の正常な本番デプロイを
本番へ昇格させます。**リポジトリを触らずに戻せます。

コード側を直すときは、`main` を1つ前のコミットへ戻します（revert コミットを作る）。
**force push は行わないでください。**

```bash
git revert <コミットハッシュ>
git push origin main
```

> デプロイを戻しても、**Supabase のデータと環境変数は戻りません。**
> スキーマを変えるマイグレーションを適用したあとにコードだけ戻すと、
> 食い違ったまま動くことになります。

### Apps Script

「デプロイを管理」から、以前のバージョンを選び直します。

```text
デプロイ → デプロイを管理 → 編集 → バージョン「＜以前の番号＞」 → デプロイ
```

URL は変わらないため、フロント側の変更は不要です。

> **`setupAuthSystem()` が作ったデータは戻りません。**
> コードを戻しても、スプレッドシートの行やシークレットはそのままです。
> シークレットを変更した場合は元の値へ戻さないと、
> 既存のパスワード・セッションが無効になります。

---

## 環境変数・設定の一覧

### リポジトリ

| ファイル | 設定するもの |
| --- | --- |
| `public/auth/config.js` | Apps Script Web アプリの `/exec` URL |
| `.env.example` | 退避中のリニューアル版LP用（`lp-draft/`）。交流会アプリは使いません |

公開ドメインはリポジトリではなく Vercel 側の設定です（`CNAME` は削除済み）。

### Vercel（環境変数）

交流会申込アプリが使います。**Production / Preview / Development の3環境すべてに
登録し、変更したら再デプロイします。** ローカルは `.env.local` に同じものを置きます。

| 変数名 | 用途 |
| --- | --- |
| `STRIPE_SECRET_KEY` | Checkout Session の作成（本番は `sk_live_…`） |
| `STRIPE_WEBHOOK_SECRET` | Webhook の署名検証。**`stripe listen` が出すローカル用とは別の値** |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | 決済画面（本番は `pk_live_…`） |
| `SUPABASE_URL` | Supabase プロジェクト（`tsam-event`）のURL |
| `SUPABASE_ANON_KEY` | 管理画面のログイン（Supabase Auth） |
| `SUPABASE_SERVICE_ROLE_KEY` | 申込の読み書き。**`NEXT_PUBLIC_` を付けない**（付けるとブラウザへ配信される） |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GMAIL_REFRESH_TOKEN` / `MAIL_FROM` | 参加確定メールの送信（[docs/gmail-setup.md](docs/gmail-setup.md)） |
| `NEXT_PUBLIC_BASE_URL` | 決済後の戻り先の土台（本番: `https://tsam-ai.com/event`） |

値の前後に空白や改行、BOM を混ぜないこと。アプリ側で除去していますが
（[lib/event/config.mjs](lib/event/config.mjs)）、混入させないに越したことはありません。

### Apps Script（Script Properties）

[AUTH_SETUP.md](./AUTH_SETUP.md) の「Script Properties 一覧」を参照。

### 認証設定スプレッドシート

[AUTH_SETUP.md](./AUTH_SETUP.md) の「認証設定シートの一覧」を参照。

---

## 同居している3つの系の分離

Vercel への移行でファイルの位置は `public/` 配下へ動きましたが、
**それぞれが独立している点は変わりません。** 片方の都合でもう片方を変えないでください。

| | `/apps/`（テスト環境） | 本番認証系 | 交流会申込アプリ |
| --- | --- | --- | --- |
| 認証 | Supabase（未接続）＋ダミー | Apps Script + スプレッドシート | Supabase Auth（管理画面のみ） |
| セッションキー | `tsam-ai-session` | `tsam-auth-session` | Cookie `tsam-event-admin` |
| バックエンド | Apps Script（このリポジトリには無い） | `gas-auth/` | Next.js サーバー（`app/event/`） |
| 共通JS | `public/apps/shared/` | `public/auth/` | `lib/event/` |
| テスト | `public/apps/tests/` | `tests/` | `tests/`（`event-*`） |

セッションの保存キーが違うため、片方にログインしても
もう片方には影響しません。

---

## 監視

現時点で自動監視はありません。以下を定期的に目視してください。

| 確認先 | 見るもの |
| --- | --- |
| Vercel → Deployments | ビルドの失敗（失敗したデプロイは本番へ出ません） |
| Vercel → Logs（Functions） | サーバーアクション・Webhook の実行時エラー |
| Stripe ダッシュボード → Webhook | 配信の失敗。決済は成立するのに「支払済み」にならない場合はここ |
| Supabase → `webhook_events` | 処理できなかったイベント |
| `TSAM AI 認証ログ` → `system_error_logs` | 本番認証系の Webhook の失敗、メール送信の失敗 |
| `TSAM AI ユーザー管理` → `stripe_events` | `processing_status` が `failed` の行 |
| Apps Script → 実行数 | エラー率の上昇 |

Apps Script の実行が失敗した場合、
プロジェクト所有者宛にGoogleから通知メールが届きます。

症状からの切り分け表は
[docs/production-cutover.md](docs/production-cutover.md) の末尾にあります。

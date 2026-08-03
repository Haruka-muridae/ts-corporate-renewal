# デプロイ手順

TSAM AI コーポレートサイトと、本番認証システムの公開手順。

---

## 現在の公開構成

```text
GitHub リポジトリ
        │
        ├─ main への push        ──▶ Vercel ──▶ https://tsam-ai.com/（本番）
        └─ それ以外への push     ──▶ Vercel ──▶ プレビューURL（Vercel SSO で保護）
```

**2026-08-01 に GitHub Pages から Vercel へ移行しました。**
GitHub Pages は無効化済みで、`CNAME` も削除されています。
切替の全手順と実施記録は [docs/production-cutover.md](docs/production-cutover.md)、
移行の設計判断は [docs/vercel-migration.md](docs/vercel-migration.md) にあります。

### 静的とサーバー実行の2本立て

| URL | 配信元 | 実行 |
| --- | --- | --- |
| `/` | `public/index.html` | 静的 |
| `/css/` `/js/` `/assets/` | `public/` 配下 | 静的 |
| `/apps/` | `public/apps/`（**テスト環境**） | 静的 |
| `/login/` `/pricing/` `/portal/` `/logout/` | `public/` 配下 | 静的 |
| `/password/setup/` `/password/reset/` | 同上 | 静的 |
| `/payment/success/` `/payment/cancel/` | 同上 | 静的 |
| `/legal/` `/event/` `/potenitas/` | 同上 | 静的 |
| `/auth/` | `public/auth/`（共通JS・CSS） | 静的 |
| `/event/apply/` 以降 | `app/event/`（Next.js App Router） | **サーバー実行** |
| `/event/api/stripe/webhook/` | `app/event/api/` | **サーバー実行** |

**静的ファイルの配信ルートは `public/` です。** リポジトリのルートではありません。
`public/` の外にあるものは配信されません。

`next.config.ts` の `rewrites().fallback` が、ディレクトリへのアクセスを
`index.html` へ解決します。`basePath` は使っていません
（理由は [docs/vercel-migration.md](docs/vercel-migration.md) §1）。

### 配信されないもの

| パス | 理由 |
| --- | --- |
| `gas-auth/` | Apps Script のソース。手動でコピーする（下記） |
| `tests/` | 本番認証系・交流会・Portal のテストコード |
| `docs/` | 設計ドキュメント |
| `supabase/` | マイグレーション |
| `lp-draft/` | 退避したリニューアル版LP |

いずれも `public/` の外にあるため、URL を叩いても届きません。
**Pages 時代と違い、`tests/` や `docs/` は Web からは読めなくなりました。**
ただしリポジトリは公開されているため、GitHub 上では誰でも読めます。
**秘密情報を入れないこと**（Script Properties に置く運用にしています）。

---

## テストの自動実行（CI）

`.github/workflows/test.yml` が push と Pull Request で `npm test` を走らせます。

**CI はデプロイに関与しません。** 配信は Vercel の Git 連携が行い、
CI が落ちてもデプロイは止まりません。公開を止めたい場合は、
GitHub のブランチ保護でこのワークフローを必須チェックに指定してください。

---

## Next.js について

Next.js（`app/` `components/` `lib/`）は **Vercel 上で動いています。**

| 対象 | 状態 |
| --- | --- |
| `app/event/` | 交流会申込アプリ。**稼働中**（Stripe 決済・Webhook・管理画面） |
| `lp-draft/` | リニューアル版LP。現行サイトと URL が衝突するため退避。未配信 |
| `.github/workflows/nextjs.yml.disabled` | Pages 時代の残骸。無効のまま |

`next.config.ts` から `output: "export"` は外してあります
（Webhook 受信と Checkout Session 作成にサーバー実行が要るため）。
経緯は [docs/vercel-migration.md](docs/vercel-migration.md)。

---

## 静的サイト側のデプロイ

特別な操作はありません。`main` へマージすれば数分で反映されます。

### 公開前の確認

```bash
npm run lint             # 追加分に警告が無いこと
npm run typecheck        # 型エラーが無いこと
npm test                 # 既存 /apps/ 分と本番認証系の両方
```

`npm test` は Chrome を起動します。
見つからない場合は環境変数 `CHROME_PATH` を設定してください。

### ローカルでの確認

静的ページだけを見るなら、配信ルート（`public/`）を直接開きます。

```bash
py -m http.server 8000 --directory public
```

<http://localhost:8000/login/> を開きます。

Next.js のルート（`/event/apply/` 以降）も見るなら、こちらを使います。

```bash
npm run dev
```

- `file://` では ES モジュールが読めません。必ず HTTP サーバー経由で開いてください。
- API を呼ぶ操作は、`public/auth/config.js` の `apiUrl` が設定済みでないと
  「この機能は現在ご利用いただけません。」で止まります（想定どおりの挙動です）。

### HTTPS

Vercel がドメインへ証明書を自動発行し、HTTP は HTTPS へ転送します。
**リポジトリ側で設定する項目はありません**（`CNAME` は削除済み）。

DNS は Cloudflare で管理しています（A レコード4件 ＋ `www` の CNAME）。
切替の記録は [docs/production-cutover.md](docs/production-cutover.md)。

---

## Apps Script のデプロイ

### 初回

[AUTH_SETUP.md](./AUTH_SETUP.md) の手順1〜5を参照してください。要点のみ:

1. スタンドアロンの Apps Script プロジェクトを作る
   （既存の `gas/` とは **別プロジェクト**）
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
- Stripe の Webhook エンドポイントURL

### clasp を使う場合

```bash
cd gas-auth
clasp push
clasp deploy --deploymentId <既存のデプロイID> --description "v2"
```

---

## リリース手順（推奨）

1. 作業ブランチで実装する
2. `npm test` が全件成功することを確認する
3. Apps Script を更新し、既存デプロイを新バージョンへ更新する
4. `checkAuthSetup()` で設定を点検する
5. ステージング相当の確認
   - Stripe をテストモードのままにして、通し確認を行う
   - 管理者アカウントでログイン・ログアウトを確認する
6. `main` へマージする（force push しない）
7. 数分後、本番URLで確認する
   - `/login/` が表示される
   - `/portal/` が未ログインで `/login/` へ戻る
   - `/apps/` が従来どおり動く（回帰確認）
8. Stripe をライブモードへ切り替える（[STRIPE_SETUP.md](./STRIPE_SETUP.md) 手順6）

---

## ロールバック

### 静的サイト

`main` を1つ前のコミットへ戻す（revert コミットを作る）。
**force push は行わないでください。**

```bash
git revert <コミットハッシュ>
git push origin main
```

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
| `public/portal/app-source.js` | アプリ一覧のスプレッドシートID |
| `.env.example` | ローカル開発用の雛形 |

公開ドメインは **Vercel 側**で登録します。`CNAME` ファイルはもうありません。

### Vercel（環境変数）

Stripe / Supabase / Gmail の値は **Vercel の環境変数にだけ**置きます。
リポジトリにもフロントエンドのコードにも書きません。
一覧は [docs/vercel-migration.md](docs/vercel-migration.md) §3。

### Apps Script（Script Properties）

[AUTH_SETUP.md](./AUTH_SETUP.md) の「Script Properties 一覧」を参照。

### 認証設定スプレッドシート

[AUTH_SETUP.md](./AUTH_SETUP.md) の「認証設定シートの一覧」を参照。

---

## 既存 `/apps/` への影響

**今回の変更は `/apps/` 配下のファイルを1つも変更していません。**

- `/apps/` は従来どおりテスト環境として動作します
- 既存の Google ログイン、お気に入り、音声レコーダー等はそのままです
- 既存のテスト（`npm run test:apps`）が全件成功することを確認しています

本番認証系と `/apps/` は、次の点で完全に分かれています。

| | `/apps/`（テスト環境） | 本番認証系 |
| --- | --- | --- |
| 認証 | Supabase（未接続）＋ダミー | Apps Script + スプレッドシート |
| セッションキー | `tsam-ai-session` | `tsam-auth-session` |
| Apps Script | `gas/`（お気に入り用） | `gas-auth/`（認証用） |
| 共通JS | `public/apps/shared/` | `public/auth/` |
| テスト | `public/apps/tests/` | `tests/` |

セッションの保存キーが違うため、片方にログインしても
もう片方には影響しません。

---

## 監視

現時点で自動監視はありません。以下を定期的に目視してください。

| 確認先 | 見るもの |
| --- | --- |
| `TSAM AI 認証ログ` → `system_error_logs` | Webhook の失敗、メール送信の失敗 |
| `TSAM AI ユーザー管理` → `stripe_events` | `processing_status` が `failed` の行 |
| Stripe ダッシュボード → Webhook | 配信の失敗 |
| Apps Script → 実行数 | エラー率の上昇 |

Apps Script の実行が失敗した場合、
プロジェクト所有者宛にGoogleから通知メールが届きます。

# デプロイ手順

TSAM AI コーポレートサイトと、本番認証システムの公開手順。

---

## 現在の公開構成

```text
GitHub リポジトリ（main ブランチのルート）
        │
        ▼  GitHub Pages（Deploy from a branch）
https://tsam-ai.com/
```

**リポジトリのルートがそのまま配信されます。**
ビルドは行われません。`index.html` や `login/index.html` が
そのままの位置で公開されます。

### 配信されるもの

| パス | 内容 |
| --- | --- |
| `/` | コーポレートサイト（`index.html`） |
| `/css/` `/js/` `/assets/` | コーポレートサイトの資産 |
| `/apps/` | **テスト環境**（既存。今回は変更していません） |
| `/login/` `/pricing/` `/portal/` `/logout/` | 本番認証系（今回追加） |
| `/password/setup/` `/password/reset/` | 同上 |
| `/payment/success/` `/payment/cancel/` | 同上 |
| `/auth/` | 本番認証系の共通JS・CSS |

### 配信されないもの

| パス | 理由 |
| --- | --- |
| `/gas-auth/` | Apps Script のソース。手動でコピーする（下記） |
| `/gas/` | 同上（お気に入り機能用） |
| `/tests/` `/apps/tests/` | テストコード |
| `/app/` `/components/` `/lib/` `/content/` | Next.js のソース（現在ビルドされていない） |
| `/docs/` | 設計ドキュメント |

> `.gs` ファイルや `tests/` がリポジトリに含まれるため、
> URL を直接叩けば内容は読めます。
> **秘密情報を入れないこと**（Script Properties に置く運用にしています）。

---

## Next.js について（重要）

このリポジトリには Next.js（`app/` `components/` `lib/`）が同居していますが、
**現在デプロイされていません。**

- `.github/workflows/nextjs.yml.disabled` … 無効化されたワークフロー
- 経緯: `67a800b ci: deploy Next.js site to GitHub Pages` → `e78ac36 revert: disable Potenitas Pages workflow`

### ワークフローを再度有効化する場合の注意

`next.config.ts` は `output: "export"` で、ビルド結果は `out/` に出ます。
このワークフローは `out/` だけを Pages へアップロードします。

**そのまま有効化すると、以下がすべて 404 になります。**

- `/apps/`（テスト環境）
- `/login/` `/pricing/` `/portal/` など（本番認証系）
- ルートの `index.html`（コーポレートサイト）

`out/` に含まれるのは `app/` 配下から生成されたページと `public/` の中身だけだからです。

有効化するなら、いずれかの対応が必要です。

1. ビルド後に `apps/` `auth/` `login/` `pricing/` `portal/` `logout/`
   `password/` `payment/` を `out/` へコピーする手順をワークフローへ足す
2. これらのディレクトリを `public/` 配下へ移す
   （その場合、各HTMLの相対パスと `auth/config.js` の `setScreenDepth()` を見直す）
3. Next.js を別プロジェクト・別ドメインで配信する

**現状のまま（ワークフロー無効）が最も安全です。**
本書は現状の構成を前提にしています。

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

```bash
py -m http.server 8000
```

<http://localhost:8000/login/> を開きます。

- `file://` では ES モジュールが読めません。必ず HTTP サーバー経由で開いてください。
- API を呼ぶ操作は、`auth/config.js` の `apiUrl` が設定済みでないと
  「この機能は現在ご利用いただけません。」で止まります（想定どおりの挙動です）。

### HTTPS

リポジトリの Settings → Pages で **「Enforce HTTPS」を有効**にしてください。
`CNAME` に `tsam-ai.com` が入っています。

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
6. `/exec` URL を `auth/config.js` の `apiUrl` へ貼る

### 更新するとき

コードを直したら、必ず **デプロイし直す**必要があります。
エディタで保存しただけでは、公開中の Web アプリには反映されません。

```text
デプロイ → デプロイを管理 → 既存のデプロイの「編集」（鉛筆アイコン）
       → バージョン「新バージョン」 → デプロイ
```

**「新しいデプロイ」ではなく「デプロイを管理」から既存を編集してください。**
新規に作ると `/exec` URL が変わり、以下の更新が必要になります。

- `auth/config.js` の `apiUrl`
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
| `auth/config.js` | Apps Script Web アプリの `/exec` URL |
| `CNAME` | 公開ドメイン（`tsam-ai.com`） |
| `.env.example` | Next.js 用（現在未使用） |

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
| 共通JS | `apps/shared/` | `auth/` |
| テスト | `apps/tests/` | `tests/` |

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

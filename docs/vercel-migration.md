# Vercel移行メモ（交流会申込アプリ 実装順序2以降の前提）

交流会申込・Stripe決済アプリはWebhook受信とCheckout Session作成にサーバー側の実行環境が
必要なため、GitHub Pages（静的配信）では動かない。このブランチで、1リポジトリのまま
Vercelへ移せる構成に変更した。

## 1. なぜ basePath を使わないか

仕様書2章は「`basePath: "/event"` を設定する」としているが、この設定は `public/` 配下の
静的ファイルにも適用される。`basePath: "/event"` にするとルート（`/`）が404になり、
「ルートは既存サイトをそのまま配信し、`/event/` 配下をアプリとする」という同章の要件と
両立しない。

そのため basePath は使わず、次の構成にした。公開URLは仕様どおり
`https://tsam-ai.com/event/...` になる。

| URL | 配信元 |
| --- | --- |
| `/` | `public/index.html`（現行のコーポレートサイト） |
| `/apps/`, `/legal/`, `/login/`, `/portal/`, `/pricing/` など | `public/` 配下の既存の静的ページ |
| `/event/` | `public/event/index.html`（交流会の詳細ページ。静的のまま） |
| `/event/legal.html` | `public/event/legal.html` |
| `/event/apply` 以降 | Next.jsのルート（`app/event/` 配下。これから実装） |

`next.config.ts` の rewrites は配列で返しているため afterFiles として評価される。
つまり `app/` 配下のルートが常に優先され、どこにも一致しなかったURLだけが
`public/` の `index.html` に落ちる。Next側にルートを追加すれば、そのパスは自動的に
静的ファイルより優先される。

## 2. このブランチで変更したこと

* `next.config.ts`
  * `output: "export"` を削除（サーバー機能を使うため）
  * `images.unoptimized` を削除（Vercelでは最適化が使える）
  * ディレクトリを `index.html` に解決する rewrites を追加
* 現行の静的サイト一式を `public/` へ移動
  （`index.html` / `css` / `js` / `assets` / `apps` / `auth` / `event` / `legal` /
  `login` / `logout` / `password` / `payment` / `portal` / `pricing` / favicon類）
* `app/` にあったリニューアル版LPのルートを `lp-draft/` へ退避
  （`/`、`/legal`、`/privacy` などが現行サイトと衝突するため。削除はしていない。
  詳細は `lp-draft/README.md`）
* テストのパス追従
  * `package.json` のテストスクリプトを `public/apps/tests/...` に変更
  * `browser-harness.mjs` の `REPO_ROOT` を、配信ルート（`SITE_ROOT` = `public/`）と
    リポジトリのルート（`REPO_ROOT`）に分離
  * 公開物ではないテストフィクスチャ（`tests/browser/fixtures/`）を配信するため、
    静的サーバーに `mounts` オプションを追加
  * `tests/` から `apps/`・`auth/` を参照していた相対パスを `public/` 経由に修正

テストは全件通っている（`npm test`：857 + 943）。

## 3. 残っている作業（このブランチではまだ行っていない）

1. **Vercelプロジェクトの作成**：このリポジトリを接続する。Framework Preset は Next.js、
   Build Command / Output Directory は既定のままでよい
2. **環境変数の登録**（仕様書13章）。値はVercelの環境変数にのみ置き、
   リポジトリとフロントエンドコードには書かない
   * `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET`
   * `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`
   * `SUPABASE_URL` / `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY`
   * `RESEND_API_KEY`
   * `NEXT_PUBLIC_BASE_URL`（本番: `https://tsam-ai.com/event`）
3. **プレビューURLでの検証**：`/`、`/event/`、`/apps/`、`/legal/tokusho/`、`/login/`、
   `/portal/` が現行と同じ内容で表示されることを確認する
4. **DNS切替**：切替前にTTLを短縮しておく。切替後にGitHub Pagesの設定を無効化する
5. **mainへのマージ**：**DNS切替より前にマージするとGitHub Pages配信が壊れる**。
   GitHub Pagesはリポジトリのルートを配信するため、`public/` へ移した時点で
   `/`・`/apps/`・`/legal/` などが404になる。マージはDNS切替の直前か直後に行う

## 4. 移行後に対応が必要な細かい点

* `CNAME`（リポジトリのルート）はGitHub Pages用。Vercelへ完全移行したあとは不要になる
* `app/layout.tsx` のメタデータはリニューアル版LP向けの文言（`lib/seo.ts`）のままなので、
  `app/event/` 配下に交流会アプリ用の `layout.tsx` を用意する
* `npm run lint` は141件のエラーを報告するが、これは移行前から同じ（`public/apps/` へ
  移動した既存ファイル由来。ベンダーバンドルやビルド済み成果物を含む）。
  CIが実行するのは `npm test` のみで、こちらは通っている

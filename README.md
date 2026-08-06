# TSアセットマネジメント合同会社 コーポレートサイト

## プロジェクト概要

TSアセットマネジメント合同会社の静的なコーポレートサイトです。HTML、CSS、Vanilla JavaScriptのみで構成し、ビルド処理や外部ライブラリを使用していません。PC、タブレット、スマートフォンに対応しています。

同じリポジトリで、TSAM AI サービスの本番用ログイン・Portal・決済連携も配信しています。

## ファイル構成

```text
.
├── public/                   ── 配信ルート（Vercel はここを静的に配る）
│   ├── index.html               コーポレートサイト
│   ├── css/ js/ assets/         コーポレートサイトの資産
│   ├── login/                ── 本番認証系（TSAM AI）
│   ├── pricing/                 料金プラン選択
│   ├── portal/                  Portal（要ログイン。アプリのグリッド）
│   ├── password/setup/          パスワード初期設定
│   ├── password/reset/          パスワード再設定
│   ├── payment/success/         決済完了
│   ├── payment/cancel/          決済キャンセル
│   ├── logout/                  ログアウト
│   ├── auth/                    上記の共通JS・CSS
│   ├── legal/                   法務文書（生成物）
│   ├── event/                   交流会の告知ページ（静的部分）
│   ├── potenitas/               Potenitas ページ
│   └── apps/                 ── アプリポータル（テスト環境。従来どおり）
│
├── app/event/                ── 交流会申込アプリ（Next.js。サーバー実行）
│                                申込・決済・Stripe Webhook・管理画面
├── components/ lib/ types/      Next.js の共通部品
├── lp-draft/                    リニューアル版LP（退避。未配信）
│
├── gas-auth/                    認証バックエンド（Apps Script。配信しない）
├── supabase/migrations/         交流会アプリのDBスキーマ
├── tests/                       本番認証系・交流会・Portal の自動テスト
├── .github/workflows/test.yml   CI（テスト実行のみ。デプロイには関与しない）
│
├── docs/
├── AGENTS.md
├── README.md
└── SITE_SPEC.md
```

**`public/` の外にあるものは配信されません。**
`tests/` `docs/` `gas-auth/` は URL を叩いても届きません
（リポジトリは公開されているため、GitHub 上では読めます）。

`labs/`（TSAM AI とは無関係な同居プロジェクト）はまだ存在しません。

`labs/` の扱い（共通資産を参照しない・公開の前提・指示書のスコープ）は
[docs/repository-structure.md](docs/repository-structure.md)で宣言しています。

`SITE_SPEC.md`は、掲載文章、会社情報、デザイン、レスポンシブ、アクセシビリティ、SEOの実装基準です。

## TSAM AI 本番認証システム

### 利用の流れ

```text
コーポレートサイト → /login/ → /portal/ → 各種アプリ

新規:
/login/ →「サービスを申し込む」→ /pricing/ → Stripe Checkout
      → /payment/success/ → 案内メール → /password/setup/ → /login/ → /portal/
```

### 構成

| 層 | 使用技術 |
| --- | --- |
| フロント | HTML / CSS / Vanilla JavaScript（ESモジュール、ビルドなし） |
| バックエンド | Google Apps Script（`gas-auth/`） |
| ユーザー管理 | Googleスプレッドシート（マイドライブ／TSAM AI／Auth） |
| 決済 | Stripe Checkout ＋ Webhook |

### ドキュメント

| 文書 | 内容 |
| --- | --- |
| [MANUAL_SETUP_CHECKLIST.md](./MANUAL_SETUP_CHECKLIST.md) | **人の手でしか実行できない作業の一覧。まずこれを読む** |
| [AUTH_SETUP.md](./AUTH_SETUP.md) | セットアップ、Script Properties、スプレッドシート構成、動作確認 |
| [STRIPE_SETUP.md](./STRIPE_SETUP.md) | Stripe の商品・キー・Webhook 設定、確認手順 |
| [DEPLOYMENT.md](./DEPLOYMENT.md) | 公開構成、デプロイ、ロールバック、Next.js との関係 |
| [SECURITY_NOTES.md](./SECURITY_NOTES.md) | 守れること・守れないこと、既知の制約 |
| [gas-auth/README.md](./gas-auth/README.md) | バックエンドのAPI仕様と設計メモ |

**公開前に [SECURITY_NOTES.md](./SECURITY_NOTES.md) を必ず読んでください。**
静的ホスティングであるがゆえの限界と、パスワードハッシュの強度について
正直に記載しています。

### 法務ページ（`/legal/`）は生成物です

`legal/terms/index.html` `legal/privacy/index.html` `legal/tokusho/index.html` は、
スプレッドシート「TSAM AI 法務文書」から生成されます。

> **これらのHTMLを直接編集しないでください。**
> 次に `publishLegalDocs()` が実行された時点で、編集内容は失われます。
> 条文を直すときはスプレッドシートを直し、公開操作を行ってください。

各ファイルの冒頭にも同じ趣旨の注記が入っています。
手編集を含む変更をレビューで見つけた場合は、取り込まずに差し戻してください。

| 目的 | 手段 |
| --- | --- |
| 条文を直す | スプレッドシート「TSAM AI 法務文書」を編集 |
| 見た目を確かめる | GAS エディタで `previewLegalDocs()` |
| 公開する | GAS エディタで `publishLegalDocs()` |

仕組みと書式規約は [docs/specs/legal-cms-spec-v1.md](./docs/specs/legal-cms-spec-v1.md)、
トークンの用意は [docs/instructions/2026-07-31-github-token.md](./docs/instructions/2026-07-31-github-token.md) にあります。

`docs/legal-source/*.md` は初期移行の原本（アーカイブ）で、現在の正ではありません。

### `/apps/` との関係

`/apps/` は **テスト環境** として維持しています。今回の本番認証系とは独立しており、
セッションの保存キーもバックエンドも別です。片方にログインしても、
もう片方には影響しません。

| | `/apps/`（テスト環境） | 本番認証系 |
| --- | --- | --- |
| 認証 | Supabase（未接続）＋ダミー | Apps Script + スプレッドシート |
| セッションキー | `tsam-ai-session` | `tsam-auth-session` |
| Apps Script | このリポジトリには含まない | `gas-auth/` |
| 共通JS | `public/apps/shared/` | `public/auth/` |
| テスト | `public/apps/tests/` | `tests/` |

> `public/apps/AUTH_SETUP.md` は `/apps/` の Google ログイン用です。
> 本番認証系の手順はルートの [AUTH_SETUP.md](./AUTH_SETUP.md) を参照してください。

## 交流会申込アプリ（`/event/`）

詳細ページ（`public/event/index.html`）は静的HTMLのままで、申込・決済・管理画面が
Next.jsのルートです。2026年8月1日に本番受付を開始しました。

| 層 | 使用技術 |
| --- | --- |
| 画面・サーバー処理 | Next.js（App Router、サーバーアクション。`app/event/`） |
| ロジック | `lib/event/`（`.mjs` ＋ 型定義 `.d.mts`。外部SDKを使わず fetch で REST を叩く） |
| データベース | Supabase（プロジェクト `tsam-event`。`supabase/migrations/`） |
| 決済 | Stripe Checkout ＋ Webhook |
| 参加確定メール | Gmail API |

| 文書 | 内容 |
| --- | --- |
| [docs/vercel-migration.md](docs/vercel-migration.md) | 1リポジトリで静的サイトとNext.jsを同居させる構成、環境変数、Webhookのエンドポイント |
| [docs/event-app-database.md](docs/event-app-database.md) | Supabaseのスキーマ、マイグレーションの適用、権限設計 |
| [docs/event-admin.md](docs/event-admin.md) | 管理画面 |
| [docs/production-cutover.md](docs/production-cutover.md) | 本番切替の実施記録、受付の開始と停止、切り分け表 |
| [docs/event-acceptance.md](docs/event-acceptance.md) | 受入条件の判定結果 |

**受付を止めるときは、Supabase の `events.is_published` を `false` にするのが先です**
（即時。サーバー側の受付判定はこちら）。`public/event/index.html` の
`data-event-status` は表示を合わせるための操作で、デプロイに1〜2分かかります。

## 実装済みセクション

- ヘッダー、グローバルナビゲーション
- ファーストビュー
- 私たちについて
- 課題解決の進め方
- 事業領域
- 事業のつながり
- わたしたちの強み
- メンバー
- 会社概要、お知らせ
- お問い合わせ
- フッター、ページトップボタン

## 実装済み機能

- 1024px未満のハンバーガーメニューとフォーカストラップ
- スクロールに応じたヘッダーとページトップボタンの表示切り替え
- IntersectionObserverによる一度限りのスクロール表示
- ApproachとBusinessのスタッガー表示
- ネイティブ`details`による経歴と定款事業内容の開閉
- `prefers-reduced-motion`によるアニメーション軽減
- スキップリンクとキーボード操作対応
- OrganizationのJSON-LD
- `mailto`によるお問い合わせ

## ローカルでの確認方法

VS CodeのLive Serverを利用する場合は、`index.html`を開いて「Open with Live Server」を実行します。Live Serverがない環境では、プロジェクトのルートで次のような静的ファイルサーバーを起動できます。

```powershell
python -m http.server 8000
```

その後、`http://localhost:8000/`へアクセスします。

本番認証系は `http://localhost:8000/login/` です。
ESモジュールを使うため、`file://` では開けません。必ずHTTPサーバー経由で開いてください。

## テスト

```bash
npm test                          # すべて（Chromeが必要）
npm run test:apps                 # /apps/（テスト環境）のみ
npm run test:auth-system          # 本番認証系のみ
npm run test:auth-system:unit     # 本番認証系のうち Node のみ（Chrome不要）
npm run lint
npm run typecheck
```

`gas-auth/*.gs` は、Node 上の偽 Apps Script 環境で実行して検証しています
（[tests/helpers/gas-harness.mjs](tests/helpers/gas-harness.mjs)）。
本番のスプレッドシートには書き込みません。

## 表示・操作の確認

- 320px、375px、768px、1024px、1440pxで横スクロールや表示崩れがないこと
- Tab／Shift+Tabだけでリンク、ボタン、メニュー、`summary`を操作できること
- ハンバーガーメニューがEscで閉じ、ボタンへフォーカスが戻ること
- 「本文へスキップ」で本文へ移動できること
- ページトップボタンが非表示時にフォーカスされないこと
- ブラウザまたはOSで「視差効果を減らす」「アニメーションを表示しない」を有効にし、スクロール表示、Hero、Connection、スムーズスクロールが停止すること
- JavaScriptを無効にしても本文が表示され、`details`が開閉できること

## Lighthouse

Chrome DevToolsのLighthouseで次を確認します。

- Performance: 90以上
- Accessibility: 95以上
- Best Practices: 95以上
- SEO: 95以上
- コンソールエラー・警告がないこと

## 公開

**Vercel が配信します**（2026-08-01 に GitHub Pages から移行）。

- `main` への push → 本番（<https://tsam-ai.com/>）
- それ以外への push → プレビューURL（Vercel SSO で保護）

静的ページはビルド不要で、ファイル参照はルート相対にしていません。
手順と設定の所在は [DEPLOYMENT.md](DEPLOYMENT.md) を参照してください。

## 未確定事項

- OGP画像と`og:image`

未確定値は推測せず、TODOコメントを維持しています。

公開URLは`https://tsam-ai.com/`で確定しました。`public/index.html`には
canonicalと`og:url`のTODOコメントが残っているため、確定した値へ差し替える作業が残っています。
favicon は設定済みです。

利用規約・プライバシーポリシーは、ログイン画面と料金プラン画面から
`/legal/` へリンク済みです（「準備中」ではありません）。

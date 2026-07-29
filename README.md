# TSアセットマネジメント合同会社 コーポレートサイト

## プロジェクト概要

TSアセットマネジメント合同会社の静的なコーポレートサイトです。HTML、CSS、Vanilla JavaScriptのみで構成し、ビルド処理や外部ライブラリを使用していません。PC、タブレット、スマートフォンに対応しています。

同じリポジトリで、TSAM AI サービスの本番用ログイン・Portal・決済連携も配信しています。

## ファイル構成

```text
.
├── index.html                コーポレートサイト
├── css/style.css
├── js/main.js
├── assets/images/
│
├── login/                    ── 本番認証系（TSAM AI）
├── pricing/                     料金プラン選択
├── portal/                      Portal（要ログイン）
├── password/setup/              パスワード初期設定
├── password/reset/              パスワード再設定
├── payment/success/             決済完了
├── payment/cancel/              決済キャンセル
├── logout/                      ログアウト
├── auth/                        上記の共通JS・CSS
├── gas-auth/                    認証バックエンド（Apps Script。配信しない）
├── tests/                       本番認証系の自動テスト
│
├── apps/                     ── アプリポータル（テスト環境。従来どおり）
├── gas/                         お気に入り機能のバックエンド
│
├── app/ components/ lib/     ── Next.js（現在デプロイしていない）
├── docs/
├── AGENTS.md
├── README.md
└── SITE_SPEC.md
```

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

### `/apps/` との関係

`/apps/` は **テスト環境** として維持しています。今回の本番認証系とは独立しており、
セッションの保存キーもバックエンドも別です。片方にログインしても、
もう片方には影響しません。

| | `/apps/`（テスト環境） | 本番認証系 |
| --- | --- | --- |
| 認証 | Supabase（未接続）＋ダミー | Apps Script + スプレッドシート |
| セッションキー | `tsam-ai-session` | `tsam-auth-session` |
| Apps Script | `gas/` | `gas-auth/` |
| 共通JS | `apps/shared/` | `auth/` |
| テスト | `apps/tests/` | `tests/` |

> `apps/AUTH_SETUP.md` は `/apps/` の Google ログイン用です。
> 本番認証系の手順はルートの [AUTH_SETUP.md](./AUTH_SETUP.md) を参照してください。

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

## GitHub Pages

GitHub Pagesでそのまま公開できる、ルート相対ではないファイル参照とビルド不要の構成です。公開前にリポジトリのPages設定と公開URLを確認してください。

## 未確定事項

- canonical URL
- `og:url`
- OGP画像と`og:image`
- favicon
- 利用規約・プライバシーポリシーの公開URL

未確定値は推測せず、TODOコメントを維持しています。

利用規約とプライバシーポリシーは、ログイン画面と料金プラン画面に
項目として表示していますが、公開URLが未確定のためリンクにしていません
（「準備中」と明示）。URLが確定したら、次の箇所をリンクへ差し替えてください。

- [login/index.html](login/index.html)
- [pricing/index.html](pricing/index.html)

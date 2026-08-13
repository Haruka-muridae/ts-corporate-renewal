# リポジトリ要件定義書

制定: 2026年8月13日
対象リポジトリ: `haruka-muridae/ts-corporate-renewal`

---

## 1. 本書の目的と位置づけ

本書は、このリポジトリ全体（TSアセットマネジメント合同会社のコーポレートサイト、TSAM AI
本番認証系、交流会申込アプリ、本番アプリ群）を対象に、**何のために・誰が・何を使えるべきか**
という要求水準を、リポジトリ横断で1つの文書にまとめたものである。

個別機能の詳細な要求（画面仕様、API、データモデル、判定ロジックなど）は
[docs/specs/](./specs/README.md) 配下の仕様書・要件定義書が正であり、本書はそれらを
置き換えない。本書と個別文書が食い違った場合は、**詳細事項は個別文書を優先**し、
本書側を個別文書に合わせて更新する。本書が担うのは、個別文書だけでは見えない
リポジトリ横断の前提（どの系がどこまでを担うか、非機能要件、スコープの境界）である。

> [docs/specs/README.md](./specs/README.md) は「要件定義書＝まだ実装が存在しない機能について
> 何を作るかを決めた文書」「仕様書＝実装済みの挙動を規定する文書」と区別している。本書は
> この区別より一段上の、**リポジトリ全体を対象にした要件定義書**である。すでに実装済みの
> 領域についても、なぜそれを作るか（要求の背景）を記録する目的で対象に含む。

## 2. 事業背景

TSアセットマネジメント合同会社（以下「当社」）は、保険数理・確率統計を土台に、
データ分析・生成AIの実装・システム開発・学習指導を行う。中心メッセージは
「数理とデータで、企業の課題を解決する。」であり、提供価値を次の3ステップで説明している。

| ステップ | 内容 |
| --- | --- |
| 数理でとらえる | 保険数理・確率統計・最適化により、事象を分布とモデルで記述し、まず問題を正しく定式化する |
| AIで解く | 機械学習によるモデリングと生成AIの実装。認知科学・行動経済学の知見を取り入れ、中身を説明できる仕組みにする |
| 仕組みに落とす | 分析で終わらせず、システム・業務自動化・クラウド環境として実装し、現場で継続して動くものにする |

主要事業は、保険数理・資産運用・会計コンサルティング、機械学習によるデータ分析、生成AIの
活用・導入支援、システム・プログラム開発、業務自動化（DX）、動画・音楽データ制作、
数学・統計・データサイエンスの学習指導、講師派遣・講義講演である（詳細と会社概要は
[SITE_SPEC.md](../SITE_SPEC.md) §1-1 が正）。

このリポジトリは、上記事業を伝える**コーポレートサイト**と、そこから提供する
**TSAM AI サービス**（本番認証・アプリポータル・個別アプリ群）、および単発イベントである
**交流会申込アプリ**を1つに収めている。

## 3. 利用者・ステークホルダー

| 利用者区分 | 何をするか | 主な入口 |
| --- | --- | --- |
| サイト訪問者（見込み顧客） | 会社情報・事業内容を閲覧し、問い合わせる | `/`（コーポレートサイト） |
| TSAM AI 契約者 | ログインし、契約プランに応じたアプリを利用する | `/login/` → `/portal/` |
| TSAM AI 新規申込者 | 料金プランを選び、Stripe決済を経て利用者登録する | `/pricing/` → Stripe Checkout → `/password/setup/` |
| 交流会参加希望者 | 開催情報を見て申し込み、決済する | `/event/` → `/event/apply/` |
| 交流会運営（当社） | 申込状況を確認し、参加者を管理する | `/event/admin/` |
| 開発者・保守担当 | 各系統の実装・テスト・デプロイを行う | リポジトリ本体、`docs/` |

## 4. リポジトリ全体像

配信は Cloudflare Workers（OpenNext）で、`npm run deploy` による**手動デプロイ**が本番反映の
唯一の手段である（`main` への push で自動デプロイはされない）。配信構成の詳細と過去の
移行経緯（GitHub Pages → Vercel → Cloudflare Workers）は
[docs/deployment-cloudflare.md](./deployment-cloudflare.md) と [DEPLOYMENT.md](../DEPLOYMENT.md) を参照する。

同じリポジトリ・同じドメインに、互いに独立した系が同居しており、**片方の都合でもう片方を
変えない**ことが設計上の要求である（詳細は [docs/repository-structure.md](./repository-structure.md)）。

| 系 | 主な場所 | バックエンド | 位置づけ |
| --- | --- | --- | --- |
| コーポレートサイト本体 | `public/index.html` ほか | なし（静的） | 事業紹介。ビルド不要 |
| TSAM AI 本番認証系 | `public/login/` `portal/` `pricing/` `password/` `payment/` `logout/` `auth/` | Apps Script（`gas-auth/`）＋ Googleスプレッドシート | 契約者向けの認証・決済・アプリポータル |
| 本番アプリ群 | `public/production-app/<アプリID>/` | アプリごとに異なる（サーバーレス、または利用者自身のAPIキー） | Portal に掲載する契約者向け個別アプリ |
| 交流会申込アプリ | `app/event/`（Next.js） | Next.js サーバーアクション＋Supabase（`tsam-event`） | 単発イベントの申込・決済・管理 |
| テスト環境 `/apps/` | `public/apps/` | Supabase（未接続）＋ダミー | TSAM AI の実験場。本番認証系とは完全に独立 |
| 別プロジェクト同居領域 | `labs/`、公開分は `public/labs/` | プロジェクトごと | TSAM AI と無関係な同居プロジェクト（現在: `ai-corporate-training`、`personal-ai-training`） |

`labs/` 配下は本書のスコープ外である。TSAM AI 側の指示・要件は `labs/` に及ばず、
`labs/` 側の作業は TSAM AI 本体の共通資産を参照・変更しない（[docs/repository-structure.md](./repository-structure.md) §2-1, §3）。

## 5. スコープ

### 5-1. 対象

- コーポレートサイト（`public/index.html` ほか、静的部分全体）
- TSAM AI 本番認証系（ログイン・Portal・料金プラン・パスワード設定/再設定・決済結果・ログアウト・法務ページ）
- 交流会申込アプリ（告知・申込・決済・Webhook・管理画面）
- Portal に掲載する本番アプリ群（`public/production-app/` 配下）
- 上記を横断する非機能要件（性能・アクセシビリティ・セキュリティ・テスト・デプロイ運用）

### 5-2. 対象外

- `labs/` 配下の同居プロジェクト（別途、各プロジェクト側の文書が正）
- `lp-draft/`（リニューアル版LPの退避コード。稼働中のサイトは参照していない）
- `potenitas-lp/`（別系統の静的LP）
- テスト環境 `/apps/` の新機能追加（現状維持が既定。本番アプリの流用元にはしない）

## 6. 機能要件

各系の詳細な機能要件・画面仕様・データモデルは、個別の仕様書・要件定義書が正である。
本節はリポジトリ横断で見たときの要求水準を示す。

### 6-1. コーポレートサイト

- 1ページ構成で、会社情報（会社概要・事業内容・メンバー・お知らせ・お問い合わせ）を
  正確に、既存の一次情報（既存HP記載事項）を改変せずに掲載する（[SITE_SPEC.md](../SITE_SPEC.md)）。
- 会社情報・実績・年・数値・固有名詞は推測・改変しない。未確定値（canonical URL、
  OGP画像等）は埋めずTODOとして残す。
- PC・タブレット・スマートフォンに対応するレスポンシブ実装とする。

### 6-2. TSAM AI 本番認証系

- 新規契約者が「料金選択 → Stripe決済 → 利用者作成 → 初期パスワード設定 → ログイン」の
  流れで自分のアカウントを持てること。
- 既存契約者がログインし、契約に応じたアプリ一覧（Portal）へアクセスできること。
- パスワード再設定、ログアウト、決済結果画面（成功/キャンセル）を提供すること。
- 利用規約・プライバシーポリシー・特定商取引法表記を `/legal/` で参照でき、内容は
  スプレッドシート「TSAM AI 法務文書」を正として生成されること（手編集しない）。
- 詳細は [docs/specs/README.md](./specs/README.md) の「現在の有効な仕様書」表（login / pricing-consent /
  legal-cms / portal / keystore / apps-grid の各spec）による。

### 6-3. 本番アプリ群（Portal 掲載アプリ）

Portal（`/portal/`）に掲載する契約者向けアプリは、`public/production-app/<アプリID>/` に
1アプリ1ディレクトリで置く。現時点でのアプリと状態は次のとおり（状態は
`public/portal/app-registry.js` への掲載有無で判定）。

| アプリID | 概要 | Portal掲載 |
| --- | --- | --- |
| `receipt-ocr` | 領収書スキャナ。利用者のドライブに保存し、当社サーバーを通さない | 済 |
| `short-script` | ショート動画の台本メーカー | 済 |
| `audio-transcriber` | 音声文字起こし（端末内Whisper または利用者自身のGemini APIキー） | 済 |
| `voice-recorder` | ブラウザ録音（バックエンドなし。Google Drive「TSAM AI／Voice Recorder」へ保存） | 済 |
| `threads-post` | Threads 投稿の下書き・AI生成・intentリンク投稿 | 済 |
| `x-post` | X 投稿（Threads版の差分: 280ウェイト計数、x.com intent） | 済 |
| `note-post` | note 下書き（Threads版の差分: 本文コピー方式） | 済 |
| `meeting-minutes` | audio-transcriber の文字起こしをGeminiで議事録化し、根拠を原文照合で表示 | 済 |
| `card-ocr` | 名刺OCR・データ登録 | 未（要件定義段階） |
| `card-mail` | 名刺台帳の宛先へ利用者自身のGmailからBCC一斉送信 | 未（要件定義段階） |

共通の要求:

- **アプリ間で共通層（`shared/` `common/` `lib/`）を作らない。** 同じロジックが必要な場合は
  複製し、複製元パスと複製日をコメントで残す（[docs/repository-structure.md](./repository-structure.md) §4）。
- 外部AIサービスのAPIキーを扱うアプリは、KeyStore（`public/auth/keystore.js`）経由で
  端末内にのみ保持し、サーバーへ送らない。
- Google Drive を扱うアプリは `drive.file` スコープに限定し、アプリが作成していない
  ファイル・フォルダへは書き込めない前提で設計する。

### 6-4. 交流会申込アプリ

- 開催告知（`public/event/index.html`、静的）から申込（`app/event/apply/`）へ遷移し、
  Stripe決済を経て参加を確定できること。
- 金額はサーバー側（`lib/event/pricing.mjs`）で計算し、フォームから来た金額を信用しないこと。
- 運営が管理画面（`app/event/admin/`）から申込状況を確認・CSV出力できること。
- 受付停止は `events.is_published=false`（Supabase、即時）を正とし、静的ページの
  `data-event-status` は表示合わせであること。
- 詳細は [docs/vercel-migration.md](./vercel-migration.md)、[docs/event-app-database.md](./event-app-database.md)、
  [docs/event-admin.md](./event-admin.md) による。

## 7. 非機能要件

### 7-1. 性能・アクセシビリティ・SEO

Lighthouse で次を満たすこと（[README.md](../README.md) 「Lighthouse」節）。

- Performance 90以上、Accessibility 95以上、Best Practices 95以上、SEO 95以上
- コンソールエラー・警告がないこと

セマンティックHTMLとネイティブ要素を優先し、ARIAはネイティブ要素の代替として乱用しない。
アニメーションは `prefers-reduced-motion` に対応し、JavaScript無効時も本文閲覧・`details`開閉が
できること（[AGENTS.md](../AGENTS.md)）。

### 7-2. レスポンシブ

320 / 375 / 768 / 1024 / 1440px の各幅で、横スクロールや表示崩れがないこと。

### 7-3. セキュリティ

- 金額計算・受付可否の判定など、信頼境界をまたぐ判断はサーバー側で行い、クライアント値を
  信用しない（交流会アプリの金額計算、`events.is_published` の判定）。
- OAuthスコープは必要最小限（`drive.file` 等）に留め、勝手に増やさない。アクセストークンは
  メモリ上のみで保持し、localStorage / sessionStorage / Cookie / URL / ログに書かない。
- Supabase の全テーブルで RLS を有効にし、テーブル権限は `service_role` にのみ付与する
  （読み書きは必ずサーバー経由）。
- `docs/` は公開URLからは届かないが、リポジトリ自体は公開されている。鍵・トークン・
  スプレッドシートID・内部URL・実在するメールアドレスをドキュメント・コードのいずれにも
  書かない。
- 静的配信であるため、クライアント側ガードはアクセス制御の主手段になり得ない
  （`voice-recorder` の `guardPage()` は表示制御であり、データを守るのはOAuth側）。

### 7-4. デプロイ・運用

- 本番反映は `npm run deploy` による手動実行のみ。`main` への push だけでは公開されない。
- `gas-auth/*.gs` はエディタ保存だけでは公開反映されず、既存デプロイをバージョン更新する
  操作が別途必要。
- `legal/*/index.html` はスプレッドシート「TSAM AI 法務文書」からの生成物であり、
  手編集は次の公開操作で失われる。

### 7-5. テスト

- CIが実行するのは `npm test` のみ（`.github/workflows/test.yml`）。
- スイートは別プロセスで直列実行する（偽Apps Script環境やグローバルの差し替えの漏れ、
  Chromeのポート競合を避けるため）。
- `gas-auth/*.gs` は Node上の偽Apps Script環境（`tests/helpers/gas-harness.mjs`）で検証し、
  本番スプレッドシートには書き込まない。

## 8. 制約・前提

- 交流会申込アプリのロジックは外部SDKを使わず `fetch` でREST（Stripe / Supabase(PostgREST) /
  Gmail）を直接叩く。依存関係は `next` / `react` / `react-dom` のみ。
- 外部ライブラリの追加、既存ファイルの削除は、実行前に必ずユーザーへ確認する
  （[AGENTS.md](../AGENTS.md)）。承認済みの外部依存は [docs/external-dependency-approvals.md](./external-dependency-approvals.md) に記録する。
- 開催日時など重複して持つ値（`public/event/index.html` と `events.event_date`）は、
  更新時に両方を揃える。
- `docs/specs/` の仕様書・要件定義書は実装の正であり、コードと食い違う場合は原則コードの
  方が誤りとみなす。乖離を見つけたら黙認せず、両者を揃える。

## 9. 未確定事項

- OGP画像・`og:image`（[README.md](../README.md) 「未確定事項」節）
- `card-ocr` `card-mail` の Portal 掲載時期（要件定義段階。実装・受入完了後に判断）

## 10. 関連文書

| 目的 | 文書 |
| --- | --- |
| リポジトリ構成・同居領域の境界 | [docs/repository-structure.md](./repository-structure.md) |
| コーポレートサイトの内容・デザイン基準 | [SITE_SPEC.md](../SITE_SPEC.md) |
| 実装方針 | [AGENTS.md](../AGENTS.md) |
| 配信構成・デプロイ手順 | [docs/deployment-cloudflare.md](./deployment-cloudflare.md)、[DEPLOYMENT.md](../DEPLOYMENT.md) |
| 本番認証系のセットアップ | [AUTH_SETUP.md](../AUTH_SETUP.md)、[MANUAL_SETUP_CHECKLIST.md](../MANUAL_SETUP_CHECKLIST.md) |
| 本番認証系のセキュリティ制約 | [SECURITY_NOTES.md](../SECURITY_NOTES.md) |
| Stripe設定 | [STRIPE_SETUP.md](../STRIPE_SETUP.md) |
| 個別アプリ・機能の仕様書/要件定義書 一覧 | [docs/specs/README.md](./specs/README.md) |
| 交流会アプリのDB・管理画面・受入結果 | [docs/event-app-database.md](./event-app-database.md)、[docs/event-admin.md](./event-admin.md)、[docs/event-acceptance.md](./event-acceptance.md) |
| voice-recorder の要件 | [docs/requirements/mvp-requirements.md](./requirements/mvp-requirements.md) |

## 11. 変更履歴

| 日付 | 内容 |
| --- | --- |
| 2026-08-13 | 初版作成 |

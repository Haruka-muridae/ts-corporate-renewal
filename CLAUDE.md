# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

（以下、リポジトリの他文書に合わせて日本語で記述する。）

## コマンド

```powershell
npm run dev                       # Next.js 開発サーバー（http://localhost:3000/）
npm run build
npm run lint                      # public/apps/ 由来の既存エラーが多数出る（後述）
npm run typecheck                 # tsc --noEmit
npm test                          # public/apps/tests + tests の全スイート（Chrome 必須）
npm run test:auth-system:unit     # 本番認証系・交流会アプリの Node スイートのみ（Chrome 不要）
```

スイート単体で走らせるときは、ランナーに名前を直接渡す。

```powershell
node tests/run.mjs event-webhook          # tests/unit/event-webhook.mjs だけ
node tests/run.mjs unit                   # kind=unit のみ
node public/apps/tests/run.mjs auth       # groups に "auth" を含むスイート
```

スイート名は [tests/run.mjs](tests/run.mjs) と [public/apps/tests/run.mjs](public/apps/tests/run.mjs) の `SUITES` 配列にある。各スイートは別プロセスで直列に実行される（偽 Apps Script 環境やグローバルの差し替えが漏れるため、および Chrome のポート競合を避けるため）。Chrome が見つからないときは環境変数 `CHROME_PATH` を指定する。

CI（[.github/workflows/test.yml](.github/workflows/test.yml)）が実行するのは `npm test` のみ。`npm run lint` は `public/apps/` 配下の既存ファイル（ベンダーバンドル・ビルド済み成果物を含む）で多数のエラーを報告する状態が続いており、これは移行前からの既知の状態（[docs/vercel-migration.md](docs/vercel-migration.md) §4）。**自分が触った範囲に新しい警告を足さないことを基準にする。**

## 配信構成（ここを誤解すると壊れる）

**配信は Cloudflare Workers（OpenNext）。本番デプロイは手動で `npm run deploy`（= `opennextjs-cloudflare build && opennextjs-cloudflare deploy`）を実行して行う。`main` への push では自動デプロイされない**（GitHub Actions の `nextjs.yml` は無効化済み＝`nextjs.yml.disabled`。動いているのは `test.yml` のみ）。`wrangler.jsonc` の `main` は `.open-next/worker.js`（OpenNext生成物）。本番の応答ヘッダは `Server: cloudflare`。2026-08 に Vercel から Cloudflare Workers へ切替済み（手順は [docs/cloudflare-cutover.md](docs/cloudflare-cutover.md)）。

> **注意（2026-08-08 訂正）**: 以前この項は「Vercel が配信・`main` へのマージが本番公開」と書いていたが、**それは Cloudflare 切替前の古い記述**。DEPLOYMENT.md / docs/production-cutover.md / docs/vercel-migration.md にも同じ古い Vercel 前提が残っている（歴史的記録として保持）。

| URL | 実体 |
| --- | --- |
| `/`、`/apps/`、`/legal/`、`/login/`、`/portal/`、`/pricing/` など | `public/` 配下の静的HTML（ビルドしない従来サイト） |
| `/event/` | `public/event/index.html`（静的のまま） |
| `/event/apply/` 以降、`/event/admin/`、`/event/api/` | Next.js のルート（`app/event/`） |

[next.config.ts](next.config.ts) の要点は次の2つ。どちらも過去に実害が出た結果なので、変更前にファイル冒頭のコメントを読むこと。

- **`basePath` を使わない。** `basePath: "/event"` は `public/` の静的ファイルにも効くため、ルート（`/`）が404になる。
- **rewrites は `fallback` で返す。** `afterFiles` にするとルートハンドラより先に評価され、`/event/api/...` が `index.html` への書き換えに飲まれて404になる（実際に Webhook が届かなかった）。

`trailingSlash: true` のため、Stripe の Webhook は必ず末尾スラッシュ付き `https://tsam-ai.com/event/api/stripe/webhook/` で登録する。スラッシュなしへの POST は308になり、Stripe はリダイレクトを追わない。

> 配信構成の記述は [README.md](README.md) / [DEPLOYMENT.md](DEPLOYMENT.md) / [docs/repository-structure.md](docs/repository-structure.md) / [docs/vercel-migration.md](docs/vercel-migration.md) / [docs/production-cutover.md](docs/production-cutover.md) で揃えてある。ただし [docs/specs/README.md](docs/specs/README.md) 末尾には「GitHub Pages がルートを配信しているため `docs/` も公開される」という移行前の記述が残っている（現在 `docs/` は公開URLからは404。秘密情報を書かないという結論自体は、リポジトリがGitHubにある以上そのまま有効）。

## 共存している3つの独立したシステム

同じリポジトリ・同じドメインに、互いに独立した系が同居している。**片方の都合でもう片方を変えない。**

| | 本番認証系 | `/apps/`（テスト環境） | 交流会申込アプリ |
| --- | --- | --- | --- |
| 画面 | `public/login/` `public/portal/` `public/pricing/` `public/password/` `public/payment/` | `public/apps/` | `app/event/` |
| 共通JS | `public/auth/` | `public/apps/shared/` | `lib/event/` |
| バックエンド | Apps Script（`gas-auth/`）＋ Googleスプレッドシート | Apps Script（`public/gas/`）＋ Supabase（未接続） | Next.js サーバー ＋ Supabase（`tsam-event`） |
| セッションキー | `tsam-auth-session` | `tsam-ai-session` | Cookie `tsam-event-admin`（httpOnly、path `/event/admin`） |
| テスト | `tests/` | `public/apps/tests/` | `tests/`（`event-*` スイート） |

`gas-auth/*.gs` は配信されないソース。**エディタで保存しただけでは公開中の Web アプリに反映されない**ため、「デプロイを管理」から既存デプロイを新バージョンへ更新する（新規デプロイを作ると `/exec` URL が変わり、`public/auth/config.js` と Stripe の設定を直す必要が出る）。Node 上の偽 Apps Script 環境（[tests/helpers/gas-harness.mjs](tests/helpers/gas-harness.mjs)）で検証しており、本番スプレッドシートには書き込まない。

## 交流会申込アプリ（`app/event/` + `lib/event/`）

- **ビジネスロジックは `.mjs`、型は手書きの `.d.mts`。** 実装を `.mjs` に置いているのは、Node で `.mjs` を直接実行するテストランナーからそのまま読めるようにするため。`.d.ts` では TypeScript が `.mjs` の型として認識しないので `.d.mts` にしてある。ロジックを追加するときはこの対を守る（`tsconfig.json` は `allowJs: false`）。
- **外部SDKを使わない。** Stripe・Supabase(PostgREST)・Gmail いずれも `fetch` で REST を直接叩いている。`package.json` の dependencies は `next` / `react` / `react-dom` のみ。ライブラリ追加は [AGENTS.md](AGENTS.md) のとおり事前確認が必要。
- **環境変数は [lib/event/config.mjs](lib/event/config.mjs) を必ず経由する。** BOM・前後空白を落としたうえで、値が無ければ「使う時点で」名前付きの例外にする（起動時に全体を巻き添えにしない）。`SUPABASE_SERVICE_ROLE_KEY` に `NEXT_PUBLIC_` を付けない。`lib/event/db.mjs` は service role キーを扱うサーバー専用モジュールで、クライアントコンポーネントから import しないこと（`server-only` パッケージは入れていないので、呼び出し側を server action / server component に限定することで守っている）。
- **金額はサーバーが計算する。** フォームから来た金額は一切使わない。割引率は [lib/event/pricing.mjs](lib/event/pricing.mjs) の定数（DBにルールを持たせない方針）で、申込ごとの内訳は `payments` の列にスナップショットとして保存する。JPY は最小通貨単位が円なので `unit_amount` に円額をそのまま渡す（100倍しない）。
- **開催日時が2か所にある。** 静的な `public/event/index.html` と `events.event_date`。次回開催時は両方を更新する。受付を止めるときは `events.is_published=false`（即時・サーバー側の判定）を先に、`public/event/index.html` の `data-event-status` は表示合わせ。

### Supabase

- マイグレーションは [supabase/migrations/](supabase/migrations/) にあり、Supabase CLI（`supabase db push`）で適用する。ダッシュボードのSQL Editorは使わない。**適用済みのファイルは編集せず、新しいマイグレーションを追加する。**
- 全表で RLS を有効にし、ポリシーを1つも作っていない。加えてテーブル権限を `service_role` にのみ付与している（権限判定は RLS より前に走るため、これが無いと service_role でも permission denied になる）。読み書きは必ずサーバー側を通る。

## 名刺メール配信アプリ（`public/production-app/card-mail/`）

名刺OCRの台帳「名刺管理」から宛先を読み、**利用者自身のGmail**からBCCで一斉送信するブラウザ完結アプリ（サーバーコードなし）。要件は [docs/specs/card-mail-requirements-v1.md](docs/specs/card-mail-requirements-v1.md)。card-ocr と**同じクライアントIDを意図的に共用**する（drive.file はクライアントIDごとに見える範囲が分かれ、card-ocr が作った台帳を読むには同じIDが要る）。スコープは `drive.file` + `gmail.send` の2つのみで、**台帳は読むだけ・作らない・書かない**。トークンはメモリ上のみ。公開前に Google Cloud 側で gmail.send スコープの追加と審査が必要（同要件書 §6）。テストは `tests/unit/card-mail.mjs`。

## 生成物・退避物（手で編集しない／デプロイされない）

- `public/legal/{terms,privacy,tokusho}/index.html` は**スプレッドシート「TSAM AI 法務文書」からの生成物**。手編集は次の `publishLegalDocs()` で失われる。条文はスプレッドシートを直す。手編集を含む変更はレビューで差し戻す（[docs/specs/legal-cms-spec-v1.md](docs/specs/legal-cms-spec-v1.md)）。`docs/legal-source/*.md` は初期移行の原本で現在の正ではない。
- `lp-draft/` はリニューアル版LPのルートを退避したもの（`/`・`/legal` などが現行サイトと衝突するため）。`components/` `content/` `types/` `lib/seo.ts` `lib/metadata.ts` `lib/jsonld.ts` はこの退避版が参照しているだけで、稼働中の交流会アプリは使っていない。`potenitas-lp/` も別系統の静的LP。
- `labs/`（未作成）は TSAM AI と無関係な同居プロジェクト用。共通資産を参照させない・本体から触らないという境界が [docs/repository-structure.md](docs/repository-structure.md) で宣言されている。

## ブラウザ録音アプリ（`public/production-app/voice-recorder/`）

- **正式な要件は [docs/requirements/mvp-requirements.md](docs/requirements/mvp-requirements.md)。** 実装・修正時は必ず同文書の §5〜§10 に準拠する。要件と矛盾する実装判断が必要になったときは、**勝手に進めず必ず確認を取る**（判断した内容は §14 の変更履歴へ残す）。
- **バックエンドを持たない。** 要件書 v1.1 はサーバー側 MP3 変換とAPI 8本を前提にしていたが、Vercel の関数では 90分・約86MB の受信と FFmpeg 実行が成立しないため、v1.2 でブラウザ完結へ改めた。**「APIを足せば解決する」と考える前に §14 を読むこと。**
- **`public/apps/voice-recorder/`（テスト環境）から import しない。** 長時間録音の実装はそこから**複製**してある（[docs/repository-structure.md](docs/repository-structure.md) §1）。テスト環境側を直しても本番には反映されないし、その逆もない。
- **保存先フォルダ名は「マイドライブ ＞ TSAM AI ＞ Voice Recorder」。** 音声文字起こしアプリが同じ場所を読みに来るため、名前を変えると両方を同時に変える必要がある。フォルダは**IDで固定登録せず、名前から解決して無ければ作成する**（`drive.file` スコープでは、アプリが作成していないフォルダへ書き込めないため）。
- **OAuth スコープは `drive.file` のみ。増やさない。** アクセストークンはメモリ上だけで保持し、localStorage / sessionStorage / Cookie / URL / ログのいずれにも書かない（`receipt-ocr` と同じ方針）。クライアントIDは公開値で、実質的な防御は Google Cloud 側の「承認済みの JavaScript 生成元」。
- **アクセス制御はクライアント側ガード（`guardPage()`）が主。** 静的配信のため HTML と JS の取得自体は防げない（[SECURITY_NOTES.md](SECURITY_NOTES.md)）。Drive のデータを守っているのは OAuth であって、このガードではない。

## 仕様書が実装の正

- [docs/specs/](docs/specs/) の仕様書は**実装の正**。コードと食い違う場合、既定ではコードのほうが間違いとみなす。乖離を見つけたら黙って放置せず、仕様書と実装のどちらを直すか決めて**両方が揃った状態**にする。判断できない場合は実装せずに報告する。参照はセクション番号（§n）で行い、行番号は使わない。各仕様書には「採用しなかった提案とその理由」の節があるので、仕様変更の提案前に読む。
- コーポレートサイト側（`public/index.html` ほか）の掲載内容・デザイン・アクセシビリティ・SEO の基準は [SITE_SPEC.md](SITE_SPEC.md)。
- `docs/` はそのまま公開される。**鍵・トークン・スプレッドシートID・内部URL・実在するメールアドレスを書かない。**

## 作業上の約束（[AGENTS.md](AGENTS.md)）

- 既存ファイルの削除、外部ライブラリの追加は、実行前に必ず確認を取る。
- 会社情報・実績・年・数値・固有名詞を推測または改変しない。canonical URL・OGP画像・favicon など未確定の値は埋めずに TODO のまま残す。
- セマンティックHTMLとネイティブ要素を優先する。ARIA をネイティブ要素の代替にしない。アニメーションは `prefers-reduced-motion` に対応する。
- レスポンシブは 320 / 375 / 768 / 1024 / 1440px で確認する。
- 静的サイト側は ES モジュールを使うため `file://` では動かない。`py -m http.server 8000` などHTTP経由で開く。
- コード内のコメントとドキュメントは日本語。「何をしているか」より「なぜそうしたか（と、採らなかった選択肢）」を書く既存の書き方に合わせる。

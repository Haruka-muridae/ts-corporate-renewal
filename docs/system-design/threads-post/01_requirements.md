# Threads 投稿アプリ（threads-post）要件定義書

作成: 2026年8月18日

> 本書は `docs/system-design/_authoring-guide.md` の規約に従う。実装と
> [docs/specs/threads-mvp-requirements-v1.md](../../specs/threads-mvp-requirements-v1.md)（以下「仕様書」）が正であり、
> 本書は移植を検討する読者向けに要点を整理したものである。詳細は仕様書の該当 §番号を参照する。

## 1. 目的・背景

TSAM AI の利用者が、Threads への投稿文を「書く／貼る／AIで作る」→ 下書きとして残す
→ 本文入りの Threads 投稿画面を開いて投稿する、を1画面で行えるようにする
（仕様書 §2）。予約投稿・複数媒体・分析・画像投稿は持たない。

設計の重点は次の順（仕様書 §2）。

1. **最後の「投稿」は必ず人が押す。** Threads の API・トークンを使わず、本文入りの
   投稿画面（intent リンク）を別タブで開くだけにとどめる。誤投稿・二重投稿が
   構造的に起きない。
2. 投稿文・下書き・履歴を**利用者の管理下から出さない。** 端末内（localStorage）保存
   のみで、当社サーバーへの送信はゼロ（名刺OCR・領収書スキャナと同じ設計原則）。
3. AI 生成は補助にとどめる。生成しただけでは何も起きず、保存・投稿は必ず人の操作。

v2.x までは「発注者本人専用の GAS アプリ」（`gas-threads/`。Threads Graph API ＋
長期トークン方式）だったが、v3.0（2026-08-12）で Portal 掲載の本番アプリへ
全面変更した（仕様書 §1.1）。旧実装は削除せず**旧版として** `gas-threads/` に
保管されており、対応するテストスイート `threads-mvp`（`tests/unit/threads-mvp.mjs`）
も別に存在する。旧実装・旧スイートは本書のスコープ外。

## 2. 用語定義

| 用語 | 意味 |
| --- | --- |
| intent リンク | 本文をクエリパラメータへ載せた投稿画面URL（`https://www.threads.com/intent/post?text=…`）を開くだけの投稿方式。API・トークンを使わない。 |
| BYOK | Bring Your Own Key。利用者本人が発行した Gemini APIキーを利用者自身が使う方式。当社は預からない。 |
| KeyStore | `public/auth/keystore.js`。Gemini APIキーをブラウザの localStorage（キー名 `tsam-api-keys`）へ保存する共通モジュール。 |
| guardPage | `public/auth/session.js` が提供する、保護対象ページの入口関数。サーバー検証が済むまで画面内容を描画させない。 |
| 書き方の調整プロンプト | 文体・トーンなどの指示を端末内に自動保存し、以後の生成のたびにテーマより前へ差し込む利用者設定（v3.1・仕様書 §3.6）。 |
| 履歴 | 「投稿画面を開いた」事実を記録したもの。intent 方式では実際に投稿されたかを観測できないため、記録範囲はここまで（仕様書 §3.5）。 |

## 3. スコープ

### 3.1 対象

- 投稿文の入力・検証・intent リンクによる投稿画面表示（仕様書 §3.2〜3.3）。
- 下書きの保存・呼び出し・削除（仕様書 §3.4）。
- 履歴の記録・一覧・直近100件への切り詰め（仕様書 §3.5）。
- Gemini による投稿文生成と、書き方の調整プロンプト（仕様書 §3.6）。
- Portal への掲載（`public/portal/app-registry.js` の `threads-post`）と `guardPage()` による認証（仕様書 §3.1）。

### 3.2 対象外

- Threads Graph API・長期トークンによる無人投稿（v1.0 の方式。仕様書 §9）。
- 予約投稿・予約リマインダー（v2.x の「自分宛メール」方式を含む）。全く別機能として
  将来実装する方針で、`gas-threads/` を下敷きにする想定だが**未着手**（仕様書 §1.1, §9, §10）。
- 複数媒体（X・note 等）への同時投稿。X版・note版はそれぞれ独立した別アプリ
  （`x-post`／`note-post`）として存在し、本アプリとは import し合わない（§9）。
- 分析・投稿実績の集計。intent 方式では「本当に投稿されたか」自体を観測できない
  （仕様書 §3.5）。
- 画像投稿。
- 下書き・履歴の Drive/Sheets 保存や端末をまたいだ共有（仕様書 §9）。
- Gemini APIキーの入力UIをこのアプリ自身に持つこと（KeyStore の一元管理に統一。仕様書 §9）。

## 4. 利用者とロール

| 利用者 | 前提 | 制約 |
| --- | --- | --- |
| ログイン済みの一般利用者（TSAM AI 利用ユーザー全員） | `guardPage()` によるサーバー検証済みセッション（`tsam-auth-session`） | 未ログインはログイン画面へ強制遷移。中身（`#tp-content`）は描画されない。 |
| AI生成を使う利用者 | 上記に加え、KeyStore に自分の Gemini APIキーを保存済み（`KeyStore.has('gemini')`） | 未設定時は Portal への案内を表示し、生成以外（書く・貼る・下書き・投稿）は制約なく使える。 |

ロールによる権限分岐（管理者／一般利用者の区別など）は存在しない。

## 5. 機能要件

| ID | 要件 | 補足 |
| --- | --- | --- |
| FR-01 | Portal（`public/portal/app-registry.js`）にアプリID `threads-post` で掲載する | `id` は後から変えない（apps-grid-spec-v1.md §5-1）。`href` はルートからの相対パス。 |
| FR-02 | ページ自身で `setScreenDepth(2)` と `guardPage()` を行い、利用者が返るまで中身を描画しない | app-registry.js 冒頭の約束（仕様書 §3.1）。 |
| FR-03 | テキストエリアで投稿文を書く／貼り付け、コードポイント基準の文字数カウント（上限500字）を常時表示する | 超過は赤く示す（仕様書 §3.2）。 |
| FR-04 | 投稿前に本文を検証し、空または500字超なら intent リンクを開かない | 検証結果は例外ではなく文字列（エラーメッセージ／null）で返す（仕様書 §3.2）。 |
| FR-05 | 「Threads で投稿」で、本文入りの投稿画面を別タブ（`noopener,noreferrer`）で開く | Threads へ `fetch` はしない。最後の「投稿」は利用者が押す（仕様書 §3.3）。 |
| FR-06 | 投稿画面を開いた事実を、日時・本文つきで履歴へ記録し新しい順に表示する | 「本当に投稿されたか」は観測できないため記録範囲を画面に明記する。保持は直近100件、超過分は古い順に破棄（仕様書 §3.5）。 |
| FR-07 | 「下書き保存」で localStorage（`tsam-threads-post-v1`）へ追記し、一覧から呼び出す／削除（確認あり）できる | localStorage 不可環境では保存不可を案内したうえで、書く・生成する・投稿画面を開くだけは動かす。壊れた保存データは読み捨てて次の保存で作り直す（仕様書 §3.4）。 |
| FR-08 | 「テーマ・指示」（上限100字）から Gemini で投稿文を1本生成し、テキストエリアへ入れる | 下書き・履歴へは自動で書かない。入力中の本文がある場合は置き換え前に確認する（仕様書 §3.6）。 |
| FR-09 | 生成時、500字以内・創作の禁止・投稿文そのものだけの出力をプロンプトで課し、コードフェンスを剥がす | 超過した場合は FR-04 の検証が止める（仕様書 §3.6）。 |
| FR-10 | 「書き方の調整」欄の入力を端末内へ自動保存し、以後の生成のたびにテーマより前へ差し込む | 下書き・履歴と同じ保存場所（`STORAGE_KEY`）を使うため、それらの操作では消えない。空にすれば使われない（v3.1・仕様書 §3.6）。 |
| FR-11 | Gemini APIキー未設定時は生成ボタンを塞がず、キー未設定エラー時に Portal への案内を示す | キー入力欄はこのアプリに作らない（仕様書 §3.6, §9）。 |

## 6. 非機能要件

### セキュリティ

- NFR-01: 投稿文・下書き・履歴は当社サーバーへ一切送信しない。送信先は Gemini（生成時のみ）と認証確認（Apps Script／auth-verify Worker）に限る（仕様書 §7、index.html の CSP コメント）。
- NFR-02: Gemini APIキーは KeyStore の外で localStorage を直接扱わない。値を読むのは生成の瞬間のみでモジュールに保持しない（仕様書 §3.6、gemini.js 冒頭コメント）。
- NFR-03: CSP はページごとに `<meta>` で宣言する。`connect-src` は `'self'` ／ Gemini ／ 認証系（`script.google.com`・`script.googleusercontent.com`・`auth-verify.potenitas-lp.workers.dev`）のみで、`threads.net`／`threads.com` を含めない（Threads へは `fetch` しないため。index.html）。
- NFR-04: DOM 組み立ては `createElement`／`textContent` を用い、`innerHTML` は使わない（リポジトリ共通方針。app.js 全体）。

### 性能

- 特筆すべき性能要件はない（サーバー処理を持たない静的アプリであり、Gemini 呼び出し以外は端末内処理のみ）。

### 可用性

- NFR-05: localStorage が使えない環境（プライベートモードの一部等）でも、書く・生成する・投稿画面を開く操作は動作を続ける。保存（下書き・履歴・調整プロンプト）だけが効かない旨を画面に案内する（仕様書 §3.4）。
- NFR-06: 壊れた保存データ（JSON破損・型不正）は読み捨て、次の保存で作り直す。アプリを止めない（post.js `readState`）。

### 運用

- NFR-07: 本番アプリ間で共通層を作らない方針（[repository-structure.md](../../repository-structure.md) §4-1）に従い、`gemini.js` のエラー分類・`post.js` の保存ロジックは同型の姉妹アプリ（`x-post`／`note-post`）との間で複製する。import はしない。
- NFR-08: 配信は本リポジトリの `main` への反映と手動デプロイ（`npm run deploy`）のみ。Meta・Google Cloud 側の作業は無い（OAuth（GIS）を使わないため。仕様書 §8）。

### アクセシビリティ

- NFR-09: セマンティックHTML、`role="status"`／`aria-live="polite"` によるメッセージ読み上げ、`prefers-reduced-motion` への配慮（style.css、AGENTS.md）。
- NFR-10: 320／375／768／1024／1440px のレスポンシブ確認（AGENTS.md）。

## 7. 制約条件

- サーバーコードを持たない静的アプリであること（BYOK・端末内保存原則の帰結）。
- Portal と同一オリジンに配置すること（KeyStore・guardPage 参照の必須条件）。
- 外部ライブラリを追加しないこと。素の ES モジュールと `fetch` のみを使う。
- `public/production-app/` 配下でアプリ間の共通層（`shared/`／`common/`／`lib/`）を作らないこと。同じロジックが要る場合は複製し、複製元パスと複製日を冒頭コメントに書く（[repository-structure.md](../../repository-structure.md) §4-1）。
- Threads の API・長期トークンを使わないこと（構造的に誤投稿・二重投稿を起こさないための方式選択。仕様書 §2, §9）。
- `APP_REGISTRY`（`public/portal/app-registry.js`）の `id` はあとから変更しないこと。
- `href` は相対パスとし、先頭 `/` を付けないこと（apps-grid-spec-v1.md §5）。

## 8. 外部依存

| 依存先 | 用途 | 認証・鍵の扱い |
| --- | --- | --- |
| Gemini API（`generativelanguage.googleapis.com`） | 投稿文の生成（`generateContent`） | 利用者本人の APIキーを `x-goog-api-key` ヘッダーで送信（BYOK）。当社は預からない。 |
| Apps Script 認証API（`script.google.com`／`script.googleusercontent.com`） | `guardPage()` のセッション検証・ログアウト（`public/auth/api.js` 経由） | 当社の認証基盤。エンドポイントURLは秘密情報ではないが、本書には値を書かない。 |
| auth-verify Worker（`auth-verify.potenitas-lp.workers.dev`） | セッション検証のキャッシュ付き代理（`public/auth/config.js` の `verifyApiUrl`） | 判定はしない代理。有効性の根拠は引き続き Apps Script 側にある。 |
| Threads（`www.threads.com`） | intent リンクによる投稿画面の表示のみ | 認証は Threads 側（未ログインなら Threads がログインへ誘導）。本アプリからの `fetch`・トークン送信はしない。 |

このアプリは Google OAuth（GIS）を使わない（仕様書 §4）。

## 9. 前提条件・未確定事項

- **本番デプロイの完了状況は未確定。** 仕様書 §10（残課題）は「コミットと本番デプロイ（`npm run deploy`）」を執筆時点で「未了」と記す。本書はコード・仕様書から読み取れる設計を対象とし、実際に本番配信済みかどうかは本書の調査範囲外。
- Threads の intent リンク先ドメインは `www.threads.com`（config.js。2026-08-12 の実機確認で `threads.net` からのリダイレクトを確認したうえでの選定）。Threads 側の仕様変更で再度変わりうるため、継続的な実機確認が要る旨は仕様書側にも明記が無く、運用上の未確定事項として扱う。
- 予約リマインダーの別機能としての要件定義（旧実装 `gas-threads/` が下敷き）は仕様書 §10 のとおり未着手（別件）。本書のスコープ外。
- 仕様書 §10 に記載のある「gas-isso 側の共通書き込み口への「=」始まりエスケープ」は、本アプリ（threads-post）自体のコードには現れない別システムの残課題であり、本書では言及のみにとどめる（詳細未調査）。
- 実 Gemini API が本アプリのプロンプト仕様どおりの応答を返すことは、同型実装（他の本番アプリの gemini.js）で確認済みだが、本アプリ単体での実API疎通は本書作成時点で未検証。

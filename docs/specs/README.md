# 仕様書ディレクトリ

このディレクトリの仕様書は、**実装の正**です。

コードと仕様書が食い違っている場合、コードのほうが間違っているとみなすのが既定の解釈です。
実装を進める際は、まず該当する仕様書を読んでください。

---

## 現在の有効な仕様書

| 仕様書 | 対象範囲 | 版 |
| --- | --- | --- |
| [login-page-detailed-spec-v3.md](./login-page-detailed-spec-v3.md) | `/login/index.html` ＋ `public/auth/` 共通層 ＋ `gas-auth/`（ログイン関連部分） | v3.2 |
| [pricing-consent-spec-v1.md](./pricing-consent-spec-v1.md) | `/pricing/` の同意フロー ＋ `gas-auth/Consent.gs` ＋ `/legal/` 3ページ | v1 |
| [legal-cms-spec-v1.md](./legal-cms-spec-v1.md) | 法務文書のスプレッドシート管理 ＋ `gas-auth/Legal.gs` ＋ `/legal/` の生成と公開 | v1 |
| [portal-spec-v1.md](./portal-spec-v1.md) | `/portal/` のレイアウトと表示条件 | v1.4 |
| [keystore-spec-v1.md](./keystore-spec-v1.md) | 外部AIサービスのAPIキーの保管（`public/auth/keystore.js`）。端末内のみ・サーバーへ送らない | v1 |
| [apps-grid-spec-v1.md](./apps-grid-spec-v1.md) | `/portal/` のアプリグリッド（ページ式）と配置データ ＋ `public/portal/app-registry.js` | v1 |
| [receipt-ocr-v2.md](./receipt-ocr-v2.md) | 領収書スキャナ（`public/production-app/receipt-ocr/`。アプリID `receipt-ocr`）。利用者のドライブに保存し、当社サーバーを通さない | v2.0（ドラフト） |
| [receipt-ocr-v1.3.md](./receipt-ocr-v1.3.md) | 上の前身。**抽出・検証の仕様（10・11・13・14・15・16.1・18.2章）は現役**で、v2.0 がここを参照する | v1.3 |
| [short-script-spec-v1.md](./short-script-spec-v1.md) | ショート動画 台本メーカー（`public/production-app/short-script/`。アプリID `short-script`）。テーマ/貼り付け/セグメントから台本を作り、ローカル補助サービスで音声・動画化 | v1.4 |

> `receipt-ocr-v1.3.md` にはサーバー（GAS）前提の記述が残っています。
> **アーキテクチャは v2.0 が正**であり、v1.3 のうち参照してよいのは
> v2.0 §7 / §9.1 が名指しする章に限ります。2段階フロー・idempotencyKey・
> LockService・APIトークン・処理台帳は実装しません。

参照するときは、セクション番号（§n）で指し示してください。
行番号は変わるため使いません。

これらの仕様書が対象とするのは **TSAM AI 本体** です。
同居する別プロジェクト（`labs/`）はスコープ外とします
（[../repository-structure.md](../repository-structure.md)）。

---

## 現在の有効な要件定義書

要件定義書は、**まだ実装が存在しない機能について「何を作るか」を決めた文書**です。
実装済みの挙動を規定する上の仕様書とは、位置づけが異なります。

| 要件定義書 | 対象範囲 | 版 |
| --- | --- | --- |
| [meishi-ocr-requirements-v3.md](./meishi-ocr-requirements-v3.md) | 名刺OCR・データ登録Webアプリ（`public/production-app/card-ocr/`。アプリID `card-ocr`）＋ Portal への掲載（`public/portal/app-registry.js`） | v3.5 |
| [card-mail-requirements-v1.md](./card-mail-requirements-v1.md) | 名刺メール配信アプリ（`public/production-app/card-mail/`。アプリID `card-mail`）。名刺OCRの台帳から宛先を読み、利用者自身のGmailからBCCで一斉送信する | v1.1 |
| [auth-registration-production-v1.md](./auth-registration-production-v1.md) | 本番認証系の初回登録フロー（料金→Stripe決済→利用者作成→初期設定）を Stripe テストモードからライブモードへ切り替える要件。コード変更なしの設定作業 | v1.0 |
| [audio-transcriber-requirements-v1.md](./audio-transcriber-requirements-v1.md) | 音声文字起こしアプリ（`public/production-app/audio-transcriber/`。アプリID `audio-transcriber`）。端末内Whisper または利用者自身の Gemini APIキー（KeyStore 経由）で文字起こしし、ブラウザ録音アプリの録音を drive.file のまま読む | v1.1 |
| [threads-mvp-requirements-v1.md](./threads-mvp-requirements-v1.md) | Threads 投稿アプリ（`public/production-app/threads-post/`。アプリID `threads-post`）＋ Portal への掲載。下書き（端末内保存）・AI生成（KeyStore 経由の Gemini）・intent リンクでの投稿・履歴のみの単機能アプリ。Threads 側の API・トークン不使用。旧 GAS 版は `gas-threads/`（保管） | v3.1 |
| [x-post-requirements-v1.md](./x-post-requirements-v1.md) | X 投稿アプリ（`public/production-app/x-post/`。アプリID `x-post`）。Threads 版の差分仕様: 280ウェイト計数（全角=2）と x.com intent | v1.0 |
| [note-post-requirements-v1.md](./note-post-requirements-v1.md) | note 下書きアプリ（`public/production-app/note-post/`。アプリID `note-post`）。Threads 版の差分仕様: 本文コピー＋作成画面を開く方式（note にプリフィルURLが無いため）と記事向け生成 | v1.0 |
| [meeting-minutes-requirements-v1.md](./meeting-minutes-requirements-v1.md) | AI議事録アプリ（`public/production-app/meeting-minutes/`。アプリID `meeting-minutes`）。audio-transcriber の文字起こしをGeminiで議事録へ整理し、原文と並べて確認・編集できる。根拠（evidence）はクライアント側で原文照合し、確認できない場合は「根拠を確認できません」と表示する | v1.0 |

要件定義書も**実装の正**です。上の仕様書と同じく、コードと食い違う場合は
コードのほうが間違っているとみなします。

実装が進み、挙動が固まった範囲については、要件定義書とは別に仕様書を起こして
上の表へ移すか、要件定義書自体を仕様書として扱うかを、そのときに決めます。
**両方に同じことを書いて二重管理しないでください。**

### 付随する計画書

| 文書 | 内容 |
| --- | --- |
| [card-ocr-phase0-plan.md](./card-ocr-phase0-plan.md) | 名刺OCRアプリのフェーズ0（方式検証PoC）の実行計画。テスト環境 `card-scanner` の監査結果、検証項目の仕分け、事業者側の作業手順 |
| [card-ocr-terms-and-help-draft.md](./card-ocr-terms-and-help-draft.md) | 名刺OCRの利用規約への追加条項案とアプリ内ヘルプの文面案（§14.5）。**まだ公開されていない案**であり、法務確認の材料 |

計画書は要件定義書の**下位**です。食い違う場合は要件定義書が正。

---

## `legal/*/index.html` は生成物です

`legal/terms/index.html` `legal/privacy/index.html` `legal/tokusho/index.html` を
**手で編集しないでください。** スプレッドシート「TSAM AI 法務文書」から生成され、
次の公開操作で上書きされます。

これらのファイルへの手編集を含む変更は、取り込まずに差し戻してください。
条文の修正はスプレッドシート側で行い、`publishLegalDocs()` で公開します。
詳細は [legal-cms-spec-v1.md](./legal-cms-spec-v1.md) §1-1 を参照してください。

関連する作業指示書は [../instructions/](../instructions/) にあります。

実装が**どう出来ているか**を記述した詳細設計書は [../design/](../design/) にあります。
仕様書・要件定義書（何を作るか）が正で、詳細設計書はその下位です。
同じことを両方へ書かないでください。

---

## 仕様書と実装が食い違ったときのルール

**黙って乖離させないこと。** 食い違いを見つけたら、次のいずれかを選び、
**仕様書と実装の両方が揃った状態**にしてから作業を終えます。

| 判断 | 行うこと |
| --- | --- |
| 仕様書が正しい | 実装を仕様書に合わせる |
| 実装が正しい | 仕様書を実装に合わせて更新する（理由を本文へ残す） |
| どちらとも決められない | 実装せずに、判断が必要な点として報告する |

「実装がこうなっているから」という理由だけで仕様書を書き換えないでください。
逆に、「仕様書にこう書いてあるから」という理由だけで、
安全性に関わる実装を変えないでください。

各仕様書には設計判断の記録（採用しなかった提案とその理由）を含む節があります。
仕様を変えようとする前に、その節を読んでください。
一度検討して却下された案を、理由を知らずに再提案することを避けるためです。

---

## このディレクトリの内容は読まれる前提で書きます

サイトの配信は Vercel（Next.js）で、公開URLから読めるのは `public/` 配下と
`app/` 配下のルートだけです。**`docs/` は公開URLからは404になります**
（2026年8月1日の切替まではリポジトリのルートを GitHub Pages が配信しており、
`docs/` もそのまま公開されていました。[../production-cutover.md](../production-cutover.md)）。

**それでも結論は変わりません。秘密情報（鍵・トークン・スプレッドシートID・内部URL・
実在するメールアドレス）を仕様書へ書かないでください。**
配信されなくなっただけで、内容は GitHub のリポジトリ上で読めます。
一度コミットすれば履歴にも残り、あとから消しても取り消せません。
追加・更新の際は、配置前に確認してください。

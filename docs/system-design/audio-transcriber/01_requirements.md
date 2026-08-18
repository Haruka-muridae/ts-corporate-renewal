# 音声文字起こしアプリ（audio-transcriber）要件定義書

## 1. 目的・背景

TSAM AI の利用者が、端末内の音声ファイルまたはブラウザ録音アプリ（`voice-recorder`）が
Google ドライブへ保存した録音を、**自分の端末内で、または自分の Gemini APIキーで**
文字起こしできるようにする。

ブラウザ録音アプリにより、録音（MP3）は利用者の「マイドライブ ＞ TSAM AI ＞ Voice Recorder」に
貯まる。次の課題は「録音の文字化」である。外部の文字起こしサービスへ音声を渡すと、内容（会議・商談）が
第三者のサーバーを経由するため、端末内で完結する選択肢を既定にする。サーバーで変換・文字起こしを
行う方式は、長時間音声（90分・約86MB）の受信と処理が静的構成のホスティングでは成立しないため
採らない（ブラウザ録音アプリが v1.2 でブラウザ完結へ改めたのと同じ判断）。

本アプリは**サーバーコードを持たない**（静的フロントエンドのみ）。当社サーバーはどこにも登場しない。

実装済みの詳細は既存仕様書
[docs/specs/audio-transcriber-requirements-v1.md](../../specs/audio-transcriber-requirements-v1.md)
（以下「既存仕様書」）を正とする。本書は既存仕様書を要件定義〜詳細設計の章立てへ再構成した
ものであり、内容を置き換えない。FR番号は既存仕様書 §9 の番号をそのまま踏襲する。

## 2. 用語定義

| 用語 | 意味 |
| --- | --- |
| drive.file | 「そのクライアントIDのアプリが作成したファイルだけ」に絞ったGoogle Driveの権限スコープ。録音を読める根拠 |
| トークンモデル | リフレッシュトークンを持たず、短命のアクセストークンだけで動くOAuthの形。静的サイト向け |
| Transformers.js | ブラウザ内で機械学習モデルを動かすライブラリ。Whisper の実行に使う（バージョン4.2.0固定） |
| WASM回避策 | Transformers.js 4.2.0 同梱の ONNX Runtime の不具合を避けるための `graphOptimizationLevel: 'basic'` 指定 |
| Voice Recorder フォルダ | 利用者のドライブ「TSAM AI」直下の、録音アプリの保存先フォルダ。本アプリは読むだけで作らない |
| Audio Transcriber フォルダ | 利用者のドライブ「TSAM AI」直下の、本アプリの結果TXT保存先。初回保存時に作成する |
| KeyStore | Gemini APIキーを端末内 `localStorage` にのみ保管する共通機構（`public/auth/keystore.js`）。ポータルの「API設定」から利用者が登録する |
| guardPage | `public/auth/session.js` が提供する、TSAM AIログインセッションを検証してから画面を描画する共通の入口関数 |
| Portal | TSAM AIのアプリ一覧画面（`public/portal/`）。本番アプリはここから起動する |

## 3. スコープ

### 3.1 含む

- 端末からの音声選択（MP3 / WAV / M4A / AAC / OGG / WebM / FLAC）
- Drive の Voice Recorder フォルダからの音声選択（一覧・取得）
- 端末内 Whisper 文字起こし（モデル選択・言語選択・タイムスタンプ・5分区間分割・進捗表示・中止）
- Gemini API 文字起こし（モデル自動選択・アップロード後の削除）
- 結果の編集・コピー・TXTダウンロード・Drive保存・話者名の一括置換

詳細は既存仕様書 §7.1。

### 3.2 含まない（現時点の判断）

| 機能 | 含めない理由（要約） |
| --- | --- |
| Google Picker（ドライブ全体からの選択） | 固定フォルダで足りる。CSPの追加許可が要る |
| アプリ内でのキー入力・登録UI | 登録・変更・削除はポータル「API設定」（KeyStore）に一本化する |
| 話者分離（端末内モード） | Whisper 単体では不可。Gemini モードで代替 |
| リアルタイム文字起こし | 録音済みファイルの変換で足りる |
| サーバー側での変換・キュー | 「当社サーバーへ送信ゼロ」の原則が崩れる |

理由の詳細は既存仕様書 §7.2、§12。

## 4. 利用者とロール

- TSAM AI のログインユーザー全員（`guardPage()` を通過した利用者）。ロールによる機能差はない。
- Drive 連携（Voice Recorder フォルダの読み取り、Audio Transcriber フォルダへの保存）を使う場合、
  利用者がブラウザ録音アプリで録音を保存済みで、対象フォルダが存在すること（§9）。
- Gemini モードを使う場合、利用者が Google AI Studio で発行した自分のAPIキーを、ポータルの
  「API設定」で登録済みであること。本アプリにキーの入力欄は無い（既存仕様書 §10）。

## 5. 機能要件

既存仕様書 §9 の番号をそのまま踏襲する。

| ID | 要件 | 補足 |
| --- | --- | --- |
| FR-01 | 画面ガード | `guardPage({ next: 'portal' })` を通過するまで内容を描画しない（`voice-recorder` と同じ方式） |
| FR-02 | Google連携 | スコープは `drive.file` の1つのみ。クライアントIDは録音アプリ・領収書スキャナと同一（`drive.file` は同一OAuthクライアントが作成したファイルしか見えないため）。同一性は単体テストで突き合わせる。トークンはメモリ上のみ保持し、Storage・URL・console へ出さない |
| FR-03 | フォルダの特定（読み取り元は作らない・保存先は作る） | フォルダIDをコードに書かず、毎回「名前と親の関係」から1階層ずつ解決する。全クエリに `in parents` を含める。フォルダ名は `config.js` の `DRIVE_NAMES` に定義し、録音アプリ側 `voice-recorder/config.js` の同名定義と一致させる（一致を単体テストで検知）。読み取り元（Voice Recorder）は見つからなくても作らない。保存先（Audio Transcriber）は初回TXT保存時に作成する |
| FR-04 | 音声の取得と検証 | 取得元は「端末」と「Voice Recorder フォルダ直下」の2つのみ。Drive一覧は更新日時の新しい順。MIMEが空・octet-streamの場合は拡張子でも音声判定する。選んだファイルは必ずBlobとして取得する（DriveのURLをGeminiへ渡さない）。401は「利用許可の期限切れ」、403は「アカウント・権限の確認」を促す専用文言で出し分ける |
| FR-05 | 端末内文字起こし | 音声を16kHzモノラルへ変換し、`segmentSeconds`（5分）ごとに区切ってWeb Workerで順に処理・連結する。WASM時は `graphOptimizationLevel: 'basic'` を必須とし、WebGPU失敗時はWorkerごと作り直してWASMで再挑戦する。中止（AbortController）後に再実行できる |
| FR-06 | Gemini文字起こし | APIキーは `x-goog-api-key` ヘッダーで送る。アップロードしたファイルは成功・失敗・中断いずれでも削除する。APIのエラーメッセージを画面へそのまま出さず、HTTPステータス・エラーコードから日本語文言へ変換する。429は「無料枠または利用上限を超えました」とする |
| FR-07 | 結果の書き出し | TXTはUTF-8・BOM無し。ファイル名は元の音声名の拡張子を `.txt` へ差し替え、パス区切りとOSで使えない文字を落とす。話者名の置換は行頭（またはタイムスタンプ直後）の「話者n：」だけを対象にし、本文中の同じ語は変えない |
| FR-08 | 制限値 | 端末内モード：512MB／4時間、Geminiモード：200MB／2時間。上限は `config.js` の `LIMITS` で一元管理し、単体テストで固定する |

各要件の背景・理由は既存仕様書 §9 を参照。

## 6. 非機能要件

| ID | 分類 | 要件 |
| --- | --- | --- |
| NFR-01 | セキュリティ | Google OAuthアクセストークンはメモリ上（`oauth.js` のクロージャ変数）にのみ保持し、localStorage・sessionStorage・Cookie・URL・console のいずれにも出さない（既存仕様書 §11、§FR-02） |
| NFR-02 | セキュリティ | Gemini APIキーはKeyStore（端末内 `localStorage` のみ）で管理し、画面が読むのは実行直前の `KeyStore.get()` 1回だけとする。モジュール変数・DOM・状態・console のどこにも保持しない。当社サーバー（GAS）へは送らない（既存仕様書 §10、[keystore-spec-v1.md](../../specs/keystore-spec-v1.md) §2・§2-1） |
| NFR-03 | セキュリティ | 通信先はページ限定CSP（`index.html` の `<meta>`）で固定する。許可先はjsDelivr／Hugging Face（Transformers.js・Whisperモデル取得）、`generativelanguage.googleapis.com`（Gemini API）、`www.googleapis.com`（Drive API）、`accounts.google.com`（GIS）、`script.google.com` / `script.googleusercontent.com`（当社認証系）に限る。Google Pickerに要る `apis.google.com` 等は許可しない（既存仕様書 §11） |
| NFR-04 | セキュリティ | Driveのクエリは常に `in parents` を含み、名前だけでドライブ全体を検索しない。スコープは `drive.file` のみで、対象フォルダ以外のDriveデータを読み取らない（既存仕様書 §11） |
| NFR-05 | セキュリティ | 外部由来の文字列（ファイル名・Drive表示名・API応答）は必ず `textContent` で扱い、`innerHTML` を使わない。例外の `message` やAPI応答本文を画面へそのまま出さず、コード（エラー種別）から日本語文言表へ変換してから表示する（既存仕様書 §11） |
| NFR-06 | 性能 | 長時間音声はメインスレッドをブロックしないよう、区間（既定5分）ごとにWeb Workerへ渡して順に処理・連結する。WebGPUが使える環境ではWebGPUを優先し、失敗時はWASMへ自動フォールバックする |
| NFR-07 | 可用性 | サーバーレス構成のため当社サーバーの障害の影響を受けないが、CDN（jsDelivr／Hugging Face）とGoogle側サービス（Drive API・GIS・Gemini API）の可用性に依存する |
| NFR-08 | 運用 | デプロイは手動実行。`main` へのマージのみでは公開されない。Portalのアプリ一覧（`public/portal/app-registry.js`）から起動する |
| NFR-09 | アクセシビリティ | 進捗・状態は `role="status"` と `aria-live="polite"` で通知し、色だけに頼らず文言を併記する（`data-tone` 属性）。Drive選択ダイアログはネイティブ `<dialog>`（`showModal()`）でフォーカス閉じ込め・Escape対応をブラウザに委ねる。`prefers-reduced-motion` に対応する（`style.css`） |

## 7. 制約条件

- **本番アプリ間で共通層を作らない。** `public/production-app/` 配下に `shared/`・`common/`・`lib/` の類を置かず、アプリ間でimportもしない（[docs/repository-structure.md](../../repository-structure.md) §4-1）。録音アプリ・領収書スキャナとの共通ロジックは複製し、複製元パスと複製日をファイル冒頭コメントに記す。
- **テスト環境（`public/apps/`）を参照しない。** 本番アプリからテスト環境へのimportを行わず、必要な実装は複製で適合させる（[docs/repository-structure.md](../../repository-structure.md) §1）。
- **OAuthクライアントIDを録音アプリ・領収書スキャナと意図的に共用する。** `drive.file` はクライアントIDごとに見える範囲が分かれるため、同じIDでないと録音アプリが保存した音声が見えない。
- npmビルドを持たない素のESモジュール構成。Gemini SDK（`@google/genai`）は導入せず、公式REST（`fetch`）を直接使う。
- Transformers.js はバージョン固定（4.2.0）。CDNの `latest` は指さない。Whisperモデルは `onnx-community` の tiny／base／small、q8量子化に限る。
- 静的配信のみで、サーバーコード（API・キュー・変換処理）を持たない。

## 8. 外部依存

| 依存先 | 用途 | 認証・スコープ |
| --- | --- | --- |
| Google Identity Services（GIS） | OAuth 2.0 トークンモデルでの認可 | 公式配信URL（`accounts.google.com/gsi/client`）のみを読み込み先とする |
| Google Drive API v3 | Voice Recorderフォルダの解決・音声一覧・取得、Audio Transcriberフォルダへの結果TXT保存 | `drive.file` スコープ。APIキー・client secretは使わない |
| jsDelivr CDN | Transformers.js本体（バージョン固定）の取得 | 端末内モードのみ。認証不要 |
| Hugging Face（`huggingface.co` / `*.hf.co` / `cdn-lfs*`） | Whisperモデルファイルの取得 | 端末内モードのみ。音声は送らない。認証不要 |
| Gemini API（`generativelanguage.googleapis.com`） | 文字起こし（Files API アップロード／`generateContent`／`models.list`） | 利用者自身のAPIキー（`x-goog-api-key` ヘッダー） |
| TSAM AI 認証系（`script.google.com` / `script.googleusercontent.com`） | ログインセッションの検証（`guardPage()` 経由） | 本番認証系の既存の仕組みをそのまま利用（本書のスコープ外） |

要求するOAuthスコープは `drive.file` の1つのみで、増やさない方針（既存仕様書 §FR-02、`config.js` のコメント）。

## 9. 前提条件・未確定事項

### 前提条件

1. Drive連携を使う場合、利用者がブラウザ録音アプリで録音を保存済みで、「マイドライブ ＞ TSAM AI ＞
   Voice Recorder」が存在すること。無い場合、本アプリはフォルダを作らず案内を出す。
2. Gemini モードを使う場合、利用者がポータルの「API設定」で自分のGemini APIキーを登録済みであること。
3. Google Cloud側で、共用OAuthクライアントの「承認済みのJavaScript生成元」に本番オリジンが
   登録されていること。この作業はコードには現れない（既存仕様書 §13）。
4. デプロイは手動（`npm run deploy`）で行う。`main` へのマージのみでは公開されない。

### 未確定事項（本書執筆時点でコード・既存仕様書から読み取れないもの）

- Gemini実APIキーでの疎通確認が完了しているか。`index.html` には「実環境によって利用できない
  場合があります」という注記が本書執筆時点でも残っている（既存仕様書 §13-5）。
- 本番オリジンでの実アカウントによるDrive連携（認可・録音一覧の表示）確認が完了しているか
  （既存仕様書 §13-4）。
- OAuth同意画面が「本番公開」へ切り替わっているか、または「テスト」状態のまま利用者を
  個別追加しているか（既存仕様書 §13-3）。
- Google Drive APIが有効化されたGoogle Cloudプロジェクトの状態（既存仕様書 §13-1、録音アプリと
  共有と記載されているが、本書からは実際の設定状態を確認できない）。

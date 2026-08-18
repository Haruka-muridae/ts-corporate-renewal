# 音声文字起こしアプリ（audio-transcriber）組み込みガイド

このアプリを別のプロダクト（別リポジトリ・別ドメイン）へ移植する際の要点をまとめる。
読者は「TSAM AIリポジトリを知らないが、このアプリを自分のプロダクトへ移植したい開発者」を想定する。

## 1. 移植の前提条件

- 静的ファイル（HTML／CSS／ES Modules）をHTTPS配信できるホスティング環境。ビルド工程は不要。
- 自前のGoogle Cloudプロジェクト（Drive API有効化、OAuthクライアント、承認済みJavaScript生成元の登録）。
- 「利用者自身のGemini APIキーを使う」方針を維持するか、自プロダクトの方針に合わせて変更するかの
  意思決定（後者の場合はキーの入力・保管UIを新たに設計する必要がある）。
- TSAM AI固有の認証（`guardPage`）・APIキー保管（KeyStore）・録音アプリとの連携（`voice-recorder`
  フォルダ）は、そのままでは持ち出せない。§3で個別に判断する。

## 2. 依存関係マップ

| 依存先 | 種別 | 結合度 |
| --- | --- | --- |
| `public/auth/session.js`（`guardPage`） | TSAM AI共通資産 | 強（ログインセッション検証の入口。代替実装が必須） |
| `public/auth/config.js`（`setScreenDepth`） | TSAM AI共通資産 | 中（相対リンクの深さ指定。認証系の実装に依存） |
| `public/auth/keystore.js`（`KeyStore`/`PROVIDERS`/`isKeyStoreAvailable`） | TSAM AI共通資産 | 強（Gemini APIキーの保管庫。代替実装が必須） |
| `public/auth/auth.css` | TSAM AI共通資産 | 弱（ボタン等の見た目のみ。無くても機能は動く） |
| `production-app/voice-recorder/config.js`の`DRIVE_NAMES` | 姉妹アプリとの結合（名前の一致のみ、import無し） | 中（読み取り元フォルダ名の一致を前提にした機能。無関係な移植先では不要） |
| OAuthクライアントID（録音アプリ・領収書スキャナと共用） | 姉妹アプリとの結合 | 強（`drive.file`は同一クライアントが作成したファイルしか見えないため、単独移植時は別ID・別スコープ設計が要る） |
| jsDelivr CDN（Transformers.js） | 外部サービス | 弱（変更不要。CSPの許可先として維持） |
| Hugging Face CDN（Whisperモデル） | 外部サービス | 弱（変更不要） |
| Gemini API | 外部サービス | 弱（変更不要。利用者キー方式を維持する場合） |
| `public/portal/app-registry.js` | TSAM AI Portal | 弱（アプリ側コードは参照しない。移植先では単に登録しない） |

## 3. 切り離しポイント

移植時に必ず差し替える・見直す箇所。

1. **`script.js`冒頭の`guardPage`/`setScreenDepth`呼び出し**: 移植先の認証方式に合わせて置き換える。
   認証を持たないプロダクトへ組み込む場合は、この呼び出し自体を削除し、
   `<main id="at-main">`の`hidden`制御方法を再設計する。
2. **`config.js`の`OAUTH.clientId`**: 移植先自身のGoogle Cloudプロジェクトで発行したクライアントIDへ
   差し替える。録音アプリとの連携（読み取り元フォルダの共有）を維持しない場合は、単独の
   `drive.file`クライアントとして構成し直せる。
3. **`config.js`の`DRIVE_NAMES`**: 録音アプリとの連携を持たない移植先では、`voiceRecorder`
   （読み取り元固定フォルダ）の概念自体が不要になる可能性がある。「端末からの音声選択のみ」に
   縮小するか、移植先独自の音声保存先と名前を合わせるかを設計時に決める。
4. **Gemini APIキーの入手経路（KeyStore）**: `public/auth/keystore.js`が無い環境では、
   `script.js`の`refreshKeyState`/`runGemini`が参照する`KeyStore.has`/`KeyStore.get`相当の
   代替実装（自プロダクトのAPIキー保管方式）に差し替える。`gemini-transcriber.js`自体はAPIキーを
   引数で受け取るだけの設計のため、この関数の呼び出し元だけを差し替えればよい。
5. **`index.html`のCSP（`<meta>`）**: 自ドメイン・自ホスティングに合わせて書き換える。
   `script.google.com`/`script.googleusercontent.com`（TSAM AI認証系）はTSAM AI固有のため除去し、
   移植先の認証バックエンドに合わせた接続先へ差し替える。jsDelivr／Hugging Face／Gemini／
   Google Drive／GISの許可先はGoogle連携を維持する限り変更不要。
6. **Portalへのリンク（`index.html`フッター、`portalLink`要素のhref）**: TSAM AI Portal固有の
   導線のため、移植先のナビゲーションに合わせて書き換えるか削除する。

## 4. 必要な外部サービスと設定作業の概要

コードには現れない、人手の作業（既存仕様書 §13相当）。

1. Google Cloudプロジェクトを作成し、Google Drive APIを有効化する。
2. OAuth 2.0クライアントID（ウェブアプリケーション）を発行する。移植先の本番オリジンおよび
   開発オリジンを「承認済みのJavaScript生成元」へ登録する。
3. OAuth同意画面を設定し、公開状態（テスト／本番）を移植先の利用者範囲に合わせる。
4. `drive.file`スコープでの認可・Drive一覧取得を実アカウントで確認する。
5. Geminiモードを維持する場合、利用者自身がGoogle AI Studio等でAPIキーを発行する運用を
   案内する（本アプリ／組み込み先はキーを代理発行しない）。
6. 実APIキーでのGemini疎通確認（Files APIアップロード・`generateContent`）を行う。

## 5. 複製時の注意

本番アプリ間で共通層を作らない方針
（[docs/repository-structure.md](../../repository-structure.md) §4-1）に従い、他プロダクトへ
持ち出す場合も「複製」を基本とする。共有ライブラリ化は行わず、複製元のパスと複製日を
複製先ファイルの冒頭コメントに残す（同§4-3）。

複製前に確認しておくとよい、本アプリの設計上の前提（不具合の指摘ではなく、移植先での要件が
異なりうる箇所として記録する）:

- **フォルダの重複解決は読み取り元でのみ実装している。** `resolveVoiceRecorderFolder`
  （読み取り元＝Voice Recorderフォルダの解決）は同名フォルダが複数見つかった場合に候補一覧を
  返し、利用者に選ばせる。一方、保存先（Audio Transcriberフォルダ）を用意する
  `ensureTranscriptFolder`は、同名フォルダが複数あった場合の挙動が読み取り元側とは異なる実装に
  なっている（`drive-client.js`の`findFolder`/`ensureFolder`）。移植先で保存先フォルダの
  重複を厳密に扱いたい場合は、実装を突き合わせたうえで方針を決めること。
- **Transformers.js 4.2.0固定・`graphOptimizationLevel:'basic'`のWASM回避策は、そのバージョン
  同梱のONNX Runtimeに紐づく。** ライブラリのバージョンを上げる場合は、この回避策が引き続き
  必要か実ブラウザで再確認すること（`config.js`のコメントに詳細あり）。
- **OAuthクライアントIDを他アプリと共用する設計は、単独移植には不要な結合である。** 録音アプリの
  録音を読む機能を持ち出さないのであれば、独立したクライアントIDと最小スコープで構成し直す方が
  シンプルになる。

## 6. 最小組み込み手順

1. `public/production-app/audio-transcriber/`配下の全ファイルを移植先の静的配信ルートへコピーする。
2. `config.js`の`OAUTH.clientId`を移植先自身のクライアントIDへ差し替える。録音アプリ連携を
   持たない場合は`DRIVE_NAMES.voiceRecorder`関連のロジック（Drive選択ダイアログ、フォルダ解決）を
   縮小するか、移植先の音声保存先名に合わせて`DRIVE_NAMES`を変更する。
3. `script.js`の`guardPage`/`setScreenDepth`呼び出しを、移植先の認証方式（無い場合は削除）に
   差し替える。
4. Gemini APIキーの入手経路（`KeyStore`相当）を移植先の資格情報管理方式に差し替える。
   `gemini-transcriber.js`・`config.js`の`GEMINI`定数はそのまま利用できる。
5. `index.html`のCSP（`<meta>`）を移植先のドメイン・認証バックエンドに合わせて書き換える。
   Google関連の許可先（jsDelivr／Hugging Face／Drive／GIS／Gemini）はGoogle連携を維持する限り
   そのまま流用できる。
6. Google Cloud側の設定（§4）を完了させ、実アカウントでDrive連携とGemini疎通を確認する。
7. 移植先の自動テスト基盤に合わせて`tests/unit/audio-transcriber.mjs`相当のNode実行テストを
   用意し、`config.js`／`state.js`／`result-exporter.js`／`drive-client.js`の純ロジックを
   移植先の値（フォルダ名・上限値等）に合わせて検証する。

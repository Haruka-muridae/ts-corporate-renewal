# AI議事録アプリ（meeting-minutes）組み込みガイド

このアプリを別のプロダクト（別リポジトリ・別ドメイン）へ移植する際の要点をまとめる。
読者は「TSAM AIリポジトリを知らないが、このアプリを自分のプロダクトへ移植したい開発者」を想定する。

## 1. 移植の前提条件

- 静的ファイル（HTML／CSS／ES Modules）をHTTPS配信できるホスティング環境。ビルド工程は不要。
- 自前のGoogle Cloudプロジェクト（Drive API有効化、OAuthクライアント、承認済みJavaScript生成元の
  登録）。Drive保存機能を持ち出す場合のみ必要（§4）。
- 「利用者自身のGemini APIキーを使う」方針を維持するか、自プロダクトの方針に合わせて変更するかの
  意思決定（後者の場合はキーの入力・保管UIを新たに設計する必要がある）。
- TSAM AI固有の認証（`guardPage`）・APIキー保管（KeyStore）・`audio-transcriber`との引継ぎ連携は、
  そのままでは持ち出せない。§3で個別に判断する。
- 本アプリ単体では「文字起こしテキストを貼り付け or ファイル読込みで議事録化する」機能は完結する。
  `audio-transcriber`からの引継ぎ機能を持たない移植先では、その部分だけ縮小できる。

## 2. 依存関係マップ

| 依存先 | 種別 | 結合度 |
| --- | --- | --- |
| `public/auth/session.js`（`guardPage`） | TSAM AI共通資産 | 強（ログインセッション検証の入口。代替実装が必須） |
| `public/auth/config.js`（`setScreenDepth`） | TSAM AI共通資産 | 中（相対リンクの深さ指定。認証系の実装に依存） |
| `public/auth/keystore.js`（`KeyStore`/`PROVIDERS`/`isKeyStoreAvailable`） | TSAM AI共通資産 | 強（Gemini APIキーの保管庫。代替実装が必須） |
| `public/auth/auth.css` | TSAM AI共通資産 | 弱（ボタン等の見た目のみ。無くても機能は動く） |
| `audio-transcriber`の`sessionStorage`引継ぎ（`tsam-meeting-minutes-handoff-v1`） | 姉妹アプリとの結合（import無し。キー名・データ形式の一致のみ） | 中（読み取り元アプリが無い移植先では、引継ぎバナー・`handoff.js`一式が不要になる） |
| OAuthクライアントID（録音アプリ・文字起こしアプリと共用） | 姉妹アプリとの結合 | 強（`drive.file`は同一クライアントが作成したファイルしか見えないため、単独移植時は別ID・別スコープ設計が要る） |
| Gemini API | 外部サービス | 弱（変更不要。利用者キー方式を維持する場合） |
| Google Drive API v3 / GIS | 外部サービス | 弱（Drive保存機能を維持する場合は変更不要。機能自体を落とすなら`oauth.js`/`drive-client.js`ごと不要） |
| `public/portal/app-registry.js` | TSAM AI Portal | 弱（アプリ側コードは参照しない。移植先では単に登録しない） |

`minutes.js`・`gemini.js`・`draft.js`はTSAM AI固有の依存を持たない純ロジックであり、そのまま
移植先でも動く（`config.js`の値を差し替えれば足りる）。

## 3. 切り離しポイント

移植時に必ず差し替える・見直す箇所。

1. **`app.js`冒頭の`guardPage`/`setScreenDepth`呼び出し**: 移植先の認証方式に合わせて置き換える。
   認証を持たないプロダクトへ組み込む場合は、この呼び出し自体を削除し、`#mm-content`の`hidden`
   制御方法を再設計する。
2. **Gemini APIキーの入手経路（KeyStore）**: `public/auth/keystore.js`が無い環境では、`app.js`の
   `refreshKeyState`/`runGeneration`が参照する`KeyStore.has`/`KeyStore.get`相当の代替実装
   （自プロダクトのAPIキー保管方式）に差し替える。`gemini.js`自体はAPIキーを引数で受け取るだけの
   設計のため、呼び出し元だけを差し替えればよい。
3. **`handoff.js`一式と、`index.html`の引継ぎバナー（`#mm-handoff`）**: `audio-transcriber`相当の
   送信元アプリを持たない移植先では丸ごと不要。持つ場合は`HANDOFF_KEY`/`HANDOFF_SOURCE_APP`
   （`config.js`）を送信元アプリ側の実装と一致させる。
4. **`config.js`の`OAUTH.clientId`とDrive保存機能全体（`oauth.js`/`drive-client.js`）**: 移植先自身の
   Google Cloudプロジェクトで発行したクライアントIDへ差し替える。録音・文字起こしアプリとの
   フォルダ共有を維持しない場合は、単独の`drive.file`クライアントとして構成し直せる。Drive保存
   自体が不要なら、出力画面（ステップ5）の「Googleドライブへ保存」ボタンと、`oauth.js`/
   `drive-client.js`の2ファイルごと削除できる（`minutes.js`/`gemini.js`はDriveに依存しない）。
5. **`config.js`の`DRIVE_NAMES`**: Drive保存を維持する場合、`root`を移植先独自のフォルダ名に
   変更できる。録音・文字起こしアプリとの連携を持たない移植先では、フォルダ階層自体を1段に
   縮小してもよい。
6. **`index.html`のCSP（`<meta>`）**: 自ドメイン・自ホスティングに合わせて書き換える。
   `script.google.com`/`script.googleusercontent.com`/`auth-verify.potenitas-lp.workers.dev`
   （TSAM AI認証系）はTSAM AI固有のため除去し、移植先の認証バックエンドに合わせた接続先へ
   差し替える。Gemini／Google Drive／GISの許可先はそれぞれの連携を維持する限り変更不要。
7. **Portalへのリンク（`index.html`フッター、ポータル「API設定」への案内リンク）**: TSAM AI Portal
   固有の導線のため、移植先のナビゲーションに合わせて書き換えるか削除する。

## 4. 必要な外部サービスと設定作業の概要

コードには現れない、人手の作業。

1. Geminiモードを維持する場合、利用者自身がGoogle AI Studio等でAPIキーを発行する運用を案内する
   （本アプリ／組み込み先はキーを代理発行しない）。
2. Drive保存を維持する場合、Google Cloudプロジェクトを作成し、Google Drive APIを有効化する。
3. OAuth 2.0クライアントID（ウェブアプリケーション）を発行する。移植先の本番オリジンおよび
   開発オリジンを「承認済みのJavaScript生成元」へ登録する。
4. OAuth同意画面を設定し、公開状態（テスト／本番）を移植先の利用者範囲に合わせる。
5. `drive.file`スコープでの認可・フォルダ作成・ファイル保存を実アカウントで確認する。
6. 実APIキーでのGemini疎通確認（構造化JSON出力が期待どおりに得られるか）を行う。

## 5. 複製時の注意

本番アプリ間で共通層を作らない方針
（[docs/repository-structure.md](../../repository-structure.md) §4-1）に従い、他プロダクトへ
持ち出す場合も「複製」を基本とする。共有ライブラリ化は行わず、複製元のパスと複製日を複製先
ファイルの冒頭コメントに残す（同§4-3）。本アプリの`oauth.js`/`drive-client.js`自体が
`audio-transcriber`からの複製である（冒頭コメントに複製元パス・複製日が記載されている）。

複製前に確認しておくとよい、本アプリの設計上の前提（不具合の指摘ではなく、移植先での要件が
異なりうる箇所として記録する）:

- **保存先フォルダの重複解決は「読み取り元」の`audio-transcriber`ほど厳密ではない。** 本アプリは
  Driveを保存先としてしか使わないため、`ensureMinutesFolder`（`drive-client.js`）は同名フォルダが
  複数見つかった場合に先頭1件をそのまま使う。`audio-transcriber`の読み取り元フォルダ解決
  （候補一覧を提示して利用者に選ばせる）とは異なる実装である。移植先で保存先フォルダの重複を
  厳密に扱いたい場合は、実装を見直すこと。
- **evidence（根拠）のクライアント側照合は原文の完全一致・部分一致に依存する。** モデルが原文の
  表記を大きく言い換えた場合、実在する内容でも「根拠を確認できません」になりうる（安全側に倒す
  設計だが、利用者体験としては根拠が多めに「未確認」表示になる場合がある）。移植先で照合の閾値
  （`MIN_EVIDENCE_CHARS`）や二次照合の方式を変更する場合は、要件書 §4-10の「擬似的な時刻を生成
  しない」という制約を維持すること。
- **Drive保存は毎回新規ファイルを作成し、上書きしない設計である。** 同じ議事録を保存し直すと
  同名ファイルが複数並ぶ。移植先で「上書き保存」を求める場合は、`saveMinutesMarkdown`の実装
  （検索してから上書きするロジック）を追加する必要がある。
- **OAuthクライアントIDを他アプリと共用する設計は、単独移植には不要な結合である。** 録音・文字
  起こしアプリのフォルダを共有する機能を持ち出さないのであれば、独立したクライアントIDと最小
  スコープで構成し直す方がシンプルになる。
- **再生成（セクション別）は送信前確認画面（ステップ2）を経由せず、ブラウザ標準の`confirm()`
  ダイアログで置換範囲だけを案内する。** 初回生成時のステップ2（Google AI APIへの送信内容・
  プライバシーに関する説明）とは異なる文言・実装経路である。移植先で「送信のたびに毎回、送信内容
  の説明を見せる」という挙動を厳密に求める場合は、再生成時もステップ2相当の画面を経由させる設計に
  変更する必要がある。

## 6. 最小組み込み手順

1. `public/production-app/meeting-minutes/`配下の全ファイルを移植先の静的配信ルートへコピーする。
2. `app.js`の`guardPage`/`setScreenDepth`呼び出しを、移植先の認証方式（無い場合は削除）に
   差し替える。
3. Gemini APIキーの入手経路（`KeyStore`相当）を移植先の資格情報管理方式に差し替える。`gemini.js`・
   `config.js`のGemini関連定数はそのまま利用できる。
4. `audio-transcriber`相当の引継ぎ元を持たない場合、`handoff.js`と`index.html`の引継ぎバナーを
   削除する。持つ場合は`HANDOFF_KEY`等を送信元アプリの実装と一致させる。
5. Drive保存機能を維持する場合は`config.js`の`OAUTH.clientId`を移植先自身のクライアントIDへ、
   `DRIVE_NAMES`を移植先の保存先名へ差し替える。不要な場合は`oauth.js`/`drive-client.js`と
   ステップ5の「Googleドライブへ保存」ボタンを削除する。
6. `index.html`のCSP（`<meta>`）を移植先のドメイン・認証バックエンドに合わせて書き換える。
   Gemini／Google Drive／GISの許可先は、それぞれの連携を維持する限りそのまま流用できる。
7. Google Cloud側の設定（§4）を完了させ、実アカウントでGemini疎通・（維持する場合は）Drive連携を
   確認する。
8. 移植先の自動テスト基盤に合わせて`tests/unit/meeting-minutes.mjs`相当のNode実行テストを用意し、
   `config.js`／`minutes.js`／`gemini.js`／`draft.js`／`drive-client.js`の純ロジックを移植先の値
   （入力上限・フォルダ名・テンプレート等）に合わせて検証する。

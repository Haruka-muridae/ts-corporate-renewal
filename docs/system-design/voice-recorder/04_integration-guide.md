# ブラウザ録音アプリ（voice-recorder）組み込みガイド

対象要件: [01_requirements.md](./01_requirements.md) / [02_basic-design.md](./02_basic-design.md) / [03_detailed-design.md](./03_detailed-design.md)

本書は「このリポジトリを知らないが、本アプリを自分のプロダクトへ移植したい開発者」を読者に想定する。

## 1. 移植の前提条件

- **HTTPS（またはlocalhost）で配信できる静的ホスティング。** `getUserMedia` / OPFS はセキュアコンテキストでしか動作しない。バックエンドは不要（本アプリはサーバーコードを持たない）。
- **ESモジュールをそのまま配信できること。** バンドラを前提にしていない（`<script type="module">` で読み込む）。
- **Google Cloud プロジェクトを用意し、`drive.file` スコープのOAuth 2.0クライアントID（ウェブアプリ）を発行できること。** 移植先が当リポジトリと同じクライアントIDを使うことはできない（承認済みオリジンが異なるため）。
- **対応ブラウザはPC版Google Chrome最新版のみを前提に設計されている。** Edge/Safari/モバイルは未検証（本アプリの既知の制約であり、移植先で保証したい場合は追加検証が必要）。
- 独自のポータル認証ゲート（`guardPage()` 相当）を持つか、持たずにOAuthだけで運用するかを移植先で判断する必要がある（§3参照）。

## 2. 依存関係マップ

### 2.1 外部サービスへの依存（必須・置き換え不可）

- **Google Identity Services**（`https://accounts.google.com/gsi/client`）: OAuthトークン取得。認可そのものの提供元であるため、これ自体は他へ差し替えられない。
- **Google Drive API v3**（`https://www.googleapis.com`）: フォルダ解決・作成、ファイル検索、resumable upload。保存先をGoogle Drive以外にする場合は `drive.js` を全面的に書き換える必要がある。

### 2.2 このリポジトリ内部への依存（移植時に必ず差し替える）

| 依存 | 参照元 | 役割 |
| --- | --- | --- |
| `../../auth/session.js` の `guardPage()` | `app.js` | TSAM AIポータルのログインセッション検証。移植先には存在しない |
| `../../auth/config.js` の `setScreenDepth()` | `app.js` | ログイン画面への相対パス解決に使う深さ設定 |
| `../../auth/auth.css` | `index.html` | ボタン・入力欄の共通スタイル（`auth-button` クラス等） |
| `../../portal/` へのリンク | `index.html` フッター | 「ポータルへ戻る」導線。移植先のナビゲーションに合わせて変更する |
| `public/apps/drive-folders.js` との名前の一致 | `config.js` の `DRIVE_NAMES`（コメント参照） | 音声文字起こしアプリと保存先フォルダ名を共有する運用。移植先に対応アプリが無ければ無関係 |

### 2.3 リポジトリ内の他アプリとの関係（結合していないことの確認）

- **`public/apps/voice-recorder/`（テスト環境）とはimport関係が無い。** 録音ロジック（`recorder/` 配下一式）とOAuth処理（`oauth.js`）は、それぞれ `public/apps/voice-recorder/` と `public/production-app/receipt-ocr/oauth.js` から**複製**して作られており、実行時の依存は無い。移植時はこのディレクトリ（`public/production-app/voice-recorder/`）を丸ごとコピーするだけでよく、複製元を追いかける必要はない。
- **他の本番アプリ（`receipt-ocr`・`card-ocr`等）とも共有コードを持たない。** リポジトリの方針で `public/production-app/` 配下に共通層（`shared/`等）を意図的に作っていないため（[docs/repository-structure.md](../../repository-structure.md) §4-1）、本アプリのディレクトリは自己完結している。
- **同梱ライブラリは `vendor/lamejs.iife.js`（LGPL-3.0）のみ。** これはリポジトリ外部のOSSであり、移植先でもそのまま使える。ライセンス表示（NOTICE/LICENSEへのリンク）を維持すること。

## 3. 切り離しポイント

移植先で書き換える／削除する必要がある箇所。

1. **ポータル認証ゲート（`app.js` の `guardPage()` 呼び出し）。**
   - 移植先に同等の認証基盤がある場合: `guardPage()` の呼び出しを移植先の認証チェックに置き換える。
   - 無い場合: この呼び出しを削除してよい。既存要件書が明記するとおり、**このゲートは機密の保護ではなく「画面に入れない」ための制御にすぎない。** 実質的なアクセス制御はOAuth（`drive.file` スコープ）が担っており、ゲートを外しても保存先データの安全性は変わらない。ただし削除後は「未認証者でも画面自体は開ける」ことになるため、それを許容できるか移植先で判断すること。
2. **OAuthクライアントID（`config.js` の `OAUTH.clientId`）。** 移植先で新規発行したクライアントIDに差し替える。Google Cloud Consoleの「承認済みのJavaScript生成元」に移植先の本番・開発オリジンを登録する。
3. **保存先フォルダ名（`config.js` の `DRIVE_NAMES.root` / `DRIVE_NAMES.app`）。** 当リポジトリでは音声文字起こしアプリと名前を共有する運用があるが、移植先にその制約が無ければ自由に変更できる。変更する場合は `formatFolderPath()` の表示文言も連動して変わることを確認する。
4. **CSP（`index.html` の `<meta http-equiv="Content-Security-Policy">`）。** `connect-src` / `script-src` / `frame-src` が `accounts.google.com` と `www.googleapis.com`、および当リポジトリの認証系（`script.google.com` / `script.googleusercontent.com`）に限定されている。移植先のドメイン構成に合わせて調整する（TSAM AI認証系向けの許可は、ポータル認証ゲートを削除するなら不要になる）。
5. **フッターの「ポータルへ戻る」リンクと `SCREEN_DEPTH`。** 移植先のディレクトリ構成に合わせて相対パスを設定し直す。
6. **テストヘルパーへの依存（`tests/unit/voice-recorder.mjs` が使う `public/apps/tests/helpers/assert.mjs`）。** このアサーションヘルパーは当リポジトリの共通資産であり、移植先に単体テストを持ち込む場合は同等のヘルパーを自前で用意するか、Node標準の `assert` に置き換える。

## 4. 必要な外部サービスと設定作業の概要

1. **Google Cloud プロジェクトの作成**（既存プロジェクトの利用も可）。
2. **OAuth同意画面の設定。** 内部（Google Workspace組織限定）にするか外部にするかは移植先の方針で決める（当リポジトリはMVP決定として内部限定を選んでいるが、これはGoogle Cloud Console側の設定でありコードには現れない）。
3. **OAuth 2.0クライアントID（ウェブアプリケーション）の発行。** 「承認済みのJavaScript生成元」に本番オリジンと開発用オリジン（例: `http://localhost:8000`）を登録する。client secretは使わない（暗黙フローのため発行不要）。
4. **Google Drive APIの有効化。**
5. **要求スコープは `drive.file` のみに限定することを推奨する。** ドライブ全体を読むスコープ（`drive` / `drive.readonly`）を使うと、保存先以外のデータが見える状態になり、本アプリが前提とする「保存先以外は読み取らない」という性質が崩れる。
6. サーバー側の設定（DB・環境変数・APIキーの管理）は不要。本アプリはクライアントサイドの `clientId` 以外に秘密情報を持たない。

## 5. 複製時の注意

`docs/repository-structure.md` §4 の複製方針（同一リポジトリ内の本番アプリ間での複製）に準じ、移植（別プロダクトへのコピー）でも次を守ることを推奨する。

- **複製元のパスと複製日を、複製先ファイルの冒頭コメントに書く。** 当リポジトリの実装自体がこの流儀に従っており（`recorder/recorder.js` 等のファイル冒頭コメントを参照）、移植先でも由来を追えるようにしておくと、当リポジトリ側で先に修正が入ったときに気づける。
- **複製元の既知の不具合・制約を、意図せず持ち込まない。** 特に次の3点は「意図した設計判断」であり、移植先でも同じ判断をするかどうかを明示的に決めること。
  1. **異常終了した録音を復旧しない。** flush前のMP3が確実に再生できる保証が無いための意図的な割り切り。移植先で復旧機能が必要なら、この制約自体を作り直す必要がある（単純な設定変更では対応できない）。
  2. **`drive.file` スコープにより、利用者が手動作成した同名ファイルとの重複が避けられない。** `drive.js` にこの制約が明記されている。許容できない場合はスコープ変更（`drive.readonly` 等の追加）を検討することになるが、それは「保存先以外を読み取らない」という前提を弱める判断になるため、単独で決めず要件として合意すること。
  3. **GISのポップアップが閉じられた場合と、オリジン未登録による失敗が、コールバック上は区別できない。** 移植先で新しいクライアントIDを設定した直後にこの事象が起きやすい。`oauth.js` のコメントのとおり、両方の可能性を案内する文言にしてある（`OAUTH_POPUP_CLOSED` の文言を参照）。承認済みオリジンの反映には時間がかかる場合がある点も利用者向け文言に含めてある。
- **本番アプリ間で共通層を作らない、という当リポジトリの方針は、移植先の事情には従わなくてよい。** これは「別々に進む開発を互いに止めないため」の当リポジトリ固有の判断であり（§4-1参照）、移植先で他のアプリと共通化する設計にすること自体は否定されない。

## 6. 最小組み込み手順

1. `public/production-app/voice-recorder/` ディレクトリを丸ごと移植先の静的ホスティング配下へコピーする（`recorder/` サブディレクトリと `vendor/` を含む）。
2. Google Cloud ConsoleでOAuth 2.0クライアントID（ウェブアプリ、`drive.file` スコープ）を発行し、承認済みJavaScript生成元に移植先の本番・開発オリジンを登録する。
3. `config.js` の `OAUTH.clientId` を発行したクライアントIDに差し替える。`DRIVE_NAMES.root` / `DRIVE_NAMES.app` を移植先の保存先フォルダ名に変更する（変更する場合は `formatFolderPath()` の表示文言が連動することを確認する）。
4. `app.js` の `guardPage()` 呼び出しを、移植先の認証チェックに置き換えるか削除する（§3-1の判断に従う）。削除する場合は `import { guardPage } from '../../auth/session.js';` および関連する `next` / `params` の受け渡しコードも合わせて除去する。
5. `index.html` のCSP（`connect-src` / `script-src` / `frame-src`）を、移植先のドメイン構成とGoogleのホスト（`accounts.google.com` / `www.googleapis.com`）に合わせて更新する。第三者CDNを足さないこと。
6. フッターのポータルリンクと `SCREEN_DEPTH` を移植先のディレクトリ構成に合わせて調整する。ポータル認証ゲートを削除した場合はリンク自体を削除・変更する。
7. 対象ブラウザで、セキュアコンテキスト・`AudioWorklet`・`Worker`・OPFS（`navigator.storage.getDirectory` と Worker内 `createSyncAccessHandle`）・`navigator.storage.estimate` が利用できることを確認する（`recorder/capabilities.js` の `detectSupport()` が実行時に判定する）。
8. `tests/unit/voice-recorder.mjs` を移植先のテスト基盤に合わせて移し（アサーションヘルパーの差し替えを含む）、純ロジック部分の回帰を確認する。実ブラウザでの録音・Drive保存の確認は、当リポジトリの `tests/e2e/voice-recorder/` と `MANUAL_CHECKS.md` を参考に、移植先で同等の確認を行う（実OAuth同意画面〜実Driveへの保存は自動化しない方針を当リポジトリでも採っている）。
9. lamejsのライセンス表示（NOTICE・LICENSE全文へのリンク）を画面から辿れる場所に維持する。

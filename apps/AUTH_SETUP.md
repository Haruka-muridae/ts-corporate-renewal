# Googleログイン設定手順（/apps/）

TSAM AIアプリポータル `/apps/` に組み込んだ「Googleでログイン」機能の設定手順と、
運用上の注意をまとめる。

対象URL: <https://tsam-ai.com/apps/>

この機能は **Google Identity Services（Sign in with Google）によるログインのみ** を扱う。
Google Drive / Google Docs などのAPI認可（アクセストークンの取得）は含まない。

---

## 0. 実装ファイルの対応

| ファイル | 役割 |
| --- | --- |
| `apps/auth-config.js` | クライアントIDなどの設定値（**書き換えるのはここだけ**） |
| `apps/auth-session.js` | 表示用プロフィールの sessionStorage 読み書き |
| `apps/google-auth.js` | GIS読み込み・初期化・ボタン描画・状態管理・UI更新 |
| `apps/index.html` | ログイン領域のマークアップ |
| `apps/style.css` | ログイン領域のスタイル |
| `apps/script.js` | `tsam-auth-change` イベントの購読（data属性への反映のみ） |

---

## 1. Google Cloud プロジェクトの選択または作成

1. <https://console.cloud.google.com/> へアクセスする。
2. 画面上部のプロジェクト選択から、既存プロジェクトを選ぶか新規作成する。
3. プロジェクト名は運用者が識別できるものにする（例: `tsam-ai-apps`）。

このリポジトリからGoogle Cloudの設定を変更することはない。すべて手動操作で行う。

---

## 2. OAuth同意画面の設定

1. 「APIとサービス」→「OAuth同意画面」を開く。
2. User Type を選ぶ。
   - 社内利用のみ、かつGoogle Workspaceを利用している場合は **内部**
   - 社外の利用者も想定する場合は **外部**
3. 以下を入力する。
   - アプリ名（利用者の同意画面に表示される）
   - ユーザーサポートメール
   - アプリのロゴ（任意）
   - アプリのホームページ: `https://tsam-ai.com`
   - プライバシーポリシーURL / 利用規約URL（**外部**を選んだ場合は事実上必須）
   - デベロッパーの連絡先メールアドレス
4. 承認済みドメインに `tsam-ai.com` を追加する。

---

## 3. OAuthクライアントの種類

1. 「APIとサービス」→「認証情報」→「認証情報を作成」→「OAuth クライアント ID」。
2. アプリケーションの種類は **ウェブ アプリケーション** を選ぶ。
   - 「デスクトップ」「Android」「iOS」などを選ぶと Sign in with Google が動作しない。
3. 名前は任意（例: `tsam-ai apps portal`）。

---

## 4. 承認済みのJavaScript生成元（Authorized JavaScript origins）

**オリジン**を登録する。スキーム + ホスト + ポートまでで、`/apps/` などのパスは含めない。
末尾にスラッシュも付けない。

## 5. 本番オリジン

```
https://tsam-ai.com
```

## 6. ローカル開発オリジン

```
http://localhost
http://localhost:8000
```

`py -m http.server 8000` で確認する場合は `http://localhost:8000` が必要。
別のポートを使うなら、そのポートも同様に登録する。
`http://127.0.0.1:8000` は `localhost` とは別オリジン扱いのため、使う場合は別途登録する。

### リダイレクトURIについて

今回はJavaScriptコールバック方式（`google.accounts.id.initialize()` の `callback`）を使う。
ブラウザのリダイレクトを伴わないため、**承認済みのリダイレクトURIは原則不要**。
`ux_mode: 'redirect'` や、サーバー側でコードを受け取る方式へ変更する場合にのみ設定する。

---

## 7. クライアントIDの設定場所

発行された **クライアントID** を `apps/auth-config.js` の `clientId` に貼る。

```js
export const GOOGLE_AUTH_CONFIG = Object.freeze({
  clientId: '000000000000-xxxxxxxxxxxxxxxx.apps.googleusercontent.com',
  storageKey: 'tsam-ai-google-profile',
  storageVersion: 1,
});
```

- クライアントIDを書く場所はこの1か所だけ。HTMLや他のJSへ直接書かない。
- 未設定（`REPLACE_WITH_GOOGLE_CLIENT_ID` のまま）の場合、画面には
  「Googleログインは現在準備中です。」と表示され、**GISの外部スクリプトも読み込まれない**。
  アプリ一覧は通常どおり利用できる。
- 形式が `.apps.googleusercontent.com` で終わらない値も未設定と同じ扱いになる。
  その場合はコンソールに警告が出る。

---

## 8. client secret は使用しない

- Sign in with Google（IDトークン方式）に **client secret は不要**。
- このリポジトリは公開リポジトリで配信される静的サイトのため、
  以下は **絶対にコミットしない**。
  - OAuth client secret
  - APIキー
  - refresh token / アクセストークン
  - サービスアカウント秘密鍵
  - 個人の認証情報
- クライアントIDは公開情報であり、秘匿の必要はない。
  不正利用の防止は「承認済みのJavaScript生成元」の制限によって行う。

---

## 9. 今回要求するスコープ

Sign in with Google の既定のスコープのみ。

- `openid`
- `profile`
- `email`

これらは `google.accounts.id.initialize()` の利用に伴う既定の範囲であり、
コード側で追加のスコープ文字列を指定していない。

---

## 10. Drive権限（音声レコーダーのみ）

ログイン（第9節）ではDriveスコープを要求しない。
音声レコーダーで「Google Driveへ保存」を押したときにだけ、
別のOAuth認可フロー（`google.accounts.oauth2.initTokenClient`）で
以下のスコープを要求する。

```
https://www.googleapis.com/auth/drive.file
```

このスコープは **このアプリが作成した、または利用者が明示的に選んだファイル** だけを
対象とする。Drive全体の閲覧権限ではない。

Google Docs API は使用していない。設定手順は「付録B: Google Drive保存の設定」を参照。

---

## 11. サーバー側のIDトークン検証は行っていない

このサイトはGitHub Pages上の静的サイトであり、バックエンドが存在しない。
そのため、Googleが発行したIDトークン（JWT）の **署名検証を行っていない**。

実装上の扱い:

- `credential`（IDトークン）は表示用にpayloadを読むだけで、**保存しない**。
  - localStorage / sessionStorage / cookie / URL / ログ / 外部送信 いずれにも残さない。
- payloadの解析に失敗した場合は例外を外へ出さず、エラー表示に倒す。
- 表示に使う値は必ず `textContent` で挿入する（`innerHTML` は使わない）。
- プロフィール画像URLは `https:` のみ許可する。

---

## 12. このログイン表示をアクセス制御に使わないこと

**重要。** この機能はUI上の利便性のためのものであり、セキュリティ境界ではない。

使ってよい用途:

- プロフィール（画像・表示名・メールアドレス）の表示
- ログイン状態の表示
- 今後のOAuth認可フローへの導線
- 利便性の向上

使ってはいけない用途:

- 管理者権限の判定
- 有料会員の判定
- 機密情報へのアクセス制御
- API認証
- サーバー側の本人確認
- `potenitas.com` などドメインによる所属判定
- メールアドレスだけによる権限付与

sessionStorage上のプロフィールは、利用者が自由に書き換えられる
**未検証の表示用キャッシュ**である。将来サーバー側の判定が必要になった場合は、
IDトークンをバックエンドへ送って `https://www.googleapis.com/oauth2/v3/certs` の
公開鍵で署名・`aud`・`iss`・`exp` を検証する仕組みを別途用意する。

---

## 13. テストユーザーの設定

OAuth同意画面の公開ステータスが **テスト** の場合、
「テストユーザー」に登録したGoogleアカウントでしかログインできない。

- 未登録のアカウントでは、同意画面で `403: access_denied` 相当のエラーになる。
- 動作確認を行う担当者のGoogleアカウントを、あらかじめ登録しておく。
- テストユーザーは最大100件まで登録できる。

---

## 14. 本番公開前の確認

1. OAuth同意画面の **公開ステータス** を確認する。
   - 社内限定運用なら User Type「内部」のままでよい。
   - 社外利用者を想定する場合は「本番環境」へ公開する必要がある。
2. 今回のスコープ（`openid` / `profile` / `email`）は機密スコープではないため、
   Googleの審査（verification）は通常不要。
   ただし将来Driveスコープを追加する場合は審査対象になり得る。
3. 承認済みのJavaScript生成元に `https://tsam-ai.com` が入っていることを確認する。
4. 設定変更の反映には数分〜数時間かかることがある。

---

## 15. トラブルシューティング

| 症状 | 原因と対処 |
| --- | --- |
| 「Googleログインは現在準備中です。」のまま | `apps/auth-config.js` の `clientId` が未設定、または形式が不正。コンソールの警告を確認する。 |
| 「Googleログインを読み込めませんでした。」 | GISスクリプトを取得できていない。ネットワーク、拡張機能によるブロック、`accounts.google.com` への到達性を確認する。 |
| ボタンは出るが押しても何も起きない | 承認済みのJavaScript生成元に、現在のオリジンが未登録。コンソールに `origin is not allowed` 系のエラーが出る。 |
| `The given origin is not allowed for the given client ID` | 上と同じ。`http://localhost:8000` など、ポートを含む正確なオリジンを登録する。 |
| `403: access_denied` | 公開ステータスが「テスト」で、テストユーザー未登録。第13節を参照。 |
| `file://` で開くと動かない | GISは `http(s)` オリジンを要求する。必ずHTTPサーバー経由で開く。 |
| プロフィール画像が出ない | 画像URLの取得失敗、または `https:` 以外のURL。イニシャル表示へ自動でフォールバックする（不具合ではない）。 |
| タブを開き直すとログイン表示が消える | 仕様。保存先は sessionStorage のみで、タブを閉じると消える。 |
| ログアウトしてもGoogleにログインしたまま | 仕様。解除するのはこのサイト上の表示状態のみで、Googleアカウント自体からはログアウトさせない。 |

---

## 付録: 今後の検討事項

### Content-Security-Policy

現在このサイトにCSPは設定されていない（GitHub Pagesのため
レスポンスヘッダーを直接制御できず、`<meta http-equiv>` での指定も未導入）。
今回のスコープではCSPを新設しない。

将来CSPを導入する場合、GIS用に最低限必要になる想定は以下。
導入前に必ず公式ドキュメントで最新の要件を確認すること。

- `script-src https://accounts.google.com/gsi/client`
- `frame-src https://accounts.google.com/gsi/`
- `connect-src https://accounts.google.com/gsi/`
- `style-src https://accounts.google.com/gsi/style`
- プロフィール画像用に `img-src https://lh3.googleusercontent.com`（配信ホストは変動し得る）

### 追加してよい外部通信

現在の外部通信は Google Identity Services と Google Drive API のみ。
以下は追加しない方針とする。

- Google Analytics / Google Tag Manager
- 広告タグ
- 他のCDN
- 非公式の認証SDK
- 独自トラッキング

---

# 付録B: Google Drive保存の設定

音声レコーダー（`/apps/voice-recorder/`）の「Google Driveへ保存」に必要な設定。

| ファイル | 役割 |
| --- | --- |
| `apps/gis-loader.js` | GIS公式スクリプトの共通ローダー（ログインとDriveで共用） |
| `apps/voice-recorder/drive-auth.js` | アクセストークンの取得（**メモリ上のみ**） |
| `apps/voice-recorder/drive-client.js` | Drive API v3（フォルダ確認・作成、multipartアップロード） |
| `apps/voice-recorder/drive-save.js` | 保存UI（状態表示、エラー文言） |

OAuthクライアントIDは `apps/auth-config.js` を参照する。**Drive側で重複定義しない。**

## B-1. Google Drive API の有効化

Driveスコープを許可しても、APIが無効なままだと呼び出しが `403` で失敗する。

1. <https://console.cloud.google.com/> で対象プロジェクトを選ぶ。
2. 「APIとサービス」→「ライブラリ」を開く。
3. 「Google Drive API」を検索して開く。
4. 「有効にする」を押す。
5. 「APIとサービス」→「有効なAPIとサービス」に表示されることを確認する。

有効化していない場合、画面には
「Google Drive APIが有効になっていません。管理者にGoogle Cloud側の設定をご確認ください。」
と表示される（`accessNotConfigured` を検出して切り替えている）。

## B-2. OAuth同意画面へ `drive.file` スコープを追加

1. 「APIとサービス」→「OAuth同意画面」→「データアクセス」（旧「スコープ」）。
2. 「スコープを追加または削除」を押す。
3. `https://www.googleapis.com/auth/drive.file` を選ぶ。
4. 保存する。

- `drive.file` は Google の分類上 **機密スコープ（sensitive scope）** にあたる。
  制限付きスコープ（`drive` や `drive.readonly`）ではない。
- 追加するのはこの1つだけ。`drive`、`drive.readonly`、`drive.metadata` は追加しない。

## B-3. テストユーザー

公開ステータスが「テスト」の場合、テストユーザーに登録したアカウントでしか
認可できない。ログイン（第13節）と同じ制約が、Drive認可にも適用される。

未登録のアカウントでは、認可ポップアップが `access_denied` で閉じ、画面には
「Google Driveへのアクセスが許可されませんでした。」と表示される。

## B-4. 本番公開時のOAuth審査

- `drive.file` は機密スコープのため、User Type「外部」で本番公開する場合は
  **Googleの審査（verification）が必要になる可能性が高い**。
  審査ではアプリのホームページ、プライバシーポリシー、スコープの利用目的の説明、
  場合によっては動作を示す動画の提出を求められる。
- User Type「内部」（Google Workspace組織内のみ）であれば審査は不要。
- 審査前でも、テストユーザーとして登録したアカウントでは動作を確認できる。
- 未審査のまま「本番環境」へ公開すると、認可時に「確認されていないアプリ」の
  警告画面が表示され、100人までの上限が適用される場合がある。

**本番公開前に、どちらの運用にするかを決めること。**

## B-5. client secret を置かないこと

- Token Model（クライアントサイドのOAuth）では client secret は不要。
- `refresh token` も発行されないため、保存する対象がそもそも存在しない。
- APIキーも使用しない（認可はアクセストークンのみ）。
- アクセストークンは **メモリ上だけ** で保持する。
  sessionStorage / localStorage / cookie / URL / ログのいずれにも書かない。
  ページを再読み込みすると消え、次回の保存時に再認可が必要になる（意図した挙動）。

## B-6. localhost での確認方法

```
py -m http.server 8000
```

<http://localhost:8000/apps/> でGoogleログイン →
<http://localhost:8000/apps/voice-recorder/> へ **同じタブで** 移動 →
録音 → MP3変換 → 「Google Driveへ保存」。

- ログイン状態は sessionStorage で共有される。sessionStorage は
  **オリジン単位かつタブ単位** のため、別タブで開くとログイン状態は引き継がれない。
- 承認済みのJavaScript生成元に `http://localhost:8000` が必要（第6節）。
- `file://` では動作しない。必ずHTTPサーバー経由で開く。

## B-7. GitHub Pages での確認方法

1. ブランチをマージし、GitHub Pagesへ反映されるのを待つ（通常1〜2分）。
2. <https://tsam-ai.com/apps/> でログイン。
3. 同じタブで <https://tsam-ai.com/apps/voice-recorder/> へ移動。
4. 録音 → MP3変換 → 「Google Driveへ保存」。
5. Drive（<https://drive.google.com/>）のマイドライブに
   「TSAM AI」＞「Voice Recorder」が作成され、MP3が入っていることを確認する。

承認済みのJavaScript生成元に `https://tsam-ai.com` が必要（第5節）。
オリジンにパス（`/apps/`）は含めない。

## B-8. 想定エラーと確認箇所

| 画面表示 | 原因 | 確認箇所 |
| --- | --- | --- |
| Googleへのログインが必要です | sessionStorageにプロフィールが無い | `/apps/` で同じタブからログインし直す |
| Google Drive保存は現在準備中です | クライアントID未設定 | `apps/auth-config.js` の `clientId` |
| 認証画面が閉じられたため、保存を中止しました | 利用者がポップアップを閉じた | 操作のやり直し |
| 認証画面を開けませんでした | ポップアップブロック | ブラウザのポップアップ設定 |
| アクセスが許可されませんでした | 同意画面で拒否／テストユーザー未登録 | B-3 |
| 保存権限が許可されませんでした | 同意画面でDriveのチェックを外した | 再度「許可」を選ぶ |
| Google Drive APIが有効になっていません | APIが未有効化（403 `accessNotConfigured`） | B-1 |
| 認証の有効期限が切れました | アクセストークンの期限切れ（401） | もう一度ボタンを押すと再認可 |
| 保存容量が不足しています | Driveの容量超過（403 `storageQuotaExceeded`） | Google Driveの空き容量 |
| アクセスが集中しています | レート制限（429 / `rateLimitExceeded`） | 時間をおいて再試行 |
| 通信に失敗しました | オフライン、遮断、CORS | ネットワーク、拡張機能 |
| Google側で問題が発生しています | 5xx | Google側の障害情報 |

`The given origin is not allowed for the given client ID` が
コンソールに出る場合は、承認済みのJavaScript生成元の登録漏れ（第4〜6節）。

## B-9. drive.file スコープの制約（仕様として理解しておくこと）

`drive.file` では、このアプリが作成したファイル・フォルダしか見えない。
そのため次の挙動になる。

- 利用者が手動で作った「TSAM AI」フォルダは、このアプリからは**見えない**。
  同名のフォルダをアプリ側が新たに作成する。
- アプリが作ったフォルダを利用者がゴミ箱へ入れると、次回は新しく作成される
  （検索条件に `trashed=false` を含めているため）。
- 同名フォルダが複数見つかった場合は、最初に取得できたものを使う。

これは権限を最小限に保つための意図した制約であり、
より広いスコープ（`drive`）へ広げる予定はない。

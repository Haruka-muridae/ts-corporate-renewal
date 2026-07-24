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

## 10. Drive権限は未実装

- `https://www.googleapis.com/auth/drive.file` などのDriveスコープは要求していない。
- `google.accounts.oauth2.initTokenClient` も使用していない。
- Drive API / Google Docs API の呼び出しも行っていない。

将来、音声レコーダーの「Google Driveへ保存」を実装する際に、
**その操作の時点で** 別のOAuth認可フロー（`initTokenClient`）を起動し、
必要最小限のスコープだけを要求する。ログインと認可は分離したまま運用する。

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

今回追加した外部通信は Google Identity Services 関連のみ。
以下は追加しない方針とする。

- Google Analytics / Google Tag Manager
- 広告タグ
- 他のCDN
- 非公式の認証SDK
- 独自トラッキング

# 参加確定メール（Gmail API）のセットアップ手順

`architect@potenitas.com` から参加確定メールを送るための設定手順。
ブラウザでの操作が必要なため、以下は事業者側で実施する。

送信の実装は `lib/event/mail/gmail.mjs`、文面は `lib/event/mail/confirmation.mjs`。
外部ライブラリは使わず、Node の `fetch` だけで Gmail API を呼んでいる。

**すべての操作を `architect@potenitas.com` でログインした状態で行うこと。**
別のアカウントで作ると、そのアカウントからしか送信できない。

## 1. Google Cloud プロジェクトの作成

<https://console.cloud.google.com/projectcreate>

* プロジェクト名: `tsam-event-mail`（任意）
* 組織 / 場所: 既定のままでよい

作成後、画面上部のプロジェクト選択で、このプロジェクトが選ばれていることを確認する。
以降のURLは、末尾に `?project=<プロジェクトID>` を付けると確実に切り替わる。

## 2. Gmail API を有効化する

<https://console.cloud.google.com/apis/library/gmail.googleapis.com>

「有効にする」を押す。

## 3. OAuth 同意画面を設定する

<https://console.cloud.google.com/auth/overview>

* User Type: **外部**（Google Workspace 契約がある場合は「内部」でよい。
  内部にできるなら、そのほうが審査もテストユーザー登録も不要になる）
* アプリ名: `TSAM交流会 メール送信`
* ユーザーサポートメール / デベロッパーの連絡先: `architect@potenitas.com`

### スコープ

「スコープを追加または削除」から次の1つだけを追加する。

```
https://www.googleapis.com/auth/gmail.send
```

`gmail.send` は**送信専用**で、受信トレイの読み取り権限を含まない。
より広い `https://mail.google.com/` は使わない。

### テストユーザー（User Type が「外部」の場合）

公開ステータスが「テスト」のままでよい。「テストユーザー」に
`architect@potenitas.com` を追加する。

> **注意**: テストのままだと、リフレッシュトークンの有効期限が **7日** になる。
> 7日ごとに再取得するのは現実的でないため、**公開ステータスを「本番環境」に切り替える**こと。
> `gmail.send` は機密性の高いスコープだが、**自分のアカウントにのみ送信する用途では
> Google の審査（検証）を通さなくても動作する**。未検証の警告画面が出たら
> 「詳細」→「（安全でないページ）に移動」で進める。

## 4. OAuth クライアント ID を作る

<https://console.cloud.google.com/auth/clients>

* 「クライアントを作成」→ アプリケーションの種類: **デスクトップアプリ**
* 名前: `tsam-event-mail-cli`（任意）

作成後に表示される次の2つを控える。

* クライアント ID（`...apps.googleusercontent.com`）
* クライアントシークレット（`GOCSPX-...`）

デスクトップアプリにするのは、リダイレクト先に `http://localhost` を使えて、
リフレッシュトークンの取得が1台で完結するため。

## 5. リフレッシュトークンを取得する

クライアント ID とシークレットが手元に来たら、こちらで取得用のスクリプトを用意する。
実行すると認可用のURLが表示されるので、ブラウザで開いて
`architect@potenitas.com` で承認する。取得したトークンは `.env.local` にのみ書き、
リポジトリにはコミットしない。

手動で行う場合は <https://developers.google.com/oauthplayground/> でも取得できる。
その場合は右上の歯車で「Use your own OAuth credentials」を有効にし、
上記のクライアント ID とシークレットを入力する。
（OAuth Playground を使うときは、手順4のリダイレクト URI に
`https://developers.google.com/oauthplayground` を追加する必要がある）

## 6. 環境変数

`.env.local`（ローカル）と Vercel の環境変数（本番）に登録する。

| 変数名 | 値 |
| --- | --- |
| `GOOGLE_CLIENT_ID` | 手順4のクライアント ID |
| `GOOGLE_CLIENT_SECRET` | 手順4のクライアントシークレット |
| `GMAIL_REFRESH_TOKEN` | 手順5で取得したリフレッシュトークン |
| `MAIL_FROM` | `TSアセットマネジメント合同会社 <architect@potenitas.com>` |

いずれも `NEXT_PUBLIC_` を付けない。付けるとブラウザに配信されるバンドルへ埋め込まれる。

## 7. 送信できる状態かの確認

環境変数を入れたあと、こちらで実際に1通送るテストを行う。
`sendMail()` はトークン取得と送信の2回だけ通信し、失敗時の例外に
クライアントシークレットやトークンを含めない作りにしてある。

## 補足

### なぜサービスアカウントを使わないか

サービスアカウントで個人のGmailアドレスから送るには、Google Workspace の
ドメイン全体の委任が必要になる。`architect@potenitas.com` が Workspace 管理下に
あるなら委任方式のほうが運用は楽（トークンの失効がない）なので、その場合は
方式を切り替える判断もできる。現状は、Workspace の有無に依存しない
リフレッシュトークン方式にしてある。

### 送信元の表示名

`MAIL_FROM` に `表示名 <アドレス>` の形式を入れると、その表示名で届く。
アドレスだけでもよい。

### 送信の上限

Gmail の1日の送信上限は、無料アカウントで約500通、Workspace で約2,000通。
交流会1回あたりの参加確定メールはこれを大きく下回るため、通常は問題にならない。

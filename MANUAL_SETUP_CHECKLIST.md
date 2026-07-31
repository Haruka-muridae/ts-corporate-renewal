# 手動作業チェックリスト

TSAM AI 認証システムを稼働させるために、**人の手でしか実行できない作業**の一覧。
Google アカウントと Stripe アカウントの操作が必要なため、コードからは実行できない。

上から順に実行すること。各項目の詳細は右端の参照先にある。

> **この作業が終わるまで、システムは動作しない。**
> リポジトリ側の実装とテストは完了しているが、
> Apps Script のデプロイと Stripe の登録が未実施のため公開できない。

---

## A. Google Apps Script

| # | 作業 | 完了 | 参照 |
| --- | --- | --- | --- |
| A-1 | <https://script.google.com/> で新規プロジェクトを作成（例: `TSAM AI Auth`） | ☐ | AUTH_SETUP.md 手順1 |
| A-2 | `gas-auth/*.gs` の21ファイルを貼り付ける（拡張子を除いた名前で） | ☐ | gas-auth/README.md |
| A-3 | `appsscript.json` を `gas-auth/appsscript.json` の内容で置き換える | ☐ | AUTH_SETUP.md 手順1 |
| A-4 | `setupAuthSystem()` を実行し、4種類の権限を承認する | ☐ | AUTH_SETUP.md 手順2 |
| A-5 | Drive の `マイドライブ/TSAM AI/Auth/` に4ファイルができたことを確認 | ☐ | AUTH_SETUP.md 手順2 |
| A-6 | 認証設定シートの `APP_BASE_URL` に `https://tsam-ai.com/` を入力 | ☐ | AUTH_SETUP.md 手順3 |
| A-7 | `benchmarkPasswordHashing()` を実行し、`PBKDF2_ITERATIONS` を決める | ☐ | AUTH_SETUP.md 手順9 |
| A-8 | ウェブアプリとしてデプロイ（実行=自分／アクセス=全員） | ☐ | AUTH_SETUP.md 手順4 |
| A-9 | 発行された `/exec` URL を控える | ☐ | AUTH_SETUP.md 手順4 |
| A-10 | `auth/config.js` の `apiUrl` に `/exec` URL を設定してコミット | ☐ | AUTH_SETUP.md 手順5 |
| A-11 | `checkAuthSetup()` を実行し、設定の抜けが無いことを確認 | ☐ | AUTH_SETUP.md 手順8 |

> **A-2 の注意:** 既存の `gas/`（お気に入り機能）とは **別プロジェクト**にすること。
> 同じプロジェクトへ入れると `CONFIG` などの名前が衝突し、両方が壊れる。

> **A-5 でできる4ファイル:** `TSAM AI ユーザー管理` / `TSAM AI 認証ログ` /
> `TSAM AI 認証設定` / `TSAM AI 法務文書`
>
> `TSAM AI 法務文書` には制定時点の3文書（利用規約・プライバシーポリシー・特商法表記）が
> 投入される。以降、`/legal/` の条文はここが正本になる。

> **A-4 で自動生成される Script Properties:**
> `AUTH_ROOT_FOLDER_ID` / `AUTH_FOLDER_ID` / `AUTH_USER_SPREADSHEET_ID` /
> `AUTH_LOG_SPREADSHEET_ID` / `AUTH_CONFIG_SPREADSHEET_ID` /
> `AUTH_LEGAL_SPREADSHEET_ID` /
> `SESSION_SECRET` / `TOKEN_SECRET` / `PASSWORD_PEPPER` / `STRIPE_WEBHOOK_URL_KEY`
>
> 再実行しても既存の値は上書きされない。バックアップを取ること。
> **`PASSWORD_PEPPER` を失うと全利用者がパスワード再設定を強いられる。**

> **A-6 が未設定だと、パスワード案内メールが送信されない**（URLを組み立てられないため）。

---

## B. 管理者アカウント

| # | 作業 | 完了 | 参照 |
| --- | --- | --- | --- |
| B-1 | `architect@potenitas.com` 宛の初期設定メールを確認 | ☐ | AUTH_SETUP.md 手順7 |
| B-2 | 届かない場合、`sendAdminSetupLink()` で再送 | ☐ | AUTH_SETUP.md 手順7 |
| B-3 | それでも届かない場合、`printAdminSetupLink()` で実行ログへURLを出力 | ☐ | AUTH_SETUP.md 手順7 |
| B-4 | 案内URLからパスワードを設定（12文字以上） | ☐ | ― |
| B-5 | **B-3 を使った場合、Apps Script の実行ログを削除する** | ☐ | SECURITY_NOTES.md 5 |

> 初期パスワードはコードにもドキュメントにも書いていない。
> 管理者自身が設定するまで、管理者アカウントは `pending` でログインできない。

---

## C. Stripe（テストモード）

| # | 作業 | 完了 | 参照 |
| --- | --- | --- | --- |
| C-1 | テストモードのシークレットキー（`sk_test_...`）を取得 | ☐ | STRIPE_SETUP.md 手順2 |
| C-2 | Script Properties へ `STRIPE_SECRET_KEY` として登録 | ☐ | STRIPE_SETUP.md 手順2 |
| C-3 | 商品と料金（継続課金）を作成し、Price ID を控える | ☐ | STRIPE_SETUP.md 手順1 |
| C-4 | 認証設定シートの `plans` へ登録し、`enabled = TRUE` にする | ☐ | STRIPE_SETUP.md 手順3 |
| C-5 | Script Properties の `STRIPE_WEBHOOK_URL_KEY` の値を控える | ☐ | STRIPE_SETUP.md 手順4 |
| C-6 | Webhook エンドポイントを登録（URL に `?path=stripe-webhook&k=＜合言葉＞`） | ☐ | STRIPE_SETUP.md 手順4 |
| C-7 | 送信イベント5種を選択 | ☐ | STRIPE_SETUP.md 手順4 |
| C-8 | テストカード `4242 4242 4242 4242` で決済を実行 | ☐ | STRIPE_SETUP.md 手順5 |
| C-9 | `stripe_events` シートに `processed` の行ができたことを確認 | ☐ | STRIPE_SETUP.md 手順5 |
| C-10 | `users` シートに利用者が作られたことを確認（`account_status = pending`） | ☐ | STRIPE_SETUP.md 手順5 |
| C-11 | 決済に使ったアドレスへ初期設定メールが届いたことを確認 | ☐ | STRIPE_SETUP.md 手順5 |
| C-12 | Stripe ダッシュボードから同じイベントを再送し、行が増えないことを確認 | ☐ | STRIPE_SETUP.md 手順5 |

> **C-6 の URL は秘密情報として扱うこと。** 合言葉が含まれる。
> 共有・スクリーンショット・課題管理システムへの貼り付けを避ける。

> **既知の制約:** Apps Script が 302 を返すため、Stripe 側で「失敗」と表示される場合がある。
> 処理自体は成功しており、再送されても冪等性により二重処理は起きない。
> 表示上の失敗が許容できない場合は中継（Cloudflare Workers）を置く構成Bを採る。

---

## D. Web 公開

| # | 作業 | 完了 | 参照 |
| --- | --- | --- | --- |
| D-1 | ブランチ `feat/auth-portal-stripe` をレビューし `main` へマージ | ☐ | DEPLOYMENT.md |
| D-2 | GitHub Pages へ反映されたことを確認（数分） | ☐ | DEPLOYMENT.md |
| D-3 | Settings → Pages で **Enforce HTTPS** を有効化 | ☐ | SECURITY_NOTES.md 11 |
| D-4 | Drive のフォルダとスプレッドシートが「制限付き」共有であることを確認 | ☐ | SECURITY_NOTES.md 10 |

---

## E. 通し確認（公開判定の根拠）

**すべて成功するまで公開可としないこと。**

| # | 確認内容 | 期待する結果 | 完了 |
| --- | --- | --- | --- |
| E-1 | `/login/` を開く | ログイン画面が表示される | ☐ |
| E-2 | 未登録アドレスでログイン | 「メールアドレスまたはパスワードが正しくありません。」 | ☐ |
| E-3 | 管理者でログイン（未決済） | Portal へ入れる | ☐ |
| E-4 | 管理者を誤パスワードでログイン | 失敗する | ☐ |
| E-5 | 誤パスワードで5回連続失敗 | 「ログインを一時的に制限しています。」 | ☐ |
| E-6 | `/pricing/` からテスト決済 | `/payment/success/` へ戻る | ☐ |
| E-7 | 案内メールからパスワード設定 | `/login/` へ案内される | ☐ |
| E-8 | 一般利用者でログイン | Portal へ入れる | ☐ |
| E-9 | 同じ設定リンクをもう一度開く | 使用済みで拒否される | ☐ |
| E-10 | Portal からログアウト | `/login/` へ戻る | ☐ |
| E-11 | ログアウト後に `/portal/` を直接開く | `/login/` へ戻される | ☐ |
| E-12 | `/password/reset/` で再設定を申し込む | 登録の有無にかかわらず同じ文言 | ☐ |
| E-13 | 再設定リンクでパスワードを変更 | 変更前のセッションが無効になる | ☐ |
| E-14 | Stripe でサブスクリプションを解約 | その利用者がログインできなくなる | ☐ |
| E-15 | スマートフォン実機で `/login/` を開く | 横スクロールが出ない | ☐ |
| E-16 | `/apps/` を開く（回帰確認） | 従来どおり動作する | ☐ |

---

## F. 本番（ライブモード）へ切り替える

E がすべて成功したあとに実施する。

| # | 作業 | 完了 | 参照 |
| --- | --- | --- | --- |
| F-1 | Stripe をライブモードへ切り替え | ☐ | STRIPE_SETUP.md 手順6 |
| F-2 | ライブモードで商品と Price を作り直す | ☐ | STRIPE_SETUP.md 手順6 |
| F-3 | `plans` シートの `stripe_price_id` をライブの値へ更新 | ☐ | STRIPE_SETUP.md 手順6 |
| F-4 | `STRIPE_SECRET_KEY` をライブキー（`sk_live_...`）へ更新 | ☐ | STRIPE_SETUP.md 手順6 |
| F-5 | ライブモードで Webhook エンドポイントを作り直す | ☐ | STRIPE_SETUP.md 手順6 |
| F-6 | 実カードで1件だけ通し確認し、必要なら返金する | ☐ | STRIPE_SETUP.md 手順6 |

> テストモードとライブモードは、キー・Price ID・Webhook がすべて別。
> 片方だけ切り替えると決済が通らない。

---

## G. 法務ページの公開（条文を直すときだけ）

`/legal/` の3ページはスプレッドシート「TSAM AI 法務文書」から生成される。
**条文を直す予定が無いあいだ、この節の作業は不要**（ページは既に公開済み）。

| # | 作業 | 完了 | 参照 |
| --- | --- | --- | --- |
| G-1 | GitHub で Fine-grained personal access token を作成（対象リポジトリのみ／Contents: Read and write のみ） | ☐ | docs/instructions/2026-07-31-github-token.md |
| G-2 | Script Properties に `GITHUB_TOKEN` として保存 | ☐ | 同上 §2 |
| G-3 | 認証設定シートの `GITHUB_REPO` / `GITHUB_BRANCH` を確認 | ☐ | 同上 §3 |
| G-4 | 条文を「TSAM AI 法務文書」で編集する | ☐ | docs/specs/legal-cms-spec-v1.md §3 |
| G-5 | `previewLegalDocs()` で見た目を確認する | ☐ | 同上 §5-1 |
| G-6 | 実質改訂なら `meta` の `version` を手で上げる | ☐ | 同上 §5-3 |
| G-7 | `publishLegalDocs()` を実行する | ☐ | 同上 §5-2 |
| G-8 | 版を上げた場合、認証設定シートの `TOS_VERSION` も更新する | ☐ | 同上 §5-5 |

> **`legal/*/index.html` を手で編集しないこと。** 次の公開で上書きされる。

> **G-8 を忘れると、改訂前の版で同意した申込みを受け付け続ける。**
> `publishLegalDocs()` は版が上がったことを検知して実行ログに警告を出す。

---

## H. 公開後も残る判断事項

コードでは決められないもの。運用開始前に方針を決めること。

| 項目 | 決めること | 参照 |
| --- | --- | --- |
| Portal に並べるアプリ | どのアプリを本番として公開するか。`auth/apps.js` は空のまま | auth/apps.js |
| 法務文書の弁護士確認 | 13項目の指摘への対応。条文の修正は G を経由する | docs/legal-review-notes.md |
| `past_due` の扱い | 支払い未確認の利用者に使わせるか（既定は使わせない） | AUTH_SETUP.md |
| Webhook の構成 | 構成A（手軽）か構成B（署名検証あり）か | STRIPE_SETUP.md 手順4 |
| `PBKDF2_ITERATIONS` | 実測に基づく値。ログイン1回 0.5〜1.5 秒が目安 | SECURITY_NOTES.md 2 |

---

## 定期的な確認

| 頻度 | 内容 |
| --- | --- |
| 週次 | `system_error_logs` シート（Webhook・メールの失敗） |
| 週次 | `stripe_events` シートに `failed` の行が無いか |
| 月次 | `login_logs` の失敗が特定アカウントに集中していないか |
| 随時 | Stripe ダッシュボードの Webhook 配信状況 |

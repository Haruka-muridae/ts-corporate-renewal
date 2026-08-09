# gas-isso — 一想（ISSO）の Apps Script ソース

**第1段（発注者専用）のバックエンド。** 実装指示書は
[../docs/pipeline/implementation-guide-v1_0-personal.md](../docs/pipeline/implementation-guide-v1_0-personal.md)。

> ## このディレクトリは配信されません
>
> `public/` の外にあるため、`https://tsam-ai.com/` からは届きません。
> `gas-auth/` と同じ「配信しないソース置き場」です。
>
> **ただしリポジトリは GitHub 上で公開されています。**
> 鍵・トークン・スプレッドシートID・内部URL・実在するメールアドレスを書かないこと。
> 秘密の値は **Script Properties** に置きます。

---

## 反映の仕方（`git push` では反映されません）

`gas-auth/` と同じで、**Apps Script はリポジトリの外にあります。**

```
デプロイ → デプロイを管理 → 既存のデプロイの「編集」（鉛筆アイコン）
       → バージョン「新バージョン」 → デプロイ
```

**「新しいデプロイ」ではなく「デプロイを管理」から既存を編集してください。**
新規に作ると URL が変わり、スマホのホーム画面に追加したものが動かなくなります。

`clasp` を使う場合:

```bash
cd gas-isso
clasp push
```

### デプロイ設定（**変えないこと**）

| 項目 | 値 |
| --- | --- |
| 次のユーザーとして実行 | **自分** |
| アクセスできるユーザー | **自分のみ** |

`appsscript.json` の `webapp` にも同じ設定が入っています。
**「全員」に変えると、URL を知っている人が誰でも操作できるようになります**
（Note Draft Helper が「全員」なのは外部ページから `fetch` するためで、
一想は画面ごと GAS 上に置くため「自分のみ」で成立します）。

---

## ファイル

| ファイル | 役割 |
| --- | --- |
| `appsscript.json` | マニフェスト。Webアプリ設定とスコープ |
| `Config.gs` | **列定義・状態値・Script Properties。** 列を足すときはここだけを直す |
| `Sheets.gs` | **SpreadsheetApp を触る唯一のファイル。** ポートとメモリ実装 |
| `Prompts.gs` | **生成物。手で編集しない**（下記） |
| `Themes.gs` | テーマ。消すと版とシーンも消す |
| `Versions.gs` | 段階ごとの版・採用・上流の収集 |
| `Scenes.gs` | 台本のシーンと **AC-09 の検証**（規則はここだけ） |
| `Generation.gs` | 依頼（`generation_queue`）と結果の取り込み |
| `Settings.gs` | 目安の字数・口調・**X の月次上限** |
| `Http.gs` | **UrlFetchApp を触る唯一のファイル。** RFC 3986 の符号化もここ |
| `Oauth1.gs` | X 用の OAuth 1.0a 署名。**外部ライブラリを使わない** |
| `Posts.gs` | 投稿の記録と、**送る前に止める判定**（未採用・二重投稿・月次上限） |
| `Threads.gs` | Threads への投稿（2段階）とトークン更新 |
| `X.gs` | X への投稿 |
| `Api.gs` | **画面が呼ぶ処理の本体。** `store` を引数で受けるのでテストできる |
| `Main.gs` | `doGet` と `google.script.run` の入口。**薄く保つ** |
| `Index.html` / `Style.html` / `Script.html` | 画面 |

以降、実装順序に沿って `Helper.gs` / `Logs.gs` が加わります。

> Apps Script はフォルダを持たないため、ここも平置きにしてあります（`gas-auth/` と同じ）。

---

## `Prompts.gs` は生成物です

出どころは **`lib/pipeline/prompts/definitions.mjs`**（単一ソース）。

```bash
node lib/pipeline/prompts/build.mjs          # 作り直す
node lib/pipeline/prompts/build.mjs --check  # 古ければ失敗する
```

**ここを手で直すと、第2段（会員向け）の `LlmClient` と食い違います。**
直すのは `definitions.mjs` です。作り直し忘れは
`tests/unit/pipeline-prompts.mjs` が検出します。

---

## テスト

**Node 上で走ります。実シートには一切書き込みません。**

```powershell
node tests/run.mjs pipeline-gas       # gas-isso の骨組み
node tests/run.mjs pipeline-prompts   # プロンプトの単一ソースと生成物
```

`Sheets.gs` が SpreadsheetApp を1か所に閉じ、その外は**テーブルアクセサ**に対して
書いてあるため、テストは `IssoSheets_memoryTables()` を差すだけで済みます。
**SpreadsheetApp の偽物は用意していません**（ハーネスが用意しないので、
実シート経路を触れば `ReferenceError` で落ちて気づけます）。

ハーネスは [../tests/helpers/isso-gas-harness.mjs](../tests/helpers/isso-gas-harness.mjs)。
`gas-auth` 用のものとは**別に用意しています**（本番認証系のテスト基盤を
別系統の都合で変えないため。repository-structure §4-1・§5-3）。

### GAS 上での確認

実シートに対する確認は、実装が進んだ段階で `Tests.gs` を足して行います。
**そちらは実シートへ書き込むため、本番のスプレッドシートでは実行しないこと。**

---

## Script Properties

| キー | 内容 | いつ要るか |
| --- | --- | --- |
| `ISSO_SPREADSHEET_ID` | 一想スプレッドシートのID | 最初から |
| `HELPER_SPREADSHEET_ID` | Note Draft Helper の記事キューのID | バトン渡し（実装順序8） |
| `HELPER_SHEET_NAME` | 同・シート名 | 同上 |
| `THREADS_*` | Threads の認証情報 | Threads 投稿 |
| `X_*` | X の認証情報 | X 投稿 |

**値が無いときは、使う時点で名前付きの例外になります**（起動時に全体を巻き添えにしません）。
`Config.gs` は BOM と前後の空白を落としてから読みます——貼り付け経路によっては
先頭に BOM が混ざり、そのままだとIDが一致せず「シートが見つからない」になるためです。

---

## シートの見出しについて

**列は位置ではなく見出し名で読みます。**

このシートは発注者が手で開いて眺めるもの（「原本は Sheets」という設計原則）なので、
**列を並べ替えたり間に列を挿したりすることは普通に起こります。**
位置で読むと、そのとき静かに壊れて別の列を読み書きします。

見出しが足りない場合は、**何が足りないかを名指しで**落とします。

# カレンダー通知 V2｜公開手順（運営者向け）

作成: 2026年8月10日

V2（ライセンスゲート＋セットアップ自動化）を本番へ出すために、
**人の手でしか実行できない作業**を依存順に1本化したもの。

> **上から順に実行すること。** 前の作業が終わっていないと次が失敗する形に並べてある。
> 途中で止めた場合も、この表の ☐ を見れば「どこから再開すればよいか」が分かる。

> **進捗（2026-08-10 の報告時点）: R-1〜R-18 まで完了の連絡あり。**
> このうち外部から確かめられたのは R-5（`/v1/health` が
> `{"ok":true,"version":"2.0.0"}` を返す）と、`/v1/evaluate` が正常応答すること。
> それ以外は報告に基づく記録である（リポジトリの外で起きたことは観測できない）。

| | |
| --- | --- |
| コード | ブランチ `feat/notifier-v2-license-gate` |
| Workers | [workers/notifier-gate/README.md](../workers/notifier-gate/README.md) |
| 認証系 GAS | [gas-deployment-log.md](./gas-deployment-log.md)「カレンダー通知 V2 の貼り替え」 |
| テンプレート | [gas-notifier/README.md](../gas-notifier/README.md) |
| 実機確認 | [notifier-v2-acceptance-checklist.md](./notifier-v2-acceptance-checklist.md) |
| 設計の理由 | [notifier-design-notes.md](./notifier-design-notes.md) |

---

## 0. 何が変わるのか（作業前に読む）

V1 は利用者の Apps Script が全部を持っていた。コピーした人は解約後も
通知を受け取り続けられ、**サブスクリプションとして成立していなかった。**

V2 では「判定」と「VAPID JWT の発行」を運営の Workers へ移した。
**ライセンスが無ければ、判定も署名も返らない。**

そのぶん、動かすまでに揃える相手が3つになる。

```
[Cloudflare Workers: notifier-gate]  ← R-1〜R-5 で用意する
        ↕ 共有シークレット（R-10b で一致を確かめる）
[認証系 GAS: gas-auth]                ← R-6〜R-10 で用意する
        ↑ ライセンスキーの発行
[録音アプリ] → [利用者のテンプレート] ← R-11〜R-21 で用意する
```

**この3つのどれかが欠けると通知は動かない。** 順番に意味があるのはそのためで、
たとえば共有シークレットを片方にしか入れていない状態では、
ライセンス照会が必ず失敗する（症状は「ご契約を確認できません」）。

---

## R. 作業一覧

### Workers（notifier-gate）

| # | 作業 | 完了 | 参照 |
| --- | --- | --- | --- |
| R-1 | KV namespace を作る<br>`npx wrangler kv namespace create LICENSE_CACHE --config workers/notifier-gate/wrangler.jsonc` | ☑ | README §5-1 |
| R-2 | 出力された id を `workers/notifier-gate/wrangler.jsonc` の `TODO_KV_NAMESPACE_ID` へ貼り、コミットする | ☑ | ― |
| R-3 | VAPID の鍵を作る<br>`node workers/notifier-gate/scripts/generate-vapid-keys.mjs` | ☑ | README §4 |
| R-3.5 | **登録する前に鍵ペアを検証する**（必須）<br>`node workers/notifier-gate/scripts/check-vapid-keys.mjs` | ☑ | 下記 |
| R-4 | シークレットを3件登録する<br>`VAPID_PRIVATE_KEY` / `VAPID_PUBLIC_KEY` / `AUTH_GAS_SHARED_SECRET` | ☑ | README §5-2 |
| R-5 | デプロイして URL を確かめる<br>`npm run deploy:notifier-gate` → `curl https://notifier-gate.potenitas-lp.workers.dev/v1/health` | ☑ | README §5-3・§5-4 |

#### R-3 の出力の見分け方

2つの値が続けて出る。**どちらがどちらかを長さで確かめられる。**

| 見出し | 中身 | 長さの目安 | 特徴 |
| --- | --- | --- | --- |
| `VAPID_PRIVATE_KEY` | PKCS#8 / base64 | **184 文字** | `+` `/` `=` を含みうる |
| `VAPID_PUBLIC_KEY` | base64url | **87 文字** | `+` `/` `=` を含まない。ブラウザの `applicationServerKey` と同じ値 |

長さが大きく違うので取り違えは起きにくいが、**取り違えると本番で
`/v1/vapid` が 500 になるまで気づけない**（登録後は読み返せないため）。

> **秘密鍵をファイルへ保存しない。** リポジトリへは絶対に入れない。
> 一時ファイルを経由する場合（下記）も、登録できたら必ず消す。

#### R-3.5: 登録する前にペアを検証する（**必須**）

シークレットは `wrangler secret put` で登録したあと**中身を読み返せない。**
貼り付けを1文字でも誤ると、気づけるのは本番で 500 が出たときになる。
実機で実際にそうなった（2026-08-11）。**R-4 の前に必ず通すこと。**

```powershell
node workers/notifier-gate/scripts/check-vapid-keys.mjs
```

1行目に秘密鍵、2行目に公開鍵を貼り、入力を終える。通れば
「形式が正しい」「互いに対になっている」の両方が確定する（公開鍵で署名を
検証している）。**値そのものは表示されない。**

> ### ⚠ 対話的な入力が効かない環境がある
>
> 入力の終わりは PowerShell で `Ctrl+Z` → Enter、bash で `Ctrl+D` だが、
> **VSCode の統合ターミナルではこれが効かないことがある**（キーが
> エディタ側へ取られる）。入力が終わらず、コマンドが返ってこない。
>
> その場合はファイルからリダイレクトする。

```powershell
# 1) 2行だけのファイルを作る（1行目=秘密鍵 / 2行目=公開鍵）
notepad keys.tmp

# 2) 標準入力として渡す
Get-Content keys.tmp | node workers/notifier-gate/scripts/check-vapid-keys.mjs

# 3) 使い終わったら必ず消す
Remove-Item keys.tmp
```

> `keys.tmp` は**リポジトリの外**に作ること。
> 消し忘れを防ぐため、作業ディレクトリではなく一時フォルダを勧める。
>
> **引数では渡さない。** コマンドライン引数はシェルの履歴と
> プロセス一覧に残る（スクリプトが標準入力から読むのはこのため）。

> **R-4 の `AUTH_GAS_SHARED_SECRET` は R-7 と同じ値にする。**
> ここで決めた値を控えておくこと（安全な場所に。この文書には書かない）。

> **R-5 で出力された URL が
> `https://notifier-gate.potenitas-lp.workers.dev` と一致することを必ず確認する。**
> アカウントのサブドメインが想定と違うと、ここで初めて分かる。
> 違っていた場合は `workers/notifier-gate/origin.mjs` を直し、
> `node tests/run.mjs notifier-gate` を通してから先へ進む（4か所が自動で照合される）。

### 認証系 GAS（gas-auth）

| # | 作業 | 完了 | 参照 |
| --- | --- | --- | --- |
| R-6 | 5ファイルを貼り替える<br>`Notifier.gs`（新規）/ `Config.gs` / `Main.gs` / `Users.gs` / `Setup.gs` | ☑ | [gas-deployment-log.md](./gas-deployment-log.md) |
| R-7 | Script Property `NOTIFIER_SHARED_SECRET` に **R-4 と同じ値**を入れる | ☑ | 同上 |
| R-8 | `setupAuthSystem()` を実行する（`users` シートのヘッダーを17列へ広げる） | ☑ | 同上 |
| R-9 | 「デプロイを管理」からバージョンを更新する（**新しいデプロイを作らない**） | ☑ | 同上 |
| R-10 | 反映結果を [gas-deployment-log.md](./gas-deployment-log.md) の履歴表へ追記する | ☑ | 同上 |
| R-10b | **共有シークレットが両側で一致しているかを確かめる**（下記） | ☐ | 下記 |

> **R-8 で既存の利用者データは上書きされない。** 増えるのは
> `users` の Q列（`notifier_license_key`。既存行は空欄のまま）と、
> 設定シートの `NOTIFIER_ENTITLEMENT`（初期値 `all_active`）の1行だけ。

> **R-9 で「新しいデプロイ」を選ぶと `/exec` URL が変わる。**
> そうなると `public/auth/config.js` と `workers/notifier-gate/wrangler.jsonc` の
> `AUTH_GAS_URL` を両方直すことになる。既存デプロイのバージョン更新を選ぶこと。

#### `wrangler tail` の読み方（**先に読むこと**）

> ## ⚠ `Ok` は「HTTP が成功した」という意味ではない
>
> `wrangler tail` が行末に出す `Ok` / `Exception` は、**ワーカーが例外を投げずに
> 応答を返したか**だけを表す。返した応答が 200 なのか 4xx なのかは見ていない。
>
> | tail の表示 | 実際に返した応答 |
> | --- | --- |
> | `Ok` | 200 も **429 も 402 も 401 も** すべてここに入る |
> | `Exception` | 500（ハンドラの外まで例外が出た場合） |
>
> **`Ok` が並んでいることは、正常に動いている証拠にならない。**
> 2026-08-11 の実機切り分けで、「ゲート側は `/v1/vapid` が Ok 連続・error ゼロ」
> という観測から**ゲートは正常と判断し、原因をテンプレート側の取り出し不具合と
> 誤って絞り込んだ。** 実際は全件 429（`RATE_LIMITED`）で、**切り分けが2往復
> 遅れた。**

判定は次の3つで行う。tail の `Ok` / `Exception` では**行わない**。

| 見るもの | 何が分かるか |
| --- | --- |
| `(error) notifier-gate error: <path> phase=… name=… message=…` | 500 になった要求と、その発生段階（`import-key` / `sign` など） |
| `license verify: reachable=… valid=… status=…` | ライセンス照会の結果（R-10b で使う） |
| 利用者側の `health.lastGateError`（`<path> -> <符号>`） | **200 以外で返したときの符号。** 4xx はここにしか出ない |

**4xx は tail から読めない**（診断ログを出さないため）。`RATE_LIMITED` や
`LICENSE_EXPIRED` を疑うときは、録音アプリの「通知の鍵」の行か、通知用シートの
`LAST_GATE_ERROR` を見る。状態コードそのものを見たい場合は `--status error`
（4xx/5xx だけに絞る）を付けるか、`curl -i` で直接叩く。

#### R-10b: 共有シークレットの一致を確かめる

> **先に notifier-gate を deploy し直すこと**（`npm run deploy:notifier-gate`）。
> 下で読むログは、コミット `71e73af` で足したものである。それ以前に deploy した
> Worker は、この行を出さない。

**応答本文からは確かめられない。** 「無効なキー」と「シークレットが合っていない」は
どちらも `expired` になる（区別できると、このエンドポイントがキーの総当たり確認に
使えてしまうため、意図的にそうしてある）。

そこで運用者だけが見られるログで確かめる。

```powershell
# 1) ログを流したまま待つ
npx wrangler tail notifier-gate --format pretty

# 2) 別のウィンドウから、実在しないキーで1回叩く
curl -X POST https://notifier-gate.potenitas-lp.workers.dev/v1/evaluate `
  -H "Content-Type: application/json" `
  -d '{\"licenseKey\":\"ZZdiagnosticNotARealKeyZZZZZZZZZZZZZZZZZZZZ\",\"settings\":{},\"events\":[],\"sentDigest\":[]}'
```

ログの1行を読む。

| ログ | 意味 | すること |
| --- | --- | --- |
| `reachable=true valid=false status=not_found` | **正常。** 認証系まで届き、そんなキーは無いと答えた | ― |
| `reachable=true valid=false status=not-configured` | Workers 側に `AUTH_GAS_SHARED_SECRET` が入っていない | R-4 をやり直す |
| `reachable=false ... status=malformed` | 認証系が `success:false` を返した。**シークレット不一致**の疑いが濃い | R-4 と R-7 の値を突き合わせる |
| `reachable=false ... status=unreachable` | 認証系へ届かない | `AUTH_GAS_URL` と、GAS のデプロイ状態を確認する |

> **ログにライセンスキーもハッシュも出ない。** `status` は認証系が返す語で、
> 個人情報を含まない（自動テストで見張っている）。

### テンプレート（gas-notifier v2）

| # | 作業 | 完了 | 参照 |
| --- | --- | --- | --- |
| R-11 | 新しいスプレッドシートを作る（例:「TSAM AI 録音通知 v2」） | ☑ | [gas-notifier/README.md](../gas-notifier/README.md) §1 |
| R-12 | `.gs` 7ファイルと `SidebarSetup.html` を同じ名前で貼り付ける | ☑ | 同上 |
| R-13 | `appsscript.json` を置き換える（**スコープは7つ**） | ☑ | 同上 §1-1 |
| R-14 | Calendar の Advanced Service（v3・識別子 `Calendar`）を有効にする | ☑ | 同上 |
| R-15 | **`setupNotifier()` を実行しない**（運営者の鍵とトリガーがテンプレートに残るため） | ☑ | 同上 |
| R-16 | 共有を「リンクを知っている全員: 閲覧者」にする | ☑ | 同上 |
| R-17 | URL の末尾を `/edit...` → `/copy` にしたものを控える | ☑ | 同上 |

> **R-12 のファイルは7つ**: `Api.gs` / `CalendarSync.gs` / `Code.gs` / `Gate.gs` /
> `Push.gs` / `Setup.gs` / `Store.gs`。
> **`lib_jsrsasign.gs` は存在しない**（V2 で不要になった）。

### 録音アプリ側とサイトの公開

| # | 作業 | 完了 | 参照 |
| --- | --- | --- | --- |
| R-18 | `notifier-config.js` の `TEMPLATE_COPY_URL` を R-17 の URL にしてコミットする | ☑ | ― |
| R-19 | ブランチを `main` へマージする | ☐ | ― |
| R-20 | サイトを公開する<br>`npm run deploy` | ☐ | [deployment-cloudflare.md](./deployment-cloudflare.md) |
| R-21 | `sw.js` と `manifest.webmanifest` の Content-Type を確認する | ☐ | 同上 §5 |

> **`npm run deploy`（サイト）と `npm run deploy:notifier-gate`（ゲート）は別物である。**
> 片方を実行してももう片方は更新されない。

### 実機確認と後始末

| # | 作業 | 完了 | 参照 |
| --- | --- | --- | --- |
| R-22 | 実機チェックリストを実施する | ☐ | [notifier-v2-acceptance-checklist.md](./notifier-v2-acceptance-checklist.md) |
| R-23 | 結果を [calendar-notifier-acceptance.md](./calendar-notifier-acceptance.md) §9 へ記録する | ☐ | ― |
| R-24 | V1 テンプレートを廃止する（下記） | ☐ | ― |

---

## V1 テンプレートの廃止（R-24）

外部への配布実績は無く、運営者自身の検証コピーだけである。したがって
**移行の受け皿は用意せず、作り直しとする**（2026-08-10 決定）。

1. V1 のテンプレートシートの共有を切る（「制限付き」へ戻す）
2. シート名の先頭へ `【廃止】` を付ける（誤って開いたときに気づけるように）
3. 運営者自身の検証コピーで、Apps Script のトリガーを削除する
   （放置すると、動かないゲートへ5分ごとに要求が飛び続ける）
4. **すぐには消さない。** V2 で問題が出たときの比較対象として1か月は残す

> V1 のコピーは V2 のゲートを知らないため、**放っておいても通知は止まる**
> （VAPID の鍵はコピー側にあるので送信自体は続くが、判定は自前で行うため
> ライセンスとは無関係に動き続ける）。トリガーを消すのはそのためである。

---

## 動かないときの切り分け

症状から見る順序。**上から順に確かめると、いちばん早く原因に着く。**

| 症状 | 最初に見る場所 |
| --- | --- |
| 録音アプリの「ご契約」が「確認できません」 | **R-10b を実行する。** R-4 と R-7 の値が一致しているか。片方だけの設定が最も多い |
| 「ご契約」が「未確認」のまま | まだ一度も同期していない。5分待つか［接続テスト］を押す |
| 「通知の鍵」が × | **その行に出ている符号を読む**（`/v1/vapid -> …`）。`RATE_LIMITED` なら数分待つ。tail の `Ok` を根拠にゲートを正常と判断しないこと（上記） |
| 公開ボタンで 403 | 2種類ある。ウィザードが見分ける（下記） |
| 通知は届くが中身が汎用 | 2台目の端末で `pending` が空。`sent_log` の `fetchedBy` を見る |
| どの端末にも通知が来ない | シートの `notify_queue` に行があるか。無ければ判定側、あれば送信側 |

> **ログにライセンスキー・接続キー・予定名は出ない。** 出ていたら実装の不具合として
> 報告すること（出さないことを自動テストで見張っている）。

### 公開ボタンの 403（2種類ある）

ウィザードが応答本文から見分けて、別々の画面を出す。

| 種別 | 原因 | ウィザードの案内 |
| --- | --- | --- |
| `API_DISABLED` | 利用者設定（script.google.com/home/usersettings）で Apps Script API が OFF | 設定ページを開かせ、**数秒ごとに公開を試して自動で次へ進む**（トグル1つで直るため） |
| `API_DISABLED_GCP` | スクリプトに紐づく **GCP プロジェクト**で Apps Script API が未有効 | **手動デプロイを主経路にする**（下記） |

#### `API_DISABLED_GCP` は自力設定を主経路にしない（2026-08-11 の実測で変更）

Google Workspace のアカウントでは、スクリプトに紐づく GCP プロジェクトが
`sys-` で始まる**既定プロジェクト**で、利用者からは設定できない。
ワンボタン公開まで進めるには、実測で次が必要だった。

1. Google Cloud で新しいプロジェクトを作る
2. **Apps Script API** を有効にする
3. **Google カレンダー API** を有効にする
   （予定の読み取りに Advanced Calendar Service を使っており、既定プロジェクトで
   有効だったものが切替先へ引き継がれない。**これを忘れると公開は通るのに
   同期だけが失敗する**という分かりにくい壊れ方になる）
4. スクリプトの「プロジェクトの設定」で、その GCP プロジェクトの番号へ切り替える
5. 権限を承認し直す

**一般の利用者に求める工程ではない。** 一方、手動デプロイは
「デプロイ→新しいデプロイ→2つ選ぶ」で終わり、**結果は同じもの**（公開URLも
挙動も変わらない）。したがってウィザードは手動を先に出し、GCP の設定は
「技術者向け・任意」の折りたたみへ置いてある。

この分岐では**自動再試行（ポーリング）も行わない。** 手順が数分がかりで、
途中の再承認でサイドバーを開き直すことになるため、待っていても次へ進めない。
手動で公開したあとは、画面の［公開できたか確かめる］を押す。

> **ワンボタン公開が「効く」のは、既定プロジェクトが個人用（`sys-` 以外）の場合と、
> 上の1〜5を済ませた場合。** 商品としては「使えたら速い経路」であって、
> 前提ではない。セットアップの完走が手動デプロイに依存することを許容している。

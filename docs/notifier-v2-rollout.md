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
| R-4 | シークレットを3件登録する<br>`VAPID_PRIVATE_KEY` / `VAPID_PUBLIC_KEY` / `AUTH_GAS_SHARED_SECRET` | ☑ | README §5-2 |
| R-5 | デプロイして URL を確かめる<br>`npm run deploy:notifier-gate` → `curl https://notifier-gate.potenitas-lp.workers.dev/v1/health` | ☑ | README §5-3・§5-4 |

> **R-3 の秘密鍵をファイルへ保存しない。** 画面の値をそのまま
> `wrangler secret put` へ貼る。リポジトリへは絶対に入れない。

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
| 「通知の鍵」が × | ゲートが応答しているか（`/v1/health`）。次にライセンスが渡っているか |
| 公開ボタンで 403 | Apps Script API が未許可（利用者側の設定。ウィザードが誘導する） |
| 通知は届くが中身が汎用 | 2台目の端末で `pending` が空。`sent_log` の `fetchedBy` を見る |
| どの端末にも通知が来ない | シートの `notify_queue` に行があるか。無ければ判定側、あれば送信側 |

> **ログにライセンスキー・接続キー・予定名は出ない。** 出ていたら実装の不具合として
> 報告すること（出さないことを自動テストで見張っている）。

# gas-notifier — 録音アプリのカレンダー通知（配布用GAS）

ブラウザ録音アプリ（`public/production-app/voice-recorder/`）の
**Googleカレンダー連携通知**を動かすための Apps Script 一式。

この文書は**運営者向け**（テンプレートシートを1度だけ作る手順）。
利用者向けの手順は [docs/calendar-notifier-setup.md](../docs/calendar-notifier-setup.md)。

---

## 0. これは何か（読まずに触らないこと）

**V2 では、判定と署名を運営の Workers が行う。** テンプレートは配管である。

```
[利用者のGoogleアカウント内]
  テンプレートシートのコピー（このコードが同梱されている）
    ├─ 毎分トリガー tick()
    │    ├─ 5分ごと: Calendar API で取得 → 匿名化 → ゲートへ判定を依頼
    │    │            → 返ってきた予定表で notify_queue を更新
    │    └─ 毎分: 期限の来た通知があれば「本文なしPush」を1通だけ送る
    │             （署名 JWT はゲートが発行したもの）
    └─ Webアプリ（doGet/doPost）= 録音アプリ・Service Worker との窓口

[運営: notifier-gate（Cloudflare Workers）]
    ├─ ライセンス検証（認証系GASへ照会）
    ├─ 判定（何を通知するか）
    └─ VAPID JWT の発行

[利用者のブラウザ]
  録音アプリ（/production-app/voice-recorder/）
    ├─ 設定画面（フィルタ・通知タイミング・直近の通知予定・テスト通知）
    ├─ Service Worker: Push受信 → GASから内容を取得 → 表示
    └─ 通知クリック → ?eventId= 付きで録音画面へ
```

**運営へ渡るのは予定の骨格だけ。** 予定名・説明・参加者・カレンダーIDは
利用者のスプレッドシートから出ない。設計の理由は
[docs/notifier-design-notes.md](../docs/notifier-design-notes.md)。

**リポジトリ上のこのディレクトリは配信されない。** `gas-auth/` と同じ扱いで、
中身は利用者の Apps Script エディタへ貼り付けて使う（テンプレートを作る運営者だけ）。

---

## 1. テンプレートシートの作り方（運営者が1度だけ）

1. 新規スプレッドシートを作る。名前は「TSAM AI 録音通知」など、
   利用者がコピー後に見て分かるものにする。
2. 「拡張機能」→「Apps Script」を開く。
3. このディレクトリの `.gs` / `.html` を**同じ名前で**貼り付ける。
   - `Code.gs` / `Setup.gs` / `Api.gs` / `CalendarSync.gs` / `Push.gs` / `Store.gs` / `Gate.gs`
   - `SidebarSetup.html`
4. `appsscript.json` は、プロジェクトの設定で
   「`appsscript.json` マニフェスト ファイルをエディタで表示する」を ON にしてから、
   このディレクトリの内容で**置き換える**。
   - **スコープは7つだけ**（要件 NFR-02）。理由は §1-1。増やさないこと。
   - `Calendar` の Advanced Service が必要。`CalendarApp` では
     `responseStatus`（自分の出欠）が取れず、FR-04 が満たせない。
5. 「サービス」から Google Calendar API（v3、識別子 `Calendar`）を追加する。
   `appsscript.json` を置き換えていれば、この操作で追加済みとして表示される。
6. **このテンプレートでは `setupNotifier()` を実行しない。**
   実行すると運営者のアカウントの鍵とトリガーがテンプレートに残る。
   セットアップは利用者がコピー後に行う。
7. 共有設定を「リンクを知っている全員: 閲覧者」にする。
8. 配布URLは、シートURLの末尾を `/edit...` から `/copy` に差し替えたもの。
   開くとコピー画面になる。これを
   `public/apps/voice-recorder/notifier-config.js` の
   `TEMPLATE_COPY_URL` へ設定する。

### 1-1. スコープが7つある理由（`script.container.ui` を含む）

`appsscript.json` に `oauthScopes` を書くと、**Apps Script の自動スコープ判定が無効になる。**
以後は「コードが実際に使う権限」を1つ残らず自分で列挙しなければならず、
書き漏らした権限は実行時に例外になる。

実機検証で踏んだのがこれで、セットアップウィザードを開いた時点で次のように落ちた。

```
Exception: 指定された権限では Ui.showSidebar を呼び出すことができません。
必要な権限: https://www.googleapis.com/auth/script.container.ui
```

`SpreadsheetApp.getUi()`（メニュー・サイドバー・ダイアログ）は
`script.container.ui` を要求する。自動判定なら勝手に付くが、明示指定にした以上は
こちらが並べる必要がある。**oauthScopes を明示するなら、UI 権限も列挙する。**

| スコープ | 何のためか |
| --- | --- |
| `calendar.events.readonly` | 通知対象の予定を読む（FR-03/04）。**書き込みはできない** |
| `script.external_request` | Push サービスへ送信する（`UrlFetchApp`） |
| `script.scriptapp` | 毎分トリガーの作成・確認（`ScriptApp`） |
| `spreadsheets.currentonly` | 設定と記録の保存。**このスプレッドシートだけ** |
| `script.container.ui` | メニューとセットアップサイドバーの表示（`SpreadsheetApp.getUi()`） |
| `script.projects` | ワンボタン公開で、自分自身のバージョンを作る |
| `script.deployments` | ワンボタン公開で、自分自身のデプロイを作る・更新する |

**データへ届く範囲は増えていない。** `script.container.ui` は
「このスクリプトが紐づいた画面に UI を出してよい」という権限であって、
カレンダー・ドライブ・他のスプレッドシートのどれにも新しい経路を作らない。

V2 で足した `script.projects` / `script.deployments` も同じ性質で、
**このスクリプト自身を公開する**ためだけに使う。これが無いと、利用者は
「デプロイ」→「新しいデプロイ」→ 種類の選択 → アクセス設定という
Google 側の画面を踏むことになり、1つ間違えると動かない。
利用者にエディタを開かせないという V2 の目的を、権限1つで買っている。
NFR-02（最小権限）は、依然として上の7つで満たしている。

**追加するときは、それが「データへの経路」か「UIの表示」かを分けて考えること。**
前者なら要件の見直しが要る。後者ならここへ1行足して理由を書く。

---

## 2. 外部ライブラリは使わない

V1 は VAPID の ES256 署名のために jsrsasign（約500KB）を利用者に手で貼らせていた。
Apps Script の `Utilities` は HMAC-SHA256 しか持たず、ECDSA が無いためである。

**V2 ではこの工程が丸ごと消えた。** 署名は運営の Workers（`notifier-gate`）が
WebCrypto で行い、テンプレートは発行済みの JWT を受け取って送るだけになった。
副作用として、貼り忘れ・順序違い・途中で切れたといった
「通知が届かない」の原因が1つ減っている。

同梱する外部ライブラリは**無い**。

## 3. ファイルの役割

| ファイル | 役割 |
| --- | --- |
| `Code.gs` | メニュー（セットアップ・引き継ぎリンク） |
| `Setup.gs` | 冪等なセットアップ、匿名化の鍵と接続キーの生成、トリガー作成、`deployWebApp()` |
| `Gate.gs` | ゲート（notifier-gate）のクライアント。判定依頼・JWT取得・テスト通知の許可 |
| `Api.gs` | `doGet` / `doPost`（action ホワイトリスト、接続キー検証） |
| `CalendarSync.gs` | `tick()`、カレンダー取得、匿名化、判定結果のキューへの反映 |
| `Push.gs` | 本文なし Push の送信（署名はゲート発行の JWT） |
| `Store.gs` | シートI/O、設定の正規化、定数 |
| `SidebarSetup.html` | セットアップウィザード（ワンボタン公開・引き継ぎリンク） |

## 4. シート

| シート | 内容 |
| --- | --- |
| `settings` | 出欠フィルタ・時間指定のみ・通知タイミング（key / value の2列） |
| `subscriptions` | Push 購読（subId / endpoint / p256dh / auth と送信結果） |
| `notify_queue` | これから出す通知（eid / eventId / 予定名 / 開始時刻 / 通知予定時刻） |
| `sent_log` | 送信記録。`fetchedBy` に**取りに来た購読の subId**を並べる（宿題 B-04） |

**時刻の列はすべてエポックミリ秒の数値**で持つ。ISO 文字列を書くと
スプレッドシートが日時として解釈し、読み戻した値の比較が静かに壊れるため
（`Store.gs` の HEADERS 上のコメント）。

**接続キー・ライセンスキー・匿名化の鍵はシートに無い。** Script Properties に
だけ置く。シートは「リンクを知っている全員／閲覧者」で共有される想定である。

## 5. API

すべて JSON を返す。成功は `{ ok: true, data }`、失敗は `{ ok: false, error: { code, message } }`。
`health` 以外は接続キー（`key`）が要る。

| action | メソッド | 内容 |
| --- | --- | --- |
| `health` | GET | 版・最終tick時刻・トリガー稼働。**予定の内容は含めない** |
| `publicKey` | GET | VAPID 公開鍵（base64url raw） |
| `getSettings` | GET | 設定の取得 |
| `saveSettings` | POST | 設定の保存（サーバー側で正規化する） |
| `saveSubscription` | POST | Push 購読の upsert |
| `pending` | GET | 未取得の通知を返し、**その購読について**取得済みにする（`endpoint` 必須・直近10分以内） |
| `event` | GET | `id` 指定で予定名と開始時刻（通知から開いた画面の表示用） |
| `upcoming` | GET | 直近の通知予定（設定画面の「次に届く通知」） |
| `saveLicense` | POST | 録音アプリからライセンスキーを受け取る |
| `syncNow` | POST | 手動同期（エディタから `tick` を実行させないための正式な代替） |
| `sendTestNotification` | POST | テスト通知を1件送る（ゲートが1日1回に制限） |
| `regenerateConnectKey` | POST | 接続キーの作り直し（誤って共有したときの失効手段） |

POST の本文は `text/plain` の JSON 文字列。プリフライトを避けるためで、
`notifier-client.js` の実装と対になっている。

## 6. クォータの見積もり

無料アカウントのトリガー実行時間は合計90分/日。

| | 回数/日 | 1回あたり | 合計 |
| --- | --- | --- | --- |
| 同期なしの tick | 1152 | 約0.3秒 | 約6分 |
| 同期ありの tick | 288 | 2〜3秒 | 約12分 |

合計 約19分/日で収まる。`tick()` の先頭で `LockService` を取り、
前の実行が長引いたときに多重実行にならないようにしている。

## 7. 動作確認チェックリスト

利用者の環境で、[docs/calendar-notifier-setup.md](../docs/calendar-notifier-setup.md)
の「動作確認」に従って AC-01〜09 を順に確かめる。
テスト用カレンダーに次の4件を、通知タイミング＋2分後の開始時刻で作る。

- (a) 自分が accepted の時間指定予定 → 通知が出る（AC-01）
- (b) declined の予定 → 出ない（AC-02）
- (c) needsAction の予定 → 出る（AC-03）
- (d) 終日予定 → 出ない（AC-04）

**録音アプリのタブを閉じた状態での受信（NFR-03）も必ず含める。**
ブラウザのプロセスまで終了させた場合は、`TTL: 300` の範囲（通知予定時刻から5分以内）に
復帰したときだけ届く。利用者向けの説明は
[docs/calendar-notifier-setup.md](../docs/calendar-notifier-setup.md) §9。

本番へデプロイしたあとは、`sw.js` と `manifest.webmanifest` が
**正しい Content-Type で配信されているか**を必ず確認する
（[docs/deployment-cloudflare.md](../docs/deployment-cloudflare.md) §5）。
ここが崩れると「登録は成功しているのに通知だけ来ない」状態になる。

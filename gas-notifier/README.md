# gas-notifier — 録音アプリのカレンダー通知（配布用GAS）

ブラウザ録音アプリ（`public/production-app/voice-recorder/`）の
**Googleカレンダー連携通知**を動かすための Apps Script 一式。

この文書は**運営者向け**（テンプレートシートを1度だけ作る手順）。
利用者向けの手順は [docs/calendar-notifier-setup.md](../docs/calendar-notifier-setup.md)。

---

## 0. これは何か（読まずに触らないこと）

**運営のサーバーは無い。** 通知の仕組みは、利用者ひとりひとりが自分の
Google アカウントの中に持つ。運営が預かるものは、鍵もデータも1つも無い。

```
[利用者のGoogleアカウント内]
  テンプレートシートのコピー（このコードが同梱されている）
    ├─ 毎分トリガー tick()
    │    ├─ 5分ごと: Calendar API で同期 → 判定 → notify_queue を更新
    │    └─ 毎分: 期限の来た通知があれば「本文なしPush」を1通だけ送る
    └─ Webアプリ（doGet/doPost）= 録音アプリ・Service Worker との窓口

[利用者のブラウザ]
  録音アプリ（/production-app/voice-recorder/）
    ├─ 設定画面（接続・フィルタ・通知タイミング）
    ├─ Service Worker: Push受信 → GASから内容を取得 → 表示
    └─ 通知クリック → ?eventId= 付きで録音画面へ
```

**リポジトリ上のこのディレクトリは配信されない。** `gas-auth/` と同じ扱いで、
中身は利用者の Apps Script エディタへ貼り付けて使う。

---

## 1. テンプレートシートの作り方（運営者が1度だけ）

1. 新規スプレッドシートを作る。名前は「TSAM AI 録音通知」など、
   利用者がコピー後に見て分かるものにする。
2. 「拡張機能」→「Apps Script」を開く。
3. このディレクトリの `.gs` / `.html` を**同じ名前で**貼り付ける。
   - `Code.gs` / `Setup.gs` / `Api.gs` / `CalendarSync.gs` / `Push.gs` / `Store.gs`
   - `SidebarSetup.html`
   - `lib_jsrsasign.gs`（§2 のとおり本体を貼る）
4. `appsscript.json` は、プロジェクトの設定で
   「`appsscript.json` マニフェスト ファイルをエディタで表示する」を ON にしてから、
   このディレクトリの内容で**置き換える**。
   - **スコープは5つだけ**（要件 NFR-02）。理由は §1-1。増やさないこと。
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
   `public/production-app/voice-recorder/notifier-config.js` の
   `TEMPLATE_COPY_URL` へ設定する。

### 1-1. スコープが5つある理由（`script.container.ui` を含む）

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

**データへ届く範囲は増えていない。** `script.container.ui` は
「このスクリプトが紐づいた画面に UI を出してよい」という権限であって、
カレンダー・ドライブ・他のスプレッドシートのどれにも新しい経路を作らない。
NFR-02（最小権限）は、依然として上の5つで満たしている。

**追加するときは、それが「データへの経路」か「UIの表示」かを分けて考えること。**
前者なら要件の見直しが要る。後者ならここへ1行足して理由を書く。

---

## 2. jsrsasign の入手と貼り付け

Web Push の VAPID は JWT を **ES256（ECDSA P-256）** で署名する。
Apps Script の `Utilities` は HMAC-SHA256 しか持たず、ECDSA が無い。
そのため jsrsasign（MIT）を同梱する。
承認の記録は [docs/external-dependency-approvals.md](../docs/external-dependency-approvals.md) §1-4。

1. https://github.com/kjur/jsrsasign の releases から `jsrsasign-all-min.js` を入手する。
2. `lib_jsrsasign.gs` を開く。**冒頭のスタブを消さない。**
3. 「ここから下へ貼る」のコメントより**下**へ、入手したファイルの中身をまるごと貼る。
4. メニュー「録音通知」→「jsrsasign を検証」を実行し、成功メッセージを確かめる。

> **スタブが本体より上にある必要がある。**
> jsrsasign は読み込み時に `navigator` を参照する。順序を入れ替えると
> `navigator is not defined` で失敗する。
> スタブの `window.crypto.getRandomValues` は `Utilities.getUuid()` 由来。
> これが無いと jsrsasign は `Math.random()` へ落ち、ECDSA の nonce が弱くなる。

MIT ライセンス表記は、配布物の先頭に含まれている。貼り付けるときに消さないこと。

---

## 3. ファイルの役割

| ファイル | 役割 |
| --- | --- |
| `Code.gs` | メニュー（セットアップ・接続コード・jsrsasign検証） |
| `Setup.gs` | 冪等なセットアップ、VAPID鍵・接続キーの生成、トリガー作成、`verifyJsrsasign()` |
| `Api.gs` | `doGet` / `doPost`（action ホワイトリスト、接続キー検証） |
| `CalendarSync.gs` | `tick()`、カレンダー同期、通知対象の判定（純関数 `decideEvent_`） |
| `Push.gs` | VAPID 署名と本文なし Push の送信 |
| `Store.gs` | シートI/O、設定の正規化、定数 |
| `SidebarSetup.html` | セットアップウィザード |
| `lib_jsrsasign.gs` | jsrsasign の同梱先（スタブのみ同梱） |

## 4. シート

| シート | 内容 |
| --- | --- |
| `settings` | 出欠フィルタ・時間指定のみ・通知タイミング（key / value の2列） |
| `subscriptions` | Push 購読（endpoint / p256dh / auth と送信結果） |
| `notify_queue` | 通知予定（eventId / 予定名 / 開始時刻 / 通知予定時刻） |
| `sent_log` | 送信記録（二重送信の防止と `pending` の受け渡し） |

**時刻の列はすべてエポックミリ秒の数値**で持つ。ISO 文字列を書くと
スプレッドシートが日時として解釈し、読み戻した値の比較が静かに壊れるため
（`Store.gs` の HEADERS 上のコメント）。

**秘密鍵と接続キーはシートに無い。** Script Properties にだけ置く。
シートは「リンクを知っている全員／閲覧者」で共有される想定である。

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
| `pending` | GET | 未取得の通知を返し、取得済みにする（直近10分以内） |
| `event` | GET | `id` 指定で予定名と開始時刻（通知から開いた画面の表示用） |

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

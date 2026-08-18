# カレンダーURL通知アプリ｜要件定義書

対象: `public/production-app/calendar-url-notifier/`（画面・Service Worker）／
`gas-notifier/OpenUrl.gs`（URL解決、配布テンプレートへの追加分）／
`workers/notifier-gate/src/constants.mjs` の `FEATURE_RULES.openurl`。

実装の正は [docs/specs/calendar-url-notifier-requirements-v1.md](../../specs/calendar-url-notifier-requirements-v1.md)（以下「既存仕様書」）。
本書は既存仕様書を置き換えず、他プロダクトへ移植する読者向けに再構成したものである。
既存仕様書との食い違いに気づいた箇所は、本書に推測で埋めず「実装時点で確認できた事実」だけを書き、
判断が要る点は §9 の未確定事項へ回した。

---

## 1. 目的・背景

Google カレンダーの予定が始まる少し前にブラウザ通知を出し、**通知を操作した端末でだけ、
その予定に紐づく URL を開く**ためのアプリ。録音アプリ（`public/production-app/voice-recorder/`）が
使っているカレンダー通知の基盤（[notifier-v2](../notifier-v2/01_requirements.md)、以下「通知基盤」）を
共用しつつ、Portal 上は別アプリとして並ぶ（既存仕様書 §1）。

| | 録音アプリの通知 | 本アプリ |
| --- | --- | --- |
| 目的 | 予定の開始前に録音を促す | 予定に紐づくページを開く |
| 遷移先 | 録音画面（固定） | 予定ごとに変わる URL |
| 通知基盤上の `feature` | `calendar` | `openurl` |

### なぜ独自の中継サーバー（ntfy 等）を使わないか

先行検討では Google Apps Script から ntfy.sh へ publish する構成を作ったが、
予定名と URL が公開の中継サーバーを経由してしまう。通知基盤は「運営へ渡るのは
予定の骨格だけ」という前提（[notifier-v2 01_requirements.md](../notifier-v2/01_requirements.md) §1・NFR-01）で
作られており、Portal に並ぶ本番アプリがこの前提を満たさない経路で予定名を外へ出すと、
利用者から見て「同じ画面から入る2つのアプリで扱いが違う」ことになる。この判断が
本アプリの設計全体（§2-2 相当のURL非送信）を貫いている。

---

## 2. 用語定義

通知基盤共通の用語（骨格・`eid`・tickle・接続キー・引き継ぎリンク・ライセンスキー・猶予）は
[notifier-v2 01_requirements.md](../notifier-v2/01_requirements.md) §2 を参照。本書では本アプリ固有の用語のみを挙げる。

| 用語 | 意味 |
| --- | --- |
| `feature: openurl` | 通知基盤（`FEATURE_RULES`）上で本アプリを識別する値。骨格の1フィールド |
| `purpose: openurl` | `sent_log` / `pending` の応答に載る値。Service Worker が「自分向けの通知か」を判定する手がかり |
| `openUrl` | 通知タップ時に開く URL。`notify_queue` / `sent_log` にだけ置かれ、判定要求（`/v1/evaluate`）には含まれない |
| `OPEN_URL:` | 予定の説明欄に書く行。行き先 URL を明示的に指定する |
| `OPEN_BEFORE:` | 予定の説明欄に書く行。その予定だけ通知タイミング（分前）を上書きする |
| 許可ホスト | 予定に書かれた URL のうち採用してよいホストの一覧。実装は `gas-notifier/OpenUrl.gs` の定数（§9） |

---

## 3. スコープ

### 対象

- `public/production-app/calendar-url-notifier/`（`index.html` / `app.js` / `sw.js` / `style.css`）が行う、
  接続（引き継ぎリンクの受け取り）・設定の保存と表示・Push 購読・通知の受信と URL への遷移
- `gas-notifier/OpenUrl.gs` が行う、予定から開く URL を解決する処理（§2 相当）と `OPEN_BEFORE` の解釈
- `gas-notifier/CalendarSync.gs` / `Store.gs` / `Push.gs` / `Api.gs` のうち、`feature: openurl` /
  `openUrl` 列 / `openUrlEnabled` 設定に関わる差分（配布テンプレートは録音アプリと共用。§7）
- `workers/notifier-gate/src/constants.mjs` の `FEATURE_RULES.openurl` 登録

### 対象外（別の文書のスコープとする）

- **通知基盤そのもの（判定・ライセンス検証・VAPID発行・レート制限）。** [notifier-v2](../notifier-v2/01_requirements.md) のスコープであり、本アプリはそれを利用する側でしかない。
- **録音アプリ本体・その通知の挙動。** 本アプリの追加によって録音アプリ側の通知仕様は変更しない（既存仕様書 §8）。
- **配布テンプレートの新規セットアップ・ライセンス発行・Web アプリ公開そのもの。** [notifier-v2 04_integration-guide.md](../notifier-v2/04_integration-guide.md) 相当であり、本書はテンプレートに対する「本アプリ向けの追加分」だけを扱う。
- Portal（`public/portal/`）自体の実装。本アプリの登録方法（§7）のみ扱う。

---

## 4. 利用者とロール

| ロール | 何をするか | 触れるもの |
| --- | --- | --- |
| 利用者（契約者） | 通知シート（テンプレートのコピー）の設定で URL通知を ON にする／`calendar-url-notifier` 画面でこの端末を登録する／設定（通知タイミング・出欠フィルタ）を変更する | `public/production-app/calendar-url-notifier/` の画面 |
| 通知シート（システムアクター） | 予定の説明欄・場所欄から開く URL を解決する／`openurl` の骨格を作りゲートへ判定を依頼する／`openUrl` を `notify_queue` / `sent_log` に保持する | `gas-notifier/OpenUrl.gs` `CalendarSync.gs` |
| Service Worker（システムアクター） | Push 受信後 `pending` を取得し、`purpose: openurl` の通知だけを表示する／通知クリックで `openUrl` を開く | `public/production-app/calendar-url-notifier/sw.js` |
| notifier-gate（システムアクター） | `openurl` を含む `FEATURE_RULES` に従って判定する。URL・予定名は一切受け取らない | `workers/notifier-gate/src/constants.mjs` `evaluate.mjs`（[notifier-v2](../notifier-v2/01_requirements.md) のスコープ） |

---

## 5. 機能要件

| FR-nn | 要件 | 実装箇所 |
| --- | --- | --- |
| FR-01 | 時刻付きの予定を通知対象とする。終日予定は対象外 | `workers/notifier-gate/src/evaluate.mjs`（`FEATURE_RULES.openurl.allDayFilter`） |
| FR-02 | 通知時刻は「予定開始 − 通知分数」。分数は予定の `OPEN_BEFORE:` → 無ければ設定画面の既定値の順で決まる | `gas-notifier/OpenUrl.gs` `resolveOpenBefore_`、`CalendarSync.gs` `buildEventSkeletons_` |
| FR-03 | 通知タイトルに予定名、本文に開始までの時間を出す | `public/production-app/calendar-url-notifier/sw.js` `buildNotification` |
| FR-04 | 通知本体のタップで解決済みの URL を開く | `sw.js` `notificationclick` |
| FR-05 | アクションボタンにも予定名を載せる（「〈予定名〉を開く」） | `sw.js` `actionLabel` |
| FR-06 | 登録済みの全端末へ通知が届く。URL を開くのは操作した端末だけ | `gas-notifier/Push.gs` `sendTickle_`（全購読へtickle）＋ `sw.js` `notificationclick`（ローカルの `data.url` のみ使用） |
| FR-07 | 同じ予定・同じ通知分数で二重に送らない。開始時刻が5分以上動いたら送り直す | `workers/notifier-gate/src/evaluate.mjs` `isAlreadyNotified`（通知基盤側の既存ロジックをそのまま利用。閾値は変更しない） |
| FR-08 | 予定に書かれた URL は HTTPS のみ採用する。許可ホストを設定できる | `gas-notifier/OpenUrl.gs` `isAllowedOpenUrl_`。「設定できる」の実装状況は §9 |
| FR-09 | 設定画面で、通知分数・出欠フィルタ・許可ホストを変更できる | `app.js` `currentSettingsFromForm` / `renderSettings`、`gas-notifier/Store.gs` `writeSettings_`。許可ホストの部分は §9 |
| FR-10 | 設定画面から接続テストとテスト通知を実行できる | `app.js` の `refreshState`（接続確認を兼ねる）と `sendTestNotification` 呼び出し |
| FR-11 | 直近の通知予定を設定画面で確認できる | `app.js` `renderUpcoming`、`gas-notifier/Api.gs` `listUpcoming_` |

### 5-1 URL の決め方（優先順位）

`gas-notifier/OpenUrl.gs` `resolveOpenUrl_` が上から順に探し、最初に見つかったものを採る。

| # | 出どころ | 検証 |
| --- | --- | --- |
| 1 | 説明欄の `OPEN_URL:` 行 | HTTPS ＋ 許可ホスト |
| 2 | 場所欄が URL の場合、その値 | 同上 |
| 3 | 説明欄の中で最初に見つかった URL | 同上 |
| 4 | Google Meet のリンク（`hangoutLink`） | `google.com` 配下かどうかのみ検証（Google生成のため） |
| 5 | その予定の Google カレンダー画面（`htmlLink`） | 同上 |

1〜3 が検証に落ちても通知そのものは取り消さず、4→5 のフォールバックへ回す。
「通知が出ること」と「知らないサイトを開かされないこと」を分けて扱うためで、
5 まで含めると URL を書いていない予定でも必ずタップ先ができる。

### 5-2 通知が出せない／行き先が無いときの扱い

`purpose: openurl` の通知が1件も無いとき、`sw.js` は行き先を持たない通知は出さず、
このアプリ自身の画面を開く通知（フォールバック）を表示する。`userVisibleOnly: true` で
購読している以上、Push を受けて何も表示しないとブラウザが購読を打ち切ることがあるため、
「通知を出さない」という選択肢は採らない（既存仕様書 §5-1）。

---

## 6. 非機能要件

### セキュリティ

| NFR-nn | 要件 |
| --- | --- |
| NFR-01 | 予定に書かれた URL は運営（notifier-gate）へ一切渡らない。骨格に含まれるフィールドは通知基盤の `ALLOWED_EVENT_FIELDS`（`eid` / `feature` / `startAt` / `status` / `allDay` / `cancelled` / `timingMin`）のみで、`openUrl` を足しても要求ごと拒否される（[notifier-v2 01_requirements.md](../notifier-v2/01_requirements.md) NFR-01 の枠組みをそのまま利用） |
| NFR-02 | 採用する URL は HTTPS のみ（`http://` を落とす）。`user:pass@` を含む URL は見かけのホストを偽装できるため受け付けない（`gas-notifier/OpenUrl.gs` `isAllowedOpenUrl_`） |
| NFR-03 | 予定名・URL は `textContent` で DOM へ入れ、`innerHTML` を使わない（`app.js` `renderUpcoming`）。通知シートの中身は接続キーで保護し、これは他機能と同じ通知基盤の枠組みを使う |
| NFR-04 | 画面の CSP（`index.html`）は `notifier-gate` を `connect-src` に含めない。ブラウザから直接ゲートを叩かず、ゲートと話すのは利用者の通知シート（Apps Script）だけである |

### 性能

| NFR-nn | 要件 |
| --- | --- |
| NFR-05 | 本アプリのために通知基盤の再通知閾値（5分）・キャッシュ期間・レート制限を変更しない（[notifier-v2 01_requirements.md](../notifier-v2/01_requirements.md) §6 をそのまま継承） |

### 可用性

| NFR-nn | 要件 |
| --- | --- |
| NFR-06 | URL 解決に失敗しても通知そのものは失われない（§5-1 のフォールバック） |
| NFR-07 | `pending` が空、または取得に失敗したときも、Service Worker は「行き先の無い」通知ではなく、アプリを開く通知を出す（§5-2） |

### 運用

| NFR-nn | 要件 |
| --- | --- |
| NFR-08 | 配布テンプレートを録音アプリと共用する（§7-1）。共用に起因する制約（`notify_queue` の行キー形式）を崩さない |
| NFR-09 | `FEATURE_RULES` に `openurl` が登録されていない状態では、この機能の通知は1件も出ない（`unknown-feature` として判定側で落ちる。[notifier-v2 03_detailed-design.md](../notifier-v2/03_detailed-design.md) の判定ロジックに準拠） |

### アクセシビリティ

サイトのアクセシビリティ基準（`SITE_SPEC.md`）を画面（`index.html`）が満たすかどうかは、
本書執筆時点のコード調査だけでは判定できない。**未確定**として扱う（§9）。

---

## 7. 制約条件

### 7-1 配布テンプレートを共用したことによる制約

配布テンプレート（`gas-notifier/`）は録音アプリと共用する（利用者のスプレッドシートと
接続キーを2組に増やさないため）。共用の結果、`notify_queue` の行キー（`Store.gs` `queueKey_`）は
**`feature: calendar` のときだけ従来の形（`eid|timing`）を保つ**設計になっている。全機能に
`feature` サフィックスを足すと、既に配布済みのシートにある行の形が変わり、更新直後の同期で
同じ予定が「新しい行」として積み直されるため。

### 7-2 通知基盤の判定を運営側へ寄せる設計をそのまま継承する

判定ロジック（出欠フィルタ・終日除外・再通知閾値）は利用者側テンプレートへ戻さず、
`workers/notifier-gate` に置いたまま利用する。本アプリのために判定を分岐させると、
[notifier-v2 01_requirements.md](../notifier-v2/01_requirements.md) が前提とする「コピー・改変で迂回できない位置に契約の検証を置く」設計が崩れる。

### 7-3 未登録の `feature` は通らない

`FEATURE_RULES` に `openurl` が無いと、配布テンプレートを更新しても `openurl` の骨格は
すべて `unknown-feature` として判定側で拒否される。テンプレートの更新と `constants.mjs` の
更新は対で行う必要がある。

---

## 8. 外部依存

本アプリが直接持つ外部依存は通知基盤（[notifier-v2](../notifier-v2/01_requirements.md) §8）と同じであり、
本アプリ固有の追加は無い。

| 依存先 | 用途 | 備考 |
| --- | --- | --- |
| Google カレンダー（Advanced Calendar Service） | 予定の取得と、URL 解決に使う説明欄・場所欄・`hangoutLink` / `htmlLink` | 通知基盤（`gas-notifier/CalendarSync.gs`）が既に取得している予定データを再利用するだけで、本アプリ用に追加の取得は行わない |
| `notifier-gate` | `openurl` を含む判定（`/v1/evaluate`） | ブラウザからは呼ばない（NFR-04）。呼ぶのは利用者の通知シート |
| Web Push プロトコル（VAPID） | 本文なしの Push（tickle）配信 | 通知基盤と共通。本アプリ用の追加設定は無い |
| Portal（`public/portal/`） | アプリ一覧への表示 | `app-registry.js` には登録しない（§9 に運用上の理由） |

---

## 9. 前提条件・未確定事項

- **FR-09「許可ホストを変更できる」の実装状況。** 本書執筆時点のコード調査では、許可ホストは
  `gas-notifier/OpenUrl.gs` の定数 `OPEN_URL_ALLOWED_HOSTS`（初期値は空＝制限なし）としてのみ存在し、
  `Store.gs` の設定項目（`RESPONSE_STATUSES` + `timedOnly` / `timing` / `openUrlEnabled`）にも
  `Api.gs` の `getSettings` / `saveSettings` にも、`public/production-app/calendar-url-notifier/index.html` /
  `app.js` にも、許可ホストに関わるキー・UI要素は見つからなかった。設定画面から変更する経路が
  実装されているかどうかは本書の調査だけでは断定できず、**未確定**として扱う。
- **本アプリ固有の受け入れ検証（AC）の完了範囲。** 既存仕様書 §9 に検証項目の一覧はあるが、
  完了・未完了の記録はリポジトリからは確認できない。
- **アクセシビリティ要件は定義されていない。** [notifier-v2 01_requirements.md](../notifier-v2/01_requirements.md) §6 と同様、
  セットアップ UI・設定画面いずれも明文化された基準を持たない。
- **Portal への登録（アプリ一覧への追加）は運営者がスプレッドシート（暫定DB）を直接編集する運用**
  であり、リポジトリの変更では反映されない（既存仕様書 §7）。反映済みかどうかは本書のスコープ外。

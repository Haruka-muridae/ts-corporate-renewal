# notifier-v2｜要件定義書

対象: `gas-notifier/`（利用者に配布する Apps Script テンプレート）＋
`workers/notifier-gate/`（運営が持つライセンスゲート兼判定サーバー、Cloudflare Workers）。

読者は「このリポジトリを知らないが、カレンダー予定の通知の仕組みを
自分のプロダクトへ移植したい開発者」を想定する。

---

## 1. 目的・背景

ブラウザで動く録音アプリ（本リポジトリ内の別プロダクト）に、Google カレンダーの
予定が始まる少し前にブラウザ通知を出す機能を付けるためのサブシステムである。
「予定が近いことを知らせる」だけが役割で、**通知から録音が自動で始まることはない**。

最初の実装（以下 V1）は、利用者のスプレッドシートにコピーされる Apps Script
だけで鍵生成・判定・署名・送信のすべてを完結させていた。この構成には次の
欠陥があった。

- テンプレートをコピーした人は、解約後も通知を受け取り続けられた
  （判定ロジックが利用者の手元にあり、サブスクリプションとして成立しない）
- VAPID の ES256 署名を Apps Script 上で作るために、利用者へ約500KBの
  外部ライブラリ（jsrsasign）を手で貼らせる必要があり、貼り忘れ・順序違い・
  途中で切れた、のいずれも「通知が届かない」という同じ症状になって
  原因の切り分けができなかった

本サブシステム（以下 V2）は、この2点を解決するために設計し直したもの
である。**「通知するかどうかの判定」と「Push を送るための署名発行」を
運営側（`notifier-gate`）へ移し、テンプレートを改造しても迂回できない位置に
契約の検証を置く。**署名を運営の Cloudflare Workers（WebCrypto が使える）へ
移すことで、外部ライブラリの貼り付け工程も同時に無くしている。

---

## 2. 用語定義

| 用語 | 意味 |
| --- | --- |
| テンプレート | `gas-notifier/` の内容を貼った、配布用のスプレッドシート雛形（運営が1度だけ作る） |
| 通知用シート | 利用者が上のテンプレートを自分の Google ドライブへコピーしたもの。1利用者に1枚 |
| ゲート | `workers/notifier-gate/`。判定・ライセンス照会・VAPID 署名を行う Cloudflare Workers |
| 骨格（イベントの骨格） | カレンダー予定から作る匿名化済みの最小データ（`eid` / `feature` / `startAt` / `status` / `allDay` / `cancelled`） |
| `eid` | 予定 ID を利用者ごとの秘密鍵で HMAC-SHA256 にかけた値。運営は元の予定 ID へ戻せない |
| tickle | 本文を含まない Web Push。Service Worker に「取りに来い」と合図するためだけに送る |
| ライセンスキー | 通知の利用権を表すトークン。認証系（`gas-auth`）が発行し、ゲートが照会する |
| 猶予（grace） | 認証系への照会が届かないあいだ、直前まで有効だったライセンスの通知を止めずに継続させる状態 |
| 接続キー | 録音アプリと通知用シートの Web アプリ入口を結ぶ、利用者ごとの秘密の文字列 |
| 引き継ぎリンク | 通知用シートの公開 URL と接続キーを、URL フラグメント（`#setup=`）へ載せて録音アプリへ渡すリンク |

---

## 3. スコープ

### 対象

- `gas-notifier/` テンプレートが行うカレンダーの読み取り・匿名化・判定依頼・
  キュー管理・Push 送信・セットアップ自動化
- `workers/notifier-gate/` が行う判定（`/v1/evaluate`）・VAPID 発行
  （`/v1/vapid`）・テスト通知許可（`/v1/test-notify`）・ライセンス検証と
  そのキャッシュ・レート制限

### 対象外（別のサブシステムとして扱う）

- **通知の受信側（ブラウザの録音アプリ本体）。** `notifier-client.js` /
  `notifier-panel.js` / `sw.js` などは録音アプリ側の実装であり、本書は
  「ゲートが返す JSON の形」と「テンプレートが提供する API」までを境界とする。
  組み込み先での実装は [04_integration-guide.md](./04_integration-guide.md) §3 を参照。
- **ライセンスの発行・課金判定（`gas-auth/Notifier.gs`）。** 本サブシステムは
  「ライセンスキーを検証専用の窓口（`verifyNotifierLicense`）へ照会する」
  ところまでが範囲で、契約状態の正本管理・Stripe 連携は認証系の責務。
- 通知対象を「カレンダー予定」以外へ拡張すること（`feature` の仕組みは
  用意されているが、`FEATURE_RULES` に `calendar` 以外は未登録＝現状は未実装）。
- iOS / iPadOS / Safari 向けの対応（Web Push の実装差により対象外）。

---

## 4. 利用者とロール

| ロール | 何をするか | 触れるもの |
| --- | --- | --- |
| 運営者 | テンプレートシートを1度だけ作る／`notifier-gate` を Cloudflare へデプロイする／VAPID 鍵と共有シークレットを管理する | `gas-notifier/README.md`、`workers/notifier-gate/README.md` |
| 利用者（契約者） | テンプレートを自分のドライブへコピーし、ウィザードでセットアップと公開を行う／通知条件（出欠フィルタ・タイミング）を設定する | 通知用シートのサイドバー、録音アプリの設定画面 |
| 録音アプリ（システムアクター） | ライセンスキーを認証系から受け取り、通知用シートへ引き渡す／Push 購読を保持し、Service Worker で通知を表示する | `gas-notifier/Api.gs` の `saveLicense` / `saveSubscription` / `pending` など |
| notifier-gate（システムアクター） | 判定・署名・ライセンス照会を行う。予定名・参加者などの中身は一切受け取らない | `/v1/evaluate` / `/v1/vapid` / `/v1/test-notify` |

---

## 5. 機能要件

| FR-nn | 要件 | 実装箇所 |
| --- | --- | --- |
| FR-01 | 利用者のカレンダーから、24時間先までの予定を5分間隔で取得する | `gas-notifier/CalendarSync.gs` `syncCalendar_` |
| FR-02 | 予定名・説明・参加者・カレンダー ID を含まない「骨格」へ変換してからゲートへ渡す。予定 ID は利用者ごとの秘密鍵で HMAC-SHA256 化した `eid` に置き換える | `CalendarSync.gs` `buildEventSkeleton_` / `eventEid_` |
| FR-03 | 自分の出欠（accepted / tentative / needsAction / declined）で通知の対象を絞る。既定値は declined 以外 ON | `Store.gs` `DEFAULT_SETTINGS`、`workers/notifier-gate/src/evaluate.mjs` |
| FR-04 | 「時間指定の予定のみ」設定が ON のとき、終日予定を通知対象から外す | `evaluate.mjs` `decideEvent` |
| FR-05 | 通知タイミングを開始時刻 / 5分前 / 10分前 / 15分前から選べる | `Store.gs` `ALLOWED_TIMINGS`、`constants.mjs` `ALLOWED_TIMINGS` |
| FR-06 | 通知するかどうかの最終判定はゲートが行う。テンプレートは判定ロジックを持たない | `workers/notifier-gate/src/evaluate.mjs` |
| FR-07 | ゲートの判定結果（`notify` / `remove`）で `notify_queue` を同期する | `CalendarSync.gs` `applyGateDecision_` |
| FR-08 | 予定が始まる予定時刻になったら、登録済みの Push 購読へ本文なしの Push（tickle）を1購読あたり1通だけ送る | `gas-notifier/Push.gs` `sendDueNotifications_` / `sendTickle_` |
| FR-09 | Push の署名（VAPID JWT）はゲートが発行し、テンプレートは期限まで使い回す | `Gate.gs` `gateVapid_`、`workers/notifier-gate/src/vapid.mjs` |
| FR-10 | Service Worker は Push 受信後、通知の中身（予定名・開始時刻）を GET `pending` で取得し、購読（端末）ごとに取得済みを管理する | `Api.gs` `takePending_`、`Store.gs` `parseFetchedBy_` |
| FR-11 | 開始時刻が5分以上動いた予定は再通知し、5分未満のずれは送信済みとして扱い再通知しない | `evaluate.mjs` `isAlreadyNotified` |
| FR-12 | 削除された予定・設定で対象外になった予定・送信済みの予定は、いずれも通知キューから外す | `evaluate.mjs` `evaluateEvents`（`remove`） |
| FR-13 | 録音アプリ（ログイン済み）がライセンスキーを認証系から受け取り、既に確立した接続（接続キー）越しに通知用シートへ引き渡す。利用者がキーを貼る欄は無い | `Api.gs` `handleSaveLicense_`、`gas-auth/Notifier.gs` `issueNotifierLicense_` |
| FR-14 | ライセンスが有効でないあいだ、判定は空の結果を返し、VAPID 署名は発行しない（Push を送れない） | `workers/notifier-gate/src/index.mjs` `handleEvaluate` / `handleVapid` |
| FR-15 | 利用者はスプレッドシートのエディタを開かずに、サイドバーのボタン操作だけでセットアップと Web アプリ公開を完了できる。公開は Apps Script API 経由で冪等に行い、既存デプロイの URL を変えない | `gas-notifier/Setup.gs` `deployWebApp` |
| FR-16 | Web アプリの `health` 以外の全アクションは接続キーで保護する。接続キーは作り直し（失効）できる | `Api.gs` `connectKeyMatches_` / `regenerateConnectKey` |
| FR-17 | 利用者はテスト通知を送って動作を確認できる（ゲートが1日1回に制限） | `Push.gs` `sendTestNotification_`、`workers/notifier-gate/src/index.mjs` `handleTestNotify` |
| FR-18 | 利用者は設定画面から、直近に届く通知の一覧（最大5件）を確認できる | `Api.gs` `listUpcoming_` |
| FR-19 | ゲートは呼び出しが上限を超えたとき、次に呼んでよい秒数（`retryAfterSec`）を返す。テンプレートはその秒数のあいだ呼び出しを止める | `workers/notifier-gate/src/ratelimit.mjs`、`gas-notifier/Gate.gs` `setVapidRetry_` |

---

## 6. 非機能要件

### セキュリティ

| NFR-nn | 要件 |
| --- | --- |
| NFR-01 | 予定名・説明・参加者・メールアドレス・カレンダー ID・予定 ID そのものを運営（ゲート）へ送らない。「送らないよう気をつける」ではなく、許可した項目以外を含む要求をゲート側が拒否する形で担保する |
| NFR-02 | テンプレートの OAuth スコープは、カレンダー読み取り専用を含む7つに限定し、書き込み系スコープを持たない |
| NFR-03 | 接続キー・ライセンスキー・匿名化用の秘密鍵（`EID_HMAC_KEY`）・VAPID の秘密鍵は、利用者の Script Properties または運営の Workers シークレットにのみ置き、シートやログへ書かない |
| NFR-04 | 接続キーの照合は、比較に要する時間が入力の中身に依存しない方式（XOR 畳み込み）で行う。ライセンスキーの KV キー・レート制限キーは SHA-256 ハッシュのみを使い、生のキーを保存しない |
| NFR-05 | ゲートが受け取った例外・失敗は、応答本文には内部情報を含めず、運用者だけが読める実行ログにのみ詳細（段階・例外種別・伏せ字済みメッセージ）を残す |

### 性能

| NFR-nn | 要件 |
| --- | --- |
| NFR-06 | テンプレートの毎分トリガー実行時間の合計を、Google の無料アカウントのクォータ（90分/日）内に収める |
| NFR-07 | Push の TTL は5分とし、届けられなかった通知はそれ以上遅延させず破棄する（「10:55 の通知が12:00に届く」事故を避けるため） |

### 可用性

| NFR-nn | 要件 |
| --- | --- |
| NFR-08 | 認証系（`gas-auth`）への照会が一時的に失敗しても、直前まで有効だったライセンスは最大72時間（キャッシュ6時間＋猶予72時間）継続させる。一度も検証できていないキーには猶予を与えない（fail closed） |
| NFR-09 | レート制限に当たったとき、上限そのものではなく「失敗したあとの振る舞い」（呼び出し側のバックオフ・成功しなくても終わる action 設計）を含めて事故を防ぐ |

### 運用

| NFR-nn | 要件 |
| --- | --- |
| NFR-10 | Web アプリの公開 URL は、再デプロイしても変わらない（既存デプロイを `update` する。`create` し直さない） |
| NFR-11 | VAPID 鍵はサービス全体で1ペアとし、ローテーション手順（登録前検証を含む）を運用文書に固定する |
| NFR-12 | 通知判定に関わる定数（フィルタ規則・再通知閾値・キャッシュ期間・レート制限値）を1ファイルへ集約し、変更の影響範囲を追えるようにする |

### アクセシビリティ

セットアップ UI はスプレッドシートのサイドバー（`SidebarSetup.html`）に限られ、
コーポレートサイト側のようなアクセシビリティ基準（`SITE_SPEC.md` 相当）は
定義されていない。**この観点は未確定**として扱う（§9）。

---

## 7. 制約条件

- **Apps Script には ECDH・HKDF・暗号用乱数が無い。** Web Push の本文暗号化
  （AES128GCM）や ES256 署名を利用者側で完結できないため、署名はゲート側
  （WebCrypto）へ、本文はそもそも送らない設計にせざるを得ない。
- **`appsscript.json` に `oauthScopes` を明示すると、Apps Script の自動
  スコープ判定が無効になる。** `SpreadsheetApp.getUi()` を使う（メニュー・
  サイドバー）には `script.container.ui` を自分で列挙する必要がある。
- シートの列（`HEADERS`）は末尾へ追加する運用とし、途中への挿入をしない
  （既存データの列ずれを防ぐため）。
- 時刻はすべてシートへエポックミリ秒の数値で持つ。ISO 文字列で書くと
  スプレッドシートが日時として解釈し、読み戻しの比較が壊れる。
- `workers/notifier-gate/` はリポジトリ直下の Worker（`tsam-ai.com` を
  配信する OpenNext）とは**別サービス**であり、デプロイコマンドも別
  （`npm run deploy:notifier-gate`）。同居している系を片方の都合で変えない
  という本リポジトリの運用方針をそのまま適用している。
- KV（Cloudflare）は結果整合であり、厳密なカウンタ・厳密な猶予起点には
  向かない。この制約に合わせて、猶予の起点を「最後に成功を確認できた
  一度きりの事実」に寄せて非決定性を避けている（詳細は
  [02_basic-design.md](./02_basic-design.md) §9）。

---

## 8. 外部依存

| 依存先 | 用途 | 備考 |
| --- | --- | --- |
| Google Calendar API（Advanced Service, v3） | 予定の取得（`responseStatus` を含む） | `CalendarApp`（組み込みサービス）では自分の出欠が取れないため使えない |
| Google Apps Script API（`projects.versions` / `deployments`） | ワンボタン公開（自分自身のデプロイを作成・更新） | `ScriptApp.getOAuthToken()` はサーバー側関数の中だけで使う |
| Web Push プロトコル（VAPID, RFC 8292） | 通知の送信 | 送信先は主要 Push サービス（FCM / Mozilla / Apple / Windows）に限定 |
| Cloudflare Workers + KV | ゲートの実行基盤。ライセンス判定キャッシュとレート制限カウンタ | `workers/notifier-gate/wrangler.jsonc` |
| `gas-auth`（認証系 Apps Script） | ライセンスキーの発行（`issueNotifierLicense`）・照会（`verifyNotifierLicense`） | ゲートとは共有シークレットで認証する server-to-server 通信。本書のスコープ外（§3） |
| Stripe（間接） | 契約状態の正本。`gas-auth` 経由でのみ触れる | 本サブシステムから直接は呼ばない |
| 録音アプリ（ブラウザ） | ライセンスキーの受け渡し元、Push 購読の保持元、Service Worker の実行元 | 本書のスコープ外（§3）。連携仕様は [04_integration-guide.md](./04_integration-guide.md) |

---

## 9. 前提条件・未確定事項

- **録音アプリ側の現在の設置場所は未確定として扱う。** 執筆時点のリポジトリでは、
  通知 UI（`notifier-*.js` / `sw.js`）は本番配信（`public/production-app/voice-recorder/`）
  ではなく試験環境（`public/apps/voice-recorder/`）に置かれている
  （関連文書: `docs/notifier-v2-resume.md`）。本サブシステム自体
  （`gas-notifier/` / `workers/notifier-gate/`）の設計・実装はどちらの
  設置場所にも依存しないため、本書はこの移設状態そのものをスコープに含めない。
- **録音アプリ側 CSP（`connect-src`）へのゲート接続許可は未適用。** ブラウザから
  `notifier-gate` の `/v1/health` を直接叩くための CSP 変更案は
  `workers/notifier-gate/README.md` §9 に「承認を得てから適用する」として
  用意されているが、適用済みかどうかは本書のスコープ外（録音アプリ側の設定）。
- **独自ドメインへの移行は未実施。** 公開先は Cloudflare の既定ドメイン
  （workers.dev）を使っており、独自ドメイン案（かつて検討された
  `api.potenitas.com`）は採用されていない。
- **`NOTIFIER_ENTITLEMENT` の「特定プランのみ」分岐は実機で未検証。** 現状の
  運用は「契約が有効な会員すべて」に同梱する設定で稼働しており、価格 ID
  単位の絞り込みは単体テストの範囲でのみ確認されている。
- **受け入れ検証の完了範囲は文書上で確認できた限りに留める。** 新セットアップ
  フローの通し（テンプレートのコピーから公開・引き継ぎまで）は完了の記録が
  あるが、複数端末・再通知・ライセンス失効・公開のやり直しなど個別の検証項目
  については、リポジトリの記録からは完了/未完了を断定できない。
- **アクセシビリティ要件は定義されていない。** セットアップ UI・設定画面いずれも
  明文化された基準を持たない。

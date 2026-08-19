# 交流会申込アプリ 要件定義書

対象: `app/event/`（Next.js） + `lib/event/`（ビジネスロジック） + `supabase/migrations/`（DB） +
`public/event/index.html`（静的告知ページ）

## 1. 目的・背景

TSアセットマネジメント合同会社が主催する交流会（懇親会）の参加申込・決済・当日運営に必要な
参加者名簿を、単一のアプリで完結させる。既存の本番認証系（`gas-auth/` + スプレッドシート）や
`/apps/`（テスト環境）とはデータベース・セッション・認証の仕組みを完全に分離してあり、
どちらかの障害・設定変更がもう片方に及ばないようにしてある。

参加費は、参加者が入力する業界・職種・立場・年齢区分の組み合わせで変動する（詳細は
[docs/event-app-database.md](../../event-app-database.md) §3、割引定数は `lib/event/pricing.mjs`）。
金額の計算・改ざん防止・決済・当日名簿の作成までを一貫してサーバー側で担保することが
本アプリの中心的な要件である。

## 2. 用語定義

| 用語 | 意味 |
| --- | --- |
| 申込（application） | 参加希望者が入力フォームから送信した1件の記録。`applications` テーブルの1行 |
| 支払（payment） | 1件の申込に紐づく決済の記録。割引内訳のスナップショットを含む。`payments` テーブルの1行 |
| 受付番号 | 支払済みになった時点でイベントごとに発番される連番（`TSAM-0001` 形式）。当日の受付・名簿に使う |
| 出禁申告 | 過去に主催者から参加をお断りする通知を受けた者が、申込フォームで自己申告する項目。該当する場合は割引を無効化し55,000円に固定する |
| 譲渡 | 申込者が参加権を第三者に譲る運用。管理画面で申込者情報を書き換え、譲渡元情報を履歴として残す |
| 定員 | イベントごとに設定できる上限人数。支払済み件数がこれに達すると申込フローが自動停止する |
| 告知ページ | `public/event/index.html`。開催概要・参加費・キャンセルポリシーを掲載する静的HTML |

## 3. スコープ

### 対象

- 参加申込フォームの入力・検証・確認・決済（Stripe Checkout）
- Stripe Webhook 受信による支払確定・受付番号発行・参加確定メール送信
- 決済結果（完了・確認中・失敗・期限切れ・返金済み）の案内画面
- 定員に基づく自動受付停止
- 管理者向けの申込者一覧・詳細・編集（譲渡対応）・メール再送・CSV出力（申込者用／名札印刷用）
- 手動返金（Stripeダッシュボード操作）の結果をWebhook経由で反映する
- 開催回のGoogleカレンダー予定への申込状況（支払済み人数・予約者名簿）の書き戻し

### 対象外

- イベント自体の作成・編集・受付状態切替を行う管理画面（[docs/event-admin.md](../../event-admin.md) §3
  のとおり事業者判断で対象外とした。イベント登録・定員変更・受付開始日時はマイグレーションで行う）
- 割引ルールをデータベースやUIから編集する機能（DB内ルールエンジンを持たない方針。フェーズ2）
- アプリからの返金操作（返金はStripeダッシュボードの手動操作のみ）
- 告知ページ（`public/event/index.html`）のNext.js化・動的化
- 決済手段の個別実装（Stripe の automatic payment methods に委ねる。カード以外の対応可否はStripe側の設定に依存）

## 4. 利用者とロール

| ロール | 説明 | 認証 |
| --- | --- | --- |
| 参加希望者 | 告知ページから申込フォームへ進み、参加費を支払う一般利用者 | 認証なし。申込の書き込みはサーバー側が service role キーで行う |
| 管理者 | 申込状況の確認・申込者情報の編集・CSV出力・メール再送を行う運営担当者 | Supabase Auth（メールアドレス + パスワード）。このSupabaseプロジェクトに登録された利用者＝管理者という設計（[docs/event-admin.md](../../event-admin.md) §1） |

## 5. 機能要件

| ID | 要件 | 補足 |
| --- | --- | --- |
| FR-01 | 告知ページ（静的HTML）に開催概要・参加費のレンジ・キャンセルポリシーを表示する。開催日時そのものは掲載せず、申込フォームの参加日選択に一本化する（2026-08〜） | `public/event/index.html`。受付状態バッジ・申込ボタンの有効/無効は `/event/api/schedule/` の取得結果から `public/event/script.js` が決める |
| FR-02 | 申込フォームは氏名・フリガナ・メール・電話・会社名・部署名（任意）・役職名（任意）・業界・職種・立場・年齢区分・出禁申告・同意3項目を受け付ける | サーバー側で必ず再検証する。ブラウザ側検証は補助にすぎない |
| FR-03 | 参加費はサーバーが業界・職種・立場・年齢区分の割引額をすべて合算して計算する。下限3,300円を下回らない | `lib/event/pricing.mjs`。フォームや隠しフィールドから送られた金額は一切使わない |
| FR-04 | 出禁を「該当する」と申告した場合、金額を55,000円に固定し、割引の内訳・理由を確認画面にもメールにも表示しない | `calculatePrice()` / `buildBreakdownLines()` |
| FR-05 | 利用規約・キャンセルポリシー・プライバシーポリシーの同意3項目がすべてチェックされていなければ申込を保存しない。同意日時とその時点のポリシー版を記録する | `CONSENT_FIELDS`、`applications.agreed_at` / `policy_version` |
| FR-06 | 申込保存後、確認画面はDBに保存された申込内容から金額を再計算して表示する。URL・フォームからの金額入力は受け付けない | `/event/apply/confirm/` |
| FR-07 | 「決済へ進む」操作でサーバーが Stripe Checkout Session を作成する。渡す金額はDBから再計算した値のみ。申込1件につき冪等キーで二重作成を防ぐ | `createCheckoutSession()` |
| FR-08 | Stripe Webhook を受信し、署名検証に成功したイベントのみ処理する。対象イベント種別は `checkout.session.completed` / `checkout.session.async_payment_succeeded` / `checkout.session.async_payment_failed` / `checkout.session.expired` / `charge.refunded` | `handleStripeEvent()` |
| FR-09 | 同一の Stripe イベントIDを2回受信しても、受付番号の再発行・メールの再送・状態の重複更新を起こさない | `webhook_events.stripe_event_id` の一意制約で判定 |
| FR-10 | 受付番号は支払済みが確定した時点でイベント内の連番として発行する。発行済みなら同じ番号を返す | DB関数 `assign_receipt_number`（イベント行のロックで直列化） |
| FR-11 | `checkout.session.completed` はカード決済等その場で確定する経路にのみ即時反映し、PayPay等の非同期決済は `async_payment_succeeded` を待って支払済みにする | 受入条件7（[docs/event-acceptance.md](../../event-acceptance.md)） |
| FR-12 | 支払確定後、参加確定メール（交流会名・開催日時・場所・受付番号・支払金額・適用割引・名札の記載内容・キャンセルポリシー・問い合わせ先を含む）を送信する | `buildConfirmationMail()`。送信失敗は記録するのみで支払の記録は巻き戻さない |
| FR-13 | 決済結果ページは、遷移してきたこと自体を支払済みの根拠にせず、DBの状態（`applications.status` 等）から「完了・確認中・失敗・期限切れ・返金済み・不明」のいずれかを判定して表示する | `resolveResultState()` |
| FR-14 | 支払済み（`status='paid'`）の件数がイベントの定員に達したら、申込フォーム表示・フォーム送信・決済開始の3段で新規申込を止める | `isSoldOut()` / `isEventSoldOut()`。決済待ち（`awaiting`）は席に数えない |
| FR-15 | 定員に達しても告知ページ（静的HTML）の表示は自動で変わらない。運営者が `data-event-status` を手動で書き換える | [docs/event-app-database.md](../../event-app-database.md) §5 |
| FR-16 | 管理者はメールアドレスとパスワードでログインする。ログイン失敗時は「アドレスが存在しない」と「パスワードが違う」を区別しない | `signInWithPassword()` |
| FR-17 | 管理画面は未ログインではアクセスできず、ログイン画面へ送られる。CSVエンドポイントは未ログインで401を返す | `requireAdmin()` / `currentAdmin()` |
| FR-18 | 管理画面は各ページの表示のたびにSupabase側のトークン有効性を問い合わせる。期限が近ければリフレッシュトークンで取り直す | `needsRefresh()` / `refreshSession()` |
| FR-19 | 申込者一覧は受付番号・氏名・メール・会社名・業界・職種・立場・年齢区分・出禁申告・割引内訳・支払金額・ステータス・申込日時・決済日時を表示し、全件数・支払済み件数・支払済み合計金額・定員状態を表示する | `AdminListPage` |
| FR-20 | 申込者詳細は全入力項目・割引内訳（申込時点のスナップショットを正とし、現行ルールでの再計算結果も併記して差異を明示する）・Stripe の Session/PaymentIntent ID・譲渡履歴・管理者メモを表示する | `AdminDetailPage` |
| FR-21 | 管理者は氏名・フリガナ・メール・電話・会社名・部署名・役職名・管理者メモを編集できる。受付番号と支払金額は変更できない | `updateApplication()` |
| FR-22 | 「譲渡として記録する」を選ぶと、譲渡元の氏名・メール・譲渡日時を履歴に残す。2回目以降の書き換えでは譲渡元情報を上書きしない | `applications.is_transferred` / `original_name` / `original_email` |
| FR-23 | 受付番号が発行済み（支払済み）の申込に対してのみ、参加確定メールを現在のメールアドレス宛に再送できる | `resendConfirmationMail()` |
| FR-24 | 申込者CSV（全件・一覧と同じ項目）と名札印刷用CSV（支払済みのみ・氏名/会社名/業界/職種/立場の5項目・年齢を含まない）をBOM付きCRLFで出力する | `buildCsv()` / `NAMETAG_CSV_COLUMNS` |
| FR-25 | CSVの値は数式として解釈されうる先頭文字（`=` `+` `-` `@` 等）を無害化する | `escapeCsvValue()` |
| FR-26 | 返金はアプリから行わない。Stripeダッシュボードでの手動返金を Webhook（`charge.refunded`）で受け取り、申込・支払の状態を「返金済み（例外対応）」に更新する | `markRefunded()` |
| FR-27 | 支払確定時・返金反映時・管理画面での申込者情報の更新時に、その回の支払済み件数と予約者名簿をGoogleカレンダー予定の**説明欄（description）**へ書き戻す。主催者がカレンダーを開くだけで各回の申込状況を把握できるようにする | `updateAttendeeNote()` / `writeAttendeeNote()` / `buildDescriptionWithNote()`。書き込みは専用トークン `GOOGLE_CALENDAR_WRITE_REFRESH_TOKEN`（`calendar.events`）で行い、読み取り用（`calendar.readonly`）とは分ける（§9-1） |
| FR-28 | 書き戻しは説明欄のうちマーカーで囲んだ自動更新ブロックだけを差し替える。主催者の手書きメモは変更しない。予定のタイトル（`summary`）・日時・参加者は書き換えない | タイトルは `calendar-sync.mjs` が完全一致で突き合わせる同期キーであり、変えるとその回の取り込みが止まる（[02_basic-design.md](./02_basic-design.md) §9） |
| FR-29 | 名簿に載せるのは**支払済み（`status='paid'`）の申込のみ**、受付番号の昇順で、**受付番号と氏名だけ**。返金された申込は `status` が変わるため自動的に名簿から消える | `listPaidAttendees()` が受付番号と氏名の2列しか取得しない（NFR-19） |

## 6. 非機能要件

### セキュリティ

| ID | 要件 |
| --- | --- |
| NFR-01 | 参加費はサーバーが計算した値のみを用いる。ブラウザから送られた金額・隠しフィールドの値は一切参照しない |
| NFR-02 | Stripe Webhook は `Stripe-Signature` ヘッダーを HMAC-SHA256 で検証し、タイムスタンプの許容範囲（既定300秒）を超えるリクエストを拒否する。比較はタイミングセーフに行う |
| NFR-03 | Supabase の全表で RLS を有効にし、ポリシーを作らない。加えてテーブル権限を `service_role` にのみ付与し、`anon` / `authenticated` からは権限自体を剥がす。読み書きは必ずサーバー側（service role キー）を経由する |
| NFR-04 | `SUPABASE_SERVICE_ROLE_KEY` など秘密情報を要する環境変数には `NEXT_PUBLIC_` を付けない。ブラウザ配信バンドルに含まれないことをビルド後に確認する運用とする |
| NFR-05 | 管理者のアクセストークンは httpOnly Cookie（`tsam-event-admin`）に保持し、パスを `/event/admin` に限定して公開画面へ送らない |
| NFR-06 | CSV出力は数式インジェクション対策（先頭文字の無害化）を行う |
| NFR-07 | エラーメッセージに秘密情報（キー・トークン・パスワード）を含めない |
| NFR-19 | カレンダーの説明欄（アプリの外＝Google側の保管領域）へ書き出す個人情報は、受付番号と氏名に限る。フリガナ・メールアドレス・電話番号・会社名・年齢区分・支払額は書き出さない。取得の時点で列を絞り（`listPaidAttendees()`）、表示側で捨てる実装にはしない |
| NFR-20 | 名簿に載せる氏名は、制御文字と自動更新ブロックのマーカー文字（U+2015）を除去してから書き出す。氏名は申込者・管理者が自由に入力できる値であり、そのまま差し込むとブロックの区切りを偽装され、次回の書き戻しで説明欄が破壊されうる |

### 冪等性・可用性

| ID | 要件 |
| --- | --- |
| NFR-08 | 同一の Stripe イベントを複数回受信しても、受付番号の重複発行・参加確定メールの重複送信・状態の不整合を起こさない（`webhook_events.stripe_event_id` の一意制約） |
| NFR-09 | 参加確定メールの送信に失敗しても、直前までに確定した支払・受付番号の記録を巻き戻さない。Stripe Webhook の処理自体は成功として扱う |
| NFR-10 | Webhook の署名検証・処理に失敗した場合は、Stripe が定める形式でHTTPステータスを返し、必要に応じてStripe側の再送に委ねる（署名不正は400・処理失敗は500） |
| NFR-18 | カレンダーへの人数・名簿の書き戻し（FR-27）に失敗しても、支払・受付番号・参加確定メール・管理画面の編集内容を巻き戻さない。書き込み用トークン未設定・Google側の障害・手動登録の回（`google_calendar_event_id` が null）のいずれも、結果の文字列に残すだけで Webhook は成功として返す（NFR-09 と同じ方針） |
| NFR-21 | 名簿が説明欄の文字数上限（Google側で8,192文字）を脅かす長さになる場合は、名簿を省略して人数行だけを書き戻す。名簿のために人数まで書けなくなる状態を作らない |

### 性能

| ID | 要件 |
| --- | --- |
| NFR-11 | 定員判定はHEADリクエスト＋`Content-Range` ヘッダーで件数のみ取得し、行データを転送しない |
| NFR-12 | 定員が設定されていないイベントでは定員判定のための問い合わせを行わない |

### 運用

| ID | 要件 |
| --- | --- |
| NFR-13 | 外部SDKを追加せず、Stripe・Supabase・Gmail のいずれも `fetch` によるREST直接呼び出しで実装する。新規ライブラリの追加は事前確認を要する（[AGENTS.md](../../../AGENTS.md)） |
| NFR-14 | ビジネスロジックは `.mjs` で実装し、型は手書きの `.d.mts` を対で用意する（`tsconfig.json` の `allowJs: false` のもとでも Node から直接実行できるようにするため） |
| NFR-15 | DB変更は Supabase CLI によるマイグレーション追加で行い、適用済みファイルは編集しない |

### アクセシビリティ

| ID | 要件 |
| --- | --- |
| NFR-16 | フォームのエラーメッセージは `role="alert"` で通知し、入力欄とエラー文言を `id` で関連付ける |
| NFR-17 | セマンティックHTML・ネイティブ要素を優先し、既存の静的サイトと共通のCSS（`public/css/style.css` 等）を用いて体裁を揃える |

## 7. 制約条件

- **basePath を使わない。** `next.config.ts` の `basePath` は `public/` 配下の静的ファイルにも適用されるため、`/` が404になる。公開URLは basePath なしで `/event/...` を実現している。
- **`trailingSlash: true`。** Stripe Webhookのエンドポイントは末尾スラッシュ付き（`/event/api/stripe/webhook/`）で登録する必要がある。スラッシュなしへのPOSTは308になり、Stripeはリダイレクトを追わない。
- **rewrites は `fallback` で返す。** `afterFiles` にするとルートハンドラより先に評価され、`/event/api/...` が静的ページへの書き換えに飲まれる。
- **`output: "export"` を使わない。** Webhook受信とCheckout Session作成にサーバー実行環境が必要なため。
- **配信は Cloudflare Workers（OpenNext）で、`main` への push による自動デプロイはない。** `npm run deploy` を手動実行する。
- **告知ページ（`public/event/index.html`）は開催日時を掲載しない（2026-08〜）。** 具体的な日時は申込フォーム（`/event/apply/`、`resolveSelectableEvents()`）が `events` テーブルから毎回描画する一本化先であり、告知ページ側の手動更新は不要。告知ページが叩く `/event/api/schedule/` は受付状態バッジ・申込ボタンの有効/無効の判定にのみ使う。
- **定員 (`capacity`) を 0・負数・小数にしても定員なし扱いになる。** 受付を閉じる手段としては使えない（`isSoldOut()` の設計判断）。閉じる場合は `apply_end_at` を過去日時に更新する。
- **定員に達したときの告知ページの表示切替は自動化されていない。** 運営者が `data-event-status` を手動更新してデプロイする。

## 8. 外部依存

| 依存先 | 用途 | 通信方式 | 認証 |
| --- | --- | --- | --- |
| Stripe | Checkout Session の作成、決済結果のWebhook通知、（手動）返金 | `fetch` による REST 直接呼び出し（SDK不使用） | シークレットキー（`STRIPE_SECRET_KEY`）／ Webhook署名（`STRIPE_WEBHOOK_SECRET`） |
| Supabase（プロジェクト `tsam-event`） | 申込・支払・Webhookイベント・メールログの永続化、管理者認証（Supabase Auth） | PostgREST（`fetch`）／ Auth REST（`fetch`） | service role キー（データ操作）／ anon キー（管理者ログイン） |
| Gmail API | 参加確定メールの送信 | `fetch`（Gmail API `messages.send`） | OAuth 2.0 リフレッシュトークン方式、`gmail.send` スコープのみ、送信元は `MAIL_FROM` 環境変数で指定（実アドレスは本書に記載しない） |
| Google Calendar API v3 | 開催日の取り込み（`events.list`）と、支払済み人数の書き戻し（`events.get` + `events.patch`、FR-27） | `fetch`（OAuth token endpoint + Calendar API v3） | OAuth 2.0 リフレッシュトークン方式。**用途ごとに別のトークンを持つ**。取り込みは `calendar.readonly`（`GOOGLE_CALENDAR_REFRESH_TOKEN`）、書き戻しは `calendar.events`（`GOOGLE_CALENDAR_WRITE_REFRESH_TOKEN`）。OAuthクライアント（`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`）はGmailと共用（§9-1） |

## 9. 前提条件・未確定事項

- 次回以降の開催日程・会場・定員・受付開始日時は未確定。イベントごとにマイグレーションで登録する運用のため、確定次第マイグレーションを追加する。
- `apply_start_at`（受付開始日時）は初回イベントで暫定値が入った経緯があり（[docs/event-app-database.md](../../event-app-database.md) §1-3）、現在の正確な値はマイグレーション追跡のみでは確認できない。**未確定**。
- 実際に有効な決済手段（カード以外にPayPay等が有効化されているか）は Stripe ダッシュボードの設定に依存し、リポジトリからは確認できない。**未確定**。
- Gmail 送信アカウント（`MAIL_FROM` で指定）が無料アカウントかGoogle Workspaceかにより日次送信上限が異なる（約500通 / 約2,000通）。現状の契約種別は本書のスコープ外につき**未確定**。
- Stripe側のWebhookエンドポイント登録・環境変数の実際の設定値・登録日時は秘密情報を含むため本書には記載しない。

### 9-1. Googleカレンダー連携のトークン発行

カレンダー連携は**用途ごとにリフレッシュトークンを分ける**。1つのトークンにまとめると、
片方の用途に過剰な権限を与えることになるため（読み取りだけの同期処理に書き込み権限を持たせない）。

| 用途 | 環境変数 | スコープ | 発行コマンド |
| --- | --- | --- | --- |
| 開催日の取り込み（読み取り専用） | `GOOGLE_CALENDAR_REFRESH_TOKEN` | `https://www.googleapis.com/auth/calendar.readonly` | `node scripts/get-calendar-refresh-token.mjs` |
| 支払人数の書き戻し（FR-27） | `GOOGLE_CALENDAR_WRITE_REFRESH_TOKEN` | `https://www.googleapis.com/auth/calendar.events` | `node scripts/get-calendar-refresh-token.mjs --write` |

手順（どちらも共通）。

1. 事業者自身のターミナルで上記コマンドを実行する。OAuth クライアント ID・シークレットの入力を求められる
   （Gmail送信用に作成済みのデスクトップアプリ型クライアントを使い回す。`GOOGLE_CLIENT_ID` /
   `GOOGLE_CLIENT_SECRET` はカレンダーとメールで共用）。
2. 表示されたURLをブラウザで開き、カレンダーの持ち主（主催者アカウント）で認可する。
   `gmail.send` は要求されない。
3. 画面に表示されたリフレッシュトークンを、上表の環境変数として Cloudflare Workers 側に登録する。
   スクリプトは値をファイルにもログにも書かない（保存の判断は実行者に委ねる）。

補足。

- **書き込み用トークンは任意。** 未設定の環境では書き戻しだけを見送り、申込・決済・メールは
  従来どおり動く（NFR-18）。設定漏れに気づけるよう、見送った事実は `webhook_events.result` に残る。
- スクリプトは値を画面に出すだけで保存しない。実際のトークン値は本書にもリポジトリにも記載しない。
- 書き込み用トークンを失効させたい場合は、Googleアカウントの「サードパーティ アプリとサービス」から
  該当クライアントのアクセスを取り消す。読み取り用と同じOAuthクライアントのため、取り消すと
  **開催日の取り込みも止まる**（両方を再発行することになる）。

# 宿題リスト（スコープ外へ送った作業）

制定: 2026年8月9日

**「気づいたが、その場では直さないと決めたもの」を残す場所。**
作業中に見つけた課題を口頭やコミットメッセージに置くと、次の作業者へ届かない。
ここに書いておけば、着手の判断材料になる。

書き方の決まり:

- **なぜ今やらないのか**を必ず書く。理由の無い先送りは、ただの放置と区別がつかない。
- 着手条件（何が起きたら手を付けるか）を書く。
- 済んだ項目は消さず、「済」へ移して日付と対応先を残す。

---

## 未対応

### B-11. 通知の向き先を1つの設定値で切り替えられるようにする（優先度: 低）

**内容**: 2026-08-11 に通知を本番（`/production-app/voice-recorder/`）から
テスト環境（`/apps/voice-recorder/`）へ移した際、**向き先が2種類あることが分かった。**

| 向き先 | いまの持ち方 | 移設で困ったか |
| --- | --- | --- |
| 自分の配置場所（SW スコープ・開く先） | `self.registration.scope` / `import.meta.url` から**組み立てている** | **困らなかった。1文字も直さずに動いた** |
| `manifest.webmanifest` の `start_url` / `scope` | **絶対パスの直書き** | 直した（相対で書けないため） |
| テンプレートのコピー先（`TEMPLATE_COPY_URL`） | `notifier-config.js` の定数 | 直していない（本番のままでよいと判断） |
| 引き継ぎリンクの戻り先（`RECORDER_APP_URL`） | `gas-notifier/Store.gs` の定数（**本番URL**） | 直していない（テスト側で完走させない前提のため） |

移設そのものは manifest の2行で済んだので、**いま困っていない。**
ただし後ろ2つは「テスト環境で通しで試したい」となった瞬間に効いてくる。
テンプレート側の `RECORDER_APP_URL` は**利用者のコピーに焼き付く**ので、
切り替えるには貼り替えとデプロイ更新が要る。

**やること**: 向き先を1か所へ集め、環境（本番／テスト）で切り替えられる形にする。
`workers/notifier-gate/origin.mjs` が公開オリジンに対してやっているのと同じ考え方で、
**正本を1つ置き、ずれたらテストが落ちる**形にするのが望ましい。

**なぜ今やらないか**: 移設は済んでおり、実害が出ていない。
テスト環境ではセットアップ導線を完走させない前提にしたので、
いま切り替えの仕組みを入れても使う場面が無い。
**使わない仕組みを先に入れると、戻すときの手数が増えるだけになる。**

**着手条件**: テスト環境で通しの検証をしたくなったとき。
または、本番／テストのどちらへ戻すかを繰り返し切り替える運用になったとき。

---

### B-09. ［接続テスト］がライセンスの状態を取り直さない（優先度: 中）

**内容**: 録音アプリの「ご契約」の行は `getSettings` が返す `LICENSE_STATE` を出す。
これを書くのは**同期（`syncCalendar_`）だけ**で、同期は5分間隔である
（[CalendarSync.gs](../gas-notifier/CalendarSync.gs)）。したがって
**［接続テスト］を押しても、ライセンスの状態は取り直されない。**

利用者から見ると「確認のボタンを押したのに、確認されていない」。
契約を直した直後に押しても変わらず、直っていないと読める。
`syncNow` の action は既にあり（`Api.gs`）、クライアント側の関数も
[notifier-client.js](../public/production-app/voice-recorder/notifier-client.js) に
あるが、**画面のどこからも呼んでいない。**

**なぜ今やらないか**: 実機検証の段取りに影響するだけで、通知そのものは
正しく動いている（5分以内に反映される）。またこの修正は
「接続テストが同期を起こす」という副作用を足すことになり、
押すたびにカレンダー読み取りとゲート照会が走る。レート制限との
兼ね合いを設計してからでないと、2026-08-11 の増幅事故と同じ形になりうる。

**着手条件**: 検証セッション（B〜G節）が終わり、evaluate の呼び出し回数の
実測が取れた時点。`syncNow` を接続テストへ足すか、押した時刻を見て
「次の同期で反映されます（あとN分）」と出すかを、そこで決める。

---

### B-10. `NOTIFIER_ENTITLEMENT` の判定が実機で未確認（優先度: 低）

**内容**: [gas-auth/Notifier.gs](../gas-auth/Notifier.gs) の
`evaluateNotifierEntitlement_` は `payment_exempt` を
**`NOTIFIER_ENTITLEMENT` を読むより先に**通す（免除の利用者が Stripe の契約を
持たないため。順序自体は正しい）。

現在の検証アカウントは `payment_exempt = TRUE` であり、
**`all_active` / `plan:<price_id>` の分岐に一度も入らない。**
E節はライセンスキーを未登録の値へ差し替えることで「ゲートが止める」ことは
確かめたが、**entitlement の規則そのものは実機で通っていない。**

`payment_exempt` を FALSE にして確かめる案は採れない。
[gas-auth/Sessions.gs](../gas-auth/Sessions.gs) がセッション検証のたびに
`isSubscriptionUsable_` を通すため、その瞬間にログインから締め出される
（`subscription_status` が `exempt` のため復帰もできない）。

**なぜ今やらないか**: 免除でない利用者が実在しないと確かめられない。
単体テストでは分岐を押さえてある（`tests/unit/notifier-license.mjs`）。

**着手条件**: 有料契約の利用者が1人でも通知を使い始めたとき。
その時点で `plan:` へ切り替える判断をするなら、切り替え前に必ず実機で確認する。

---

### B-08. VAPID キャッシュの上書きで、宛先の組み合わせが往復すると取り直しが起きる（優先度: 中）

**内容**: [gas-notifier/Gate.gs](../gas-notifier/Gate.gs) の `gateVapid_` は、
受け取った JWT の集合で `VAPID_JWTS_JSON` を**まるごと上書き**する。
ところが呼び出し元によって欲しい宛先が違う。

| 呼び出し元 | 欲しい宛先 |
| --- | --- |
| `primeVapid_`（`saveLicense` / `publicKey`） | 主要3社を決め打ち（fcm / mozilla / apple） |
| `sendTickle_`（tick） | **実際の購読の endpoint から作った origin** |

Edge（`wns2-….notify.windows.com`）のように決め打ちに含まれない宛先を使う端末が
あると、`primeVapid_` → tick → `primeVapid_` と交互に呼ばれるたびに
キャッシュが外れ、**そのつどゲートを1回消費する。**

**なぜ今やらないか**: 実害が出ていない。tick は連続して同じ宛先を求めるので
2回目以降はキャッシュに当たり、`primeVapid_` はライセンスの引き渡しと
初回の鍵取得でしか動かない（`saveLicense` の繰り返しは止めた）。
1時間20回の枠に対して、往復しても数回で収まる。

> **失敗後のクールダウン（`VAPID_RETRY_AT`）はこの件に効かない。**
> 往復で起きるのは**成功する呼び出し**であり、待ちを作るのは失敗したときだけ
> だからである。同じ「呼び出しが増える」でも、2026-08-11 に直した増幅
> （失敗 → 保存されない → また呼ぶ）とは別の経路である。
> 枠を広げた（4 → 20）ことと、ゲートが `retryAfterSec` を返すようになったことも、
> この件の発生自体は減らさない。**効くのは枠の余裕だけ**で、
> だから優先度を 中 に置いている。

**単純な「上書きせず統合する」では直らない**ことも先に書いておく。
`VAPID_EXPIRES_AT` は集合全体で1つしか持っていないため、統合すると
古い JWT が新しい期限を名乗り、**期限切れの署名で送って 401 になる。**
直すなら、宛先ごとに期限を持つ形へ変える必要がある。

**着手条件**: 実機で Edge / Firefox を含む複数端末を登録し、
`RATE_LIMITED` が再び出た場合。または宛先ごとの期限を持たせる改修を行うとき。

---

### B-06. `potenitas.com` の DNS 管理画面の所在を docs に記録する（優先度: 低）

> **訂正（2026-08-10）**: この項目は当初「`potenitas.com` は未取得であり、
> 第三者が取得すると管理者宛メールを受信できてしまう」という内容で登録した。
> **事実確認の結果、この前提は誤りだった。** `potenitas.com` は Google Workspace
> 経由で取得済み（レジストラは Google）であり、`architect@potenitas.com` は
> 実在・受信可能なアドレスである。乗っ取りリスクの記述と、
> 「管理者メール経由のフローを使わない」という暫定運用は撤回する。
> **`INITIAL_ADMIN_EMAIL` と `LEGAL_CONTACT_EMAIL` は現状のままでよい。**

**内容**: `potenitas.com` は **Google Workspace 経由で取得したドメイン**で、
レジストラも DNS も Google 側にある。つまり DNS レコードを触るには
**Workspace の管理者アカウント**で管理コンソールへ入る必要があるが、
そのことがリポジトリのどこにも書かれていない。

困るのは、DNS を触る必要が生じたときである。

- カレンダー通知の Workers を独自ドメイン（`api.potenitas.com`）へ移すとき
- メール周り（SPF / DKIM / DMARC）を確認・変更するとき

「どこで触れるのか」が分からないと、その場で調べ直すことになる。

**やること**: DNS 管理画面の所在を docs に1節書く。**アカウント名や
パスワードは書かない**（リポジトリは GitHub にある）。書くのは
「Google Workspace の管理コンソールにある」「レジストラは Google」という
所在と、下の移行手段の選択肢まで。

将来 notifier-gate を `api.potenitas.com` へ移す場合の手段は2つある。

1. **Google 側の DNS にレコードを足す** — Cloudflare の Custom Domain 検証に
   必要なレコードを Workspace の管理コンソールから追加する
2. **ネームサーバーを Cloudflare へ移管する** — こちらのほうが以後の操作は楽だが、
   **MX レコードの引き継ぎが必須**である。引き継ぎ漏れは
   「メールが全部届かなくなる」形で表面化し、気づくのが遅れる

いずれにせよ、**移行しても既存利用者への影響は無い**
（workers.dev のURLは Custom Domain を足しても並行して有効なまま。
[workers/notifier-gate/README.md](../workers/notifier-gate/README.md) §8）。

**なぜ今やらないか**: 現在 notifier-gate は workers.dev の既定ドメインで
公開しており、DNS を触る必要が無い。急いで書いても、実際に移行する時点で
Cloudflare 側の要求が変わっている可能性がある。

**着手条件**: `api.potenitas.com` への移行を決めたとき、
またはメール周りの設定を確認する必要が生じたとき。

---

### B-01. `gas-notifier/*.gs` の構文検査を CI に追加する

**内容**: [gas-notifier/](../gas-notifier/) の `.gs` は、いまテストから
[tests/helpers/gas-notifier-harness.mjs](../tests/helpers/gas-notifier-harness.mjs)
経由で `vm` に読み込まれている。読み込みに失敗すれば
`notifier-template` スイートが異常終了するため、**構文エラーは実質的に
検出される**。ただしそれは副作用であって、意図した検査ではない。

- 検査対象は harness が読む範囲に限られる（`SidebarSetup.html` は読み込まれない）
- 失敗したとき「構文エラー」ではなく「スイートが落ちた」としか出ない
- `SidebarSetup.html` 内の JS はどこからも検査されていない
  （V2 でウィザードの分量が増えたぶん、見ていない範囲も増えた）

**やること**: `.gs` を V8 相当で構文検査する小さなスクリプトを足し、
[.github/workflows/test.yml](../.github/workflows/test.yml) から実行する。
`gas-auth/*.gs` も同じ扱いにできる。

**なぜ今やらないか**: カレンダー通知の実装とは独立しており、
CI の構成（現在は `npm test` のみ）へ手を入れる話になるため。

**着手条件**: `.gs` の構文エラーを本番へ持ち込んだ時点、
または CI に別の検査を足す機会があったとき。

---

### B-02. ログイン仕様書 §6「将来拡張」1・2 の実施

**内容**: [docs/specs/login-page-detailed-spec-v3.md](./specs/login-page-detailed-spec-v3.md) §6 に、
発動条件つきの将来拡張が3つ書かれている。2026-08-09 に 3（画面ごとの許可パラメータ）だけを
実施し、1 と 2 は残してある。

1. `ALLOWED_NEXT` を `SCREENS`（[public/auth/config.js](../public/auth/config.js)）から導出し、
   画面追加時の多重修正（page / session / config）を解消する
2. 画面名ベースの元画面復帰（`?next=<画面名>` を `guardPage()` が自動設定）を導入する

**発動条件はすでに満たされている。** 「保護対象画面が3つを超えた時点で」と書かれており、
現在は portal / card-ocr（+help, +measure）/ receipt-ocr / short-script（+help）/
voice-recorder の6アプリ・9画面がある。

**なぜ今やらないか**: 2 を入れると**全アプリのログイン後の遷移先が変わる**。
現在はどのアプリも `guardPage({ next: 'portal' })` で Portal へ戻る挙動になっており
（録音アプリだけ 2026-08-09 に自分の画面へ戻すよう変えた）、これを一斉に変えるなら
各アプリの導線を1つずつ確認する必要がある。カレンダー通知の不具合修正に
巻き込む変更ではない。

**やること**: 別ブランチで、各アプリの `guardPage({ next: ... })` を一斉に見直す。
[tests/unit/frontend.mjs](../tests/unit/frontend.mjs) の「遷移先の検証」と
「ログイン画面への往復」を先に拡張してから実装に入ること。

**着手条件**: 保護対象アプリをもう1つ足すとき（多重修正が3か所に増える）。

---

### B-03. Vercel 前提の古い記述を Cloudflare Workers + OpenNext へ揃える

**内容**: 2026-08 に Vercel から Cloudflare Workers（OpenNext）へ切り替えたが、
切替前に書かれた文書がそのまま残っている。**現行の正は
[docs/deployment-cloudflare.md](./deployment-cloudflare.md)** であり、
その冒頭にも「DEPLOYMENT.md と production-cutover.md は古い」と書いてある。

読んだ人が誤解しうる主なもの:

| 文書 | 古い前提 |
| --- | --- |
| [DEPLOYMENT.md](../DEPLOYMENT.md) | Vercel の Git 連携で `main` へのマージが公開になる |
| [MANUAL_SETUP_CHECKLIST.md](../MANUAL_SETUP_CHECKLIST.md) | Vercel 側の手動設定手順 |
| [docs/production-cutover.md](./production-cutover.md) | Vercel への切替手順（歴史的記録） |
| [docs/vercel-migration.md](./vercel-migration.md) | 同上 |
| [docs/specs/README.md](./specs/README.md) 末尾 | GitHub Pages がルートを配信しており `docs/` も公開される |

**いちばん危ないのは「マージ＝公開」という誤解**である。現在は
`npm run deploy` の手動実行だけが公開の起点で、マージしても本番は変わらない。

**なぜ今やらないか**: 対象が広く、どれを「歴史的記録として残す」・どれを
「現行に合わせて書き換える」かの仕分けから要る。切替の経緯そのものは
記録として価値があるため、単純な一括置換にはできない。

**やること**: 各文書の冒頭に現行構成への案内を足すか、
「これは移行前の記録である」と明記する。`docs/specs/README.md` の
「`docs/` も公開される」は**事実と異なる**（現在は公開URLから404）ため、
これだけは先に直すのが望ましい。ただし「秘密情報を書かない」という結論自体は、
リポジトリが GitHub にある以上そのまま有効なので消さないこと。

**着手条件**: 新しい担当者がデプロイ手順を読む前。または上記のどれかを
別件で編集するとき（ついでに直す）。

---

## 済

### B-07. `scriptApiFetch_` の一時デバッグ出力を削除する — 済（2026-08-11）

**対応**: 削除した。着手条件（403 の原因が確定し、公開が通ること）が
実機で満たされたため、テンプレートを貼り替える同じ機会に行った。

- 原因は **GCP プロジェクトで Apps Script API が未有効**（`API_DISABLED_GCP`）。
  生の応答に入っていたプロジェクト番号と有効化URLで確定した
- 恒久的に残すものではない。応答本文を4000文字まで出しており、
  Google 側の文面が変われば何が出るか分からない。
  **出す内容を自分で決めていない**のが、この出力のよくないところだった
- 切り分けは、種別（`API_DISABLED` / `API_DISABLED_GCP`）と
  有効化URLの抽出（`firstHttpsUrl_`）で足りる状態になっている

[tests/unit/notifier-template.mjs](../tests/unit/notifier-template.mjs) の検査は
**外さずに向きを変えた。** 「生の応答を出す」から
**「生の応答を流し込まない／種別の1行は残す」**へ置き換え、
同じ形の出力が将来また入り込むことを見張らせている。

**この原因を受けた商品判断**は、宿題ではなく実装へ反映済み。
`API_DISABLED_GCP` では手動公開を主経路にした
（[notifier-v2-rollout.md](./notifier-v2-rollout.md)「公開ボタンの 403」）。

---

### B-04. `pending` の取得済み管理を購読（端末）単位にする — 済（2026-08-10）

**対応**: カレンダー通知 V2（Phase 3 / 4）で解決した。

- `subscriptions` に `subId`（購読ごとの識別子）を持たせた
- `sent_log` の `fetchedBy` に、取りに来た `subId` を並べる形へ変えた
  （`fetchedAt` 1列で「最初に来た端末が全部さらう」形をやめた）
- `pending` は**呼び出し元の `endpoint` を必須**にした。省略を許すと
  V1 の挙動へ静かに戻るため（[Api.gs](../gas-notifier/Api.gs) の `takePending_`）
- Service Worker 側も自分の endpoint を添えて呼ぶようにした
  （[sw.js](../public/production-app/voice-recorder/sw.js)）

**設計の理由**: [notifier-design-notes.md](./notifier-design-notes.md) §5

**残っている確認**: 実機で2台に本文つき通知が届くこと。
[notifier-v2-acceptance-checklist.md](./notifier-v2-acceptance-checklist.md) C 節。

---

### B-05. 送信済みの予定がリスケされたときの再通知仕様を確定する — 済（2026-08-10）

**決めたこと**: **開始時刻が5分以上動いたら再通知する。5分未満なら再通知しない。**

宿題として書いたときの懸念（開始時刻をキーへ入れると微修正で連発する）は、
閾値と**比較の相手**の2つで解いた。

- 重複判定のキーを `feature + eid + timing + 開始時刻` にした
- 比較の相手は常に**送信時点の開始時刻**で、前回の同期で見た値ではない。
  毎回の値と比べると、4分ずらしを繰り返して無限に先送りできてしまう。
  送信時点と比べれば、4分ずらしを2回した時点で元から8分動いており再通知される

判定は運営の Workers にあり（[evaluate.mjs](../workers/notifier-gate/src/evaluate.mjs)）、
閾値は `RENOTIFY_THRESHOLD_MS`。テストは時刻差のマトリクス
（変更なし / 4分 / 5分 / 60分 / 過去方向 / 積み重ね）で固定してある。

**設計の理由**: [notifier-design-notes.md](./notifier-design-notes.md) §4

**残っている確認**: 実機で「60分ずらす→再通知あり」「4分ずらす→なし」。
[notifier-v2-acceptance-checklist.md](./notifier-v2-acceptance-checklist.md) D 節。

# カレンダー通知 V2｜本番へ戻す手順

作成: 2026年8月11日

2026-08-11 に、通知を本番（`/production-app/voice-recorder/`）から
テスト環境（`/apps/voice-recorder/`）へ移した。**試験の先送りであって廃止ではない。**
この文書は、戻すときに読むもの。

| | |
| --- | --- |
| 戻す先の基準点 | タグ **`notifier-v2-complete`**（移設直前の main） |
| 移設したコミット | `cd05d84` |
| 実機検証の再開位置 | [notifier-v2-test-run.md](./notifier-v2-test-run.md) |
| 設計の全体像 | [notifier-v2-design.md](./notifier-v2-design.md) |

---

## 0. いま何が動いていて、何が止まっているか

**サーバー側は全部生きている。** 止めたのは本番画面への露出だけである。

| 要素 | 状態 | 費用 |
| --- | --- | --- |
| `notifier-gate`（Workers） | **稼働中。** `/v1/health` は 200 を返す | 無料枠内 |
| KV（`LICENSE_CACHE`） | 稼働中。ライセンス記録が1件 | 無料枠内 |
| `gas-auth` の `Notifier.gs` | 稼働中。ライセンス発行・照会とも可能 | ― |
| 検証用のテンプレートのコピー | **毎分トリガーを停止**（2026-08-11 確定・§5-1） | ― |
| V1 のテンプレート（配布用） | 未廃止（宿題 R-24） | ― |
| 本番の録音アプリ | **通知の UI・SW・購読なし。CSP からもゲートを除去** | ― |
| テスト環境の録音アプリ | 通知の実体あり（セットアップは完走しない） | ― |

> 棚卸しの判断は §5。

---

## 1. 戻し方は2つある

### 1-A. タグから戻す（**移設後にテスト環境側で通知を触っていない場合**）

```powershell
git checkout -b feat/notifier-restore origin/main
git checkout notifier-v2-complete -- `
  public/production-app/voice-recorder/ `
  public/apps/voice-recorder/ `
  tests/unit/voice-recorder-notifier.mjs `
  tests/unit/notifier-connection.mjs `
  workers/notifier-gate/origin.mjs
npm test
```

**いちばん確実である。** 移設で触ったファイルが、移設前の姿へ丸ごと戻る。

ただし**移設後に加えた変更も一緒に消える。** 上のコマンドは
`public/apps/voice-recorder/` も戻すので、テスト環境側で録音まわりを
直していた場合はそこも巻き添えになる。`git diff notifier-v2-complete -- public/apps/voice-recorder/`
で先に確かめること。

### 1-B. 移設をもう一度、逆向きに行う（**テスト環境側で通知を直した場合**）

直した内容を残したいときはこちら。§2 の一覧を上から順に逆向きに行う。

---

## 2. 移設で動かしたものの一覧（逆向きに行うときの手順）

| # | 対象 | 移設でしたこと | 戻すときにすること |
| --- | --- | --- | --- |
| 1 | `notifier-client.js` / `notifier-config.js` / `notifier-messages.js` / `notifier-panel.js` / `sw.js` / `manifest.webmanifest` | `/apps/` へ `git mv` | `/production-app/` へ `git mv` |
| 2 | `manifest.webmanifest` の `start_url` / `scope` | `/apps/voice-recorder/` へ | **`/production-app/voice-recorder/` へ戻す**（相対で書けない唯一の場所） |
| 3 | `index.html` の通知セクション（`vr-notifier-panel`）と対象表示バナー（`vr-event-banner`） | `/apps/` の `</main>` 直前へ挿入 | 本番の `</section>`（result パネル）の後ろへ。バナーは「利用の準備」パネルの直前 |
| 4 | `index.html` の `<link rel="manifest">` | `/apps/` の head へ | 本番の head へ |
| 5 | `style.css` の通知専用の規則 | `/apps/style.css` の末尾へ（印つきのブロック） | ブロックごと本番へ戻す |
| 6 | 組み立ての呼び出し | `/apps/script.js` の `DOMContentLoaded` 末尾で `mountNotifier()` | 本番 `app.js` の `guardPage()` 通過後へ。**`import` も戻す** |
| 7 | `app.js` の `currentEventIdFromUrl` | 本番に内製化して**残置** | `notifier-panel.js` の export へ戻し、内製版を消す |
| 8 | テストの参照先 | `tests/unit/voice-recorder-notifier.mjs` / `notifier-connection.mjs` / `workers/notifier-gate/origin.mjs` を `/apps/` へ | `/production-app/` へ戻す |

> **7 に注意。** `currentEventIdFromUrl` は移設のとき**2か所に存在しない**ようにしてある
> （本番の `app.js` に内製し、`notifier-panel.js` にも export が残っている）。
> 戻すときは、本番 `app.js` の内製版を**消してから** import に切り替えること。
> 消さないと、同じ名前の関数が2つある状態になる。

### パスの直書きは無い（**戻すのが楽な理由**）

`sw.js` と `notifier-panel.js` は開く先も自分の窓かどうかの判定も
`self.registration.scope` と `import.meta.url` から作っている。
**移設のとき1文字も直さずに動いた。** 戻すときも同じである。

この性質は `tests/unit/voice-recorder-notifier.mjs` が見張っている
（`/production-app/` と `/apps/voice-recorder/` の**どちらも**直書きされていないこと）。

---

## 3. 戻したあとに必要なこと

### 3-1. デプロイ

```powershell
npm run deploy
```

**通知ゲートの再デプロイは要らない**（触っていないため）。

### 3-2. 利用者側の再セットアップ — **不要**

| 要素 | 戻したあと |
| --- | --- |
| ライセンスキー | **そのまま使える。** 認証系の `users` Q列にあり、消していない |
| 接続キー・`/exec` URL | **そのまま使える。** テンプレート側の Script Properties にある |
| VAPID の鍵 | **変えていない。** 購読は無効にならない |
| 通知用シート（利用者のコピー） | **貼り替え不要**（テンプレート側は移設で触っていない） |

**ただし端末の購読は取り直しになる。** Service Worker のスコープが
`/apps/voice-recorder/` → `/production-app/voice-recorder/` へ戻るため、
移設中に `/apps/` 側で購読した端末の登録は本番では効かない。
録音アプリで［接続テスト］を1回押せば登録し直される。

> 移設中にテスト環境で購読していない場合は、この作業も要らない。

### 3-3. IndexedDB の扱い — **触らない**

接続情報の保管先（`tsam-vr-notifier`）は**オリジン単位**で、
`/apps/` と `/production-app/` で**同じものを共有する**。
つまり移設しても接続情報はそのまま引き継がれ、戻しても同じである。

**分離していないのは意図的である**（本番へ戻して使う前提のため）。
分離しておくと、戻したときに接続をやり直すことになる。

### 3-4. テンプレート（`gas-notifier/`）の整合

移設では**テンプレートを一切触っていない。** 貼り替えは不要。

ただし、移設より前の作業で**まだ貼り替えていない変更が残っている**場合がある。
[gas-deployment-log.md](./gas-deployment-log.md) の履歴と、
`git log --oneline notifier-v2-complete -- gas-notifier/` を突き合わせて確かめること。

### 3-5. 実機検証の再開位置

A節は完走済み。**B節から再開する。**
手順は [notifier-v2-test-run.md](./notifier-v2-test-run.md)。

戻したあとに追加で確かめること（移設が壊していないかの確認）:

| 見るもの | 期待 |
| --- | --- |
| 本番の録音アプリに通知パネルが出る | `vr-notifier-panel` が hidden を外して表示される |
| `/production-app/voice-recorder/sw.js` | 200・`text/javascript` |
| `/production-app/voice-recorder/manifest.webmanifest` | 200・`application/manifest+json`・`scope` が `/production-app/voice-recorder/` |
| テスト環境（`/apps/`）に通知が残っていない | 二重に動かない（`sw.js` のスコープ衝突を避ける） |

---

## 4. 判断が要った2点（2026-08-11 に確定）

| # | 対象 | 決定 | 戻すときにすること |
| --- | --- | --- | --- |
| 1 | 本番 `index.html` の CSP `connect-src` の `notifier-gate` | **除去** | **足し直す**（下記） |
| 2 | 本番 `app.js` の `?eventId=` 引き継ぎ（`next` の元画面復帰） | **残置** | `notifier-panel.js` の export へ戻す（§2 の 7） |

**1 を除去した理由**: 通知の無い画面にゲートへの通信許可を残す理由が無い。
攻撃面が増えるわけではないが、**必要が無い許可を残すと「なぜ在るのか」が
読めなくなる。**

**2 を残した理由**: `?eventId=` の引き継ぎは認証系の汎用機構であり、
通知とは独立に効いている。移設の巻き添えで消さないよう
`currentEventIdFromUrl` を `app.js` に内製化し、挙動を変えていない。

### 戻すときに CSP へ足す1行

`public/production-app/voice-recorder/index.html` の `connect-src` へ、
次のオリジンを**1つだけ**足す。

```
https://notifier-gate.potenitas-lp.workers.dev
```

> **`*.workers.dev` にはしない。** workers.dev は誰でも使える共有ドメインで、
> ワイルドカードにすると**他人の Worker まで許可する**ことになる。
> `script-src` にも足さない（呼ぶのは fetch だけである）。

足し忘れると、通知の接続テストが CSP でブロックされる。
`tests/unit/voice-recorder-notifier.mjs` は現在**「外れていること」**を
見張っているので、戻すときはその節も裏返すこと。

---

## 5. 運用系の棚卸し（移設中どうするか）

**2026-08-11 に確定した。** 以下は決定であり、提案ではない。

| 対象 | 提案 | 理由 |
| --- | --- | --- |
| **`notifier-gate`（Workers）** | **稼働継続（確定）** | 呼び出しが無ければ費用は発生しない（Workers は要求課金）。止めると `wrangler deploy` のやり直しとシークレット3件の再登録が要り、**戻すときの手間のほうが大きい。** 外部利用者はゼロなので、開いていることによる実害も無い |
| **KV（`LICENSE_CACHE`）** | **そのまま** | 記録は1件。無料枠内。消すと復帰時に再照会が走るだけで害は無いが、消す利益も無い |
| **VAPID の鍵（シークレット）** | **絶対に触らない** | 差し替えると**全端末の購読が無効**になる。移設中に触る理由が無い |
| **検証用コピーの毎分トリガー** | **停止（確定）** | 通知先が無いのに毎分カレンダーを読み、5分ごとにゲートを叩き続ける。加えて**先送り中も実予定の通知が届き続け、検証者の混乱のもとになる。** 止め方は §5-1 |
| **テンプレート（配布用 v2）** | **現状維持（確定）** | 共有リンクを配っていない以上、置いてあること自体に実害は無い。消すと R-23 の記録と突き合わせられなくなる |
| **V1 のテンプレート** | **廃止してよい**（宿題 R-24） | 移設とは独立。V1 は外部配布ゼロで、残す理由が無い |
| **`gas-auth` の `Notifier.gs`** | **そのまま** | 認証系のデプロイに同居しており、外すと**認証系そのものの貼り替え**が要る。呼ばれなければ何もしない |

### 5-1. 毎分トリガーの止め方（1行）

> 通知用シートを開き、**拡張機能 → Apps Script → 左の時計アイコン（トリガー）→
> `tick` の行の「⋮」→「トリガーを削除」。**

戻すときは、シートのメニュー「録音通知」→「セットアップを開く」→
［セットアップを実行］で作り直される（**既存の接続キーや鍵は作り直されない**——
`ensureEidHmacKey_` は既にあれば触らないため、送信済みの記録と突き合う）。

> **止めても届いてしまう通知が1件だけある。** 停止の時点で
> `notify_queue` に入っていて、まだ送っていない予定である。
> 気になる場合は、トリガーを消したあとに `notify_queue` の行を消す。

### 費用のまとめ

**移設中に発生し続ける費用は無い。** Workers も KV も無料枠内で、
呼び出しが止まればそのぶん減る。止める価値があるのは
**検証用コピーの毎分トリガー**だけで、これは費用ではなく
Apps Script の実行枠（1日あたりの上限）の話である。

---

## 6. 戻す作業の見積もり

| 作業 | 所要 | 誰が |
| --- | --- | --- |
| §1-A（タグから戻す）＋ `npm test` | 10分 | 開発 |
| `npm run deploy` | 5分 | 運用 |
| 検証用コピーのトリガーを作り直す | 2分 | 運用 |
| 本番画面の目視（通知パネル・`sw.js`・manifest） | 5分 | 運用 |
| 端末の購読を取り直す（［接続テスト］1回） | 1分 | 利用者 |
| 実機 B節から再開 | 90分 | 運用 |

**戻すこと自体は30分ほどで終わる。** 残りは検証の時間である。

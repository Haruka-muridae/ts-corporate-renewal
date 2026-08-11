# notifier-gate

カレンダー通知 V2 のライセンスゲート兼判定サーバー（Cloudflare Workers）。

公開先: `https://notifier-gate.potenitas-lp.workers.dev`

---

## 1. 役割と境界

V1（2026-08 に本番稼働）は、利用者の Apps Script が鍵生成・判定・署名・送信の
すべてを持っていた。テンプレートをコピーした人は、解約後も通知を受け取り続けられる。

V2 では次の2つを運営側へ移した。**テンプレートを改造しても迂回できない位置**に
置くことが目的である。

| 移したもの | なぜここでなければならないか |
| --- | --- |
| 判定（何を通知するか） | 製品の頭脳。利用者のシートにあると読める・変えられる |
| VAPID JWT の発行 | 署名が無ければ push を送れない。判定だけ止めても自前判定で送れてしまう |

移していないもの（＝利用者の Apps Script に残るもの）:

- Google カレンダーの読み取り（Advanced Calendar Service）
- 予定名・説明・参加者の保持（利用者自身のスプレッドシートのみ）
- Push の送信そのもの（購読を持っているのは利用者側）

### 運営が受け取らないもの

**予定名・説明・参加者・メールアドレス・カレンダー ID は、このサーバーへ届かない。**
これは「送らないよう気をつける」ではなく、[src/evaluate.mjs](src/evaluate.mjs) の
`validateEvents` が**許可した項目以外を含む要求を拒否する**ことで守っている
（要件 DR-03/04）。許可されている項目は
[src/constants.mjs](src/constants.mjs) の `ALLOWED_EVENT_FIELDS`。

予定 ID そのものも届かない。利用者の GAS が端末ごとの秘密鍵で HMAC-SHA256 に
かけた `eid` を送り、ハッシュ → 実際の予定の対応表は利用者のシートだけが持つ。

---

## 2. エンドポイント

すべて JSON。成功は `{ ok: true, ... }`、失敗は `{ ok: false, error: { code, message } }`。

| path | method | 呼び出し元 | 用途 |
| --- | --- | --- | --- |
| `/v1/health` | GET / POST | 録音アプリ | 疎通確認。返すのは版だけ |
| `/v1/evaluate` | POST | 利用者の GAS（5分ごと） | 通知対象の判定 |
| `/v1/vapid` | POST | 利用者の GAS（12時間ごと） | 公開鍵と VAPID JWT の発行 |
| `/v1/test-notify` | POST | 利用者の GAS | テスト通知の許可判定 |

### `/v1/evaluate`

```jsonc
// 入力
{
  "licenseKey": "…",
  "deviceLabel": "任意",                      // 省略可
  "settings": {
    "accepted": true, "tentative": true,
    "needsAction": true, "declined": false,
    "timedOnly": true, "timingMin": 5
  },
  "events": [
    {
      "eid": "HMACのハッシュ",
      "feature": "calendar",                  // 省略時 "calendar"
      "startAt": "2026-08-10T10:00:00.000Z",
      "status": "accepted",                   // 自分の出欠。不参加者は ""
      "allDay": false,
      "cancelled": false,
      "timingMin": 30                         // 省略可（カレンダー以外の機能向け）
    }
  ],
  "sentDigest": [
    { "eid": "…", "feature": "calendar", "timing": 5, "startAt": "2026-08-10T10:00:00.000Z" }
  ]
}

// 出力
{
  "ok": true,
  "notify": [
    { "eid": "…", "feature": "calendar", "timing": 5,
      "startAt": "…", "notifyAt": "2026-08-10T09:55:00.000Z" }
  ],
  "remove": ["…"],
  "licenseState": "active"
}
```

`notify` は**これから出す通知**の一覧、`remove` は**キューから消すもの**の一覧
（削除された・出欠が変わった・設定で外れた・すでに送った、のいずれか）。
GAS 側はこの2つで `notify_queue` を同期するだけでよい。

### `/v1/vapid`

```jsonc
// 入力
{ "licenseKey": "…", "audiences": ["https://fcm.googleapis.com"] }

// 出力
{ "ok": true, "publicKey": "…", "jwts": { "https://fcm.googleapis.com": "…" },
  "expiresAt": "…", "licenseState": "active" }
```

`audiences` は push サービスの origin に限る（[src/constants.mjs](src/constants.mjs) の
`DEFAULT_PUSH_HOSTS`）。任意の相手への署名を配らないための制限。

### レート制限（`RATE_LIMITS`）

| エンドポイント | 上限 | 想定する呼び出し |
| --- | --- | --- |
| `/v1/evaluate` | 1分2回 | 同期は5分に1回 |
| `/v1/vapid` | 1時間20回 | JWT は12時間キャッシュ。定常状態では1日1〜2回 |
| `/v1/test-notify` | 1日1回 | 利用者がボタンを押したとき |

上限に当たると **429** を返す。本文とヘッダの両方に「窓が明けるまでの秒数」を載せる。

```jsonc
// 429 の本文
{ "ok": false, "error": { "code": "RATE_LIMITED", "message": "…" }, "retryAfterSec": 1800 }
```

```
Retry-After: 1800
```

呼び出し側（[gas-notifier/Gate.gs](../../gas-notifier/Gate.gs)）はこの秒数のあいだ
**呼ぶのをやめる。** 返さないと当てずっぽうで再試行され、その再試行がまた断られる。

> **`wrangler tail` の "Ok" は 200 という意味ではない。** 例外が出なかったという
> 意味であり、**429 も 402 も "Ok" と表示される。** 実機で「ゲート側は成功している
> のに利用者側は失敗し続ける」という読み違いを起こした（2026-08-11）。
> 状態コードを見るには `--status` を使うか、利用者側の `lastGateError` を読む。

`RATE_LIMITS` を変えるときの見方は
[docs/notifier-design-notes.md](../../docs/notifier-design-notes.md) §10-3。
**上限だけを決めて、失敗したときの振る舞いを決めないと事故になる。**

---

## 3. 判定ロジック

順序は要件書 §6 のとおりに固定してある。入れ替えると、削除済みの終日予定が
「終日だから除外」で止まってキューに残る。

1. 削除済み（`cancelled: true`）→ `remove`
2. 終日予定 → 「時間指定のみ」が ON なら `remove`
3. 自分の出欠が取れない（`status: ""`）→ `remove`
4. その出欠が設定で OFF → `remove`

### リスケされたときの再通知（宿題 B-05 の解決）

重複判定のキーは `feature + eid + timing + 開始時刻` とする。ただし
**開始時刻の差が5分未満なら「送信済み」を引き継ぎ、再通知しない。**
主催者が1〜2分ずらすたびに通知が連発するのを避けるため。

比較の相手は常に `sentDigest` に載っている**送信時点の開始時刻**であり、
前回の同期で見た値ではない。4分ずらしを2回繰り返した場合は元から8分動いて
いるので再通知される。閾値は [src/constants.mjs](src/constants.mjs) の
`RENOTIFY_THRESHOLD_MS`。

### 機能横断の設計

`feature` はカレンダー以外の通知（例: 提出期限のリマインド）を同じ Push 基盤へ
載せるための入口。`FEATURE_RULES` に登録されていない `feature` は通さない
（判定を運営側に置くのが V2 の目的なので、テンプレート側が勝手に名乗れる形にしない）。

---

## 4. VAPID 鍵

### 生成と、登録前の確認

```powershell
# 1) 作る
node workers/notifier-gate/scripts/generate-vapid-keys.mjs

# 2) 登録する前に確かめる（1行目に秘密鍵、2行目に公開鍵を貼る）
#    入力を終えるには Ctrl+Z → Enter（PowerShell）
node workers/notifier-gate/scripts/check-vapid-keys.mjs
```

**2 を飛ばさないこと。** `wrangler secret put` で登録した値は
**あとから読み返せない。** 貼り付けを誤っても気づけるのは
「本番で 500 が出たとき」になる。実機でそうなった（2026-08-11）。

確認スクリプトは Worker と**同じコード**（`src/vapid.mjs`）で読み込みと署名を行い、
さらに公開鍵で署名を検証する。通れば、その2つは形式が正しく、
かつ**互いに対になっている**ことが確定する。次の事故はいずれもここで止まる。

| 事故 | 出る内容 |
| --- | --- |
| 見出し行ごと貼った | `base64 以外の文字が混ざっています` |
| 途中で切れた | `短すぎます（N バイト）` |
| 秘密鍵と公開鍵を逆に貼った | `PKCS#8 として取り込めませんでした` |
| 別々に生成した値を混ぜた | `対になっていません` |

**鍵を引数で渡さない。** シェルの履歴とプロセス一覧に残るため、
標準入力から読む作りにしてある。出力にも鍵は出ない。

出力された2つの値を、そのまま `wrangler secret put` へ貼る。
**ファイルへ保存しないこと。リポジトリへは絶対に入れない。**

### 形式（生成側と読み込み側の対応）

| 値 | 形式 | 生成 | 読み込み |
| --- | --- | --- | --- |
| `VAPID_PRIVATE_KEY` | PKCS#8 の DER を **base64** | `exportKey('pkcs8')` → `toString('base64')` | `importKey('pkcs8', …)`。PEM・base64url・JWK も受ける |
| `VAPID_PUBLIC_KEY` | 非圧縮の生の点（65バイト）を **base64url** | `exportKey('raw')` → `toString('base64url')` | そのまま返す。素の base64 で登録されていても base64url へ直す |

公開鍵が base64url なのは、ブラウザの `applicationServerKey` がその形しか
受け取らないため。`exportKey('raw')` はまさにこの65バイトを返すので、
openssl で DER の中身を切り出す作業が要らない。

署名は WebCrypto（`crypto.subtle`）の ECDSA / P-256 で行う。この API は
JWS がそのまま要求する `r||s` の64バイトを返すため、V1 で使っていた
jsrsasign（利用者に手で貼らせていた約500KB）は不要になった。

### ローテーション

**鍵はサービス全体で1ペア**であり、差し替えると
**全利用者の Push 購読が無効になる。** ブラウザの購読は
`applicationServerKey` に紐づいており、鍵が変われば既存の購読では届かない。

したがってローテーションは次の順で行うこと。

1. 事前に利用者へ告知する（「録音アプリで通知を登録し直す作業が要る」）
2. 新しい鍵を作り、**`check-vapid-keys.mjs` で確認してから**登録する
3. `npm run deploy:notifier-gate` で反映する
4. 利用者は録音アプリの設定画面から通知を登録し直す
5. 古い購読は push 送信時に 404 / 410 を返すので、GAS 側が自然に消す

鍵が漏れた場合は上を即座に行う。漏れた鍵でできるのは
「この鍵で登録された購読へ push を送ること」であり、予定の中身は読めない。

### 貼り直しだけを行う場合（鍵は変えない）

登録に失敗した疑いがあるときは、**同じ鍵をもう一度登録し直す**だけでよい。
値が同じであれば `applicationServerKey` は変わらないので、
**購読への影響は無い**（利用者の再登録は要らない）。

```powershell
node workers/notifier-gate/scripts/check-vapid-keys.mjs   # 手元の控えを確認
npx wrangler secret put VAPID_PRIVATE_KEY --config workers/notifier-gate/wrangler.jsonc
npx wrangler secret put VAPID_PUBLIC_KEY  --config workers/notifier-gate/wrangler.jsonc
npm run deploy:notifier-gate
```

手元に控えが無い場合は、鍵を作り直すことになる（＝上のローテーション手順）。
**登録済みの値は読み返せない。**

---

## 5. デプロイ手順（運用者が行う）

前提: `wrangler` はリポジトリの devDependencies に入っている。追加インストールは不要。

1. **KV namespace を作る**

   ```powershell
   npx wrangler kv namespace create LICENSE_CACHE --config workers/notifier-gate/wrangler.jsonc
   ```

   出力された id を [wrangler.jsonc](wrangler.jsonc) の `TODO_KV_NAMESPACE_ID` へ貼る。

2. **シークレットを登録する**（3つ）

   ```powershell
   node workers/notifier-gate/scripts/generate-vapid-keys.mjs
   npx wrangler secret put VAPID_PRIVATE_KEY     --config workers/notifier-gate/wrangler.jsonc
   npx wrangler secret put VAPID_PUBLIC_KEY      --config workers/notifier-gate/wrangler.jsonc
   npx wrangler secret put AUTH_GAS_SHARED_SECRET --config workers/notifier-gate/wrangler.jsonc
   ```

   `AUTH_GAS_SHARED_SECRET` は認証系 GAS のスクリプトプロパティへ同じ値を入れる
   （gas-auth 側の手順は docs/gas-deployment-log.md）。

3. **deploy する**

   ```powershell
   npm run deploy:notifier-gate
   ```

   `npm run deploy`（サイト本体）はこの Worker を更新しない。逆も同じ。

   DNS もゾーンの設定も要らない。公開先は workers.dev の既定ドメインで、
   `https://<サービス名>.<アカウントのサブドメイン>.workers.dev` になる。
   **deploy 後、出力されたURLが
   `https://notifier-gate.potenitas-lp.workers.dev` と一致することを確認すること。**
   違っていた場合はアカウントのサブドメインが想定と違うので、
   [origin.mjs](origin.mjs) を直してテストを通してから作業を続ける。

4. **疎通を見る**

   ```powershell
   curl https://notifier-gate.potenitas-lp.workers.dev/v1/health
   ```

5. **録音アプリの CSP を変更する**（§9 の変更案。**承認を得てから**行う）

---

## 6. ライセンスの状態

| state | いつ | evaluate | vapid |
| --- | --- | --- | --- |
| `active` | 認証系が「有効」と答えた | 判定を返す | 発行する |
| `grace` | 認証系へ届かない（直前まで有効だった場合のみ） | 判定を返す | 発行する |
| `expired` | 認証系が「無効」と答えた／猶予切れ／未検証 | 空を返す | 発行しない（402） |

- 判定結果は KV に**6時間**キャッシュする。したがって
  **解約が通知の停止に反映されるまで最長6時間**かかる。
  この値は利用者向けの手順書にも書いてあるので、変えるなら両方直すこと。
- 猶予（`grace`）は「一度は有効と確認できたキー」にだけ与える。
  初めて見るキーは認証系へ届かない限り通さない（fail closed）。

### 猶予の起点は「最後に active を確認できた時刻」

**「最初に照会へ失敗した時刻」から数えてはいけない。** KV は結果整合であり、
猶予レコードが全 colo へ行き渡るまでの間、まだ古い（照会成功時の）レコードを
読む colo が現れる。そこが「今から猶予開始」と書き直すと、書き込みは後勝ちなので
**打ち切り時刻が後ろへずれ続け、不通が長引くほど失効しなくなる。**

そこで猶予は、照会が成功した一度きりの事実である `activeConfirmedAt` から数える。
どの colo も読んだ値をそのまま写すだけなので、期限は決定的になる。反映待ちで
古いレコードを読んだ場合、起点は**より過去**になる＝安全側へ倒れる。

打ち切りは `activeConfirmedAt + 6時間（キャッシュ）+ 72時間（猶予）`
（[src/constants.mjs](src/constants.mjs) の `LICENSE_CONTINUATION_MAX_MS`）。
キャッシュが効いている6時間は照会自体を行わないため、これを足さないと
猶予が実質66時間になる。

---

## 7. テスト

```powershell
node tests/run.mjs notifier-gate
```

判定・ライセンス状態遷移・VAPID 署名・匿名化の検査を Node 上で実行する
（Workers ランタイムも Chrome も不要）。`src/*.mjs` は Workers 固有の API を
使っていないため、テストから直接 import できる。

公開オリジンが4か所でずれていないことも、このスイートが見ている（§8）。

### 本番で失敗したときの読み方

```powershell
npx wrangler tail notifier-gate --format pretty
```

失敗すると1行だけ出る。**応答には内部情報を返さないが、ログには出す**
（読む相手が違うため。`src/diagnostics.mjs` の冒頭）。

```
notifier-gate error: /v1/vapid phase=import-key name=DataError message=…
```

| `phase` | 落ちた場所 | まず見るもの |
| --- | --- | --- |
| `hash-license` | ライセンスキーの取り扱い | 要求の形 |
| `rate-limit` | KV の読み書き | KV バインディングの id |
| `license-verify` | 認証系 GAS への照会 | `AUTH_GAS_URL` と共有シークレット（§5 の R-10b） |
| `import-key` | **VAPID 秘密鍵の読み込み** | `check-vapid-keys.mjs` で手元の控えを確認 |
| `sign` | ES256 署名 | 同上（鍵は読めたが署名に失敗＝稀） |
| `unknown` | 上記以外 | `name` と `message` |

**鍵・共有シークレット・ライセンスキーはログに出ない。**
例外メッセージへ混ざっていても、書き出す直前に伏せている（テストで固定）。

---

## 8. 公開オリジンの管理と、独自ドメインへの移行

### いまの公開先と、その決め方

```
https://notifier-gate.potenitas-lp.workers.dev
```

当初は独自ドメインのサブドメイン（`api.potenitas.com`）を充てる案だったが、
ゾーンの追加を待たずに出せることを優先し、workers.dev の既定ドメインにした
（2026-08-10 決定）。

### 正本は1か所

このURLは4つの場所に現れる。別の実行環境にあるため、import で1つの値を
共有することはできない（GAS は ES モジュールを読めず、CSP は HTML の属性である）。

そこで **「正本を1つ決め、ずれたらテストが落ちる」** 形にしてある。
正本は [origin.mjs](origin.mjs) の `NOTIFIER_GATE_ORIGIN` で、
参照する場所は同ファイルの `GATE_ORIGIN_FILES` に列挙されている。
`node tests/run.mjs notifier-gate` が一致を検査するので、
**どこか1か所だけ書き換えるとテストが落ちる。**

参照する場所を増やしたときは `GATE_ORIGIN_FILES` にも足すこと。

### 独自ドメインへ移すとき（将来）

**workers.dev の既定ドメインは、Custom Domain を後から足しても
無効にならず、並行して有効なまま**である。したがって移行は次の順で行える。

1. Cloudflare にゾーンを追加し、`wrangler.jsonc` に
   `routes: [{ pattern: "…", custom_domain: true }]` を足して deploy する
   （`workers_dev` は残しておく）
2. [origin.mjs](origin.mjs) の値を新URLへ変え、テストの指示に従って4か所を揃える
3. 新しくセットアップする利用者から新URLを使う

**すでにセットアップを終えている利用者は、何もしなくてよい。**
古い workers.dev のURLが動き続けるため、テンプレートの貼り直しも
録音アプリの再設定も不要である。

移行後に workers.dev を止めたくなった場合だけ、`workers_dev: false` にする。
そのときは**先に全利用者の接続先を切り替える必要がある**（止めた瞬間に、
古いURLを持つテンプレートからの通知が全部止まる）。

---

## 9. 録音アプリの CSP 変更案（**未適用**）

録音アプリのフロントは `/v1/health` を直接叩くため、`connect-src` に
このオリジンを足す必要がある。**CSP の変更は影響が大きいため、
案を示して承認を得てから適用する**という取り決めに従い、まだ適用していない。

対象: [public/production-app/voice-recorder/index.html](../../public/production-app/voice-recorder/index.html)

```diff
- connect-src 'self' https://www.googleapis.com https://script.google.com https://script.googleusercontent.com;
+ connect-src 'self' https://www.googleapis.com https://script.google.com https://script.googleusercontent.com https://notifier-gate.potenitas-lp.workers.dev;
```

- 足すのは `connect-src` の1ディレクティブ **だけ**。
  `script-src` には足さない（このオリジンからスクリプトは読み込まない）
- ワイルドカード（`*.workers.dev`）にはしない。
  **他人の Worker まで許可することになる。** workers.dev は誰でも使える共有ドメインで、
  サブドメインの持ち主を Cloudflare のアカウント名でしか区別できない
- push の送信はサーバー側（GAS）が行うため、push サービスのオリジンは足さなくてよい

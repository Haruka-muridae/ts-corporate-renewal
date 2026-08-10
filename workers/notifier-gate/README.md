# notifier-gate

カレンダー通知 V2 のライセンスゲート兼判定サーバー（Cloudflare Workers）。

公開先: `https://api.potenitas.com`

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

### 生成

```powershell
node workers/notifier-gate/scripts/generate-vapid-keys.mjs
```

出力された2つの値を、そのまま `wrangler secret put` へ貼る。
**ファイルへ保存しないこと。リポジトリへは絶対に入れない。**

署名は WebCrypto（`crypto.subtle`）の ECDSA / P-256 で行う。この API は
JWS がそのまま要求する `r||s` の64バイトを返すため、V1 で使っていた
jsrsasign（利用者に手で貼らせていた約500KB）は不要になった。

### ローテーション

**鍵はサービス全体で1ペア**であり、差し替えると
**全利用者の Push 購読が無効になる。** ブラウザの購読は
`applicationServerKey` に紐づいており、鍵が変われば既存の購読では届かない。

したがってローテーションは次の順で行うこと。

1. 事前に利用者へ告知する（「録音アプリで通知を登録し直す作業が要る」）
2. 新しい鍵を `wrangler secret put` で登録し、deploy する
3. 利用者は録音アプリの設定画面から通知を登録し直す
4. 古い購読は push 送信時に 404 / 410 を返すので、GAS 側が自然に消す

鍵が漏れた場合は上を即座に行う。漏れた鍵でできるのは
「この鍵で登録された購読へ push を送ること」であり、予定の中身は読めない。

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

3. **`potenitas.com` のゾーンを Cloudflare へ追加する**

   ゾーンが未追加のまま deploy すると、`routes` の Custom Domain 作成で失敗する。
   ゾーン追加が済むまでは [wrangler.jsonc](wrangler.jsonc) の `routes` を
   一時的に外し、`notifier-gate.<account>.workers.dev` で動かしてもよい。
   その場合は録音アプリの CSP と GAS 側の接続先も暫定 URL にそろえること。

4. **deploy する**

   ```powershell
   npm run deploy:notifier-gate
   ```

   `npm run deploy`（サイト本体）はこの Worker を更新しない。逆も同じ。

5. **疎通を見る**

   ```powershell
   curl https://api.potenitas.com/v1/health
   ```

---

## 6. ライセンスの状態

| state | いつ | evaluate | vapid |
| --- | --- | --- | --- |
| `active` | 認証系が「有効」と答えた | 判定を返す | 発行する |
| `grace` | 認証系へ届かない（直前まで有効だった場合のみ・最大72時間） | 判定を返す | 発行する |
| `expired` | 認証系が「無効」と答えた／猶予切れ／未検証 | 空を返す | 発行しない（402） |

- 判定結果は KV に**6時間**キャッシュする。したがって
  **解約が通知の停止に反映されるまで最長6時間**かかる。
  この値は利用者向けの手順書にも書いてあるので、変えるなら両方直すこと。
- 猶予（`grace`）は「一度は有効と確認できたキー」にだけ与える。
  初めて見るキーは認証系へ届かない限り通さない（fail closed）。

---

## 7. テスト

```powershell
node tests/run.mjs notifier-gate
```

判定・ライセンス状態遷移・VAPID 署名・匿名化の検査を Node 上で実行する
（Workers ランタイムも Chrome も不要）。`src/*.mjs` は Workers 固有の API を
使っていないため、テストから直接 import できる。

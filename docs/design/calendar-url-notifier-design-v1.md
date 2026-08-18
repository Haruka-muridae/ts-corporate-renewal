# カレンダーURL通知アプリ 詳細設計書 v1.0

| 項目 | 内容 |
| --- | --- |
| アプリID | `calendar-url-notifier` |
| 実装 | `public/production-app/calendar-url-notifier/` ＋ `gas-notifier/`（配布テンプレート） ＋ `workers/notifier-gate/` |
| 上位文書 | [../specs/calendar-url-notifier-requirements-v1.md](../specs/calendar-url-notifier-requirements-v1.md) |
| 設計の経緯 | [../notifier-design-notes.md](../notifier-design-notes.md)／[../notifier-v2-design.md](../notifier-v2-design.md) |
| テスト | `tests/unit/notifier-gate.mjs` / `-license` / `-template` / `-connection`（＋ `voice-recorder-notifier`） |
| 規模 | 画面 約1,000行 ＋ Worker 約1,800行 ＋ GAS テンプレート |
| 作成日 | 2026年8月18日 |

**11本のうち、このアプリだけがサーバー側の実装を持つ。**
しかも3か所（ブラウザ・利用者の Apps Script・運営の Cloudflare Worker）に分かれている。
どこに何を置くかの判断が、この設計の全体である。

---

## §1 責務と境界

### 1-1. 3つの実行場所

| 場所 | 実体 | 役割 |
| --- | --- | --- |
| ブラウザ | `public/production-app/calendar-url-notifier/` | 設定画面・Push 登録・**通知の表示（Service Worker）** |
| 利用者の Apps Script | `gas-notifier/`（配布テンプレート） | カレンダーの読み取り・予定の骨格の抽出・URL の解決 |
| 運営の Cloudflare Worker | `workers/notifier-gate/` | **ライセンス検証・通知要否の判定・VAPID 署名** |

### 1-2. 引き受けないこと（運営側が受け取らないもの）

`notifier-gate` が受け取ってよいのは、ライセンスキー、設定（出欠フィルタと
通知タイミング）、**予定の骨格**（ハッシュ化済み ID・開始時刻・出欠・終日・削除済み）だけ。

**予定名・説明・参加者・メールアドレス・カレンダーID は受け取らない。**
これは「送らないよう気をつける」ではなく、
**`evaluate.mjs` の `validateEvents` が許可した項目以外を含む要求を拒否する**
ことで守っている（要件 DR-03/04）。`ALLOWED_EVENT_FIELDS` に無いキーが
**1つでもあれば要求ごと拒否**する。

### 1-3. 隣との関係

| 相手 | 関係 |
| --- | --- |
| `public/apps/voice-recorder/sw.js` | Service Worker の**複製元**。import しない |
| `voice-recorder` | 通知から `?eventId=` 付きで開く導線があった（現在は使われていない） |
| サイト配信の Worker | **別サービス。** ルートの `wrangler.jsonc` は tsam-ai.com（OpenNext）のもので、こちらは `workers/notifier-gate/wrangler.jsonc` を使う |

---

## §2 モジュール構成

### 2-1. ブラウザ側

| ファイル | 責務 | 行数 |
| --- | --- | --- |
| `app.js` | 画面。引き継ぎリンクの受け取り・Push 登録・設定保存・テスト通知 | 407 |
| `sw.js` | **通知を出す**（旧式＝クラシックの Service Worker） | 325 |
| `index.html` / `style.css` | 画面 | — |

### 2-2. `notifier-gate`（Cloudflare Worker）

| ファイル | 責務 | 行数 |
| --- | --- | --- |
| `index.mjs` | 入口・ルーティング | 338 |
| `evaluate.mjs` | **通知要否の判定（純関数のみ）** | 395 |
| `license.mjs` | ライセンス検証とキャッシュ | 324 |
| `vapid.mjs` | VAPID の JWT 発行（ES256 / WebCrypto） | 264 |
| `constants.mjs` | 定数（`FEATURE_RULES` / `ALLOWED_EVENT_FIELDS` ほか） | 229 |
| `diagnostics.mjs` | 失敗時の記録（運用者だけが読める形） | 121 |
| `http.mjs` | 応答の形と CORS | 84 |
| `ratelimit.mjs` | レート制限（KV の固定窓カウンタ） | 67 |

---

## §3 状態とデータ構造

### 3-1. ブラウザ側

**IndexedDB**（`localStorage` ではない）。

| 名前 | 値 |
| --- | --- |
| DB | `tsam-curl-notifier` |
| バージョン | 1 |
| ストア | `config` |
| キー | `connection` |

`app.js` と `sw.js` が**同じ定義を別々に持っている。**
`sw.js` は旧式のワーカーで `import` できないため、**写しである。片方だけ変えない。**
（`type: 'module'` にすると未対応ブラウザで登録そのものが失敗する。）

ほかに `localStorage` のキー `tsam-curl-notifier` / `tsam-curl-notifier-fallback` がある。

### 3-2. Worker 側

- ライセンスの検証結果はキャッシュする（毎回問い合わせない）
- **VAPID の秘密鍵は isolate が使い回される間 `importKey` をやり直さない。**
  そのとき**シークレットの文字列も一緒に覚える**（鍵だけ覚えると、
  シークレットが差し替わったことに気づけない）
- レート制限は KV の固定窓カウンタ。**厳密さより「暴走を止めること」を優先**している
  （KV は結果整合で、`read → write` の間に別リージョンからの要求が入りうる）

---

## §4 主要フロー

### 4-1. 導入（引き継ぎリンク）

利用者は配布テンプレート（`gas-notifier/`）を自分の Apps Script へ入れる。
セットアップが終わると `#setup=` 付きのリンクが出る。
`app.js` はそこから接続先を受け取り、IndexedDB へ保存する。

**接続情報を URL のクエリではなくフラグメント（`#`）で渡す。**
フラグメントはサーバーへ送られない。

### 4-2. 通知の判定（`evaluate.mjs`）

判定は**純関数のみ**で構成され、**順序は上位文書 §6 のとおりに固定**されている。
V1 では `gas-notifier/CalendarSync.gs` にあったものを Worker へ移した。

`FEATURE_RULES` が機能ごとの適用可否を持つ。

| 機能 | 出欠フィルタ | 終日フィルタ |
| --- | --- | --- |
| `calendar` | 適用 | 適用 |
| `openurl` | 適用 | 適用 |

### 4-3. VAPID 署名（`vapid.mjs`）

V1 では Apps Script 上で署名していたが、**Apps Script に ES256 が無く**、
外部ライブラリ（jsrsasign）を足していた。

Workers には WebCrypto があり、`crypto.subtle.sign` の ECDSA / P-256 は
JWS がそのまま要求する `r||s` の64バイトを返す。
**外部ライブラリを1つも足さずに済む**ため、2026-08-10 に jsrsasign を廃止した
（[../external-dependency-approvals.md](../external-dependency-approvals.md) §1-4）。

### 4-4. 通知の表示（`sw.js`）

録音アプリの Service Worker との違いは**行き先の決め方だけ**である。

| アプリ | 行き先 |
| --- | --- |
| 録音アプリ | 固定の画面へ `?eventId=` 付きで飛ぶ |
| このアプリ | **予定ごとの URL**（GAS が解決したもの）を開く |

### 4-5. 失敗時の記録（`diagnostics.mjs`）

当初は `notifier-gate error: <path>` の1行しか出していなかったが、**それでは足りなかった。**
現在は運用者だけが読める形で、どの段階（`inPhase`）で何が起きたかを残す。
`collectSecrets` はシークレットの取り違えを検出するためにある。

---

## §5 外部インターフェース

| 相手 | 方向 | 内容 |
| --- | --- | --- |
| ブラウザ → `notifier-gate` | POST | Push 購読の登録、設定 |
| 利用者の GAS → `notifier-gate` | POST | 予定の骨格 → 判定結果 |
| `notifier-gate` → Push サービス | POST | VAPID 署名付きの通知（`DEFAULT_PUSH_HOSTS`） |
| ブラウザ ← Push サービス | push イベント | `sw.js` が通知を出す |

応答の形は `gas-notifier` / `gas-auth` と揃えてある。

```
成功: { ok: true,  ... }
失敗: { ok: false, error: { code, message } }
```

要求本文は `MAX_BODY_BYTES`（256KB）を超えたら読まない
（`gas-auth/Main.gs` の `parsePostBody_` と同じ考え）。

---

## §6 エラー設計

`http.mjs` の `ERRORS` / `fail()` / `ok()` に集約。
CORS も同じファイルが持つ。

**利用者に見える文言と、運用者だけが読む記録を分けている**（§4-5）。

---

## §7 移植（他プロダクトへの組み込み）

### 7-1. 移植単位

| 単位 | ファイル | 依存 | 単独で持ち出せるか |
| --- | --- | --- | --- |
| **VAPID 署名（外部ライブラリ無し）** | `vapid.mjs` | WebCrypto | **可。Web Push を自前で送る実装として、そのまま使える** |
| **許可リスト方式の入力検証** | `evaluate.mjs` の `validateEvents` ＋ `constants.mjs` の `ALLOWED_EVENT_FIELDS` | なし | **可。「送られても受け取らない」を実装で担保する型** |
| 判定ロジック | `evaluate.mjs`（純関数） | `constants.mjs` | 可 |
| ライセンス検証＋キャッシュ | `license.mjs` | KV | 可 |
| KV 固定窓レート制限 | `ratelimit.mjs` | KV | 可 |
| 通知の受け口 | `sw.js` | なし | 可（**旧式ワーカーである点に注意**） |
| 引き継ぎリンクの受け取り | `app.js` の `#setup=` 処理 | IndexedDB | 可 |

### 7-2. 置換点

1. **`wrangler.jsonc`。** サービス名・KV バインディング・シークレット
2. **VAPID 鍵。** `scripts/generate-vapid-keys.mjs` で生成する。**リポジトリへ置かない**
3. `constants.mjs` の `FEATURE_RULES` / `ALLOWED_EVENT_FIELDS` / `MAX_EVENTS` /
   `RATE_LIMITS` / `DEFAULT_PUSH_HOSTS`
4. **IndexedDB の DB 名・ストア名・キー。`app.js` と `sw.js` の両方**（§3-1）
5. `gas-notifier/` 側のテンプレート（配布物なので、移植先の運用に合わせる）
6. `public/auth/` への依存（`guardPage()`）

### 7-3. 前提

- **Push 通知が使えるブラウザ**であること
- Service Worker を**旧式で**登録すること（`type: 'module'` は登録自体が失敗しうる）
- Cloudflare Workers と KV（またはそれに相当するもの）
- 利用者が自分の Apps Script を持てること（カレンダー読み取りのため）

### 7-4. 持ち出してはいけないもの

- **`ALLOWED_EVENT_FIELDS` を緩めた版。** V2 の売りそのものが失われる
- `sw.js` を `type: 'module'` にした版
- VAPID の秘密鍵（当然だが、生成物を含めない）
- `app.js` と `sw.js` の定義を片方だけ写したもの

---

## §8 テスト設計

| スイート | 範囲 |
| --- | --- |
| `notifier-gate` | 判定（`evaluate.mjs`）・入力検証・拒否 |
| `notifier-license` | ライセンス検証とキャッシュ |
| `notifier-template` | 配布テンプレート（`gas-notifier/`）の整合 |
| `notifier-connection` | 接続情報の受け取り・保存 |
| `voice-recorder-notifier` | 通知から録音アプリを開く導線 |

判定が**純関数**であることが、実通信なしでの検証を可能にしている。

---

## §9 設定値と環境依存

| 定数 | 場所 | 意味 |
| --- | --- | --- |
| `GATE_VERSION` | `constants.mjs` | ゲートの版 |
| `DEFAULT_PUSH_HOSTS` | 同上 | Push サービスの許可先 |
| `LICENSE_STATE` | 同上 | ライセンスの状態 |
| `MAX_EVENTS` / `RATE_LIMITS` | 同上 | 暴走の歯止め |
| `FEATURE_RULES` | 同上 | 機能ごとのフィルタ適用 |
| `ALLOWED_EVENT_FIELDS` | 同上 | **受け取ってよい項目の許可リスト** |
| `MAX_BODY_BYTES` | `index.mjs` | 256KB |
| `DB_NAME` / `STORE_NAME` / `CONNECTION_KEY` | `app.js` ＋ `sw.js` | **2か所に同じ定義** |

VAPID の鍵とライセンスの検証先は Workers のシークレットで持つ。**コードに書かない。**

---

## §10 既知の制約・未解決

1. **同じ定義が `app.js` と `sw.js` に二重にある**（§3-1）。
   旧式ワーカーの制約による意図的な重複だが、片方だけ変えると壊れる
2. **通知機能は本番のポータルに出ていない時期がある。**
   録音アプリ側の `?eventId=` 導線は現在使われておらず、
   残す／消すの判断が保留されている（[../notifier-v2-resume.md](../notifier-v2-resume.md)）
3. **KV のレート制限は厳密ではない**（結果整合。§3-2）。暴走を止める目的に絞っている
4. **配布テンプレートの更新は利用者の操作に依存する。**
   `gas-notifier/` を直しても、利用者が自分の Apps Script を更新しなければ反映されない

---

## §11 設計判断の記録

| 判断 | 採らなかった案 | 理由 |
| --- | --- | --- |
| 判定を Worker へ移す（V2） | 利用者の Apps Script で完結（V1） | ライセンス検証ができない。テンプレートは配ったら手が届かない |
| **予定の中身を受け取らない** | 予定名も送って判定を賢くする | 運営が個人情報を預からないことが V2 の売り |
| 許可リストで拒否する | 送信側で気をつける | 「気をつける」は担保にならない |
| VAPID を WebCrypto で署名 | jsrsasign を使い続ける | Workers には ES256 がある。外部依存を1つ減らせた |
| Service Worker を旧式にする | `type: 'module'` | 未対応ブラウザで登録そのものが失敗する |
| 接続情報を `#` で渡す | クエリで渡す | フラグメントはサーバーへ送られない |
| IndexedDB を使う | `localStorage` | Service Worker から同期 API を使えない |
| 失敗記録を厚くする | 1行の要約 | 実際に「1行では足りなかった」 |
| KV 固定窓で妥協する | 厳密なレート制限 | 結果整合の下で厳密さを求めるとコストが見合わない |

---

## §12 変更履歴

| 版 | 日付 | 内容 |
| --- | --- | --- |
| v1.0 | 2026-08-18 | 初版。実装（2026年8月時点）を記述 |

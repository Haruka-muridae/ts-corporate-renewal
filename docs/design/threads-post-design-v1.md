# Threads 投稿アプリ 詳細設計書 v1.0

| 項目 | 内容 |
| --- | --- |
| アプリID | `threads-post` |
| 実装 | `public/production-app/threads-post/` |
| 上位文書 | [../specs/threads-mvp-requirements-v1.md](../specs/threads-mvp-requirements-v1.md)（本書はその下位） |
| テスト | `tests/unit/threads-post.mjs`（`node tests/run.mjs threads-post`）／`tests/unit/threads-mvp.mjs` |
| 規模 | 約1,100行（HTML・CSS・JS 合計） |
| 作成日 | 2026年8月18日 |

本書は**実装がどう出来ているか**を記述する。**何を作るか**は上位文書が持つ。
重複させないため、要件の理由づけは §n で参照するにとどめる。

このアプリは、投稿系3本（`threads-post` / `x-post` / `note-post`）の**原型**である。
他2本の設計書は本書との差分として書かれている。

---

## §1 責務と境界

### 1-1. 引き受けること

- テーマ（最大100字）から Gemini で投稿文を生成する
- 投稿文を編集し、文字数（コードポイント）を数えて上限500字と突き合わせる
- 本文入りの Threads 作成画面を intent リンクで開く
- 下書きと履歴を**この端末のこのブラウザだけ**に保存する

### 1-2. 引き受けないこと

- **Threads への投稿そのもの。** 最後の「投稿」は利用者が Threads の画面で押す。
  Threads の API もアクセストークンも使わない（上位文書 §1.1 の方式選択）
- **投稿されたかどうかの観測。** intent 方式では確認できない。
  履歴に記録するのは「投稿画面を開いた」という事実まで（§3-3）
- **端末をまたいだ同期。** 当社サーバーへ何も送らないため、原理的にできない
- **APIキーの保管。** [../specs/keystore-spec-v1.md](../specs/keystore-spec-v1.md) の KeyStore が持つ

### 1-3. 隣との関係

| 相手 | 関係 |
| --- | --- |
| `public/auth/session.js` | `guardPage()` で未ログインを弾く。**このアプリの認証はすべてここに委ねる** |
| `public/auth/keystore.js` | Gemini APIキーを都度読む。アプリ側に保持しない |
| `public/auth/config.js` | `setScreenDepth(2)` で相対階層を宣言する |
| `x-post` / `note-post` | 複製先。共有はしない（[../repository-structure.md](../repository-structure.md) §4-1） |
| `gas-threads/` | 旧 GAS 版。**現在は保管のみで動いていない。** 生成プロンプトの
「事実を創作しない」指示だけがここへ引き継がれている |

---

## §2 モジュール構成

| ファイル | 責務 | 行数 | 依存先 |
| --- | --- | --- | --- |
| `index.html` | 画面の骨格、CSP の宣言、DOM の id | 128 | — |
| `style.css` | 見た目 | — | — |
| `config.js` | 静的設定（モデル・上限・保存キー・intent の URL） | 61 | なし |
| `post.js` | 検証・intent URL の組み立て・端末内保存 | 161 | `config.js` |
| `gemini.js` | Gemini 呼び出しとエラー分類 | 279 | `config.js` |
| `app.js` | DOM の付け外しだけ | 284 | 上3つ ＋ `public/auth/` の3モジュール |

依存の向きは一方向で、循環はない。

```
app.js ──→ post.js ──→ config.js
   │  └───→ gemini.js ─┘
   └──→ ../../auth/{session,config,keystore}.js
```

**`app.js` にロジックを置かない**という分け方が、そのままテスト容易性になっている
（§8）。`app.js` は DOM を触るためテストせず、`post.js` / `gemini.js` だけを
Node から直接読み込んで固定している。

---

## §3 状態とデータ構造

### 3-1. 保存先

`localStorage`、キーは `tsam-threads-post-v1`（`config.js` の `STORAGE_KEY`）。
**1キーに全状態を JSON で入れる。**

```json
{
  "drafts":  [{ "id": "…", "text": "…", "createdAt": 1755500000000 }],
  "history": [{ "id": "…", "at": 1755500000000, "kind": "投稿画面を開いた", "text": "…" }],
  "stylePrompt": "…"
}
```

- `id` は `crypto.randomUUID()`。使えない環境では `id-<時刻>-<乱数>` にフォールバックする
- `drafts` は無制限。`history` は `HISTORY_LIMIT`（100件）で古い順に捨てる
- 一覧は保存順の**逆順**（新しい順）で返す

### 3-2. 壊れたデータの扱い

`readState()` は `JSON.parse` の失敗と型不一致を**握りつぶして空の状態を返す。**
次の保存で作り直される。**利用者へエラーを出さない**のは、保存データが壊れていても
アプリの主目的（生成して投稿画面を開く）は達成できるためである。

### 3-3. 履歴の意味

`kind` に入るのは `'投稿画面を開いた'` という文字列で、**投稿の成否ではない**（§1-2）。
文言を変えると過去の履歴と混ざるため、変えるなら版（`-v1`）を上げる。

### 3-4. メモリだけに置くもの

- **Gemini APIキー。** `handleGenerate()` の中で `KeyStore.get()` から都度読み、
  ローカル変数のまま `generatePost()` へ渡す。モジュール変数に保持しない
- 編集中の本文（`<textarea>` の値）。保存操作をしない限り残らない

### 3-5. `localStorage` が使えないとき

`isStorageAvailable()` が起動時に1回だけ判定し、結果を `storageOk` に持つ。
**アプリは動く。保存だけが効かない**旨を画面（`#tp-storage-note`）で案内する。
プライベートモードの一部で保存が例外になるため。

---

## §4 主要フロー

### 4-1. 起動（`init()`）

1. `setScreenDepth(2)` … `/production-app/threads-post/` はルートから2階層。
   共通層が相対パスを解決するための宣言で、**モジュール読み込み時点で実行する**
2. `guardPage()` を待つ。返り値が偽なら**何も描画せずに終わる**
   （すでにログイン画面へ遷移している）
3. `#tp-loading` を隠し `#tp-content` を出す。**検証が終わるまで中身を見せない**
4. イベント登録 → `refreshKeyState()` / `updateCount()` / `renderDrafts()` / `renderHistory()`

### 4-2. 生成（`handleGenerate()`）

```
テーマ空 → メッセージを出して中止
本文が入力済み → confirm で上書き確認（キャンセルなら中止）
KeyStore からキーを都度読む（無ければ空文字を渡す＝ KEY_MISSING になる）
生成ボタンを disabled にする
generatePost() → 成功: 本文へ流し込み、文字数を更新
              → 失敗: describeGeminiError() の文言＋エラーコードを表示
finally: 生成ボタンを戻す
```

`AbortSignal` を渡す口は `gemini.js` 側にあるが、**画面からは使っていない**（§10）。

### 4-3. 投稿（`handlePost()`）

1. `validatePostText()`（空・500字超）
2. `window.open(buildIntentUrl(text), '_blank', 'noopener,noreferrer')`
   - **クリックと同じイベント内で開く。** 非同期の後に開くとポップアップ扱いで阻止される
   - `noopener,noreferrer` を明示する。開く先は他社の画面である
3. 開けなければポップアップ許可の案内を出して終わる（履歴に記録しない）
4. 開けたら履歴へ記録して再描画

### 4-4. キー設定の反映

ポータルでキーを設定して戻ってくる導線があるため、
`visibilitychange`（`document.hidden` が false になったとき）と `focus` で
`refreshKeyState()` を呼び直す。**ページを再読み込みさせない**ための作り。

---

## §5 外部インターフェース

### 5-1. Gemini

| 項目 | 値 |
| --- | --- |
| ホスト | `generativelanguage.googleapis.com`（`config.js` の `GEMINI_HOST`） |
| パス | `/v1beta/models/<model>:generateContent` |
| メソッド | POST |
| 認証 | `x-goog-api-key` **ヘッダー**。URL のクエリに載せない |
| モデル | `DEFAULT_MODEL` → 404 のときだけ `FALLBACK_MODEL` |

要求本文は `buildPostRequest()` が組み立てる。

```json
{
  "contents": [{ "role": "user", "parts": [{ "text": "<方針＋調整＋テーマ>" }] }],
  "generationConfig": { "temperature": 0.4, "maxOutputTokens": 1024 }
}
```

プロンプトの構成は「投稿の方針 → 書き方の調整（利用者設定・任意）→ テーマ・指示」。
方針には**創作の禁止**（テーマに無い数字・固有名詞・エピソードを足さない）が含まれる。
これは旧 GAS 版（`gas-threads/Generate.gs`）から引き継いだ指示である。

利用者の調整プロンプトはテーマより**前**に置き、2000字で頭打ちにする。
テーマ自体は `THEME_MAX_LENGTH`（100字）で切る。

応答からの取り出しは `extractPostText()`。`candidates[0].content.parts[0].text` を読み、
**コードフェンスと前後空白を剥がす**（付けるなと指示していても稀に付くため）。

### 5-2. Threads

| 項目 | 値 |
| --- | --- |
| URL | `https://www.threads.com/intent/post?text=<encodeURIComponent(本文)>` |
| 認証 | なし。未ログインなら Threads 側が `/login?next=…` へ誘導する |

ドメインは `threads.com`。旧 `threads.net` はリダイレクトされることを
2026-08-12 に実機確認したうえで、**直接 `threads.com` へ向けている**（`config.js` の注記）。

### 5-3. 送らないもの

当社サーバーへは何も送らない。`guardPage()` の検証（認証系 Apps Script ／
セッション検証 Worker）だけが当社側との通信である。

---

## §6 エラー設計

### 6-1. Gemini のエラー

`GeminiError`（`code` / `status` / `detail`）。**メッセージにキーを含めない**
（`gemini:<code>` のみ）。

| コード | 発生条件 | 画面のコード |
| --- | --- | --- |
| `KEY_MISSING` | キーが空 | KEY-001 |
| `KEY_REJECTED` | HTTP 401 / 403 | KEY-002 |
| `BAD_REQUEST` | HTTP 400 | AI-003 |
| `RATE_LIMITED` | HTTP 429 | AI-002 |
| `MODEL_NOT_FOUND` | HTTP 404 | AI-005 |
| `EMPTY_TEXT` | 本文が取り出せない／空 | AI-004 |
| `NETWORK` | `fetch` が例外 | AI-001 |
| `SERVER_ERROR` | HTTP 5xx（503 は文言を変える） | AI-001 |
| `UNKNOWN` | 上記以外 | SYS-999 |

**400 をキーの問題として扱わない。** 400 はリクエストの形が不正なときで、
キーが悪いときは 401/403 である。取り違えると利用者がキーを作り直し続けることになる。

`describeGeminiError()` は必ず `detail`（`summarizeErrorBody()` の要約、300字で切る）
を返す。「不明なエラー」だけでは切り分けができないため。
Gemini のエラー本文にキーは現れないので、そのまま表示してよい。

### 6-2. 再試行

- **404 のときだけ**フォールバックモデルで1回試す（モデルの廃止に追随するため）
- **503 では切り替えない。** 混雑は待って直すものであり、モデルを変えても同じ
- 401/403 でも再試行しない。結果は変わらず、無料枠のクォータを削るだけ

### 6-3. 画面側のエラー

`say(text, isError)` が1か所へ集約する。検証エラー（空・字数超）は例外ではなく
**文字列を返す**設計で、画面がそのまま表示できるようにしてある。

---

## §7 移植（他プロダクトへの組み込み）

### 7-1. 移植単位

| 単位 | ファイル | 依存 | 単独で持ち出せるか |
| --- | --- | --- | --- |
| Gemini テキスト生成 | `gemini.js` ＋ `config.js` の Gemini 節 | なし（キーは引数） | **可**。このリポジトリで最も再利用しやすい塊 |
| 端末内の下書き・履歴 | `post.js` の保存部 ＋ `STORAGE_KEY` `HISTORY_LIMIT` | なし（`storage` は引数で差し替え可） | **可** |
| intent 投稿 | `post.js` の `buildIntentUrl()` ＋ `app.js` の `handlePost()` | なし | 可（対象SNSごとに URL が変わる） |
| 画面 | `app.js` `index.html` `style.css` | `public/auth/` の3モジュール | **不可のまま**。§7-2 の3を先に外す |

### 7-2. 置換点（移植先で必ず直す）

1. **`config.js` の全定数。** `DEFAULT_MODEL` / `FALLBACK_MODEL`（モデルの世代）、
   `TEXT_LIMIT`（SNSごとの上限）、`THREADS_INTENT_BASE`、`STORAGE_KEY`（**必ず変える。
   同一オリジンに置くと他アプリと衝突する**）、`HISTORY_LIMIT`、`MAX_OUTPUT_TOKENS`
2. **プロンプト。** `buildPostRequest()` の「投稿の方針」は Threads 向けの文面である。
   移植先の媒体に合わせて書き直す。**創作の禁止だけは残すことを勧める**
3. **`public/auth/` への依存。** `app.js` 冒頭の3つの import。
   外し方は [auth-shared-design-v1.md](./auth-shared-design-v1.md) §5。
   最小構成なら `guardPage()` を「常に利用者を返す関数」に、
   `KeyStore` を「キーを返す任意の供給源」に差し替えれば動く
4. **CSP。** `index.html` の `<meta http-equiv="Content-Security-Policy">`。
   `connect-src` に Gemini のホストが要る。当社の認証系オリジンは不要になる
5. **DOM の id（`tp-` 接頭辞）。** `app.js` の `dom` オブジェクトと `index.html` が対
6. **絶対パス。** `favicon` などが `../../` を前提にしている

### 7-3. 前提

- HTTPS またはローカルホストで配信すること。ES モジュールを使うため
  `file://` では動かない
- 利用者が Gemini APIキーを持っていること（BYOK）。移植先が自社キーを使うなら、
  **キーをクライアントへ置けない**ため、サーバー側の中継が要る。
  そのときこのモジュールの前提（キーは引数）は変わらないが、`fetchImpl` を
  自社エンドポイント向けに差し替える設計になる
- ポップアップを開ける文脈（クリックハンドラ内）であること

### 7-4. 持ち出してはいけないもの

- `STORAGE_KEY` の値そのもの（衝突する）
- 当社の認証系オリジンを含む CSP の記述
- 上位文書に紐づく画面文言のうち、当社サービス名を含むもの

---

## §8 テスト設計

スイート: `tests/unit/threads-post.mjs`（`node tests/run.mjs threads-post`）。
ほかに `tests/unit/threads-mvp.mjs` が上位文書の受け入れ観点を持つ。

**`app.js` はテストしない。** DOM の付け外ししかせず、ロジックを持たないため。
テストは `post.js` / `gemini.js` を Node から直接 import して固定する。

差し替え口は2つ。

| 差し替え口 | 用途 |
| --- | --- |
| `post.js` の `{ storage, now }` 引数 | `localStorage` の偽物（`Map` 実装）と時刻の固定 |
| `gemini.js` の `fetchImpl` 引数 | 実APIへ通信しない。ヘッダー・URL・本文を検証する |

固定している観点は、検証と intent リンク（500字・URL エンコード）、
端末内保存（下書き・履歴・上限・壊れたデータの読み捨て）、
Gemini 呼び出し（キーがヘッダーにあること・404 フォールバック・エラー分類）。

ブラウザテストは無い（DOM 依存の分岐が小さいため）。

---

## §9 設定値と環境依存

すべて `config.js` にある。**設定値を変えるのはこのファイルだけ**という約束。

| 定数 | 意味 |
| --- | --- |
| `DEFAULT_MODEL` / `FALLBACK_MODEL` | Gemini のモデル名。他の本番アプリと同じ値に揃えてある |
| `GEMINI_HOST` / `GEMINI_ENDPOINT_BASE` | 送信先 |
| `MAX_OUTPUT_TOKENS` | 出力上限。500字の本文に対し余裕をみて 1024 |
| `THREADS_INTENT_BASE` | 投稿画面の URL |
| `TEXT_LIMIT` | 本文の上限（500） |
| `THEME_MAX_LENGTH` | テーマ入力の上限（100） |
| `STORAGE_KEY` | `tsam-threads-post-v1` |
| `HISTORY_LIMIT` | 履歴の保持件数（100） |

**秘密情報を置かない。** このファイルは公開URLから読める。
APIキーは KeyStore だけが扱い、ここには現れない。

環境依存は次のとおり。

- `crypto.randomUUID`（無ければフォールバックあり）
- `localStorage`（無くても動く）
- ポップアップ（阻止されたら案内する）

---

## §10 既知の制約・未解決

1. **投稿の成否を観測できない**（§1-2）。intent 方式の帰結であり、
   上位文書 §1.1 で受け入れた制約
2. **`AbortSignal` の口が未使用。** `gemini.js` は `signal` を受け取れるが、
   `app.js` は渡していない。生成の中止ボタンが無いため。UI を足すときに繋ぐ
3. **文字数の数え方が Threads と一致する保証がない。** 公開されていないため、
   コードポイントで厳しめに数えている（絵文字合成を1字と数えない）。
   「入るはずが入らない」より「入らないと言われて入る」を選んだ
4. **下書きに件数上限が無い。** 履歴だけ 100 件で切っている。
   `localStorage` の容量上限に当たると保存が例外になり、
   `handleSave()` がその旨を表示して終わる（データは失われない）

---

## §11 設計判断の記録

上位文書 §9 と重複しない範囲で、実装側の判断だけを記す。

| 判断 | 採らなかった案 | 理由 |
| --- | --- | --- |
| 保存を1キーの JSON にまとめた | 下書き・履歴・設定でキーを分ける | 読み書きが1トランザクションで済み、部分的に壊れた状態を作らない |
| 壊れた保存データを黙って捨てる | 利用者へ復旧を促す | 主目的（生成して投稿画面を開く）は保存が無くても達成できる |
| 検証エラーを例外でなく文字列で返す | 例外を投げる | 画面がそのまま表示に使える。分岐が減る |
| `app.js` にロジックを置かない | 1ファイルにまとめる | DOM を持たない層だけをテストできる（§8） |
| エラー詳細（`detail`）を必ず画面へ出す | 利用者向けの短文だけ出す | 切り分けができない問い合わせが増える。キーは本文に現れないので安全 |
| `x-post` へ共有せず複製した | 共通モジュールを作る | [../repository-structure.md](../repository-structure.md) §4-1 |

---

## §12 変更履歴

| 版 | 日付 | 内容 |
| --- | --- | --- |
| v1.0 | 2026-08-18 | 初版。実装（2026年8月時点）を記述 |

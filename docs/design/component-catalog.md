# 部品カタログ — 本番アプリで繰り返し使われている実装単位

対象: `public/production-app/` の全11アプリ ＋ `public/auth/`

制定: 2026年8月18日

この文書は[詳細設計書群](./README.md)の索引であり、**各アプリの設計書より上位ではない。**
ここでは「同じ系譜の実装がどこにいくつあり、どこで分岐したか」だけを扱う。
個々の挙動は各アプリの設計書が持つ。

一次情報は**各ファイル冒頭のコメント**である（このリポジトリは複製元と複製日を
そこに書く規約になっている）。系譜を推測で補っていない。
コメントに記載が無いものは「記載なし」と書いた。

---

## §1 なぜ複製されているのか

[../repository-structure.md](../repository-structure.md) §4-1 が、
`public/production-app/` の下に共通層（`shared/` `common/` `lib/`）を置かないと決めている。
理由は4つあり、要点は「重複より結合のほうが高くつく」「別々に進む開発を互いに止めない」。

**したがって、この一覧は「整理されていない状態」の記録ではない。意図された状態の記録である。**
移植するとき（他プロダクトへ持ち出すとき）も同じで、**参照ではなく複製して持ち出す。**
そのとき何を直すかは、各アプリ設計書の §7 が持つ。

同 §4-2 は「3本目の本番アプリが入るとき、この判断をやり直す」と書いている。
現に11本ある。**再検討の材料はこの文書の §4 に置くが、判断そのものはここで下さない。**

---

## §2 部品の家族（9系統）

| # | 家族 | 実装のある場所 | 分岐の度合い | 単独で持ち出せるか |
| --- | --- | --- | --- | --- |
| 1 | GIS ローダ | `card-ocr` `card-mail`（`gis-loader.js`）、`receipt-ocr` `voice-recorder` `audio-transcriber`（`oauth.js` 内に内蔵） | ほぼ同一 | 可 |
| 2 | OAuth トークン取得 | `card-ocr` `card-mail`（`drive-auth.js`）、`receipt-ocr` `voice-recorder` `audio-transcriber`（`oauth.js`） | エラー分類とスコープ検証で分岐 | 可（設定の差し替えのみ） |
| 3 | Drive 入出力 | `card-ocr` `card-mail`（`drive-api.js`）、`receipt-ocr`（`drive.js` `google-api.js`）、`voice-recorder`（`drive.js`）、`audio-transcriber`（`drive-client.js`） | 用途で分岐（アップロード／検索／ダウンロード） | 条件付き |
| 4 | Sheets 書き込み | `card-ocr`（`sheets.js`）、`receipt-ocr`（`sheets.js`）、`card-mail`（`ledger.js`。読むだけ） | `valueInputOption` が違う（§3-4） | 条件付き |
| 5 | セル値の無害化 | `card-ocr`（`sanitize.js`）、`receipt-ocr`（`sheets.js` の `escapeFormula`） | 対象文字が違う | 可 |
| 6 | 画像ハッシュ | `card-ocr`（`hash.js`）、`receipt-ocr`（`hash.js`） | 複数 Blob 対応の有無 | 可 |
| 7 | Gemini 呼び出し | `card-ocr` `meeting-minutes` `short-script` `threads-post` `x-post` `note-post`（`gemini.js`） | プロンプトと後処理で分岐。**通信部と分類部はほぼ同一** | 可 |
| 8 | 端末内保存（下書き・履歴） | `threads-post` `x-post` `note-post`（`post.js`）、`meeting-minutes`、`audio-transcriber`（`settings-store.js`） | キー名と上限のみ | 可 |
| 9 | 設定モジュール | 全アプリの `config.js` | 中身は各アプリ固有。**構造だけが共通** | 可（構造のみ） |

「単独で持ち出せるか」は、そのファイル群だけを別リポジトリへ複製して
動かせるかの見立てである。根拠は各アプリ設計書の §7。

---

## §3 家族ごとの系譜と分岐

### 3-1. GIS ローダ（`gis-loader.js`）

```
public/apps/gis-loader.js（テスト環境）
  └→ card-ocr/poc/gis-loader.js（2026-08-04）
       └→ card-ocr/gis-loader.js
            └→ card-mail/gis-loader.js（2026-08-10）
```

`card-ocr` → `card-mail` の差分は**冒頭コメントの記述のみ**で、コードは同一。
`receipt-ocr` `voice-recorder` `audio-transcriber` は同じ処理を `oauth.js` の中に持っている
（独立ファイルにしていない）。

**設計上の要点は1つ。** スクリプトの読み込み Promise をモジュールに1つだけ持ち、
**失敗したらキャッシュを捨てる。** 捨てないと、一度失敗したページでは
再試行しても同じ失敗した Promise が返り、連携が二度と成功しない。
`receipt-ocr/oauth.js` は現にその形になっている
（[../receipt-ocr-findings-20260804.md](../receipt-ocr-findings-20260804.md) #1）。

### 3-2. OAuth トークン取得（`drive-auth.js` / `oauth.js`）

```
public/apps/drive-auth.js（テスト環境）
  └→ card-ocr/poc/drive-auth.js（2026-08-04）
       └→ card-ocr/drive-auth.js ──→ card-mail/drive-auth.js（2026-08-10）

receipt-ocr/oauth.js
  └→ voice-recorder/oauth.js
       └→ audio-transcriber/oauth.js
```

**2つの系統がある。** 上は `card-scanner` 由来、下は `receipt-ocr` 由来。
どちらも次の方針は共通で、**移植先でも崩してはならない**。

- トークンはモジュールのクロージャ変数だけに置く。`localStorage` / `sessionStorage` /
  Cookie / URL / ログのいずれにも書かない。参照を返す getter も作らない
- refresh token・client secret を使わない（静的サイトに秘密は置けない）
- スコープを増やさない

分岐は3点。

| 分岐 | 実装 |
| --- | --- |
| 付与スコープの検証 | `card-ocr` `card-mail` は検証する。同意画面で利用者がチェックを外してもトークンは発行されるため（[../receipt-ocr-findings-20260804.md](../receipt-ocr-findings-20260804.md) #4）。`card-mail` は `drive.file` と `gmail.send` の**2つとも**検証する |
| エラー分類の粒度 | `voice-recorder` はポップアップ阻止・オリジン未登録・利用者による中断を区別する。`audio-transcriber` は `DriveAuthError` として `POPUP_CLOSED` / `POPUP_BLOCKED` / `ACCESS_DENIED` / `SCOPE_NOT_GRANTED` を返す。`receipt-ocr` は最も粗い |
| 中断（AbortSignal） | `card-ocr` 系は認可も中断できる。`receipt-ocr` 系は不可 |

### 3-3. Drive 入出力

`card-ocr` / `card-mail` の `drive-api.js` は同系譜（2026-08-10 複製）。
`receipt-ocr` は `drive.js` と `google-api.js` に分かれ、`voice-recorder` は
長時間録音のアップロード（再開可能アップロード）を持つ点で他と性質が違う。

**フォルダを ID で固定登録せず、名前から解決して無ければ作る**、という方針が共通。
`drive.file` スコープでは、アプリが作成していないフォルダへ書き込めないためである。

### 3-4. Sheets 書き込み（分岐が最も危険な家族）

```
public/apps/card-scanner/sheets-client.js
  ├→ receipt-ocr/sheets.js
  └→ card-ocr/sheets.js（2026-08-04。上の2つを突き合わせて作成）
```

**`valueInputOption` が違う。**

| アプリ | 値 | 帰結 |
| --- | --- | --- |
| `receipt-ocr` | `RAW` | 数式が評価されない。数式インジェクションに対して一段強い |
| `card-ocr` | `USER_ENTERED` | 数式が評価される。**無害化（§3-5）が唯一の防御になる** |

**移植時にここを取り違えると、防御の枚数が変わる。**
`USER_ENTERED` の実装を持ち出して `RAW` 前提の無害化と組み合わせない。

### 3-5. セル値の無害化

`card-ocr/sanitize.js` は、PoC 版と `receipt-ocr/sheets.js` の `escapeFormula` を
突き合わせて作られ、**対象文字にタブと復帰を足してある**（`receipt-ocr` 側が広かった）。
§3-4 のとおり `card-ocr` ではこれが唯一の防御である。

### 3-6. 画像ハッシュ

`card-scanner/metadata.js` → `receipt-ocr/hash.js` → `card-ocr/hash.js`（2026-08-04）。
`card-ocr` は名刺の表裏2枚を扱うため、複数 Blob をまとめて計算する口を足している。

`crypto.subtle` は**セキュアコンテキストでしか使えない**（https と localhost のみ）。
両実装とも、計算できない場合は `null` を返し、呼び出し側が「ハッシュ無し」で
先へ進める作りになっている。重複判定は他の手掛かり（メール・電話）でも行えるため。

### 3-7. Gemini 呼び出し（6本）

```
card-ocr/poc/gemini.js
  └→ card-ocr/gemini.js（2026-08-04）
       ├→ short-script/gemini.js
       │    ├→ threads-post/gemini.js ──→ x-post/gemini.js
       │    └→ note-post/gemini.js
       └→ meeting-minutes/gemini.js
```

方針は6本すべてで同一。

- キーは `x-goog-api-key` **ヘッダー**に載せる。URL のクエリに載せない
  （開発者ツールの履歴や拡張機能から見えるため）
- キーを引数で受け取り、モジュール内に保持しない。例外にも `console` にも出さない
- 外部SDKを使わず `fetch` で REST を直接叩く
- 主モデルが 404（廃止）のときだけフォールバックへ切り替える
- `responseSchema` の `type` は**大文字**（`'OBJECT'` 等）。小文字はサーバーに 400 で弾かれる
  （`card-ocr/prompt.js` が実際に踏んだ事故の記録が `meeting-minutes/gemini.js` に残っている）

モデル定数は6本とも同じ値で `config.js` に置かれている
（`DEFAULT_MODEL` = `gemini-2.5-flash-lite`、`FALLBACK_MODEL` = `gemini-3.5-flash-lite`）。

**分岐しているのはプロンプトと後処理だけ**で、通信部とエラー分類はほぼ同一。
行数の差（279〜523行）は、そのままプロンプト・スキーマ・後処理の差である。

### 3-8. 端末内保存

すべて `localStorage` で、キー名は `tsam-` 接頭辞に統一されている。

| キー | 使う場所 | 中身 |
| --- | --- | --- |
| `tsam-threads-post-v1` | `threads-post` | 下書き・履歴 |
| `tsam-x-post-v1` | `x-post` | 同上 |
| `tsam-note-post-v1` | `note-post` | 同上 |
| `tsam-meeting-minutes-draft` | `meeting-minutes` | 議事録の下書き |
| `tsam-meeting-minutes-handoff-v1` | `audio-transcriber` → `meeting-minutes` | アプリ間の引き継ぎ（TTL 30分） |
| `tsam-audio-transcriber-settings-v1` | `audio-transcriber` | 設定 |
| `tsam-card-ocr-*`（4件） | `card-ocr` | 解決済みのフォルダ・台帳 ID のキャッシュ |
| `tsam-card-mail-*`（3件） | `card-mail` | 同上 |
| `tsam-receipt-ocr-locations` | `receipt-ocr` | 同上 |
| `tsam-curl-notifier` / `tsam-curl-notifier-fallback` | `calendar-url-notifier` | 通知設定 |

**アクセストークンはこの一覧に無い**（§3-2 のとおりメモリのみ）。移植時もこの線を越えない。

### 3-9. 設定モジュール（`config.js`）

全11アプリが持つ。共通するのは**構造**だけである。

- 外部から差し替えたい値（クライアントID・モデル名・上限・タイムアウト）を1か所に集める
- 設定が未投入かどうかを判定する述語を置く（例: `isOauthConfigured()`）
- 秘密でない公開値のみを置く（クライアントIDは公開値。実質的な防御は
  Google Cloud 側の「承認済みの JavaScript 生成元」）

---

## §4 「同一化できる範囲」の実測（2026-08-18）

[../repository-structure.md](../repository-structure.md) §4-1 は 2026-08-04 に
`receipt-ocr` と `card-ocr` の2本を突き合わせ、**同一化できたのは4断片・約200行（全体の3%）**
と測っている。同 §4-2 は「3本目が入るとき、この判断をやり直す」としており、
現に11本ある。**そこで、詳細設計書を書くにあたり、複製関係にある対を実測した。**

### 4-1. 測り方

`diff` で**一致した行数**を数えた（順序を保った一致。空行・コメントを含む）。
「同一化できる量」の上限を粗く見るための数字であって、
**そのまま共通化できる行数ではない**（コメントの一致が多く含まれる）。

### 4-2. 結果

| 対 | 一致行 | 行数（左 / 右） | 一致率（左基準） |
| --- | --- | --- | --- |
| `threads-post/gemini.js` ↔ `x-post/gemini.js` | 275 | 279 / 279 | 99% |
| `threads-post/gemini.js` ↔ `note-post/gemini.js` | 262 | 279 / 304 | 94% |
| `short-script/gemini.js` ↔ `threads-post/gemini.js` | 211 | 310 / 279 | 68% |
| `card-ocr/gemini.js` ↔ `meeting-minutes/gemini.js` | 192 | 341 / 523 | 56% |
| `card-ocr/gis-loader.js` ↔ `card-mail/gis-loader.js` | 116 | 128 / 119 | 91% |
| `card-ocr/drive-auth.js` ↔ `card-mail/drive-auth.js` | 283 | 308 / 303 | 92% |
| `card-ocr/drive-api.js` ↔ `card-mail/drive-api.js` | 293 | 500 / 313 | 59% |
| `threads-post/post.js` ↔ `x-post/post.js` | 126 | 161 / 161 | 78% |
| `receipt-ocr/oauth.js` ↔ `voice-recorder/oauth.js` | 105 | 118 / 153 | 89% |
| `receipt-ocr/hash.js` ↔ `card-ocr/hash.js` | 24 | 55 / 73 | 44% |

### 4-3. 読み取れること

**2026-08-04 の「3%」とは様相が違う。** ただし比べているものが違う。
あのときは**別系統の2アプリ全体**を突き合わせた。ここで測ったのは
**同一系譜にある対の同一ファイル**である。数字の大小をそのまま比較できない。

そのうえで言えること。

1. **投稿系3本の `gemini.js` は 94〜99% 一致する。**
   分岐しているのはプロンプトと定数だけで、通信部・エラー分類は実質同一である
2. **認可まわり（`gis-loader.js` / `drive-auth.js` / `oauth.js`）も 89〜92%。**
   残りはスコープ検証の有無とエラー分類の粒度（§3-2）
3. **用途が違う対ほど下がる。** `card-ocr` ↔ `meeting-minutes` の `gemini.js` は 56%、
   `hash.js` は 44%。**同じ名前でも同じものではない**
4. `drive-api.js` の 59% は、`card-ocr` 側が 500 行と大きいことによる
   （`card-mail` は読み取りしか使わない）

### 4-4. それでも共通層をここで作らない

**この節は共通化の可否を決める材料であって、決定ではない。**
2026-08-04 の判断は行数ではなく**方針の食い違いが13点あったこと**を理由にしている。
一致率が高くても、その13点（エラーコード体系・`valueInputOption`・
同名フォルダの扱い・モデル名ほか）は消えていない。実際、本カタログの
§3-4（`RAW` と `USER_ENTERED`）と §3-2（スコープ検証の有無）は、
**一致率の高い家族の中にいまも残っている食い違い**である。

判断には [../instructions/2026-08-18-app-design-docs-handoff.md](../instructions/2026-08-18-app-design-docs-handoff.md) §2 の
方針決定（A 複製前提／B 共有ライブラリ化／C 第三者納品）が要る。

---

## §5 移植するときの共通の落とし穴

各アプリ設計書の §7 に個別の置換点を書くが、**どの部品を持ち出しても効くもの**をここに置く。

1. **Google Cloud 側の設定が要る。** クライアントIDを差し替えるだけでは動かない。
   移植先のオリジンを「承認済みの JavaScript 生成元」へ登録する必要がある
2. **CSP の `connect-src`。** 各 `index.html` に書かれている。移植先の CSP へ写す
3. **HTTPS またはローカルホストであること。** `crypto.subtle`（§3-6）と
   Google の認可の両方が、セキュアコンテキストを要求する。
   ES モジュールを使うため `file://` では動かない
4. **失敗した Promise をキャッシュしない**（§3-1）
5. **複製元の既知の欠陥を写さない。**
   [../repository-structure.md](../repository-structure.md) §4-3 と
   [../receipt-ocr-findings-20260804.md](../receipt-ocr-findings-20260804.md)
6. **`public/auth/` への依存**（`guardPage()` / `KeyStore`）は移植先には無い。
   外し方は [auth-shared-design-v1.md](./auth-shared-design-v1.md) §5 が持つ

---

## §6 この文書で確認できていないこと

- `public/apps/`（テスト環境）側の現状との差分は追っていない。
  本番アプリはそこから複製されており、**依存はしていない**（[../repository-structure.md](../repository-structure.md) §1）
- 系譜のうち、冒頭コメントに記載が無いものは追跡していない。
  `receipt-ocr` の各モジュールと `meeting-minutes/gemini.js` の複製元は、
  コメントに「同じ方針」とあるだけで複製日が書かれていない

---

## 変更履歴

| 版 | 日付 | 内容 |
| --- | --- | --- |
| v1.0 | 2026-08-18 | 初版。9系統の家族と系譜を記録。§4 の再測定は未実施 |

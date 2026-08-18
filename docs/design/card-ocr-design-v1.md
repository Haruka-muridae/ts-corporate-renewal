# 名刺OCR・データ登録アプリ 詳細設計書 v1.0

| 項目 | 内容 |
| --- | --- |
| アプリID | `card-ocr` |
| 実装 | `public/production-app/card-ocr/` |
| 上位文書 | [../specs/meishi-ocr-requirements-v3.md](../specs/meishi-ocr-requirements-v3.md)（v3.5） |
| 付随 | [../specs/card-ocr-phase0-plan.md](../specs/card-ocr-phase0-plan.md)（方式検証。完了済み） |
| テスト | `tests/unit/card-ocr.mjs`（`node tests/run.mjs card-ocr`） |
| 規模 | 約7,600行（このリポジトリで最大のアプリ） |
| 作成日 | 2026年8月18日 |

**OCR を2系統（Drive OCR ＋ Gemini）持ち、その結果を突き合わせる**のがこのアプリの中核。
「どちらが正か」の決着（§4-4）が設計判断のいちばん重い部分である。

---

## §1 責務と境界

### 1-1. 引き受けること

- 名刺の表面・裏面を順に撮影／選択し、前処理（回転・リサイズ・圧縮）する
- Drive OCR（画像→Google ドキュメント変換の副作用として走る）でテキストを得る
- 正規表現による事前抽出と、Gemini による項目分類を行い、**突き合わせる**
- 重複（同一画像ハッシュ → 会社名＋氏名）を判定する
- 利用者のドライブに保存構造を自動で作り、画像と台帳1行を保存する

### 1-2. 引き受けないこと

- 当社サーバーでの処理・保管。**画像もテキストも当社を通らない**
- 台帳の閲覧・編集 UI（スプレッドシートを直接使う）
- メール配信（`card-mail` の担当）

### 1-3. 隣との関係

| 相手 | 関係 |
| --- | --- |
| `card-mail` | **同じクライアントIDを意図的に共用**し、このアプリが作った台帳を読む。`drive.file` はクライアントIDごとに見える範囲が分かれるため、共用しないと読めない |
| `receipt-ocr` | 複製元／複製先。手順・列の組み立て方を手本にしている。**import はしない** |
| `public/apps/card-scanner/` | 元の系譜（テスト環境）。import しない |
| KeyStore | Gemini キーの取得元 |

---

## §2 モジュール構成

| ファイル | 責務 | 行数 | DOM | 通信 |
| --- | --- | --- | --- | --- |
| `config.js` | 静的設定（唯一の設定源） | 187 | — | — |
| `prerequisites.js` | 前提確認画面（SC-00）の状態判別 | 205 | **無** | 無 |
| `capture-flow.js` | 表→裏の撮影ステップ遷移 | 140 | **無** | 無 |
| `capture.js` | 画像の前処理（回転・縮小・圧縮） | 414 | 一部 | 無 |
| `hash.js` | 画像の SHA-256 | 73 | 無 | 無 |
| `gis-loader.js` | GIS スクリプトの読み込み | 128 | — | 有 |
| `drive-auth.js` | トークン取得とスコープ検証 | 308 | 無 | 有 |
| `drive-api.js` | Drive API v3 | 500 | 無 | 有 |
| `drive-ocr.js` | Drive OCR（一時ドキュメント経由） | 337 | 無 | 有 |
| `drive-storage.js` | 保存構造の解決・健全性確認 | 434 | 無 | 有 |
| `extract.js` | 正規化と正規表現抽出 | 315 | **無** | 無 |
| `prompt.js` | Gemini のプロンプトとスキーマ | 195 | 無 | 無 |
| `gemini.js` | Gemini 呼び出し | 341 | 無 | 有 |
| `merge.js` | Gemini と正規表現の突き合わせ | 198 | **無** | 無 |
| `schema.js` | 台帳の列定義と行の組み立て | 277 | **無** | **無** |
| `sanitize.js` | セル値の無害化 | 114 | 無 | 無 |
| `sheets.js` | Sheets API v4 | 394 | 無 | 有 |
| `register.js` | 確定保存の手順 | 288 | 無 | 有 |
| `app.js` | 画面 | 1,086 | 有 | — |
| `measure/` | 精度測定用の別画面 | — | 有 | 有 |

### 2-1. 「DOM 無し・通信無し」を明示している層

`prerequisites.js` `capture-flow.js` `extract.js` `merge.js` `schema.js` は、
いずれも冒頭で「ここに DOM／通信を持ち込まない」と宣言している。
**画面を組み立てずに正しさを確かめられる状態を保つため**であり、
そのままテストの対象になっている（§8）。

とくに `schema.js` と `sheets.js` を分けてあるのは、
**列構成の正しさを通信なしで確かめられるようにするため**である。

---

## §3 状態とデータ構造

### 3-1. 保存構造（利用者のドライブ）

```
マイドライブ
└─ TSAM AI                （ROOT_FOLDER_NAME）
   └─ 名刺データ           （APP_FOLDER_NAME）
      ├─ 名刺管理          （SPREADSHEET_NAME。Googleスプレッドシート）
      └─ images
         └─ YYYY / MM     （月別。resolveMonthFolder）
```

**フォルダIDを設定に持たない。** 名前から解決し、無ければ作る
（`drive.file` ではアプリが作成していないフォルダへ書けないため）。
解決結果は `localStorage` にキャッシュする。

| キー | 内容 |
| --- | --- |
| `tsam-card-ocr-root-folder-id` | `TSAM AI` |
| `tsam-card-ocr-app-folder-id` | `名刺データ` |
| `tsam-card-ocr-image-folder-id` | `images` |
| `tsam-card-ocr-spreadsheet-id` | `名刺管理` |
| `tsam-card-ocr-measure-session` | 精度測定画面の作業用 |

キャッシュは**あくまで近道**で、`isFileId()` で形を検査し、
実在しなければ解決し直す（`clearStorageCache()` がある）。

### 3-2. 台帳の列（`schema.js`）

`SCHEMA_VERSION = '3.5'`。データタブと履歴タブの2種類。

データ列は「人が読む列」（登録日時・会社名・部署名・役職・氏名・氏名カナ・郵便番号・
住所・電話番号・携帯番号・FAX・メールアドレス・URL・その他・要確認項目）と、
「機械が使う列」（`record_id` `duplicate_key` `has_back` `back_filled_fields`
`front_image_hash` `back_image_hash` `front_file_id` `back_file_id`
`front_file_url` `back_file_url` `app_version` `prompt_version`）に分かれる。

**列は位置ではなくキーで組み立てる**（`register.js` が `receipt-ocr` から採った形）。
`verifyHeader()` が既存の見出しと突き合わせ、`missingTabs()` が不足タブを検出する。

見出しの決め方には経緯がある。上位文書 §11.2 は「v1.1 の列構成を基本とし」とするが、
**v1.1 はこのリポジトリに無い。** そこで §11.2 が名前を明示している列はその名前を使い、
残りは日本語見出しにしてある。

### 3-3. メモリだけに置くもの

アクセストークン（`drive-auth.js` のクロージャ）、Gemini APIキー（都度取得）、
撮影した画像（Blob）。

---

## §4 主要フロー

### 4-1. 前提確認（SC-00）

`evaluatePrerequisites()` は**状態を1つだけ返す**。
未ログイン（→ `/login/`）／Google 未連携（→ 連携ボタン）／キー未設定（→ Portal）の
3状態を判別し、**該当する誘導のみを表示する**（上位文書 §10.1）。

複数の誘導を同時に出すと、利用者はどれから手を付ければよいか分からなくなる。

### 4-2. 撮影（`capture-flow.js` ＋ `capture.js`）

**表→裏の順に取得する。1画面に2枠を並べない。**
スマートフォンで片手で扱うとき「いま何を撮ればよいか」が一意に決まるため。
**裏面なしが多数派**（裏は空白か英語表記の複製）なので、スキップを一級の操作として持つ。

前処理は次のとおり。

- 長辺 **2000px**（複製元は 1600px。上位文書 §20 の確定値）
- **1.5MB に収まるまで段階的に圧縮**する
- HEIC を見分けて案内を分ける
- 手動回転

**解像度を下げすぎない**ことが明記されている。OCR の精度に直結するため。

### 4-3. OCR（`drive-ocr.js`）

```
1. files.create（multipart）で画像を Google ドキュメントへ変換 ← この過程で OCR が走る
2. files.export（text/plain）で本文を取得
3. 一時ドキュメントを完全削除（TEMP_DOC_PREFIX で識別）
```

- **面ごとに並列で走らせる**
- **裏面の失敗を全体の失敗にしない**（表面が取れていれば進める）
- 最大 `MAX_OCR_ATTEMPTS`（3回）まで再試行する
- 言語は `OCR_LANGUAGE = 'ja'`

### 4-4. 抽出と突き合わせ（`extract.js` → `gemini.js` → `merge.js`）

**正規表現は Gemini の代わりではない。得意な所だけを担当する。**

| 担当 | 対象 |
| --- | --- |
| 正規表現（`extract.js`） | メール・URL・郵便番号・電話番号（**形が決まっている**） |
| Gemini（`gemini.js` ＋ `prompt.js`） | 会社名・氏名・役職・住所（**文脈が要る**） |

`merge.js` の決着ルール。

- 原則は**用途分類は Gemini 優先**（上位文書 §FR-10）
- **例外は電話番号の種別。ここだけ正規表現が正。**
  日本の携帯は 070 / 080 / 090 で始まると決まっており、文脈ではなく形の問題である。
  フェーズ0の予行で「同じ番号が `phone` と `mobile` の両方に入る」不具合が出た。
  プロンプトでも禁じたが、**形で決められるものを言葉で頼まない**という判断

`fieldsNeedingReview()` が「要確認項目」を返し、台帳の該当列へ入る。

Gemini への入力は `truncateForGemini()` で `MAX_GEMINI_INPUT_LENGTH`（2000字）に切る。

### 4-5. 確定保存（`register.js`）

```
1. 重複を見る
     findHashDuplicate()      … 同一画像のハッシュ
     findAttributeDuplicate() … 会社名＋氏名（buildNameKey）
2. 表面・裏面の画像を images/YYYY/MM へ上げる
3. 台帳へ1行追記する
```

`receipt-ocr` から採った3つの形。

- **列の定義から行を組み立てる**（位置で書かない）
- **本体を先に保存し、付随するものは後**
- **二重送信を防ぐ**

### 4-6. 保存構造の健全性（`drive-storage.js`）

`ensureStorage()` が構造を解決・作成し、`inspectSpreadsheet()` が
タブと見出しを検査する。壊れた状態（同名フォルダが複数、見出しの不一致、
タブの欠落）への対応が `StorageNotice` として型付けされている。
この「壊れた状態への対応」が上位文書 §9.3 の実質的な本体である。

---

## §5 外部インターフェース

| 系統 | エンドポイント | 用途 |
| --- | --- | --- |
| Drive | `DRIVE_FILES_ENDPOINT` / `DRIVE_UPLOAD_ENDPOINT` | フォルダ解決・画像アップロード・OCR 用一時ドキュメント |
| Sheets | `SHEETS_ENDPOINT` | 台帳の読み書き |
| Gemini | `GEMINI_ENDPOINT_BASE` | 項目分類 |
| GIS | `GIS_SCRIPT_URL` | 認可 |

- スコープは `DRIVE_SCOPE`（`drive.file`）**のみ**
- **付与スコープを検証する**（同意画面でチェックを外されてもトークンは発行されるため）
- GIS の読み込みは `GIS_LOAD_TIMEOUT_MS`（10秒）でタイムアウト、
  トークンは `TOKEN_EXPIRY_MARGIN_MS`（60秒）の余裕を見て更新する
- Gemini のモデルは他アプリと同じ（`DEFAULT_MODEL` → 404 で `FALLBACK_MODEL`）、
  `MAX_OUTPUT_TOKENS` は 700（項目分類なので短い）

### 5-1. Sheets の書き込み方式（**移植時に最も注意する点**）

`valueInputOption` は **`USER_ENTERED`**。数式が評価されるため、
**`sanitize.js` の無害化が唯一の防御になる。**
`receipt-ocr` は `RAW` で書いており、数式が評価されない分だけ防御が1枚多い。
[component-catalog.md](./component-catalog.md) §3-4 を参照。

---

## §6 エラー設計

- `OcrError` / `OcrErrorCode`（`drive-ocr.js`）
- Gemini・Drive・Sheets それぞれの分類（各モジュール）
- 画面のエラーコードは上位文書 §15 の体系（例: 画像は `IMG-001` / `IMG-002` / `IMG-003`）

**裏面の失敗は全体の失敗にしない**（§4-3）ように、失敗の伝播範囲が面ごとに切られている。

---

## §7 移植（他プロダクトへの組み込み）

### 7-1. 移植単位

| 単位 | ファイル | 依存 | 単独で持ち出せるか |
| --- | --- | --- | --- |
| **Drive OCR** | `drive-ocr.js` ＋ `drive-api.js` | 認可 | **可。Google ドキュメント変換の副作用で OCR する手法はそのまま使える** |
| 画像前処理 | `capture.js` | なし | 可（長辺・目標サイズは定数） |
| 正規表現抽出 | `extract.js` | なし（純粋関数） | **可。日本の電話番号・郵便番号の扱いを含む** |
| 突き合わせ | `merge.js` | `extract.js` の出力形 | 可 |
| 台帳スキーマ | `schema.js` ＋ `sanitize.js` | なし | 可（列を差し替える） |
| 保存構造の解決 | `drive-storage.js` | `drive-api.js` | 可（名前を差し替える） |
| 撮影フロー | `capture-flow.js` | なし | 可 |
| 前提判別 | `prerequisites.js` | なし | 可（誘導先を差し替える） |
| 画面 | `app.js` | `public/auth/` | 不可のまま |

### 7-2. 置換点

1. **`config.js` 全体。** `GOOGLE_CLIENT_ID`（**`card-mail` と共用している事実を
   引き継ぐかどうかを先に決める**）、`ROOT_FOLDER_NAME` / `APP_FOLDER_NAME` /
   `IMAGE_FOLDER_NAME` / `SPREADSHEET_NAME`、`TABS`、`APP_VERSION`、`STORAGE_KEYS`
2. **`schema.js` の `DATA_COLUMNS` / `HISTORY_COLUMNS` と `SCHEMA_VERSION`**
3. **`prompt.js`。** 抽出したい項目が変われば、スキーマとプロンプトの両方
4. **`sanitize.js` と `valueInputOption` の組。**
   **片方だけ持ち出さない**（§5-1）
5. `public/auth/` への依存、CSP、DOM id

### 7-3. 前提

- セキュアコンテキスト（`crypto.subtle` を使う。使えない場合は
  ハッシュ無しで進む設計になっている）
- Drive と Sheets の API が有効なプロジェクト
- 承認済み JavaScript 生成元の登録
- 利用者が Gemini APIキーを持っていること

### 7-4. 持ち出してはいけないもの

- **`USER_ENTERED` のまま無害化を外した版**（§5-1）
- 電話番号の種別を Gemini に決めさせる版（§4-4 の経緯）
- 長辺 1600px の旧設定（OCR 精度が落ちる。§4-2）
- 当社の保存構造名（`TSAM AI ＞ 名刺データ`）

---

## §8 テスト設計

スイート: `tests/unit/card-ocr.mjs`。

テスト対象は、DOM も通信も持たない層（`prerequisites.js` `capture-flow.js`
`extract.js` `merge.js` `schema.js` `sanitize.js` `hash.js`）と、
`fetchImpl` を差し替えられる層（`drive-api.js` `drive-ocr.js` `drive-storage.js`
`sheets.js` `gemini.js` `register.js`）。

差し替え口は `{ token, fetchImpl, signal }` で統一されている。

`measure/`（精度測定画面）は別系統で、**PoC の実装ではなく本番の実装を測るように
作り直されている**（過去に PoC 側を測っていた経緯がコメントに残っている）。

---

## §9 設定値と環境依存

`config.js`。主なもの。

| 定数 | 意味 |
| --- | --- |
| `GOOGLE_CLIENT_ID` / `CLIENT_ID_PLACEHOLDER` / `isClientIdConfigured()` | 未設定を検出できるようにしてある |
| `DRIVE_SCOPE` | `drive.file` のみ |
| `GIS_SCRIPT_URL` / `GIS_LOAD_TIMEOUT_MS` / `TOKEN_EXPIRY_MARGIN_MS` | 認可 |
| `DRIVE_FILES_ENDPOINT` / `DRIVE_UPLOAD_ENDPOINT` / `SHEETS_ENDPOINT` | Google API |
| `DEFAULT_MODEL` / `FALLBACK_MODEL` / `MAX_OUTPUT_TOKENS`（700） | Gemini |
| `ROOT_FOLDER_NAME` / `APP_FOLDER_NAME` / `IMAGE_FOLDER_NAME` / `SPREADSHEET_NAME` / `TABS` | 保存構造 |
| `APP_VERSION`（`card-ocr-1.1`） | 台帳へ記録する |
| `STORAGE_KEYS` | `localStorage` のキャッシュ |
| 各 MIME 定数 | フォルダ・ドキュメント・スプレッドシート・JPEG |

---

## §10 既知の制約・未解決

1. **`USER_ENTERED` を選んだ結果、防御が無害化1枚になっている**（§5-1）。
   意図した選択だが、`sanitize.js` を弱めると直ちに数式インジェクションに晒される
2. **`crypto.subtle` が使えない環境ではハッシュ無しで進む。**
   重複判定はメール・電話・会社名＋氏名でも行えるため止めない設計
3. **利用者が手で置いたファイルは `drive.file` では見えない。**
   同名の台帳が2つある状態を完全には防げない（`StorageNotice` で通知する）
4. **`app.js` が 1,086 行。** 画面の判断を集約する設計の帰結
5. **上位文書 §11.2 が参照する「v1.1 の列構成」がリポジトリに無い**（§3-2）。
   現在の列は §11.2 が名前を明示したものを基準に再構成したものである

---

## §11 設計判断の記録

上位文書 §（採用しなかった提案）と重複しない範囲で、実装側の判断を記す。

| 判断 | 採らなかった案 | 理由 |
| --- | --- | --- |
| OCR を Drive の変換で行う | Gemini に画像を直接読ませる／OCR ライブラリを積む | フェーズ0で方式を検証済み。追加の依存も追加の送信先も要らない |
| 正規表現と Gemini を併用する | Gemini だけに任せる | 形が決まっているものは正規表現が確実。**電話種別は正規表現が正**（実際に事故が出た） |
| 表→裏の順に撮る | 1画面に2枠 | 片手操作で「いま何を撮るか」が一意になる |
| 裏面の失敗を全体の失敗にしない | どちらか失敗なら中止 | 裏面なしが多数派で、表面だけで登録できる |
| 長辺 2000px・1.5MB | 1600px のまま | OCR 精度が解像度に直結する |
| 列をキーで組み立てる | 位置で書く | 列を足したときに黙って壊れない |
| 本体を先に保存する | まとめて保存する | 途中で失敗しても、台帳の1行と画像の関係が壊れにくい |
| `schema.js` と `sheets.js` を分ける | 1ファイルにする | 列構成を通信なしで検証できる |
| キャッシュを近道としてのみ使う | ID を設定として保持する | 利用者ごとに異なり、消えることもある |

---

## §12 変更履歴

| 版 | 日付 | 内容 |
| --- | --- | --- |
| v1.0 | 2026-08-18 | 初版。実装（2026年8月時点）を記述 |

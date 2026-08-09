# Phase 1 設計（文章パイプライン MVP）

**作成日**: 2026年8月7日
**対象**: 一想（ISSO）／`app/pipeline/` + `lib/pipeline/`
**根拠**: [implementation-guide.md](./implementation-guide.md) v0.6 §2・§3-2・§4、要件定義書 v0.1 7.1〜7.5・9章・10章・15章
**受入条件**: AC-01 / AC-02 / AC-03（＋ AC-09 のシーン構造）

**実装前の設計。着手の承認を得るための報告物である。**

---

## 0. Phase 1 の範囲

| 入る | 入らない |
| --- | --- |
| テーマ入力（FR-001〜003） | SNS連携・投稿（Phase 2） |
| Threads / X / note / 台本の段階生成（FR-010〜044） | 予約・リマインダー（Phase 2） |
| 編集・再生成・採用（FR-013 ほか） | 動画化・TTS・YouTube（§8 拡張） |
| ローカル下書きと派生追跡（FR-060 の一部） | 状態 SCHEDULED / PUBLISHING / PUBLISHED（Phase 2） |
| エクスポート／インポート | |
| データ保存場所の説明画面 | |
| **Gemini のBYOキー登録・保管（keystore 相当）** | サーバー処理（v0.6 で消滅） |

**完全ローカル動作。v0.6 により Phase 1 のサーバー処理はゼロ**（LLM は利用者のBYOキーでブラウザから Gemini を直接呼ぶ。guide §3-2）。

---

## 1. IndexedDB スキーマ

### 1-1. なぜ IndexedDB か

localStorage は同期APIで**メインスレッドを止める**うえ、容量が概ね 5MB 程度。
note 記事（1,500〜3,000字）を複数テーマぶん持つと足りない。
IndexedDB は非同期・大容量で、構造化データをそのまま置ける。

**ラッパは自作する**（外部SDK禁止・guide §1）。使う機能は
`openDB` / `transaction` / `objectStore` / `index` / `cursor` だけなので、
薄い Promise 化で足りる。

### 1-2. ストア構成

DB名 `isso`、初期バージョン `1`。

```
projects        1テーマ = 1プロジェクト（ContentProject 相当）
versions        各段階の生成物と派生関係（ContentVersion 相当）
scenes          台本のシーン（Scene 相当。FR-043 / AC-09）
settings        段階ごとの生成オプション（FR-012 / FR-032 / FR-042）
meta            スキーマ版・初回起動フラグ
```

**Phase 2 で `publishJobs` / `publishedPosts` / `credentials` を追加する。**
いま作らないのは、形が T1-6・T2-2 の結果で変わるため（[platform-adapter-and-llm-client.md](./platform-adapter-and-llm-client.md) §5）。

### 1-3. `projects`

| キー | 型 | 備考 |
| --- | --- | --- |
| `id` (PK) | string | `prj_` + UUID |
| `sourceText` | string | 利用者が入力した着想（FR-001） |
| `title` | string | 任意（FR-002） |
| `audience` | string | 想定読者。任意 |
| `note` | string | 補足情報。任意 |
| `status` | `'draft' \| 'archived'` | Phase 1 では2値のみ |
| `createdAt` / `updatedAt` | string (ISO) | |

索引: `updatedAt`（ホームの新しい順一覧）。

### 1-4. `versions` — **本プロダクトの中核**

要件10章の「重要」注記どおり、**`parentVersionId` による派生追跡が体験の中核**。

| キー | 型 | 備考 |
| --- | --- | --- |
| `id` (PK) | string | `ver_` + UUID |
| `projectId` | string | → `projects.id` |
| `stage` | `'threads' \| 'x' \| 'note' \| 'script' \| 'metadata'` | |
| `body` | string | 本文。`script` は本文（シーンは `scenes` へ） |
| `versionNo` | number | 同一 stage 内の連番。再生成で増える |
| `parentVersionId` | string \| null | **どの採用版から派生したか** |
| `adopted` | boolean | **採用フラグ**（下記） |
| `editedByUser` | boolean | 利用者が手を入れたか（FR-015 / 要件15章） |
| `createdAt` | string (ISO) | |

索引: `projectId`、複合 `[projectId+stage]`、`parentVersionId`。

#### `adopted` の扱い（要件15章の要）

> 「前段の**採用版**を次段の主要入力として扱う」「ユーザーが修正した表現を次段の生成に反映し、
> **AI原案よりユーザー編集を優先する**」

- **同一 `[projectId, stage]` で `adopted: true` は高々1件。** 採用の切り替えは
  トランザクション内で旧採用を落としてから立てる
- 次段の生成入力は「**採用済みの上流版**」だけを渡す。未採用の案は渡さない
- `editedByUser: true` の版が採用されている場合、プロンプトで
  「これは利用者が編集したものであり、表現を尊重する」旨を明示する

> **複数案（FR-013）は versions に複数行として入り、うち1件が `adopted`。**
> 別ストアにしない。案も版も「同じ段階の候補」であって構造が同じため。

### 1-5. `scenes` — FR-043 / AC-09

| キー | 型 | 備考 |
| --- | --- | --- |
| `id` (PK) | string | `scn_` + UUID |
| `versionId` | string | → `versions.id`（`stage: 'script'` の版） |
| `order` | number | 0 始まり |
| `narration` | string | **必須。** ナレーション（話し言葉） |
| `visualPrompt` | string | **必須。** 映像指示 |
| `subtitle` | string \| null | 字幕。Phase 1 では任意（動画化しないため） |

索引: `versionId`、複合 `[versionId+order]`。

> **AC-09 が見るのはこの3列の存在。** 「複数シーンに分割され、各シーンが
> ナレーションと映像指示を持つ」——`narration` と `visualPrompt` を
> **NOT NULL 相当（空文字を許さない）**として扱い、生成後の検証で担保する。

### 1-6. `settings` / `meta`

`settings` は `key`（PK）と `value` の単純なKV。段階ごとの文字数目安・口調・
目標尺（FR-012 / FR-032 / FR-042）を持つ。

`meta` は `schemaVersion` と `welcomeSeen`（初回説明画面を見たか）。

### 1-7. マイグレーション方針

`onupgradeneeded` で `oldVersion` から順に段階適用する。
**Phase 2 でストアを足すときにデータを消さない**ことが要件。

```
v1 → v2 : publishJobs / publishedPosts / credentials を追加（Phase 2）
```

> **利用者のブラウザにしかデータが無い以上、マイグレーションの失敗＝データ消失。**
> 失敗時は「エクスポートしてから再試行してください」と案内し、**黙って作り直さない。**

---

## 2. 画面構成

### 2-1. ルート

`app/pipeline/` 配下。`basePath` を使わないため、パスはそのまま公開URLになる。

| ルート | 要件 | 内容 |
| --- | --- | --- |
| `/pipeline/` | UI-01 | ホーム。テーマ入力＋最近のテーマ一覧 |
| `/pipeline/welcome/` | **新設（§2-2 必須）** | データ保存場所の説明。初回に必ず通す |
| `/pipeline/project/[id]/` | UI-02 | **生成ワークスペース。Phase 1 の主画面** |
| `/pipeline/settings/` | UI-07 | 文字数目安・口調・目標尺 |
| `/pipeline/data/` | **新設** | エクスポート／インポート／全削除 |
| `/pipeline/data-deletion/` | **新設** | Meta 提出用の削除案内（[legal/data-deletion-page-outline.md](./legal/data-deletion-page-outline.md)） |
| `/pipeline/keys/` | **新設（v0.6）** | Gemini APIキーの登録・確認・削除。取得手順の案内も |

**UI-03（動画プレビュー）は作らない**（§8）。UI-04 / UI-05 / UI-06 は Phase 2。/pipeline/api/* は **Phase 1 では1本も作らない**（v0.6）。

### 2-2. すべてクライアントコンポーネント

**データが利用者ブラウザにしか無いため、サーバーが描画できる利用者データが1つも無い。**
ページはシェルだけを返し、IndexedDB の読み書きはクライアントで行う。

これは guide §3-1 の「サーバーコンポーネントでの入口ガードが無いことを許容する」の
裏返しであり、**設計上の対**になっている。

### 2-3. UI-02（生成ワークスペース）の構造

プロトタイプ [prototype/content-pipeline-mvp.jsx](./prototype/content-pipeline-mvp.jsx) の
段階タブ構成を踏襲する。

```
┌─ ヘッダー: 一想 / テーマ名 / 保存先の注意（常時小さく） ─┐
├─ 段階タブ:  Threads → X → note → YouTube台本 ─────────┤
│   各タブに 未生成 / 生成中 / 下書き / 採用済み の状態表示  │
├─ 本文エリア: 生成結果（複数案はカード）                  │
│   [編集] [再生成] [採用]                                │
├─ 台本タブのみ: シーン一覧（順序・ナレーション・映像指示）  │
└─ フッター: 文字数カウント（媒体の上限に対する比率）        │
```

**段階間の依存を UI で表す**: 前段が未採用なら次段のタブを押せない（要件15章の
「前段の採用版を次段の主要入力とする」を操作で担保する）。

### 2-4. デザイントーン

プロトタイプの藍（`#1F2B45`）×朱（`#C7392B`）、明朝見出し、冷たい和紙（`#F4F5F2`）を
引き継ぐ。**`public/event/theme.css` と同じく `app/pipeline/` 用の CSS を独立させる**
（他アプリのスタイルへ影響させない）。

### 2-5. 初回説明画面（`/pipeline/welcome/`）

guide §2-2 が **Must** としている画面。`meta.welcomeSeen` が false なら
ホームからここへ誘導する。

伝える3点:
1. データはこのブラウザにだけ保存され、**当社のサーバーには送られない**
2. **PC とスマートフォンで同期しない。** ブラウザのデータを削除すると消える
3. **エクスポート**でいつでも JSON として保存できる（その場でボタンを出す）

> **「同意」ボタンにしない。** 法的な同意は利用規約側で取る。
> ここは仕様の説明であり、「理解しました」で進める。

---

## 3. LlmClient の段階別設定

> **v0.6 で全面的に差し替えた。** Anthropic（運営契約）→ **Gemini（利用者BYOキー）**。
> 骨子（段階別のトークン量・構造化出力・生成後検証・AC-09 の担保）は維持し、
> Gemini の相当機能へ写像している。

### 3-1. モデルと共通設定

| 項目 | 値 | 理由 |
| --- | --- | --- |
| プロバイダ | **Gemini（Google AI）** | v0.6 決定。既存の本番アプリと同じ（guide §3-2） |
| APIキー | **利用者のBYOキー。** `x-goog-api-key` ヘッダ | URLのクエリに載せない（`card-ocr/gemini.js` の既存判断） |
| 呼び出し元 | **ブラウザから直接** | CORS は本番で実証済み。**中継APIを実装しない** |
| エンドポイント | `https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent` | 既存アプリと同一 |
| SDK | **使わない。`fetch` で REST** | guide §1（外部SDK追加禁止） |
| JSON 出力 | **`responseSchema`（構造化出力）** | プロトタイプの正規表現によるコードフェンス剥がしは事故のもと |
| 出力上限 | `generationConfig.maxOutputTokens` | 段階別に設定（§3-2） |
| 失敗時 | **フォールバックモデルへ1回だけ退避** | 503（混雑）は実際に起きる（`card-ocr/config.js` の記録） |

> **`responseSchema` の `type` は大文字で書く。** 小文字だと 400 で弾かれる（proto の列挙型）。
> card-ocr のフェーズ0で SYS-999 の原因になった実績がある。**再発見しない。**

### 3-2. モデル選定案

リポジトリ内の本番アプリが実際に使っている（＝実キーで動作確認済みの）モデルから選ぶ。

| アプリ | 主モデル | フォールバック | 用途 |
| --- | --- | --- | --- |
| `receipt-ocr` | `gemini-3.6-flash` | `gemini-2.5-flash` | 領収書の読み取り・補完 |
| `audio-transcriber` | `gemini-3.6-flash`（推奨と表示） | `3.5-flash` → `2.5-flash` | 文字起こし |
| `card-ocr` | `gemini-2.5-flash-lite` | `gemini-3.5-flash-lite` | 名刺の抽出（**lite 系**） |

**一想の選定案**

| | モデル | 理由 |
| --- | --- | --- |
| **主** | **`gemini-3.6-flash`** | receipt-ocr と audio-transcriber が「推奨」として本番採用。**一想は長文生成が中心**で、抽出主体の card-ocr とは要求が違うため **lite 系は採らない** |
| **退避** | **`gemini-2.5-flash`** | receipt-ocr のフォールバックと同一。世代を落として可用性を取る |

> **card-ocr が lite 系なのは用途が違うから**であって、新しい世代が悪いからではない。
> ただし `card-ocr/config.js` に「**当初の主モデル `gemini-3.5-flash-lite` に 503 が続き、
> 入れ替えたら同じキー・同じリクエストで 6/6 成功**」という記録がある。
> **モデルの可用性は世代の新しさと一致しない。** 実測で決める姿勢を引き継ぐ。

> **【要確認】選定は実キーでの疎通確認をもって確定する。** モデルの提供状況は変わるため、
> `GET https://generativelanguage.googleapis.com/v1beta/models`（`portal.js` が既に使っている）
> で現在の一覧を取り、上の2モデルが存在することを確かめてから固定する。
> **利用者のキーで動くかどうかが最終的な判断基準**（無料枠キーでは使えるモデルが違うことがある）。

### 3-3. 段階別

`maxOutputTokens` は**出力だけ**を縛る（Anthropic の `max_tokens` と違い、思考ぶんを含まない）。

| 段階 | 目安の出力 | `maxOutputTokens` | 構造化出力 |
| --- | --- | --- | --- |
| `threads` | 50〜150字 × 3案 | 2,000 | 案の配列 |
| `x` | 150〜300字 | 1,500 | なし（テキスト） |
| `note` | 1,500〜3,000字 | 8,000 | 見出し＋本文＋タイトル候補 |
| `script` | シーン分割つき台本 | 8,000 | **シーン配列（§3-4）** |
| `metadata` | タイトル・概要・サムネ文言 | 2,000 | 3項目のオブジェクト |

> **`effort` に相当するパラメータは持たせない。** Anthropic 版では段階別に `effort` を
> 振っていたが、Gemini には同じ概念が無い。**モデル選択（flash / lite）が実質的な
> 調整つまみ**になる。段階ごとにモデルを変える案は、**まず単一モデルで実測してから**判断する。

> **数値は見込み。Phase 1 で実測して差し替える。** 特に `note`。
> **出力が途中で切れると JSON が壊れて段階ごと失敗する**（card-ocr が
> 400→700 に上げた理由と同じ。`MAX_OUTPUT_TOKENS` の注記を参照）。

### 3-4. `script` の構造化出力スキーマ（AC-09 の担保）

**`type` は大文字。** Gemini の `responseSchema` は proto の列挙型を取る。

```js
export const SCRIPT_SCHEMA = Object.freeze({
  type: 'OBJECT',
  properties: {
    scenes: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          narration:    { type: 'STRING' },
          visualPrompt: { type: 'STRING' },
          subtitle:     { type: 'STRING' },
        },
        required: ['narration', 'visualPrompt'],
      },
    },
  },
  required: ['scenes'],
});
```

**AC-09 をスキーマで担保する。** `narration` と `visualPrompt` を `required` にすることで、
「各シーンがナレーションと映像指示を持つ」がAPI側で保証される。

> 構造化出力は**空配列や空文字までは防げない**。生成後に
> 「`scenes.length >= 2` かつ各要素の `narration` / `visualPrompt` が非空」を
> 検証し、満たさなければ再生成する。**この検証が AC-09 の実装。**

### 3-4. システムプロンプト

プロトタイプの `RULES` を出発点にする（guide §0）。FR-033（事実の捏造禁止）は常時含める。

```
あなたは「1つの着想をThreads→X→note→YouTubeへ段階的に育てる」制作支援AIです。厳守事項:
- 前段の採用文を主要入力とし、中心の主張を全媒体で一致させる。文章量・構成・語り口だけを媒体に最適化する。
- 入力に無い数字・固有名詞・具体エピソードを決して創作しない。
- ユーザーが編集した表現をAI原案より優先して次段に反映する。
```

**プロトタイプの4行目「JSONのみを出力する。コードフェンスは付けない」は削る。**
構造化出力が形を保証するため不要で、二重に効くと出力が痩せる。

### 3-6. APIキーの保管（v0.6・中継APIの代わりに要るもの）

**中継APIが消えた代わりに、利用者のキーを預かる責任がブラウザ側に来る。**

既存の [public/auth/keystore.js](../../public/auth/keystore.js) と同じ方針を採る
（[keystore-spec-v1.md](../specs/keystore-spec-v1.md)）。**コードは複製する。import しない**
（`app/pipeline/` から `public/` は import できず、かつ本番アプリ間で共通層を作らない規約のため）。

| 方針 | 内容 |
| --- | --- |
| 保管場所 | **localStorage のみ。** IndexedDB には入れない（キーとコンテンツを混ぜない） |
| サーバー送信 | **しない。** 一想にはそもそも送り先が無い |
| 保存キー | 1件だけ。プロバイダーごとに分けない（消し忘れ防止・既存の判断） |
| ログアウト連動 | `public/auth/session.js` の `signOut()` が消す対象に含まれるか要確認 |
| 画面表示 | `/pipeline/keys/` で「登録済み / 未登録」を出す。**値そのものは再表示しない** |
| 保存できない環境 | プライベートモード等で localStorage が使えなくても**画面を壊さない**（既存 keystore と同じ） |

> **既存規約 第6条4項が「APIキーの保存の有無・場所・期間・保護方法を、
> 本サービスの画面又はプライバシーポリシーで別途表示する」と定めている。**
> `/pipeline/keys/` がその表示場所になる（[legal/existing-legal-inventory.md](./legal/existing-legal-inventory.md) §3-2）。

### 3-7. エラー処理

中継が無いぶん、**Gemini のエラーを利用者に直接見せることになる。**
`card-ocr/gemini.js` の `mapGeminiError` 相当（日本語文言への変換）を複製する。

| 状況 | 扱い |
| --- | --- |
| 401 / 403（キー不正） | 「APIキーを確認してください」＋ `/pipeline/keys/` への導線 |
| 429（レート/クォータ） | 「利用枠の上限に達しました」＋ Google 側の管理画面を案内 |
| 503（混雑） | **フォールバックモデルで1回だけ再試行**。それでも失敗なら時間を置く案内 |
| `finishReason` が `MAX_TOKENS` | **JSON が壊れている可能性。** 成功扱いにしない |
| `SAFETY` 等のブロック | 生成できなかった旨と、入力を見直す案内 |

> **`finishReason` の確認を落とさない。** 出力が途中で切れているのに成功扱いにすると、
> 壊れた JSON をパースして別のエラーとして現れ、原因が分からなくなる。

---

## 4. モジュール構成

```
lib/pipeline/
  db/
    open.mjs            IndexedDB の open とマイグレーション
    projects.mjs        projects の CRUD
    versions.mjs        versions の CRUD ＋ 採用の切り替え
    scenes.mjs          scenes の CRUD
    settings.mjs        settings / meta
    export.mjs          エクスポート／インポート（JSON）
  llm/
    types.d.mts         LlmClient / GenerateInput / GenerateResult
    gemini.mjs          Gemini 実装（fetch・BYOキー・フォールバック）
    errors.mjs          Gemini のエラー→日本語文言（card-ocr から複製）
    prompts.mjs         段階別プロンプト組み立て
    schemas.mjs         構造化出力のスキーマ
    stages.mjs          段階別の maxOutputTokens とモデル
  validate/
    scenes.mjs          AC-09 の検証（シーン構造）
  keys/
    keystore.mjs        Gemini APIキーの保管（public/auth/keystore.js から複製）
```

**`.mjs` ＋ `.d.mts` の対**を守る（`allowJs: false`）。
テストは `tests/unit/pipeline-*.mjs` として `tests/run.mjs` の `SUITES` へ追加する。

### テストの当て方

| 対象 | 方法 |
| --- | --- |
| `db/` | **`fake-indexeddb` を入れない**（外部SDK禁止）。IndexedDB の薄いラッパを自作しているので、**ラッパの下に注入できる形**にして、Node 側ではメモリ実装を差す |
| `llm/` | `fetchImpl` を差し替えて応答をスタブ |
| `validate/` | 純粋関数。そのまま |
| 画面 | Phase 1 では `tests/browser/` に最小の導線テスト |

---

## 5. 未確定・先に決めたいこと

| # | 事項 | 影響 | 待ち先 |
| --- | --- | --- | --- |
| 1 | **Gemini のモデル名の実機確認**（`gemini-3.6-flash` / `gemini-2.5-flash`） | `gemini.mjs` の定数 | 実キーでの疎通（§3-2） |
| 2 | 段階別 `maxOutputTokens` の実測値 | 出力の切れ＝JSON 破損 | Phase 1 内で実測 |
| 3 | `signOut()` が Gemini キーを消す対象に含まれるか | ログアウト時の挙動 | 実装時に `public/auth/session.js` を確認 |

**v0.6 で解決した待ち事項**

| 事項 | 結果 |
| --- | --- |
| 用語（「会員」か「利用者」か） | **「利用者」に確定・適用済み** |
| LLM の月次上限の初期値 | **撤廃**（BYOキーで費用が利用者負担のため） |
| カウンタの保存先 | **Phase 1 では不要**。Threads のみになり Phase 2 送り（guide §3-3） |

---

## 6. 実装順序（Phase 1 内）

```
1. db/          IndexedDB ラッパとスキーマ（テスト先行）
2. keys/ + llm/ キー保管 ＋ LlmClient（stage: threads だけで通す）
3. UI-02        1段階だけ動くワークスペース  ← ここで AC-01 の一部が立つ
4. 残り段階     x → note → script（script で AC-09）
5. 採用と派生   adopted / parentVersionId  ← AC-02
6. 一覧と再編集 UI-01 ＋ 再編集             ← AC-03
7. export/import ＋ welcome 画面
```

**3 の時点で通しで動くものが見える**ようにしてある。
段階を全部作ってから画面に取りかかると、最後まで動くものが無い期間が長くなる。

# 一想（ISSO）実装指示書 v1.0-personal（第1段：発注者専用）

**発注者**: TSアセットマネジメント合同会社（tsam-ai.com）
**作成日**: 2026年8月8日
**位置づけ**: [roadmap.md](./roadmap.md) の**第1段**。第2段（会員向け）は [archive/](./archive/) にある

**設計です。実装は承認後。**

---

## 1. 確定事項

| 項目 | 決定 | 決定日 |
| --- | --- | --- |
| 利用者 | **発注者1名** | 2026-08-07 |
| 画面 | **GAS HTML Service**（実行=自分／アクセス=自分のみ） | 2026-08-08 |
| 実装 | **素の HTML/JS。** React・ビルド不要 | 2026-08-08 |
| スマホ | ブラウザの**ホーム画面追加** | 2026-08-08 |
| UI 参照 | [prototype/content-pipeline-mvp.jsx](./prototype/content-pipeline-mvp.jsx) の**段階採用フローと藍×朱のトーン**（直接移植はしない） | 2026-08-08 |
| データ | 発注者の **Google Sheets** | 2026-08-07 |
| 生成 | **Workspace Studio Flows の組み込み Gemini**（APIキー不要） | 2026-08-07 |
| Threads / X | GAS から発注者の認証情報（Script Properties） | 2026-08-07 |
| note | **Helper へバトンを渡す。一想は Draft Bridge を実装しない** | 2026-08-08 |
| Helper | **1行も手を入れない** | 2026-08-08 |
| 置き場所 | **`gas-isso/`**（`gas-auth/` と同じ「配信しないソース置き場」。§8 で提案） | 本書で提案 |

---

## 2. 設計原則

### 2-1. 原本は必ず Sheets に残る

Note Draft Helper から引き継ぐ最上位の原則。

> **note アカウントに問題が起きても、書いたものは Sheets に残る。**

したがって:

- **生成・編集・採用は、必ず Sheets へ書いてから画面に反映する。** 画面の状態を正とせず、
  Sheets を正とする
- **投稿の成否にかかわらず本文を消さない。** 投稿できたかは別列で持つ
- 一想は note へ**直接投稿しない**。Helper の記事キューへ渡し、そこにも本文が残る

### 2-2. Draft Bridge のリスク管理（限定解除にともなう明文化）

[phase0_verification_plan_v0_1.md](./phase0_verification_plan_v0_1.md) §2 の限定解除を受けた原則。
**第1段の一想は Draft Bridge を実装しない**が、Helper 側で使う以上、原則はここに置く。

| 原則 | 具体 |
| --- | --- |
| **原本は必ず Sheets** | Bridge が壊れても、書いたものは失われない |
| **低頻度で使う** | 連続実行しない。1記事ずつ、人の操作で |
| **失敗時はコピー＆ペーストへフォールバック** | Bridge の失敗を握りつぶさず、コピー導線を出す |
| **最悪ケースはアカウント停止と割り切る** | 復旧できない前提で運用する。**業務上不可欠な用途に使わない** |
| **1か所に閉じる** | Bridge は Helper 側の1実装だけ。一想には持たない |

### 2-3. 第2段への移植性

[roadmap.md](./roadmap.md) §1 の3要件を満たす。

1. **段階別プロンプトは単一ソース**（§6）
2. **Sheets スキーマは会員版 `versions` への写像**（§4）
3. **移植マップを持つ**（[roadmap.md](./roadmap.md) §2 を本書の一部として参照）

---

## 3. 全体像

```
              ┌──────────────────────────────────────────┐
              │  一想（GAS プロジェクト gas-isso）        │
              │  実行=自分 / アクセス=自分のみ            │
              │                                          │
  ブラウザ ──▶│  HTML Service（画面）                    │
  （PC/スマホ）│      │ google.script.run                 │
              │      ▼                                   │
              │  GAS ロジック                             │
              └──────┬───────────────────┬───────────────┘
                     │                   │
                     ▼                   ▼
        ┌────────────────────┐   ┌──────────────────┐
        │ 一想スプレッドシート │   │ Threads / X API  │
        │  themes             │   │ （Script         │
        │  versions ★        │   │   Properties の  │
        │  scenes             │   │   認証情報）      │
        │  generation_queue ★│   └──────────────────┘
        │  posts              │
        │  settings           │
        └──────┬──────────────┘
               │ ①依頼を書く      ▲ ②結果を書き戻す
               ▼                  │
        ┌────────────────────────┴─┐
        │ Workspace Studio Flow     │  組み込み Gemini（APIキー不要）
        └───────────────────────────┘

               │ note 本文が確定したら
               ▼
        ┌──────────────────────────┐
        │ Helper の記事キュー Sheets │ ← 一想は1行 insert するだけ
        └──────────┬───────────────┘
                   ▼
        Note Draft Helper（既存・無改造）→ note
```

**一想は Gemini を直接呼ばない。** `generation_queue` を介して Flow に依頼する（§5）。

---

## 4. Sheets スキーマ

スプレッドシートは**1つ**。シートIDは Script Properties（`ISSO_SPREADSHEET_ID`）に置き、
コードに書かない（`gas-auth` と同じ流儀）。

### 4-1. `versions` — **中核。会員版 `versions` ストアへの写像**

**1行＝1版。** 列は [archive/phase1-design.md](./archive/phase1-design.md) §1-4 の項目に1対1で対応させる。

| 列 | 名前 | 会員版の項目 | 備考 |
| --- | --- | --- | --- |
| A | `version_id` | `id` | `ver_` + UUID |
| B | `theme_id` | `projectId` | |
| C | `stage` | `stage` | threads / x / note / script / metadata |
| D | `version_no` | `versionNo` | 同一 [theme_id, stage] 内の連番 |
| E | `parent_version_id` | `parentVersionId` | **どの採用版から派生したか**（要件10章の中核） |
| F | `adopted` | `adopted` | TRUE / FALSE。同一 [theme_id, stage] で**高々1件** |
| G | `edited_by_user` | `editedByUser` | TRUE / FALSE（要件15章） |
| H | `created_at` | `createdAt` | ISO 8601 |
| **I** | **`body`** | `body` | **最後に置く。** 長いので、前の列を読むのに横スクロールさせない |

> **移植のとき何が起きるか**: 列名を項目名へ読み替え、行をレコードへ変換するだけ。
> **`lib/pipeline/db/versions.mjs` の採用・派生のロジックがそのまま考え方として使える。**

### 4-2. `themes`

| 列 | 名前 | 会員版 |
| --- | --- | --- |
| A | `theme_id` | `id` |
| B | `title` | `title` |
| C | `audience` | `audience` |
| D | `memo` | `note` |
| E | `status` | `status`（draft / archived） |
| F | `created_at` | `createdAt` |
| G | `updated_at` | `updatedAt` |
| **H** | **`source_text`** | `sourceText` | **最後**（着想は長くなりうる） |

### 4-3. `scenes` — FR-043 / AC-09

| 列 | 名前 | 会員版 |
| --- | --- | --- |
| A | `scene_id` | `id` |
| B | `version_id` | `versionId`（`stage='script'` の版） |
| C | `order` | `order`（0始まり） |
| D | `narration` | `narration` **必須** |
| E | `visual_prompt` | `visualPrompt` **必須** |
| F | `subtitle` | `subtitle`（任意） |

**AC-09 の検証は第1段でも行う**（2件以上・D と E が非空）。実装は
`lib/pipeline/db/scenes.mjs` の `validateScenes()` と同じ判定を GAS で持つ。

### 4-4. `generation_queue` — **Flow との受け渡し口**

| 列 | 名前 | 備考 |
| --- | --- | --- |
| A | `request_id` | |
| B | `theme_id` | |
| C | `stage` | |
| D | `status` | **待機 / 処理中 / 完了 / 失敗** |
| E | `requested_at` | |
| F | `completed_at` | |
| G | `error` | Flow 側が失敗理由を書く |
| **H** | **`prompt`** | **GAS が組み立てた完全なプロンプト**（固定部分＋可変部分） |
| **I** | **`result`** | **Flow が書き戻す生成結果** |

**`prompt` を完全な形で渡す**ことで、**Flow は「H を読む → Gemini → I に書く → D を完了に」
だけの単純なものになる。** 段階ごとに Flow を作り分けなくてよい。

> **この設計は Workspace Studio Flows の能力に依存する**（§9 の確認事項②）。
> Sheets の行トリガと書き戻しができない場合は、**プロンプトを手で Studio へ貼り、
> 結果を手で I 列へ貼る**運用に落ちる。**その場合もシートの形は変えなくてよい。**

### 4-5. `posts` — 投稿の記録

| 列 | 名前 | 備考 |
| --- | --- | --- |
| A | `post_id` | |
| B | `theme_id` | |
| C | `version_id` | 投稿した版 |
| D | `platform` | threads / x / note |
| E | `status` | 成功 / 失敗 / **Helper へ引き渡し済み**（note の場合） |
| F | `posted_at` | |
| G | `url` | 公開URL。note は Helper 側で確定するため空になりうる |
| H | `error` | |

### 4-6. `settings`

`key` / `value` の2列。段階別の文字数目安・口調・目標尺（FR-012 / FR-032 / FR-042）。
既定値はコード側（`Config.gs`）に持ち、シートは上書き用。

---

## 5. 生成の流れ

```
1. 画面で「Threads 案を生成」
        ▼
2. GAS: 前段の採用版を集める（versions の adopted）
        ＋ 段階別プロンプト（生成された Prompts.gs）
        ＋ settings
        → 完全なプロンプトを組み立て、generation_queue に1行（status=待機）
        ▼
3. Flow: 待機行を拾う → Gemini → result に書く → status=完了
        ▼
4. 画面: 完了を検知（ポーリング or 手動更新）
        ▼
5. GAS: result を解釈して versions へ取り込む
        - threads は3案 → 3行
        - script は scenes へも展開し、AC-09 の検証をかける
        ▼
6. 画面で採用・手直し
```

> **4 のポーリングは控えめに。** GAS の実行時間とクォータを無駄に使う。
> **既定は「手動で更新」**とし、自動ポーリングを付けるなら 10 秒間隔程度に留める。

> **5 の取り込みで検証する。** `script` は AC-09 を満たさなければ**取り込まず失敗にする**
> （壊れた台本を versions に入れない）。再依頼は画面から。

---

## 6. 段階別プロンプト（単一ソース）

### 6-1. 置き場所と生成

[roadmap.md](./roadmap.md) §1 要件1 の実装。

```
lib/pipeline/prompts/
  definitions.mjs     ★単一ソース。段階ごとの役割・制約・出力形式
  definitions.d.mts
  flow-text.mjs       Flow へ貼るテキストの組み立て（純粋関数）
  gas-source.mjs      Prompts.gs の生成（純粋関数）
  build.mjs           上2つを呼んでファイルへ書き出す

生成物:
  gas-isso/Prompts.gs            ← 第1段の GAS が使う（手で編集しない）
  docs/pipeline/flow-text/*.txt  ← Flow へ貼る場合の版（手で編集しない）
```

**`lib/pipeline/` に置く理由**: ここは既に**段によらない一想のロジック**の置き場になっている
（`db/` は第2段向け）。第2段の `LlmClient` は `definitions.mjs` を**そのまま import** できる。
**同じ定義から、第1段の GAS と第2段の JS が生成される。**

> **なぜ2種類の生成物を出すか。** Flow が「H列を読んで I列に書く」形（§4-4）で組めれば
> `Prompts.gs` だけで足り、Studio の設定は Flow 1本で済む。組めない場合は
> 段階ごとに Flow を作って `flow-text/*.txt` を貼る運用になる。
> **どちらに転んでも単一ソースは保たれる。**

### 6-2. 定義に含めるもの・含めないもの

| 含める | 含めない |
| --- | --- |
| 段階ID・役割・前段からの引き継ぎ方 | モデル名 |
| 制約（**FR-033 の捏造禁止**を常時） | APIキー |
| 文字数・尺の目安（`settings` で上書き可） | トークン上限 |
| 出力形式（`script` のシーン構造＝AC-09） | 実行環境ごとの都合 |

**共通ルール**はプロトタイプの `RULES` を出発点にする（[roadmap.md](./roadmap.md) §1）。

```
あなたは「1つの着想をThreads→X→note→YouTubeへ段階的に育てる」制作支援AIです。厳守事項:
- 前段の採用文を主要入力とし、中心の主張を全媒体で一致させる。文章量・構成・語り口だけを媒体に最適化する。
- 入力に無い数字・固有名詞・具体エピソードを決して創作しない。
- ユーザーが編集した表現をAI原案より優先して次段に反映する。
```

> **手直しの傾向が見えたら定義側を直す。** 毎回同じ手直しをしているならプロンプトのバグ
> （[learnings.md](./learnings.md) §1）。**Studio 上で直接育てない。**

### 6-3. 段階別の骨子

| 段階 | 出力 | 形式 |
| --- | --- | --- |
| `threads` | 50〜150字 × **3案** | 案の区切りを明示 |
| `x` | 150〜300字 | テキスト |
| `note` | 1,500〜3,000字 | 見出し＋本文＋タイトル候補 |
| `script` | 話し言葉＋**シーン分割** | **シーンごとにナレーションと映像指示**（AC-09） |
| `metadata` | タイトル候補・概要・サムネ文言 | 3項目 |

> **Gemini の `responseSchema` は第1段では使えない**（Flow 経由のため）。
> 出力形式は**プロンプトで指示し、GAS 側で解釈する**。したがって
> **`script` の取り込みで AC-09 の検証が必須**（§5 の 5）。

---

## 7. GAS プロジェクト構成

Apps Script はフォルダを持たないため、リポジトリ側も平置きにする（`gas-auth/` と同じ）。

| ファイル | 役割 |
| --- | --- |
| `appsscript.json` | マニフェスト（タイムゾーン・スコープ・Webアプリ設定） |
| `Config.gs` | 定数・Script Properties の読み出し・既定の settings |
| `Main.gs` | `doGet()`（HTML Service）と画面から呼ぶ入口関数 |
| `Sheets.gs` | 5シートの読み書き（この1本だけが SpreadsheetApp を触る） |
| `Themes.gs` | テーマの作成・一覧・更新 |
| `Versions.gs` | **採用・派生・上流収集**（`lib/pipeline/db/versions.mjs` と同じ考え方） |
| `Scenes.gs` | シーンの保存と **AC-09 の検証** |
| `Generation.gs` | プロンプト組み立て → `generation_queue` へ依頼 → 結果の取り込み |
| `Prompts.gs` | **生成物**（§6-1）。手で編集しない |
| `Threads.gs` | Threads 投稿 |
| `X.gs` | X 投稿 |
| `Helper.gs` | **Helper の記事キューへバトンを渡す**（§7-2） |
| `Logs.gs` | 実行記録（シートに残す） |
| `Tests.gs` | GAS 上で走らせる自己テスト（`gas-auth/Tests.gs` と同じ流儀） |
| `Index.html` / `Style.html` / `Script.html` | 画面（§8） |

### 7-1. `Sheets.gs` だけが SpreadsheetApp を触る

`lib/pipeline/db/` でポートを1ファイルに閉じたのと同じ理由。
**`Versions.gs` と `Scenes.gs` のロジックを、シート操作から切り離す。**
`Tests.gs` から偽のシート実装を差せる形にする。

### 7-2. Helper へのバトン渡し（`Helper.gs`）

**Helper には1行も手を入れない。** 一想が Helper の記事キューへ**1行 insert するだけ**。

```
一想（note 本文が確定・採用済み）
        ▼
Helper の記事キュー Sheets へ1行追加
  記事状況 = 「記事生成完了」  ← Helper が拾う状態
        ▼
Note Draft Helper の既存導線（取得 → コピー → note）がそのまま動く
```

- 書き込み先は Script Properties（`HELPER_SPREADSHEET_ID` / `HELPER_SHEET_NAME`）
- 一想側は `posts` に `platform='note'`, `status='Helper へ引き渡し済み'` を記録
- **公開URLは Helper 側で確定する**ため、一想の `posts.url` は空のままでよい

> **列定義が未確定。** §9 の確認事項① で実物から特定する。

---

## 8. 画面（HTML Service）

**素の HTML/JS。ビルドなし。** `Index.html` に `Style.html` と `Script.html` を
`include()` で差し込む（GAS HTML Service の定石）。

### 8-1. 画面遷移

ルーターは持たず、**1ページ内で表示を切り替える**（HTML Service は単一URL）。

```
[テーマ一覧]  ──選択──▶  [ワークスペース]  ──▶  [設定]
      │                      │
   新規作成               段階タブ
                       Threads / X / note / 台本
```

### 8-2. ワークスペース（主画面）

プロトタイプの**段階採用フロー**を引き継ぐ。

```
┌─ 一想 / テーマ名 ───────────────────────┐
├─ 段階タブ: Threads → X → note → 台本 ──┤
│    各タブに 未生成 / 依頼中 / 下書き / 採用済み │
├─ 本文エリア                              │
│    複数案はカードで並べる（threads は3案）  │
│    [手直し] [採用] [再依頼]               │
├─ 台本タブのみ: シーン一覧                  │
│    順序 / ナレーション / 映像指示           │
└─ フッター: 文字数（媒体の目安に対する比率） ┘
```

- **前段が未採用なら次段タブを押せない**（要件15章を操作で担保）
- **依頼中は「更新」ボタンを出す**（Flow の完了を取りに行く）
- 採用済みの note があれば **「Helper へ送る」ボタン**を出す

### 8-3. トーンとスマホ

- 藍 `#1F2B45` × 朱 `#C7392B`、冷たい和紙 `#F4F5F2`、明朝見出し（プロトタイプ準拠）
- **スマホ優先で組む。** ホーム画面追加で使うため、320 / 375px で崩れないこと
- セマンティックHTMLとネイティブ要素を優先（[AGENTS.md](../../AGENTS.md)）

> **GAS HTML Service は iframe 内で動く。** `window.open` やクリップボードAPIに
> 制約が出る場合があるため、**コピー機能は実機で確認する**（§9 の確認事項④）。

---

## 9. 発注者に確認したいこと（実装前）

> **番号を振り直した（2026-08-09）。** 当初の表は 1=Flows / 2=Helper だったが、
> 実際のやり取りでは **①=Helper / ②=Flows** で通っていた。
> **番号がずれたまま「①待ち」と言うと、待っているものが食い違う。**
> やり取りで使っている側に合わせる。

| # | 確認事項 | なぜ要るか | 何が止まるか |
| --- | --- | --- | --- |
| **①** | **Helper の記事キューの列定義** | §7-2 のバトン渡しに必須 | **実装順序8**、手順書 §F・§G-4 |
| **②** | **Workspace Studio Flows は Sheets の行を読み、同じ行に書き戻せるか** | §4-4 の設計が成立するか。できなければ「手で貼る」運用に落とす（**シートの形は変えなくてよい**） | 手順書 §C・§G-2。**実装は止まらない** |
| ~~**③**~~ | ~~Threads / X の認証情報の形式~~ | **回答済み（2026-08-09）。下記** | — |
| ④ | HTML Service 上でのコピー動作 | §8-3 | 何も止めない。**手順書 §G-1 で分かる** |

> **止まっているのは①だけ。** ②は「手で貼る」運用で代替でき、
> **④は G-1 を通せば自然に分かる。**

### 確認事項③の回答（2026-08-09）と、そこから決まったこと

**Threads / X の自動投稿基盤は既存に無い。既存の自動化は note（Helper）のみ。**
認証情報も未取得。したがって**実装順序7は新規取得を前提とする。**

| | 前提 | 決まったこと |
| --- | --- | --- |
| **Threads** | D-4 先行確認で取るトークンを**そのまま本運用の資格情報にする**（開発モード・自分のアカウント） | **短期トークンのままにできない。** 長期トークン（60日）への交換と自動更新を実装する。`THREADS_APP_ID` / `THREADS_APP_SECRET` を Script Properties に持つのはこのため |
| **X** | 発注者自身の X Developer アカウントを**新規に作る**。従量課金の有効化から | **OAuth 1.0a（自分のアカウントのアクセストークン）を使う。** 認可のリダイレクトを受けるページが要らず、トークンに期限が無い。署名は `Utilities.computeHmacSignature` で足りる（**外部ライブラリを足さない**） |
| **X の課金** | **投稿ごとに発注者へ課金される** | **一想側にも月次上限を持つ**（設定値 `x.monthlyPostLimit`。`posts` シートの当月件数で判定）。**外部サービスの課金を、外部サービスの設定だけに頼らない** |

> **X の料金体系は「無料枠がある」前提で書かない。** 2026年時点では
> **Free プランは廃止され従量課金へ移行した**という情報がある。
> [setup-v1_0-personal.md](./setup-v1_0-personal.md) §E-0 は、**どちらも前提にせず
> コンソールで実測してから進む**中立な手順にしてある。
> **実装は課金形態に依存しない**（無料でも従量でも同じ経路で投稿する）。
> 依存するのは `x.monthlyPostLimit`（既定 **60件/月**）だけで、これは
> **課金額ではなく件数で止める**ため、単価が変わっても見込みが変わらない。

### 確認事項①：Helper 記事キューの特定手順

**次のどちらかで教えてください。値そのものは不要で、構造だけで足ります。**

**方法A（速い）**: 記事キュー Sheets を開き、**1行目（見出し行）をそのままコピーして貼る**。
あわせて、A列から順に**どの列が何か**を1行で。

**方法B（確実）**: Helper の GAS プロジェクト（`noteArticleApi.js`）を開き、
**先頭の定数定義（シート名・列番号・状態値）をコピーして貼る**。

**あわせて知りたいこと**

1. **記事状況（H列）に取りうる値の全部**
   （既知: 記事生成完了 / 取得済 / Note記事作成済 / 下書き作成エラー。**他にありますか**）
2. **`newsId` の採番規則**（連番 / 日付 / UUID など）。一想が新規行を作るときに必要
3. **一想が空にしてはいけない列**（空だと Helper が壊れる列）
4. **1行目が見出し行か**、データは2行目からか

---

## 10. 実装順序

```
1. lib/pipeline/prompts/     単一ソースと生成（Node 側・テスト先行）
2. gas-isso/ の骨組み        Config / Sheets / Tests
3. Themes / Versions         採用・派生（Tests.gs で固定）
4. Generation                依頼 → 取り込み。**Flow 抜きで手動投入から通す**
5. 画面（1段階だけ）          ここで通しで動くものが見える
6. 残りの段階 → 台本（AC-09）
7. Threads / X 投稿
8. Helper バトン渡し
```

**4 を「Flow 抜き」で先に通す。** `generation_queue` の I 列に手で結果を貼れば
取り込みが検証できる。**Flow の設定（確認事項②）を待たずに進められる。**

---

## 11. 移植マップ

[roadmap.md](./roadmap.md) §2 を本書の一部とする。実装が変わるたびに更新する。

---

## 12. 手順書の目次（別文書として作成）

**→ [setup-v1_0-personal.md](./setup-v1_0-personal.md) として作成済み（2026-08-09）。**
以下は元の目次。**本節ではなく手順書のほうを更新する。**

```
A. スプレッドシートの用意
   A-1. 一想スプレッドシートを作る（5シート）
   A-2. シートIDを控える
B. GAS プロジェクト
   B-1. スタンドアロンで新規作成（**Helper とは別プロジェクト**）
   B-2. gas-isso/ のファイルを貼る（または clasp push）
   B-3. Script Properties を設定
        ISSO_SPREADSHEET_ID / HELPER_SPREADSHEET_ID / HELPER_SHEET_NAME
        THREADS_* / X_*
   B-4. 初期化関数を実行して権限を承認
   B-5. **ウェブアプリとしてデプロイ（実行=自分／アクセス=自分のみ）**
   B-6. URL をスマホのホーム画面に追加
C. Workspace Studio Flow
   C-1. Flow を作る（generation_queue の待機行を拾う）
   C-2. Gemini ステップを置く
   C-3. 結果を I 列へ、状態を D 列へ書き戻す
   C-4. 手動実行で1件通す
   （Flow が組めない場合の代替: プロンプトを手で貼る運用）
D. Threads
   D-1. Meta アプリを開発モードのまま用意
   D-2. **自分のアカウントにアプリのロールを付与**
   D-3. 認証情報を Script Properties へ
   D-4. **開発モードのまま投稿できることを確認**（第1段の最初の検証項目）
E. X
   E-1. 認証情報を Script Properties へ
   E-2. テスト投稿
F. Helper との接続
   F-1. Helper の記事キューのIDとシート名を Script Properties へ
   F-2. 一想から1行書き出し、Helper 側で取得できることを確認
G. 通し確認
   G-1. 着想 → Threads → X → note → 台本
   G-2. note を Helper へ送り、既存導線で note まで
   G-3. learnings.md に1本目の記録を書く
```

> **D-4 が第1段の最初の検証項目**（[learnings.md](./learnings.md) §3）。
> ここが通らないと Threads 連携が成立しないため、**B より先に確認してもよい。**

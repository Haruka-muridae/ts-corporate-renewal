# 一想（ISSO）ロードマップ — 2段階提供

**最終更新**: 2026年8月8日

一想は**最終的にポータル会員向けとして提供する。** 現在の個人ツール化は方針撤回ではなく、
**2段階ロードマップの第1段**である。

```
第1段（いま）                        第2段（将来）
発注者専用・個人ツール         ──▶   ポータル会員向け提供
Workspace Studio Flows              Next.js + 会員のブラウザ
 + GAS + Sheets + Helper へバトン渡し    + 利用者BYOキー / 非保持アーキテクチャ

出発点: Note Draft Helper           出発点: docs/pipeline/archive/
```

| 段 | 状態 | 実装指示書 |
| --- | --- | --- |
| **第1段** | **設計完了・承認待ち** | [implementation-guide-v1_0-personal.md](./implementation-guide-v1_0-personal.md) |
| **第2段** | 設計完了・実装は `lib/pipeline/db/` のみ | [archive/implementation-guide.md](./archive/implementation-guide.md) v0.6 |

> **第2段は「いつか考えること」ではなく、設計が既にある。**
> 会員向けの実装指示書 v0.6・法務起案・Platform Adapter 設計案は
> [archive/](./archive/) に揃っている。第1段はそこへ**合流できる形**で作る。

---

## 1. 第1段の設計要件：**第2段への移植性**

第1段を「使い捨ての個人ツール」として作らない。**第2段で捨てる部分と持ち越す部分を、
最初から分けておく。**

### 要件1: 段階別プロンプトは**単一ソース**で管理する

段階別プロンプト（Threads / X / note / 台本 / メタデータ）は**1か所で定義**し、
そこから2つの出力を生成する。

```
            プロンプト定義（単一ソース）
                     │
        ┌────────────┴────────────┐
        ▼                          ▼
  第1段: Flow に貼る指示文      第2段: LlmClient が読む定義
  （プレーンテキスト。          （archive/phase1-design.md §3-4
    発注者が Studio へ貼る）      の prompts.mjs 相当）
```

**手で2か所を保つ形にしない。** Flow の指示文を Studio 上で直接育てると、
第2段で「どれが最新か」が分からなくなる。**Studio へ貼るテキストは生成物**とし、
定義側を直して貼り直す運用にする。

> **定義に含めるもの**: 段階ID・役割・制約（FR-033 の捏造禁止を含む）・
> 文字数や尺の目安・出力スキーマ（台本のシーン構造＝AC-09）。
> **含めないもの**: モデル名・APIキー・トークン上限（実行環境ごとに違うため）。

> **置き場所は `lib/pipeline/prompts/` に確定**（v1.0-personal §6-1）。
> ここから第1段の `gas-isso/Prompts.gs` と、Flow へ貼るテキストを生成する。

### 要件2: Sheets スキーマは**会員版 DB スキーマへの写像**を意識する

第2段の中核は `versions`（[archive/phase1-design.md](./archive/phase1-design.md) §1-4）である。
**Sheets の列をこれに対応させる。**

| Sheets の列（案） | 会員版 `versions` の項目 | 役割 |
| --- | --- | --- |
| テーマID | `projectId` | 1着想＝1テーマ |
| 段階 | `stage` | threads / x / note / script / metadata |
| 本文 | `body` | |
| 版番号 | `versionNo` | 同一 [テーマ, 段階] 内の連番 |
| 派生元 | `parentVersionId` | **どの採用版から派生したか**（要件10章の中核） |
| 採用 | `adopted` | 同一 [テーマ, 段階] で高々1件 |
| 手直し | `editedByUser` | 要件15章「AI原案よりユーザー編集を優先」 |
| 作成日時 | `createdAt` | |

**1行＝1版**にする。Helper の記事キュー（1記事＝1行のフラット構造）とは別のシートになる。

> **移植のとき何が起きるか**: 列名を項目名へ読み替え、行を `versions` レコードへ
> 変換するだけになる。**構造が違うと、この移植が「作り直し」になる。**

> **台本のシーン**は `scenes` に対応する別シート（[archive/phase1-design.md](./archive/phase1-design.md) §1-5）。
> AC-09 の検証（2件以上・ナレーションと映像指示が非空）は**第1段でも行う**。

### 要件3: v1.0-personal に「移植マップ」の章を設ける

下の §2 をそのまま v1.0-personal の一章として持ち、**実装が変わるたびに更新する。**

---

## 2. 移植マップ（第1段 → 第2段）

**v1.0-personal の該当章の下敷き。** 設計が固まったら数値や名称を具体化する。

| 構成要素 | 第1段（個人版） | 第2段（会員版） | 第2段の出典 |
| --- | --- | --- | --- |
| **生成AI** | Workspace Studio Flows の組み込み Gemini（**APIキー不要**） | 利用者BYOキーの Gemini（ブラウザから直接） | [v0.6](./archive/implementation-guide.md) §2-3・§3-2 |
| **プロンプト** | Flow に貼る指示文（**生成物**） | `LlmClient` の `prompts.mjs` | [phase1-design](./archive/phase1-design.md) §3-4 |
| **データの置き場所** | 発注者の Google Sheets | 利用者ブラウザの IndexedDB（**非保持**） | [phase1-design](./archive/phase1-design.md) §1 |
| **画面** | **GAS HTML Service**（素の HTML/JS） | Next.js `app/pipeline/` | [phase1-design](./archive/phase1-design.md) §2 |
| **認証** | GAS Webアプリ **実行=自分／アクセス=自分のみ** | `tsam-auth-session` を案A（Authorization ヘッダ）で | [v0.6](./archive/implementation-guide.md) §3-1 |
| **note 投稿** | **Helper へバトンを渡す**（一想は Draft Bridge を実装しない） | **整形コピー＋note下書きエディタ遷移**（FR-065） | 検証計画 §2 / T4 |
| **Threads 投稿** | GAS から発注者の認証情報（Script Properties） | OAuth。トークンは利用者ブラウザ、サーバー非保存 | [v0.6](./archive/implementation-guide.md) §2-3 |
| **Threads の審査** | **開発モードのまま自分のアカウントへ**（App Review 不要の想定） | **Meta App Review が必要**（申請文面は作成済み） | [phase0/review-submissions](./archive/phase0/review-submissions.md) §2 |
| **X 投稿** | GAS から発注者の認証情報（Script Properties） | 利用者のBYOキー（公開クライアント＋PKCE が第一候補） | [v0.6](./archive/implementation-guide.md) §2-3 |
| **利用量カウンタ** | **不要**（利用者1名） | **Threads のみ必要**（共有アプリの24h/250を守るため） | [v0.6](./archive/implementation-guide.md) §3-3 |
| **上限・許可リスト** | 不要 | 段階公開の許可リスト | [v0.6](./archive/implementation-guide.md) §3-4 |
| **法務文書** | 不要（第三者へ提供しない） | 個別規約＋プライバシー補遺（**起案済み・未承認**） | [archive/legal/](./archive/legal/) |
| **データ削除案内** | 不要 | Meta 提出用ページ（構成案あり） | [archive/legal/data-deletion-page-outline.md](./archive/legal/data-deletion-page-outline.md) |
| **受入条件** | AC-01〜03 / AC-09 を維持 | 同左＋ AC-04 / 05 / 08 | 要件17章 |

### 移植のときに**捨てるもの・持ち越すもの**

| | 内容 |
| --- | --- |
| **持ち越す** | プロンプト定義／段階と採用の考え方／AC-09 の検証ロジック／Sheets の行構造（→ `versions`）／第1段の運用で得た学び（[learnings.md](./learnings.md)） |
| **捨てる** | GAS の Web アプリ層／Sheets そのもの／Script Properties の認証情報／Helper へのバトン渡し |
| **作り直す** | 画面（GAS HTML Service → Next.js）／認証／投稿経路 |

> **「捨てる」ものが多く見えるが、それでよい。** 第1段の目的は
> **プロンプトと体験を実地で固めること**であり、配管は第2段で作り直す前提。
> 配管を第2段に合わせて作り込むと、第1段が重くなって目的を外す。

---

## 3. 第2段へ進む判断

第1段の運用で [learnings.md](./learnings.md) の観点を記録し、それを材料に判断する。

**第2段の設計は既にある**ため、判断すべきは「作れるか」ではなく
**「会員に出せる品質か」「出す価値があるか」**である。

| 判断の入口 | 見るもの |
| --- | --- |
| 品質 | プロンプトが安定して使える水準か（learnings §1） |
| 体験 | 段階採用のUXが機能しているか（learnings §2） |
| 制約 | Threads の 24h 上限が現実的か（learnings §3） |
| 実現性 | note の投稿導線が成立するか（learnings §4） |
| 価値 | 1テーマあたりの所要時間が短縮されているか（learnings §5） |

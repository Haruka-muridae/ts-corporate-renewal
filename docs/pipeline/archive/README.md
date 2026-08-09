# 第2段（ポータル会員向け提供）の出発点

**作成**: 2026年8月7日 ／ **最終更新**: 2026年8月8日
**位置づけ**: 一想の **2段階ロードマップ第2段**（[../roadmap.md](../roadmap.md)）の設計資産

**ここは「凍結庫」ではない。** 一想は最終的にポータル会員向けとして提供する。
第1段（発注者専用の個人ツール）を経て第2段へ進むとき、**設計はここから再開する。**

> **第2段は「いつか考えること」ではない。** 実装指示書 v0.6・Phase 1 設計・法務起案・
> Meta の申請文面まで**すでに揃っている。** 第1段は、ここへ**合流できる形**で作る
> （移植性の要件は [../roadmap.md](../roadmap.md) §1、対応関係は §2 の移植マップ）。

---

## 1. 第2段を再開するときに読む順序

| # | 文書 | 何が書いてあるか |
| --- | --- | --- |
| 1 | [../roadmap.md](../roadmap.md) | **まずここ。** 第1段からの移植マップ。何を持ち越し、何を作り直すか |
| 2 | [../learnings.md](../learnings.md) | **第1段の運用で得た事実。** 会員に出せる品質か・出す価値があるかの判断材料 |
| 3 | [implementation-guide.md](./implementation-guide.md) | **v0.6。会員向けの実装指示書。改訂履歴に v0.2〜v0.6 の決定経緯が全部ある** |
| 4 | [phase1-design.md](./phase1-design.md) | Phase 1 の設計（IndexedDB スキーマ・画面構成・LlmClient の段階別設定） |
| 5 | [platform-adapter-and-llm-client.md](./platform-adapter-and-llm-client.md) | Platform Adapter の抽象と `LlmClient` インターフェース |
| 6 | [legal/existing-legal-inventory.md](./legal/existing-legal-inventory.md) | 既存の利用規約23条・プライバシーポリシー16節との整合分析 |
| 7 | [legal/isso-individual-terms-draft.md](./legal/isso-individual-terms-draft.md) | 個別規約とプライバシー補遺の起案（**発注者未承認**） |
| 8 | [phase0/review-submissions.md](./phase0/review-submissions.md) | Meta App Review の申請文面（**完成済み・未提出**） |
| 9 | [phase0/owner-tasks.md](./phase0/owner-tasks.md) | 発注者のアカウント操作タスク |
| 10 | [verification/](./verification/) | Phase 0 検証トラック T1〜T6 |

## 2. 復元するときのパス

`verification/` は元は**リポジトリルートの `verification/pipeline/`** にあった。
`run.mjs` は自ディレクトリからの相対パスで動くため、**ディレクトリごと戻せばそのまま動く。**

```
docs/pipeline/archive/verification/  →  verification/pipeline/
```

戻したら [../../repository-structure.md](../../repository-structure.md) §5 と
ルート `CLAUDE.md` の表にも `verification/pipeline/` を書き戻すこと。

## 3. 再開前に必ず確認すること

**外部サービスの仕様と審査要件は、第1段の運用中に変わる。**

- Meta App Review の要件（[phase0/review-submissions.md](./phase0/review-submissions.md) §2）
- Threads / X の API 仕様とレート制限 — **第1段の実測が [../learnings.md](../learnings.md) §3 にある**
- 既存の利用規約・プライバシーポリシーの版
  （[legal/existing-legal-inventory.md](./legal/existing-legal-inventory.md) は 2026-08-07 時点の本文に基づく分析）

---

## 4. 第2段送りにしたタスク（**廃止ではない**）

第1段では**利用者が発注者1名**であるため不要になったもの。
**第2段で再開する。** 理由まで記録してあるのは、再開時に「なぜ止めていたか」を
読み違えないため。

| タスク | 場所 | 第1段で不要な理由 | **第2段で復活する条件** |
| --- | --- | --- | --- |
| **法務（A系）全般** | [phase0/owner-tasks.md](./phase0/owner-tasks.md) | 第三者へ提供しないため、個別規約・プライバシー補遺が不要 | **会員へ提供する時点で必要。** 起案は済んでいるので、既存規約の版と突き合わせて出す |
| **Meta App Review の提出** | 同 D系 ／ [phase0/review-submissions.md](./phase0/review-submissions.md) | 開発モードのまま発注者自身のアカウント（アプリにロール付与）へ投稿する想定 | **発注者以外が使う時点で必要。** 申請文面は完成済み。Phase 2 の投稿導線と録画が前提 |
| **カウンタ**（Threads 日次上限・保存先選定 T6-4） | 同 E系 ／ [verification/tracks/T6-common.mjs](./verification/tracks/T6-common.mjs) | 利用者が1名のため、共有資源の枯渇も利用者間の公平性の問題も生じない | **利用者が2名以上になった時点で必要。** 初期値は [../learnings.md](../learnings.md) §3 の実測から決める |
| 段階公開の許可リスト | 同 E-1 | 同上 | 同上 |
| データ削除案内ページ | [legal/data-deletion-page-outline.md](./legal/data-deletion-page-outline.md) | Meta 提出物であり、審査不要なら不要 | Meta App Review と同時 |

> ### カウンタの理由を読み違えないこと
>
> 会員向けでは「**原価防衛ではなく利用者間の公平性**」が残す理由だった（v0.6 §3-3）。
> 発注者名義の Meta アプリを全利用者で共有し、**24時間250件の上限がアプリ単位で効く**ため、
> 1人が使い切ると他の利用者が投稿できなくなる。
>
> **利用者が1名になるとこの理由自体が消える。** 第2段で利用者が増えた瞬間に**復活する。**
> 第1段の実測（1人が1日何件使うか）が、そのまま**会員数の天井**を決める材料になる。

---

## 5. 第2段の設計はどこまで終わっていたか

再開時に「どこから手を付けるか」を判断するための記録。

### 終わっていたこと

| 領域 | 状態 |
| --- | --- |
| 実装指示書 | **v0.6 まで確定**（Gemini BYOキー・データ非保持・MVP スコープ縮小・用語統一） |
| Phase 1 設計 | **完了・発注者承認済み** |
| Meta App Review の申請文面 | **完成。** 提出は Phase 2 の録画待ちだった |
| 法務の整合分析 | **完了。** 既存規約が「利用者が自分のキーで外部AIを使う」前提で書かれており、Gemini がそのまま乗ることを確認 |
| 個別規約・プライバシー補遺 | **起案済み。** 発注者の確認待ちだった（素材に無い追加4件の採否を含む） |
| 受入条件 | AC-09 を新設し、AC-06/07 を拡張フェーズへ |

### 終わっていなかったこと

| 項目 | 状態 |
| --- | --- |
| Phase 0 の実測（T1・T2・T4・T6） | **未実施。** 実アカウント・実キーが要るため。**第1段の運用が実質的にこれを兼ねる** |
| Meta App Review の提出 | **未提出** |
| 法務の承認・公開 | **未承認。** `public/legal/` への反映は行っていない |
| Phase 1 の実装 | **`lib/pipeline/db/` のみ完了**（下記） |

---

## 6. `lib/pipeline/db/` の扱い（**ここには移していない**）

第2段向けの唯一の実装が `lib/pipeline/db/`（IndexedDB 層・テスト89件）。
**アーカイブへ移していない。**

| 論点 | 内容 |
| --- | --- |
| 第1段では**使わない** | データは発注者の Google Sheets に置くため、IndexedDB は要らない |
| **第2段ではそのまま使える** | 会員版の設計（[phase1-design.md](./phase1-design.md) §1）そのものの実装 |
| **第1段でもロジックは効く** | `versions.mjs` の採用・派生の判定と `scenes.mjs` の AC-09 検証は、**保存先が Sheets に変わっても同じ**（[../roadmap.md](../roadmap.md) §1 要件2） |

**第2段で再利用する前提なので、消さずに残す。** 通っているテスト
（`tests/unit/pipeline-db.mjs`）も止めない。第1段の設計時に、
Sheets 版と考え方を揃えるための**参照実装**として使う。

# Phase 0 検証（コンテンツ自動展開・投稿アプリ）

[docs/pipeline/phase0_verification_plan_v0_1.md](../../docs/pipeline/phase0_verification_plan_v0_1.md)
の T1〜T6 を実行し、Go / 条件付きGo / No-Go を証拠付きで記録するための枠組み。
追加・変更項目は [implementation-guide.md](../../docs/pipeline/implementation-guide.md) §4 に従う。

---

## これはテストではない

**`npm test` からは実行されない。CI でも走らない。** 意図的にそうしてある。

| | `tests/` | `verification/pipeline/` |
| --- | --- | --- |
| 目的 | 実装が仕様どおりか | 外部依存が成立するか・いくらかかるか |
| 対象 | 自分たちのコード | Threads / X / YouTube / TTS / Supabase 等の実サービス |
| 外部通信 | しない（スタブ） | **する。実アカウント・実課金に触れる** |
| 資格情報 | 不要 | 必要 |
| 実行者 | 誰でも・何度でも | 担当者が意図して1回ずつ |
| 結果 | pass / fail | 実測値と判定（Go / 条件付きGo / No-Go） |

CI に入れると、secrets を CI へ置くことになり、かつ push のたびに外部APIを叩いて
課金とレート制限を消費する。**入れないことが設計判断である。**

---

## 実行

```powershell
node verification/pipeline/run.mjs            # 自動実行できる項目をすべて
node verification/pipeline/run.mjs T1         # トラック単位
node verification/pipeline/run.mjs T3-2       # 項目単位
node verification/pipeline/run.mjs --list     # 項目の一覧と種別を出す
node verification/pipeline/run.mjs --plan     # 何を実行するかだけ出して終了（通信しない）
```

資格情報はリポジトリに置かない。`verification/pipeline/.env.local`（gitignore 済み）か、
シェルの環境変数で渡す。必要な変数は `--list` が項目ごとに表示する。

---

## 項目の種別

| 種別 | 意味 | 誰が |
| --- | --- | --- |
| `auto` | Node から実行できる。実行すると結果が記録される | スクリプト |
| `browser` | ブラウザでしか確認できない（CORS・OPFS・Web Push・Resumable Upload） | 担当者が `probes/` のページを開く |
| `manual` | アカウント操作・審査提出・目視判断 | 発注者（[docs/pipeline/phase0/owner-tasks.md](../../docs/pipeline/phase0/owner-tasks.md)） |

`auto` 以外は実行されず、`--list` に「担当」として出る。**自動化できないものを
自動化できるふりをしない**ため、種別を明示している。

---

## 結果の記録

- `results/T1.md` 〜 `results/T6.md` — 人が読む判定と考察。**手で書き足す前提**
- `results/raw/*.json` — スクリプトが書いた実測値。手で編集しない

`results/` はコミットする（Phase 0 の成果物そのもののため）。ただし
**トークン・APIキー・実在するメールアドレス・内部URLを書かない。**
`lib/record.mjs` の `redact()` が既知の形（`sk-`・`Bearer `・`whsec_` 等）を伏せるが、
**最後の確認は人間が行う。** `docs/` と同じく、リポジトリは公開されている。

---

## トラック一覧（v0.5）

| ID | 内容 | 状態 |
| --- | --- | --- |
| T1 | Threads API | **MVP 対象。** 追加: ブラウザからの直接呼び出し（CORS）可否 |
| T2 | X API | **MVP 対象。** BYOキー前提。公開クライアント + PKCE を第一候補に検証 |
| T3 | YouTube Data API | **★凍結**（拡張フェーズ送り。[FROZEN.md](./FROZEN.md)） |
| T4 | note フォールバック体験 | **MVP 対象。** 変更なし |
| T5 | TTS・動画レンダリング | **★凍結**（拡張フェーズ送り。[FROZEN.md](./FROZEN.md)） |
| T6 | 共通基盤 | **MVP 対象。** ただし T6-2 のみ凍結（対象が消滅）。T6-5（Web Push）は Threads / X のリマインダーに必要なため**継続** |

凍結トラックは「すべて実行」に含まれないが、**名指しすれば動く**（`run.mjs T3`）。
凍結の理由と再開手順は [FROZEN.md](./FROZEN.md)。

---

## 非保持方針との関係

guide §2 により、検証の対象が元の計画から変わっている項目がある。

- **T6-1（OAuthトークンの暗号化保管）は実施しない。** 保管しないため。
  代わりに「トークンがサーバーに残らないこと」を確かめる項目へ置き換えた。
- **T6-2（ジョブキューの冪等性）は凍結。** 予約投稿がリマインダー方式になり、
  残っていたレンダリングも v0.5 で拡張フェーズへ送られたため、
  **サーバー側に冪等性を要するジョブが1つも無くなった**（[FROZEN.md](./FROZEN.md)）。
- **T1 にブラウザ直接呼び出しの検証が加わった。** 中継を外せるほど
  サーバーが触るものが減り、非保持の主張が強くなるため。

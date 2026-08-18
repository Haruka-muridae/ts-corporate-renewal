# 作業指示書 — 本番アプリの要件定義〜詳細設計書の整備（ローカル Claude Code 向け）

起案: 2026年8月18日 / 対象: `public/production-app/` の全11アプリ ＋ それらが依存する共通層

この文書は**作業の指示書であり、成果物そのものではない。** ここで決めるのは
「何を・どこに・どの形で書くか」と「書く順序」であって、設計内容ではない。

対象読者は、このリポジトリをローカルにクローンした Claude Code（または人間）。
§12 にそのまま貼れるプロンプトを置いた。**§1〜§11 を読ませてから §12 を渡すこと。**

---

## §1 目的と成果物

### 1-1. なぜ書くか

現在の各アプリには**要件定義書（何を作るか）はあるが、詳細設計書（どう出来ているか）が無い。**
そのため、あるアプリの一部を別プロダクトへ持っていくとき、実装を読み直すしかない。

このリポジトリは「アプリ間で共通層を作らず、必要なら複製する」方針を採っている
（[../repository-structure.md](../repository-structure.md) §4-1）。
**複製を前提にする以上、複製する側が読むための文書が要る。**
それが無いまま複製すると、複製元の欠陥（同 §4-3）ごと写ることになる。実際に
`receipt-ocr` → `card-ocr` で7件の未反映が見つかっている。

### 1-2. 成果物

| 成果物 | 置き場所 | 本数 |
| --- | --- | --- |
| 部品カタログ（移植単位の一覧と系譜） | `docs/design/component-catalog.md` | 1 |
| 各アプリの詳細設計書 | `docs/design/<app-id>-design-v1.md` | 11 |
| 共通層の詳細設計書 | `docs/design/auth-shared-design-v1.md` | 1 |

要件定義書は**すでにある（§3）。新たに書き直さない。** 詳細設計書から §n で参照する。

### 1-3. 成果物でないもの

- 実装の変更。**この作業でコードを直さない。** 乖離を見つけたら §11-3 の扱いにする
- 要件定義書の書き換え。版ずれ（§4-1）の修正だけは別作業として切り出す
- 共通ライブラリ化・パッケージ化。§2 で選ばない限り行わない

---

## §2 先に決めること（着手前にユーザーへ確認）

「他のプロダクトにも組み込めるように」の実現手段が3通りあり、**書く内容が変わる。**

| 案 | 意味 | 文書への影響 |
| --- | --- | --- |
| **A. 複製前提の移植ガイド（推奨）** | 別リポジトリへファイルを複製し、置換点を直して使う | 各設計書に「移植」章（§7）が要る。現行方針と矛盾しない |
| B. 共有ライブラリ化 | npm パッケージ等に切り出し、各所から参照 | `repository-structure.md` §4-1 の判断を覆す必要がある。設計書の前に**その決定**が要る |
| C. 第三者への納品・販売用 | 外部の開発者・顧客が読む製品仕様書 | 秘密情報の線引き・免責・サポート範囲の章が追加で要る |

**既定は A。** 理由は、§4-1 の判断（重複より結合が高くつく／別々に進む開発を止めない）が
まだ有効であり、文書を整えることは A のコストだけを下げるから。
ただし §4-2 は「3本目の本番アプリが入るとき再検討する」と書いており、**現に11本ある。**
B を選ぶなら、この作業の前に「11本を見比べたうえで抽象を決める」判断が要る。
**A で進めるが、B の判断材料として §8 の部品カタログを先に作る**、という順序を採る。

---

## §3 現状の棚卸し（2026-08-18 時点）

### 3-1. 本番アプリ11本

| アプリID | 名称 | 規模 | 既存の要件定義書 | テスト | 主な外部依存 |
| --- | --- | --- | --- | --- | --- |
| `voice-recorder` | ブラウザ録音 | 約3,700行 | [../requirements/mvp-requirements.md](../requirements/mvp-requirements.md) | `voice-recorder`, `voice-recorder-notifier` | Drive（`drive.file`）、lamejs（同梱） |
| `audio-transcriber` | 音声文字起こし | 約6,600行 | [../specs/audio-transcriber-requirements-v1.md](../specs/audio-transcriber-requirements-v1.md) | `audio-transcriber` | Drive、Gemini、端末内 Whisper |
| `meeting-minutes` | AI議事録 | 約4,400行 | [../specs/meeting-minutes-requirements-v1.md](../specs/meeting-minutes-requirements-v1.md) | `meeting-minutes` | Gemini |
| `receipt-ocr` | 領収書スキャナ | 約6,300行 | [../specs/receipt-ocr-v2.md](../specs/receipt-ocr-v2.md)（＋ v1.3 の抽出章） | `receipt-ocr` 他4本 | Drive、Sheets、Gemini |
| `card-ocr` | 名刺OCR | 約7,600行 | [../specs/meishi-ocr-requirements-v3.md](../specs/meishi-ocr-requirements-v3.md) | `card-ocr` | Drive、Sheets、Gemini |
| `card-mail` | 名刺メール配信 | 約2,400行 | [../specs/card-mail-requirements-v1.md](../specs/card-mail-requirements-v1.md) | `card-mail`, `browser:card-mail` | Drive、Sheets、Gmail 送信 |
| `short-script` | ショート動画 台本メーカー | 約2,500行 | [../specs/short-script-spec-v1.md](../specs/short-script-spec-v1.md) | `short-script-companion` | Gemini、ローカル補助サービス |
| `threads-post` | Threads 投稿 | 約1,100行 | [../specs/threads-mvp-requirements-v1.md](../specs/threads-mvp-requirements-v1.md) | `threads-mvp`, `threads-post` | Gemini、intent リンク |
| `x-post` | X 投稿 | 約1,100行 | [../specs/x-post-requirements-v1.md](../specs/x-post-requirements-v1.md) | `x-post` | 同上 |
| `note-post` | note 下書き | 約1,200行 | [../specs/note-post-requirements-v1.md](../specs/note-post-requirements-v1.md) | `note-post` | 同上（プリフィル不可のためコピー方式） |
| `calendar-url-notifier` | カレンダーURL通知 | 約1,000行 | [../specs/calendar-url-notifier-requirements-v1.md](../specs/calendar-url-notifier-requirements-v1.md) | `notifier-gate`, `notifier-license`, `notifier-template`, `notifier-connection` | Service Worker、Push、`gas-notifier/`、`workers/notifier-gate/` |

行数は HTML・CSS・JS の合計。スイート名は `node tests/run.mjs <名前>` に渡す名前。

### 3-2. アプリが乗っている共通層

| 対象 | 実体 | 既存文書 |
| --- | --- | --- |
| 画面ガード・セッション | `public/auth/session.js`（`guardPage()` ほか） | [../specs/login-page-detailed-spec-v3.md](../specs/login-page-detailed-spec-v3.md) §5・§8 |
| 認証API クライアント | `public/auth/api.js` | 同上 |
| APIキー保管（BYOK） | `public/auth/keystore.js` | [../specs/keystore-spec-v1.md](../specs/keystore-spec-v1.md) |
| Portal 掲載 | `public/portal/app-registry.js` ほか | [../specs/apps-grid-spec-v1.md](../specs/apps-grid-spec-v1.md) / [../specs/portal-spec-v1.md](../specs/portal-spec-v1.md) |
| セッション検証キャッシュ | `workers/auth-verify/` | [../specs/auth-verify-cache-spec-v1.md](../specs/auth-verify-cache-spec-v1.md) |
| 通知ゲート | `workers/notifier-gate/` ＋ `gas-notifier/` | [../notifier-design-notes.md](../notifier-design-notes.md) ほか |

### 3-3. アプリ内で複製されている部品（移植の主対象）

各アプリの `config.js` / `drive-auth.js`（または `oauth.js`）/ `gis-loader.js` / `gemini.js` は、
**同じ系譜から複製されている。** 複製元と複製日は各ファイル冒頭コメントに書かれている。

- `gis-loader.js`: `public/apps/` → `card-ocr/poc/` → `card-ocr/` → `card-mail/`（実質同一）
- `drive-auth.js` / `oauth.js`: 同系譜だが、要求スコープと失敗時の扱いが分岐
  （`card-mail` は `drive.file` ＋ `gmail.send` の2つを検証する、など）
- `gemini.js`: 6本あり、279〜523行。プロンプトと後処理が分岐
- `oauth.js`: `receipt-ocr`（118行）は既知の欠陥あり（[../receipt-ocr-findings-20260804.md](../receipt-ocr-findings-20260804.md) #1）

**この分岐こそが設計書に書くべき中身である。** 「同じである」ではなく
「どこが同じで、どこが・なぜ違うか」を書く。

---

## §4 既存文書のギャップ（作業前に把握すること）

### 4-1. 版のずれ

[../specs/README.md](../specs/README.md) の一覧表と、各文書の本文の版が食い違っている。

| 文書 | README の表記 | 本文の表記 |
| --- | --- | --- |
| `audio-transcriber-requirements-v1.md` | v1.1 | 1.3 |
| `meeting-minutes-requirements-v1.md` | v1.0 | v1.1 |
| `note-post-requirements-v1.md` | v1.0 | v1.1 |
| `short-script-spec-v1.md` | v1.4 | 1.5 |

**この作業のついでに直さない。** 独立した小さな変更として先に片づけるか、
最後にまとめて1コミットにする（どちらでもよいが、設計書のコミットに混ぜない）。

### 4-2. 文書が無い範囲

- **交流会申込アプリ（`app/event/` ＋ `lib/event/`）** に要件定義書・仕様書が無い。
  運用文書（[../event-admin.md](../event-admin.md)・[../event-app-database.md](../event-app-database.md)・[../event-acceptance.md](../event-acceptance.md)）だけがある。
  今回の対象外だが、**同じ形式で書ける唯一のサーバー側アプリ**なので、
  §2 の A で進めるなら「12本目」として最後に足す価値がある
- `workers/notifier-gate/` の仕様書が独立していない（アプリ側の要件定義書に混ざっている）

### 4-3. 位置づけの整理が要るもの

`receipt-ocr` は v2.0（ドラフト）と v1.3 の2本立てで、v1.3 の一部章だけが現役。
詳細設計書を書くとき、**どちらを参照しているかを章ごとに明示する。**

---

## §5 文書体系（決定事項）

### 5-1. 配置と命名

```
docs/design/
  README.md                      … 一覧と読み方（最後に書く）
  component-catalog.md           … 部品カタログ（§8）
  auth-shared-design-v1.md       … 共通層
  <app-id>-design-v1.md          … 各アプリ（app-id は Portal の登録IDに合わせる）
```

`docs/specs/`（要件定義書・仕様書＝**何を作るか**）とは別ディレクトリにする。
理由は、**改訂の頻度と責任者が違う**から。要件は事業判断で変わり、設計は実装で変わる。
同じディレクトリに置くと、どちらが正か毎回考えることになる。

### 5-2. 正の関係

```
docs/specs/（要件定義書・仕様書）   ← 正
        ↑ 参照（§n で指す）
docs/design/（詳細設計書）          ← 下位
        ↑ 記述対象
public/production-app/（実装）
```

- 詳細設計書と要件定義書が食い違ったら、**要件定義書が正**
- 詳細設計書と実装が食い違ったら、**実装が正**（設計書は実装を記述する文書だから）
- ただし「実装が要件定義書に違反している」場合は、直さず**報告する**（§11-3）

### 5-3. 二重管理をしない

要件定義書に書いてあることを、詳細設計書へ写さない。**参照する。**
`docs/specs/README.md` が既に禁じている（「両方に同じことを書いて二重管理しないでください」）。

判断に迷ったら次の基準を使う。

| 内容 | 置き場所 |
| --- | --- |
| なぜその機能が要るか、利用者は誰か、やらないこと | 要件定義書 |
| どのファイルの何が、どの順で、どんなデータを持って動くか | 詳細設計書 |
| 移植するとき何を差し替えるか | 詳細設計書（§7） |

---

## §6 詳細設計書のテンプレート（全アプリ共通の章立て）

**章番号と章名を全アプリで揃える。** 揃っていないと、移植時に横断して読めない。

```markdown
# <アプリ名> 詳細設計書 v1.0

| 項目 | 内容 |
| --- | --- |
| アプリID | <app-id> |
| 実装 | public/production-app/<app-id>/ |
| 上位文書 | docs/specs/<要件定義書>.md（この文書はその下位） |
| テスト | tests/unit/<suite>.mjs（node tests/run.mjs <suite>） |
| 作成日 | YYYY年M月D日 |

## §1 責務と境界
  このアプリが引き受けること／引き受けないこと。隣のアプリとの分担。

## §2 モジュール構成
  ファイル1つ＝1行の表（ファイル名・責務・行数の目安・依存先）。
  依存の向きを図または箇条書きで示す。循環があるならそう書く。

## §3 状態とデータ構造
  画面状態、永続化するもの（localStorage キー名・スキーマ・版）、
  メモリだけに置くもの（トークン等）。**キー名は実物を書く。**

## §4 主要フロー
  利用者操作ごとに、呼ばれる関数の順序と分岐。1フロー＝1小節。
  非同期の待ち合わせ・中断（AbortSignal）の扱いを明記する。

## §5 外部インターフェース
  叩く API（ホスト・パス・メソッド・要求スコープ）、送るもの／送らないもの。
  リクエスト／レスポンスの形は代表例を1つ。

## §6 エラー設計
  エラーコード体系、利用者へ出す文言の方針、リトライの有無と回数、
  「回復不能になる失敗」の扱い（例: 認可失敗時にキャッシュを捨てる理由）。

## §7 移植（他プロダクトへの組み込み）    ← 本作業の中核。詳細は指示書 §7
## §8 テスト設計
  スイート名、差し替え口（テストが何を注入して何を検証しているか）、
  ブラウザテストが必要な理由（あれば）。

## §9 設定値と環境依存
  クライアントID・モデル名・上限値・タイムアウト等の一覧と、置いてある場所。
  **実際の鍵・ID・内部URLは書かない。名前と意味だけ書く。**

## §10 既知の制約・未解決
  仕様上の割り切り、既知の不具合（出典を示す）、将来変えるつもりの箇所。

## §11 設計判断の記録
  採らなかった案とその理由。**既存の要件定義書の同種の節から引き継ぐ。**

## §12 変更履歴
```

不要な章は「該当なし」と1行書いて残す。**削らない**（横断で読めなくなるため）。

---

## §7 §7「移植」章の書き方（この作業の中核）

他の章は実装を記述すれば書けるが、この章だけは**書き手が判断して作る。**
次の4点を必ず含める。

### 7-1. 移植単位の宣言

このアプリから切り出せる塊を、粒度つきで挙げる。

```markdown
| 単位 | ファイル | 依存 | 単独で持ち出せるか |
| --- | --- | --- | --- |
| Google 認可（drive.file） | drive-auth.js, gis-loader.js, config.js の一部 | GIS スクリプト | 可（設定の差し替えのみ） |
| Drive 台帳の解決 | ledger.js, drive-api.js | 上の認可 | 条件付き（フォルダ名規約に依存） |
| Gemini 呼び出し | gemini.js, prompt.js | KeyStore または任意のキー供給 | 可（KeyStore を外部化すれば） |
```

### 7-2. 置換点（差し替えが要る箇所）

移植先で必ず直すものを、**ファイル名・定数名で**示す。行番号は使わない。

- クライアントID と承認済みオリジン（`config.js` の該当定数）
- 保存先フォルダ名・スプレッドシート名の規約
- `public/auth/` への依存（`guardPage()` / `KeyStore`）をどう外すか
- CSP の `connect-src`（`index.html`）

### 7-3. 前提の明示

移植先が満たしていないと動かない条件。例:

- HTTPS 配信であること（`file://` では ES モジュールが動かない）
- OAuth 同意画面で必要なスコープが有効化されていること
- ブラウザ要件（OPFS・AudioWorklet・Service Worker など、使っているもの）

### 7-4. 持ち出してはいけないもの

- 既知の欠陥を含む実装（複製前に直す。[../repository-structure.md](../repository-structure.md) §4-3）
- 当社固有の運用前提（Portal の登録、認証系のセッション名 `tsam-auth-session` など）
- 法務・利用条件に紐づく文言（アプリの画面文言は移植先の責任で作り直す）

---

## §8 部品カタログ（`docs/design/component-catalog.md`）

**各アプリの設計書より先に、骨格だけ作る。** 名前を先に決めないと、
11本の設計書で同じ部品が別名で呼ばれる。

含めるもの:

1. 部品ごとの**系譜**（どこからどこへ複製され、いつ、何を変えたか）。
   一次情報は各ファイル冒頭のコメント。推測で系譜を書かない
2. 分岐の一覧（同じ部品の実装がなぜ違うか。§3-3 の観点）
3. 「同一化できる範囲」と「できない範囲」の現時点の見立て。
   [../repository-structure.md](../repository-structure.md) §4-1 は 2026-08-04 に2本を比べて
   「同一化できたのは約200行・全体の3%」と結論した。**11本での再測定はこのカタログの仕事。**
   ただし**結論（共通層を作る／作らない）はここで出さない。** §2 の B は別の意思決定

---

## §9 進め方

### 9-1. フェーズ

| フェーズ | 内容 | 成果物 |
| --- | --- | --- |
| 0 | §2 の確認、`docs/design/` 作成、部品カタログの骨格 | `component-catalog.md`（暫定） |
| 1 | **1本目の設計書でテンプレートを確定**（`threads-post` を推奨） | `threads-post-design-v1.md` |
| 2 | 同系の差分2本（`x-post` `note-post`） | 設計書2本 |
| 3 | 音声チェーン（`voice-recorder` → `audio-transcriber` → `meeting-minutes`） | 設計書3本 |
| 4 | Drive 台帳系（`card-ocr` → `card-mail` → `receipt-ocr`） | 設計書3本 |
| 5 | 残り（`short-script` `calendar-url-notifier`） | 設計書2本 |
| 6 | 共通層（`auth-shared-design-v1.md`）、部品カタログの確定、`docs/design/README.md` | 3本 |

**1本目を最小のアプリにする理由**は、テンプレートの粗が安く出るから。
`threads-post` は約1,100行で、AI生成・下書き保存・intent 投稿という
このリポジトリで最も繰り返し使われている型を含んでいる。

### 9-2. セッションの切り方（ローカル Claude Code 向け）

- **1アプリ＝1セッション。** 終わったらコンテキストを空にして次へ
- 1アプリのコミットは1つ（設計書1ファイル追加）。まとめてコミットしない
- フェーズ1が終わった時点で**必ず人間のレビューを入れる。** 以降10本が同じ型で増える

---

## §10 守る制約（違反したら差し戻し）

1. **コードを変更しない。** この作業は文書だけ。乖離は §11-3 で報告する
2. **秘密情報を書かない。** 鍵・トークン・スプレッドシートID・内部URL・実在するメールアドレス。
   `docs/` は現在の配信構成では公開URLから 404 だが、**GitHub のリポジトリでは読める。**
   一度コミットすれば履歴に残る（[../specs/README.md](../specs/README.md) 末尾）
3. **日本語で書く。** 「何をしているか」より「なぜそうしたか（と、採らなかった選択肢）」を書く
4. **参照は §n・ファイル名・関数名・定数名で行う。行番号を使わない**
5. **推測を事実として書かない。** 実装から読み取れないこと（意図・経緯）は、
   一次情報（ファイル冒頭コメント・`docs/` の既存文書・テストの記述）を出典として示すか、
   「未確認」と明示する
6. **要件定義書の内容を写さない**（§5-3）
7. `public/apps/`（テスト環境）と `public/production-app/`（本番）を混同しない。
   本番アプリはテスト環境から**複製**されており、依存していない
8. `lp-draft/` `potenitas-lp/` `labs/` は対象外

---

## §11 受け入れ基準

### 11-1. 各設計書

- §6 の章立てがすべてある（該当なしの章も残っている）
- §2 のモジュール表が、実際のファイル一覧と**過不足なく一致する**
- §3 の localStorage キー名・§9 の定数名が、実装の綴りと**文字単位で一致する**
- §7 に置換点が具体的に挙がっている（「設定を直す」のような抽象語で終わっていない）
- 上位の要件定義書へのリンクがあり、重複記述が無い

### 11-2. 全体

- `docs/design/README.md` から11本＋共通層＋カタログへ辿れる
- `docs/specs/README.md` から `docs/design/` の存在に触れている（1行でよい）
- `npm run typecheck` と `npm test` が作業前と同じ結果（文書のみの変更なので当然だが確認する）

### 11-3. 乖離を見つけたときの扱い

実装が要件定義書に違反している、または既知の不具合を見つけた場合:

- **直さない。設計書に「§10 既知の制約・未解決」として書く**
- 加えて `docs/design/findings-2026-08.md` に1件1項目で積み、
  作業完了時にまとめて報告する（重大度・該当ファイル・根拠）
- 安全性に関わるもの（トークンの保存先、スコープ、送信先）は**その場で作業を止めて報告する**

---

## §12 ローカル Claude Code へ渡すプロンプト

### 12-1. キックオフ（フェーズ0・1回だけ）

```text
このリポジトリの本番アプリ（public/production-app/ 配下の11本）について、
他のプロダクトへ組み込めるようにするための詳細設計書を整備する。

まず docs/instructions/2026-08-18-app-design-docs-handoff.md を読んでほしい。
作業の目的・成果物・文書体系・章立てテンプレート・制約・受け入れ基準は
すべてその指示書にある。以降の判断はその指示書を正とする。

今回のセッションでやることは、指示書 §9-1 のフェーズ0だけ:

1. 指示書 §2 の「先に決めること」を読み、A（複製前提の移植ガイド）で進めてよいか
   私に確認する。確認が取れるまで先へ進まない
2. docs/design/ を作り、docs/design/component-catalog.md の骨格を書く
   （指示書 §8。系譜は各ファイル冒頭のコメントを一次情報とし、推測で埋めない）
3. コミットして止まる。設計書本体はまだ書かない

制約は指示書 §10。特に「コードを変更しない」「秘密情報を書かない」
「推測を事実として書かない」を守ること。
```

### 12-2. 各アプリ（フェーズ1〜5・1アプリごとに新しいセッションで）

```text
docs/instructions/2026-08-18-app-design-docs-handoff.md に従って、
<APP_ID> の詳細設計書 docs/design/<APP_ID>-design-v1.md を書く。

読む順序:
1. 上記の指示書（特に §6 章立て、§7 移植章、§10 制約、§11 受け入れ基準）
2. docs/design/component-catalog.md（部品の呼び名を揃えるため）
3. このアプリの上位文書: <要件定義書へのパス>
4. 実装: public/production-app/<APP_ID>/ の全ファイル
5. テスト: tests/unit/<SUITE>.mjs（差し替え口と検証内容は §8 の材料になる）
6. 既にある設計書があれば1本読み、章立てと文体を合わせる

守ること:
- コードを変更しない。乖離・不具合は §10「既知の制約・未解決」に書き、
  docs/design/findings-2026-08.md へも1件ずつ積む
- 要件定義書の内容を写さない。§n で参照する
- localStorage のキー名、定数名、関数名は実装の綴りをそのまま書く。行番号は書かない
- 鍵・トークン・スプレッドシートID・内部URL・実在メールアドレスを書かない
- 日本語。「なぜそうしたか」と「採らなかった案」を書く

書き終えたら、指示書 §11-1 の受け入れ基準を自分で1項目ずつ確認し、
結果を報告してから設計書1ファイルだけをコミットする。
```

`<APP_ID>` `<要件定義書へのパス>` `<SUITE>` は §3-1 の表から埋める。

### 12-3. レビュー依頼（フェーズ1の直後・人間が読む前の自己点検）

```text
docs/design/<APP_ID>-design-v1.md を、これから10本増やすテンプレートとして点検してほしい。

観点:
1. §6 の章立てのうち、このアプリでは書けたが他のアプリでは書けない章はあるか
2. 逆に、このアプリには無いが他のアプリには要る章はあるか
   （サーバー側を持つ calendar-url-notifier、Worker と GAS を含む構成を想定して）
3. §7 移植章は、実際にこのファイル群を別リポジトリへ複製する人が
   これだけを見て作業を始められる内容になっているか。足りない情報を挙げる
4. 要件定義書と重複している記述があれば指摘する

指摘は箇条書きで。修正はまだ加えず、私の判断を待つこと。
```

---

## §13 ローカル側で必要な情報・前提

| 項目 | 内容 |
| --- | --- |
| リポジトリ | `Haruka-muridae/ts-corporate-renewal` |
| ブランチ | 新規に切る（例 `docs/app-design-v1`）。`main` へ直接コミットしない |
| 実行環境 | Node（テストの実行は必須ではないが `npm run typecheck` は通ること）。ブラウザテストには Chrome が要る（`CHROME_PATH`） |
| 必読 | `CLAUDE.md` / `AGENTS.md` / `docs/repository-structure.md` / `docs/specs/README.md` / 本指示書 |
| 読まなくてよい | `lp-draft/` `potenitas-lp/` `labs/` `public/apps/`（テスト環境）／ `docs/00_〜18_*.md`（Potenitas LP の別系統） |
| 触ってはいけない | `public/legal/*/index.html`（スプレッドシートからの生成物） |

**外部サービスへの接続は要らない作業である。** Google の管理コンソール・Stripe・Supabase の
実値を見に行く必要は無い。設計書に実値を書かないため（§10-2）。

---

## §14 判断が要る点（ユーザーへの確認事項）

1. **§2 の A / B / C のどれで進めるか**（既定は A）
2. 交流会申込アプリ（`app/event/`）を12本目として含めるか（§4-2）
3. `docs/design/` という配置でよいか。`docs/specs/design/` に入れる案もあるが、
   §5-1 の理由（改訂頻度と責任者が違う）から分けることを勧める
4. 版ずれ（§4-1）を先に直すか、最後にまとめるか

---

## 変更履歴

| 版 | 日付 | 内容 |
| --- | --- | --- |
| v1.0 | 2026-08-18 | 初版。11アプリの棚卸しと、詳細設計書整備の作業指示 |

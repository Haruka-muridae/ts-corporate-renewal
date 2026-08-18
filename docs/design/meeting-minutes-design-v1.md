# AI議事録アプリ 詳細設計書 v1.0

| 項目 | 内容 |
| --- | --- |
| アプリID | `meeting-minutes` |
| 実装 | `public/production-app/meeting-minutes/` |
| 上位文書 | [../specs/meeting-minutes-requirements-v1.md](../specs/meeting-minutes-requirements-v1.md)（本文の版は v1.1） |
| テスト | `tests/unit/meeting-minutes.mjs`（`node tests/run.mjs meeting-minutes`） |
| 規模 | 約4,400行 |
| 作成日 | 2026年8月18日 |

**このアプリの信頼性の核は「根拠（evidence）のクライアント側照合」である**（§4-3）。
生成そのものより、生成結果を原文と突き合わせる仕組みのほうが設計上重い。

---

## §1 責務と境界

### 1-1. 引き受けること

- 文字起こし（貼り付け／ファイル読み込み／`audio-transcriber` からの引き継ぎ）を受け取る
- Gemini で構造化された議事録（`meeting` / `summary` / `topics` / `decisions` /
  `actionItems` / `openIssues` / `notes`）を生成する
- **モデルが返した根拠を原文へ照合し、確認できなければ「根拠を確認できません」に落とす**
- 4種のテンプレートで Markdown を組み立て、原文と並べて確認・編集できるようにする
- 部分再生成（全体／要約／決定事項／タスク）
- 端末内ドラフトの自動保存（IndexedDB）

### 1-2. 引き受けないこと

- 録音・文字起こし（`voice-recorder` / `audio-transcriber` の担当）
- 当社サーバーへの保存。**議事録も原文も当社へ送らない**
- 複数ドラフトの管理（MVP 対象外。常に1件）
- テンプレートの利用者編集（固定4種）

### 1-3. 隣との関係

| 相手 | 関係 |
| --- | --- |
| `audio-transcriber` | `sessionStorage` キー `tsam-meeting-minutes-handoff-v1` で受け取る。**送り側を信頼しない**（§4-1） |
| KeyStore | Gemini キーの取得元 |
| `public/auth/session.js` | `guardPage()` |

---

## §2 モジュール構成

| ファイル | 責務 | 行数 | 依存先 |
| --- | --- | --- | --- |
| `config.js` | 上限・引き継ぎ・ドラフト・テンプレート・再生成対象 | 203 | なし |
| `handoff.js` | 引き継ぎデータの読み取りと**検証** | 190 | `config.js` |
| `minutes.js` | 議事録の純粋ロジック（検証・照合・Markdown・ファイル名） | 731 | `config.js` |
| `draft.js` | IndexedDB のドラフト保存 | 184 | `config.js` |
| `gemini.js` | Gemini（構造化出力） | 523 | `config.js` |
| `app.js` | 画面 | 1,429 | 上記すべて ＋ `public/auth/` |

`minutes.js` `handoff.js` `draft.js` はいずれも **DOM を参照せず、Node からそのまま
import できる**。`draft.js` は `idbFactory` を、`handoff.js` は `storage` を注入できる。

---

## §3 状態とデータ構造

### 3-1. 議事録の共通スキーマ

テンプレートが4種あるが、**内部の構造化データは常に共通スキーマ**である
（`gemini.js` の `MINUTES_SCHEMA`）。

```
meeting { title, date, time, participants[], purpose }
summary        文字列
topics[]       議題別
decisions[]    決定事項
actionItems[]  タスク
openIssues[]   未決事項
notes[]        自由記述
```

テンプレートごとに変わるのは**どの項目をどの見出しで Markdown へ出すか**だけで、
`sections` と `headings` がその対応表になる。

| テンプレート | 出す項目 |
| --- | --- |
| `standard`（既定） | 概要／議題／決定事項／タスク／未決事項 |
| `concise` | 要約／決定事項／タスク |
| `detailed` | 議題別の要旨／決定事項／タスク／未決事項 |
| `one-on-one` | 話題／本人の認識／合意事項／次回までの行動 |

`one-on-one` は上位文書の項目名が共通スキーマの語彙と違うため、**写像**している
（話題→`topics`、本人の認識→`notes`、合意事項→`decisions`、次回までの行動→`actionItems`）。
**新しいテンプレートを足すときも、スキーマを増やさずこの写像で吸収する。**

### 3-2. 永続化するもの

| 場所 | 名前 | 内容 | 理由 |
| --- | --- | --- | --- |
| IndexedDB | DB `tsam-meeting-minutes-draft` / ストア `draft` / キー `current` | ドラフト1件（**入力原文を含む**） | `localStorage` は容量が小さく同期 API。長い原文は IndexedDB を優先する（上位文書 §4-14） |
| `sessionStorage` | `tsam-meeting-minutes-handoff-v1` | 引き継ぎ（読んだら消す） | タブを閉じれば自動で消える。**本文を `localStorage` へ恒久保存しない** |

自動保存は `DRAFT_AUTOSAVE`（`debounceMs: 2000`）。

**APIキー・認証セッションは `draft.js` の管轄外**で、削除操作の対象にも含めない。

### 3-3. 上限

| 定数 | 値 | 用途 |
| --- | --- | --- |
| `TRANSCRIPT_MAX_CHARS` | 60,000 | 超えたら生成前に警告し、短縮・分割を案内 |
| `TRANSCRIPT_WARN_CHARS` | 45,000 | 上限の75%で早めに知らせる |
| `MAX_OUTPUT_TOKENS` | 8,192 | 構造化応答は長い |

---

## §4 主要フロー

### 4-1. 引き継ぎの受け取り（`handoff.js`）

**`sessionStorage` の中身を信頼できない入力として扱う**（上位文書 §5-2）。
同一オリジンの他スクリプトや、利用者自身が開発者ツールで書き換えた値でありうるため、
「`audio-transcriber` が書いたはず」という前提を置かない。

```
validateHandoffPayload():
  - version のメジャー不一致 → 拒否
  - transcript が文字列でない → 拒否
  - createdAt + TTL（30分）超過 → 無効
  - 未知の項目 → 無視（型が合わなければ既定値へ丸める）
```

失敗時の文言は1つに固定されている
（「文字起こしを引き継げませんでした。音声文字起こしアプリからもう一度お試しください。」）。

### 4-2. 生成（`gemini.js`）

`responseMimeType: 'application/json'` ＋ `responseSchema: MINUTES_SCHEMA` で
構造化出力を要求する。**`responseSchema` の `type` は大文字**（`'OBJECT'` 等）。
小文字はサーバーに 400 で弾かれる（`card-ocr/prompt.js` が実際に踏んだ事故）。

指定していても**まれにコードフェンスが付く**ため、`parseMinutesJson()` が剥がしてから
`JSON.parse` する。結果は `normalizeMinutesResponse()` が共通スキーマへ正規化する
（想定外の型は既定値へ丸め、例外にしない）。

モデルは `DEFAULT_MODEL` → 404 のときだけ `FALLBACK_MODEL`（他アプリと同じ方針）。

### 4-3. 根拠の照合（このアプリの核）

上位文書 §4-10 は「根拠は**入力文字起こし内の該当箇所に限る**」と定める。
**プロンプトで指示するだけでは保証できない**（モデルが要約や言い換えを「引用」として
返しうる）。そこで、返ってきた evidence を**実際に原文へ検索する。**

```
verifyEvidence(evidenceText, transcript):
  1. 空 → confirmed: false
  2. 10文字未満（MIN_EVIDENCE_CHARS）→ 照合するまでもなく confirmed: false
     （短い断片は複数箇所へ一致してしまうため）
  3. findEvidenceInTranscript():
       a. 完全一致（indexOf）→ found。2つ目があれば multiple
       b. 空白を畳んだうえでの部分一致 → found（ただし index は -1 ＝ 位置特定不可）
  4. confirmed: true のとき、multiple でなければ
     findPrecedingTimestamp() で直前のタイムスタンプを拾う
```

確認できなければ `EVIDENCE_NOT_CONFIRMED`（`'根拠を確認できません'`）を表示する。
`verifyMinutesEvidence()` が議事録全体を走査する。

**照合は完全一致を第一段に置き、空白の畳み込みだけを緩和として認める。**
表記ゆれ全般を許すと「照合した」と言えなくなるため。

### 4-4. 部分再生成

`REGENERATE_TARGETS`（`all` / `summary` / `decisions` / `actionItems`）。
`mergeMinutesSection(current, incoming, target)` が該当節だけを差し替える。
**利用者が編集した他の節を壊さない**ための仕組み。

### 4-5. 書き出し

`buildMarkdown(minutes, { templateId, includeEvidence })`。
`buildMinutesFileName({ date, title })` がファイル名を作る。

---

## §5 外部インターフェース

### 5-1. Gemini

| 項目 | 値 |
| --- | --- |
| ホスト・パス | 他アプリと同じ（`v1beta` の `generateContent`） |
| 認証 | `x-goog-api-key` ヘッダー |
| 出力 | `responseMimeType: application/json` ＋ `responseSchema` |
| モデル | `DEFAULT_MODEL` → 404 のときだけ `FALLBACK_MODEL` |
| 差し替え口 | `fetchImpl` / `signal` |

### 5-2. `audio-transcriber`

受け取り専用。キー・版・TTL は §3-2 / §4-1。

### 5-3. 送らないもの

当社サーバーへは何も送らない。

---

## §6 エラー設計

`gemini.js` のエラー分類は投稿系アプリと同じ体系（`GeminiErrorCode` ＋
`describeGeminiError`）。加えて、このアプリ固有の固定文言が3つある。

| 定数 | 文言 | 場面 |
| --- | --- | --- |
| `HANDOFF_ERROR` | 文字起こしを引き継げませんでした。… | 引き継ぎの検証に落ちた |
| `DRAFT_SAVE_ERROR` | 端末に下書きを保存できませんでした。… | IndexedDB の容量不足 |
| `DRAFT_RESTORE_ERROR` | 下書きを復元できませんでした。… | 保存済みドラフトが壊れていた |

いずれも上位文書 §9-2 の表現をそのまま使っている。**文言を実装側で言い換えない。**

入力検証は `minutes.js` が `TRANSCRIPT_ERROR` / `FILE_ERROR` として持ち、
バイナリらしさ（`looksBinary`）と文字化け（`looksMisdecoded`）も見る。

---

## §7 移植（他プロダクトへの組み込み）

### 7-1. 移植単位

| 単位 | ファイル | 依存 | 単独で持ち出せるか |
| --- | --- | --- | --- |
| **根拠照合** | `minutes.js` の `findEvidenceInTranscript` / `verifyEvidence` / `verifyMinutesEvidence` / `findPrecedingTimestamp` | なし（純粋関数） | **可。LLM 出力を原文へ突き合わせる仕組みが要る場面で、そのまま効く** |
| 構造化生成 | `gemini.js` ＋ `MINUTES_SCHEMA` | `config.js` | 可（スキーマを差し替える） |
| テンプレート写像 | `config.js` の `TEMPLATES` ＋ `minutes.js` の `buildMarkdown` | なし | 可 |
| IndexedDB ドラフト | `draft.js` | `config.js` の4定数 | 可（`idbFactory` 注入可） |
| 引き継ぎの検証 | `handoff.js` | `config.js` | 可（送り側を信頼しない形がそのまま使える） |
| 画面 | `app.js` | `public/auth/` | 不可のまま |

### 7-2. 置換点

1. **`MINUTES_SCHEMA` と `TEMPLATES`。** 出したい項目が変われば両方
2. **`config.js` の DB 名・ストア名・キー名**（`tsam-meeting-minutes-draft` ほか）。
   移植先で必ず変える
3. **`HANDOFF_KEY` / `HANDOFF_MAJOR_VERSION` / `HANDOFF_TTL_MS` / `HANDOFF_SOURCE_APP`。**
   送り側が無ければ `handoff.js` ごと落とす
4. **`LIMITS`。** 60,000字はモデルと用途に依存する
5. **`MIN_EVIDENCE_CHARS`（10）。** 言語と用途で最適値が変わる
6. `public/auth/` への依存、CSP、DOM id

### 7-3. 前提

- IndexedDB が使えること（使えない場合はドラフト保存だけが効かない）
- `sessionStorage`（引き継ぎを使う場合）
- 利用者が Gemini APIキーを持っていること
- **`responseSchema` を解釈するモデルであること。** 他社モデルへ移すなら
  構造化出力の指定方法から作り直す

### 7-4. 持ち出してはいけないもの

- **照合を省いて evidence をそのまま表示する改変。** 上位文書 §4-10 の要求を崩す
- 上位文書 §9-2 の文言を言い換えたもの
- 原文を `localStorage` へ恒久保存する改変（§3-2 の理由）

---

## §8 テスト設計

スイート: `tests/unit/meeting-minutes.mjs`。

`app.js` はテストしない。テスト対象は
`handoff.js`（版不一致・型不一致・TTL 超過・未知項目の無視）、
`minutes.js`（正規化・**根拠照合**・Markdown・ファイル名・入力検証）、
`draft.js`（保存・復元・破損時の扱い）、
`gemini.js`（スキーマ・コードフェンス剥がし・エラー分類）。

差し替え口は `storage`（`handoff.js`）、`idbFactory`（`draft.js`。
`tests/helpers/fake-indexeddb.mjs` で `globalThis.indexedDB` を差し替える構成にも、
明示的に渡す構成にも対応）、`fetchImpl` / `signal`（`gemini.js`）、`now`。

---

## §9 設定値と環境依存

| 定数 | 値・意味 |
| --- | --- |
| `SCREEN_DEPTH` | 2 |
| `DEFAULT_MODEL` / `FALLBACK_MODEL` | 他アプリと同じ |
| `MAX_OUTPUT_TOKENS` | 8192 |
| `LIMITS` | 60,000／45,000 文字 |
| `HANDOFF_KEY` / `HANDOFF_TTL_MS` / `HANDOFF_MAJOR_VERSION` / `HANDOFF_SOURCE_APP` | 引き継ぎ（30分・v1・`audio-transcriber`） |
| `DRAFT_DB_NAME` / `DRAFT_DB_VERSION` / `DRAFT_STORE_NAME` / `DRAFT_RECORD_KEY` | IndexedDB |
| `DRAFT_AUTOSAVE` | 有効・2000ms デバウンス |
| `TEMPLATES` / `DEFAULT_TEMPLATE_ID` | 固定4種・既定 `standard` |
| `REGENERATE_TARGETS` | 4択 |
| `EVIDENCE_NOT_CONFIRMED` | `根拠を確認できません` |

---

## §10 既知の制約・未解決

1. **照合は完全一致と空白畳み込みだけ。** 句読点や表記ゆれを伴う正しい引用は
   「確認できません」になる。**安全側の誤りだが、利用者には不便**
2. **10文字未満の根拠は常に未確認になる。** 短い決定事項（「実施する」など）を
   根拠として返された場合、内容が正しくても確認できない
3. **同じ文が複数回出てくると、タイムスタンプを付けられない**（`multiple` のとき）
4. **ドラフトは1件のみ。** 別の会議を扱うと上書きされる（MVP の割り切り）
5. **引き継ぎの TTL 判定は受け側のみ。** 送り側は書くだけなので、
   この判定を落とすと期限切れデータを読むことになる

---

## §11 設計判断の記録

| 判断 | 採らなかった案 | 理由 |
| --- | --- | --- |
| **evidence を原文照合する** | プロンプトで「原文から引用せよ」と指示するだけ | 指示だけでは保証できない。照合がこのアプリの信頼性の核 |
| 未確認を空欄にせず明示する | 根拠が無い項目を隠す | 「根拠が無い」という事実自体が利用者の判断材料になる |
| 共通スキーマ＋写像でテンプレートを表現 | テンプレートごとにスキーマを持つ | 生成側の分岐が増え、部分再生成の合流も難しくなる |
| ドラフトを IndexedDB に置く | `localStorage` | 原文が長い。容量と同期 API の制約 |
| 引き継ぎ元を信頼しない | 自アプリが書いたものとして扱う | 同一オリジンの他スクリプトや開発者ツールで書き換えられる |
| 引き継ぎを `sessionStorage` に置く | `localStorage` / URL のクエリ | タブを閉じれば消える。URL は履歴やログに残る |
| 部分再生成で節だけ差し替える | 全体を作り直す | 利用者の編集を壊さない |

---

## §12 変更履歴

| 版 | 日付 | 内容 |
| --- | --- | --- |
| v1.0 | 2026-08-18 | 初版。実装（2026年8月時点）を記述 |

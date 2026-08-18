# X 投稿アプリ 詳細設計書 v1.0

| 項目 | 内容 |
| --- | --- |
| アプリID | `x-post` |
| 実装 | `public/production-app/x-post/` |
| 上位文書 | [../specs/x-post-requirements-v1.md](../specs/x-post-requirements-v1.md)（Threads 版の差分仕様） |
| テスト | `tests/unit/x-post.mjs`（`node tests/run.mjs x-post`） |
| 規模 | 約1,100行 |
| 作成日 | 2026年8月18日 |

**本書は [threads-post-design-v1.md](./threads-post-design-v1.md) の差分として書く。**
実装が `threads-post` からの複製であり（[../repository-structure.md](../repository-structure.md) §4-1）、
同じことを2度書くと片方だけが古くなるためである。

章立ては揃えてあり、差分の無い章は「Threads 版と同じ」と書いて参照先を示す。

---

## §1 責務と境界

Threads 版 §1 と同じ。違いは対象媒体（X／旧 Twitter）と上限の数え方（§3-1）だけ。

引き受けないことも同じ。**X の API・アクセストークンは使わない。**
最後の「ポスト」は利用者が X の画面で押す。

---

## §2 モジュール構成

Threads 版 §2 と同じ6ファイル・同じ依存の向き。行数もほぼ同じ。

DOM の id 接頭辞だけが違う（`tp-` → `xp-`）。CSS クラスも同様（`xp-message` など）。

---

## §3 状態とデータ構造

保存キーが違う。**それ以外は Threads 版 §3 と同一の実装**（`post.js` の保存部は
コメント以外の差分が無い）。

| 項目 | 値 |
| --- | --- |
| `localStorage` キー | `tsam-x-post-v1` |
| 保存する形 | `{ drafts, history, stylePrompt }`（Threads 版と同じ） |
| 履歴の上限 | 100 件 |

### 3-1. 上限の数え方（このアプリ固有）

X の上限は**280「ウェイト」**であり、文字数ではない。

`post.js` の `weightOf(codePoint)` が twitter-text の既定レンジに合わせて重みを返す。

| 範囲 | 重み |
| --- | --- |
| U+0000–U+10FF、U+2000–U+200D、U+2010–U+201F、U+2032–U+2037 | 1 |
| 上記以外（日本語・絵文字を含む） | 2 |

`countWeight()` が合計を返し、画面のカウント表示と検証の両方が使う。
**日本語だけならおよそ140字**になる。

画面のエラー文言も「本文が上限（280ウェイト・日本語なら約140字）を超えています」と、
ウェイトと概算字数の両方を出す。ウェイトは利用者に馴染みが無いため。

---

## §4 主要フロー

Threads 版 §4 と同じ。`updateCount()` が `countText()` ではなく `countWeight()` を
呼ぶ点だけが違う。

---

## §5 外部インターフェース

### 5-1. Gemini

Threads 版 §5-1 と同じ。プロンプトは X 向けの文面になっているが、構成
（方針 → 調整 → テーマ）と `temperature: 0.4`、`MAX_OUTPUT_TOKENS: 1024` は同じ。

### 5-2. X

| 項目 | 値 |
| --- | --- |
| URL | `https://x.com/intent/post?text=<encodeURIComponent(本文)>`（`config.js` の `X_INTENT_BASE`） |
| 未ログイン時 | X が `redirect_after_login=<intent URL>` でログインへ誘導し、ログイン後に本文入りの作成画面が開く（2026-08-12 実機確認） |

---

## §6 エラー設計

Threads 版 §6 と同じ（`gemini.js` のエラー分類は複製で、コードも文言も同一）。

---

## §7 移植（他プロダクトへの組み込み）

### 7-1. 移植単位

Threads 版 §7-1 と同じ表に加え、**ウェイト計算（`weightOf` / `countWeight`）が
独立した移植単位**になる。依存が無く、X 以外でも「全角を2と数える」要件があれば使える。

### 7-2. 置換点

Threads 版 §7-2 の6点と同じ。値だけが違う。

| 置換点 | このアプリの値 |
| --- | --- |
| `STORAGE_KEY` | `tsam-x-post-v1`（**移植先で必ず変える**） |
| 上限 | `WEIGHT_LIMIT`（280）。文字数ではないことに注意 |
| intent URL | `X_INTENT_BASE` |
| DOM id 接頭辞 | `xp-` |

**上限の意味を取り違えないこと。** Threads 版の `TEXT_LIMIT`（文字数）と
このアプリの `WEIGHT_LIMIT`（ウェイト）は名前も意味も違う。
複製時に片方の検証だけ持ち込むと、上限が実質2倍または半分になる。

### 7-3. 前提

Threads 版 §7-3 と同じ。

### 7-4. 持ち出してはいけないもの

Threads 版 §7-4 と同じ。

---

## §8 テスト設計

スイート: `tests/unit/x-post.mjs`。

構成は Threads 版 §8 と同じ（`post.js` / `gemini.js` を直接読み、`storage` と
`fetchImpl` を差し替える）。**追加の観点はウェイト計算**で、
半角・全角・絵文字を混ぜた入力で 280 の境界を固定している。

---

## §9 設定値と環境依存

`config.js` にある。Threads 版 §9 との違いは次の3つ。

| 定数 | 値 | 備考 |
| --- | --- | --- |
| `X_INTENT_BASE` | `https://x.com/intent/post` | — |
| `WEIGHT_LIMIT` | 280 | 文字数ではない |
| `STORAGE_KEY` | `tsam-x-post-v1` | — |

`DEFAULT_MODEL` / `FALLBACK_MODEL` / `MAX_OUTPUT_TOKENS` / `THEME_MAX_LENGTH` /
`HISTORY_LIMIT` は Threads 版と同じ値。

---

## §10 既知の制約・未解決

Threads 版 §10 の 1・2・4 はそのまま当てはまる。3（文字数の数え方）は次に置き換わる。

- **ウェイトの区分は twitter-text の既定に合わせた近似である。**
  X 側の実際の計数と一致する保証はない。URL の短縮（t.co）による調整も行っていないため、
  **URL を含む投稿では実際より多く数える**（安全側に外れる）

---

## §11 設計判断の記録

Threads 版 §11 に加えて、このアプリ固有の判断。

| 判断 | 採らなかった案 | 理由 |
| --- | --- | --- |
| ウェイトを自前で数える | twitter-text を依存に加える | 外部ライブラリの追加は事前確認が要る（[../../AGENTS.md](../../AGENTS.md)）。区分は4レンジで、写して足りる |
| URL 短縮を考慮しない | t.co の23文字固定として計算する | 短縮の仕様が変わると黙って上限を誤る。多めに数えて弾くほうが安全 |
| エラー文言にウェイトと概算字数を併記 | ウェイトだけ出す | 利用者にウェイトの語は馴染みが無い |

---

## §12 変更履歴

| 版 | 日付 | 内容 |
| --- | --- | --- |
| v1.0 | 2026-08-18 | 初版。Threads 版の差分として記述 |

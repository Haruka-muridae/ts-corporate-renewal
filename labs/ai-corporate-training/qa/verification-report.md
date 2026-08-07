# 自動検証レポート（AI人材育成プログラム LP）

実施日: 2026年8月7日
対象: [public/labs/ai-corporate-training/](../../../public/labs/ai-corporate-training/)
（`index.html` ／ `css/style.css` ／ `js/main.js`）

検証に使ったパッケージ（`axe-core` / `html-validate`）は作業用ディレクトリにのみ入れ、
**リポジトリへはコミットしていない。** Playwright はリポジトリの devDependencies に既存。

## サマリー

| 項目 | 結果 |
| --- | --- |
| コピー照合（確定稿67件） | **67/67 一字一句一致** |
| JSON-LD の FAQ と本文の照合 | **4/4 一致** |
| コントラスト（実レンダリング） | **75/75 合格** |
| html-validate（`a11y,recommended,standard`） | **指摘 0** |
| axe-core violations | **0** |
| 横スクロール（375 / 768 / 1440px） | **3幅とも発生なし** |
| キーボード操作 | **Tab到達・Enter・Space すべて期待どおり** |
| reduced-motion | **fade 対象 36件すべて opacity: 1** |
| ソフトローンチ構成の存在確認 | **すべて期待どおり** |

---

## 1. コピー照合

実装指示書 4章の確定稿67件を、HTML からタグ・コメント・`<script>` を除去した
地の文に対して照合した。

```
確定稿 67 件中 67 件一致
確定稿を差し引いた残り: "AI人材育成プログラム導入相談を予約する導入相談を予約する"
```

残りの内訳は次の2つだけで、**指示書に無い日本語の地の文は1つも存在しない。**

| 残った文字列 | 理由 |
| --- | --- |
| `AI人材育成プログラム` ×1 | `<title>` のテキスト。照合は地の文を対象にしており、`<title>` も残る |
| `導入相談を予約する` ×2 | 同じ文言がヘッダー・料金カード・申込みの3箇所に出るため、1回分しか引けていない |

### JSON-LD の FAQ と本文 FAQ の一致

`FAQPage.mainEntity` の `name` / `acceptedAnswer.text` を、本文の `<summary>` と
`.faq-answer` の `textContent` と厳密比較した。

```
4組すべて一致（ok: true, count: 4）
```

---

## 2. コントラスト

判定は WCAG AA（通常テキスト 4.5:1／大きい文字 3:1）。
`aria-hidden="true"` の要素（カード見出しの `｜`）は計測対象から除外している。

### 2-1. 背景ごとの最小値（全テキスト75件）

| 背景 | 最小値 | 判定 |
| --- | --- | --- |
| `#FAFAF8` Background | 4.81 | OK |
| `#FFFFFF` Surface | 5.03 | OK |
| `#EAF2F7` Pale Blue | 4.53 | OK |
| `#245B8A` Primary（ボタン上の白文字） | 7.15 | OK |

Pale Sage `#EDF2EE` はこのページで使っていない。

### 2-2. 色ごとの内訳

| 前景 | 使用要素数 | 最小値 | 判定 |
| --- | --- | --- | --- |
| Secondary `#567185`（eyebrow・番号・チェック記号・FAQの＋） | 10 | **4.53** | OK |
| Text Sub `#687078`（補助テキスト・注記・タグ） | 23 | **4.81** | OK |
| Text `#202326` / 白（ボタン上） | 残り | 7.15 以上 | OK |

**淡色背景（Pale Blue）に直接置く文字は `--color-text` へ上げてある**
（`--color-text-sub` は淡色の上で 4.44:1 と AA に届かないため）。対象は
`.pricing-body` `.pricing-closing` `.apply-lead` `.apply-meta` の4つ。

**料金カードの注記（`.price-note`）は小さくしても薄くしていない。**
白カードの上で `--color-text-sub` = 5.03:1。13px でも AA を満たす。

---

## 3. html-validate / axe-core

```
$ npx html-validate --preset a11y,recommended,standard index.html
（出力なし・終了コード 0）

axe.run(document, { resultTypes: ['violations'] })
violations: 0
```

どちらも指摘0のため、**見た目を変える修正は発生していない。**

---

## 4. スクリーンショットと横スクロール

[screenshots/](screenshots/) にフルページで保存。

| 幅 | scrollWidth | clientWidth | 横スクロール |
| --- | --- | --- | --- |
| 375px | 375 | 375 | **なし** |
| 768px | 768 | 768 | **なし** |
| 1440px | 1440 | 1440 | **なし** |

---

## 5. キーボード操作

Tab を9回押して `document.activeElement` を記録した結果。

```
1. a: 導入相談を予約する              ← ヘッダーCTA
2. a: 導入相談を予約する(無料・30分)   ← Hero CTA
3. a: 導入相談を予約する              ← 料金カードCTA
4. summary: 何名まで参加できますか？            ← FAQ 1
5. summary: 社員のITレベルがバラバラでも…       ← FAQ 2
6. summary: 業務システムへのAI導入も…          ← FAQ 3
7. summary: 契約期間や支払い方法を…            ← FAQ 4
8. a: 導入相談を予約する              ← 申込みCTA
9. body                              ← ブラウザUIへ抜ける
```

**ヘッダーCTA → 本文リンク → FAQ → 申込みCTA の順で到達できる。** DOM 順どおりで、
`tabindex` による順序の作り替えは行っていない。

| 操作 | 結果 |
| --- | --- |
| `summary` に Enter → 開く | OK |
| もう一度 Enter → 閉じる | OK |
| Space → 開く | OK |

テーマ例のタグはフォーカス対象にしていない（押せる要素ではないため）。

---

## 6. reduced-motion

```
.reveal の総数: 36
opacity !== 1 の要素: 0
```

---

## 7. ソフトローンチ構成の確認

| 項目 | 期待 | 実測 |
| --- | --- | --- |
| `noindex` | 1件（フェーズ2で削除する） | **1件** |
| `href="#"` | **0件**（CTA は予約ページへ接続済み） | **0件** |
| 申込みCTAのリンク先 | `https://calendar.app.google/j2vgYwytooBz9M1Q7` | **1件** |
| 個人向けLPの予約URL（`gMGf779…`）の誤混入 | 0件 | **0件** |
| `#apply` アンカー（ヘッダー・Hero・料金カード） | 3件 | **3件** |
| canonical | `https://tsam-ai.com/labs/ai-corporate-training/` | 一致 |
| `og:*` | type / url / title / description / image / image:width / image:height | **7件** |
| `twitter:card` | `summary_large_image` | 1件 |
| JSON-LD | `Service` ＋ `FAQPage` | 各1件 |
| 価格 | 55000 JPY | `"price": "55000"` ×2（`offers` と `priceSpecification`） |
| `AggregateRating` / `Review` | 使わない | **0件** |
| `--color-secondary` | `#567185`（補正後） | 一致 |
| OGP画像 | 1200×630 | 1200×630（37.0KB） |

ヘッダー・Hero・料金カードの3つのボタンは `#apply` へのページ内アンカーで、
遷移先の申込みセクションに予約ページへの CTA がある構成。

> **予約ページは個人向けLPと別物。** 短縮URLの末尾が
> 法人 `j2vgYwytooBz9M1Q7` ／ 個人 `gMGf779ioTYdkVuD7` と異なり、
> 転送先の予約スケジュールIDも別（法人 `AcZssZ35I7FN…` ／ 個人 `AcZssZ15jRDD…`）。
> 取り違えていないことを機械確認している。

---

## 8. 生データ

[results.json](results.json) に全測定値を保存している。

---

## 9. 再検証の手順

姉妹LPの
[personal-ai-training/qa/verification-report.md](../../personal-ai-training/qa/verification-report.md) §11
と同じ。対象ディレクトリを `public/labs/ai-corporate-training` に読み替える。

**コピーまたは FAQ を変更したときは、§1 の照合を必ずやり直すこと。**
JSON-LD と本文がずれると、Google はそれをスパムとして扱う。

# 自動検証レポート

実施日: 2026年8月7日
対象: [public/labs/personal-ai-training/](../../../public/labs/personal-ai-training/)
（`index.html` ／ `css/style.css` ／ `js/main.js`）

> 配信物は `public/` 配下へ移設した。この `qa/` と各レポートは**配信されない**よう
> `labs/` 側に残してある（`public/` に置くと `tsam-ai.com` から誰でも読めるため。
> 実測: `https://tsam-ai.com/apps/PHASE3_AUDIT_REPORT.md` は 200 を返す）。

検証に使ったパッケージ（`axe-core` / `html-validate`）は作業用ディレクトリにのみ入れ、
**リポジトリへはコミットしていない。** Playwright はリポジトリの devDependencies に既存。

## サマリー

| 項目 | 結果 |
| --- | --- |
| コントラスト（実レンダリング） | **56/56 合格** |
| html-validate（`a11y,recommended,standard`） | **指摘 0** |
| axe-core violations | **0** |
| 横スクロール（375 / 768 / 1440px） | **3幅とも発生なし** |
| キーボード操作 | **Tab順・Enter・Space すべて期待どおり** |
| reduced-motion | **fade 対象 31件すべて opacity: 1** |
| コピー照合（確定稿49件） | **49/49 一字一句一致** |
| JSON-LD の FAQ と本文の照合 | **3/3 一致** |

---

## 1. コントラスト（タスク1の決着を含む）

### 1-1. トークン単位の計算

背景4色すべてに対する比。判定は WCAG AA（通常テキスト 4.5:1／大きい文字 3:1）。

| 前景 | Background `#FAFAF8` | Surface `#FFFFFF` | Pale Blue `#EAF2F7` | Pale Sage `#EDF2EE` |
| --- | --- | --- | --- | --- |
| ~~旧 Secondary `#7895AA`~~ | 3.01 NG | 3.14 NG | 2.78 NG | 2.78 NG |
| ~~指示された `#5F7D93`~~ | 4.15 NG | 4.34 NG | 3.83 NG | 3.83 NG |
| **採用 Secondary `#567185`** | **4.91 OK** | **5.13 OK** | **4.53 OK** | **4.53 OK** |
| Primary `#245B8A` | 6.84 OK | 7.15 OK | 6.31 OK | 6.31 OK |
| Text `#202326` | 15.11 OK | 15.79 OK | 13.94 OK | 13.94 OK |
| Text Sub `#687078` | 4.81 OK | 5.03 OK | 4.44 NG | 4.44 NG |

**オーナー指示の `#5F7D93` では 4.5:1 に届かなかった**（最悪 3.83:1）。
指示書タスク1-3 の「不足する背景があればさらに暗い値を検討してよい／ただし
Primary より暗くしない」に従い、`#5F7D93` の色相を保ったまま**4背景すべてが
4.5:1 を満たす最も明るい値**を二分探索して `#567185` を採用した。

- 輝度 0.1548。Primary の 0.0969 より明るいため、Primary との役割の差は保たれている
- これ以上明るくすると淡色背景で 4.5 を割る（`#5F7D93` 方向へ 1 段戻すと 4.49 以下）

`--color-text-sub` は淡色背景で 4.44:1 と AA に届かないままだが、**淡色背景に直接
置いている補助テキスト3箇所（サイクル締め・目指す状態の補足・申込みメタ）は
前回作業で `--color-text` へ上げてあり、今回もそのまま維持している。**
残る Text Sub の使用箇所はすべて基調色（4.81）か白（5.03）の上にあり AA を満たす。

### 1-2. Secondary を使用している実要素（全9件・重複を除いて表示）

| 要素 | テキスト | サイズ | 背景 | 実測 | 判定 |
| --- | --- | --- | --- | --- | --- |
| `p.eyebrow` | "One-on-one / Online" | 12px | `#FAFAF8` | 4.91 | OK |
| `p.eyebrow` | "Concerns" ほか | 12px | `#FFFFFF` | 5.13 | OK |
| `p.eyebrow` | "Monthly Cycle" | 12px | `#EAF2F7` | 4.53 | OK |
| `p.eyebrow` | "Goal" | 12px | `#EDF2EE` | 4.53 | OK |
| `span.card-no` | "Session 01" / "Session 02" | 13px | `#FFFFFF` | 5.13 | OK |

`span.card-sep`（カード見出しの `｜`）は `aria-hidden="true"` を付けた区切り記号のため
計測対象から除外している（WCAG 1.4.3 の「純粋な装飾」に当たる）。色は Secondary で
描画されるため、仮に対象としても 5.13:1 で AA を満たす。

### 1-3. 背景ごとの最小コントラスト（全テキスト）

| 背景 | 最小値 | 判定 |
| --- | --- | --- |
| `#FAFAF8` Background | 4.81 | OK |
| `#FFFFFF` Surface | 5.03 | OK |
| `#EAF2F7` Pale Blue | 4.53 | OK |
| `#EDF2EE` Pale Sage | 4.53 | OK |
| `#245B8A` Primary（ボタン上の白文字） | 7.15 | OK |

---

## 2. html-validate

```
$ npx html-validate --preset a11y,recommended,standard index.html
（出力なし・終了コード 0）
```

**指摘 0。** 修正は発生していないため、見た目は変わっていない。

---

## 3. axe-core

Playwright で実ページに `axe-core` を注入し `axe.run()` を実行。

```
violations: 0
```

修正は発生していない。

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
1. a: 申し込む                      ← ヘッダーCTA
2. a: マンツーマンAI学習を始める      ← Hero CTA
3. a: AIを使える自分をつくる          ← 料金CTA
4. summary: AIにまったく詳しくなくても受講…   ← FAQ 1
5. summary: 受講に必要なものはありますか？     ← FAQ 2
6. summary: 授業の内容は決まっていますか？     ← FAQ 3
7. a: マンツーマンAI学習を始める      ← 申込みCTA
8. body                            ← ブラウザUIへ抜ける
9. a: 申し込む                      ← 先頭へ戻る
```

**ヘッダーCTA → 本文リンク → FAQ → 申込みCTA の順で到達できる。** DOM 順どおりで、
`tabindex` による順序の作り替えは行っていない。

| 操作 | 結果 |
| --- | --- |
| `summary` に Enter → 開く | OK |
| もう一度 Enter → 閉じる | OK |
| Space → 開く | OK |

フォーカスリングは `:focus-visible` で表示（`outline: 2px solid var(--color-primary)`）。

---

## 6. reduced-motion

`prefers-reduced-motion: reduce` のコンテキストでページを開き、fade 対象の
`opacity` を全件測定した。

```
.reveal の総数: 31
opacity !== 1 の要素: 0
```

タスク1（色）・タスク3（メタ情報）の変更後も、**動きの軽減設定でアニメーションが
完全に無効化されている。**

---

## 7. コピー照合

実装指示書 4章の確定稿49件を、HTML からタグ・コメント・`<script>` を除去した
地の文に対して照合した。

```
確定稿 49 件中 49 件一致
確定稿を差し引いた残り: "パーソナルAIトレーニングマンツーマンAI学習を始める"
```

残りは、**同じ文字列が2回出てくる2件**（サイト名がヘッダーとフッターの両方に、
CTA文言が Hero と申込みの両方に）を引き切れていないだけで、**指示書に無い日本語の
地の文は存在しない。**

メタ情報・JSON-LD は照合対象外（指示書 タスク4-6）。

### JSON-LD の FAQ と本文 FAQ の一致

`FAQPage.mainEntity` の `name` / `acceptedAnswer.text` を、本文の `<summary>` と
`.faq-answer` の `textContent` と厳密比較した。

```
3組すべて一致（ok: true, count: 3）
```

---

## 8. 生データ

[results.json](results.json) に全測定値を保存している（コントラスト全56件の
前景色・背景色・サイズ・比、axe の結果、メタ情報、Tab順）。

---

## 9. ローカルでの確認と再検証の手順

### 見た目を確認するだけ

```powershell
npx serve public/labs/personal-ai-training
# もしくは
py -m http.server 8000 --directory public/labs/personal-ai-training
```

`file://` では開かないこと（フォント取得と相対パスが解決できない）。

配信構成ごと確認したい場合は、リポジトリのルートで `npm run dev` を実行して
<http://localhost:3000/labs/personal-ai-training/> を開く。
`next.config.ts` の fallback rewrite を通るため、本番と同じ経路になる。

### 検証をやり直す

このレポートの数値は、次の4つを実行して得たもの。**検証用パッケージは
リポジトリへ入れていない**ため、作業用ディレクトリで `--no-save` で入れる。

```powershell
# 1. 検証用パッケージ（リポジトリ外の作業ディレクトリで）
npm i --no-save axe-core html-validate

# 2. HTML 構文
npx html-validate --preset a11y,recommended,standard `
  public/labs/personal-ai-training/index.html

# 3. Playwright はリポジトリの devDependencies に既にある
npx playwright install chromium
```

コントラスト・axe・スクリーンショット・キーボード・reduced-motion は
Playwright で1本のスクリプトにまとめて測っている。要点は次のとおり。

| 測定 | 方法 |
| --- | --- |
| コントラスト | `getComputedStyle` の `color` と、祖先をたどって最初に不透明だった `backgroundColor` から相対輝度比を計算。`aria-hidden="true"` の要素は除外 |
| axe | 実ページに `axe-core` を `addScriptTag` で注入し `axe.run(document, { resultTypes: ['violations'] })` |
| 横スクロール | `documentElement.scrollWidth <= clientWidth` |
| キーボード | `page.keyboard.press('Tab')` を9回押して `document.activeElement` を記録 |
| reduced-motion | `browser.newContext({ reducedMotion: 'reduce' })` で開き、`.reveal` 全件の `opacity` を確認 |
| コピー照合 | HTML からタグ・コメント・`<script>` を除去し、確定稿49件が含まれるかを検査 |
| JSON-LD 照合 | `FAQPage.mainEntity` と `<summary>` / `.faq-answer` の `textContent` を厳密比較 |

**コピーまたは FAQ を変更したときは、§7 の照合を必ずやり直すこと。**
JSON-LD と本文がずれると、Google はそれをスパムとして扱う。

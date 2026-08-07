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
| コントラスト（実レンダリング） | **58/58 合格**（2026-08-08 の相互リンク追加後） |
| html-validate（`a11y,recommended,standard`） | **指摘 0** |
| axe-core violations | **0** |
| 横スクロール（375 / 768 / 1440px） | **3幅とも発生なし** |
| キーボード操作 | **Tab順・Enter・Space すべて期待どおり** |
| reduced-motion | **fade 対象 31件すべて opacity: 1** |
| コピー照合（確定稿49件＋相互リンク1件） | **50/50 一字一句一致** |
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
7. a: マンツーマンAI学習を始める      ← 申込みCTA（予約ページへ）
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
CTA文言が Hero と申込みの両方に）を引き切れていないだけ。

**したがって、実装指示書の確定稿に無い日本語の地の文は1つも存在しない。**
正式公開にあたって CTA 下へ補足1行を足す案があったが、オーナー判断で見送っている。

メタ情報・JSON-LD は照合対象外（指示書 タスク4-6）。

### JSON-LD の FAQ と本文 FAQ の一致

`FAQPage.mainEntity` の `name` / `acceptedAnswer.text` を、本文の `<summary>` と
`.faq-answer` の `textContent` と厳密比較した。

```
3組すべて一致（ok: true, count: 3）
```

---

## 8. 生データ

[results.json](results.json)（ローカル）と [results-live.json](results-live.json)（本番）に全測定値を保存している（コントラスト全56件の
前景色・背景色・サイズ・比、axe の結果、メタ情報、Tab順）。

---

## 9. 本番デプロイ後の検証（2026-08-07）

デプロイした版: **`e825d31c-71d2-493c-869e-b1911bda87d0`**（内容は `3e55e0f`）
切り戻し先の版: `632b0c1f-eab2-48b5-ae9d-7e854d6d5ae4`

`wrangler` がアップロードしたのは **6ファイルだけ**（LP の5点 ＋ `BUILD_ID`）。
残り539ファイルは「already uploaded」で、**既存の配信物には一切触れていない。**

### 9-1. LP

| 確認 | 結果 |
| --- | --- |
| `https://tsam-ai.com/labs/personal-ai-training/` | **200** |
| 配信HTML vs リポジトリ | **差分 0 行** |
| `noindex` | **あり**（1件）※ soft launch 時点。正式公開で削除済み（§10） |
| `href="#"` | **0件** |
| 「申し込み受付は、現在準備中です。」 | **あり**（1件）※ soft launch 時点。正式公開で CTA へ戻した（§10） |
| `css/style.css` `js/main.js` `favicon.svg` `ogp.png` | すべて **200** |
| canonical / og:* / twitter:card / JSON-LD | すべて配信HTMLに含まれる |
| 本番URLでの再計測（コントラスト / axe / 横スクロール / reduced-motion / FAQ照合） | ローカルと同じ結果（56/56・0件・3幅なし・31件すべて `opacity:1`・3/3） |
| 3幅スクリーンショット | [screenshots/live/](screenshots/live/) |

### 9-2. 既存ページの回帰

デプロイ直前に保存した配信HTMLと突き合わせた。

| URL | 結果 |
| --- | --- |
| `/` | **差分なし** |
| `/login/` | **差分なし** |
| `/portal/` | **差分なし** |
| `/apps/` | **差分なし** |
| `/event/` | **差分なし** |
| `/event/apply/` | **200 かつ `x-opennext: 1`**（サーバー側が動いている証拠） |
| `/production-app/voice-recorder/` | **200**。配信HTML はリポジトリと差分 0 行 |
| `/production-app/receipt-ocr/` | **200** |

**ロールバックは発生していない。**

### 9-3. デプロイ直後に1度だけ 404 を観測した

デプロイ完了の数秒後に取得した768px のスクリーンショットが、Next.js の
404 ページになっていた（375px と 1440px は同時刻に成功している）。

その後 **30回連続で叩いて 30回とも 200**（`CF-Cache-Status: HIT`）。
再取得したスクリーンショットも正常。**エッジへの伝播中の一過性**と判断した。

> デプロイ直後の検証は、**数十秒おいてから**行うか、複数回叩いて確かめること。
> 1回の 404 で異常と判断しない。逆に、1回の 200 で正常と判断しないこと。

---

## 10. 正式公開（2026-08-07）

無料相談の予約ページが用意できたため、soft launch を解除した。

| 変更 | 内容 |
| --- | --- |
| CTA | 「申し込み受付は、現在準備中です。」→ **ボタン「マンツーマンAI学習を始める」**（文言は確定稿どおり）。リンク先は `https://calendar.app.google/gMGf779ioTYdkVuD7`（`target` 無し＝同一タブ） |
| `noindex` | **削除**（TODO コメントごと） |
| CSS | 不要になった `.apply-pending` を削除。`.apply .btn` は元から残してあったため追加は不要だった |
| CTA下の補足1行 | **追加しない**（オーナー判断） |
| sitemap 登録 | **行っていない。** サイトに `sitemap.xml` が存在しないため（§10-2） |

### 10-1. 再検証（すべて再実行）

| 項目 | 結果 |
| --- | --- |
| コピー照合 | **49/49 一致。確定稿に無い地の文は0件** |
| コントラスト | **56/56 合格** |
| axe-core violations | **0** |
| html-validate | **指摘 0** |
| 横スクロール（375/768/1440） | **3幅ともなし** |
| reduced-motion | fade 対象31件すべて `opacity: 1` |
| JSON-LD の FAQ 照合 | **3/3 一致** |
| `robots` メタ | **null（noindex なし）** |
| canonical / og:url / og:image / JSON-LD の `url` | すべて `https://tsam-ai.com/labs/personal-ai-training/` のまま |
| Tab順 | 申込みCTAが7番目に復帰 |

### 10-2. デプロイ後の検証

デプロイした版: **`566a82b4-c428-40ae-8f38-dfd321040a53`**（内容は `b62df4e`）
切り戻し先の版: `866bdd93-7343-4d2f-8da0-a527e481cd2e`

アップロードは **3ファイルのみ**（`index.html`・`css/style.css`・`BUILD_ID`）、
残り542ファイルは無変更。

| 確認 | 結果 |
| --- | --- |
| LP 配信HTML vs リポジトリ | **差分 0 行** |
| `noindex` | **0件**（解除できている） |
| 「準備中」 | **0件** |
| CTA の `href` | `https://calendar.app.google/gMGf779ioTYdkVuD7` |
| canonical | 変更なし |
| 通し導線（`/potenitas/` → LP → CTA） | デスクトップ・モバイルとも **`calendar.google.com` へ 200・同一タブ** |
| 回帰6ページ（`/` `/login/` `/portal/` `/apps/` `/event/` `/potenitas/`） | **全件 差分0行** |
| `/event/apply/` | 200 かつ `x-opennext: 1` |
| 本番での再計測 | コントラスト56/56・axe 0件・横スクロール3幅なし・reduced-motion 31/31・FAQ 3/3 |

**ロールバックは発生していない。**

### 10-3. エッジキャッシュの入れ替わりに時間がかかった

**今回は「既存ファイルの中身を書き換える」デプロイだったため、直後は
古い内容が配信され続けた。** これまでのデプロイは新規ファイルの追加が
中心で、この現象は起きていなかった。

```
デプロイ直後   … noindex あり・準備中あり（古い内容）／CF-Cache-Status: HIT
                  ただしキャッシュバスター付きURLでは新しい内容が返る
                  → オリジンは更新済み、エッジが古いだけと判別できる
しばらく後     … 6回中5回が新しい内容（エッジノードごとに差がある）
さらに後       … 25回中25回が新しい内容（収束）
```

`Cache-Control: public, max-age=0, must-revalidate` でも即時には入れ替わらない。

> **既存ファイルを更新するデプロイでは、検証の前にエッジの収束を待つこと。**
> 判別方法: **クエリ文字列を付けたURL**（`?cb=12345`）を引くと、キャッシュを
> 迂回してオリジンの内容が見える。そこが新しければ配信物の問題ではなく、
> エッジの入れ替わり待ちである。
> 急ぐ場合は Cloudflare ダッシュボード → Caching → Purge Everything
> （今回は指示の制約により実行していない。待って収束させた）。

### 10-4. sitemap を登録しなかった理由

**このサイトには `sitemap.xml` も `robots.txt` も存在しない。**

```
https://tsam-ai.com/sitemap.xml   → 404
https://tsam-ai.com/robots.txt    → 404
```

`public/` 配下にも Next.js のルート（`app/`）にも無く、リポジトリ内で
sitemap を参照している箇所も無い（`lp-draft/sitemap.ts` は退避したLP用で未配信）。

したがって「既存の sitemap にLPを追加する」作業は成立しなかった。
**LP だけを載せた sitemap を新規に作ると、サイト全体の中でこのLPだけが
重要だと申告する形になる**ため、作っていない。サイト全体の sitemap を
用意するかどうかは、このLPの範囲を超える判断としてオーナーへ残した。

---

## 11. 姉妹LPへの相互リンク追加（2026-08-08）

法人向けLP「AI人材育成プログラム」の正式公開に合わせ、**フッター直上に
1行のクロスリンク**を置いた。文言はオーナー指定の固定文で、こちらで作った
言葉は無い。

```text
企業・チームでの導入をお考えの方へ — 法人向け「AI人材育成プログラム」
                                     └ リンク（/labs/ai-corporate-training/）
```

| 決めたこと | 理由 |
| --- | --- |
| **ボタンにせずテキストリンク1行** | 直前が申込みCTA。同じ強さの要素を続けると、どちらを押せばよいか分からなくなる |
| リンクは**後半の商品名だけ**に掛ける | リンクテキスト単体で行き先が分かる（WCAG 2.4.4）。「こちら」のような文言を作らずに済む |
| **下線を付ける** | 色の差だけで「押せる」と示さない（WCAG 1.4.1） |
| リンクの色は Secondary `#567185` | 補助テキスト色のままではリンクに見えない。淡色でない基調背景の上で **4.91:1**（AA） |
| 罫線は上下1本ずつ、`.container` の内側 | 本文の左右幅と揃う。フッターとの間も切れる |
| `target` を付けない | サイト内移動。他のCTAと挙動を揃える（同一タブ） |
| CSS は**姉妹LPと共通化しない** | 2本のLPは別々に育つ。片方の帯を直してもう片方が壊れるのを避ける |

### 11-1. 再検証（ローカル）

| 項目 | 前回 | 今回 |
| --- | --- | --- |
| コピー照合 | 49/49 | **50/50**（確定稿49件＋相互リンク1件） |
| コントラスト | 56/56 | **58/58**（追加分: 地の文 4.81 / リンク 4.91・どちらも AA） |
| axe-core violations | 0 | **0** |
| html-validate | 0 | **0** |
| reduced-motion | 31/31 | **31/31**（帯は `.reveal` にしていない。フッターと同じ扱い） |
| JSON-LD の FAQ 照合 | 3/3 | **3/3** |
| Tab順 | 7番目が申込みCTA | 申込みCTAの**次**（8番目）に相互リンク |

横スクロールは AGENTS.md の指定幅5つで測り直した。

| 幅 | 320 | 375 | 768 | 1024 | 1440 |
| --- | --- | --- | --- | --- | --- |
| 横スクロール | なし | なし | なし | なし | なし |
| 帯の行数 | 2行 | 2行 | 1行 | 1行 | 1行 |

### 11-2. 相互リンクの往復（Playwright でクリック）

`target` を付けていないので、**タブは増えない**ことも併せて確認している。

| 起点 | 着地 | ステータス | `<title>` | タブ数 |
| --- | --- | --- | --- | --- |
| `/labs/personal-ai-training/` | `/labs/ai-corporate-training/` | 200 | AI人材育成プログラム | 1 |
| `/labs/ai-corporate-training/` | `/labs/personal-ai-training/` | 200 | パーソナルAIトレーニング | 1 |

デスクトップ（1440×900）・モバイル（390×844）の両方で同じ結果。

### 11-3. 長音符が行頭に来た

375px で帯が2行になると、既定の折り返しでは姉妹LP側が
「マンツ / ーマン」と割れた。**長音符の行頭禁則が効いていない。**
段落に `line-break: strict` を付けて「マンツー / マンの」に直している。

このLPの文言では割れないが、**同じ規則を両方に置いた**（帯の実装を
左右で食い違わせないため）。

### 11-4. デプロイ

法人向けLPの正式公開・POTENITAS の導線接続と**同じ1回のデプロイ**にまとめた。

デプロイした版: **`210b6b26-0544-46ba-9fe3-ce29764be7bc`**（内容は `f5d2f85`）
切り戻し先の版: `218a6e77-6eea-4487-bdcd-0d97074a4f74`

アップロードは **6ファイル**（両LPの `index.html` と `css/style.css`、
`potenitas/index.html`、`BUILD_ID`）、残り544ファイルは無変更。

| 確認 | 結果 |
| --- | --- |
| 配信物 vs リポジトリ | **5点とも 差分 0 行** |
| このLPの差分（デプロイ前後） | **相互リンク1箇所のみ**。他の行は変わっていない |
| 相互リンクの往復 | 両方向とも 200・同一タブ（§11-2 と同じ結果） |
| 回帰5ページ（`/` `/login/` `/portal/` `/apps/` `/event/`） | **全件 デプロイ前と同一** |
| 本番URLでの再計測 | コントラスト58/58・axe 0件・横スクロール3幅なし・reduced-motion 31/31・FAQ 3/3 |

**ロールバックは発生していない。**

> **回帰の対象からこのLPを外した。** 今回はこのLP自身に変更が入るため、
> 「1バイトも変わらない」を期待できない。代わりに変更が相互リンク1箇所だけで
> あることを差分で確認している。

詳細は法人向けLPの
[ai-corporate-training/qa/verification-report.md](../../ai-corporate-training/qa/verification-report.md) §8-3。

---

## 12. ローカルでの確認と再検証の手順

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
| コピー照合 | HTML からタグ・コメント・`<script>` を除去し、確定稿49件＋相互リンク1件が含まれるかを検査 |
| JSON-LD 照合 | `FAQPage.mainEntity` と `<summary>` / `.faq-answer` の `textContent` を厳密比較 |

**コピーまたは FAQ を変更したときは、§7 の照合を必ずやり直すこと。**
JSON-LD と本文がずれると、Google はそれをスパムとして扱う。

# 自動検証レポート（AI人材育成プログラム LP）

実施日: 2026年8月7日（初回）／2026年8月8日（正式公開・相互リンク追加後に再実施）
対象: [public/labs/ai-corporate-training/](../../../public/labs/ai-corporate-training/)
（`index.html` ／ `css/style.css` ／ `js/main.js`）

検証に使ったパッケージ（`axe-core` / `html-validate`）は作業用ディレクトリにのみ入れ、
**リポジトリへはコミットしていない。** Playwright はリポジトリの devDependencies に既存。

## サマリー

| 項目 | 結果 |
| --- | --- |
| コピー照合（確定稿69件＋相互リンク1件） | **70/70 一字一句一致** |
| JSON-LD の FAQ と本文の照合 | **4/4 一致** |
| コントラスト（実レンダリング） | **79/79 合格** |
| html-validate（`a11y,recommended,standard`） | **指摘 0** |
| axe-core violations | **0** |
| 横スクロール（375 / 768 / 1440px） | **3幅とも発生なし** |
| キーボード操作 | **Tab到達・Enter・Space すべて期待どおり** |
| reduced-motion | **fade 対象 38件すべて opacity: 1** |
| ソフトローンチ構成の存在確認 | **すべて期待どおり** |

---

## 1. コピー照合

実装指示書 4章の確定稿69件と、フッター直上の相互リンク1件（2026-08-08 追加・
オーナー指定の固定文言）を、HTML からタグ・コメント・`<script>` を除去した
地の文に対して照合した。

```
確定稿 70 件中 70 件一致
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

### 2-1. 背景ごとの最小値（全テキスト79件）

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
| Secondary `#567185`（eyebrow・番号・チェック記号・FAQの＋・相互リンク） | 12 | **4.53** | OK |
| Text Sub `#687078`（補助テキスト・注記・タグ・相互リンクの地の文） | 24 | **4.81** | OK |
| Text `#202326` / 白（ボタン上） | 残り | 7.15 以上 | OK |

相互リンク帯（2026-08-08 追加）の実測は次のとおり。どちらも 14px の通常テキストで、
判定は 4.5:1。

| 要素 | 前景 | 背景 | 比 | 判定 |
| --- | --- | --- | --- | --- |
| 地の文「個人での受講をお考えの方へ —」 | `#687078` | `#FAFAF8` | **4.81** | OK |
| リンク「マンツーマンの「パーソナルAIトレーニング」」 | `#567185` | `#FAFAF8` | **4.91** | OK |

**リンクには下線を付けている。** 色の差だけで「押せる」ことを示すと、
色を区別しづらい人に伝わらないため（WCAG 1.4.1 の要求）。

帯の設計判断（ボタンにしない・リンクは商品名だけに掛ける・CSS を共通化しない）と
往復クリックの結果は、姉妹LPの
[personal-ai-training/qa/verification-report.md](../../personal-ai-training/qa/verification-report.md) §11
にまとめてある。**2本のLPで同じ内容なので、片方にだけ書いた。**

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

相互リンク帯を足した 2026-08-08 は、AGENTS.md の指定幅5つすべてで測り直した。

| 幅 | 横スクロール | 相互リンク帯の行数 |
| --- | --- | --- |
| 320px | **なし** | 2行 |
| 375px | **なし** | 2行 |
| 768px | **なし** | 1行 |
| 1024px | **なし** | 1行 |
| 1440px | **なし** | 1行 |

> **375px で長音符が行頭に来た。** 既定の折り返しでは
> 「マンツ / ーマン」と割れる。段落に `line-break: strict` を付けて
> 長音符・小書き仮名の行頭禁則を効かせ、「マンツー / マンの」に直している。

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
9. a: マンツーマンの「パーソナルAIト… ← 相互リンク（2026-08-08 追加）
```

**ヘッダーCTA → 本文リンク → FAQ → 申込みCTA → 相互リンク の順で到達できる。** DOM 順どおりで、
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
.reveal の総数: 38
opacity !== 1 の要素: 0
```

---

## 7. 構成の確認

`noindex` の行だけ、2026-08-08 の正式公開（フェーズ2）で期待値が反転している。
他は初回から変わっていない。

| 項目 | 期待 | 実測 |
| --- | --- | --- |
| `noindex` | **0件**（2026-08-08 に削除。それ以前は1件） | **0件** |
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
| 相互リンクの `href` | `/labs/personal-ai-training/`（サイト絶対・同一タブ） | 一致・`target` なし |

ヘッダー・Hero・料金カードの3つのボタンは `#apply` へのページ内アンカーで、
遷移先の申込みセクションに予約ページへの CTA がある構成。

> **予約ページは個人向けLPと別物。** 短縮URLの末尾が
> 法人 `j2vgYwytooBz9M1Q7` ／ 個人 `gMGf779ioTYdkVuD7` と異なり、
> 転送先の予約スケジュールIDも別（法人 `AcZssZ35I7FN…` ／ 個人 `AcZssZ15jRDD…`）。
> 取り違えていないことを機械確認している。

---

## 8. デプロイ（2026-08-07 ソフトローンチ／2026-08-08 正式公開）

フェーズ1で2回、フェーズ2で1回デプロイしている（フェーズ1の1回目のあとに
オーナー確認で FAQ の見出し追加が入ったため）。

| 回 | 版 | 内容 | アップロード |
| --- | --- | --- | --- |
| 1回目 | `f2aabd2c-3ead-45d2-9305-308521f8d46e` | `169a499`（初回のソフトローンチ） | 4ファイル |
| 2回目 | `218a6e77-6eea-4487-bdcd-0d97074a4f74` | `72f2675`（FAQ の見出し追加） | 2ファイル（`index.html` ＋ `BUILD_ID`） |
| **3回目（現行）** | **`210b6b26-0544-46ba-9fe3-ce29764be7bc`** | `f5d2f85`（正式公開・POTENITAS 導線・相互リンク） | **6ファイル**（両LPの `index.html` と `css/style.css`・`potenitas/index.html` ＋ `BUILD_ID`） |

切り戻し先の版: `218a6e77-6eea-4487-bdcd-0d97074a4f74`（2回目）。
そこからさらに戻すなら `f2aabd2c`（1回目）→ `566a82b4`（法人LP追加前）。

> **デプロイは WSL の別クローンから行う。** Windows 側で `npm run deploy` を
> 実行すると、ビルドは通るのに wrangler のアップロード段階で
> `Error: write EOF` になって落ちた（2026-08-08 実測）。OpenNext 自身が
> Windows を「実行時に予測できない失敗が起こりうる」としている
> （[docs/deployment-cloudflare.md](../../../docs/deployment-cloudflare.md) §2）。
> **落ちたのはアップロード前なので、本番は一切変わっていない。**

1回目のアップロードは **4ファイル**（`index.html` / `css/style.css` / `ogp.png` ＋ `BUILD_ID`）。
`js/main.js` と `favicon.svg` は姉妹LPと**バイト単位で同一**のため、
Cloudflare の内容ハッシュによる重複排除で再アップロードされていない。

フェーズ1（ソフトローンチ）時点の確認結果:

| 確認 | 結果 |
| --- | --- |
| 新LP `https://tsam-ai.com/labs/ai-corporate-training/` | **200** |
| 配信HTML vs リポジトリ | **差分 0 行** |
| `noindex` | **あり**（フェーズ2で削除） |
| CTA の `href` | `https://calendar.app.google/j2vgYwytooBz9M1Q7` |
| `href="#"` | **0件** |
| 付随アセット（css / js / favicon / ogp） | **4点とも 200** |
| CTA の遷移（デスクトップ・モバイル） | `calendar.google.com` へ **200・同一タブ**。スケジュールID `AcZssZ35I7FN…`（**個人向けの `AcZssZ15jRDD…` とは別物**） |
| 回帰7ページ（`/` `/login/` `/portal/` `/apps/` `/event/` `/potenitas/` `/labs/personal-ai-training/`） | **全件 差分0行** |
| `/event/apply/` | 200 かつ `x-opennext: 1` |
| 本番URLでの再計測 | コントラスト77/77・axe 0件・横スクロール3幅なし・reduced-motion 38/38・FAQ 4/4 |
| 3幅スクリーンショット | [screenshots/live/](screenshots/live/) |

**ロールバックは発生していない。**

### 8-1. 新規パスでも「404 の残りかす」が出た

**今回は新規パスの追加なのに、デプロイ直後に 404 が混ざった。**

```
デプロイ直後   … 12回中 7回が 200、5回が 404
数分後         … 20回中 19回が 200
さらに後       … 20回中 20回が 200（収束）
```

原因は**否定キャッシュ**。デプロイ前のベースライン取得や状態確認で
同じURLを叩いており、そのときの 404 がエッジに載っていた。
Cloudflare は 404 応答もキャッシュするため、新規パスでも
「まだ無かった頃の答え」がしばらく返る。

判別は姉妹LPの
[personal-ai-training/qa/verification-report.md](../../personal-ai-training/qa/verification-report.md) §10-3
と同じ方法で付く。**クエリ文字列を付けたURL**ならキャッシュを迂回して
オリジンを見られる。

```
?cb=12345 付き … 8回中 8回が 200。アセット4点もすべて 200
→ 配信物は正しく、エッジの否定キャッシュが残っているだけと判定
```

> **デプロイ前に新規URLの 404 を確認すると、その 404 がキャッシュされる。**
> 確認したいときはクエリ文字列を付けるか、デプロイ後の収束待ちを見込むこと。

### 8-2. 2回目（既存ファイルの更新）はさらに時間がかかった

FAQ の見出し追加は `index.html` の**書き換え**なので、姉妹LPの正式公開時と
同じ「既存ファイル更新」のパターンになった。

```
デプロイ直後   … 20回中  7回が新しい内容
以降           … 15 → 13 → 17 → 13 → 24 → 24 → 25/25（収束）
```

**新規パスの追加（8-1）より明らかに長い。** 収束の途中は行ったり来たりする
（エッジノードごとに入れ替わる時刻が違うため、19/20 のあと 13/20 に戻ることもある）。
**1ラウンドの結果で判断せず、0件になるまで繰り返すこと。**

オリジンはこの間ずっと正しかった（クエリ文字列付きで確認済み）。

### 8-3. 3回目（正式公開・2026-08-08）の確認

| 確認 | 結果 |
| --- | --- |
| 配信物 vs リポジトリ（法人LP・個人LP・POTENITAS の HTML と CSS 2本） | **5点とも 差分 0 行** |
| `noindex` | **0件**（削除できている。`robots` メタは `null`） |
| 相互リンクの往復（デスクトップ・モバイル） | 両方向とも **200・同一タブ・タブ数1**。着地の `<title>` も一致 |
| 通し導線（`/potenitas/` →「AI人材を育成しよう」→ 法人LP → 申込みCTA） | デスクトップ・モバイルとも **`calendar.google.com` へ 200・同一タブ**。スケジュールID `AcZssZ35I7FN…`（法人） |
| 個人向けの導線（「AIスキルを身につけよう」） | **`/labs/personal-ai-training/` のまま生存** |
| POTENITAS の差分 | **+1 行 / −1 行**（`href` を足した1行だけ）。表示はスクリーンショットのハッシュ一致で不変を確認 |
| 個人LPの差分 | **相互リンク1箇所のみ**（`<aside class="cross-link">` の追加。他の行の変更なし） |
| 回帰5ページ（`/` `/login/` `/portal/` `/apps/` `/event/`） | **全件 デプロイ前と同一** |
| 付随アセット（両LPの css / js / favicon / ogp） | **8点とも 200** |
| `/event/apply/` | 200 かつ `x-opennext: 1` |
| `/production-app/voice-recorder/` | 200 |
| 本番URLでの再計測（法人LP） | コントラスト79/79・axe 0件・横スクロール3幅なし・reduced-motion 38/38・FAQ 4/4 |
| 本番URLでの再計測（個人LP） | コントラスト58/58・axe 0件・横スクロール3幅なし・reduced-motion 31/31・FAQ 3/3 |
| 3幅スクリーンショット | [screenshots/live/](screenshots/live/) |

**ロールバックは発生していない。**

> **回帰の対象から個人向けLPを外した。** 今回は個人LPにも相互リンクが入るため、
> 「1バイトも変わらない」を期待できない。代わりに**変更が相互リンク1箇所だけである
> ことを差分で確認**している（上表）。

エッジキャッシュは今回**すぐ収束した**（1ラウンド目で 100/100）。念のため
2ラウンド追加して 125/125・125/125 を確認している。§8-2 のときと違うのは、
デプロイ前に同じURLを叩いた回数が少なかったためと見ている。**毎回この速さとは
限らないので、確認は 0件になるまで繰り返すこと。**

---

## 9. 生データ

[results.json](results.json)（ローカル）と [results-live.json](results-live.json)（本番）に
全測定値を保存している。

---

## 10. 再検証の手順

姉妹LPの
[personal-ai-training/qa/verification-report.md](../../personal-ai-training/qa/verification-report.md) §12
と同じ。対象ディレクトリを `public/labs/ai-corporate-training` に読み替える。

**コピーまたは FAQ を変更したときは、§1 の照合を必ずやり直すこと。**
JSON-LD と本文がずれると、Google はそれをスパムとして扱う。

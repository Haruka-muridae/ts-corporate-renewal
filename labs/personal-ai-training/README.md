# パーソナルAIトレーニング LP

月額11,000円・月2回・各60分のオンラインマンツーマンAI学習サービスのランディングページ。

---

## 公開状態

> **正式公開済み（2026-08-07）。** `noindex` を解除し、CTA は無料相談の
> 予約ページへつないである。

| | 状態 |
| --- | --- |
| `main` へのマージ | **済**（2026-08-07） |
| 本番への公開 | **済**（2026-08-07・`npm run deploy`。2026-08-08 に相互リンクを追加して再デプロイ） |
| URL | `https://tsam-ai.com/labs/personal-ai-training/` |
| 検索インデックス | **許可**（`noindex` は削除済み） |
| 申込み | **CTA「マンツーマンAI学習を始める」→ Google カレンダーの予約スケジュール**（30分の無料相談）。同一タブ遷移 |
| sitemap 登録 | **していない。** そもそもこのサイトに `sitemap.xml` が存在しない（下記） |
| 流入経路 | `/potenitas/` の相談テーマ「AIスキルを身につけよう」から（2026-08-07 接続）／[法人向けLP](../ai-corporate-training/README.md) のフッター直上から（2026-08-08 接続） |

### sitemap について

**このサイトには `sitemap.xml` も `robots.txt` も無い。** `public/` 配下にも
Next.js のルートにも存在せず、`https://tsam-ai.com/sitemap.xml` と
`/robots.txt` はいずれも 404 を返す（2026-08-07 実測）。
`lp-draft/sitemap.ts` は退避したLP用で、配信されていない。

したがって「既存の sitemap にLPを追加する」という作業は成立しなかった。
LP だけを載せた sitemap を新規に作ると、**サイト全体の中でこのLPだけが
重要だと申告する形**になり、かえって不利益になりうるため作っていない。

サイト全体の sitemap を用意するかどうかは、このLPの範囲を超える判断
なのでオーナーに委ねる。無くてもクローラは辿れる（`/potenitas/` から
リンクがある）。

申込みフォームが未完成のため、押せないボタンを置く代わりに文章で案内している。
ヘッダーの「申し込む」と料金カードの「AIを使える自分をつくる」は `#apply` への
ページ内アンカーのままで、**遷移先で準備中の案内が読める**構成になっている。

**マージは公開ではない。** 本番は Cloudflare Workers が配信しており、Git 連携も
自動ビルドも設定されていない。公開は `npm run deploy` の手動実行でのみ起きる
（[deployment-report.md](./deployment-report.md) §4）。

---

## ファイル構成

配信されるもの（`public/` 配下）:

```text
public/labs/personal-ai-training/
├── index.html        1ページ完結（8セクション）
├── css/style.css     デザイントークンとレイアウト
├── js/main.js        スクロール表示（Fade Up）のみ
├── favicon.svg       トークン2色・無地の丸
└── ogp.png           1200×630。既存コピーのみで構成
```

配信されないもの（`public/` の外。この README を含む）:

```text
labs/personal-ai-training/
├── README.md                     この文書
├── deployment-report.md          本番配信構成の調査（結論と根拠）
└── qa/
    ├── verification-report.md    自動検証の結果一覧
    ├── results.json              全測定値の生データ
    └── screenshots/              375 / 768 / 1440px のフルページ
```

**レポート類を `public/` に置かないこと。** `public/` 配下の `.md` は実際に配信される
（実測: `https://tsam-ai.com/apps/PHASE3_AUDIT_REPORT.md` は 200 を返す）。
内部の配信構成メモが誰でも読める状態になる。

外部依存は Google Fonts（Inter / Zen Kaku Gothic New）だけ。
ビルドツール・CSSフレームワーク・アイコンライブラリは使っていない。
リポジトリの `package.json` には何も足していない。

---

## 決定ログ

| 日付 | 決定 | 理由 |
| --- | --- | --- |
| 2026-08-07 | **eyebrow の色は B案（Secondary を暗くする）を採用。最終値は `#567185`** | 当初の `#7895AA` は 2.78〜3.14:1 で AA 未達。オーナー指示の `#5F7D93` も実測 3.83〜4.34:1 で**まだ 4.5 に届かなかった**ため、指示書タスク1-3 の「不足すればさらに暗い値を検討してよい／Primary より暗くしない」に従い、色相を保ったまま4背景すべてが 4.5:1 に届く最も明るい値を探索した。実測 4.53〜5.13:1 |
| 2026-08-07 | **Vercel は使用しない** | 本番は Cloudflare Workers + OpenNext。Vercel の設定・デプロイ・設定ファイルは一切作っていない |
| 2026-08-07 | **公開先は `tsam-ai.com` 配下。soft launch（noindex・CTA未接続）** | 配信ルートが `public/` であることを実測で確定させ、`public/labs/personal-ai-training/` へ移設した |
| 2026-08-07 | **レポート類は `public/` の外に置く** | `public/` 配下の `.md` は配信されるため。指示書 rule 5 と同じ理由 |
| 2026-08-07 | 淡色背景に直接置く補助テキスト3箇所は `--color-text` を使う | `--color-text-sub` は淡色背景で 4.44:1 と AA に 0.06 届かないため |
| **2026-08-07** | **申込み受付は「準備中」表示にして soft launch** | フォームが未完成のため。押せないボタンを置くより、押せないことを文章で伝えるほうが誠実。`noindex` は維持し、sitemap にも載せない |
| **2026-08-07** | **POTENITAS から導線接続** | `/potenitas/` の相談テーマ「AIスキルを身につけよう」の遷移先を、ご相談メールからこの LP へ変更した（[public/potenitas/index.html](../../public/potenitas/index.html) の `messages` 配列に `href` を1つ足すだけ）。**これで LP に外部からの入口ができた。** `noindex` は検索避けであって、リンクを辿った人は普通に到達する |
| **2026-08-07** | **正式公開: フォーム接続・`noindex` 解除** | 無料相談の予約ページ（Google カレンダーの予約スケジュール）が用意できたため、準備中表示を CTA ボタンへ戻して接続し、`noindex` を削除した。**sitemap 登録は行っていない**（サイトに `sitemap.xml` が存在しないため。上記「sitemap について」） |
| 2026-08-07 | CTA 下の補足1行「まずは、30分の無料相談から。」は**追加しない** | オーナー判断。ページの文言を実装指示書の確定稿49件だけに保つ |
| 2026-08-07 | **GitHub Pages を無効化** | `main` のルートを配信する設定が残っており、`README.md` や `docs/` が github.io で読める状態だった。`tsam-ai.com` の配信には使われていない |
| **2026-08-08** | **姉妹LP（法人向け）への相互リンクをフッター直上に置く。確定稿は 49件 → 50件** | オーナー指示・文言固定。**ボタンにせずテキストリンク1行**にしたのは、直前にある申込みCTAと競合させないため。色だけで判別させないよう下線を付け、リンクは Secondary（`#FAFAF8` の上で 4.91:1）に上げている。CSS は共通化せず、姉妹LPと**同じ規則を各自の `style.css` に持たせた**（複製の方針どおり） |

---

## オーナー残作業

### A. 表示の確認

- [ ] **スマートフォン実機で見た目を確認する**

  375 / 768 / 1440px のスクリーンショットと横スクロール検査は自動で行ってあるが、
  実機のタッチ操作・フォント表示・`prefers-reduced-motion` の実挙動は確認していない。

### B. 正式公開の直後にやること

- [ ] **予約の通し確認（最優先）**

  スマートフォン実機で `/potenitas/` →「AIスキルを身につけよう」→ LP →
  CTA と辿り、**テスト予約を1件入れる。** そのうえで次を確認する。

  - 自分の Google カレンダーに予定が入る
  - Meet のリンクが付く
  - 確認メールが届く

  **確認できたらテスト予約を削除すること。**

  自動検証では遷移先URLとHTTPステータスまでしか確認できていない
  （Google 側のボット対策で、予約フォームの中身までは踏み込めない）。

- [ ] **サイト全体の `sitemap.xml` を用意するかを判断する**

  現在このサイトには `sitemap.xml` も `robots.txt` も無い（どちらも 404）。
  用意するならサイト全体を対象にするのが筋で、**このLPだけを載せた
  sitemap は作らないほうがよい。** 判断は上記「sitemap について」を参照。

- [ ] **Google Search Console へ登録する**（利用している場合）

  sitemap を作った場合はその送信も。作らない場合も、URL 検査から
  インデックス登録を申請できる。

- [ ] **OGP画像の SNS シェアプレビューを確認する**

  X / Facebook / Slack にURLを貼って、カードの見え方を確かめる。

---

## ローカルでの確認

ES モジュールは使っていないが、フォント取得と相対パスの都合で HTTP 経由で開く。

```powershell
py -m http.server 8000 --directory public/labs/personal-ai-training
```

<http://localhost:8000/> を開く。`npx serve public/labs/personal-ai-training` でもよい。

配信構成ごと確認したい場合は、リポジトリのルートで `npm run dev` を実行し、
<http://localhost:3000/labs/personal-ai-training/> を開く
（`next.config.ts` の fallback rewrite を通るため、本番と同じ経路になる）。

---

## 実装上の約束

- **コピーは実装指示書の確定稿が正。** 50件（確定稿49件＋相互リンク1件）を機械照合しており、変更するときは
  [qa/verification-report.md](./qa/verification-report.md) §7 の照合も併せて更新する
- 色は必ず `:root` の CSS 変数を経由する。直値を書かない
- 見出しの `<br class="br-lg">` は 768px 以上でだけ効く。狭い画面は
  `text-wrap: balance` で行を均す
- `.reveal` を隠すのは `<head>` の `documentElement.classList.add('js')` が
  付いているときだけ。JS が無効な環境では最初から見えている

関連: [../../docs/repository-structure.md](../../docs/repository-structure.md)（リポジトリの領域分け）

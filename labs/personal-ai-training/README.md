# パーソナルAIトレーニング LP

月額11,000円・月2回・各60分のオンラインマンツーマンAI学習サービスのランディングページ。

---

## 公開状態

> **soft launch 済み。`noindex` のまま、申込みは「準備中」表示で公開している。**
> **正式公開はフォーム完成後に改めて行う（下の残作業）。**

| | 状態 |
| --- | --- |
| `main` へのマージ | **済**（2026-08-07） |
| 本番への公開 | **済**（2026-08-07・`npm run deploy`） |
| URL | `https://tsam-ai.com/labs/personal-ai-training/` |
| 検索インデックス | **`noindex`。** 解除はフォーム完成後 |
| 申込み | **受付準備中。** 最終セクションに「申し込み受付は、現在準備中です。」と表示。CTAボタンは置いていない |
| sitemap 登録 | **していない**（`noindex` 中のため） |

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
| 2026-08-07 | **GitHub Pages を無効化** | `main` のルートを配信する設定が残っており、`README.md` や `docs/` が github.io で読める状態だった。`tsam-ai.com` の配信には使われていない |

---

## オーナー残作業

### A. いつでもできる確認

- [ ] **スマートフォン実機で確認する**

  375 / 768 / 1440px のスクリーンショットと横スクロール検査は自動で行ってあるが、
  実機のタッチ操作・フォント表示・`prefers-reduced-motion` の実挙動は確認していない。

- [ ] **OGP画像の SNS シェアプレビューを確認する**

  `ogp.png` は配信済み。X / Facebook / Slack にURLを貼って、カードの見え方を確かめる。
  `noindex` はクローラ向けの指定で、**SNS の OGP 取得は妨げない。**

### B. フォーム完成後の正式公開（この順に行う）

- [ ] **① 準備中テキストを CTA ボタンへ戻し、フォームURLを設定する**

  [index.html](../../public/labs/personal-ai-training/index.html) の最終セクション
  （`id="apply"`）にある次の1行を、

  ```html
  <p class="apply-pending reveal">申し込み受付は、現在準備中です。</p>
  ```

  もとの CTA ボタンへ戻す（文言は変えない）。

  ```html
  <p class="reveal"><a class="btn" href="＜フォームのURL＞">マンツーマンAI学習を始める</a></p>
  ```

  該当箇所の直上に、同じ内容の HTML コメントを置いてある。
  CSS の `.apply-pending` と `.apply .btn` は両方とも残してあるので、
  **スタイルの追加は要らない。**

  他の3つのボタン（ヘッダー・Hero・料金カード）は `#apply` へのページ内アンカーで、
  **そのままでよい。**

- [ ] **② `noindex` を外す**

  `index.html` の `<meta name="robots" content="noindex">`（TODO コメントの直下）を
  削除する。**① が終わるまで外さないこと。** 申し込めないページを検索結果に出すことになる。

- [ ] **③ ルート `sitemap.xml` へ登録するかを判断する**

  現在は登録していない。正式公開時に、この LP をコーポレートサイトの sitemap に
  載せるかどうかを決める。別サービスとして扱うなら載せない選択もある。

- [ ] **④ デプロイする**

  ```powershell
  npm run deploy
  ```

  手順は [docs/deployment-cloudflare.md](../../docs/deployment-cloudflare.md) §3〜§5、
  または [REENTRY.md](../../REENTRY.md) 手順4。
  **`main` の内容がまるごと出る**点に注意（LP 以外の変更も一緒に公開される）。

- [ ] **⑤ 公開後、`href` とインデックスを確認する**

  配信HTMLに `noindex` が無いこと、CTA のリンク先がフォームURLになっていること。
  必要なら Search Console でインデックス登録を申請する。

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

- **コピーは実装指示書の確定稿が正。** 49件を機械照合しており、変更するときは
  [qa/verification-report.md](./qa/verification-report.md) §7 の照合も併せて更新する
- 色は必ず `:root` の CSS 変数を経由する。直値を書かない
- 見出しの `<br class="br-lg">` は 768px 以上でだけ効く。狭い画面は
  `text-wrap: balance` で行を均す
- `.reveal` を隠すのは `<head>` の `documentElement.classList.add('js')` が
  付いているときだけ。JS が無効な環境では最初から見えている

関連: [../../docs/repository-structure.md](../../docs/repository-structure.md)（リポジトリの領域分け）

# AI人材育成プログラム（法人向け）LP

月額55,000円（税込）・月4回・各60分の法人向けオンライン研修のランディングページ。
個人向け [パーソナルAIトレーニング](../personal-ai-training/README.md) の姉妹商品。

---

## 公開状態

> **ソフトローンチ構成で実装済み。まだ本番へは出していない。**

| | 状態 |
| --- | --- |
| `main` へのマージ | 済（2026-08-07） |
| 本番への公開 | **未。** デプロイは別途指示（POTENITAS 導線接続と合わせて行う） |
| 公開後のURL | `https://tsam-ai.com/labs/ai-corporate-training/` |
| 検索インデックス | **`noindex`。** 正式公開時に削除する |
| CTA | **法人導入相談の予約ページへ接続済み**（Google カレンダーの予約スケジュール・同一タブ）。**個人向けLPとは別の予約ページ** |

---

## ファイル構成

配信されるもの（`public/` 配下）:

```text
public/labs/ai-corporate-training/
├── index.html        1ページ完結（9ブロック）
├── css/style.css     姉妹LPからの複製＋この商品固有の部品
├── js/main.js        スクロール表示（Fade Up）のみ。姉妹LPと同一
├── favicon.svg       姉妹LPからの流用（同一ファイル）
└── ogp.png           1200×630。既存コピーのみで構成
```

配信されないもの（`public/` の外。この README を含む）:

```text
labs/ai-corporate-training/
├── README.md                     この文書
└── qa/
    ├── verification-report.md    検証結果
    ├── results.json              全測定値
    └── screenshots/              375 / 768 / 1440px
```

> **実装指示書 §2 は README.md を `public/labs/ai-corporate-training/` 配下に
> 置くと読める書き方だったが、`labs/` 側に置いた。** `public/` 配下の `.md` は
> 実際に配信される（実測: `https://tsam-ai.com/apps/PHASE3_AUDIT_REPORT.md` は 200）。
> README には正式公開の手順やオーナー向けの残作業が入るため、公開すべきでない。
> 姉妹LPも同じ構成にしてある。移したい場合は `git mv` 1回で済む。

---

## 姉妹LPとの関係

`css/style.css` と `js/main.js` は
[public/labs/personal-ai-training/](../../public/labs/personal-ai-training/) からの
**複製**（2026-08-07）。`favicon.svg` は同一ファイルを置いている。

**共通化していない。import もしていない。** 2本のLPは別々の商品として別々に
育つ想定で、片方の都合で共有CSSを変えるともう片方が壊れるため。
これは [docs/repository-structure.md](../../docs/repository-structure.md) §4-1
（本番アプリ領域で共通層を作らない）と同じ考え方。

複製元との差分:

| 変更 | 内容 |
| --- | --- |
| 削除 | `.goal-quotes` / `.goal-note` / `.section--pale-sage`（このページに該当セクションが無い） |
| 削除 | `.price-desc`（このページは `.price-includes` と `.price-note` を使う） |
| 追加 | `.pricing-body` `.rate-list` `.pricing-closing`（料金の構造） |
| 追加 | `.tag-list`（テーマ例） |
| 追加 | `.price-includes` `.price-note`（料金カード） |
| 追加 | `.step-list` `.step-title` `.step-body`（導入の流れ） |
| 追加 | `.apply-lead`（申込みの説明文） |
| 変更 | 淡色背景の上で本文色へ上げる対象を、このページの要素に差し替え |

デザイントークンは `:root` ごとそのまま流用している。
**`--color-secondary` は補正後の `#567185`**（旧 `#7895AA` は AA 未達のため使わない）。

---

## 決定ログ

| 日付 | 決定 | 理由 |
| --- | --- | --- |
| 2026-08-07 | 姉妹LPの `style.css` を複製してベースにする | 実装指示書 §2。共通化はしない（上記） |
| 2026-08-07 | Pale Sage は使わない | 該当するセクションが無い。使わない色の規則を残さない |
| 2026-08-07 | Pale Blue は「料金の構造」と「申込み」の2箇所 | 元のデザイン方針の「1〜2箇所」に収める |
| 2026-08-07 | ~~FAQ に Eyebrow と見出しを置かない~~ → **置く** | 実装指示書 4.9 に記載が無く、いったん置かずに実装して確認を仰いだ。**オーナー確認により指示漏れと判明**し、個人向けLPと同一の Eyebrow `FAQ` ／ 見出し `よくある質問。` を追加した（確定稿は 67件 → 69件） |
| 2026-08-07 | レポート類は `public/` の外へ置く | `public/` 配下の `.md` は配信されるため |

---

## オーナーの確認待ち

- [x] ~~**FAQ セクションに Eyebrow と見出しを付けるか**~~
      → **解決済み（2026-08-07）。** 実装指示書 4.9 の記載漏れとオーナーが確認し、
      個人向けLPと同一の Eyebrow `FAQ` ／ 見出し `よくある質問。` を追加した。

- [ ] **`noindex` を外す**（正式公開時。フェーズ2）

- [ ] **POTENITAS の「AI人材を育成しよう」から導線をつなぐか判断する**

  `public/potenitas/index.html` の `messages` 配列に、まだ `href` の無い項目として
  「AI人材を育成しよう」がある。**この商品の導線として自然だが、今回の指示範囲外**
  のため触っていない。つなぐなら `href: "/labs/ai-corporate-training/"` を1つ足すだけ。

---

## ローカルでの確認

```powershell
npx serve public/labs/ai-corporate-training
```

`file://` では開かないこと（フォント取得と相対パスが解決できない）。
配信構成ごと見るならリポジトリのルートで `npm run dev` を実行し、
<http://localhost:3000/labs/ai-corporate-training/> を開く。

---

## 実装上の約束

- **コピーは実装指示書の確定稿が正。** 67件を機械照合している
  （[qa/verification-report.md](./qa/verification-report.md) §1）
- 色は必ず `:root` の CSS 変数を経由する。直値を書かない
- JSON-LD の FAQ は本文の `<details>` と一字一句一致させる。
  **FAQ を直したら必ず両方を直し、照合をやり直す**
- 実績数字・導入社数・お客様の声は**存在しないため一切書かない**

# パーソナルAIトレーニング LP

月額11,000円・月2回・各60分のオンラインマンツーマンAI学習サービスのランディングページ。

## 公開の扱い

**Web には公開していない。** `public/` の外に置いてあるため、`tsam-ai.com` から
このファイルへは届かない（[docs/repository-structure.md](../../docs/repository-structure.md) §2-3 の記録として明記する）。

公開する場合は `public/labs/personal-ai-training/` へ移し、
`npm run deploy` を実行する（マージだけでは公開されない。
[docs/deployment-cloudflare.md](../../docs/deployment-cloudflare.md)）。

> リポジトリ自体は公開されているため、GitHub 上では誰でも読める。
> 鍵・トークン・個人情報を置かないこと。

## 構成

```text
index.html        1ページ完結
css/style.css     デザイントークンとレイアウト
js/main.js        スクロール表示（Fade Up）のみ
```

外部依存は Google Fonts（Inter / Zen Kaku Gothic New）だけ。
ビルドツール・CSSフレームワーク・アイコンライブラリは使っていない。

## ローカルでの確認

ES モジュールこそ使っていないが、フォント取得と相対パスの都合で
HTTP 経由で開く。

```powershell
py -m http.server 8000 --directory labs/personal-ai-training
```

## 未確定

- 申込ボタン（`#apply` 内）のリンク先。`href="#"` のまま、HTML に TODO コメントを残してある

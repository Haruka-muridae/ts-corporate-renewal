# TSアセットマネジメント合同会社 コーポレートサイト

## プロジェクト概要

TSアセットマネジメント合同会社の静的なコーポレートサイトです。HTML、CSS、Vanilla JavaScriptのみで構成し、ビルド処理や外部ライブラリを使用していません。PC、タブレット、スマートフォンに対応しています。

## ファイル構成

```text
.
├── index.html
├── css/
│   └── style.css
├── js/
│   └── main.js
├── assets/
│   └── images/
│       └── .gitkeep
├── .gitignore
├── AGENTS.md
├── README.md
└── SITE_SPEC.md
```

`SITE_SPEC.md`は、掲載文章、会社情報、デザイン、レスポンシブ、アクセシビリティ、SEOの実装基準です。

## 実装済みセクション

- ヘッダー、グローバルナビゲーション
- ファーストビュー
- 私たちについて
- 課題解決の進め方
- 事業領域
- 事業のつながり
- わたしたちの強み
- メンバー
- 会社概要、お知らせ
- お問い合わせ
- フッター、ページトップボタン

## 実装済み機能

- 1024px未満のハンバーガーメニューとフォーカストラップ
- スクロールに応じたヘッダーとページトップボタンの表示切り替え
- IntersectionObserverによる一度限りのスクロール表示
- ApproachとBusinessのスタッガー表示
- ネイティブ`details`による経歴と定款事業内容の開閉
- `prefers-reduced-motion`によるアニメーション軽減
- スキップリンクとキーボード操作対応
- OrganizationのJSON-LD
- `mailto`によるお問い合わせ

## ローカルでの確認方法

VS CodeのLive Serverを利用する場合は、`index.html`を開いて「Open with Live Server」を実行します。Live Serverがない環境では、プロジェクトのルートで次のような静的ファイルサーバーを起動できます。

```powershell
python -m http.server 8000
```

その後、`http://localhost:8000/`へアクセスします。

## 表示・操作の確認

- 320px、375px、768px、1024px、1440pxで横スクロールや表示崩れがないこと
- Tab／Shift+Tabだけでリンク、ボタン、メニュー、`summary`を操作できること
- ハンバーガーメニューがEscで閉じ、ボタンへフォーカスが戻ること
- 「本文へスキップ」で本文へ移動できること
- ページトップボタンが非表示時にフォーカスされないこと
- ブラウザまたはOSで「視差効果を減らす」「アニメーションを表示しない」を有効にし、スクロール表示、Hero、Connection、スムーズスクロールが停止すること
- JavaScriptを無効にしても本文が表示され、`details`が開閉できること

## Lighthouse

Chrome DevToolsのLighthouseで次を確認します。

- Performance: 90以上
- Accessibility: 95以上
- Best Practices: 95以上
- SEO: 95以上
- コンソールエラー・警告がないこと

## GitHub Pages

GitHub Pagesでそのまま公開できる、ルート相対ではないファイル参照とビルド不要の構成です。公開前にリポジトリのPages設定と公開URLを確認してください。

## 未確定事項

- canonical URL
- `og:url`
- OGP画像と`og:image`
- favicon

未確定値は推測せず、`index.html`内のTODOコメントを維持しています。

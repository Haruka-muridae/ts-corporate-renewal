# Potenitas Next.js・Cloudflare実装仕様

**Version:** 1.0.0  
**Status:** Approved with deployment TODOs  
**Last Updated:** 2026-07-22

## 1. 技術構成

- Next.js App Router
- TypeScript strict
- Tailwind CSS
- 静的エクスポート
- Cloudflare Pages
- GitHub
- Google Apps Scriptフォーム
- GA4（同意・プライバシー方針確定後）

LPにサーバー常駐、認証、データベース、CMSを導入しません。

## 2. 静的出力

```ts
// next.config.ts
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "export",
  trailingSlash: true,
  images: { unoptimized: true },
  reactStrictMode: true,
};

export default nextConfig;
```

`next/image`を使う場合、静的書き出しでサーバー画像最適化を利用できないため、ビルド前に画像を適切な寸法・形式へ変換します。写真を多用しない方針を維持します。

## 3. 使用禁止・制約

- Server Actions
- API Routes / Route Handlersの動的処理
- cookies、headers等のリクエスト依存機能
- ISR、SSR、動的リダイレクト
- Next.js内のサーバー処理を前提とするフォーム
- 未生成の動的ルート

必要になった時点でCloudflare Workers等への移行を別案件として設計します。

## 4. 推奨構成

```text
app/
├── layout.tsx
├── page.tsx
├── robots.ts
├── sitemap.ts
├── icon.svg
├── globals.css
├── faq/page.tsx
├── about/page.tsx
├── privacy/page.tsx
├── legal/page.tsx
└── thanks/page.tsx
components/
├── lp/
├── ui/
└── analytics/
content/
├── lp.ts
├── faq.ts
├── legal.ts
└── metadata.ts
lib/
├── env.ts
├── jsonld.ts
├── analytics.ts
└── form.ts
public/
├── og/
├── images/
└── _headers
tests/
```

法務ページのパスは正式URL決定後に固定します。

## 5. 環境変数

```text
NEXT_PUBLIC_SITE_URL=
NEXT_PUBLIC_GA_MEASUREMENT_ID=
NEXT_PUBLIC_CONTACT_ENDPOINT=
```

- `SITE_URL`とフォームURLは本番ビルドで必須
- GA4は未導入時に空を許可し、スクリプトを読み込まない
- GASの秘密値を`NEXT_PUBLIC_*`に置かない
- `.env*`の実値をGitへコミットしない

## 6. Cloudflare Pages

静的サイトとしてPagesへ配備します。

- Build command: `npm run build`
- Build output: `out`
- Node.jsバージョン: プロジェクトで固定
- Production branch: `main`
- Preview: Pull Requestごと

Cloudflareは一般的なフルスタックNext.jsにはWorkersを推奨していますが、本プロジェクトは`output: "export"`の静的サイトなのでPagesの対象です。

## 7. フォーム

ブラウザーからGAS Web Appへ送信します。

要件:

- HTML標準バリデーション＋クライアント補助
- GAS側で必須、長さ、形式を再検証
- ハニーポット
- 二重送信防止
- 送信中状態、成功、失敗を明示
- 成功時に`/thanks/`へ遷移
- CORS、許可origin、レスポンス形式を実環境で検証
- スプレッドシートへ保存する個人情報を最小化
- 通知メールに機密情報を過剰に含めない

GASだけで堅牢なレート制限を実現できるとは仮定しません。スパムが発生したらCloudflare Turnstile等を追加検討します。

## 8. アコーディオン

- JS前のHTMLに全回答を含める
- ボタン要素を使い`aria-expanded`と`aria-controls`を同期
- パネルへ`id`を付ける
- キーボード操作可能
- URLハッシュで対象を開く場合はフォーカス移動を検証
- 隠し方は検索用ではなく利用者向け情報整理として実装

`details`/`summary`で要件を満たせる場合は優先して検討します。

## 9. 外部フォント

最小コスト・表示速度を優先し、次のいずれかを採用します。

1. `next/font`でNoto Sans JPとInterをセルフホスト
2. システムフォント優先へ簡素化

多数ウェイトを読み込みません。日本語フォントの容量をLCPと初回転送量で検証します。

## 10. ヘッダー

`public/_headers`で次を開始点とします。

```text
/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: camera=(), microphone=(), geolocation=()
  X-Frame-Options: DENY
```

CSPは、Next.jsの出力、インラインJSON-LD、GA4、GAS接続先を実測してからレポート専用で導入し、違反を解消後に強制します。動作未検証の厳格CSPを公開時の必須条件にしません。

## 11. ビルド検証

```text
npm run lint
npm run typecheck
npm run test
npm run build
```

`out`について次を確認します。

- HTMLに9ブロックの本文が存在
- title、description、canonical、JSON-LDが存在
- robots.txt、sitemap.xmlが生成
- すべての内部URLが静的ファイルとして解決
- `/thanks/`がnoindex
- `pages.dev`プレビューのnoindex方針が機能

## 12. 公式参考情報

- Next.js static export: https://nextjs.org/docs/app/guides/static-exports
- Next.js metadata: https://nextjs.org/docs/app/getting-started/metadata-and-og-images
- Cloudflare static Next.js Pages: https://developers.cloudflare.com/pages/framework-guides/nextjs/deploy-a-static-nextjs-site/
- Cloudflare Pages headers: https://developers.cloudflare.com/pages/configuration/headers/

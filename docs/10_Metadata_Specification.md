# Potenitas メタデータ仕様

**Version:** 1.0.0  
**Status:** Approved with URL TODO  
**Last Updated:** 2026-07-22

## 1. 前提

本番URLが未確定のため、URLを含む値は`NEXT_PUBLIC_SITE_URL`から生成します。本番ビルドでは未設定をエラーにし、仮URLを公開しません。

## 2. サイト名

```text
Potenitas
```

## 3. トップページtitle

採用案:

```text
Potenitas｜自分で判断できるようになるためのAI個別指導
```

理由: ブランド名、提供価値、サービス分類を自然な日本語で示し、`AIスクール`という禁止分類を避けます。

代替案:

```text
Potenitas｜伴走型のAI活用個別指導
Potenitas｜AIを業務で使い、変化を測る個別指導
```

本番採用は人間が1案に確定します。検索語の羅列や頻繁な変更をしません。

## 4. meta description

採用候補:

```text
Potenitasは、実際の業務を題材に、AIの回答を自分で検証し、改善の仕組みを作り、変化を測れる状態まで伴走する個別指導サービスです。TSアセットマネジメント合同会社が運営しています。
```

これは検索用要約であり、LPの確定コピーを置換しません。表示内容と相違がないことを公開前に確認します。

## 5. robotsメタ

公開ページ:

```text
index,follow,max-image-preview:large,max-snippet:-1,max-video-preview:-1
```

非公開・完了ページ:

- `/thanks/`: `noindex,follow`
- プレビュー・検証用URL: `noindex,nofollow`
- 管理用ページ: 公開しない。robots.txtだけで秘密情報を保護しない

## 6. canonical

- 各インデックス対象ページは絶対URLの自己参照canonicalを1つ出力
- 末尾スラッシュ方針をNext.js設定、内部リンク、sitemap、canonicalで統一
- クエリ付き計測URLも正規ページをcanonicalにする
- `pages.dev`プレビューをcanonicalにしない

## 7. OGP / X

トップページ:

- `og:type`: `website`
- `og:site_name`: `Potenitas`
- `og:title`: titleより短い自然な表現
- `og:description`: meta descriptionと意味を一致
- `og:url`: 正規URL
- `og:locale`: `ja_JP`
- `og:image`: 1200×630pxのブランド画像（要制作）
- `twitter:card`: `summary_large_image`

OGP画像は、Potenitas、`可能性は、証明できる。`、運営主体の最小表記で構成できます。ただし画像内のコピー採用は人間承認が必要です。架空の人物、受講者、受賞ロゴを使いません。

## 8. Next.js Metadata API

```ts
import type { Metadata } from "next";

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL;

if (!siteUrl) {
  throw new Error("NEXT_PUBLIC_SITE_URL is required");
}

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: "Potenitas｜自分で判断できるようになるためのAI個別指導",
    template: "%s｜Potenitas",
  },
  description:
    "Potenitasは、実際の業務を題材に、AIの回答を自分で検証し、改善の仕組みを作り、変化を測れる状態まで伴走する個別指導サービスです。TSアセットマネジメント合同会社が運営しています。",
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    locale: "ja_JP",
    siteName: "Potenitas",
    url: "/",
    images: [{ url: "/og/potenitas-og.png", width: 1200, height: 630 }],
  },
  twitter: {
    card: "summary_large_image",
    images: ["/og/potenitas-og.png"],
  },
};
```

コードのtitle・descriptionは人間が最終承認した値へ置換してから公開します。

## 9. favicon / manifest

- `app/icon.svg`または`app/icon.png`
- `app/apple-icon.png`
- 必要な場合のみ`app/manifest.ts`
- ブランド名・背景色・テーマ色をDesign Systemと一致させる
- PWA機能を使わない段階で過剰なmanifest設定を追加しない

## 10. sitemap

`app/sitemap.ts`で、公開済みかつcanonicalなURLだけを返します。

- LP
- 運営者情報
- FAQ
- 特商法表記
- プライバシーポリシー
- 記事（公開後）

`/thanks/`、プレビュー、404、リダイレクト先、未公開ページを含めません。実態のない`changeFrequency`や未来の`lastModified`を作りません。

## 11. 検証

- ビルド後の`out/**/*.html`でtitle、description、canonicalを確認
- OGP Debugger等で絶対URLと画像取得を確認
- Search Console URL検査でGoogle選択canonicalを確認
- sitemap内URLが200、index可能、自己参照canonicalであることを自動検査

## 12. 公式参考情報

- Next.js Metadata: https://nextjs.org/docs/app/getting-started/metadata-and-og-images
- Next.js metadata files: https://nextjs.org/docs/app/api-reference/file-conventions/metadata
- Google title links: https://developers.google.com/search/docs/appearance/title-link
- Google snippets: https://developers.google.com/search/docs/appearance/snippet

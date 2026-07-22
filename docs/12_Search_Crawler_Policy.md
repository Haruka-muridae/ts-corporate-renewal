# Potenitas 検索・AIクローラーポリシー

**Version:** 1.0.0  
**Status:** Policy approved, URL TODO  
**Last Updated:** 2026-07-22

## 1. 方針

検索・回答時の発見可能性を優先し、検索用クローラーは許可します。基盤モデル学習用クローラーは、検索可視性とは別に判断します。robots.txtはアクセス制御や秘密保持の仕組みではありません。

## 2. 推奨判断

| User-agent | 公式用途の要約 | 方針 |
|---|---|---|
| `Googlebot` | Google検索 | 許可 |
| `Bingbot` | Bing検索 | 許可 |
| `OAI-SearchBot` | ChatGPT検索 | 許可 |
| `ChatGPT-User` | ユーザー要求による取得 | 許可意向。ただしrobots.txtが常に適用されるとは限らない |
| `GPTBot` | OpenAIモデル学習 | 初期は拒否 |
| `Claude-SearchBot` | Claude検索 | 許可 |
| `Claude-User` | ユーザー要求による取得 | 許可意向 |
| `ClaudeBot` | Anthropicモデル学習 | 初期は拒否 |
| `PerplexityBot` | Perplexity検索 | 許可 |
| `Perplexity-User` | ユーザー要求による取得 | 許可意向。robots.txtを尊重しない場合がある |
| `Google-Extended` | Gemini学習・一部グラウンディング制御 | 初期は拒否。Google検索掲載には影響しない |

学習許可はAEOの必須条件ではありません。ブランド方針が変わったときだけ再審議します。

## 3. robots.txt案

`NEXT_PUBLIC_SITE_URL`確定後にsitemapの絶対URLを出力します。

```text
User-agent: *
Allow: /

User-agent: GPTBot
Disallow: /

User-agent: ClaudeBot
Disallow: /

User-agent: Google-Extended
Disallow: /

Sitemap: https://{本番ドメイン}/sitemap.xml
```

`OAI-SearchBot`、`Claude-SearchBot`、`PerplexityBot`は`*`の許可を継承します。特定のクローラー用グループを追加すると一般ルールを継承しない実装もあるため、追加時は必要なAllow/Disallowをそのグループ内へ明示します。

## 4. Next.js実装

`app/robots.ts`を使います。

```ts
import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL;
  if (!siteUrl) throw new Error("NEXT_PUBLIC_SITE_URL is required");

  return {
    rules: [
      { userAgent: "*", allow: "/" },
      { userAgent: "GPTBot", disallow: "/" },
      { userAgent: "ClaudeBot", disallow: "/" },
      { userAgent: "Google-Extended", disallow: "/" },
    ],
    sitemap: new URL("/sitemap.xml", siteUrl).toString(),
  };
}
```

生成結果を必ず確認し、フレームワーク表現の差でグループが意図せず結合されていないか検証します。必要なら`public/robots.txt`の静的ファイルへ切り替えます。

## 5. Google-Extended

Googleの公式説明では、Google-ExtendedはGeminiモデルの将来世代の学習と一部のグラウンディング利用を制御する独立トークンです。Google検索への掲載や順位には影響しません。

検索可視性を保ちながら学習利用を拒否できるため、初期は`Disallow: /`とします。Geminiでのグラウンディング露出を優先する方針へ変える場合は、影響を再確認して承認を取ります。

## 6. OpenAI / Anthropic / Perplexity

- OpenAI: `OAI-SearchBot`と`GPTBot`は別に制御可能。`ChatGPT-User`はユーザー起点で、robots.txtが常に適用されるとは限らない
- Anthropic: 検索、ユーザー取得、学習のクローラーが分かれているため、検索・ユーザー取得を許可し学習を拒否
- Perplexity: `PerplexityBot`は検索用。`Perplexity-User`はユーザー起点でrobots.txtを無視する場合がある

WAFやUser-Agentだけで正規クローラーと断定しません。必要に応じて各社公式のIP・検証方法を使います。

## 7. llms.txt

v1では公開しません。

理由:

- 検索エンジンの標準的な順位・引用要件ではない
- GoogleはAI検索最適化のための追加AIファイルは不要と案内している
- 内容重複と更新漏れの責務が増える

将来採用する場合も、サイト内の正式ページへの短い索引に限定し、非公開情報や本文の別バージョンを置きません。

## 8. IndexNow

公開初期のページ数が少ないため必須ではありません。記事更新が始まったら採用を検討します。

- sitemapとBing Webmaster Tools登録を先に行う
- 新規・更新・削除URLだけを通知
- インデックスや順位を保証するものではない
- APIキーは公開仕様に従い、リポジトリへ秘密情報を含めない

## 9. プレビュー環境

`*.pages.dev`のプレビューは検索対象にしません。

- Cloudflareの`_headers`で`X-Robots-Tag: noindex`を付与する方法を検討
- 本番カスタムドメインにnoindexを誤適用しない
- basic認証等が必要な機密プレビューは別途アクセス制御する

## 10. 変更管理

- 四半期ごとに各社の公式クローラー文書を確認
- User-agent名の推測追加は禁止
- 方針変更は日付、理由、対象クローラー、想定影響を`CHANGELOG.md`へ記録

## 11. 公式参考情報

- OpenAI crawlers: https://developers.openai.com/api/docs/bots
- Anthropic crawlers: https://privacy.claude.com/en/articles/8896518-does-anthropic-crawl-data-from-the-web-and-how-can-site-owners-block-the-crawler
- Perplexity crawlers: https://docs.perplexity.ai/guides/bots
- Google crawlers / Google-Extended: https://developers.google.com/crawling/docs/crawlers-fetchers/google-common-crawlers
- Bing robots.txt: https://www.bing.com/webmasters/help/how-to-create-a-robots-txt-file-cb7c31ec
- IndexNow: https://www.bing.com/webmasters/help/indexnow-0z209wby

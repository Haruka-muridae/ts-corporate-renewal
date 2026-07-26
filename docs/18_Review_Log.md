# Potenitas SEO・AEO草案レビュー記録

**Version:** 1.0.0  
**Review Date:** 2026-07-22  
**Reviewed Source:** `Potenitas_SEO_AEO_implementation_spec_draft.md`  
**Canonical Source:** `LP要件定義書.md`および後発の会話合意

## 1. 結論

元草案には有用なSEO、構造化データ、Next.js、テストの具体例がありましたが、要件定義書を参照できない前提で作られた暫定版でした。そのため、そのまま実装するとコピー、見出し、契約条件、URLに誤りが入る状態でした。

本改訂では、草案を責務別文書へ分割し、確定情報を同期し、未確定情報を明示的TODOへ変更しました。

## 2. 重大な修正

### H1の誤り

草案の例では`可能性は、証明できる。`がH1候補でした。要件上、これは第4ブロックの旗です。

修正後:

- H1: `AIの正解は、誰も教えてくれない。`
- 第4ブロック: `可能性は、証明できる。`

### プレースホルダー

`TBD`、`__COPY_FROM_REQUIREMENTS__`、仮URLを廃止し、次のどちらかへ変更しました。

- 要件から同期した確定値
- `TODO: 人間の確認が必要`として公開を止める値

### 契約条件

会話で合意した次を反映しました。

- 月単位の自動更新
- 次回請求日前までの連絡で次回以降停止
- 日割りなし
- 提供済み・支払済み料金の返金なし
- 未消化面談は原則翌月へ繰り越し
- 休会制度なし
- 講師都合は振替
- 卒業後、必要になった場合のみ別契約のコンサルティングを利用可能

繰り越し上限・有効期限は未確定のままです。

## 3. SEO・AEOレビュー

維持:

- 人に見える本文を基盤にする
- 特別なAEOハックを使わない
- エンティティと定義文を一貫させる
- 検索・AI引用を保証しない

修正:

- FAQを20〜40件へ機械的に増やす方針を不採用
- FAQPageを必須施策から任意へ変更
- `llms.txt`を初期公開対象から除外
- 記事量産ではなく、実際の問い合わせ・検索データに基づく追加へ変更

公式確認では、GoogleはAI Overviews/AI Modeのための追加最適化や特別なAIファイルを要求していません。

## 4. Next.js・Cloudflareレビュー

採用:

- App Router、TypeScript、Tailwind
- `output: "export"`
- Cloudflare Pagesの`out`配備

境界:

- Server Actions、SSR、ISR、動的APIを使用しない
- フォームはGASへ送信
- 静的exportの範囲を超えたらWorkers等を別途設計

CloudflareはフルスタックNext.jsにはWorkersを推奨していますが、静的exportはPages公式ガイドの対象です。

## 5. 構造化データレビュー

採用: Organization、WebSite、WebPage、Service。下層ページでBreadcrumbList。PersonとFAQPageは条件付き。

不採用: 架空のReview、AggregateRating、Offer、Course、Product、EducationalOrganization。

価格や評価を検索表示目的で追加せず、画面上の事実と一致させます。

## 6. クローラーレビュー

検索用クローラーを許可し、学習用を初期拒否する分離方針へ整理しました。

- 許可: Googlebot、Bingbot、OAI-SearchBot、Claude-SearchBot、PerplexityBot
- 拒否: GPTBot、ClaudeBot、Google-Extended
- ユーザー起点fetcherはrobots.txtが常に適用されるとは限らないことを明記

Google-Extendedの拒否はGoogle検索掲載へ影響しませんが、Geminiの学習・一部グラウンディング利用に影響し得ます。

## 7. アクセシビリティ・性能レビュー

- WCAG 2.2 AAを基準化
- LCP 2.5秒、INP 200ms、CLS 0.1の公式「良好」基準を採用
- Lighthouse点数を保証や唯一の合格条件にしない
- キーボード、200%拡大、フォームエラー、reduced motionを手動確認へ追加
- 大容量動画、スライダー、過剰な第三者JSを禁止

## 8. セキュリティレビュー

元草案の厳格CSP案は、静的Next.js、JSON-LD、GA4、GASの実出力と衝突する可能性がありました。

修正後:

- nosniff、Referrer-Policy、Permissions-Policy、frame制御を先行
- CSPはReport-Onlyで実測後に強制
- 未検証CSPでフォーム・分析・描画を壊さない

## 9. 計測レビュー

- `generate_lead`はサーバー成功後のみ
- 個人情報・自由記述をGA4へ送らない
- AI回答内の引用回数は測定不能として扱う
- Search Console、Bing、フォーム結果を別の観測系として整理
- 少数応募データから市場全体を断定しない

## 10. 未確定事項

### 実装前に必須

- 本番独自ドメイン
- 法人・担当者・連絡先の公開範囲
- GAS本番エンドポイントとレスポンス仕様

### 公開前に必須

- OGP画像
- 特商法、利用規約、プライバシーポリシー
- GA4測定ID、同意方針
- Cloudflare Pagesプロジェクトとドメイン設定

### 公開後でもよい

- IndexNow
- 記事クラスター
- Person構造化データ
- FAQPage構造化データ
- llms.txt（当面不採用）

## 11. 参照した主要公式情報

- Google AI features: https://developers.google.com/search/docs/appearance/ai-features
- Google AI optimization guide: https://developers.google.com/search/docs/fundamentals/ai-optimization-guide
- Google structured data policies: https://developers.google.com/search/docs/appearance/structured-data/sd-policies
- Google crawler list: https://developers.google.com/crawling/docs/crawlers-fetchers/google-common-crawlers
- OpenAI bots: https://developers.openai.com/api/docs/bots
- Anthropic crawlers: https://privacy.claude.com/en/articles/8896518-does-anthropic-crawl-data-from-the-web-and-how-can-site-owners-block-the-crawler
- Perplexity bots: https://docs.perplexity.ai/guides/bots
- Next.js static exports: https://nextjs.org/docs/app/guides/static-exports
- Cloudflare Pages static Next.js: https://developers.cloudflare.com/pages/framework-guides/nextjs/deploy-a-static-nextjs-site/
- WCAG 2.2: https://www.w3.org/TR/WCAG22/
- Core Web Vitals: https://web.dev/articles/vitals

## 12. レビュー判定

文書群は実装開始に使用できます。ただし未確定事項を架空値で埋めず、`17_Codex_Implementation_Guide.md`のPhase 0監査から開始することが条件です。

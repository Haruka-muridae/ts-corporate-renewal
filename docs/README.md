# Potenitas SEO・AEOドキュメント

**Version:** 1.0.0  
**Status:** 実装利用可（明示されたTODOを除く）  
**Owner:** TSアセットマネジメント合同会社  
**Last Updated:** 2026-07-22

## 目的

本ディレクトリは、PotenitasのLPをNext.jsの静的サイトとして実装し、検索エンジンと回答エンジンの双方に事実を正確に伝えるための仕様書群です。

「AEO専用の裏技」は採用しません。人が読める明確な本文、検索可能なHTML、整合したメタデータと構造化データ、適切なクローラー制御、表示品質を基盤とします。AI回答への掲載・引用・順位は保証しません。

## 最上位の情報源

判断の優先順位は次のとおりです。

1. 法令、契約内容、検索サービス等の公式仕様
2. `LP要件定義書.md`の確定コピーと9ブロック構成
3. 会話で明示的に合意した後発の決定
4. 本ドキュメント群
5. 実装上の便宜

後発の合意により、サービス名は`Potenitas`です。元の要件定義書に残る「サービス名未定」の表記より、この決定を優先します。

## 文書一覧

| 文書 | 責務 |
|---|---|
| [08_SEO_AEO_Specification.md](./08_SEO_AEO_Specification.md) | SEO・AEOの基本方針、検索意図、エンティティ、運用 |
| [09_Content_Architecture.md](./09_Content_Architecture.md) | 9ブロック、確定コピー、補足ページ、FAQ、内部リンク |
| [10_Metadata_Specification.md](./10_Metadata_Specification.md) | title、description、canonical、OGP、sitemap |
| [11_Structured_Data.md](./11_Structured_Data.md) | Schema.org採否、JSON-LD、検証 |
| [12_Search_Crawler_Policy.md](./12_Search_Crawler_Policy.md) | robots.txt、AIクローラー、llms.txt、IndexNow |
| [13_NextJS_Implementation.md](./13_NextJS_Implementation.md) | Next.js静的出力とCloudflare Pages実装 |
| [14_Accessibility_Performance.md](./14_Accessibility_Performance.md) | WCAG、Core Web Vitals、セキュリティヘッダー |
| [15_Analytics_Specification.md](./15_Analytics_Specification.md) | GA4、Search Console、Bing、検証指標 |
| [16_Testing_Specification.md](./16_Testing_Specification.md) | 自動・手動テスト、公開判定 |
| [17_Codex_Implementation_Guide.md](./17_Codex_Implementation_Guide.md) | Codexが安全に段階実装する手順 |
| [18_Review_Log.md](./18_Review_Log.md) | 元草案の問題点、修正内容、未確定事項 |
| [CHANGELOG.md](./CHANGELOG.md) | 文書群の変更履歴 |

## 実装前に確定が必要な項目

- 本番の独自ドメインと正規URL
- OGP画像の最終ファイル名・寸法・公開URL
- 公開する法人情報、担当者情報、連絡先の範囲
- 問い合わせフォームのGoogle Apps Script本番URL
- GA4測定IDと同意・プライバシー方針
- 特定商取引法、利用規約、プライバシーポリシーの正式URLと内容
- 未消化面談の繰り越し上限・有効期限（設定する場合）

未確定値を架空の値で埋めてはいけません。コードでは`TODO`、環境変数、またはビルド時エラーで管理します。

## 実装の開始順

1. `09`で表示内容とHTML階層を確定
2. `10`〜`12`で検索向け出力を確定
3. `13`に沿って静的サイトを構築
4. `14`〜`16`で品質と計測を検証
5. `17`の手順で小さく実装・レビュー・コミット

## 公式仕様の基準日

公式情報は2026-07-22時点で確認しています。検索サービス、クローラー名、Next.js、Cloudflareの仕様は変化するため、公開前と半年ごとに再確認してください。

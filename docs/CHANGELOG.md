# Changelog

## 1.0.0 - 2026-07-22

### 追加

- 一枚岩だったSEO・AEO草案を11の責務別仕様書と本変更履歴へ分割
- LP要件定義書と後発の会話合意を同期
- Next.js静的出力、Cloudflare Pages、Google Apps Scriptフォームの実装境界を明文化
- OpenAI、Anthropic、Perplexity、Google、Bingのクローラー方針を分離
- WCAG 2.2 AAとCore Web Vitalsの受入基準を追加
- GA4、Search Console、Bing Webmaster Toolsの計測仕様を追加
- Codex向け段階実装・停止条件・完了条件を追加

### 修正

- 誤ってH1候補とされていた`可能性は、証明できる。`を第4ブロックのブランドステートメントへ戻した
- H1を確定コピー`AIの正解は、誰も教えてくれない。`へ統一
- `TBD`、`__COPY_FROM_REQUIREMENTS__`等の曖昧なプレースホルダーを、確定情報または明示的TODOへ置換
- FAQPageをAEOの必須施策として扱わず、表示FAQと一致する場合のみ任意採用に変更
- `llms.txt`を公開必須から除外
- 架空のOffer、Review、AggregateRating、Course等を禁止
- Cloudflare Pagesで壊れやすい未検証CSPを公開必須から外し、安全な段階導入へ変更

### 維持した主要方針

- 確定コピーと9ブロックの順序は変更しない
- 実績・料金は常時表示し、アコーディオンへ入れない
- 一般・紹介・奨学の料金枠を同格に扱う
- AEOのための隠し本文、キーワード詰め込み、大量FAQを行わない
- AI回答への引用・掲載を保証しない

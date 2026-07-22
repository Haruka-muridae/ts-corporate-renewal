# Potenitas テスト仕様

**Version:** 1.0.0  
**Status:** Approved  
**Last Updated:** 2026-07-22

## 1. 方針

テストは、確定コピー、9ブロック順序、契約・料金の正確性、検索出力、アクセシビリティ、静的配備を守るために行います。スナップショットだけで合格にしません。

## 2. 必須コマンド

```text
npm run lint
npm run typecheck
npm run test
npm run build
npm run test:e2e
```

実際の`package.json`に存在するスクリプトだけをREADMEへ記載します。

## 3. 単体テスト

- 環境変数検証
- URL生成
- JSON-LD生成
- GA4イベント関数
- フォームの入力整形とバリデーション
- FAQや料金データの重複ID検査

## 4. コンテンツ整合テスト

自動検査候補:

- H1が1つで`AIの正解は、誰も教えてくれない。`
- 9ブロックIDが定義順で1回ずつ存在
- `可能性は、証明できる。`が第4ブロックに存在
- 実績・料金セクションがアコーディオン内にない
- CTAが`相談する（無料）`
- 料金が110,000 / 55,000 / 11,000円で同じDOM階層
- 禁止表現が混入していない
- `TBD`、`__COPY_FROM_REQUIREMENTS__`、`example.com`が本番出力にない

コピー全体のハッシュ固定は誤字修正も阻害するため、重要文と構造を検査し、全文差分は人間レビューします。

## 5. SEOテスト

- title、description、canonicalが各ページで1つ
- canonicalが絶対URLかつ本番ドメイン
- robotsメタがページ方針と一致
- sitemapのURLが200でindex可能
- robots.txtに正しいsitemapとクローラー方針
- OGP画像が200、1200×630、適切なMIME
- JSON-LDがパース可能で表示内容と一致
- `/thanks/`がnoindex
- 本番HTMLに主要本文が存在

## 6. アクセシビリティテスト

自動:

- axe-coreで重大・深刻違反0
- ラベル、見出し、ARIA参照の整合
- 色コントラスト

手動:

- キーボードのみで全操作
- フォーカス順と表示
- 200%拡大
- スクリーンリーダーの見出し・ランドマーク
- アコーディオンの状態通知
- フォームエラーと成功通知
- reduced motion

自動検査だけでWCAG準拠を断定しません。

## 7. レスポンシブ・視覚検査

幅: 320、375、390、430、768、1024、1440px。

- 横スクロールなし
- 料金3区分がPCで同格、SPで同じ順序の縦積み
- CTAが本文を隠さない
- 長い日本語見出しが不自然に欠けない
- フォームとアコーディオンのタップ領域
- OGP、favicon、404、thanksを確認

主要幅のスクリーンショット差分を保存しますが、意図した変更は人間が承認して更新します。

## 8. フォームE2E

- 必須未入力
- 不正な連絡先形式
- 長すぎる入力
- ハニーポット入力
- 二重クリック
- ネットワーク失敗
- GAS 4xx/5xx/不正JSON
- 成功保存と通知
- 成功時のみ`generate_lead`
- 失敗時に入力保持
- スプレッドシートに式注入され得る先頭記号を安全に扱う

本番送信テストではテストデータと明示し、削除手順を決めます。

## 9. パフォーマンス

- Lighthouse mobile / desktop
- PageSpeed Insights（公開後）
- JS転送量と第三者スクリプト
- フォント・画像のウォーターフォール
- CLSの手動操作後確認
- Search ConsoleのフィールドCWV（データ蓄積後）

公開前目安:

- Lighthouse Performance 90以上
- Accessibility 95以上
- CLS 0.1以下（ラボ）
- 大容量動画・不要なスライダーなし

## 10. Cloudflare配備テスト

- PreviewとProductionのビルド成功
- Productionのみ正規canonical
- Previewはnoindex
- `_headers`反映
- HTTPS、リダイレクト、末尾スラッシュ統一
- 404のHTTP状態と表示
- キャッシュ更新後に古いHTMLが残らない

## 11. 公開チェックリスト

### 必須

- [ ] 人間が確定コピーと9ブロックを照合
- [ ] 料金・契約・法務文書が一致
- [ ] 本番URL、OGP、フォームURLを確定
- [ ] lint、typecheck、test、build、E2E成功
- [ ] キーボード、フォーム、主要幅を手動確認
- [ ] robots、sitemap、canonical、JSON-LDを検証
- [ ] GA4へ個人情報が送られない
- [ ] Search Console / Bingの所有権確認準備

### 公開直後

- [ ] URL検査とsitemap送信
- [ ] robots.txtとHTTPヘッダーを本番で再確認
- [ ] フォーム本番送信
- [ ] GA4 Realtime / DebugView確認
- [ ] 404とリダイレクト確認

## 12. 完了条件

重大な既知不具合、未承認コピー、架空値、検索を妨げるnoindex、フォーム送信不能、キーボード操作不能がないこと。点数目標未達を例外承認する場合は理由と改善期限を記録します。

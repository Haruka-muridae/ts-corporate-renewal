# Potenitas 計測仕様

**Version:** 1.0.0  
**Status:** Approved with measurement ID TODO  
**Last Updated:** 2026-07-22

## 1. 目的

LPを「観測装置」として運用し、誰がどの課題で相談し、どの情報を確認したかを、個人情報を送らずに測定します。AI回答内での引用回数など、取得できない指標を測れるとは扱いません。

## 2. 使用ツール

- Google Analytics 4
- Google Search Console
- Bing Webmaster Tools
- フォーム保存先のGoogleスプレッドシート
- 必要に応じてCloudflare Web Analytics（GA4との重複目的を整理してから）

初期段階ではGoogle Tag Managerを使いません。

## 3. イベント設計

| イベント | 条件 | 主なパラメータ |
|---|---|---|
| `cta_click` | 無料相談CTA | `location`, `link_target` |
| `form_start` | 最初の入力操作を1回だけ | `form_id` |
| `generate_lead` | サーバー成功応答後 | `form_id`, `lead_source` |
| `accordion_toggle` | 進め方・サービス・申込の開閉 | `section_id`, `state` |
| `section_view` | 実績・料金・FAQが一定割合表示 | `section_id` |
| `outbound_click` | 法人サイト等の外部リンク | `link_domain`, `link_name` |

`generate_lead`はGA4推奨イベント名です。売上額を確定できないため`value`を架空設定しません。

## 4. 禁止パラメータ

GA4へ次を送りません。

- 氏名、メール、電話番号
- 自由記述本文
- 具体的な業務上の秘密
- IPアドレスを独自に収集した値
- 個人を特定し得るフォーム回答
- URLクエリに含まれた個人情報

## 5. 実装例

```ts
type EventParams = Record<string, string | number | boolean>;

export function trackEvent(name: string, params: EventParams = {}) {
  if (typeof window === "undefined" || typeof window.gtag !== "function") return;
  window.gtag("event", name, params);
}
```

イベント名・パラメータ名は英小文字とアンダースコアに統一します。同一行動を複数イベントで重複送信しません。

## 6. 重要なファネル

```text
自然検索・参照流入
  → LP閲覧
  → 実績到達
  → 料金到達
  → CTAクリック
  → フォーム開始
  → 送信完了
  → 面談実施（スプレッドシート側）
  → 契約（スプレッドシート側）
```

ブラウザー分析と営業・契約データを自動的に個人単位で結合しません。必要な場合はプライバシー方針と法的根拠を確認します。

## 7. Search Console

確認事項:

- 指名・非指名クエリ
- ページ別クリック、表示、CTR、平均掲載順位
- インデックス状況
- Google選択canonical
- Core Web Vitals
- 構造化データの問題

指名/非指名はSearch Consoleの出力をルールで分類します。ブランド名の表記揺れをリスト管理し、完全な分類ではないことを注記します。

## 8. Bing Webmaster Tools

- サイト所有権を確認
- sitemapを送信
- クロール・インデックス問題を確認
- 実際に記事更新が増えたらIndexNowを検討

## 9. AIサービスからの参照流入

リファラーやUTMが付く範囲だけを観測できます。ChatGPT、Perplexity等が常に識別可能な参照元を送るとは限りません。

レポートでは次を分けます。

- 識別できたAI参照流入
- Direct / Unknown
- 検索流入

AI回答での表示回数・引用回数を、GA4だけで算出しません。

## 10. 仮説検証

10〜20件の応募蓄積後に、フォーム回答から次を確認します。

- 職業・事業形態
- 改善したい業務
- AI利用状況
- 価格区分
- 面談・契約への進行

少数データで市場全体を断定しません。自由記述を外部AIへ投入する場合は匿名化・利用許諾・社内方針を確認します。

## 11. 同意とプライバシー

- GA4導入をプライバシーポリシーへ記載
- Cookie同意の要否は、日本法だけでなく対象地域・機能・広告利用を含め専門家確認
- 広告目的やGoogle Signalsを初期状態で有効にしない
- 同意未取得時の動作を実装前に決定
- 保持期間とアクセス権を最小化

## 12. 公開後の確認

公開直後:

- DebugViewで各イベントを1回ずつ確認
- `generate_lead`が失敗時に送られないこと
- 自分のテストトラフィックを識別

月次:

- 自然検索、CTA、フォーム、面談、契約の推移
- 404、参照元、デバイス別の異常
- 個人情報がイベントへ混入していないか

## 13. 公式参考情報

- GA4 events: https://developers.google.com/analytics/devguides/collection/ga4/events
- GA4 recommended events: https://developers.google.com/analytics/devguides/collection/ga4/reference/events
- Search Console: https://support.google.com/webmasters/
- Bing Webmaster Tools: https://www.bing.com/webmasters/help

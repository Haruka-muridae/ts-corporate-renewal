# Potenitas 構造化データ仕様

**Version:** 1.0.0  
**Status:** Approved with entity TODOs  
**Last Updated:** 2026-07-22

## 1. 原則

- JSON-LDは人に表示される内容を補助し、置換しない
- 表示本文にない価格、評価、人物、実績、資格を追加しない
- 構造化データの採用は検索結果表示を保証しない
- URL、名称、価格、提供条件を本文・メタデータと一致させる
- 未確定値を架空の値で埋めない

## 2. 採用判断

| Schema | 方針 | 時期 |
|---|---|---|
| `Organization` | 採用 | 公開時 |
| `WebSite` | 採用 | 公開時 |
| `WebPage` | 採用 | 公開時 |
| `Service` | 採用 | 公開時 |
| `BreadcrumbList` | 下層ページのみ採用 | 下層公開時 |
| `Person` | 公開プロフィールと本人承認がある場合のみ | 要確認 |
| `FAQPage` | 表示FAQと完全一致する場合のみ任意採用 | FAQ公開後 |

## 3. 採用しないSchema

- `AggregateRating`、`Review`: 検証可能な公開レビューがない
- `Course`: 現時点の個別伴走サービスを一律にコースと定義しない
- `Product`: 物販ではない
- `Offer`: 価格・契約条件の表示と公式要件を精査するまで見送る
- `EducationalOrganization`: 運営法人を教育機関として誤分類しない

## 4. エンティティID

本番URLを`https://example.invalid`で代用しません。実装時は環境変数から次を生成します。

```text
{SITE_URL}/#organization
{SITE_URL}/#website
{SITE_URL}/#webpage
{SITE_URL}/#service
{SITE_URL}/about/#person-yuki-saito  （公開承認後のみ）
```

## 5. Organization

必須・採用値:

- `@type`: `Organization`
- `@id`: `/#organization`
- `name`: `TSアセットマネジメント合同会社`
- `url`: 法人の正規URLまたはPotenitas内の運営者ページ（要確定）

任意・要確認:

- `logo`: 正式ロゴの絶対URL
- `sameAs`: 法人が管理する公式プロフィールのみ
- `email`, `telephone`, `address`: 公開範囲を人間が承認した場合のみ

## 6. Service

- `@type`: `Service`
- `name`: `Potenitas`
- `serviceType`: `個別指導・伴走型のAI活用支援`
- `provider`: `/#organization`
- `areaServed`: オンライン提供の実態に合わせて設定。対象地域が未確定なら省略
- `description`: 表示本文と同じ意味の事実定義

`AIスクール`、資産運用、投資助言を示す値を入れません。

## 7. JSON-LDひな型

```ts
type JsonLd = Record<string, unknown>;

export function buildHomeJsonLd(siteUrl: string): JsonLd {
  const root = new URL("/", siteUrl).toString();

  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "@id": `${root}#organization`,
        name: "TSアセットマネジメント合同会社",
        url: root,
      },
      {
        "@type": "WebSite",
        "@id": `${root}#website`,
        url: root,
        name: "Potenitas",
        inLanguage: "ja-JP",
        publisher: { "@id": `${root}#organization` },
      },
      {
        "@type": "WebPage",
        "@id": `${root}#webpage`,
        url: root,
        name: "Potenitas｜自分で判断できるようになるためのAI個別指導",
        isPartOf: { "@id": `${root}#website` },
        about: { "@id": `${root}#service` },
        inLanguage: "ja-JP",
      },
      {
        "@type": "Service",
        "@id": `${root}#service`,
        name: "Potenitas",
        serviceType: "個別指導・伴走型のAI活用支援",
        provider: { "@id": `${root}#organization` },
        description:
          "実際の業務を題材に、AIの回答を自分で検証し、改善の仕組みを作り、変化を測れる状態まで伴走する個別指導サービスです。",
        url: root,
      },
    ],
  };
}
```

descriptionはLP本文と人間が承認したサービス定義に一致させます。

## 8. Next.js出力

```tsx
const jsonLd = buildHomeJsonLd(siteUrl);

<script
  type="application/ld+json"
  dangerouslySetInnerHTML={{
    __html: JSON.stringify(jsonLd).replace(/</g, "\\u003c"),
  }}
/>
```

信頼できる内部オブジェクトだけをシリアライズします。フォーム入力やCMS由来の未検証文字列をそのまま入れません。

## 9. BreadcrumbList

トップページには不要です。下層ページで、画面上のパンくずと同じ階層だけを出力します。存在しない中間ページや検索語をパンくずへ追加しません。

## 10. FAQPage

GoogleはFAQリッチリザルトの表示対象を、主に権威ある政府・医療サイトへ限定しています。Potenitasでは表示獲得を目的にしません。

採用条件:

- 質問と回答が同じページで利用者に表示される
- 回答が確定し、誇張や宣伝ではない
- 1つの質問を重複マークアップしない
- ユーザー投稿型の回答ではない

条件を満たしても、マークアップしない判断が可能です。

## 11. Person

本人が承認した公開プロフィールがある場合のみ採用します。

許可候補:

- 氏名
- 役割
- 公式プロフィールURL
- 本人が管理する公式URL

非公開:

- 生年月日、私用住所、私用連絡先
- 未確認の学歴、資格、受賞歴
- 推測した専門性

## 12. 検証

- Schema Markup Validator
- Google Rich Results Test（対応タイプのみ）
- ビルド後HTMLにJSON-LDが1回だけ存在すること
- すべての`@id`とURLが本番正規URLであること
- 表示価格・契約条件と矛盾しないこと
- Search Console拡張レポートとURL検査

## 13. 公式参考情報

- Schema.org: https://schema.org/
- Google structured data policies: https://developers.google.com/search/docs/appearance/structured-data/sd-policies
- FAQ structured data: https://developers.google.com/search/docs/appearance/structured-data/faqpage

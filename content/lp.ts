import type { LPContent } from "@/types/lp";

const consultationAction = {
  label: "相談する（無料）",
  href: "#consultation",
} as const;

export const lpContent = {
  hero: {
    id: "hero",
    serviceName: "Potenitas",
    heading: "AIの正解は、誰も教えてくれない。",
    description: [
      "自分で判断できるようになるまで、伴走します。",
      "変わったかどうかは、数字で確かめます。",
    ],
    supplement:
      "TSアセットマネジメント合同会社が提供する、個別指導・伴走型のAI活用支援サービス",
    primaryAction: consultationAction,
  },
  empathy: {
    id: "empathy",
    heading: "AI導入で起きる問題",
    description: [],
    items: [
      "AIを使いたいが、何から始めればよいかわからない",
      "AIを触ってはいるが、仕事や成果につながっていない",
      "情報が多すぎて、自分に必要な使い方を判断できない",
    ],
  },
  about: {
    id: "about",
    heading: "Potenitasとは",
    description: [
      "Potenitasは、生成AIを実務で使いこなせるようになるための、個別指導・伴走型AI活用支援サービスである。",
      "AIスクールではない。",
      "AIを仕事・学習・人生へ実装するための思考と設計を提供する。",
    ],
  },
  brand: {
    id: "brand",
    heading: "可能性は、証明できる。",
    description: [
      "AIを教えることではなく、AIを使って一人ひとりの可能性を証明すること。",
    ],
  },
  service: {
    id: "service",
    heading: "サービス内容",
    description: [],
    items: [
      {
        id: "process",
        title: "進め方",
        body: [],
        items: [
          "現状確認",
          "題材選定",
          "安全確認",
          "仕組みづくり",
          "測定",
          "説明・卒業",
        ],
        status: "confirmed",
      },
      {
        id: "delivery",
        title: "提供内容",
        body: [],
        items: [
          "1対1の個別指導",
          "1回60分、月2回、オンライン",
          "平日チャットは原則24時間以内を目安に返信",
        ],
        status: "confirmed",
      },
      {
        id: "scope",
        title: "対応範囲",
        body: [],
        items: [
          "実装代行は対象外",
          "デバッグ代行は対象外",
          "医療・法律・心理判断は対象外",
        ],
        status: "confirmed",
      },
    ],
  },
  results: {
    id: "results",
    heading: "実績",
    description: [],
    items: [
      {
        id: "education",
        label: "学習指導",
        facts: ["2020〜2023年", "約50名", "テスト平均約25点向上"],
        notes: ["AIによる成果ではない"],
      },
      {
        id: "efficiency",
        label: "業務効率化",
        facts: ["月間雑務275時間から53時間", "約80%削減"],
        notes: ["齋藤悠貴個人の実績", "自己計測値"],
      },
    ],
    disclaimer: "同様の成果を保証するものではありません。",
  },
  faq: {
    id: "faq",
    heading: "よくある質問",
    description: [],
    pendingLabel: "回答は現在確認中です。",
    items: [
      ...[
        "AI初心者でも相談できますか",
        "ChatGPT以外の生成AIも対象ですか",
        "どのような業務を題材にできますか",
        "実装やデバッグの代行は含まれますか",
        "料金と契約期間を教えてください",
        "解約、日割り、返金はどうなりますか",
        "未消化の面談はどうなりますか",
        "卒業はどのように判断されますか",
        "機密情報や個人情報はどう扱いますか",
      ].map((title, index) => ({
        id: `faq-${index + 1}`,
        title,
        body: [],
        items: [],
        status: "pending" as const,
        statusLabel: "回答確認中",
      })),
      {
        id: "faq-graduation-support",
        title: "卒業後の支援はありますか",
        body: [
          "卒業後、必要になった場合は、別契約としてコンサルティングを利用可能",
        ],
        items: [],
        status: "confirmed",
      },
    ],
  },
  pricing: {
    id: "pricing",
    heading: "料金",
    description: ["3料金枠の提供内容は同一です。"],
    plans: [
      {
        id: "general",
        name: "一般枠",
        price: null,
        pricePendingLabel: "料金詳細は現在確認中です。",
        description: "提供内容は3枠共通です。",
        action: consultationAction,
      },
      {
        id: "referral",
        name: "紹介枠",
        price: null,
        pricePendingLabel: "料金詳細は現在確認中です。",
        description: "提供内容は3枠共通です。",
        action: consultationAction,
      },
      {
        id: "scholarship",
        name: "奨学枠",
        price: null,
        pricePendingLabel: "料金詳細は現在確認中です。",
        description: "提供内容は3枠共通です。",
        action: consultationAction,
      },
    ],
    // TODO: 税込・税別の確定後に料金表示へ反映する。
    // TODO: 月額・契約総額など料金単位の確定後に料金表示へ反映する。
  },
  cta: {
    id: "consultation",
    heading: "相談する（無料）",
    description: [],
    flow: {
      heading: "お申し込みの流れ",
      pendingLabel: "具体的な流れは現在確認中です。",
    },
    form: {
      id: "consultation-form",
      heading: "無料相談フォーム",
      notice: "フォームは現在準備中です。入力内容は送信されません。",
      fields: [
        {
          id: "current-situation",
          label: "現在の状況（必須）",
          kind: "textarea",
          required: true,
        },
        {
          id: "desired-improvement",
          label: "改善したい業務（必須）",
          kind: "textarea",
          required: true,
        },
        {
          id: "ai-usage",
          label: "AI利用状況（任意）",
          kind: "textarea",
          required: false,
        },
        {
          id: "full-name",
          label: "氏名（必須）",
          kind: "text",
          required: true,
          autoComplete: "name",
        },
        {
          id: "contact",
          label: "連絡先（必須）",
          kind: "text",
          required: true,
        },
        {
          id: "occupation",
          label: "職業・事業内容（必須）",
          kind: "textarea",
          required: true,
        },
      ],
      submitLabel: "送信する",
      developmentMessage:
        "現在開発中のため、入力内容は送信されませんでした。",
    },
  },
} as const satisfies LPContent;

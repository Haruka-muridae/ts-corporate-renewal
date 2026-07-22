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
        ["faq-1", "AI初心者でも相談できますか"],
        ["faq-2", "ChatGPT以外の生成AIも対象ですか"],
        ["faq-3", "どのような業務を題材にできますか"],
      ].map(([id, title]) => ({
        id,
        title,
        body: [],
        items: [],
        status: "pending" as const,
        statusLabel: "回答確認中",
      })),
      {
        id: "faq-4",
        title: "実装やデバッグの代行は含まれますか",
        body: ["実装代行、デバッグ代行は対象外です。"],
        items: [],
        status: "confirmed",
      },
      {
        id: "faq-5",
        title: "料金と契約期間を教えてください",
        body: [
          "一般枠は月額110,000円（税込）、紹介枠は月額55,000円（税込）、奨学枠は月額11,000円（税込）です。3枠の提供内容は同一です。",
          "入会金、初期費用、追加料金はありません。契約期間は1か月で、毎月自動更新します。",
          "支払方法は原則クレジットカードです。初回決済完了後、双方で合意した日時にサービスを開始します。",
        ],
        items: [],
        status: "confirmed",
      },
      {
        id: "faq-6",
        title: "解約、日割り、返金はどうなりますか",
        body: [
          "解約は、次回請求日の前日23:59までにお手続きください。日割り返金はなく、利用者都合による返金は原則ありません。",
        ],
        items: [],
        status: "confirmed",
      },
      {
        id: "faq-7",
        title: "未消化の面談はどうなりますか",
        body: [
          "未消化面談は翌月末まで繰り越し可能で、上限は2回です。面談変更は24時間前までにお手続きください。休会制度はありません。",
        ],
        items: [],
        status: "confirmed",
      },
      ...[
        ["faq-8", "卒業はどのように判断されますか"],
        ["faq-9", "機密情報や個人情報はどう扱いますか"],
      ].map(([id, title]) => ({
        id,
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
        price: "月額110,000円（税込）",
        description: "提供内容は3枠共通です。",
        action: consultationAction,
      },
      {
        id: "referral",
        name: "紹介枠",
        price: "月額55,000円（税込）",
        description: "提供内容は3枠共通です。",
        action: consultationAction,
      },
      {
        id: "scholarship",
        name: "奨学枠",
        price: "月額11,000円（税込）",
        description: "提供内容は3枠共通です。",
        action: consultationAction,
      },
    ],
    termsHeading: "契約条件",
    terms: [
      "入会金なし",
      "初期費用なし",
      "追加料金なし",
      "契約期間1か月",
      "毎月自動更新",
      "支払方法：原則クレジットカード",
      "サービス開始：初回決済完了後、双方で合意した日時",
      "解約期限：次回請求日の前日23:59まで",
      "日割り返金なし",
      "利用者都合による返金は原則なし",
      "面談変更は24時間前まで",
      "未消化面談は翌月末まで繰り越し可能（上限2回）",
      "休会制度なし",
    ],
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
          label: "メールアドレス（必須）",
          kind: "email",
          required: true,
          autoComplete: "email",
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

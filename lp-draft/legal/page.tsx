import Link from "next/link";

import { buildPageMetadata } from "@/lib/metadata";

export const metadata = buildPageMetadata({
  title: "特定商取引法に基づく表記",
  pathname: "/legal/",
});

const legalItems = [
  { label: "事業者名", value: "TSアセットマネジメント合同会社" },
  { label: "通信販売業務責任者", value: "齋藤 悠貴（執行役員）" },
  {
    label: "所在地",
    value: (
      <address className="not-italic">
        〒249-0002
        <br />
        神奈川県逗子市久木8-8-26
      </address>
    ),
  },
  {
    label: "電話番号",
    value: (
      <a className="underline underline-offset-4" href="tel:09012614930">
        090-1261-4930
      </a>
    ),
  },
  {
    label: "メール",
    value: (
      <a
        className="underline underline-offset-4"
        href="mailto:architect@potenitas.com"
      >
        architect@potenitas.com
      </a>
    ),
  },
  {
    label: "役務内容",
    value: (
      <>
        Potenitas
        <br />
        個別伴走型AI活用支援サービス
      </>
    ),
  },
  {
    label: "料金",
    value: (
      <Link className="underline underline-offset-4" href="/#pricing">
        LP記載の料金
      </Link>
    ),
  },
  { label: "支払方法", value: "原則クレジットカード" },
  { label: "提供開始", value: "初回決済後、双方で合意した日時" },
  { label: "解約", value: "次回請求日前日23:59まで" },
] as const;

export default function LegalPage() {
  return (
    <main className="min-h-screen bg-[var(--color-off-white)] px-5 py-16 sm:px-8 sm:py-24">
      <article className="mx-auto w-full max-w-4xl border border-[var(--color-border)] bg-white p-6 sm:p-10 lg:p-14">
        <header className="border-b border-[var(--color-gold)] pb-7">
          <p className="text-sm tracking-[0.18em] text-[var(--color-text-muted)]">
            Potenitas
          </p>
          <h1 className="mt-3 text-3xl font-semibold text-[var(--color-navy)] sm:text-4xl">
            特定商取引法に基づく表記
          </h1>
        </header>

        <dl className="mt-8 divide-y divide-[var(--color-border)]">
          {legalItems.map((item) => (
            <div
              key={item.label}
              className="grid gap-2 py-5 sm:grid-cols-[13rem_1fr] sm:gap-6"
            >
              <dt className="font-semibold text-[var(--color-navy)]">
                {item.label}
              </dt>
              <dd className="min-w-0 text-base leading-8 text-[var(--color-text)]">
                {item.value}
              </dd>
            </div>
          ))}
        </dl>
      </article>
    </main>
  );
}

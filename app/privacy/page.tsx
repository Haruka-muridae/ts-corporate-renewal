import { buildPageMetadata } from "@/lib/metadata";

export const metadata = buildPageMetadata({
  title: "プライバシーポリシー",
  pathname: "/privacy/",
});

const acquiredInformation = [
  "氏名",
  "メールアドレス",
  "職業・事業内容",
  "AI利用状況",
  "相談内容",
] as const;

const purposes = [
  "無料相談対応",
  "面談調整",
  "契約手続",
  "問い合わせ管理",
  "統計的分析によるサービス改善",
] as const;

const storageDestinations = [
  "Google Workspace",
  "Google Apps Script",
  "Googleスプレッドシート",
] as const;

type ListSectionProps = Readonly<{
  title: string;
  items: readonly string[];
}>;

function ListSection({ title, items }: ListSectionProps) {
  return (
    <section className="border-t border-[var(--color-border)] pt-7">
      <h2 className="text-xl font-semibold text-[var(--color-navy)] sm:text-2xl">
        {title}
      </h2>
      <ul className="mt-4 space-y-2 text-base text-[var(--color-text)]">
        {items.map((item) => (
          <li key={item} className="flex gap-3 leading-8">
            <span
              aria-hidden="true"
              className="mt-[0.85rem] size-1.5 shrink-0 rounded-full bg-[var(--color-gold)]"
            />
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export default function PrivacyPage() {
  return (
    <main className="min-h-screen bg-[var(--color-off-white)] px-5 py-16 sm:px-8 sm:py-24">
      <article className="mx-auto w-full max-w-4xl border border-[var(--color-border)] bg-white p-6 sm:p-10 lg:p-14">
        <header className="border-b border-[var(--color-gold)] pb-7">
          <p className="text-sm tracking-[0.18em] text-[var(--color-text-muted)]">
            Potenitas
          </p>
          <h1 className="mt-3 text-3xl font-semibold text-[var(--color-navy)] sm:text-4xl">
            プライバシーポリシー
          </h1>
        </header>

        <div className="mt-8 space-y-8">
          <ListSection title="取得情報" items={acquiredInformation} />
          <ListSection title="利用目的" items={purposes} />

          <section className="border-t border-[var(--color-border)] pt-7">
            <h2 className="text-xl font-semibold text-[var(--color-navy)] sm:text-2xl">
              保存期間
            </h2>
            <p className="mt-4 text-base leading-8 text-[var(--color-text)]">
              最終対応日から3年間
            </p>
          </section>

          <ListSection title="保存先" items={storageDestinations} />

          <section className="border-t border-[var(--color-border)] pt-7">
            <h2 className="text-xl font-semibold text-[var(--color-navy)] sm:text-2xl">
              第三者提供
            </h2>
            <p className="mt-4 text-base leading-8 text-[var(--color-text)]">
              法令に基づく場合を除き行いません。
            </p>
          </section>

          <section className="border-t border-[var(--color-border)] pt-7">
            <h2 className="text-xl font-semibold text-[var(--color-navy)] sm:text-2xl">
              未成年者
            </h2>
            <p className="mt-4 text-base leading-8 text-[var(--color-text)]">
              保護者同意必須。
            </p>
          </section>
        </div>
      </article>
    </main>
  );
}

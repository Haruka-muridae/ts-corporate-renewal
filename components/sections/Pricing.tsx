import Link from "next/link";

import { Button } from "@/components/ui/Button";
import { Container } from "@/components/ui/Container";
import type { PricingContent } from "@/types/lp";

type PricingProps = Readonly<{
  content: PricingContent;
}>;

export function Pricing({ content }: PricingProps) {
  return (
    <section
      id={content.id}
      className="bg-white py-20 sm:py-28"
      aria-labelledby={`${content.id}-title`}
    >
      <Container>
        <span
          aria-hidden="true"
          className="block h-px w-12 bg-[var(--color-gold)]"
        />
        <h2
          id={`${content.id}-title`}
          className="mt-6 text-3xl font-semibold text-[var(--color-navy)] sm:text-4xl"
        >
          {content.heading}
        </h2>
        <div className="mt-5 space-y-2 text-base leading-8 text-[var(--color-text-muted)]">
          {content.description.map((paragraph) => (
            <p key={paragraph}>{paragraph}</p>
          ))}
        </div>
        <div className="mt-10 grid items-stretch gap-5 md:grid-cols-3">
          {content.plans.map((plan) => (
            <article
              key={plan.id}
              className="flex min-w-0 flex-col border border-[var(--color-border)] bg-white p-6"
            >
              <h3 className="text-xl font-semibold text-[var(--color-navy)] sm:text-2xl">
                {plan.name}
              </h3>
              <p className="mt-6 border-y border-[var(--color-border)] py-5 text-xl font-semibold leading-8 text-[var(--color-navy)]">
                {plan.price}
              </p>
              <p className="mt-5 text-base leading-7 text-[var(--color-text)]">
                {plan.description}
              </p>
              <div className="mt-auto pt-8">
                <Button href={plan.action.href} variant="secondary">
                  {plan.action.label}
                </Button>
              </div>
            </article>
          ))}
        </div>
        <section
          className="mt-12 border border-[var(--color-border)] bg-[var(--color-off-white)] p-6 sm:p-8"
          aria-labelledby={`${content.id}-terms-title`}
        >
          <h3
            id={`${content.id}-terms-title`}
            className="text-xl font-semibold text-[var(--color-navy)] sm:text-2xl"
          >
            {content.termsHeading}
          </h3>
          <ul className="mt-6 grid gap-x-10 gap-y-3 text-base text-[var(--color-text)] md:grid-cols-2">
            {content.terms.map((term) => (
              <li key={term} className="flex gap-3 leading-8">
                <span
                  aria-hidden="true"
                  className="mt-[0.85rem] size-1.5 shrink-0 rounded-full bg-[var(--color-gold)]"
                />
                <span>{term}</span>
              </li>
            ))}
          </ul>
          <nav
            className="mt-7 flex flex-wrap gap-x-6 gap-y-3 border-t border-[var(--color-border)] pt-5 text-base"
            aria-label="料金と契約に関する法務情報"
          >
            <Link
              href="/legal/"
              className="text-[var(--color-navy)] underline decoration-[var(--color-gold)] underline-offset-4 hover:text-[var(--color-gold-dark)]"
            >
              特定商取引法に基づく表記
            </Link>
            <Link
              href="/privacy/"
              className="text-[var(--color-navy)] underline decoration-[var(--color-gold)] underline-offset-4 hover:text-[var(--color-gold-dark)]"
            >
              プライバシーポリシー
            </Link>
          </nav>
        </section>
      </Container>
    </section>
  );
}

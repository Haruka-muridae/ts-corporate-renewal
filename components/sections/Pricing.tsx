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
              <p className="mt-6 border-y border-[var(--color-border)] py-5 text-base leading-7 text-[var(--color-text-muted)]">
                {plan.pricePendingLabel}
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
      </Container>
    </section>
  );
}

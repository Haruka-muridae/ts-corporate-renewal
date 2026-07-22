import { Button } from "@/components/ui/Button";
import { Container } from "@/components/ui/Container";
import type { PricingContent } from "@/types/lp";

type PricingProps = Readonly<{
  content: PricingContent;
}>;

export function Pricing({ content }: PricingProps) {
  return (
    <section id={content.id} className="py-16">
      <Container>
        <p className="text-sm text-slate-500">{content.eyebrow}</p>
        <h2 className="mt-3 text-3xl font-semibold">{content.heading}</h2>
        <p className="mt-4 text-slate-600">{content.description}</p>
        {content.plans.length > 0 && (
          <div className="mt-8 grid gap-4 md:grid-cols-3">
            {content.plans.map((plan) => (
              <article key={plan.id} className="border border-slate-200 p-5">
                <h3 className="text-xl font-semibold">{plan.name}</h3>
                <p className="mt-3">{plan.price}</p>
                <p className="mt-3 text-sm text-slate-600">
                  {plan.description}
                </p>
                <ul className="my-5 list-disc space-y-2 pl-5 text-sm">
                  {plan.features.map((feature) => (
                    <li key={feature}>{feature}</li>
                  ))}
                </ul>
                <Button href={plan.action.href} variant="secondary">
                  {plan.action.label}
                </Button>
              </article>
            ))}
          </div>
        )}
      </Container>
    </section>
  );
}

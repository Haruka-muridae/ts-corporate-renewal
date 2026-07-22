import { Button } from "@/components/ui/Button";
import { Container } from "@/components/ui/Container";
import type { HeroContent } from "@/types/lp";

type HeroProps = Readonly<{
  content: HeroContent;
}>;

export function Hero({ content }: HeroProps) {
  return (
    <section
      id={content.id}
      className="relative overflow-hidden bg-white py-24 sm:py-32"
      aria-labelledby={`${content.id}-title`}
    >
      <div
        aria-hidden="true"
        className="absolute inset-y-0 right-0 hidden w-1/3 border-l border-[var(--color-gold-light)] bg-[var(--color-off-white)] lg:block"
      />
      <Container className="relative">
        <div className="max-w-4xl">
          <p className="text-base font-semibold tracking-[0.18em] text-[var(--color-gold-dark)] uppercase">
            {content.serviceName}
          </p>
          <span
            aria-hidden="true"
            className="mt-5 block h-px w-16 bg-[var(--color-gold)]"
          />
          <h1
            id={`${content.id}-title`}
            className="mt-8 text-4xl leading-[1.35] font-semibold tracking-tight text-[var(--color-navy)] sm:text-5xl lg:text-6xl"
          >
            {content.heading}
          </h1>
          <div className="mt-8 space-y-2 text-lg leading-8 text-[var(--color-text)] sm:text-xl">
            {content.description.map((paragraph) => (
              <p key={paragraph}>{paragraph}</p>
            ))}
          </div>
          <p className="mt-8 max-w-2xl border-l-2 border-[var(--color-gold)] pl-4 text-base leading-8 text-[var(--color-text-muted)]">
            {content.supplement}
          </p>
          <div className="mt-10">
            <Button href={content.primaryAction.href}>
              {content.primaryAction.label}
            </Button>
          </div>
        </div>
      </Container>
    </section>
  );
}

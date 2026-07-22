import { Container } from "@/components/ui/Container";
import type { SectionContent } from "@/types/lp";

type BrandProps = Readonly<{
  content: SectionContent;
}>;

export function Brand({ content }: BrandProps) {
  return (
    <section
      id={content.id}
      className="border-y border-[var(--color-gold-dark)] bg-[var(--color-navy)] py-20 text-white sm:py-28"
      aria-labelledby={`${content.id}-title`}
    >
      <Container className="text-center">
        <span
          aria-hidden="true"
          className="mx-auto block h-px w-12 bg-[var(--color-gold)]"
        />
        <h2
          id={`${content.id}-title`}
          className="mt-7 text-3xl leading-tight font-semibold tracking-tight sm:text-5xl"
        >
          {content.heading}
        </h2>
        <div className="mx-auto mt-7 max-w-3xl space-y-4 text-base leading-8 text-slate-200 sm:text-lg">
          {content.description.map((paragraph) => (
            <p key={paragraph}>{paragraph}</p>
          ))}
        </div>
      </Container>
    </section>
  );
}

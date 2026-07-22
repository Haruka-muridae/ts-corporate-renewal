import { Container } from "@/components/ui/Container";
import type { SectionContent } from "@/types/lp";

type AboutProps = Readonly<{
  content: SectionContent;
}>;

export function About({ content }: AboutProps) {
  return (
    <section
      id={content.id}
      className="bg-white py-20 sm:py-28"
      aria-labelledby={`${content.id}-title`}
    >
      <Container>
        <div className="grid gap-10 lg:grid-cols-[0.8fr_1.2fr] lg:gap-20">
          <div>
            <span
              aria-hidden="true"
              className="block h-px w-12 bg-[var(--color-gold)]"
            />
            <h2
              id={`${content.id}-title`}
              className="mt-6 text-3xl leading-tight font-semibold text-[var(--color-navy)] sm:text-4xl"
            >
              {content.heading}
            </h2>
          </div>
          <div className="space-y-6 text-base leading-8 text-[var(--color-text)] sm:text-lg">
            {content.description.map((paragraph) => (
              <p key={paragraph}>{paragraph}</p>
            ))}
          </div>
        </div>
      </Container>
    </section>
  );
}

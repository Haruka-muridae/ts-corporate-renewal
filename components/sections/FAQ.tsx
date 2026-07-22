import { Accordion } from "@/components/ui/Accordion";
import { Container } from "@/components/ui/Container";
import type { AccordionSectionContent } from "@/types/lp";

type FAQProps = Readonly<{
  content: AccordionSectionContent;
}>;

export function FAQ({ content }: FAQProps) {
  return (
    <section
      id={content.id}
      className="bg-[var(--color-off-white)] py-20 sm:py-28"
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
        <div className="mt-10">
          <Accordion
            items={content.items}
            pendingLabel={content.pendingLabel}
          />
        </div>
      </Container>
    </section>
  );
}

import { Accordion } from "@/components/ui/Accordion";
import { Container } from "@/components/ui/Container";
import type { AccordionSectionContent } from "@/types/lp";

type FAQProps = Readonly<{
  content: AccordionSectionContent;
}>;

export function FAQ({ content }: FAQProps) {
  return (
    <section id={content.id} className="py-16">
      <Container>
        <p className="text-sm text-slate-500">{content.eyebrow}</p>
        <h2 className="mt-3 text-3xl font-semibold">{content.heading}</h2>
        <p className="mt-4 text-slate-600">{content.description}</p>
        <div className="mt-8">
          <Accordion items={content.items} />
        </div>
      </Container>
    </section>
  );
}

import { Container } from "@/components/ui/Container";
import type { SectionContent } from "@/types/lp";

type AboutProps = Readonly<{
  content: SectionContent;
}>;

export function About({ content }: AboutProps) {
  return (
    <section id={content.id} className="py-16">
      <Container>
        <p className="text-sm text-slate-500">{content.eyebrow}</p>
        <h2 className="mt-3 text-3xl font-semibold">{content.heading}</h2>
        <p className="mt-4 text-slate-600">{content.description}</p>
      </Container>
    </section>
  );
}

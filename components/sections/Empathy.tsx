import { Container } from "@/components/ui/Container";
import type { ListSectionContent } from "@/types/lp";

type EmpathyProps = Readonly<{
  content: ListSectionContent;
}>;

export function Empathy({ content }: EmpathyProps) {
  return (
    <section id={content.id} className="py-16">
      <Container>
        <p className="text-sm text-slate-500">{content.eyebrow}</p>
        <h2 className="mt-3 text-3xl font-semibold">{content.heading}</h2>
        <p className="mt-4 text-slate-600">{content.description}</p>
        {content.items.length > 0 && (
          <ul className="mt-6 list-disc space-y-2 pl-5">
            {content.items.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        )}
      </Container>
    </section>
  );
}

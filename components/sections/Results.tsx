import { Container } from "@/components/ui/Container";
import type { ResultsContent } from "@/types/lp";

type ResultsProps = Readonly<{
  content: ResultsContent;
}>;

export function Results({ content }: ResultsProps) {
  return (
    <section id={content.id} className="py-16">
      <Container>
        <p className="text-sm text-slate-500">{content.eyebrow}</p>
        <h2 className="mt-3 text-3xl font-semibold">{content.heading}</h2>
        <p className="mt-4 text-slate-600">{content.description}</p>
        {content.items.length > 0 && (
          <ul className="mt-8 grid gap-4 md:grid-cols-3">
            {content.items.map((item) => (
              <li key={item.id} className="border border-slate-200 p-5">
                <p className="text-sm text-slate-500">{item.label}</p>
                <p className="mt-2 text-2xl font-semibold">{item.value}</p>
                <p className="mt-3 text-sm text-slate-600">
                  {item.description}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Container>
    </section>
  );
}

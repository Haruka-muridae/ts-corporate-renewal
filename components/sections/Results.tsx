import { Container } from "@/components/ui/Container";
import type { ResultsContent } from "@/types/lp";

type ResultsProps = Readonly<{
  content: ResultsContent;
}>;

export function Results({ content }: ResultsProps) {
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
        <div className="mt-10 grid gap-5 md:grid-cols-2">
          {content.items.map((item) => (
            <article
              key={item.id}
              className="border border-[var(--color-border)] bg-white p-6 sm:p-8"
            >
              <h3 className="text-xl font-semibold text-[var(--color-navy)] sm:text-2xl">
                {item.label}
              </h3>
              <ul className="mt-6 space-y-3">
                {item.facts.map((fact) => (
                  <li
                    key={fact}
                    className="border-l-2 border-[var(--color-gold)] pl-4 text-lg leading-8 text-[var(--color-text)]"
                  >
                    {fact}
                  </li>
                ))}
              </ul>
              <ul className="mt-6 space-y-2 text-base leading-7 text-[var(--color-text-muted)]">
                {item.notes.map((note) => (
                  <li key={note}>※ {note}</li>
                ))}
              </ul>
            </article>
          ))}
        </div>
        <p className="mt-6 border-l-2 border-[var(--color-gold)] pl-4 text-base leading-7 text-[var(--color-text-muted)]">
          {content.disclaimer}
        </p>
      </Container>
    </section>
  );
}

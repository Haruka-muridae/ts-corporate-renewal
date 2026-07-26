import { Container } from "@/components/ui/Container";
import type { ListSectionContent } from "@/types/lp";

type EmpathyProps = Readonly<{
  content: ListSectionContent;
}>;

export function Empathy({ content }: EmpathyProps) {
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
          className="mt-6 text-3xl leading-tight font-semibold text-[var(--color-navy)] sm:text-4xl"
        >
          {content.heading}
        </h2>
        <ul className="mt-10 grid gap-4 lg:grid-cols-3">
          {content.items.map((item, index) => (
            <li
              key={item}
              className="border-t-2 border-[var(--color-gold)] bg-white p-6 text-base leading-8 text-[var(--color-text)] shadow-[0_8px_24px_rgba(15,39,71,0.04)]"
            >
              <span className="mb-4 block text-sm font-semibold tracking-[0.16em] text-[var(--color-gold-dark)]">
                0{index + 1}
              </span>
              {item}
            </li>
          ))}
        </ul>
      </Container>
    </section>
  );
}

import type { AccordionItemContent } from "@/types/lp";

type AccordionProps = Readonly<{
  items: readonly AccordionItemContent[];
  pendingLabel?: string;
}>;

export function Accordion({ items, pendingLabel }: AccordionProps) {
  return (
    <div className="space-y-3">
      {items.map((item) => (
        <details
          key={item.id}
          className="group rounded-sm border border-[var(--color-border)] bg-white open:border-[var(--color-gold)]"
        >
          <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-4 px-5 py-4 text-[var(--color-navy)] outline-none transition-colors duration-200 hover:bg-[var(--color-gold-pale)] focus-visible:ring-2 focus-visible:ring-[var(--color-gold)] focus-visible:ring-inset [&::-webkit-details-marker]:hidden">
            <span className="flex min-w-0 flex-1 flex-wrap items-center gap-3">
              <h3 className="text-base font-semibold sm:text-lg">
                {item.title}
              </h3>
              {item.statusLabel && (
                <span className="rounded-full border border-[var(--color-border)] bg-[var(--color-off-white)] px-2.5 py-1 text-xs font-medium text-[var(--color-text-muted)]">
                  {item.statusLabel}
                </span>
              )}
            </span>
            <span
              aria-hidden="true"
              className="grid size-7 shrink-0 place-items-center rounded-full border border-[var(--color-gold)] text-xl font-light leading-none transition-transform duration-200 group-open:rotate-45"
            >
              +
            </span>
          </summary>
          <div className="border-t border-[var(--color-border)] px-5 py-5 text-base text-[var(--color-text-muted)]">
            {item.body.map((paragraph) => (
              <p key={paragraph} className="leading-8">
                {paragraph}
              </p>
            ))}
            {item.items.length > 0 && (
              <ul className="space-y-3">
                {item.items.map((entry) => (
                  <li key={entry} className="flex gap-3 leading-8">
                    <span
                      aria-hidden="true"
                      className="mt-[0.85rem] size-1.5 shrink-0 rounded-full bg-[var(--color-gold)]"
                    />
                    <span>{entry}</span>
                  </li>
                ))}
              </ul>
            )}
            {item.status === "pending" && pendingLabel && (
              <p className="rounded-sm bg-[var(--color-off-white)] px-4 py-3 leading-7">
                {pendingLabel}
              </p>
            )}
          </div>
        </details>
      ))}
    </div>
  );
}

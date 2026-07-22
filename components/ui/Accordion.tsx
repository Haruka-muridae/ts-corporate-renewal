import type { AccordionItemContent } from "@/types/lp";

type AccordionProps = Readonly<{
  items: readonly AccordionItemContent[];
}>;

export function Accordion({ items }: AccordionProps) {
  if (items.length === 0) {
    return null;
  }

  return (
    <div className="divide-y divide-slate-200 border-y border-slate-200">
      {items.map((item) => (
        <details key={item.id}>
          <summary className="cursor-pointer py-4 font-medium">
            {item.title}
          </summary>
          <p className="pb-4 text-slate-600">{item.content}</p>
        </details>
      ))}
    </div>
  );
}

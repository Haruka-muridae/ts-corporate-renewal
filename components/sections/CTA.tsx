import { Button } from "@/components/ui/Button";
import { Container } from "@/components/ui/Container";
import type { CTAContent } from "@/types/lp";

type CTAProps = Readonly<{
  content: CTAContent;
}>;

export function CTA({ content }: CTAProps) {
  return (
    <section id={content.id} className="py-24">
      <Container className="text-center">
        <p className="text-sm text-slate-500">{content.eyebrow}</p>
        <h2 className="mt-3 text-3xl font-semibold">{content.heading}</h2>
        <p className="mx-auto mt-4 max-w-2xl text-slate-600">
          {content.description}
        </p>
        <div className="mt-8">
          <Button href={content.action.href}>{content.action.label}</Button>
        </div>
      </Container>
    </section>
  );
}

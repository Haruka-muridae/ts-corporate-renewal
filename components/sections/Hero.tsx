import { Button } from "@/components/ui/Button";
import { Container } from "@/components/ui/Container";
import type { HeroContent } from "@/types/lp";

type HeroProps = Readonly<{
  content: HeroContent;
}>;

export function Hero({ content }: HeroProps) {
  return (
    <section id={content.id} className="py-24">
      <Container>
        <p className="text-sm text-slate-500">{content.eyebrow}</p>
        <h1 className="mt-3 text-4xl font-semibold">{content.heading}</h1>
        <p className="mt-5 max-w-2xl text-slate-600">{content.description}</p>
        <div className="mt-8">
          <Button href={content.primaryAction.href}>
            {content.primaryAction.label}
          </Button>
        </div>
      </Container>
    </section>
  );
}

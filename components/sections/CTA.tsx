import { ConsultationForm } from "@/components/ui/ConsultationForm";
import { Container } from "@/components/ui/Container";
import type { CTAContent } from "@/types/lp";

type CTAProps = Readonly<{
  content: CTAContent;
}>;

export function CTA({ content }: CTAProps) {
  return (
    <section
      id={content.id}
      className="scroll-mt-4 border-t border-[var(--color-gold)] bg-[var(--color-navy-dark)] py-20 text-white sm:py-28"
      aria-labelledby={`${content.id}-title`}
    >
      <Container>
        <span
          aria-hidden="true"
          className="block h-px w-12 bg-[var(--color-gold)]"
        />
        <h2
          id={`${content.id}-title`}
          className="mt-6 text-3xl font-semibold sm:text-4xl"
        >
          {content.heading}
        </h2>

        <div className="mt-10 grid gap-8 lg:grid-cols-[0.7fr_1.3fr] lg:gap-12">
          <div className="border-t border-[var(--color-gold-dark)] pt-6">
            <h3 className="text-xl font-semibold sm:text-2xl">
              {content.flow.heading}
            </h3>
            <p className="mt-4 text-base leading-8 text-slate-300">
              {content.flow.pendingLabel}
            </p>
          </div>
          <ConsultationForm content={content.form} />
        </div>
      </Container>
    </section>
  );
}

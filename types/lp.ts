export type SectionContent = Readonly<{
  id: string;
  heading: string;
  description: readonly string[];
}>;

export type LinkContent = Readonly<{
  label: string;
  href: "#consultation";
}>;

export type AccordionItemContent = Readonly<{
  id: string;
  title: string;
  body: readonly string[];
  items: readonly string[];
  status: "confirmed" | "pending";
  statusLabel?: string;
}>;

export type ResultItemContent = Readonly<{
  id: string;
  label: string;
  facts: readonly string[];
  notes: readonly string[];
}>;

export type PricingPlanContent = Readonly<{
  id: string;
  name: string;
  price: string;
  description: string;
  action: LinkContent;
}>;

export type FormFieldContent = Readonly<{
  id: string;
  label: string;
  kind: "text" | "email" | "textarea";
  required: boolean;
  autoComplete?: "name" | "email";
}>;

export type ConsultationFormContent = Readonly<{
  id: string;
  heading: string;
  notice: string;
  fields: readonly FormFieldContent[];
  submitLabel: string;
  developmentMessage: string;
}>;

export type HeroContent = SectionContent &
  Readonly<{
    serviceName: string;
    supplement: string;
    primaryAction: LinkContent;
  }>;

export type ListSectionContent = SectionContent &
  Readonly<{
    items: readonly string[];
  }>;

export type AccordionSectionContent = SectionContent &
  Readonly<{
    items: readonly AccordionItemContent[];
    pendingLabel?: string;
  }>;

export type ResultsContent = SectionContent &
  Readonly<{
    items: readonly ResultItemContent[];
    disclaimer: string;
  }>;

export type PricingContent = SectionContent &
  Readonly<{
    plans: readonly PricingPlanContent[];
    termsHeading: string;
    terms: readonly string[];
  }>;

export type CTAContent = SectionContent &
  Readonly<{
    flow: Readonly<{
      heading: string;
      pendingLabel: string;
    }>;
    form: ConsultationFormContent;
  }>;

export type LPContent = Readonly<{
  hero: HeroContent;
  empathy: ListSectionContent;
  about: SectionContent;
  brand: SectionContent;
  service: AccordionSectionContent;
  results: ResultsContent;
  faq: AccordionSectionContent;
  pricing: PricingContent;
  cta: CTAContent;
}>;

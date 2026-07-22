export type SectionContent = Readonly<{
  id: string;
  eyebrow: string;
  heading: string;
  description: string;
}>;

export type LinkContent = Readonly<{
  label: string;
  href: string;
}>;

export type AccordionItemContent = Readonly<{
  id: string;
  title: string;
  content: string;
}>;

export type ResultItemContent = Readonly<{
  id: string;
  label: string;
  value: string;
  description: string;
}>;

export type PricingPlanContent = Readonly<{
  id: string;
  name: string;
  price: string;
  description: string;
  features: readonly string[];
  action: LinkContent;
}>;

export type HeroContent = SectionContent &
  Readonly<{
    primaryAction: LinkContent;
  }>;

export type ListSectionContent = SectionContent &
  Readonly<{
    items: readonly string[];
  }>;

export type AccordionSectionContent = SectionContent &
  Readonly<{
    items: readonly AccordionItemContent[];
  }>;

export type ResultsContent = SectionContent &
  Readonly<{
    items: readonly ResultItemContent[];
  }>;

export type PricingContent = SectionContent &
  Readonly<{
    plans: readonly PricingPlanContent[];
  }>;

export type CTAContent = SectionContent &
  Readonly<{
    action: LinkContent;
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

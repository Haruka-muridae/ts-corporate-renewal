import type { LPContent } from "@/types/lp";

const placeholderSection = {
  eyebrow: "TODO",
  heading: "TODO",
  description: "TODO",
} as const;

export const lpContent = {
  hero: {
    id: "hero",
    ...placeholderSection,
    primaryAction: {
      label: "TODO",
      href: "#cta",
    },
  },
  empathy: {
    id: "empathy",
    ...placeholderSection,
    items: [],
  },
  about: {
    id: "about",
    ...placeholderSection,
  },
  brand: {
    id: "brand",
    ...placeholderSection,
  },
  service: {
    id: "service",
    ...placeholderSection,
    items: [],
  },
  results: {
    id: "results",
    ...placeholderSection,
    items: [],
  },
  faq: {
    id: "faq",
    ...placeholderSection,
    items: [],
  },
  pricing: {
    id: "pricing",
    ...placeholderSection,
    plans: [],
  },
  cta: {
    id: "cta",
    ...placeholderSection,
    action: {
      label: "TODO",
      href: "#",
    },
  },
} as const satisfies LPContent;

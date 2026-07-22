import type { Metadata } from "next";

import { PlaceholderPage } from "@/components/ui/PlaceholderPage";
import { buildPageMetadata } from "@/lib/metadata";

export const metadata: Metadata = {
  ...buildPageMetadata({
    title: "FAQ",
    pathname: "/faq/",
  }),
  robots: {
    index: false,
    follow: true,
  },
};

export default function FaqPage() {
  return <PlaceholderPage title="FAQ" />;
}

import type { Metadata } from "next";

import { PlaceholderPage } from "@/components/ui/PlaceholderPage";
import { buildPageMetadata } from "@/lib/metadata";

export const metadata: Metadata = {
  ...buildPageMetadata({
    title: "運営者情報",
    pathname: "/about/",
  }),
  robots: {
    index: false,
    follow: true,
  },
};

export default function AboutPage() {
  return <PlaceholderPage title="運営者情報" />;
}

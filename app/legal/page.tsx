import { PlaceholderPage } from "@/components/ui/PlaceholderPage";
import { buildPageMetadata } from "@/lib/metadata";

export const metadata = buildPageMetadata({
  title: "特定商取引法に基づく表記",
  pathname: "/legal/",
});

export default function LegalPage() {
  return <PlaceholderPage title="特定商取引法に基づく表記" />;
}

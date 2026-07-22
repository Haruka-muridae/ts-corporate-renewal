import { PlaceholderPage } from "@/components/ui/PlaceholderPage";
import { buildPageMetadata } from "@/lib/metadata";

export const metadata = buildPageMetadata({
  title: "FAQ",
  pathname: "/faq/",
});

export default function FaqPage() {
  return <PlaceholderPage title="FAQ" />;
}

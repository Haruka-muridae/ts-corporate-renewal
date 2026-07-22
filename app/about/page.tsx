import { PlaceholderPage } from "@/components/ui/PlaceholderPage";
import { buildPageMetadata } from "@/lib/metadata";

export const metadata = buildPageMetadata({
  title: "運営者情報",
  pathname: "/about/",
  noIndex: true,
});

export default function AboutPage() {
  return <PlaceholderPage title="運営者情報" />;
}

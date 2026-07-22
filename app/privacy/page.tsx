import { PlaceholderPage } from "@/components/ui/PlaceholderPage";
import { buildPageMetadata } from "@/lib/metadata";

export const metadata = buildPageMetadata({
  title: "プライバシーポリシー",
  pathname: "/privacy/",
});

export default function PrivacyPage() {
  return <PlaceholderPage title="プライバシーポリシー" />;
}

import { PlaceholderPage } from "@/components/ui/PlaceholderPage";
import { buildPageMetadata } from "@/lib/metadata";

export const metadata = buildPageMetadata({
  title: "送信完了",
  pathname: "/thanks/",
  noIndex: true,
});

export default function ThanksPage() {
  return <PlaceholderPage title="送信完了" />;
}

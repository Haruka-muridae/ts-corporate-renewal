import { siteUrl } from "@/lib/env";
import { buildHomeJsonLd, serializeJsonLd } from "@/lib/jsonld";

export function HomeJsonLd() {
  if (!siteUrl) {
    return null;
  }

  const jsonLd = buildHomeJsonLd(siteUrl);

  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: serializeJsonLd(jsonLd) }}
    />
  );
}

import { siteDescription, siteName, siteTitle } from "@/lib/seo";

type JsonLd = Record<string, unknown>;

export function buildHomeJsonLd(baseUrl: URL): JsonLd {
  const root = new URL("/", baseUrl).toString();

  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "@id": `${root}#organization`,
        name: "TSアセットマネジメント合同会社",
        url: root,
      },
      {
        "@type": "WebSite",
        "@id": `${root}#website`,
        url: root,
        name: siteName,
        inLanguage: "ja-JP",
        publisher: { "@id": `${root}#organization` },
      },
      {
        "@type": "WebPage",
        "@id": `${root}#webpage`,
        url: root,
        name: siteTitle,
        isPartOf: { "@id": `${root}#website` },
        about: { "@id": `${root}#service` },
        inLanguage: "ja-JP",
      },
      {
        "@type": "Service",
        "@id": `${root}#service`,
        name: siteName,
        serviceType: "個別指導・伴走型のAI活用支援",
        provider: { "@id": `${root}#organization` },
        description: siteDescription,
        url: root,
      },
    ],
  };
}

export function serializeJsonLd(jsonLd: JsonLd): string {
  return JSON.stringify(jsonLd).replace(/</g, "\\u003c");
}

import type { Metadata } from "next";

import { getAbsoluteUrl } from "@/lib/env";
import { siteDescription, siteName } from "@/lib/seo";

type PageMetadataOptions = Readonly<{
  title: string;
  pathname: string;
  noIndex?: boolean;
}>;

export function buildPageMetadata({
  title,
  pathname,
  noIndex = false,
}: PageMetadataOptions): Metadata {
  const canonicalUrl = getAbsoluteUrl(pathname);
  const socialTitle = `${title}｜${siteName}`;

  return {
    title,
    alternates: canonicalUrl ? { canonical: canonicalUrl } : undefined,
    robots: noIndex
      ? {
          index: false,
          follow: true,
        }
      : undefined,
    openGraph: {
      type: "website",
      locale: "ja_JP",
      siteName,
      title: socialTitle,
      description: siteDescription,
      url: canonicalUrl ?? undefined,
    },
    twitter: {
      card: "summary_large_image",
      title: socialTitle,
      description: siteDescription,
    },
  };
}

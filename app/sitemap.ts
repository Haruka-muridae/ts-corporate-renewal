import type { MetadataRoute } from "next";

import { getAbsoluteUrl, isProductionDeployment } from "@/lib/env";

export const dynamic = "force-static";

const sitemapPaths = ["/", "/about/", "/faq/", "/privacy/", "/legal/"];

export default function sitemap(): MetadataRoute.Sitemap {
  if (!isProductionDeployment) {
    return [];
  }

  return sitemapPaths.map((pathname) => {
    const url = getAbsoluteUrl(pathname);

    if (!url) {
      throw new Error("A production sitemap requires NEXT_PUBLIC_SITE_URL.");
    }

    return { url };
  });
}

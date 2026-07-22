import type { MetadataRoute } from "next";

import {
  getAbsoluteUrl,
  isProductionDeployment,
} from "@/lib/env";

export const dynamic = "force-static";

export default function robots(): MetadataRoute.Robots {
  if (!isProductionDeployment) {
    return {
      rules: {
        userAgent: "*",
        disallow: "/",
      },
    };
  }

  const sitemapUrl = getAbsoluteUrl("/sitemap.xml");

  if (!sitemapUrl) {
    throw new Error("A production sitemap requires NEXT_PUBLIC_SITE_URL.");
  }

  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
      },
      {
        userAgent: ["GPTBot", "ClaudeBot", "Google-Extended"],
        disallow: "/",
      },
    ],
    sitemap: sitemapUrl,
  };
}

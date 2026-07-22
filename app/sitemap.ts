import type { MetadataRoute } from "next";

import { getAbsoluteUrl, isProductionDeployment } from "@/lib/env";

export const dynamic = "force-static";

export default function sitemap(): MetadataRoute.Sitemap {
  if (!isProductionDeployment) {
    return [];
  }

  const url = getAbsoluteUrl("/");

  if (!url) {
    throw new Error("A production sitemap requires NEXT_PUBLIC_SITE_URL.");
  }

  return [{ url }];
}

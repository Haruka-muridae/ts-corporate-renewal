import type { Metadata } from "next";
import type { ReactNode } from "react";

import { isProductionDeployment, siteUrl } from "@/lib/env";
import {
  siteDescription,
  siteKeywords,
  siteName,
  siteTitle,
} from "@/lib/seo";

import "./globals.css";

type RootLayoutProps = Readonly<{
  children: ReactNode;
}>;

const canonicalUrl = siteUrl ? new URL("/", siteUrl).toString() : undefined;

export const metadata: Metadata = {
  metadataBase: siteUrl ?? undefined,
  title: {
    default: siteTitle,
    template: `%s｜${siteName}`,
  },
  description: siteDescription,
  keywords: siteKeywords,
  alternates: canonicalUrl ? { canonical: canonicalUrl } : undefined,
  robots: isProductionDeployment
    ? {
        index: true,
        follow: true,
        googleBot: {
          index: true,
          follow: true,
          "max-image-preview": "large",
          "max-snippet": -1,
          "max-video-preview": -1,
        },
      }
    : {
        index: false,
        follow: false,
        noarchive: true,
      },
  openGraph: {
    type: "website",
    locale: "ja_JP",
    siteName,
    title: siteTitle,
    description: siteDescription,
    url: canonicalUrl,
    // TODO: 承認済みの1200x630px OGP画像が用意されたら images を追加する。
  },
  twitter: {
    card: "summary_large_image",
    title: siteTitle,
    description: siteDescription,
    // TODO: 承認済みのOGP画像が用意されたら images を追加する。
  },
  // TODO: favicon.ico、icon、apple-touch-iconの実画像確定後に icons を追加する。
};

export default function RootLayout({ children }: RootLayoutProps) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}

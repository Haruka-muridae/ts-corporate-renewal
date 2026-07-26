const deploymentEnvironment =
  process.env.NEXT_PUBLIC_DEPLOY_ENV?.trim().toLowerCase() ?? "preview";

export const isProductionDeployment =
  deploymentEnvironment === "production";

function readSiteUrl(): URL | null {
  const value = process.env.NEXT_PUBLIC_SITE_URL?.trim();

  if (!value) {
    if (isProductionDeployment) {
      throw new Error(
        "NEXT_PUBLIC_SITE_URL is required for a production deployment.",
      );
    }

    return null;
  }

  let parsedUrl: URL;

  try {
    parsedUrl = new URL(value);
  } catch {
    throw new Error("NEXT_PUBLIC_SITE_URL must be an absolute URL.");
  }

  if (parsedUrl.protocol !== "https:" && isProductionDeployment) {
    throw new Error("NEXT_PUBLIC_SITE_URL must use HTTPS in production.");
  }

  if (parsedUrl.search || parsedUrl.hash || parsedUrl.username || parsedUrl.password) {
    throw new Error(
      "NEXT_PUBLIC_SITE_URL must not contain credentials, a query, or a hash.",
    );
  }

  parsedUrl.pathname = "/";

  return parsedUrl;
}

export const siteUrl = readSiteUrl();

export function getAbsoluteUrl(pathname: string): string | null {
  return siteUrl ? new URL(pathname, siteUrl).toString() : null;
}

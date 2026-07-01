const DEFAULT_PRODUCTION_SITE_URL = "https://conclave.acmvit.in";
const DEFAULT_DEVELOPMENT_SITE_URL = "http://localhost:3000";

const defaultSiteUrl =
  process.env.NODE_ENV === "production"
    ? DEFAULT_PRODUCTION_SITE_URL
    : DEFAULT_DEVELOPMENT_SITE_URL;

const firstNonEmpty = (
  ...values: Array<string | undefined>
): string | undefined => {
  for (const value of values) {
    const normalized = value?.trim();
    if (normalized) return normalized;
  }
  return undefined;
};

export const normalizeOrigin = (value: string | undefined): string | null => {
  if (!value?.trim()) return null;
  try {
    const withProtocol = value.includes("://") ? value : `https://${value}`;
    return new URL(withProtocol).origin;
  } catch {
    return null;
  }
};

export const getPublicSiteUrl = (): string =>
  normalizeOrigin(
    firstNonEmpty(
      process.env.NEXT_PUBLIC_SITE_URL,
      process.env.NEXT_PUBLIC_APP_URL,
      process.env.BETTER_AUTH_URL,
      process.env.BETTER_AUTH_BASE_URL,
      process.env.VERCEL_URL,
    ),
  ) ?? defaultSiteUrl;

export const getAuthBaseUrl = (): string =>
  normalizeOrigin(
    firstNonEmpty(
      process.env.BETTER_AUTH_URL,
      process.env.BETTER_AUTH_BASE_URL,
      process.env.NEXT_PUBLIC_APP_URL,
      process.env.NEXT_PUBLIC_SITE_URL,
      process.env.VERCEL_URL,
    ),
  ) ?? defaultSiteUrl;

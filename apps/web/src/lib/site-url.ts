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

const webHostOf = (url: string | undefined): string | null => {
  const value = url?.trim();
  if (!value) return null;
  const href = /^https?:\/\//i.test(value)
    ? value
    : /^[a-z0-9.-]+(?::\d+)?\/?$/i.test(value)
      ? `https://${value}`
      : null;
  if (!href) return null;
  try {
    const parsed = new URL(href);
    return parsed.host && !parsed.username && !parsed.password ? parsed.host : null;
  } catch {
    return null;
  }
};

export const getMeetingLinkHosts = (): string[] => {
  const hosts = new Set<string>();
  for (const url of [
    DEFAULT_PRODUCTION_SITE_URL,
    process.env.NEXT_PUBLIC_SITE_URL,
    process.env.NEXT_PUBLIC_APP_URL,
  ]) {
    const host = webHostOf(url);
    if (host) hosts.add(host);
  }
  if (
    typeof window !== "undefined" &&
    /^https?:$/.test(window.location.protocol) &&
    window.location.host
  ) {
    hosts.add(window.location.host);
  }
  return [...hosts];
};

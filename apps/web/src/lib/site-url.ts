import { canonicalHost } from "./comparable-host";

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

const WEB_URL = /^https?:\/\//i;
const SCHEMELESS_AUTHORITY = /^(?:\[[0-9a-f:.]+\]|[^\s@:[\]]+)(?::\d+)?$/i;

const parseSiteSetting = (
  value: string | undefined,
): { origin: string; host: string } | null => {
  const setting = value?.trim();
  if (!setting) return null;
  const explicit = WEB_URL.test(setting);
  if (!explicit && !SCHEMELESS_AUTHORITY.test(setting.split(/[/?#\\]/)[0])) return null;
  let url: URL;
  try {
    url = new URL(explicit ? setting : `https://${setting}`);
  } catch {
    return null;
  }
  const host = url.hostname ? canonicalHost(url.host) : null;
  return host ? { origin: url.origin, host } : null;
};

export const getPublicSiteUrl = (): string => {
  for (const value of [
    process.env.NEXT_PUBLIC_SITE_URL,
    process.env.NEXT_PUBLIC_APP_URL,
    process.env.BETTER_AUTH_URL,
    process.env.BETTER_AUTH_BASE_URL,
    process.env.VERCEL_URL,
  ]) {
    const setting = parseSiteSetting(value);
    if (setting) return setting.origin;
  }
  return defaultSiteUrl;
};

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

export const getMeetingLinkHosts = (): string[] => {
  const hosts = new Set<string>();
  for (const url of [
    DEFAULT_PRODUCTION_SITE_URL,
    process.env.NEXT_PUBLIC_SITE_URL,
    process.env.NEXT_PUBLIC_APP_URL,
  ]) {
    const setting = parseSiteSetting(url);
    if (setting) hosts.add(setting.host);
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

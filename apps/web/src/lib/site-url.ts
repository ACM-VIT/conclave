import { webOrigin } from "./meeting-origin";

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

const WEB_URL = /^https?:/i;
const SCHEMELESS_AUTHORITY = /^(?:\[[0-9a-f:.]+\]|[^\s@:[\]]+)(?::\d+)?$/i;

const siteSettingOrigin = (value: string | undefined): string | null => {
  const setting = value?.trim();
  if (!setting) return null;
  if (WEB_URL.test(setting)) return webOrigin(setting);
  if (!SCHEMELESS_AUTHORITY.test(setting.split(/[/?#\\]/)[0])) return null;
  return webOrigin(`https://${setting}`);
};

export const getPublicSiteUrl = (): string => {
  for (const value of [
    process.env.NEXT_PUBLIC_SITE_URL,
    process.env.NEXT_PUBLIC_APP_URL,
    process.env.BETTER_AUTH_URL,
    process.env.BETTER_AUTH_BASE_URL,
    process.env.VERCEL_URL,
  ]) {
    const origin = siteSettingOrigin(value);
    if (origin) return origin;
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

export const getMeetingLinkOrigins = (): string[] => {
  const origins = new Set<string>();
  for (const value of [
    DEFAULT_PRODUCTION_SITE_URL,
    process.env.NEXT_PUBLIC_SITE_URL,
    process.env.NEXT_PUBLIC_APP_URL,
  ]) {
    const origin = siteSettingOrigin(value);
    if (origin) origins.add(origin);
  }
  if (typeof window !== "undefined") {
    const current = webOrigin(`${window.location.protocol}//${window.location.host}/`);
    if (current) origins.add(current);
  }
  return [...origins];
};

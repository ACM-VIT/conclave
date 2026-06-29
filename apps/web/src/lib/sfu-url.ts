const PUBLIC_SFU_URL = "https://sfu.acmvit.in";

const envValue = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed || undefined;
};

const splitUrlList = (value: string | undefined): string[] =>
  (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .map((entry) => {
      const separatorIndex = entry.indexOf("=");
      return separatorIndex >= 0 ? entry.slice(separatorIndex + 1).trim() : entry;
    })
    .filter(Boolean);

const uniqueUrls = (values: string[]): string[] => {
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const value of values) {
    const normalized = productionSafeSfuUrl(value);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    urls.push(normalized);
  }
  return urls;
};

const isProductionRuntime = (): boolean =>
  process.env.NODE_ENV === "production";

const isLocalhostUrl = (value: string): boolean => {
  try {
    const { hostname } = new URL(value);
    return hostname === "localhost" || hostname === "127.0.0.1";
  } catch {
    return false;
  }
};

export const normalizeSfuUrl = (value: string): string =>
  value.trim().replace(/\/+$/, "");

const productionSafeSfuUrl = (value: string): string => {
  const normalized = normalizeSfuUrl(value);
  if (isProductionRuntime() && isLocalhostUrl(normalized)) {
    return PUBLIC_SFU_URL;
  }
  return normalized;
};

export const resolveSfuUrls = (): string[] => {
  const configuredUrls = [
    ...splitUrlList(process.env.SFU_URLS),
    ...splitUrlList(process.env.SFU_POOL_URLS),
    ...splitUrlList(process.env.SFU_POOL),
    ...splitUrlList(process.env.NEXT_PUBLIC_SFU_URLS),
    envValue(process.env.SFU_URL),
    envValue(process.env.NEXT_PUBLIC_SFU_URL),
  ].filter((value): value is string => Boolean(value));

  return uniqueUrls(configuredUrls.length > 0 ? configuredUrls : [PUBLIC_SFU_URL]);
};

export const resolveSfuUrl = (): string =>
  resolveSfuUrls()[0] ?? productionSafeSfuUrl(PUBLIC_SFU_URL);

export const normalizeRoutedSfuUrl = (value: unknown): string | null => {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }
    return productionSafeSfuUrl(url.toString());
  } catch {
    return null;
  }
};

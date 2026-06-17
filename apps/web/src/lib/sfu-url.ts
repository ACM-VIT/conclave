const PUBLIC_SFU_URL = "https://sfu.acmvit.in";

const envValue = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed || undefined;
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

export const resolveSfuUrl = (): string =>
  productionSafeSfuUrl(
    envValue(process.env.SFU_URL) ||
      envValue(process.env.NEXT_PUBLIC_SFU_URL) ||
      PUBLIC_SFU_URL,
  );

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

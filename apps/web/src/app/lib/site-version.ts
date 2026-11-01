export interface ConclaveSiteVersion {
  id: string;
  tag: string | null;
  timestamp: string | null;
}

export interface ConclaveMinNativeVersion {
  ios: string;
  android: string;
}

export interface ConclaveSiteVersionResponse {
  serviceVersion: ConclaveSiteVersion;
  clientVersion?: ConclaveSiteVersion;
  minNativeVersion?: ConclaveMinNativeVersion;
}

export const DEFAULT_CONCLAVE_MIN_NATIVE_VERSION: ConclaveMinNativeVersion = {
  ios: "2.0.0",
  android: "2.0.0",
};

const NATIVE_VERSION_PATTERN = /^\d{1,4}(\.\d{1,4}){0,3}$/;

const nativeVersionOrFallback = (value: unknown, fallback: string): string => {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim();
  return NATIVE_VERSION_PATTERN.test(normalized) ? normalized : fallback;
};

export const resolveConclaveMinNativeVersion = (
  env: Record<string, string | undefined>,
): ConclaveMinNativeVersion => ({
  ios: nativeVersionOrFallback(
    env.CONCLAVE_MIN_NATIVE_VERSION_IOS,
    DEFAULT_CONCLAVE_MIN_NATIVE_VERSION.ios,
  ),
  android: nativeVersionOrFallback(
    env.CONCLAVE_MIN_NATIVE_VERSION_ANDROID,
    DEFAULT_CONCLAVE_MIN_NATIVE_VERSION.android,
  ),
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const nullableString = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized || null;
};

export const normalizeConclaveSiteVersion = (
  metadata: unknown,
  fallbackId = "local",
): ConclaveSiteVersion => {
  if (!isRecord(metadata)) {
    return {
      id: fallbackId,
      tag: null,
      timestamp: null,
    };
  }

  return {
    id:
      nullableString(metadata.id) ??
      nullableString(metadata.version_id) ??
      fallbackId,
    tag: nullableString(metadata.tag) ?? nullableString(metadata.version_tag),
    timestamp:
      nullableString(metadata.timestamp) ??
      nullableString(metadata.created_at) ??
      nullableString(metadata.created_on),
  };
};

const isConclaveSiteVersion = (
  value: unknown,
): value is ConclaveSiteVersion => {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    (typeof value.tag === "string" || value.tag === null) &&
    (typeof value.timestamp === "string" || value.timestamp === null)
  );
};

export const isConclaveSiteVersionResponse = (
  value: unknown,
): value is ConclaveSiteVersionResponse =>
  isRecord(value) &&
  isConclaveSiteVersion(value.serviceVersion) &&
  (value.clientVersion === undefined ||
    isConclaveSiteVersion(value.clientVersion));

export const isSameConclaveSiteVersion = (
  current: ConclaveSiteVersion,
  next: ConclaveSiteVersion,
): boolean =>
  current.id === next.id &&
  current.tag === next.tag &&
  current.timestamp === next.timestamp;

export const formatConclaveSiteVersionLabel = (
  version: ConclaveSiteVersion,
): string => {
  if (version.tag) return version.tag;

  if (version.timestamp) {
    const timestamp = new Date(version.timestamp);
    if (!Number.isNaN(timestamp.valueOf())) {
      return timestamp.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      });
    }
  }

  return version.id === "local" ? "local" : version.id.slice(0, 8);
};

export const resolveAvailableConclaveVersion = (
  currentClientVersion: ConclaveSiteVersion,
  latest: ConclaveSiteVersionResponse,
): ConclaveSiteVersion | null => {
  const latestClientVersion = latest.clientVersion ?? latest.serviceVersion;
  if (
    currentClientVersion.id === "local" ||
    latestClientVersion.id === "local"
  ) {
    return null;
  }
  return isSameConclaveSiteVersion(currentClientVersion, latestClientVersion)
    ? null
    : latest.serviceVersion;
};

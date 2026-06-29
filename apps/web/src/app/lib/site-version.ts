export interface ConclaveSiteVersion {
  id: string;
  tag: string | null;
  timestamp: string | null;
}

export interface ConclaveSiteVersionResponse {
  serviceVersion: ConclaveSiteVersion;
}

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

export const isConclaveSiteVersion = (
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
  isRecord(value) && isConclaveSiteVersion(value.serviceVersion);

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

export type YouTubeBroadcastStatus =
  | "live"
  | "upcoming"
  | "none"
  | "unknown";

export const YOUTUBE_TRANSIENT_METADATA_TTL_MS = 30 * 1000;
export const YOUTUBE_VOD_METADATA_TTL_MS = 15 * 60 * 1000;

export const resolveYouTubeBroadcastStatus = (
  value: unknown,
  actualEndTime: unknown,
): YouTubeBroadcastStatus => {
  if (typeof actualEndTime === "string") return "none";
  if (value === "live" || value === "upcoming" || value === "none") {
    return value;
  }
  return "unknown";
};

export const youtubeMetadataCacheTtl = (
  status: YouTubeBroadcastStatus,
): number =>
  status === "none"
    ? YOUTUBE_VOD_METADATA_TTL_MS
    : YOUTUBE_TRANSIENT_METADATA_TTL_MS;

export const youtubeMetadataRevalidateAfter = (
  status: YouTubeBroadcastStatus,
): number | null =>
  status === "none" ? null : YOUTUBE_TRANSIENT_METADATA_TTL_MS;

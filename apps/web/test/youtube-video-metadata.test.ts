import { describe, expect, it } from "vitest";
import {
  YOUTUBE_TRANSIENT_METADATA_TTL_MS,
  YOUTUBE_VOD_METADATA_TTL_MS,
  resolveYouTubeBroadcastStatus,
  youtubeMetadataCacheTtl,
  youtubeMetadataRevalidateAfter,
} from "../src/lib/youtube-video-metadata";
import {
  liveHintForMetadata,
  type WatchVideoMetadata,
} from "../../../packages/apps-sdk/src/apps/watch/web/youtubeMeta";

const metadata = (
  broadcastStatus: WatchVideoMetadata["broadcastStatus"],
): WatchVideoMetadata => ({
  videoId: "abcdefghijk",
  title: "Example",
  isLive: broadcastStatus === "live",
  broadcastStatus,
  revalidateAfterMs:
    broadcastStatus === "none" ? null : YOUTUBE_TRANSIENT_METADATA_TTL_MS,
});

describe("YouTube video metadata", () => {
  it("keeps upcoming and unknown broadcasts on the short cache path", () => {
    expect(resolveYouTubeBroadcastStatus("upcoming", undefined)).toBe(
      "upcoming",
    );
    expect(resolveYouTubeBroadcastStatus(undefined, undefined)).toBe(
      "unknown",
    );
    expect(youtubeMetadataCacheTtl("upcoming")).toBe(
      YOUTUBE_TRANSIENT_METADATA_TTL_MS,
    );
    expect(youtubeMetadataCacheTtl("unknown")).toBe(
      YOUTUBE_TRANSIENT_METADATA_TTL_MS,
    );
    expect(youtubeMetadataRevalidateAfter("upcoming")).toBe(
      YOUTUBE_TRANSIENT_METADATA_TTL_MS,
    );
  });

  it("uses the long cache only for confirmed non-live videos", () => {
    expect(resolveYouTubeBroadcastStatus("live", "2026-07-10T12:00:00Z")).toBe(
      "none",
    );
    expect(youtubeMetadataCacheTtl("none")).toBe(
      YOUTUBE_VOD_METADATA_TTL_MS,
    );
    expect(youtubeMetadataRevalidateAfter("none")).toBeNull();
  });

  it("keeps transient metadata non-authoritative for iframe live detection", () => {
    expect(liveHintForMetadata(metadata("upcoming"))).toBeNull();
    expect(liveHintForMetadata(metadata("unknown"))).toBeNull();
    expect(liveHintForMetadata(metadata("live"))).toBe(true);
    expect(liveHintForMetadata(metadata("none"))).toBe(false);
  });
});

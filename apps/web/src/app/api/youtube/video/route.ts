import { NextResponse } from "next/server";
import {
  takeYouTubeRateLimit,
  youtubeRateLimitResponse,
} from "../rate-limit";
import {
  resolveYouTubeBroadcastStatus,
  youtubeMetadataCacheTtl,
  youtubeMetadataRevalidateAfter,
  type YouTubeBroadcastStatus,
} from "@/lib/youtube-video-metadata";

const YOUTUBE_VIDEOS_URL = "https://www.googleapis.com/youtube/v3/videos";
const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
const CACHE_MAX_ENTRIES = 128;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_REQUESTS = 30;

export type YouTubeVideoMetadata = {
  videoId: string;
  title: string;
  isLive: boolean;
  broadcastStatus: YouTubeBroadcastStatus;
  revalidateAfterMs: number | null;
};

type CacheEntry = {
  at: number;
  value: YouTubeVideoMetadata;
};

const cache = new Map<string, CacheEntry>();

type VideosResponse = {
  items?: Array<{
    id?: unknown;
    snippet?: {
      title?: unknown;
      liveBroadcastContent?: unknown;
    };
    liveStreamingDetails?: {
      actualEndTime?: unknown;
    };
  }>;
};

const readCache = (videoId: string): YouTubeVideoMetadata | null => {
  const entry = cache.get(videoId);
  if (!entry) return null;
  const ttl = youtubeMetadataCacheTtl(entry.value.broadcastStatus);
  if (Date.now() - entry.at >= ttl) {
    cache.delete(videoId);
    return null;
  }
  return entry.value;
};

const writeCache = (value: YouTubeVideoMetadata): void => {
  if (cache.size >= CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(value.videoId, { at: Date.now(), value });
};

/**
 * Resolve the currently-playing video's live status server-side. The iframe
 * API reports a growing, finite duration for broadcasts, so duration alone
 * cannot distinguish a DVR-enabled live stream from an ordinary video.
 */
export async function GET(request: Request): Promise<Response> {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "YouTube metadata is not configured" },
      { status: 503 },
    );
  }

  const videoId = new URL(request.url).searchParams.get("id")?.trim() ?? "";
  if (!VIDEO_ID_PATTERN.test(videoId)) {
    return NextResponse.json({ error: "Invalid video id" }, { status: 400 });
  }

  const cached = readCache(videoId);
  if (cached) return NextResponse.json(cached);

  const rateLimit = await takeYouTubeRateLimit(request, {
    scope: "video-metadata",
    binding: "YOUTUBE_METADATA_RATE_LIMITER",
    limit: RATE_LIMIT_REQUESTS,
    windowMs: RATE_LIMIT_WINDOW_MS,
  });
  if (!rateLimit.ok) return youtubeRateLimitResponse(rateLimit);

  const url = new URL(YOUTUBE_VIDEOS_URL);
  url.searchParams.set("part", "snippet,liveStreamingDetails");
  url.searchParams.set("id", videoId);
  url.searchParams.set("key", apiKey);

  try {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) {
      return NextResponse.json(
        { error: "YouTube metadata lookup failed" },
        { status: 502 },
      );
    }
    const payload = (await response.json()) as VideosResponse;
    const item = payload.items?.find((candidate) => candidate.id === videoId);
    const title = item?.snippet?.title;
    if (!item || typeof title !== "string") {
      return NextResponse.json({ error: "Video not found" }, { status: 404 });
    }

    const broadcastStatus = resolveYouTubeBroadcastStatus(
      item.snippet?.liveBroadcastContent,
      item.liveStreamingDetails?.actualEndTime,
    );
    const value: YouTubeVideoMetadata = {
      videoId,
      title,
      isLive: broadcastStatus === "live",
      broadcastStatus,
      revalidateAfterMs: youtubeMetadataRevalidateAfter(broadcastStatus),
    };
    writeCache(value);
    return NextResponse.json(value);
  } catch {
    return NextResponse.json(
      { error: "YouTube metadata lookup failed" },
      { status: 502 },
    );
  }
}

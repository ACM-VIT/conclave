import { NextResponse } from "next/server";
import { parseIsoDuration, type YouTubeSearchItem } from "../search/route";
import {
  takeYouTubeRateLimit,
  youtubeRateLimitResponse,
} from "../rate-limit";

const YOUTUBE_VIDEOS_URL = "https://www.googleapis.com/youtube/v3/videos";
const REGION_CODE = "US";
const MAX_RESULTS = 12;
const CACHE_TTL_MS = 15 * 60 * 1000;
const CACHE_MAX_ENTRIES = 16;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_REQUESTS = 30;

type TrendingPage = {
  at: number;
  items: YouTubeSearchItem[];
  nextPageToken: string | null;
};

const pageCache = new Map<string, TrendingPage>();

type VideosResponse = {
  items?: Array<{
    id?: unknown;
    snippet?: {
      title?: unknown;
      channelTitle?: unknown;
      publishedAt?: unknown;
      thumbnails?: { medium?: { url?: unknown }; default?: { url?: unknown } };
    };
    contentDetails?: { duration?: unknown };
    statistics?: { viewCount?: unknown };
  }>;
};

const mapItems = (payload: VideosResponse): YouTubeSearchItem[] => {
  const items: YouTubeSearchItem[] = [];
  for (const item of payload.items ?? []) {
    const videoId = item.id;
    const title = item.snippet?.title;
    if (typeof videoId !== "string" || typeof title !== "string") continue;
    const thumb =
      item.snippet?.thumbnails?.medium?.url ??
      item.snippet?.thumbnails?.default?.url;
    const views = Number(item.statistics?.viewCount);
    items.push({
      videoId,
      title,
      channel:
        typeof item.snippet?.channelTitle === "string"
          ? item.snippet.channelTitle
          : "",
      thumbnail: typeof thumb === "string" ? thumb : null,
      durationSeconds: parseIsoDuration(item.contentDetails?.duration),
      views: Number.isFinite(views) ? views : null,
      publishedAt:
        typeof item.snippet?.publishedAt === "string"
          ? item.snippet.publishedAt
          : null,
    });
  }
  return items;
};

export async function GET(request: Request): Promise<Response> {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "YouTube browse is not configured" },
      { status: 503 },
    );
  }

  const pageToken =
    new URL(request.url).searchParams.get("pageToken")?.trim().slice(0, 64) ??
    "";

  const cached = pageCache.get(pageToken);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return NextResponse.json({
      items: cached.items,
      nextPageToken: cached.nextPageToken,
    });
  }

  const rateLimit = await takeYouTubeRateLimit(request, {
    scope: "trending",
    binding: "YOUTUBE_TRENDING_RATE_LIMITER",
    limit: RATE_LIMIT_REQUESTS,
    windowMs: RATE_LIMIT_WINDOW_MS,
  });
  if (!rateLimit.ok) {
    return youtubeRateLimitResponse(rateLimit);
  }

  const url = new URL(YOUTUBE_VIDEOS_URL);
  url.searchParams.set("part", "snippet,contentDetails,statistics");
  url.searchParams.set("chart", "mostPopular");
  url.searchParams.set("regionCode", REGION_CODE);
  url.searchParams.set("maxResults", String(MAX_RESULTS));
  if (pageToken) url.searchParams.set("pageToken", pageToken);
  url.searchParams.set("key", apiKey);

  try {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) {
      return NextResponse.json(
        { error: "YouTube browse failed" },
        { status: 502 },
      );
    }
    const payload = (await response.json()) as VideosResponse & {
      nextPageToken?: unknown;
    };
    const items = mapItems(payload);
    const nextPageToken =
      typeof payload.nextPageToken === "string" ? payload.nextPageToken : null;
    if (pageCache.size >= CACHE_MAX_ENTRIES) {
      const oldest = pageCache.keys().next().value;
      if (oldest !== undefined) pageCache.delete(oldest);
    }
    pageCache.set(pageToken, { at: Date.now(), items, nextPageToken });
    return NextResponse.json({ items, nextPageToken });
  } catch {
    return NextResponse.json(
      { error: "YouTube browse failed" },
      { status: 502 },
    );
  }
}

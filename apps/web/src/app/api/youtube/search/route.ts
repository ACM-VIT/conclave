import { NextResponse } from "next/server";
import {
  takeYouTubeRateLimit,
  youtubeRateLimitResponse,
} from "../rate-limit";

const YOUTUBE_SEARCH_URL = "https://www.googleapis.com/youtube/v3/search";
const YOUTUBE_VIDEOS_URL = "https://www.googleapis.com/youtube/v3/videos";
const MAX_QUERY_LENGTH = 100;
const MAX_RESULTS = 12;
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX_ENTRIES = 64;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_REQUESTS = 8;

export type YouTubeSearchItem = {
  videoId: string;
  title: string;
  channel: string;
  thumbnail: string | null;
  durationSeconds: number | null;
  views: number | null;
  publishedAt: string | null;
};

const cache = new Map<string, { at: number; items: YouTubeSearchItem[] }>();

const readCache = (key: string): YouTubeSearchItem[] | null => {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.at > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry.items;
};

const writeCache = (key: string, items: YouTubeSearchItem[]): void => {
  if (cache.size >= CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { at: Date.now(), items });
};

export const parseIsoDuration = (value: unknown): number | null => {
  if (typeof value !== "string") return null;
  const match = value.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!match) return null;
  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2] ?? 0);
  const seconds = Number(match[3] ?? 0);
  return hours * 3600 + minutes * 60 + seconds;
};

type SearchResponse = {
  items?: Array<{
    id?: { videoId?: unknown };
    snippet?: {
      title?: unknown;
      channelTitle?: unknown;
      publishedAt?: unknown;
      thumbnails?: { medium?: { url?: unknown }; default?: { url?: unknown } };
    };
  }>;
};

type VideoDetailsResponse = {
  items?: Array<{
    id?: unknown;
    contentDetails?: { duration?: unknown };
    statistics?: { viewCount?: unknown };
  }>;
};

export async function GET(request: Request): Promise<Response> {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "YouTube search is not configured" },
      { status: 503 },
    );
  }

  const query = new URL(request.url).searchParams
    .get("q")
    ?.trim()
    .slice(0, MAX_QUERY_LENGTH);
  if (!query) {
    return NextResponse.json({ error: "Missing query" }, { status: 400 });
  }

  const cacheKey = query.toLowerCase();
  const cached = readCache(cacheKey);
  if (cached) {
    return NextResponse.json({ items: cached });
  }

  const rateLimit = await takeYouTubeRateLimit(request, {
    scope: "search",
    binding: "YOUTUBE_SEARCH_RATE_LIMITER",
    limit: RATE_LIMIT_REQUESTS,
    windowMs: RATE_LIMIT_WINDOW_MS,
  });
  if (!rateLimit.ok) {
    return youtubeRateLimitResponse(rateLimit);
  }

  const searchUrl = new URL(YOUTUBE_SEARCH_URL);
  searchUrl.searchParams.set("part", "snippet");
  searchUrl.searchParams.set("type", "video");
  searchUrl.searchParams.set("videoEmbeddable", "true");
  searchUrl.searchParams.set("maxResults", String(MAX_RESULTS));
  searchUrl.searchParams.set("regionCode", "US");
  searchUrl.searchParams.set("relevanceLanguage", "en");
  searchUrl.searchParams.set("q", query);
  searchUrl.searchParams.set("key", apiKey);

  try {
    const searchResponse = await fetch(searchUrl, { cache: "no-store" });
    if (!searchResponse.ok) {
      return NextResponse.json(
        { error: "YouTube search failed" },
        { status: 502 },
      );
    }
    const payload = (await searchResponse.json()) as SearchResponse;

    const base: YouTubeSearchItem[] = [];
    for (const item of payload.items ?? []) {
      const videoId = item.id?.videoId;
      const title = item.snippet?.title;
      if (typeof videoId !== "string" || typeof title !== "string") continue;
      const thumb =
        item.snippet?.thumbnails?.medium?.url ??
        item.snippet?.thumbnails?.default?.url;
      base.push({
        videoId,
        title,
        channel:
          typeof item.snippet?.channelTitle === "string"
            ? item.snippet.channelTitle
            : "",
        thumbnail: typeof thumb === "string" ? thumb : null,
        durationSeconds: null,
        views: null,
        publishedAt:
          typeof item.snippet?.publishedAt === "string"
            ? item.snippet.publishedAt
            : null,
      });
    }

    if (base.length > 0) {
      const detailsUrl = new URL(YOUTUBE_VIDEOS_URL);
      detailsUrl.searchParams.set("part", "contentDetails,statistics");
      detailsUrl.searchParams.set("id", base.map((v) => v.videoId).join(","));
      detailsUrl.searchParams.set("key", apiKey);
      try {
        const detailsResponse = await fetch(detailsUrl, { cache: "no-store" });
        if (detailsResponse.ok) {
          const details =
            (await detailsResponse.json()) as VideoDetailsResponse;
          const byId = new Map(
            (details.items ?? [])
              .filter((item) => typeof item.id === "string")
              .map((item) => [item.id as string, item]),
          );
          for (const item of base) {
            const info = byId.get(item.videoId);
            if (!info) continue;
            item.durationSeconds = parseIsoDuration(
              info.contentDetails?.duration,
            );
            const views = Number(info.statistics?.viewCount);
            item.views = Number.isFinite(views) ? views : null;
          }
        }
      } catch {
      }
    }

    writeCache(cacheKey, base);
    return NextResponse.json({ items: base });
  } catch {
    return NextResponse.json(
      { error: "YouTube search failed" },
      { status: 502 },
    );
  }
}

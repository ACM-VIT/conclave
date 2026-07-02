// Best-effort YouTube metadata for the UI. Thumbnails come straight from the
// predictable ytimg CDN (no key, always available). Titles come from the public
// oEmbed endpoint and are strictly optional: any failure resolves to null and
// the UI falls back to the video id.

const TITLE_FETCH_TIMEOUT_MS = 2_500;

/** Medium-quality 16:9 thumbnail for a video id. */
export const thumbnailUrl = (videoId: string): string =>
  `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;

export type WatchSearchResult = {
  videoId: string;
  title: string;
  channel: string;
  thumbnail: string | null;
  durationSeconds: number | null;
  views: number | null;
  publishedAt: string | null;
};

/** 3661 -> "1:01:01", 754 -> "12:34". Null in, null out. */
export const formatDuration = (seconds: number | null): string | null => {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return null;
  const whole = Math.round(seconds);
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
};

/** 2712345 -> "2.7M views", 857000 -> "857K views". Null in, null out. */
export const formatViews = (views: number | null): string | null => {
  if (views == null || !Number.isFinite(views) || views < 0) return null;
  if (views >= 1_000_000_000)
    return `${(views / 1_000_000_000).toFixed(1).replace(/\.0$/, "")}B views`;
  if (views >= 1_000_000)
    return `${(views / 1_000_000).toFixed(1).replace(/\.0$/, "")}M views`;
  if (views >= 1_000) return `${Math.round(views / 1_000)}K views`;
  return `${views} views`;
};

/** ISO date -> "13 hours ago", "2 days ago", "3 months ago". */
export const formatAge = (publishedAt: string | null): string | null => {
  if (!publishedAt) return null;
  const then = Date.parse(publishedAt);
  if (!Number.isFinite(then)) return null;
  const diffMs = Date.now() - then;
  if (diffMs < 0) return null;
  const minutes = Math.floor(diffMs / 60_000);
  const plural = (n: number, unit: string) =>
    `${n} ${unit}${n === 1 ? "" : "s"} ago`;
  if (minutes < 60) return plural(Math.max(1, minutes), "minute");
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return plural(hours, "hour");
  const days = Math.floor(hours / 24);
  if (days < 7) return plural(days, "day");
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return plural(weeks, "week");
  const months = Math.floor(days / 30);
  if (months < 12) return plural(Math.max(1, months), "month");
  return plural(Math.floor(days / 365), "year");
};

const parseSearchItems = (payload: unknown): WatchSearchResult[] => {
  const items = (payload as { items?: unknown })?.items;
  if (!Array.isArray(items)) return [];
  const entries: readonly unknown[] = items;
  return entries.filter((item): item is WatchSearchResult => {
    if (!item || typeof item !== "object") return false;
    const record = item as Record<string, unknown>;
    return typeof record.videoId === "string" && typeof record.title === "string";
  });
};

export type WatchSearchOutcome = {
  items: WatchSearchResult[];
  /** True when the server has no YouTube key (503), so search is a feature
   * that is off rather than a query with no hits. */
  unavailable: boolean;
};

/**
 * Search YouTube through the host's server proxy (the API key stays server
 * side). Fails soft to an empty list; a 503 marks the feature as off so the
 * UI can explain instead of showing "nothing found".
 */
export const searchVideos = async (
  query: string,
): Promise<WatchSearchOutcome> => {
  if (typeof fetch !== "function" || !query.trim()) {
    return { items: [], unavailable: false };
  }
  try {
    const response = await fetch(
      `/api/youtube/search?q=${encodeURIComponent(query.trim())}`,
    );
    if (response.status === 503) return { items: [], unavailable: true };
    if (!response.ok) return { items: [], unavailable: false };
    return { items: parseSearchItems(await response.json()), unavailable: false };
  } catch {
    return { items: [], unavailable: false };
  }
};

export type TrendingPage = {
  items: WatchSearchResult[];
  nextPageToken: string | null;
  /** True when the server has no YouTube key configured (503). */
  unavailable: boolean;
};

/** A page of trending videos for the browse surface. Fails soft to empty. */
export const fetchTrending = async (
  pageToken?: string | null,
): Promise<TrendingPage> => {
  const empty: TrendingPage = { items: [], nextPageToken: null, unavailable: false };
  if (typeof fetch !== "function") return empty;
  try {
    const url = pageToken
      ? `/api/youtube/trending?pageToken=${encodeURIComponent(pageToken)}`
      : "/api/youtube/trending";
    const response = await fetch(url);
    if (response.status === 503) return { ...empty, unavailable: true };
    if (!response.ok) return empty;
    const payload = (await response.json()) as { nextPageToken?: unknown };
    return {
      items: parseSearchItems(payload),
      nextPageToken:
        typeof payload.nextPageToken === "string"
          ? payload.nextPageToken
          : null,
      unavailable: false,
    };
  } catch {
    return empty;
  }
};

/** Fetch a video's title via oEmbed. Never throws; null on any failure. */
export const fetchVideoTitle = async (
  videoId: string,
): Promise<string | null> => {
  if (typeof fetch !== "function") return null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TITLE_FETCH_TIMEOUT_MS);
    const response = await fetch(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(
        `https://www.youtube.com/watch?v=${videoId}`,
      )}&format=json`,
      { signal: controller.signal },
    );
    clearTimeout(timer);
    if (!response.ok) return null;
    const payload = (await response.json()) as { title?: unknown };
    return typeof payload.title === "string" && payload.title.trim()
      ? payload.title.trim()
      : null;
  } catch {
    return null;
  }
};

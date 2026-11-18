const TITLE_FETCH_TIMEOUT_MS = 2_500;
const METADATA_FETCH_TIMEOUT_MS = 3_000;

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

export type WatchVideoMetadata = {
  videoId: string;
  title: string;
  isLive: boolean;
  broadcastStatus: WatchBroadcastStatus;
  revalidateAfterMs: number | null;
};

type WatchBroadcastStatus =
  | "live"
  | "upcoming"
  | "none"
  | "unknown";

const isWatchBroadcastStatus = (
  value: unknown,
): value is WatchBroadcastStatus =>
  value === "live" ||
  value === "upcoming" ||
  value === "none" ||
  value === "unknown";

export const liveHintForMetadata = (
  metadata: WatchVideoMetadata | null,
): boolean | null => {
  if (metadata?.broadcastStatus === "live") return true;
  if (metadata?.broadcastStatus === "none") return false;
  return null;
};

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

export const formatViews = (views: number | null): string | null => {
  if (views == null || !Number.isFinite(views) || views < 0) return null;
  if (views >= 1_000_000_000)
    return `${(views / 1_000_000_000).toFixed(1).replace(/\.0$/, "")}B views`;
  if (views >= 1_000_000)
    return `${(views / 1_000_000).toFixed(1).replace(/\.0$/, "")}M views`;
  if (views >= 1_000) return `${Math.round(views / 1_000)}K views`;
  return `${views} views`;
};

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
  unavailable: boolean;
};

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
  unavailable: boolean;
};

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

export const fetchVideoMetadata = async (
  videoId: string,
): Promise<WatchVideoMetadata | null> => {
  if (typeof fetch !== "function" || !/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
    return null;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), METADATA_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(
      `/api/youtube/video?id=${encodeURIComponent(videoId)}`,
      { signal: controller.signal },
    );
    if (!response.ok) return null;
    const payload = (await response.json()) as Partial<WatchVideoMetadata>;
    if (
      payload.videoId !== videoId ||
      typeof payload.title !== "string" ||
      typeof payload.isLive !== "boolean" ||
      !isWatchBroadcastStatus(payload.broadcastStatus) ||
      !(
        payload.revalidateAfterMs === null ||
        (typeof payload.revalidateAfterMs === "number" &&
          Number.isFinite(payload.revalidateAfterMs) &&
          payload.revalidateAfterMs >= 1_000)
      ) ||
      payload.isLive !== (payload.broadcastStatus === "live")
    ) {
      return null;
    }
    return {
      videoId: payload.videoId,
      title: payload.title,
      isLive: payload.isLive,
      broadcastStatus: payload.broadcastStatus,
      revalidateAfterMs: payload.revalidateAfterMs,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
};

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

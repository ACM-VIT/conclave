import { getCloudflareContext } from "@opennextjs/cloudflare";
import { NextResponse } from "next/server";
import {
  type ChatLinkPreview,
  type UnfurlResponsePayload,
  getYouTubeThumbnailUrl,
  getYouTubeVideoId,
} from "../../lib/link-embeds";
import { parseUnfurlableUrl, parseUnfurlHtml } from "../../lib/unfurl-html";
import { fetchTweetPreview, getTweetIdFromUrl } from "../../lib/unfurl-tweet";

// Server-side link unfurler for chat embeds. The client hands us a URL from a
// chat message; we fetch it (so participant IPs never reach the target site),
// scrape Open Graph / Twitter-card metadata, and return a normalized preview.
//
// Production runs on Cloudflare Workers with `global_fetch_strictly_public`,
// which hard-blocks fetches that resolve to private addresses. The hostname
// checks in parseUnfurlableUrl are the equivalent guard for `next dev`.

const FETCH_TIMEOUT_MS = 6_000;
const MAX_HTML_BYTES = 512 * 1024;
const USER_AGENT =
  "Mozilla/5.0 (compatible; ConclaveLinkPreview/1.0; +https://conclave.acmvit.in)";

// Found metadata is stable; misses retry sooner in case the page was flaky.
const HIT_CACHE_CONTROL =
  "public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400";
const MISS_CACHE_CONTROL = "public, max-age=300, s-maxage=900";

const RATE_LIMIT = 30;
const RATE_WINDOW_MS = 60_000;

type CloudflareRateLimitBinding = {
  limit(options: { key: string }): Promise<{ success: boolean }>;
};

type LocalRateLimitBucket = { windowStartedAt: number; count: number };
const localBuckets = new Map<string, LocalRateLimitBucket>();
const MAX_LOCAL_BUCKETS = 1_000;

const clientKey = (request: Request): string => {
  const forwardedFor = request.headers
    .get("x-forwarded-for")
    ?.split(",")
    .at(0)
    ?.trim();
  const candidate =
    [
      request.headers.get("cf-connecting-ip")?.trim(),
      request.headers.get("x-real-ip")?.trim(),
      forwardedFor,
      request.headers.get("user-agent")?.trim(),
    ].find((value): value is string => Boolean(value)) ?? "anonymous";
  return candidate.slice(0, 128);
};

const takeLocalRateLimit = (key: string): boolean => {
  const now = Date.now();
  const bucket = localBuckets.get(key);
  if (!bucket || now - bucket.windowStartedAt >= RATE_WINDOW_MS) {
    localBuckets.set(key, { windowStartedAt: now, count: 1 });
    while (localBuckets.size > MAX_LOCAL_BUCKETS) {
      const oldest = localBuckets.keys().next().value;
      if (oldest === undefined) break;
      localBuckets.delete(oldest);
    }
    return true;
  }
  if (bucket.count >= RATE_LIMIT) return false;
  bucket.count += 1;
  return true;
};

type RateLimitOutcome = { ok: true } | { ok: false; status: 429 | 503 };

const takeUnfurlRateLimit = async (request: Request): Promise<RateLimitOutcome> => {
  const key = `unfurl:${clientKey(request)}`;

  let limiter: CloudflareRateLimitBinding | null = null;
  try {
    const { env } = await getCloudflareContext({ async: true });
    const binding = (env as { UNFURL_RATE_LIMITER?: CloudflareRateLimitBinding })
      .UNFURL_RATE_LIMITER;
    limiter = binding && typeof binding.limit === "function" ? binding : null;
  } catch {
    limiter = null;
  }

  if (limiter) {
    try {
      const { success } = await limiter.limit({ key });
      return success ? { ok: true } : { ok: false, status: 429 };
    } catch {
      // Fall through to the fail-closed production branch below.
    }
  }

  if (process.env.NODE_ENV === "production") {
    // An unfurler is an outbound-fetch proxy; never run it unmetered.
    return { ok: false, status: 503 };
  }

  return takeLocalRateLimit(key) ? { ok: true } : { ok: false, status: 429 };
};

// Reads at most `maxBytes` of the body, stopping early once the document head
// has closed — everything the parser wants lives there on real pages.
const readHtmlPrefix = async (
  response: Response,
  maxBytes: number,
): Promise<string> => {
  const body = response.body;
  if (!body) return "";
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let html = "";
  let receivedBytes = 0;
  try {
    while (receivedBytes < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      receivedBytes += value.byteLength;
      html += decoder.decode(value, { stream: true });
      if (html.includes("</head")) break;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return html + decoder.decode();
};

const IMAGE_CONTENT_TYPE_PATTERN =
  /^image\/(?:png|jpeg|gif|webp|avif|svg\+xml)\b/i;

// YouTube's watch pages are bot-gated and scrape to nothing; its public
// oEmbed endpoint returns the title/author/thumbnail without an API key.
const fetchYouTubePreview = async (
  target: URL,
  videoId: string,
): Promise<ChatLinkPreview | null> => {
  let parsed: unknown;
  try {
    const response = await fetch(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(target.href)}&format=json`,
      {
        headers: { accept: "application/json", "user-agent": USER_AGENT },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        cache: "no-store",
      },
    );
    if (!response.ok) {
      response.body?.cancel().catch(() => {});
      return null;
    }
    parsed = await response.json();
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const payload = parsed as { title?: unknown; author_name?: unknown; thumbnail_url?: unknown };

  const title = typeof payload.title === "string" ? payload.title : undefined;
  if (!title) return null;
  return {
    url: target.href,
    kind: "page",
    siteName: "YouTube",
    title,
    description:
      typeof payload.author_name === "string" ? payload.author_name : undefined,
    imageUrl:
      typeof payload.thumbnail_url === "string"
        ? payload.thumbnail_url
        : getYouTubeThumbnailUrl(videoId),
    faviconUrl: "https://www.youtube.com/favicon.ico",
    imageLayout: "large",
  };
};

const fetchPreview = async (target: URL): Promise<ChatLinkPreview | null> => {
  // Tweet links can't be scraped (X serves an empty JS shell); the
  // syndication CDN returns the tweet with its media instead. On failure we
  // still try the generic scrape below rather than giving up outright.
  const tweetId = getTweetIdFromUrl(target);
  if (tweetId) {
    const tweetPreview = await fetchTweetPreview(tweetId, FETCH_TIMEOUT_MS);
    if (tweetPreview) return tweetPreview;
  }

  const youTubeVideoId = getYouTubeVideoId(target.href);
  if (youTubeVideoId) {
    const youTubePreview = await fetchYouTubePreview(target, youTubeVideoId);
    if (youTubePreview) return youTubePreview;
  }

  let response: Response;
  try {
    response = await fetch(target, {
      headers: {
        accept: "text/html,application/xhtml+xml;q=0.9,image/*;q=0.8,*/*;q=0.5",
        "accept-language": "en",
        "user-agent": USER_AGENT,
      },
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch {
    return null;
  }

  // Redirects may land anywhere; re-run the same safety checks on the final
  // URL before touching the body or echoing it back to clients.
  const finalUrl = parseUnfurlableUrl(response.url || target.href);
  if (!finalUrl || !response.ok) {
    response.body?.cancel().catch(() => {});
    return null;
  }

  const contentType = response.headers.get("content-type") ?? "";

  if (IMAGE_CONTENT_TYPE_PATTERN.test(contentType)) {
    response.body?.cancel().catch(() => {});
    return {
      url: finalUrl.href,
      kind: "image",
      imageUrl: finalUrl.href,
      siteName: finalUrl.hostname.replace(/^www\./, ""),
    };
  }

  if (!/^(?:text\/html|application\/xhtml\+xml)\b/i.test(contentType)) {
    response.body?.cancel().catch(() => {});
    return null;
  }

  let html: string;
  try {
    html = await readHtmlPrefix(response, MAX_HTML_BYTES);
  } catch {
    return null;
  }

  const metadata = parseUnfurlHtml(html, finalUrl);
  if (!metadata.title && !metadata.description && !metadata.imageUrl) {
    return null;
  }

  return {
    url: finalUrl.href,
    kind: "page",
    siteName: metadata.siteName ?? finalUrl.hostname.replace(/^www\./, ""),
    title: metadata.title,
    description: metadata.description,
    imageUrl: metadata.imageUrl,
    faviconUrl: metadata.faviconUrl,
    imageLayout: metadata.imageLayout,
  };
};

const previewResponse = (
  payload: UnfurlResponsePayload,
  init?: { status?: number; cacheControl?: string },
): Response =>
  NextResponse.json(payload, {
    status: init?.status ?? 200,
    headers: {
      "Cache-Control":
        init?.cacheControl ??
        (payload.preview ? HIT_CACHE_CONTROL : MISS_CACHE_CONTROL),
    },
  });

// workerd exposes the Cache API; `next dev` on Node does not. Cache hits are
// shared across every participant who unfurls the same link and are served
// before the rate limiter, so popular links stay cheap for everyone.
const getEdgeCache = (): Cache | null =>
  (globalThis as { caches?: { default?: Cache } }).caches?.default ?? null;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const target = parseUnfurlableUrl(searchParams.get("url") ?? "");
  if (!target) {
    return previewResponse(
      { preview: null },
      { status: 400, cacheControl: "no-store" },
    );
  }

  const cacheKey = new Request(
    new URL(
      `/api/unfurl?url=${encodeURIComponent(target.href)}`,
      request.url,
    ).href,
  );
  const edgeCache = getEdgeCache();
  if (edgeCache) {
    try {
      const cached = await edgeCache.match(cacheKey);
      if (cached) return cached;
    } catch {
      // Cache API hiccups must never take down unfurling.
    }
  }

  const rateLimit = await takeUnfurlRateLimit(request);
  if (!rateLimit.ok) {
    return previewResponse(
      { preview: null },
      { status: rateLimit.status, cacheControl: "no-store" },
    );
  }

  const preview = await fetchPreview(target);
  const response = previewResponse({ preview });

  if (edgeCache) {
    try {
      await edgeCache.put(cacheKey, response.clone());
    } catch {
      // Same: caching is best-effort.
    }
  }

  return response;
}

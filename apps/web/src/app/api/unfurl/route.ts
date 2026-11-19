import { NextResponse } from "next/server";
import {
  type ChatLinkPreview,
  type UnfurlResponsePayload,
  getYouTubeThumbnailUrl,
  getYouTubeVideoId,
} from "../../lib/link-embeds";
import { toUnfurlAssetUrl } from "../../lib/unfurl-assets";
import { fetchUnfurlResource } from "../../lib/unfurl-fetch";
import { parseUnfurlableUrl, parseUnfurlHtml } from "../../lib/unfurl-html";
import { takeUnfurlRateLimit } from "../../lib/unfurl-rate-limit";
import { readHtmlPrefix } from "../../lib/unfurl-response";
import { fetchTweetPreview, getTweetIdFromUrl } from "../../lib/unfurl-tweet";

const FETCH_TIMEOUT_MS = 6_000;
const MAX_HTML_BYTES = 512 * 1024;
const USER_AGENT =
  "Mozilla/5.0 (compatible; ConclaveLinkPreview/1.0; +https://conclave.acmvit.in)";

const HIT_CACHE_CONTROL =
  "private, max-age=3600, stale-while-revalidate=3600";
const MISS_CACHE_CONTROL = "private, max-age=300";

const IMAGE_CONTENT_TYPE_PATTERN =
  /^image\/(?:png|jpeg|gif|webp|avif|svg\+xml)\b/i;

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
    imageUrl: toUnfurlAssetUrl(
      typeof payload.thumbnail_url === "string"
        ? payload.thumbnail_url
        : getYouTubeThumbnailUrl(videoId),
    ),
    faviconUrl: toUnfurlAssetUrl("https://www.youtube.com/favicon.ico"),
    imageLayout: "large",
  };
};

const fetchPreview = async (target: URL): Promise<ChatLinkPreview | null> => {
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

  let fetched: Awaited<ReturnType<typeof fetchUnfurlResource>>;
  try {
    fetched = await fetchUnfurlResource(target, {
      headers: {
        accept: "text/html,application/xhtml+xml;q=0.9,image/*;q=0.8,*/*;q=0.5",
        "accept-language": "en",
        "user-agent": USER_AGENT,
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch {
    return null;
  }
  if (!fetched) return null;
  const { response, finalUrl } = fetched;
  if (!response.ok) {
    response.body?.cancel().catch(() => {});
    return null;
  }

  const contentType = response.headers.get("content-type") ?? "";

  if (IMAGE_CONTENT_TYPE_PATTERN.test(contentType)) {
    response.body?.cancel().catch(() => {});
    return {
      url: finalUrl.href,
      kind: "image",
      imageUrl: toUnfurlAssetUrl(finalUrl.href),
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
    imageUrl: toUnfurlAssetUrl(metadata.imageUrl),
    faviconUrl: toUnfurlAssetUrl(metadata.faviconUrl),
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

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const target = parseUnfurlableUrl(searchParams.get("url") ?? "");
  if (!target) {
    return previewResponse(
      { preview: null },
      { status: 400, cacheControl: "no-store" },
    );
  }

  const rateLimit = await takeUnfurlRateLimit(request);
  if (!rateLimit.ok) {
    return previewResponse(
      { preview: null },
      { status: rateLimit.status, cacheControl: "no-store" },
    );
  }

  const preview = await fetchPreview(target);
  return previewResponse({ preview });
}

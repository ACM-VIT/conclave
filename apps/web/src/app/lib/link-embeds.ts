// Client-side plumbing for chat link embeds: which URLs in a message deserve
// a preview card, YouTube detection for the inline player, and a session-wide
// cache in front of /api/unfurl so every message, remount, and duplicate link
// costs at most one request.

export type ChatLinkPreviewKind = "page" | "image" | "tweet";

export interface ChatLinkTweetMedia {
  kind: "photo" | "video" | "gif";
  /** Photo URL, or the poster frame for videos and gifs. */
  url: string;
  /** Direct mp4 for videos and gifs. */
  videoUrl?: string;
  width?: number;
  height?: number;
}

export interface ChatLinkTweetData {
  authorName: string;
  /** Without the leading @. */
  authorHandle: string;
  authorAvatarUrl?: string;
  text: string;
  media: ChatLinkTweetMedia[];
  createdAt?: number;
}

export interface ChatLinkPreview {
  /** Final URL after redirects — what the embed card links to. */
  url: string;
  kind: ChatLinkPreviewKind;
  siteName?: string;
  title?: string;
  description?: string;
  imageUrl?: string;
  faviconUrl?: string;
  imageLayout?: "large" | "thumb";
  /** Present when kind is "tweet"; clients without tweet support can fall
   * back to the generic title/description/imageUrl fields above. */
  tweet?: ChatLinkTweetData;
}

export interface UnfurlResponsePayload {
  preview: ChatLinkPreview | null;
}

export const MAX_EMBEDS_PER_MESSAGE = 2;

// Only unfurl links the sender typed explicitly as links ("https://…" or
// "www.…"). Bare domains like "vercel.com" still linkify in the message text
// but don't embed — mid-sentence mentions would otherwise spam cards.
const EMBED_URL_PATTERN = /(?:https?:\/\/|www\.)[^\s<>]+/gi;

/**
 * Returns the embeddable URLs of a chat message, deduped and capped. Wrapping
 * a link in angle brackets ("<https://…>") suppresses its embed, mirroring
 * the convention chat power users expect.
 */
export function extractEmbedUrls(
  content: string,
  max: number = MAX_EMBEDS_PER_MESSAGE,
): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();

  for (const match of content.matchAll(EMBED_URL_PATTERN)) {
    if (urls.length >= max) break;
    const index = match.index ?? -1;
    if (index < 0) continue;

    // Same trailing-punctuation trim as the message linkifier, so the embed
    // fetches exactly the URL the text renders as a link.
    const trimmed = match[0].replace(/[),.!?;:]+$/, "");
    if (!trimmed || trimmed.includes("@")) continue;

    const followingChar = content[index + match[0].length];
    if (content[index - 1] === "<" && followingChar === ">") continue;

    const href = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    let normalized: string;
    try {
      normalized = new URL(href).href;
    } catch {
      continue;
    }
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    urls.push(normalized);
  }

  return urls;
}

const YOUTUBE_VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

/** Extracts a YouTube video id from watch/shorts/live/embed/youtu.be URLs. */
export function getYouTubeVideoId(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  let candidate: string | undefined;

  if (host === "youtu.be") {
    candidate = url.pathname.split("/")[1];
  } else if (host === "youtube.com" || host === "m.youtube.com" || host === "music.youtube.com") {
    const [, first, second] = url.pathname.split("/");
    if (first === "watch") {
      candidate = url.searchParams.get("v") ?? undefined;
    } else if (first === "shorts" || first === "live" || first === "embed") {
      candidate = second;
    }
  }

  return candidate && YOUTUBE_VIDEO_ID_PATTERN.test(candidate) ? candidate : null;
}

export const getYouTubeThumbnailUrl = (videoId: string): string =>
  `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

export const getYouTubeEmbedUrl = (videoId: string): string =>
  `https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1&rel=0`;

// Resolved previews (including nulls — "this URL has no card") are kept for
// the whole session; chat history remounts constantly and must not refetch.
const previewCache = new Map<string, Promise<ChatLinkPreview | null>>();

export function fetchChatLinkPreview(url: string): Promise<ChatLinkPreview | null> {
  let pending = previewCache.get(url);
  if (!pending) {
    pending = (async (): Promise<ChatLinkPreview | null> => {
      const response = await fetch(`/api/unfurl?url=${encodeURIComponent(url)}`);
      if (!response.ok) return null;
      const payload = (await response.json()) as UnfurlResponsePayload;
      return payload?.preview ?? null;
    })().catch(() => null);
    previewCache.set(url, pending);
  }
  return pending;
}

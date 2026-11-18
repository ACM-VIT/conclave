export type ChatLinkPreviewKind = "page" | "image" | "tweet";

export interface ChatLinkTweetMedia {
  kind: "photo" | "video" | "gif";
  url: string;
  videoUrl?: string;
  width?: number;
  height?: number;
}

export interface ChatLinkTweetData {
  authorName: string;
  authorHandle: string;
  authorAvatarUrl?: string;
  text: string;
  media: ChatLinkTweetMedia[];
  createdAt?: number;
}

export interface ChatLinkPreview {
  url: string;
  kind: ChatLinkPreviewKind;
  siteName?: string;
  title?: string;
  description?: string;
  imageUrl?: string;
  faviconUrl?: string;
  imageLayout?: "large" | "thumb";
  tweet?: ChatLinkTweetData;
}

export interface UnfurlResponsePayload {
  preview: ChatLinkPreview | null;
}

export const MAX_EMBEDS_PER_MESSAGE = 2;

const EMBED_URL_PATTERN = /(?:https?:\/\/|www\.)[^\s<>]+/gi;

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

const previewCache = new Map<string, Promise<ChatLinkPreview | null>>();

export function fetchChatLinkPreview(url: string): Promise<ChatLinkPreview | null> {
  let pending = previewCache.get(url);
  if (!pending) {
    pending = (async (): Promise<ChatLinkPreview | null> => {
      const response = await fetch(`/api/unfurl?url=${encodeURIComponent(url)}`);
      if (!response.ok) {
        throw new Error(`Unfurl failed with ${response.status}`);
      }
      const payload = (await response.json()) as UnfurlResponsePayload;
      return payload?.preview ?? null;
    })().catch(() => {
      previewCache.delete(url);
      return null;
    });
    previewCache.set(url, pending);
  }
  return pending;
}

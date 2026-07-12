// Tweet unfurling for the /api/unfurl route. X/Twitter pages are a JS shell
// with no Open Graph tags for generic scrapers, so tweet links go through the
// public syndication CDN (the same unauthenticated endpoint react-tweet and
// the official embed widget use). It returns tweet text, author, photos, and
// mp4 variants — everything the chat card needs to show real media. Any
// failure falls back to the generic HTML scrape, which degrades to no embed.

import type {
  ChatLinkPreview,
  ChatLinkTweetData,
  ChatLinkTweetMedia,
} from "./link-embeds";

const TWEET_HOSTS = new Set([
  "twitter.com",
  "www.twitter.com",
  "mobile.twitter.com",
  "m.twitter.com",
  "x.com",
  "www.x.com",
  "mobile.x.com",
]);

const TWEET_ID_PATTERN = /^\d{1,25}$/;
const MAX_TWEET_TEXT_LENGTH = 500;
const MAX_TWEET_MEDIA = 4;

/** Extracts the tweet id from …/status/<id> URLs (incl. /i/web/status). */
export function getTweetIdFromUrl(url: URL): string | null {
  if (!TWEET_HOSTS.has(url.hostname.toLowerCase())) return null;
  const segments = url.pathname.split("/").filter(Boolean);
  const statusIndex = segments.findIndex(
    (segment) => segment === "status" || segment === "statuses",
  );
  if (statusIndex === -1) return null;
  const id = segments[statusIndex + 1] ?? "";
  return TWEET_ID_PATTERN.test(id) ? id : null;
}

// The syndication endpoint requires a token derived from the tweet id; this
// is the exact formula the official widget computes client-side.
export function getSyndicationToken(tweetId: string): string {
  return ((Number(tweetId) / 1e15) * Math.PI)
    .toString(36)
    .replace(/(0+|\.)/g, "");
}

const SYNDICATION_FEATURES = [
  "tfw_timeline_list:",
  "tfw_follower_count_sunset:true",
  "tfw_tweet_edit_backend:on",
  "tfw_refsrc_session:on",
  "tfw_fosnr_soft_interventions_enabled:on",
  "tfw_show_birdwatch_pivots_enabled:on",
  "tfw_show_business_verified_badge:on",
  "tfw_duplicate_scribes_to_settings:on",
  "tfw_use_profile_image_shape_enabled:on",
  "tfw_show_blue_verified_badge:on",
  "tfw_legacy_timeline_sunset:true",
  "tfw_show_gov_verified_badge:on",
  "tfw_show_business_affiliate_badge:on",
  "tfw_tweet_edit_frontend:on",
].join(";");

export function getSyndicationUrl(tweetId: string): string {
  const url = new URL("https://cdn.syndication.twimg.com/tweet-result");
  url.searchParams.set("id", tweetId);
  url.searchParams.set("lang", "en");
  url.searchParams.set("features", SYNDICATION_FEATURES);
  url.searchParams.set("token", getSyndicationToken(tweetId));
  return url.href;
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const asString = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value : null;

const asMediaUrl = (value: unknown): string | null => {
  const raw = asString(value);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
};

const asDimension = (value: unknown): number | undefined => {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.round(value);
};

// Photos render at card width; ask pbs.twimg.com for the "small" rendition
// instead of the multi-megabyte original.
const smallPhotoUrl = (url: string): string =>
  `${url}${url.includes("?") ? "&" : "?"}name=small`;

interface RawVideoVariant {
  bitrate?: unknown;
  content_type?: unknown;
  url?: unknown;
}

// Chat cards are ~280px wide; the middle mp4 rendition is plenty.
const pickMp4Variant = (variants: unknown): string | null => {
  if (!Array.isArray(variants)) return null;
  const mp4s = variants
    .map((variant) => variant as RawVideoVariant)
    .filter((variant) => asString(variant.content_type) === "video/mp4")
    .map((variant) => ({
      bitrate: typeof variant.bitrate === "number" ? variant.bitrate : 0,
      url: asMediaUrl(variant.url),
    }))
    .filter((variant): variant is { bitrate: number; url: string } =>
      Boolean(variant.url),
    )
    .sort((left, right) => left.bitrate - right.bitrate);
  if (mp4s.length === 0) return null;
  return mp4s[Math.floor(mp4s.length / 2)].url;
};

const parseMediaDetails = (value: unknown): ChatLinkTweetMedia[] => {
  if (!Array.isArray(value)) return [];
  const media: ChatLinkTweetMedia[] = [];

  for (const entry of value) {
    if (media.length >= MAX_TWEET_MEDIA) break;
    const detail = asRecord(entry);
    if (!detail) continue;
    const type = asString(detail.type);
    const stillUrl = asMediaUrl(detail.media_url_https);
    if (!stillUrl) continue;
    const originalInfo = asRecord(detail.original_info);
    const width = asDimension(originalInfo?.width);
    const height = asDimension(originalInfo?.height);

    if (type === "photo") {
      media.push({ kind: "photo", url: smallPhotoUrl(stillUrl), width, height });
      continue;
    }
    if (type === "video" || type === "animated_gif") {
      const videoInfo = asRecord(detail.video_info);
      const videoUrl = pickMp4Variant(videoInfo?.variants);
      if (!videoUrl) continue;
      const aspect = Array.isArray(videoInfo?.aspect_ratio)
        ? (videoInfo.aspect_ratio as unknown[])
        : [];
      media.push({
        kind: type === "video" ? "video" : "gif",
        url: stillUrl,
        videoUrl,
        width: asDimension(aspect[0]) ?? width,
        height: asDimension(aspect[1]) ?? height,
      });
    }
  }

  return media;
};

// Older payload shape: `photos` + `video` at the top level. Used only when
// `mediaDetails` is absent.
const parseLegacyMedia = (tweet: Record<string, unknown>): ChatLinkTweetMedia[] => {
  const media: ChatLinkTweetMedia[] = [];

  if (Array.isArray(tweet.photos)) {
    for (const entry of tweet.photos) {
      if (media.length >= MAX_TWEET_MEDIA) break;
      const photo = asRecord(entry);
      const url = asMediaUrl(photo?.url);
      if (!url) continue;
      media.push({
        kind: "photo",
        url: smallPhotoUrl(url),
        width: asDimension(photo?.width),
        height: asDimension(photo?.height),
      });
    }
  }

  const video = asRecord(tweet.video);
  if (video) {
    const poster = asMediaUrl(video.poster);
    const variants = Array.isArray(video.variants)
      ? video.variants.map((variant) => {
          const record = asRecord(variant);
          return {
            content_type: record?.type,
            url: record?.src,
          };
        })
      : [];
    const videoUrl = pickMp4Variant(variants);
    if (poster && videoUrl) {
      const aspect = Array.isArray(video.aspectRatio)
        ? (video.aspectRatio as unknown[])
        : [];
      media.push({
        kind: "video",
        url: poster,
        videoUrl,
        width: asDimension(aspect[0]),
        height: asDimension(aspect[1]),
      });
    }
  }

  return media;
};

interface RawUrlEntity {
  url?: unknown;
  display_url?: unknown;
}

const cleanTweetText = (tweet: Record<string, unknown>): string => {
  const rawText = asString(tweet.text) ?? "";
  // Ranges are in Unicode code points; slice accordingly so emoji-heavy
  // tweets don't get cut mid-surrogate.
  const codePoints = Array.from(rawText);
  const range = Array.isArray(tweet.display_text_range)
    ? (tweet.display_text_range as unknown[])
    : null;
  const start =
    typeof range?.[0] === "number" && range[0] >= 0 ? range[0] : 0;
  const end =
    typeof range?.[1] === "number" && range[1] <= codePoints.length
      ? range[1]
      : codePoints.length;
  let text = codePoints.slice(start, end).join("");

  // Swap remaining t.co wrappers for their human-readable display form.
  const entities = asRecord(tweet.entities);
  if (Array.isArray(entities?.urls)) {
    for (const entry of entities.urls) {
      const urlEntity = entry as RawUrlEntity;
      const shortUrl = asString(urlEntity.url);
      const displayUrl = asString(urlEntity.display_url);
      if (shortUrl && displayUrl) {
        text = text.replaceAll(shortUrl, displayUrl);
      }
    }
  }
  // Trailing media t.co links (present when display_text_range is absent).
  // Tweets from the http era wrap media as http://t.co/…, hence https?.
  text = text.replace(/(?:\s*https?:\/\/t\.co\/\w+)+\s*$/, "");

  text = text.trim();
  return text.length > MAX_TWEET_TEXT_LENGTH
    ? `${text.slice(0, MAX_TWEET_TEXT_LENGTH - 1)}…`
    : text;
};

/**
 * Maps a syndication `tweet-result` payload onto a chat link preview.
 * Returns null for tombstones (deleted/protected) and unrecognized shapes.
 */
export function parseTweetResult(
  payload: unknown,
  requestedId: string,
): ChatLinkPreview | null {
  const tweet = asRecord(payload);
  if (!tweet) return null;
  const typename = asString(tweet.__typename);
  if (typename && typename !== "Tweet") return null;

  const user = asRecord(tweet.user);
  const authorName = asString(user?.name);
  const authorHandle = asString(user?.screen_name);
  if (!authorName || !authorHandle) return null;

  const media =
    "mediaDetails" in tweet
      ? parseMediaDetails(tweet.mediaDetails)
      : parseLegacyMedia(tweet);
  const text = cleanTweetText(tweet);
  if (!text && media.length === 0) return null;

  const tweetId = asString(tweet.id_str) ?? requestedId;
  const canonicalUrl = `https://x.com/${authorHandle}/status/${tweetId}`;
  const avatarUrl = asMediaUrl(user?.profile_image_url_https) ?? undefined;
  const createdAt = asString(tweet.created_at);
  const createdAtMs = createdAt ? Date.parse(createdAt) : Number.NaN;

  const data: ChatLinkTweetData = {
    authorName,
    authorHandle,
    ...(avatarUrl ? { authorAvatarUrl: avatarUrl } : {}),
    text,
    media,
    ...(Number.isFinite(createdAtMs) ? { createdAt: createdAtMs } : {}),
  };

  const firstMedia = media[0];
  return {
    url: canonicalUrl,
    kind: "tweet",
    siteName: "X",
    title: `${authorName} (@${authorHandle})`,
    description: text || undefined,
    imageUrl: firstMedia?.url ?? avatarUrl,
    faviconUrl: "https://abs.twimg.com/favicons/twitter.3.ico",
    imageLayout: firstMedia ? "large" : "thumb",
    tweet: data,
  };
}

/** Fetches and parses a tweet; null means "use the generic unfurl path". */
export async function fetchTweetPreview(
  tweetId: string,
  timeoutMs: number,
): Promise<ChatLinkPreview | null> {
  let response: Response;
  try {
    response = await fetch(getSyndicationUrl(tweetId), {
      headers: {
        accept: "application/json",
        "user-agent":
          "Mozilla/5.0 (compatible; ConclaveLinkPreview/1.0; +https://conclave.acmvit.in)",
      },
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
  } catch {
    return null;
  }
  if (!response.ok) {
    response.body?.cancel().catch(() => {});
    return null;
  }
  try {
    return parseTweetResult(await response.json(), tweetId);
  } catch {
    return null;
  }
}

"use client";

import { Link as LinkIcon, Play, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  type ChatLinkPreview,
  type ChatLinkTweetData,
  type ChatLinkTweetMedia,
  fetchChatLinkPreview,
  getYouTubeEmbedUrl,
  getYouTubeThumbnailUrl,
  getYouTubeVideoId,
} from "../lib/link-embeds";

interface ChatLinkEmbedViewProps {
  url: string;
}

// Sentinel for "unfurl in flight" so a null result ("no preview available")
// can collapse the embed without a loading flash for links that never embed.
const LOADING = Symbol("loading");

const CARD_CLASS =
  "block w-[280px] max-w-full overflow-hidden rounded-[16px] border border-white/10 bg-white/[0.04] transition-colors hover:border-white/20 hover:bg-white/[0.06]";

function SiteRow({
  preview,
  fallbackHost,
}: {
  preview: ChatLinkPreview | null;
  fallbackHost: string;
}) {
  const [faviconFailed, setFaviconFailed] = useState(false);
  const siteName = preview?.siteName ?? fallbackHost;
  if (!siteName) return null;

  return (
    <span className="flex min-w-0 items-center gap-1.5">
      {preview?.faviconUrl && !faviconFailed ? (
        <img
          src={preview.faviconUrl}
          alt=""
          aria-hidden="true"
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setFaviconFailed(true)}
          className="h-3.5 w-3.5 shrink-0 rounded-[3px] object-contain"
        />
      ) : null}
      <span className="truncate text-[11px] text-[#a1a1aa]">{siteName}</span>
    </span>
  );
}

function YouTubeEmbed({
  url,
  videoId,
  preview,
}: {
  url: string;
  videoId: string;
  preview: ChatLinkPreview | null;
}) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [thumbnailFailed, setThumbnailFailed] = useState(false);
  const title = preview?.title ?? "Watch on YouTube";
  const thumbnailUrl = preview?.imageUrl ?? getYouTubeThumbnailUrl(videoId);

  return (
    <div className={CARD_CLASS}>
      <a
        href={preview?.url ?? url}
        target="_blank"
        rel="noopener noreferrer"
        className="block px-3 pb-2 pt-2.5"
      >
        <SiteRow preview={preview} fallbackHost="YouTube" />
        <span className="mt-0.5 line-clamp-2 block text-[12.5px] font-medium leading-snug text-[#fafafa]">
          {title}
        </span>
      </a>
      <div className="relative aspect-video w-full bg-black/40">
        {isPlaying ? (
          <iframe
            src={getYouTubeEmbedUrl(videoId)}
            title={title}
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
            allowFullScreen
            className="absolute inset-0 h-full w-full border-0"
          />
        ) : (
          <button
            type="button"
            onClick={() => setIsPlaying(true)}
            aria-label={`Play video: ${title}`}
            className="group/play absolute inset-0 h-full w-full cursor-pointer"
          >
            {!thumbnailFailed ? (
              <img
                src={thumbnailUrl}
                alt=""
                aria-hidden="true"
                loading="lazy"
                referrerPolicy="no-referrer"
                onError={() => setThumbnailFailed(true)}
                className="absolute inset-0 h-full w-full object-cover"
              />
            ) : null}
            <span className="absolute inset-0 flex items-center justify-center">
              <span className="flex h-11 w-11 items-center justify-center rounded-full bg-[#F95F4A] text-white transition-transform group-hover/play:scale-105">
                <Play size={18} strokeWidth={2} fill="currentColor" />
              </span>
            </span>
          </button>
        )}
      </div>
    </div>
  );
}

function TweetPhotoCell({
  media,
  className = "",
}: {
  media: ChatLinkTweetMedia;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return <span className={`block h-full w-full bg-white/[0.04] ${className}`} />;
  }
  return (
    <img
      src={media.url}
      alt="Tweet photo"
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className={`h-full w-full object-cover ${className}`}
    />
  );
}

// A tweet carries at most one video (or animated gif); gifs autoplay muted on
// loop the way X renders them, real videos are click-to-play with controls.
function TweetVideoView({
  media,
  label,
}: {
  media: ChatLinkTweetMedia;
  label: string;
}) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [posterFailed, setPosterFailed] = useState(false);
  const hasAutoStartedRef = useRef(false);
  const aspectRatio =
    media.width && media.height ? `${media.width} / ${media.height}` : "16 / 9";

  // Kick playback off inside the click's user-activation window (the swap
  // commits synchronously for discrete events) instead of trusting the
  // autoplay attribute; retry muted if unmuted playback is denied.
  const startPlayback = (video: HTMLVideoElement | null) => {
    if (!video || hasAutoStartedRef.current) return;
    hasAutoStartedRef.current = true;
    video.play().catch(() => {
      video.muted = true;
      video.play().catch(() => {});
    });
  };

  if (media.kind === "gif") {
    return (
      <div
        className="relative max-h-[320px] w-full bg-black/40"
        style={{ aspectRatio }}
      >
        <video
          src={media.videoUrl}
          poster={media.url}
          muted
          loop
          autoPlay
          playsInline
          preload="metadata"
          aria-label={label}
          className="absolute inset-0 h-full w-full object-contain"
        />
        <span className="absolute bottom-1.5 left-1.5 rounded bg-black/60 px-1 py-0.5 text-[10px] font-semibold leading-none text-white">
          GIF
        </span>
      </div>
    );
  }

  return (
    <div
      className="relative max-h-[320px] w-full bg-black/40"
      style={{ aspectRatio }}
    >
      {isPlaying ? (
        <video
          ref={startPlayback}
          src={media.videoUrl}
          poster={media.url}
          controls
          autoPlay
          playsInline
          preload="metadata"
          aria-label={label}
          className="absolute inset-0 h-full w-full object-contain"
        />
      ) : (
        <button
          type="button"
          onClick={() => setIsPlaying(true)}
          aria-label={`Play ${label}`}
          className="group/play absolute inset-0 h-full w-full cursor-pointer"
        >
          {!posterFailed ? (
            <img
              src={media.url}
              alt=""
              aria-hidden="true"
              loading="lazy"
              referrerPolicy="no-referrer"
              onError={() => setPosterFailed(true)}
              className="absolute inset-0 h-full w-full object-cover"
            />
          ) : null}
          <span className="absolute inset-0 flex items-center justify-center">
            <span className="flex h-11 w-11 items-center justify-center rounded-full bg-[#F95F4A] text-white transition-transform group-hover/play:scale-105">
              <Play size={18} strokeWidth={2} fill="currentColor" />
            </span>
          </span>
        </button>
      )}
    </div>
  );
}

function TweetPhotoGrid({ photos }: { photos: ChatLinkTweetMedia[] }) {
  if (photos.length === 1) {
    const [photo] = photos;
    const aspectRatio =
      photo.width && photo.height
        ? `${photo.width} / ${photo.height}`
        : undefined;
    return (
      <div
        className={`w-full overflow-hidden bg-black/25 ${
          aspectRatio ? "max-h-[240px]" : "h-[160px]"
        }`}
        style={aspectRatio ? { aspectRatio } : undefined}
      >
        <TweetPhotoCell media={photo} />
      </div>
    );
  }
  if (photos.length === 2) {
    return (
      <div className="grid h-[140px] grid-cols-2 gap-px bg-black/25">
        {photos.map((photo) => (
          <TweetPhotoCell key={photo.url} media={photo} />
        ))}
      </div>
    );
  }
  if (photos.length === 3) {
    return (
      <div className="grid h-[186px] grid-cols-2 grid-rows-2 gap-px bg-black/25">
        <TweetPhotoCell media={photos[0]} className="row-span-2" />
        <TweetPhotoCell media={photos[1]} />
        <TweetPhotoCell media={photos[2]} />
      </div>
    );
  }
  return (
    <div className="grid h-[186px] grid-cols-2 grid-rows-2 gap-px bg-black/25">
      {photos.slice(0, 4).map((photo) => (
        <TweetPhotoCell key={photo.url} media={photo} />
      ))}
    </div>
  );
}

function TweetEmbed({
  preview,
  tweet,
}: {
  preview: ChatLinkPreview;
  tweet: ChatLinkTweetData;
}) {
  const [avatarFailed, setAvatarFailed] = useState(false);
  const video = tweet.media.find(
    (media) => media.kind === "video" || media.kind === "gif",
  );
  const photos = tweet.media.filter((media) => media.kind === "photo");
  const timeLabel = tweet.createdAt
    ? new Date(tweet.createdAt).toLocaleDateString([], {
        month: "short",
        day: "numeric",
      })
    : null;

  return (
    <div className={CARD_CLASS}>
      <a
        href={preview.url}
        target="_blank"
        rel="noopener noreferrer"
        className="block px-3 pb-2 pt-2.5"
      >
        <span className="flex min-w-0 items-center gap-1.5">
          {tweet.authorAvatarUrl && !avatarFailed ? (
            <img
              src={tweet.authorAvatarUrl}
              alt=""
              aria-hidden="true"
              loading="lazy"
              referrerPolicy="no-referrer"
              onError={() => setAvatarFailed(true)}
              className="h-5 w-5 shrink-0 rounded-full bg-black/25 object-cover"
            />
          ) : null}
          <span className="truncate text-[12.5px] font-medium text-[#fafafa]">
            {tweet.authorName}
          </span>
          <span className="min-w-0 shrink-[2] truncate text-[11px] text-[#a1a1aa]">
            @{tweet.authorHandle}
            {timeLabel ? ` · ${timeLabel}` : ""}
          </span>
        </span>
        {tweet.text ? (
          <span className="mt-1 line-clamp-5 block whitespace-pre-wrap text-[12.5px] leading-snug text-[#fafafa]/90">
            {tweet.text}
          </span>
        ) : null}
      </a>
      {video ? (
        <TweetVideoView
          media={video}
          label={`video from @${tweet.authorHandle}`}
        />
      ) : photos.length > 0 ? (
        <a
          href={preview.url}
          target="_blank"
          rel="noopener noreferrer"
          className="block"
        >
          <TweetPhotoGrid photos={photos} />
        </a>
      ) : null}
    </div>
  );
}

function ImageEmbed({ preview }: { preview: ChatLinkPreview }) {
  const [failed, setFailed] = useState(false);
  if (failed || !preview.imageUrl) return null;

  return (
    <a
      href={preview.url}
      target="_blank"
      rel="noopener noreferrer"
      className="block max-w-full overflow-hidden rounded-[16px] border border-white/10 bg-black/25"
    >
      <img
        src={preview.imageUrl}
        alt="Linked image"
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
        className="block max-h-56 w-auto max-w-full object-contain"
      />
    </a>
  );
}

function PageEmbed({ preview }: { preview: ChatLinkPreview }) {
  const [imageFailed, setImageFailed] = useState(false);
  const showImage = Boolean(preview.imageUrl) && !imageFailed;
  const isLargeImage = showImage && preview.imageLayout === "large";
  const isThumbImage = showImage && !isLargeImage;

  return (
    <a
      href={preview.url}
      target="_blank"
      rel="noopener noreferrer"
      className={`${CARD_CLASS} px-3 py-2.5`}
    >
      <span className="flex items-start gap-2.5">
        <span className="min-w-0 flex-1">
          <SiteRow preview={preview} fallbackHost="" />
          {preview.title ? (
            <span className="mt-0.5 line-clamp-2 block text-[12.5px] font-medium leading-snug text-[#fafafa]">
              {preview.title}
            </span>
          ) : null}
          {preview.description ? (
            <span className="mt-0.5 line-clamp-2 block text-[12px] leading-snug text-[#a1a1aa]">
              {preview.description}
            </span>
          ) : null}
        </span>
        {isThumbImage ? (
          <img
            src={preview.imageUrl}
            alt=""
            aria-hidden="true"
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={() => setImageFailed(true)}
            className="h-14 w-14 shrink-0 rounded-lg bg-black/25 object-cover"
          />
        ) : null}
      </span>
      {isLargeImage ? (
        <img
          src={preview.imageUrl}
          alt=""
          aria-hidden="true"
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setImageFailed(true)}
          className="mt-2 max-h-[150px] w-full rounded-lg bg-black/25 object-cover"
        />
      ) : null}
    </a>
  );
}

/**
 * Compact preview above the composer for the first link in the draft, with a
 * dismiss control. Dismissing tells the send path to set `suppressEmbeds`, so
 * the message renders without embed cards for everyone.
 */
export function ChatComposerLinkPreview({
  url,
  onDismiss,
}: {
  url: string;
  onDismiss: () => void;
}) {
  const [preview, setPreview] = useState<
    ChatLinkPreview | null | typeof LOADING
  >(LOADING);
  const [thumbFailed, setThumbFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setPreview(LOADING);
    setThumbFailed(false);
    void fetchChatLinkPreview(url).then((result) => {
      if (!cancelled) setPreview(result);
    });
    return () => {
      cancelled = true;
    };
  }, [url]);

  if (preview === LOADING) return null;

  const videoId = getYouTubeVideoId(url);
  // No card would render on the sent message either — nothing to dismiss.
  if (!preview && !videoId) return null;

  const thumbnailUrl =
    preview?.imageUrl ?? (videoId ? getYouTubeThumbnailUrl(videoId) : undefined);
  let host = "";
  try {
    host = new URL(url).hostname.replace(/^www\./, "");
  } catch {
    host = "";
  }
  const siteName = preview?.siteName ?? (videoId ? "YouTube" : host);
  const title = preview?.title ?? (videoId ? "Watch on YouTube" : url);

  return (
    <div className="mb-2 flex items-center gap-2.5 rounded-xl border border-white/10 bg-white/[0.04] p-2 pr-1.5">
      {thumbnailUrl && !thumbFailed ? (
        <img
          src={thumbnailUrl}
          alt=""
          aria-hidden="true"
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setThumbFailed(true)}
          className="h-10 w-10 shrink-0 rounded-lg bg-black/25 object-cover"
        />
      ) : (
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-white/[0.06] text-[#a1a1aa]">
          <LinkIcon size={16} strokeWidth={1.75} />
        </span>
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate text-[11px] text-[#a1a1aa]">
          Link preview{siteName ? ` · ${siteName}` : ""}
        </p>
        <p className="truncate text-[12.5px] font-medium text-[#fafafa]">
          {title}
        </p>
      </div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Remove link preview"
        title="Send without link preview"
        className="shrink-0 self-center rounded-md p-1 text-[#a1a1aa] transition-colors hover:bg-white/[0.08] hover:text-[#fafafa]"
      >
        <X size={14} strokeWidth={2} />
      </button>
    </div>
  );
}

/**
 * Rich preview card for a link in a chat message. Renders nothing while the
 * unfurl is in flight and stays empty when the URL yields no metadata, so
 * messages never show broken or placeholder cards.
 */
export default function ChatLinkEmbedView({ url }: ChatLinkEmbedViewProps) {
  const [preview, setPreview] = useState<
    ChatLinkPreview | null | typeof LOADING
  >(LOADING);

  useEffect(() => {
    let cancelled = false;
    setPreview(LOADING);
    void fetchChatLinkPreview(url).then((result) => {
      if (!cancelled) setPreview(result);
    });
    return () => {
      cancelled = true;
    };
  }, [url]);

  if (preview === LOADING) return null;

  // YouTube links get an inline click-to-play player even when the page
  // scrape came back empty — the thumbnail is derivable from the video id.
  const videoId = getYouTubeVideoId(url);
  if (videoId) {
    return <YouTubeEmbed url={url} videoId={videoId} preview={preview} />;
  }

  if (!preview) return null;
  if (preview.kind === "tweet" && preview.tweet) {
    return <TweetEmbed preview={preview} tweet={preview.tweet} />;
  }
  if (preview.kind === "image") return <ImageEmbed preview={preview} />;
  return <PageEmbed preview={preview} />;
}

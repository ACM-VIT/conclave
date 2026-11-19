"use client";

import { Volume2, VolumeX } from "lucide-react";
import { useRef, useState, type CSSProperties } from "react";
import type { ChatGifAttachment } from "../lib/types";

interface ChatGifAttachmentViewProps {
  gif: ChatGifAttachment;
  className?: string;
  imageClassName?: string;
  widthClassName?: string;
}

function getGifStyle(gif: ChatGifAttachment): CSSProperties | undefined {
  if (!gif.width || !gif.height) return undefined;
  return {
    aspectRatio: `${gif.width} / ${gif.height}`,
  };
}

const Watermark = () => (
  <img
    src="/KLIPY%20TEXT%20LIGHT.svg"
    alt=""
    aria-hidden="true"
    className="pointer-events-none absolute bottom-2 left-2 h-3 w-auto max-w-[34%] opacity-70 drop-shadow-[0_1px_2px_rgba(0,0,0,0.55)]"
  />
);

function ClipAttachment({
  gif,
  baseClassName,
  sizeClassName,
}: {
  gif: ChatGifAttachment;
  baseClassName: string;
  sizeClassName: string;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [muted, setMuted] = useState(true);

  const toggleAudio = () => {
    const video = videoRef.current;
    if (!video) return;
    const next = !muted;
    video.muted = next;
    setMuted(next);
    if (!next) {
      void video.play().catch(() => {});
    }
  };

  return (
    <div className={baseClassName} style={getGifStyle(gif)} title={gif.title}>
      <video
        ref={videoRef}
        src={gif.videoUrl}
        poster={gif.previewUrl ?? gif.url}
        muted
        loop
        autoPlay
        playsInline
        preload="metadata"
        aria-label={gif.title || "Clip"}
        onClick={toggleAudio}
        className={`${sizeClassName} cursor-pointer`}
      />
      <button
        type="button"
        onClick={toggleAudio}
        aria-label={muted ? "Unmute clip" : "Mute clip"}
        className="absolute bottom-2 right-2 inline-flex h-7 w-7 items-center justify-center rounded-full bg-black/55 text-white backdrop-blur-sm transition-colors hover:bg-black/70"
      >
        {muted ? (
          <VolumeX size={15} strokeWidth={1.75} />
        ) : (
          <Volume2 size={15} strokeWidth={1.75} />
        )}
      </button>
      <Watermark />
    </div>
  );
}

export default function ChatGifAttachmentView({
  gif,
  className = "",
  imageClassName = "",
  widthClassName = "w-[240px]",
}: ChatGifAttachmentViewProps) {
  const hasRatio = Boolean(gif.width && gif.height);
  const sizeClassName = `${hasRatio ? "h-full" : "h-auto"} w-full object-contain ${imageClassName}`;
  const isSticker = gif.kind === "sticker";
  const baseClassName = `relative block ${widthClassName} max-w-full overflow-hidden rounded-[16px] ${
    isSticker ? "" : "bg-black/25"
  } ${className}`;

  if (gif.kind === "clip" && gif.videoUrl) {
    return (
      <ClipAttachment
        gif={gif}
        baseClassName={baseClassName}
        sizeClassName={sizeClassName}
      />
    );
  }

  const content = (
    <img
      src={gif.url}
      alt={gif.title || "GIF"}
      loading="lazy"
      className={sizeClassName}
    />
  );

  if (gif.pageUrl) {
    return (
      <a
        href={gif.pageUrl}
        target="_blank"
        rel="noopener noreferrer"
        className={baseClassName}
        style={getGifStyle(gif)}
        title={gif.title}
      >
        {content}
        <Watermark />
      </a>
    );
  }

  return (
    <div className={baseClassName} style={getGifStyle(gif)} title={gif.title}>
      {content}
      <Watermark />
    </div>
  );
}

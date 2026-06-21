"use client";

import type { CSSProperties } from "react";
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

export default function ChatGifAttachmentView({
  gif,
  className = "",
  imageClassName = "",
  widthClassName = "w-[240px]",
}: ChatGifAttachmentViewProps) {
  const hasRatio = Boolean(gif.width && gif.height);
  const content = (
    <img
      src={gif.url}
      alt={gif.title || "GIF"}
      loading="lazy"
      className={`${hasRatio ? "h-full" : "h-auto"} w-full object-contain ${imageClassName}`}
    />
  );
  const watermark = (
    <img
      src="/KLIPY%20TEXT%20LIGHT.svg"
      alt=""
      aria-hidden="true"
      className="pointer-events-none absolute bottom-2 left-2 h-3 w-auto max-w-[34%] opacity-70 drop-shadow-[0_1px_2px_rgba(0,0,0,0.55)]"
    />
  );

  const baseClassName = `relative block ${widthClassName} max-w-full overflow-hidden rounded-[16px] bg-black/25 ${className}`;

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
        {watermark}
      </a>
    );
  }

  return (
    <div className={baseClassName} style={getGifStyle(gif)} title={gif.title}>
      {content}
      {watermark}
    </div>
  );
}

"use client";

import { Maximize2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ChatImageAttachment } from "../lib/types";

interface ChatImageAttachmentViewProps {
  image: ChatImageAttachment;
  caption?: string;
  expandable?: boolean;
  className?: string;
  widthClassName?: string;
}

function ChatImageLightbox({
  image,
  caption,
  onClose,
}: {
  image: ChatImageAttachment;
  caption?: string;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key === "Tab") {
        event.preventDefault();
        closeButtonRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    const previouslyFocused = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      previouslyFocused?.focus?.();
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={image.fileName}
      tabIndex={-1}
      onClick={onClose}
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/85 p-5 outline-none"
    >
      <button
        ref={closeButtonRef}
        type="button"
        onClick={onClose}
        aria-label="Close image preview"
        className="absolute right-5 top-5 inline-flex h-10 w-10 items-center justify-center rounded-full border border-white/15 bg-black/40 text-white transition-colors hover:bg-white/10"
      >
        <X size={20} strokeWidth={1.8} />
      </button>
      <img
        src={image.url}
        alt={caption || image.fileName}
        className="max-h-full max-w-full rounded-xl object-contain"
        onClick={(event) => event.stopPropagation()}
      />
    </div>,
    document.body,
  );
}

export default function ChatImageAttachmentView({
  image,
  caption,
  expandable = true,
  className = "",
  widthClassName = "max-w-[300px]",
}: ChatImageAttachmentViewProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const closeLightbox = useCallback(() => setIsExpanded(false), []);

  const frameClassName = `block ${widthClassName} overflow-hidden rounded-[18px] bg-black/30 ${className}`;
  const picture = (
    <img
      src={image.url}
      alt={caption || image.fileName}
      loading="lazy"
      decoding="async"
      className="max-h-[320px] min-h-24 w-auto max-w-full object-contain"
    />
  );
  const captionBar = caption ? (
    <span className="block border-t border-white/10 bg-[#232327] px-3.5 py-2 text-[13.5px] leading-relaxed text-[#fafafa] [overflow-wrap:anywhere] whitespace-pre-wrap">
      {caption}
    </span>
  ) : null;

  if (!expandable) {
    return (
      <div className={frameClassName}>
        {picture}
        {captionBar}
      </div>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setIsExpanded(true)}
        aria-label={`View ${image.fileName} full screen`}
        className={`group relative text-left ${frameClassName}`}
      >
        {picture}
        <span className="absolute right-2 top-2 inline-flex h-7 w-7 items-center justify-center rounded-full bg-black/55 text-white opacity-0 backdrop-blur-sm transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
          <Maximize2 size={13} strokeWidth={1.8} />
        </span>
        {captionBar}
      </button>
      {isExpanded ? (
        <ChatImageLightbox image={image} caption={caption} onClose={closeLightbox} />
      ) : null}
    </>
  );
}

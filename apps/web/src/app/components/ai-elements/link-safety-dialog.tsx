"use client";

// Conclave-styled replacement for Streamdown's built-in link-safety modal.
// The stock modal is styled with shadcn theme classes (bg-background,
// text-primary, border-border) that this app never defines, so it rendered as
// an unthemed glass box. Same contract as the original: confirm before opening
// an external link found in AI / transcript markdown.

import { Check, Copy, ExternalLink } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { LinkSafetyModalProps } from "streamdown";
import { color } from "@conclave/ui-tokens";

/** Renders the URL with the hostname emphasized so the destination that
 * matters is the part that pops. Falls back to plain text for non-URL hrefs
 * (mailto:, relative paths). */
function UrlPreview({ url }: { url: string }) {
  try {
    const host = new URL(url).host;
    const hostIndex = host ? url.indexOf(host) : -1;
    if (host && hostIndex !== -1) {
      return (
        <>
          <span style={{ color: color.textFaint }}>
            {url.slice(0, hostIndex)}
          </span>
          <span className="font-medium" style={{ color: color.text }}>
            {host}
          </span>
          <span style={{ color: color.textFaint }}>
            {url.slice(hostIndex + host.length)}
          </span>
        </>
      );
    }
  } catch {
    // Not an absolute URL — show as-is below.
  }
  return <span style={{ color: color.textMuted }}>{url}</span>;
}

export function LinkSafetyDialog({
  url,
  isOpen,
  onClose,
  onConfirm,
}: LinkSafetyModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const copiedTimerRef = useRef(0);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    // Same accessible-modal focus dance as ShortcutsHelpDialog: move focus in
    // on open, hand it back to the link that opened us on close.
    const previouslyFocused = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      previouslyFocused?.focus?.();
    };
  }, [isOpen, onClose]);

  useEffect(() => {
    if (!isOpen) setCopied(false);
    return () => window.clearTimeout(copiedTimerRef.current);
  }, [isOpen]);

  const handleCopy = useCallback(async () => {
    if (!navigator?.clipboard?.writeText) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard denied — leave the button as-is.
    }
  }, [url]);

  const handleOpen = useCallback(() => {
    onConfirm();
    onClose();
  }, [onConfirm, onClose]);

  if (!isOpen) return null;

  // Portal to <body>: the markdown that spawns this dialog lives inside
  // overflow-hidden chat bubbles and entrance-animated (transformed) rows,
  // either of which would clip or re-anchor a fixed overlay.
  return createPortal(
    <div
      className="fixed inset-0 z-[95] flex items-center justify-center px-4"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div aria-hidden className="absolute inset-0 -z-10 bg-black/50" />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Open external link"
        tabIndex={-1}
        className="flex w-full max-w-[400px] flex-col overflow-hidden rounded-2xl border shadow-[0_24px_80px_rgba(0,0,0,0.55)] outline-none will-change-transform animate-[meet-popover-in_150ms_cubic-bezier(0.22,1,0.36,1)]"
        style={{
          backgroundColor: color.surfaceRaised,
          borderColor: color.border,
        }}
      >
        <div
          className="flex items-center gap-2.5 border-b px-4 py-3"
          style={{ borderColor: color.border }}
        >
          <ExternalLink
            size={16}
            strokeWidth={2}
            className="shrink-0"
            style={{ color: color.textFaint }}
          />
          <h2
            className="flex-1 text-[14px] font-semibold"
            style={{ color: color.text }}
          >
            Open external link?
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded border px-1.5 py-px text-[10px]"
            style={{ borderColor: color.border, color: color.textFaint }}
          >
            esc
          </button>
        </div>

        <div className="flex flex-col gap-3 px-4 py-4">
          <p
            className="text-[12.5px] leading-relaxed"
            style={{ color: color.textMuted }}
          >
            This link opens in a new tab outside Conclave. Only open links you
            trust.
          </p>
          <div
            className="max-h-28 overflow-y-auto break-all rounded-xl border px-3 py-2.5 text-[12px] leading-relaxed"
            style={{
              borderColor: color.border,
              backgroundColor: color.bgAlt,
            }}
          >
            <UrlPreview url={url} />
          </div>
          <div className="flex items-center justify-end gap-2.5 pt-0.5">
            <button
              type="button"
              onClick={handleCopy}
              className="inline-flex h-9 items-center justify-center gap-2 rounded-full border border-[#fafafa]/15 px-4 text-[12.5px] font-medium text-[#fafafa]/76 transition-colors hover:border-[#fafafa]/35 hover:bg-[#fafafa]/10 hover:text-[#fafafa]"
            >
              {copied ? (
                <Check size={14} strokeWidth={1.8} />
              ) : (
                <Copy size={14} strokeWidth={1.8} />
              )}
              {copied ? "Copied" : "Copy link"}
            </button>
            <button
              type="button"
              onClick={handleOpen}
              className="inline-flex h-9 items-center justify-center gap-2 rounded-full border border-[#F95F4A]/45 bg-[#F95F4A]/20 px-4 text-[12.5px] font-medium text-[#fafafa] transition-colors hover:border-[#F95F4A]/70 hover:bg-[#F95F4A]/35"
            >
              <ExternalLink size={14} strokeWidth={1.8} />
              Open link
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

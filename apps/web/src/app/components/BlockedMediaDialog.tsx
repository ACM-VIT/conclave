"use client";

import { Loader2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  BROWSER_FAMILIES,
  BROWSER_LABELS,
  blockedFooter,
  blockedLead,
  blockedTitle,
  detectBrowserFamily,
  isTouchDevice,
  unblockSteps,
  type BlockedDevice,
  type BrowserFamily,
} from "../lib/blocked-media";

interface BlockedMediaDialogProps {
  devices: readonly BlockedDevice[];
  isRetrying: boolean;
  onRetry: () => void;
  onClose: () => void;
}

export default function BlockedMediaDialog({
  devices,
  isRetrying,
  onRetry,
  onClose,
}: BlockedMediaDialogProps) {
  const [browser, setBrowser] = useState<BrowserFamily>(() =>
    detectBrowserFamily(navigator.userAgent),
  );
  const [touch] = useState(() => isTouchDevice(navigator.userAgent));
  const dialogRef = useRef<HTMLDivElement>(null);
  const retryRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    retryRef.current?.focus();
    return () => previouslyFocused?.focus?.();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>("button:not(:disabled)"),
      );
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[150] flex items-center justify-center bg-black/70 px-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="blocked-media-title"
        aria-describedby="blocked-media-lead"
        className="w-full max-w-[440px] rounded-2xl border border-white/10 bg-[#18181b] p-5 text-[#fafafa]"
      >
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h2 id="blocked-media-title" className="text-[16px] font-semibold leading-snug">
              {blockedTitle(devices)}
            </h2>
            <p
              id="blocked-media-lead"
              className="mt-1 text-[13px] leading-snug text-[#fafafa]/60"
            >
              {blockedLead(devices)}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="-mr-1 -mt-1 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[#fafafa]/50 transition-colors hover:bg-white/[0.06] hover:text-[#fafafa]"
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>

        <div
          role="group"
          aria-label="Your browser"
          className="mt-4 grid grid-cols-3 gap-1 rounded-xl border border-white/10 bg-white/[0.02] p-1"
        >
          {BROWSER_FAMILIES.map((family) => (
            <button
              key={family}
              type="button"
              aria-pressed={family === browser}
              onClick={() => setBrowser(family)}
              className={`h-8 rounded-lg text-[12.5px] font-medium transition-colors duration-150 ${
                family === browser
                  ? "bg-white/[0.08] text-[#fafafa]"
                  : "text-[#fafafa]/55 hover:text-[#fafafa]"
              }`}
            >
              {BROWSER_LABELS[family]}
            </button>
          ))}
        </div>

        <ol className="mt-4 space-y-2.5">
          {unblockSteps(browser, devices, touch).map((step, index) => (
            <li key={step} className="flex gap-2.5 text-[13.5px] leading-snug">
              <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-white/15 text-[11px] font-semibold tabular-nums text-[#fafafa]/70">
                {index + 1}
              </span>
              <span className="min-w-0 text-[#fafafa]/85">{step}</span>
            </li>
          ))}
        </ol>

        <p className="mt-4 text-[12px] leading-snug text-[#fafafa]/45">
          {blockedFooter(devices, touch)}
        </p>

        <div className="mt-5 grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-10 items-center justify-center rounded-xl border border-white/10 bg-white/[0.04] text-[14px] font-medium text-[#fafafa] transition-colors duration-150 hover:bg-white/[0.08]"
          >
            Close
          </button>
          <button
            ref={retryRef}
            type="button"
            onClick={onRetry}
            disabled={isRetrying}
            className="inline-flex h-10 items-center justify-center gap-2 rounded-xl bg-[#F95F4A] text-[14px] font-medium text-white transition-[filter] duration-150 hover:brightness-[1.05] disabled:cursor-wait disabled:opacity-75"
          >
            {isRetrying ? (
              <Loader2 size={15} className="animate-spin" aria-hidden="true" />
            ) : null}
            Try again
          </button>
        </div>
      </div>
    </div>
  );
}

import React from "react";
import type { GestureNeed } from "../hooks/useSyncedPlayback";

type GestureOverlayProps = {
  need: GestureNeed;
  onResolve: () => void;
  title: string | null;
};

/**
 * Browser autoplay recovery. Muted playback gets a small, non-blocking sound
 * chip; only a genuinely blocked player uses the centered recovery surface.
 * Both actions are explicitly local, so nobody mistakes them for room-wide
 * playback controls.
 */
export function GestureOverlay({
  need,
  onResolve,
  title,
}: GestureOverlayProps) {
  if (need === "none") return null;

  if (need === "sound") {
    return (
      <div className="pointer-events-none absolute inset-x-0 top-3 z-20 flex justify-center px-3">
        <button
          type="button"
          onClick={onResolve}
          className="pointer-events-auto inline-flex h-9 cursor-pointer items-center gap-2 rounded-full border border-white/10 px-3 text-[12px] font-medium text-[#f4f4f5] shadow-[0_8px_28px_rgba(0,0,0,0.3)] transition-colors hover:border-white/20 hover:bg-[#202027]"
          style={{
            backgroundColor: "rgba(17, 17, 21, 0.9)",
            backdropFilter: "blur(10px)",
          }}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <polygon
              points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"
              fill="currentColor"
              stroke="none"
            />
            <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
          </svg>
          Audio is muted
          <span className="text-[#ff8a78]">Turn on</span>
        </button>
      </div>
    );
  }

  return (
    <div
      className="absolute inset-0 z-20 flex items-center justify-center px-5"
      style={{ backgroundColor: "rgba(0, 0, 0, 0.46)" }}
    >
      <div
        className="flex w-full max-w-[22rem] flex-col items-center rounded-2xl border border-white/10 px-6 py-5 text-center shadow-[0_18px_60px_rgba(0,0,0,0.48)]"
        style={{
          backgroundColor: "rgba(16, 16, 20, 0.94)",
          backdropFilter: "blur(12px)",
        }}
      >
        <div
          className="flex h-10 w-10 items-center justify-center rounded-full"
          style={{ backgroundColor: "rgba(249, 95, 74, 0.14)" }}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="#F95F4A"
            aria-hidden="true"
            style={{ marginLeft: 2 }}
          >
            <polygon points="6 4 20 12 6 20 6 4" />
          </svg>
        </div>
        <p className="mt-3 text-[14px] font-semibold text-[#fafafa]">
          Resume playback on this device
        </p>
        {title ? (
          <p className="mt-1 max-w-full truncate text-[12px] text-[#8b8b93]">
            {title}
          </p>
        ) : null}
        <button
          type="button"
          onClick={onResolve}
          className="mt-4 inline-flex h-10 cursor-pointer items-center rounded-full px-5 text-[13px] font-semibold text-white transition-opacity hover:opacity-90"
          style={{ backgroundColor: "#F95F4A" }}
        >
          Resume for me
        </button>
        <p className="mt-2.5 text-[11px] leading-relaxed text-[#71717a]">
          This only starts your player. It won&apos;t change playback for the room.
        </p>
      </div>
    </div>
  );
}

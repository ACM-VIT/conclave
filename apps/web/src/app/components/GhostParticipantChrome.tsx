"use client";

import type { ReactNode } from "react";
import { Ghost } from "lucide-react";

export const GHOST_ACCENT_CLASS = "text-[#F95F4A]";

type GhostParticipantChromeProps = {
  compact?: boolean;
  label?: string;
};

export function GhostParticipantBadge({
  compact = false,
  label = "Ghost",
}: GhostParticipantChromeProps) {
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-full border border-[#F95F4A]/30 bg-[#F95F4A]/10 font-medium text-[#F95F4A] ${
        compact ? "px-1.5 py-0.5 text-[10px]" : "px-2 py-0.5 text-[11px]"
      }`}
    >
      <Ghost
        className={compact ? "h-3 w-3" : "h-3.5 w-3.5"}
        strokeWidth={1.75}
        aria-hidden
      />
      {label}
    </span>
  );
}

export function GhostParticipantOverlay({
  compact = false,
  label = "Ghost",
}: GhostParticipantChromeProps) {
  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-[#0a0a0b]/45">
      <div
        className={`flex flex-col items-center ${compact ? "gap-1.5" : "gap-2"}`}
      >
        <Ghost
          className={`${compact ? "h-8 w-8" : "h-12 w-12"} ${GHOST_ACCENT_CLASS}`}
          strokeWidth={1.75}
          aria-hidden
        />
        <span
          className={`rounded-full border border-[#F95F4A]/30 bg-[#0a0a0b]/80 font-medium uppercase tracking-wider text-[#F95F4A] ${
            compact ? "px-2 py-0.5 text-[9px]" : "px-3 py-1 text-[10px]"
          }`}
        >
          {label}
        </span>
      </div>
    </div>
  );
}

export function GhostParticipantTileFrame({
  children,
  isGhostParticipant,
}: {
  children: ReactNode;
  isGhostParticipant: boolean;
}) {
  if (!isGhostParticipant) {
    return children;
  }

  return (
    <div className="relative h-full w-full rounded-[inherit] ring-1 ring-inset ring-[#F95F4A]/25">
      {children}
    </div>
  );
}

"use client";

import { MicOff } from "lucide-react";
import type { ReactNode } from "react";
import { truncateDisplayName } from "../lib/utils";

export default function TileNameplate({
  name,
  dense,
  isLocal = false,
  isMuted,
  isSpeaking,
  badge,
}: {
  name: string;
  dense: boolean;
  isLocal?: boolean;
  isMuted: boolean;
  isSpeaking: boolean;
  badge?: ReactNode;
}) {
  return (
    <div
      data-meet-tile-nameplate
      className={`absolute flex items-center rounded-full border border-[#fafafa]/10 bg-black/70 ${
        dense
          ? "bottom-1.5 left-1.5 max-w-[82%] gap-1 px-2 py-0.5 text-[10px]"
          : "bottom-3 left-3 max-w-[75%] gap-2 px-3 py-1.5 text-xs"
      }`}
    >
      <span className="min-w-0 truncate font-medium text-[#fafafa]" title={name}>
        {truncateDisplayName(name, dense ? 16 : 18)}
      </span>
      {badge}
      {isLocal ? (
        <span className="shrink-0 font-medium text-[#F95F4A]">You</span>
      ) : null}
      {isSpeaking ? (
        <span className="acm-voice-activity shrink-0" aria-label="Speaking">
          <span />
          <span />
          <span />
        </span>
      ) : null}
      {isMuted ? (
        <MicOff
          className={`shrink-0 text-[#F95F4A] ${dense ? "h-2.5 w-2.5" : "h-3 w-3"}`}
        />
      ) : null}
    </div>
  );
}

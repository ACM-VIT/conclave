"use client";

import { memo } from "react";
import type { ReactionEvent } from "../lib/types";

interface ReactionOverlayProps {
  reactions: ReactionEvent[];
  getDisplayName: (userId: string) => string;
}

function ReactionOverlay({
  reactions,
  getDisplayName,
}: ReactionOverlayProps) {
  return (
    <div className="pointer-events-none absolute inset-0 z-20">
      {reactions.map((reaction) => {
        const displayName = getDisplayName(reaction.userId);
        return (
          <div
            key={reaction.id}
            className="absolute bottom-24 sm:bottom-20"
            style={{ left: `${reaction.lane}%` }}
          >
            <div className="-translate-x-1/2">
              <div className="animate-reaction-float flex flex-col items-center gap-1">
                <div className="w-12 h-12 sm:w-16 sm:h-16 rounded-full bg-black/60 border border-white/10 flex items-center justify-center text-2xl sm:text-3xl shadow-xl">
                  {reaction.kind === "emoji" ? (
                    reaction.value
                  ) : (
                    <img
                      src={reaction.value}
                      alt={reaction.label || "Reaction"}
                      className="w-7 h-7 sm:w-10 sm:h-10 object-contain"
                    />
                  )}
                </div>
                <span className="text-[9px] sm:text-[10px] text-white/70 bg-black/40 border border-white/5 px-1.5 sm:px-2 py-0.5 rounded-full max-w-[140px] truncate">
                  {displayName}
                </span>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default memo(ReactionOverlay);

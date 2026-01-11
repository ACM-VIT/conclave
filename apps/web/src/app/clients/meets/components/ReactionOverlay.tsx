"use client";

import { memo } from "react";
import type { ReactionEvent } from "../types";

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
            className="absolute bottom-20 animate-reaction-float"
            style={{ left: `${reaction.lane}%` }}
          >
            <div className="flex flex-col items-center gap-1">
              <div className="w-16 h-16 rounded-full bg-black/60 border border-white/10 flex items-center justify-center text-3xl shadow-xl">
                {reaction.kind === "emoji" ? (
                  reaction.value
                ) : (
                  <img
                    src={reaction.value}
                    alt={reaction.label || "Reaction"}
                    className="w-10 h-10 object-contain"
                  />
                )}
              </div>
              <span className="text-[10px] text-white/70 bg-black/40 border border-white/5 px-2 py-0.5 rounded-full">
                {displayName}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default memo(ReactionOverlay);

"use client";

import { memo, useSyncExternalStore } from "react";
import {
  getReactionRenderLimit,
  type ReactionStore,
} from "../lib/reaction-store";

interface ReactionOverlayProps {
  store: ReactionStore;
  getDisplayName: (userId: string) => string;
  participantCount: number;
}

function ReactionOverlay({
  store,
  getDisplayName,
  participantCount,
}: ReactionOverlayProps) {
  // Subscribing here (instead of receiving reactions as a prop) keeps
  // reaction traffic from re-rendering anything above this overlay.
  const reactions = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot
  );

  if (reactions.length === 0) return null;

  // A wall of translucent animated layers is expensive to composite over a
  // large live-video grid. Keep the newest reactions visible while bounding
  // the amount of per-frame paint/composite work.
  const renderLimit = getReactionRenderLimit(participantCount);
  const visibleReactions =
    reactions.length > renderLimit ? reactions.slice(-renderLimit) : reactions;

  return (
    <div
      className="meet-reaction-overlay pointer-events-none absolute inset-0 z-20"
      data-meet-reaction-count={visibleReactions.length}
      data-meet-reaction-limit={renderLimit}
    >
      {visibleReactions.map((reaction) => {
        const displayName = getDisplayName(reaction.userId);
        return (
          <div
            key={reaction.id}
            className="absolute bottom-24 sm:bottom-20"
            style={{ left: `${reaction.lane}%` }}
          >
            <div className="-translate-x-1/2">
              <div
                className="animate-reaction-float flex flex-col items-center gap-1.5"
                style={{ animationDuration: "2s" }}
                onAnimationEnd={() => store.remove(reaction.id)}
              >
                <div className="flex h-11 w-11 items-center justify-center rounded-full border border-[#fafafa]/10 bg-[#18181b]/90 text-2xl sm:h-14 sm:w-14 sm:text-3xl">
                  {reaction.kind === "emoji" ? (
                    reaction.value
                  ) : (
                    <img
                      src={reaction.value}
                      alt={reaction.label || "Reaction"}
                      className="h-6 w-6 object-contain sm:h-8 sm:w-8"
                    />
                  )}
                </div>
                <span className="max-w-[140px] truncate rounded-full border border-[#fafafa]/10 bg-[#18181b]/90 px-2 py-0.5 text-[11px] text-[#fafafa]/70 sm:text-[12px]">
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

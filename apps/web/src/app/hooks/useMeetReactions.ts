"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import type { Socket } from "socket.io-client";
import {
  EMOJI_REACTIONS,
  MAX_REACTIONS,
  REACTION_LIFETIME_MS,
} from "../lib/constants";
import { createReactionStore } from "../lib/reaction-store";
import type { ReactionStore } from "../lib/reaction-store";
import type { ReactionEvent, ReactionOption, ReactionPayload } from "../lib/types";
import { buildAssetReaction, isReactionEmoji, isValidAssetPath } from "../lib/utils";

interface UseMeetReactionsOptions {
  userId: string;
  socketRef: React.MutableRefObject<Socket | null>;
  isObserverMode?: boolean;
  reactionAssets?: string[];
}

export function useMeetReactions({
  userId,
  socketRef,
  isObserverMode = false,
  reactionAssets,
}: UseMeetReactionsOptions) {
  const storeRef = useRef<ReactionStore | null>(null);
  if (!storeRef.current) {
    storeRef.current = createReactionStore(MAX_REACTIONS);
  }
  const reactionStore = storeRef.current;
  const reactionTimeoutsRef = useRef<Map<string, number>>(new Map());
  const lastReactionSentRef = useRef<number>(0);

  const baseReactionOptions = useMemo<ReactionOption[]>(
    () =>
      EMOJI_REACTIONS.map((emoji) => ({
        id: `emoji-${emoji}`,
        kind: "emoji",
        value: emoji,
        label: emoji,
      })),
    []
  );

  const customReactionOptions = useMemo<ReactionOption[]>(
    () => (reactionAssets ? reactionAssets.map(buildAssetReaction) : []),
    [reactionAssets]
  );

  const reactionOptions = useMemo(
    () => [...baseReactionOptions, ...customReactionOptions],
    [baseReactionOptions, customReactionOptions]
  );

  const addReaction = useCallback(
    (reaction: ReactionPayload) => {
      if (reaction.kind === "emoji" && !isReactionEmoji(reaction.value)) return;
      if (reaction.kind === "asset" && !isValidAssetPath(reaction.value)) return;

      const reactionId = `${Date.now()}-${Math.random()
        .toString(36)
        .substring(2, 8)}`;
      const lane = 12 + Math.random() * 76;
      const event: ReactionEvent = {
        id: reactionId,
        userId: reaction.userId,
        kind: reaction.kind,
        value: reaction.value,
        label: reaction.label,
        timestamp: reaction.timestamp || Date.now(),
        lane,
      };

      reactionStore.add(event);

      const timeoutId = window.setTimeout(() => {
        reactionStore.remove(reactionId);
        reactionTimeoutsRef.current.delete(reactionId);
      }, REACTION_LIFETIME_MS);
      reactionTimeoutsRef.current.set(reactionId, timeoutId);
    },
    [reactionStore]
  );

  const sendReaction = useCallback(
    (reaction: ReactionOption) => {
      if (isObserverMode) return;
      const now = Date.now();
      if (now - lastReactionSentRef.current < 100) {
        return;
      }
      lastReactionSentRef.current = now;

      addReaction({
        userId,
        kind: reaction.kind,
        value: reaction.value,
        label: reaction.label,
        timestamp: now,
      });

      if (reaction.kind === "emoji" && !isReactionEmoji(reaction.value)) return;
      if (reaction.kind === "asset" && !isValidAssetPath(reaction.value))
        return;
      const socket = socketRef.current;
      if (!socket) return;

      const payload =
        reaction.kind === "emoji"
          ? {
              kind: "emoji" as const,
              value: reaction.value,
              emoji: reaction.value,
              label: reaction.label,
            }
          : {
              kind: "asset" as const,
              value: reaction.value,
              label: reaction.label,
            };

      socket.emit(
        "sendReaction",
        payload,
        (response: { success: boolean } | { error: string }) => {
          if ("error" in response) {
            console.error("[Meets] Reaction error:", response.error);
          }
        }
      );
    },
    [addReaction, userId, isObserverMode, socketRef]
  );

  const clearReactions = useCallback(() => {
    reactionTimeoutsRef.current.forEach((timeoutId) => {
      window.clearTimeout(timeoutId);
    });
    reactionTimeoutsRef.current.clear();
    reactionStore.clear();
  }, [reactionStore]);

  useEffect(() => {
    return () => {
      reactionTimeoutsRef.current.forEach((timeoutId) => {
        window.clearTimeout(timeoutId);
      });
      reactionTimeoutsRef.current.clear();
      reactionStore.clear();
    };
  }, [reactionStore]);

  return {
    reactionStore,
    reactionOptions,
    addReaction,
    sendReaction,
    clearReactions,
  };
}

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Socket } from "socket.io-client";
import {
  EMOJI_REACTIONS,
  MAX_REACTIONS,
  REACTION_LIFETIME_MS,
} from "../lib/constants";
import type { ReactionEvent, ReactionOption, ReactionPayload } from "../lib/types";
import { buildAssetReaction, isReactionEmoji, isValidAssetPath } from "../lib/utils";

interface UseMeetReactionsOptions {
  userId: string;
  socketRef: React.MutableRefObject<Socket | null>;
  ghostEnabled: boolean;
  isObserverMode?: boolean;
  reactionAssets?: string[];
}

export function useMeetReactions({
  userId,
  socketRef,
  ghostEnabled,
  isObserverMode = false,
  reactionAssets,
}: UseMeetReactionsOptions) {
  const [reactions, setReactions] = useState<ReactionEvent[]>([]);
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

  const addReaction = useCallback((reaction: ReactionPayload) => {
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

    setReactions((prev) => {
      const next = [...prev, event];
      return next.length > MAX_REACTIONS ? next.slice(-MAX_REACTIONS) : next;
    });

    const timeoutId = window.setTimeout(() => {
      setReactions((prev) => prev.filter((item) => item.id !== reactionId));
      reactionTimeoutsRef.current.delete(reactionId);
    }, REACTION_LIFETIME_MS);
    reactionTimeoutsRef.current.set(reactionId, timeoutId);
  }, []);

  const sendReaction = useCallback(
    (reaction: ReactionOption) => {
      if (ghostEnabled || isObserverMode) return;
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
    [addReaction, userId, ghostEnabled, isObserverMode, socketRef]
  );

  useEffect(() => {
    return () => {
      reactionTimeoutsRef.current.forEach((timeoutId) => {
        window.clearTimeout(timeoutId);
      });
      reactionTimeoutsRef.current.clear();
    };
  }, []);

  return {
    reactions,
    reactionOptions,
    addReaction,
    sendReaction,
    clearReactions: () => {
      reactionTimeoutsRef.current.forEach((timeoutId) => {
        window.clearTimeout(timeoutId);
      });
      reactionTimeoutsRef.current.clear();
      setReactions([]);
    },
  };
}

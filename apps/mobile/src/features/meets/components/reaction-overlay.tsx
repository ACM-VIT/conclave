import React, { useEffect, useMemo } from "react";
import Animated, {
  Extrapolation,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import type { ReactionEvent } from "../types";
import { reactionAssetMap } from "../reaction-assets";
import { REACTION_LIFETIME_MS } from "../constants";
import { Image, Text, View } from "@/tw";

interface ReactionOverlayProps {
  reactions: ReactionEvent[];
  currentUserId: string;
  resolveDisplayName: (userId: string) => string;
}

const ReactionBubble = React.memo(function ReactionBubble({
  reaction,
  displayName,
}: {
  reaction: ReactionEvent;
  displayName: string;
}) {
  const progress = useSharedValue(0);
  const drift = useMemo(() => (Math.random() * 2 - 1) * 12, []);

  useEffect(() => {
    progress.value = 0;
    progress.value = withTiming(1, { duration: REACTION_LIFETIME_MS });
  }, [progress]);

  const animatedStyle = useAnimatedStyle(() => {
    const translateY = interpolate(progress.value, [0, 1], [0, -160]);
    const scale = interpolate(progress.value, [0, 0.15], [0.9, 1]);
    const opacity = interpolate(
      progress.value,
      [0, 0.1, 0.85, 1],
      [0, 1, 1, 0],
      Extrapolation.CLAMP
    );
    const transform = [{ translateY }, { translateX: drift }, { scale }] as const;
    return {
      transform,
      opacity,
    };
  }, [drift]);

  return (
    <Animated.View
      style={animatedStyle}
      className="items-center"
    >
      <View className="items-center gap-1">
        <View className="h-16 w-16 items-center justify-center rounded-full border border-white/10 bg-black/60">
          {reaction.kind === "emoji" ? (
            <Text className="text-3xl">{reaction.value}</Text>
          ) : reactionAssetMap[reaction.value] ? (
            <Image
              source={reactionAssetMap[reaction.value]}
              className="h-10 w-10"
            />
          ) : (
            <Text className="text-2xl">✨</Text>
          )}
        </View>
        <View className="rounded-full border border-white/5 bg-black/40 px-2 py-0.5">
          <Text className="text-[10px] font-medium text-white/80">
            {displayName}
          </Text>
        </View>
      </View>
    </Animated.View>
  );
});

export function ReactionOverlay({
  reactions,
  currentUserId,
  resolveDisplayName,
}: ReactionOverlayProps) {
  if (!reactions.length) return null;

  return (
    <View className="absolute inset-0 pointer-events-none">
      {reactions.map((reaction) => {
        const left = `${reaction.lane}%` as const;
        const displayName =
          reaction.userId === currentUserId
            ? "You"
            : resolveDisplayName(reaction.userId) || "Someone";
        return (
          <Animated.View
            key={reaction.id}
            style={{ left }}
            className="absolute bottom-24"
          >
            <ReactionBubble reaction={reaction} displayName={displayName} />
          </Animated.View>
        );
      })}
    </View>
  );
}

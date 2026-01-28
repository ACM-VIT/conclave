import React from "react";
import Animated, { FadeInUp, FadeOutUp } from "react-native-reanimated";
import type { ReactionEvent } from "../types";
import { reactionAssetMap } from "../reaction-assets";
import { Image, Text, View } from "@/tw";

interface ReactionOverlayProps {
  reactions: ReactionEvent[];
}

export function ReactionOverlay({ reactions }: ReactionOverlayProps) {
  if (!reactions.length) return null;

  return (
    <View className="absolute inset-0 pointer-events-none">
      {reactions.map((reaction) => {
        const left = `${reaction.lane}%` as const;
        return (
          <Animated.View
            key={reaction.id}
            entering={FadeInUp.duration(200)}
            exiting={FadeOutUp.duration(200)}
            style={{ left }}
            className="absolute bottom-24"
          >
            {reaction.kind === "emoji" ? (
              <Text className="text-3xl">{reaction.value}</Text>
            ) : reactionAssetMap[reaction.value] ? (
              <Image
                source={reactionAssetMap[reaction.value]}
                className="w-12 h-12"
              />
            ) : (
              <Text className="text-2xl">✨</Text>
            )}
          </Animated.View>
        );
      })}
    </View>
  );
}

import React from "react";
import type { MeetError } from "../types";
import { Pressable, Text, View } from "@/tw";

interface ErrorBannerProps {
  meetError: MeetError;
  onDismiss?: () => void;
  primaryActionLabel?: string;
  onPrimaryAction?: () => void;
}

export function ErrorBanner({
  meetError,
  onDismiss,
  primaryActionLabel,
  onPrimaryAction,
}: ErrorBannerProps) {
  return (
    <View className="w-full bg-red-950/80 border border-red-700/50 px-4 py-3">
      <View className="flex-row items-start justify-between gap-3">
        <View className="flex-1">
          <Text className="text-sm font-semibold text-red-100" selectable>
            {meetError.message}
          </Text>
          <Text className="text-xs text-red-200/80 mt-1" selectable>
            {meetError.code}
          </Text>
        </View>
        {onDismiss ? (
          <Pressable
            className="px-2 py-1 rounded-full bg-red-800/70"
            onPress={onDismiss}
          >
            <Text className="text-xs text-white">Dismiss</Text>
          </Pressable>
        ) : null}
      </View>
      {primaryActionLabel && onPrimaryAction ? (
        <Pressable
          className="mt-3 px-3 py-2 rounded-lg bg-red-600/90"
          onPress={onPrimaryAction}
        >
          <Text className="text-xs font-semibold text-white">
            {primaryActionLabel}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

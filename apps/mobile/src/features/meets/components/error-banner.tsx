import React from "react";
import { StyleSheet, View as RNView } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { MeetError } from "../types";
import { Pressable, Text, View } from "@/tw";
import { GlassPill } from "./glass-pill";

interface ErrorBannerProps {
  meetError: MeetError;
  onDismiss?: () => void;
  primaryActionLabel?: string;
  onPrimaryAction?: () => void;
  placement?: "top" | "bottom";
  bottomOffset?: number;
  topOffset?: number;
  autoDismissMs?: number | null;
}

export function ErrorBanner({
  meetError,
  onDismiss,
  primaryActionLabel,
  onPrimaryAction,
  placement = "bottom",
  bottomOffset = 16,
  topOffset = 12,
  autoDismissMs = 6000,
}: ErrorBannerProps) {
  const insets = useSafeAreaInsets();
  const bottomPosition = insets.bottom + bottomOffset;
  const topPosition = insets.top + topOffset;
  const isBottom = placement === "bottom";

  React.useEffect(() => {
    if (!onDismiss || autoDismissMs === null) return;
    const timer = setTimeout(() => {
      onDismiss();
    }, autoDismissMs);
    return () => clearTimeout(timer);
  }, [meetError.message, meetError.code, onDismiss, autoDismissMs]);

  return (
    <RNView
      pointerEvents="box-none"
      style={[
        styles.wrapper,
        isBottom ? { bottom: bottomPosition } : { top: topPosition },
      ]}
    >
      <GlassPill style={styles.toastShell}>
        <View style={styles.toast}>
          <View style={styles.accent} />
          <View style={styles.content}>
            <View style={styles.textBlock}>
              <Text style={styles.message} selectable>
                {meetError.message}
              </Text>
              <Text style={styles.code} selectable>
                {meetError.code}
              </Text>
            </View>
            <View style={styles.actions}>
              {primaryActionLabel && onPrimaryAction ? (
                <Pressable
                  onPress={onPrimaryAction}
                  style={({ pressed }) => [
                    styles.primaryAction,
                    pressed && styles.actionPressed,
                  ]}
                >
                  <Text style={styles.primaryActionText}>
                    {primaryActionLabel}
                  </Text>
                </Pressable>
              ) : null}
              {onDismiss ? (
                <Pressable
                  onPress={onDismiss}
                  style={({ pressed }) => [
                    styles.secondaryAction,
                    pressed && styles.actionPressed,
                  ]}
                >
                  <Text style={styles.secondaryActionText}>Dismiss</Text>
                </Pressable>
              ) : null}
            </View>
          </View>
        </View>
      </GlassPill>
    </RNView>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    position: "absolute",
    left: 16,
    right: 16,
    alignItems: "center",
    zIndex: 20,
  },
  toastShell: {
    width: "100%",
    maxWidth: 520,
    borderRadius: 26,
    borderWidth: 1,
    borderColor: "rgba(249, 95, 74, 0.45)",
    backgroundColor: "rgba(12, 10, 10, 0.75)",
    shadowColor: "rgba(249, 95, 74, 0.45)",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.35,
    shadowRadius: 14,
    elevation: 10,
  },
  toast: {
    flexDirection: "row",
    alignItems: "stretch",
    paddingVertical: 12,
    paddingHorizontal: 14,
    gap: 12,
  },
  accent: {
    width: 3,
    borderRadius: 999,
    backgroundColor: "#F95F4A",
  },
  content: {
    flex: 1,
    gap: 10,
  },
  textBlock: {
    gap: 4,
  },
  message: {
    color: "#FEFCD9",
    fontSize: 13,
    fontWeight: "600",
  },
  code: {
    color: "rgba(254, 252, 217, 0.6)",
    fontSize: 11,
    letterSpacing: 0.6,
    textTransform: "uppercase",
  },
  actions: {
    flexDirection: "row",
    gap: 8,
    flexWrap: "wrap",
  },
  primaryAction: {
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: "rgba(249, 95, 74, 0.9)",
  },
  primaryActionText: {
    color: "#FFFFFF",
    fontSize: 11,
    fontWeight: "600",
    letterSpacing: 0.4,
  },
  secondaryAction: {
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: "rgba(255, 255, 255, 0.08)",
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.1)",
  },
  secondaryActionText: {
    color: "rgba(254, 252, 217, 0.8)",
    fontSize: 11,
    fontWeight: "600",
    letterSpacing: 0.4,
  },
  actionPressed: {
    opacity: 0.85,
    transform: [{ scale: 0.98 }],
  },
});

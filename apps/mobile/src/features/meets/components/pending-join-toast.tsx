import React from "react";
import { StyleSheet, View as RNView } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Pressable, Text } from "@/tw";
import { Check, X } from "lucide-react-native";
import { GlassPill } from "./glass-pill";

interface PendingJoinToastProps {
  visible: boolean;
  displayName: string;
  count: number;
  onAdmit: () => void;
  onReject: () => void;
}

export function PendingJoinToast({
  visible,
  displayName,
  count,
  onAdmit,
  onReject,
}: PendingJoinToastProps) {
  const insets = useSafeAreaInsets();

  if (!visible) return null;

  return (
    <RNView
      pointerEvents="box-none"
      style={[styles.container, { bottom: insets.bottom + 96 }]}
    >
      <GlassPill style={styles.toast}>
        <Text style={styles.label}>Waiting</Text>
        <Text style={styles.name} numberOfLines={1}>
          {displayName}
        </Text>
        {count > 1 ? (
          <Text style={styles.more}>+{count - 1}</Text>
        ) : null}
        <Pressable
          onPress={onReject}
          style={({ pressed }) => [
            styles.iconButton,
            styles.rejectButton,
            pressed && styles.buttonPressed,
          ]}
          accessibilityRole="button"
          accessibilityLabel="Reject"
        >
          <X size={16} color="rgba(248, 113, 113, 0.95)" strokeWidth={2.5} />
        </Pressable>
        <Pressable
          onPress={onAdmit}
          style={({ pressed }) => [
            styles.iconButton,
            styles.admitButton,
            pressed && styles.buttonPressed,
          ]}
          accessibilityRole="button"
          accessibilityLabel="Admit"
        >
          <Check size={16} color="#16a34a" strokeWidth={2.5} />
        </Pressable>
      </GlassPill>
    </RNView>
  );
}

const styles = StyleSheet.create({
  container: {
    position: "absolute",
    left: 0,
    right: 0,
    alignItems: "center",
    zIndex: 30,
  },
  toast: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: "rgba(10, 10, 10, 0.92)",
    borderWidth: 1,
    borderColor: "rgba(250, 250, 250, 0.15)",
  },
  label: {
    fontSize: 10,
    letterSpacing: 1.2,
    textTransform: "uppercase",
    color: "rgba(249, 95, 74, 0.8)",
  },
  name: {
    fontSize: 12,
    color: "rgba(250, 250, 250, 0.92)",
    maxWidth: 120,
  },
  more: {
    fontSize: 10,
    color: "rgba(250, 250, 250, 0.5)",
  },
  iconButton: {
    width: 40,
    height: 40,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  rejectButton: {
    borderColor: "rgba(234, 67, 53, 0.5)",
    backgroundColor: "rgba(234, 67, 53, 0.15)",
  },
  admitButton: {
    borderColor: "rgba(249, 95, 74, 0.6)",
    backgroundColor: "rgba(249, 95, 74, 0.85)",
  },
  buttonPressed: {
    opacity: 0.7,
    transform: [{ scale: 0.96 }],
  },
});

import React, { useCallback, useEffect, useMemo, useRef } from "react";
import { StyleSheet } from "react-native";
import { TrueSheet } from "@lodev09/react-native-true-sheet";
import type { MeetError } from "../types";
import { Pressable, Text, View } from "@/tw";
import { SHEET_COLORS, SHEET_THEME } from "./true-sheet-theme";

interface ErrorSheetProps {
  visible: boolean;
  meetError: MeetError;
  onDismiss?: () => void;
  primaryActionLabel?: string;
  onPrimaryAction?: () => void;
  autoDismissMs?: number | null;
}

export function ErrorSheet({
  visible,
  meetError,
  onDismiss,
  primaryActionLabel,
  onPrimaryAction,
  autoDismissMs = 6000,
}: ErrorSheetProps) {
  const sheetRef = useRef<TrueSheet>(null);
  const hasPresented = useRef(false);

  const handleDismiss = useCallback(() => {
    void sheetRef.current?.dismiss();
  }, []);

  const handleDidDismiss = useCallback(() => {
    hasPresented.current = false;
    onDismiss?.();
  }, [onDismiss]);

  useEffect(() => {
    if (visible) {
      hasPresented.current = true;
      void sheetRef.current?.present(0);
    } else if (hasPresented.current) {
      void sheetRef.current?.dismiss();
    }
  }, [visible]);

  useEffect(() => {
    if (!visible || !onDismiss || autoDismissMs === null) return;
    const timer = setTimeout(() => {
      handleDismiss();
    }, autoDismissMs);
    return () => clearTimeout(timer);
  }, [
    visible,
    meetError.code,
    meetError.message,
    onDismiss,
    autoDismissMs,
    handleDismiss,
  ]);

  const handlePrimaryAction = useCallback(() => {
    onPrimaryAction?.();
    handleDismiss();
  }, [onPrimaryAction, handleDismiss]);

  const headerTitle = useMemo(() => {
    switch (meetError.code) {
      case "PERMISSION_DENIED":
        return "Permissions Needed";
      case "MEDIA_ERROR":
        return "Device Issue";
      case "CONNECTION_FAILED":
        return "Connection Problem";
      case "TRANSPORT_ERROR":
        return "Connection Problem";
      default:
        return "Something Went Wrong";
    }
  }, [meetError.code]);

  return (
    <TrueSheet
      ref={sheetRef}
      detents={["auto"]}
      onDidDismiss={handleDidDismiss}
      {...SHEET_THEME}
      grabber={false}
      draggable={false}
      dimmed={false}
    >
      <View style={styles.sheetContent}>
        <View style={styles.headerRow}>
          <View style={styles.headerTextBlock}>
            <Text style={styles.title}>{headerTitle}</Text>
            <Text style={styles.code}>{meetError.code}</Text>
          </View>
          {onDismiss ? (
            <Pressable onPress={handleDismiss} style={styles.closeButton}>
              <Text style={styles.closeText}>Close</Text>
            </Pressable>
          ) : null}
        </View>

        <Text style={styles.message}>{meetError.message}</Text>

        {(primaryActionLabel && onPrimaryAction) || onDismiss ? (
          <View style={styles.actionsRow}>
            {primaryActionLabel && onPrimaryAction ? (
              <Pressable
                onPress={handlePrimaryAction}
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
                onPress={handleDismiss}
                style={({ pressed }) => [
                  styles.secondaryAction,
                  pressed && styles.actionPressed,
                ]}
              >
                <Text style={styles.secondaryActionText}>Dismiss</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}
      </View>
    </TrueSheet>
  );
}

const styles = StyleSheet.create({
  sheetContent: {
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 20,
    gap: 12,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 12,
  },
  headerTextBlock: {
    gap: 6,
    flex: 1,
  },
  title: {
    fontSize: 16,
    fontWeight: "600",
    color: SHEET_COLORS.text,
  },
  code: {
    fontSize: 11,
    letterSpacing: 2,
    textTransform: "uppercase",
    color: SHEET_COLORS.textFaint,
  },
  message: {
    fontSize: 13,
    lineHeight: 18,
    color: SHEET_COLORS.textMuted,
  },
  closeButton: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: "rgba(254, 252, 217, 0.08)",
    borderWidth: 1,
    borderColor: SHEET_COLORS.border,
  },
  closeText: {
    fontSize: 11,
    color: SHEET_COLORS.text,
  },
  actionsRow: {
    flexDirection: "row",
    gap: 8,
    flexWrap: "wrap",
  },
  primaryAction: {
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 8,
    backgroundColor: "rgba(249, 95, 74, 0.9)",
  },
  primaryActionText: {
    color: "#FFFFFF",
    fontSize: 12,
    fontWeight: "600",
    letterSpacing: 0.4,
  },
  secondaryAction: {
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 8,
    backgroundColor: "rgba(255, 255, 255, 0.08)",
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.1)",
  },
  secondaryActionText: {
    color: "rgba(254, 252, 217, 0.8)",
    fontSize: 12,
    fontWeight: "600",
    letterSpacing: 0.4,
  },
  actionPressed: {
    opacity: 0.85,
    transform: [{ scale: 0.98 }],
  },
});

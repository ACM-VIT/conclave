import React, { useCallback, useEffect, useRef } from "react";
import { StyleSheet, View as RNView } from "react-native";
import * as Haptics from "expo-haptics";
import { TrueSheet } from "@lodev09/react-native-true-sheet";
import { Pressable, View } from "@/tw";
import { Hand, ScreenShare } from "lucide-react-native";
import { SHEET_COLORS, SHEET_THEME } from "./true-sheet-theme";

const COLORS = {
  dark: "#0b0b0b",
} as const;

interface SettingsSheetProps {
  visible: boolean;
  isScreenSharing: boolean;
  isHandRaised: boolean;
  onToggleScreenShare: () => void;
  onToggleHandRaised: () => void;
  onClose: () => void;
}

export function SettingsSheet({
  visible,
  isScreenSharing,
  isHandRaised,
  onToggleScreenShare,
  onToggleHandRaised,
  onClose,
}: SettingsSheetProps) {
  const sheetRef = useRef<TrueSheet>(null);
  const hasPresented = useRef(false);

  const handleDismiss = useCallback(() => {
    void sheetRef.current?.dismiss();
  }, []);

  const handleDidDismiss = useCallback(() => {
    hasPresented.current = false;
    onClose();
  }, [onClose]);

  const trigger = useCallback((action: () => void) => {
    Haptics.selectionAsync().catch(() => {});
    action();
  }, []);

  useEffect(() => {
    if (visible) {
      hasPresented.current = true;
      void sheetRef.current?.present(0);
    } else if (hasPresented.current) {
      void sheetRef.current?.dismiss();
    }
  }, [visible]);

  useEffect(() => {
    return () => {
      if (hasPresented.current) {
        void sheetRef.current?.dismiss();
      }
    };
  }, []);

  return (
    <TrueSheet
      ref={sheetRef}
      detents={["auto"]}
      onDidDismiss={handleDidDismiss}
      {...SHEET_THEME}
    >
      <View style={styles.sheetContent}>
        {/* Drag Handle */}
        <RNView style={styles.dragHandle} />

        {/* Icon Grid */}
        <RNView style={styles.grid}>
          <Pressable
            onPress={() => trigger(onToggleScreenShare)}
            style={({ pressed }) => [
              styles.gridItem,
              isScreenSharing && styles.gridItemActive,
              pressed && styles.gridItemPressed,
            ]}
            accessibilityRole="button"
            accessibilityLabel="Toggle screen sharing"
            accessibilityState={{ selected: isScreenSharing }}
          >
            <ScreenShare
              size={28}
              color={isScreenSharing ? COLORS.dark : SHEET_COLORS.text}
              strokeWidth={1.5}
            />
          </Pressable>

          <Pressable
            onPress={() => trigger(onToggleHandRaised)}
            style={({ pressed }) => [
              styles.gridItem,
              isHandRaised && styles.gridItemHandActive,
              pressed && styles.gridItemPressed,
            ]}
            accessibilityRole="button"
            accessibilityLabel="Toggle raise hand"
            accessibilityState={{ selected: isHandRaised }}
          >
            <Hand
              size={28}
              color={isHandRaised ? COLORS.dark : SHEET_COLORS.text}
              strokeWidth={1.5}
            />
          </Pressable>
        </RNView>
      </View>
    </TrueSheet>
  );
}

const styles = StyleSheet.create({
  sheetContent: {
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 32,
    alignItems: "center",
  },
  dragHandle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: SHEET_COLORS.border,
    opacity: 0.4,
    alignSelf: "center",
    marginBottom: 24,
  },
  grid: {
    flexDirection: "row",
    gap: 12,
    justifyContent: "center",
    alignSelf: "center",
  },
  gridItem: {
    width: 80,
    height: 80,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: SHEET_COLORS.surface,
    borderWidth: 1,
    borderColor: SHEET_COLORS.border,
    position: "relative",
  },
  gridItemActive: {
    backgroundColor: "rgba(249, 95, 74, 0.65)",
    borderColor: "rgba(249, 95, 74, 0.9)",
    shadowColor: "rgba(249, 95, 74, 0.6)",
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.6,
    shadowRadius: 12,
    elevation: 6,
  },
  gridItemHandActive: {
    backgroundColor: "rgba(251, 191, 36, 0.65)",
    borderColor: "rgba(251, 191, 36, 0.9)",
    shadowColor: "rgba(251, 191, 36, 0.55)",
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.6,
    shadowRadius: 12,
    elevation: 6,
  },
  gridItemPressed: {
    opacity: 0.7,
    transform: [{ scale: 0.96 }],
  },
});

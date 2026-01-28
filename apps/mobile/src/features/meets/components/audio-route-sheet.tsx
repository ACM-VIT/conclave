import React, { useCallback, useEffect, useRef } from "react";
import { StyleSheet } from "react-native";
import * as Haptics from "expo-haptics";
import { TrueSheet } from "@lodev09/react-native-true-sheet";
import { Pressable, Text, View } from "@/tw";
import { SHEET_COLORS, SHEET_THEME } from "./true-sheet-theme";

export type AudioRoute = "speaker" | "earpiece";

interface AudioRouteSheetProps {
  visible: boolean;
  currentRoute: AudioRoute;
  onSelect: (route: AudioRoute) => void;
  onClose: () => void;
}

export function AudioRouteSheet({
  visible,
  currentRoute,
  onSelect,
  onClose,
}: AudioRouteSheetProps) {
  const sheetRef = useRef<TrueSheet>(null);
  const hasPresented = useRef(false);

  const handleDismiss = useCallback(() => {
    void sheetRef.current?.dismiss();
  }, []);

  const handleDidDismiss = useCallback(() => {
    hasPresented.current = false;
    onClose();
  }, [onClose]);

  const handleSelect = useCallback(
    (route: AudioRoute) => {
      Haptics.selectionAsync().catch(() => {});
      onSelect(route);
    },
    [onSelect]
  );

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
      detents={["auto", 0.4]}
      onDidDismiss={handleDidDismiss}
      {...SHEET_THEME}
    >
      <View style={styles.sheetContent}>
        <View style={styles.headerRow}>
          <Text style={styles.headerText}>Audio Output</Text>
          <Pressable onPress={handleDismiss} style={styles.closeButton}>
            <Text style={styles.closeText}>Done</Text>
          </Pressable>
        </View>

        <View style={styles.optionsRow}>
          <Pressable
            style={[
              styles.optionButton,
              currentRoute === "speaker" && styles.optionButtonActive,
            ]}
            onPress={() => handleSelect("speaker")}
          >
            <Text style={styles.optionText}>Speaker</Text>
          </Pressable>
          <Pressable
            style={[
              styles.optionButton,
              currentRoute === "earpiece" && styles.optionButtonActive,
            ]}
            onPress={() => handleSelect("earpiece")}
          >
            <Text style={styles.optionText}>Earpiece</Text>
          </Pressable>
        </View>

        <Text style={styles.helperText}>
          Bluetooth and wired headsets can be selected from the system audio picker.
        </Text>
      </View>
    </TrueSheet>
  );
}

const styles = StyleSheet.create({
  sheetContent: {
    paddingHorizontal: 16,
    paddingBottom: 16,
    gap: 12,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 8,
  },
  headerText: {
    fontSize: 16,
    fontWeight: "600",
    color: SHEET_COLORS.text,
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
    fontSize: 12,
    color: SHEET_COLORS.text,
  },
  optionsRow: {
    flexDirection: "row",
    gap: 10,
  },
  optionButton: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(254, 252, 217, 0.06)",
    borderWidth: 1,
    borderColor: SHEET_COLORS.border,
  },
  optionButtonActive: {
    backgroundColor: "rgba(249, 95, 74, 0.2)",
    borderColor: "rgba(249, 95, 74, 0.5)",
  },
  optionText: {
    fontSize: 14,
    color: SHEET_COLORS.text,
  },
  helperText: {
    fontSize: 12,
    color: SHEET_COLORS.textMuted,
  },
});

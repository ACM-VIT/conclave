import React, { useCallback, useEffect, useMemo, useRef } from "react";
import { StyleSheet } from "react-native";
import * as Haptics from "expo-haptics";
import type { ReactionOption } from "../types";
import { TrueSheet } from "@lodev09/react-native-true-sheet";
import { reactionAssetMap } from "../reaction-assets";
import { FlatList, Pressable, Text, View, Image } from "@/tw";
import { SHEET_COLORS, SHEET_THEME } from "./true-sheet-theme";

interface ReactionSheetProps {
  visible: boolean;
  options: ReactionOption[];
  onSelect: (reaction: ReactionOption) => void;
  onClose: () => void;
}

export function ReactionSheet({
  visible,
  options,
  onSelect,
  onClose,
}: ReactionSheetProps) {
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
    (reaction: ReactionOption) => {
      Haptics.selectionAsync().catch(() => {});
      onSelect(reaction);
    },
    [onSelect]
  );

  const gridData = useMemo(() => options, [options]);

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
      detents={["auto", 0.55]}
      scrollable
      onDidDismiss={handleDidDismiss}
      {...SHEET_THEME}
    >
      <View style={styles.sheetContent}>
        <View style={styles.headerRow}>
          <Text style={styles.headerText}>Reactions</Text>
          <Pressable onPress={handleDismiss} style={styles.closeButton}>
            <Text style={styles.closeText}>Done</Text>
          </Pressable>
        </View>

        <FlatList
          data={gridData}
          keyExtractor={(item) => item.id}
          numColumns={4}
          contentContainerStyle={styles.grid}
          renderItem={({ item }) => (
            <Pressable
              style={styles.reactionItem}
              onPress={() => handleSelect(item)}
            >
              {item.kind === "emoji" ? (
                <Text style={styles.reactionEmoji}>{item.value}</Text>
              ) : reactionAssetMap[item.value] ? (
                <Image source={reactionAssetMap[item.value]} style={styles.reactionAsset} />
              ) : (
                <Text style={styles.reactionEmoji}>✨</Text>
              )}
            </Pressable>
          )}
        />
      </View>
    </TrueSheet>
  );
}

const styles = StyleSheet.create({
  sheetContent: {
    paddingHorizontal: 16,
    paddingBottom: 16,
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
  grid: {
    gap: 12,
    paddingTop: 8,
  },
  reactionItem: {
    width: "25%",
    aspectRatio: 1,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(254, 252, 217, 0.06)",
    borderWidth: 1,
    borderColor: SHEET_COLORS.border,
    marginBottom: 12,
  },
  reactionEmoji: {
    fontSize: 22,
    color: SHEET_COLORS.text,
  },
  reactionAsset: {
    width: 28,
    height: 28,
  },
});

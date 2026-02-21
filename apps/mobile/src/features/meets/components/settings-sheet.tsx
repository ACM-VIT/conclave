import React, { useCallback, useEffect, useRef } from "react";
import { StyleSheet, View as RNView } from "react-native";
import * as Haptics from "expo-haptics";
import { TrueSheet } from "@lodev09/react-native-true-sheet";
import { Pressable, View } from "@/tw";
import {
  ClipboardPenLine,
  Hand,
  Lock,
  LockOpen,
  MessageSquareLock,
  StickyNote,
  UserMinus,
  VolumeX,
} from "lucide-react-native";
import { useApps } from "@conclave/apps-sdk";
import { SHEET_COLORS, SHEET_THEME } from "./true-sheet-theme";

interface SettingsSheetProps {
  visible: boolean;
  isHandRaised: boolean;
  isRoomLocked: boolean;
  isNoGuests: boolean;
  isChatLocked: boolean;
  isTtsDisabled: boolean;
  isAdmin?: boolean;
  onOpenDisplayName?: () => void;
  onToggleHandRaised: () => void;
  onToggleRoomLock?: (locked: boolean) => void;
  onToggleNoGuests?: (noGuests: boolean) => void;
  onToggleChatLock?: (locked: boolean) => void;
  onToggleTtsDisabled?: (disabled: boolean) => void;
  onClose: () => void;
}

export function SettingsSheet({
  visible,
  isHandRaised,
  isRoomLocked,
  isNoGuests,
  isChatLocked,
  isTtsDisabled,
  isAdmin = false,
  onOpenDisplayName,
  onToggleHandRaised,
  onToggleRoomLock,
  onToggleNoGuests,
  onToggleChatLock,
  onToggleTtsDisabled,
  onClose,
}: SettingsSheetProps) {
  const { state: appsState, openApp, closeApp } = useApps();
  const sheetRef = useRef<TrueSheet>(null);
  const hasPresented = useRef(false);
  const isWhiteboardActive = appsState.activeAppId === "whiteboard";

  const handleDismiss = useCallback(() => {
    void sheetRef.current?.dismiss();
  }, []);

  const handleToggleWhiteboard = useCallback(() => {
    if (isWhiteboardActive) {
      closeApp();
      return;
    }
    openApp("whiteboard");
  }, [closeApp, isWhiteboardActive, openApp]);

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
        <RNView style={styles.dragHandle} />

        <RNView style={styles.grid}>
          {isAdmin ? (
            <Pressable
              onPress={() =>
                trigger(() => {
                  handleToggleWhiteboard();
                  handleDismiss();
                })
              }
              style={({ pressed }) => [
                styles.gridItem,
                isWhiteboardActive && styles.gridItemActive,
                pressed && styles.gridItemPressed,
              ]}
              accessibilityRole="button"
              accessibilityLabel={
                isWhiteboardActive ? "Close whiteboard" : "Open whiteboard"
              }
              accessibilityState={{ selected: isWhiteboardActive }}
            >
              <StickyNote
                size={28}
                color={SHEET_COLORS.text}
                fill={isWhiteboardActive ? "rgba(254, 252, 217, 0.35)" : "transparent"}
                strokeWidth={1.5}
              />
            </Pressable>
          ) : null}

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
              color={SHEET_COLORS.text}
              fill={isHandRaised ? "rgba(0, 0, 0, 0.35)" : "transparent"}
              strokeWidth={1.5}
            />
          </Pressable>

          <Pressable
            onPress={() => {
              if (!onOpenDisplayName) return;
              trigger(onOpenDisplayName);
            }}
            style={({ pressed }) => [
              styles.gridItem,
              pressed && styles.gridItemPressed,
            ]}
            accessibilityRole="button"
            accessibilityLabel="Change display name"
          >
            <ClipboardPenLine size={28} color={SHEET_COLORS.text} strokeWidth={1.5} />
          </Pressable>

          {isAdmin ? (
            <Pressable
              onPress={() => {
                if (!onToggleRoomLock) return;
                trigger(() => onToggleRoomLock(!isRoomLocked));
              }}
              style={({ pressed }) => [
                styles.gridItem,
                isRoomLocked && styles.gridItemLockActive,
                pressed && styles.gridItemPressed,
              ]}
              accessibilityRole="button"
              accessibilityLabel={isRoomLocked ? "Unlock room" : "Lock room"}
              accessibilityState={{ selected: isRoomLocked }}
            >
              {isRoomLocked ? (
                <Lock
                  size={28}
                  color={SHEET_COLORS.text}
                  strokeWidth={1.5}
                />
              ) : (
                <LockOpen
                  size={28}
                  color={SHEET_COLORS.text}
                  strokeWidth={1.5}
                />
              )}
            </Pressable>
          ) : null}
          {isAdmin ? (
            <Pressable
              onPress={() => {
                if (!onToggleNoGuests) return;
                trigger(() => onToggleNoGuests(!isNoGuests));
              }}
              style={({ pressed }) => [
                styles.gridItem,
                isNoGuests && styles.gridItemHandActive,
                pressed && styles.gridItemPressed,
              ]}
              accessibilityRole="button"
              accessibilityLabel={isNoGuests ? "Allow guests" : "Block guests"}
              accessibilityState={{ selected: isNoGuests }}
            >
              <UserMinus size={28} color={SHEET_COLORS.text} strokeWidth={1.5} />
            </Pressable>
          ) : null}
          {isAdmin ? (
            <Pressable
              onPress={() => {
                if (!onToggleChatLock) return;
                trigger(() => onToggleChatLock(!isChatLocked));
              }}
              style={({ pressed }) => [
                styles.gridItem,
                isChatLocked && styles.gridItemLockActive,
                pressed && styles.gridItemPressed,
              ]}
              accessibilityRole="button"
              accessibilityLabel={isChatLocked ? "Unlock chat" : "Lock chat"}
              accessibilityState={{ selected: isChatLocked }}
            >
              <MessageSquareLock
                size={28}
                color={SHEET_COLORS.text}
                strokeWidth={1.5}
              />
            </Pressable>
          ) : null}
          {isAdmin ? (
            <Pressable
              onPress={() => {
                if (!onToggleTtsDisabled) return;
                trigger(() => onToggleTtsDisabled(!isTtsDisabled));
              }}
              style={({ pressed }) => [
                styles.gridItem,
                isTtsDisabled && styles.gridItemActive,
                pressed && styles.gridItemPressed,
              ]}
              accessibilityRole="button"
              accessibilityLabel={isTtsDisabled ? "Enable text to speech" : "Disable text to speech"}
              accessibilityState={{ selected: isTtsDisabled }}
            >
              <VolumeX size={28} color={SHEET_COLORS.text} strokeWidth={1.5} />
            </Pressable>
          ) : null}
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
    flexWrap: "wrap",
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
  gridItemLockActive: {
    backgroundColor: "rgba(76, 168, 255, 0.55)",
    borderColor: "rgba(76, 168, 255, 0.85)",
    shadowColor: "rgba(76, 168, 255, 0.55)",
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

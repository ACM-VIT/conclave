import React, { useCallback, useEffect, useRef } from "react";
import { StyleSheet } from "react-native";
import * as Haptics from "expo-haptics";
import { TrueSheet } from "@lodev09/react-native-true-sheet";
import {
  AtSign,
  Hand,
  Link2,
  Lock,
  LockOpen,
  MessageCircle,
  MessageSquareLock,
  ScreenShare,
  Smile,
  StickyNote,
  UserMinus,
  Users,
  VolumeX,
} from "lucide-react-native";
import { ScrollView, Pressable, Text, View } from "@/tw";
import { SHEET_COLORS, SHEET_THEME } from "./true-sheet-theme";

type IconCmp = React.ComponentType<{
  color?: string;
  size?: number;
  strokeWidth?: number;
}>;

interface MoreSheetProps {
  isOpen: boolean;
  isHandRaised: boolean;
  isScreenSharing: boolean;
  isScreenShareAvailable?: boolean;
  isChatOpen: boolean;
  isRoomLocked: boolean;
  isNoGuests: boolean;
  isChatLocked: boolean;
  isTtsDisabled: boolean;
  isDmEnabled: boolean;
  isAdmin: boolean;
  isWhiteboardActive?: boolean;
  showWhiteboardControl?: boolean;
  isAppsLocked?: boolean;
  pendingUsersCount: number;
  unreadCount: number;
  showParticipantsControl?: boolean;
  onToggleScreenShare: () => void;
  onToggleHand: () => void;
  onToggleChat: () => void;
  onToggleParticipants: () => void;
  onOpenReactions: () => void;
  onShareLink: () => void;
  onToggleRoomLock?: (locked: boolean) => void;
  onToggleNoGuests?: (noGuests: boolean) => void;
  onToggleChatLock?: (locked: boolean) => void;
  onToggleTtsDisabled?: (disabled: boolean) => void;
  onToggleDmEnabled?: (enabled: boolean) => void;
  onToggleWhiteboard?: () => void;
  onToggleAppsLock?: (locked: boolean) => void;
  onClose: () => void;
}

function ActionRow({
  icon: Icon,
  label,
  active = false,
  warning = false,
  badge,
  status,
  onPress,
}: {
  icon: IconCmp;
  label: string;
  active?: boolean;
  warning?: boolean;
  badge?: number;
  status?: string;
  onPress: () => void;
}) {
  const accent = warning ? SHEET_COLORS.warning : SHEET_COLORS.accent;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
    >
      <View style={[styles.rowIcon, active && { backgroundColor: warning ? "rgba(251, 191, 36, 0.15)" : "rgba(249, 95, 74, 0.15)" }]}>
        <Icon
          color={active ? accent : SHEET_COLORS.text}
          size={22}
          strokeWidth={1.75}
        />
      </View>
      <Text style={[styles.rowLabel, active && { color: accent }]} numberOfLines={1}>
        {label}
      </Text>
      {typeof badge === "number" && badge > 0 ? (
        <View style={styles.badge}>
          <Text style={styles.badgeText}>{badge > 9 ? "9+" : badge}</Text>
        </View>
      ) : status ? (
        <Text style={[styles.rowStatus, active && { color: accent }]}>{status}</Text>
      ) : null}
    </Pressable>
  );
}

export function MoreSheet({
  isOpen,
  isHandRaised,
  isScreenSharing,
  isScreenShareAvailable = true,
  isChatOpen,
  isRoomLocked,
  isNoGuests,
  isChatLocked,
  isTtsDisabled,
  isDmEnabled,
  isAdmin,
  isWhiteboardActive = false,
  showWhiteboardControl = true,
  isAppsLocked = false,
  pendingUsersCount,
  unreadCount,
  showParticipantsControl = true,
  onToggleScreenShare,
  onToggleHand,
  onToggleChat,
  onToggleParticipants,
  onOpenReactions,
  onShareLink,
  onToggleRoomLock,
  onToggleNoGuests,
  onToggleChatLock,
  onToggleTtsDisabled,
  onToggleDmEnabled,
  onToggleWhiteboard,
  onToggleAppsLock,
  onClose,
}: MoreSheetProps) {
  const sheetRef = useRef<TrueSheet>(null);
  const hasPresented = useRef(false);

  const handleDismiss = useCallback(() => {
    void sheetRef.current?.dismiss();
  }, []);

  const handleDidDismiss = useCallback(() => {
    hasPresented.current = false;
    onClose();
  }, [onClose]);

  const runAction = useCallback((action: () => void) => {
    Haptics.selectionAsync().catch(() => {});
    action();
    void sheetRef.current?.dismiss();
  }, []);

  useEffect(() => {
    if (isOpen) {
      hasPresented.current = true;
      void sheetRef.current?.present(0);
    } else if (hasPresented.current) {
      void sheetRef.current?.dismiss();
    }
  }, [isOpen]);

  useEffect(() => {
    return () => {
      if (hasPresented.current) {
        void sheetRef.current?.dismiss();
      }
    };
  }, []);

  const canScreenShare = isScreenSharing || isScreenShareAvailable;

  return (
    <TrueSheet
      ref={sheetRef}
      detents={["auto", 0.75]}
      scrollable
      onDidDismiss={handleDidDismiss}
      {...SHEET_THEME}
    >
      <View style={styles.sheetContent}>
        <View style={styles.headerRow}>
          <Text style={styles.headerText}>More</Text>
          <Pressable onPress={handleDismiss} style={styles.closeButton}>
            <Text style={styles.closeText}>Done</Text>
          </Pressable>
        </View>

        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
        >
          {showParticipantsControl ? (
            <ActionRow
              icon={Users}
              label="Participants"
              badge={pendingUsersCount}
              onPress={() => runAction(onToggleParticipants)}
            />
          ) : null}

          <ActionRow
            icon={MessageCircle}
            label="Chat"
            active={isChatOpen}
            badge={unreadCount}
            onPress={() => runAction(onToggleChat)}
          />

          <ActionRow
            icon={Smile}
            label="Reactions"
            onPress={() => runAction(onOpenReactions)}
          />

          <ActionRow
            icon={Hand}
            label={isHandRaised ? "Lower hand" : "Raise hand"}
            active={isHandRaised}
            warning
            onPress={() => runAction(onToggleHand)}
          />

          {canScreenShare ? (
            <ActionRow
              icon={ScreenShare}
              label={isScreenSharing ? "Stop sharing" : "Share screen"}
              active={isScreenSharing}
              status={isScreenSharing ? "Live" : undefined}
              onPress={() => runAction(onToggleScreenShare)}
            />
          ) : null}

          {showWhiteboardControl && onToggleWhiteboard ? (
            <ActionRow
              icon={StickyNote}
              label={isWhiteboardActive ? "Close whiteboard" : "Open whiteboard"}
              active={isWhiteboardActive}
              status={isWhiteboardActive ? "Live" : undefined}
              onPress={() => runAction(onToggleWhiteboard)}
            />
          ) : null}

          <ActionRow
            icon={Link2}
            label="Share link"
            onPress={() => runAction(onShareLink)}
          />

          {isAdmin ? (
            <>
              <Text style={styles.sectionLabel}>Host</Text>

              {onToggleRoomLock ? (
                <ActionRow
                  icon={isRoomLocked ? Lock : LockOpen}
                  label={isRoomLocked ? "Unlock meeting" : "Lock meeting"}
                  active={isRoomLocked}
                  warning
                  onPress={() => runAction(() => onToggleRoomLock(!isRoomLocked))}
                />
              ) : null}

              {onToggleNoGuests ? (
                <ActionRow
                  icon={UserMinus}
                  label={isNoGuests ? "Allow guests" : "Block guests"}
                  active={isNoGuests}
                  warning
                  onPress={() => runAction(() => onToggleNoGuests(!isNoGuests))}
                />
              ) : null}

              {onToggleChatLock ? (
                <ActionRow
                  icon={MessageSquareLock}
                  label={isChatLocked ? "Enable chat" : "Disable chat"}
                  active={isChatLocked}
                  warning
                  onPress={() => runAction(() => onToggleChatLock(!isChatLocked))}
                />
              ) : null}

              {onToggleTtsDisabled ? (
                <ActionRow
                  icon={VolumeX}
                  label={isTtsDisabled ? "Enable TTS" : "Disable TTS"}
                  active={isTtsDisabled}
                  onPress={() => runAction(() => onToggleTtsDisabled(!isTtsDisabled))}
                />
              ) : null}

              {onToggleDmEnabled ? (
                <ActionRow
                  icon={AtSign}
                  label={isDmEnabled ? "Disable DMs" : "Enable DMs"}
                  active={!isDmEnabled}
                  warning
                  onPress={() => runAction(() => onToggleDmEnabled(!isDmEnabled))}
                />
              ) : null}

              {onToggleAppsLock && isWhiteboardActive ? (
                <ActionRow
                  icon={isAppsLocked ? Lock : LockOpen}
                  label={isAppsLocked ? "Unlock whiteboard" : "Lock whiteboard"}
                  active={isAppsLocked}
                  warning
                  onPress={() => runAction(() => onToggleAppsLock(!isAppsLocked))}
                />
              ) : null}
            </>
          ) : null}
        </ScrollView>
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
    backgroundColor: "rgba(250, 250, 250, 0.08)",
    borderWidth: 1,
    borderColor: SHEET_COLORS.border,
  },
  closeText: {
    fontSize: 12,
    color: SHEET_COLORS.text,
  },
  scroll: {
    maxHeight: 520,
  },
  scrollContent: {
    paddingTop: 8,
    paddingBottom: 8,
    gap: 4,
  },
  sectionLabel: {
    fontSize: 11,
    fontWeight: "600",
    letterSpacing: 1,
    textTransform: "uppercase",
    color: SHEET_COLORS.textMuted,
    marginTop: 16,
    marginBottom: 4,
    paddingHorizontal: 4,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderRadius: 16,
    backgroundColor: SHEET_COLORS.row,
    borderWidth: 1,
    borderColor: SHEET_COLORS.border,
  },
  rowPressed: {
    opacity: 0.8,
    backgroundColor: "rgba(250, 250, 250, 0.06)",
  },
  rowIcon: {
    width: 40,
    height: 40,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(250, 250, 250, 0.06)",
  },
  rowLabel: {
    flex: 1,
    fontSize: 15,
    fontWeight: "500",
    color: SHEET_COLORS.text,
  },
  rowStatus: {
    fontSize: 10,
    letterSpacing: 1.4,
    textTransform: "uppercase",
    color: SHEET_COLORS.textMuted,
  },
  badge: {
    minWidth: 20,
    height: 20,
    paddingHorizontal: 6,
    borderRadius: 10,
    backgroundColor: SHEET_COLORS.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  badgeText: {
    fontSize: 11,
    fontWeight: "700",
    color: "#ffffff",
  },
});

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { StyleSheet } from "react-native";
import type { Participant } from "../types";
import { TrueSheet } from "@lodev09/react-native-true-sheet";
import { FlatList, Pressable, Text, View } from "@/tw";
import { SHEET_COLORS, SHEET_THEME } from "./true-sheet-theme";

interface ParticipantsPanelProps {
  participants: Participant[];
  localParticipant: Participant;
  currentUserId: string;
  resolveDisplayName: (userId: string) => string;
  onClose: () => void;
  pendingUsers?: Map<string, string>;
  isAdmin?: boolean;
  hostUserId?: string | null;
  hostUserIds?: string[];
  onAdmitPendingUser?: (userId: string) => void;
  onRejectPendingUser?: (userId: string) => void;
  onPromoteHost?: (userId: string) => Promise<boolean> | boolean;
  visible?: boolean;
}

export function ParticipantsPanel({
  participants,
  localParticipant,
  currentUserId,
  resolveDisplayName,
  onClose,
  pendingUsers,
  isAdmin = false,
  hostUserId,
  hostUserIds,
  onAdmitPendingUser,
  onRejectPendingUser,
  onPromoteHost,
  visible = true,
}: ParticipantsPanelProps) {
  const sheetRef = useRef<TrueSheet>(null);
  const hasPresented = useRef(false);
  const [pendingPromoteUserId, setPendingPromoteUserId] = useState<string | null>(
    null
  );
  const [promotingUserId, setPromotingUserId] = useState<string | null>(null);

  const effectiveHostUserId = hostUserId ?? (isAdmin ? currentUserId : null);
  const effectiveHostUserIds = new Set<string>(
    hostUserIds && hostUserIds.length > 0
      ? hostUserIds
      : effectiveHostUserId
        ? [effectiveHostUserId]
        : []
  );

  const handleDismiss = useCallback(() => {
    void sheetRef.current?.dismiss();
  }, []);

  const handleDidDismiss = useCallback(() => {
    hasPresented.current = false;
    setPendingPromoteUserId(null);
    setPromotingUserId(null);
    onClose();
  }, [onClose]);

  const data = useMemo(() => {
    const map = new Map<string, Participant>();
    for (const participant of participants) {
      map.set(participant.userId, participant);
    }
    if (localParticipant) {
      map.set(localParticipant.userId, {
        ...(map.get(localParticipant.userId) ?? localParticipant),
        ...localParticipant,
      });
    }
    const ordered: Participant[] = [];
    if (localParticipant) {
      const local = map.get(localParticipant.userId);
      if (local) ordered.push(local);
    }
    for (const [userId, participant] of map.entries()) {
      if (localParticipant && userId === localParticipant.userId) continue;
      ordered.push(participant);
    }
    return ordered;
  }, [participants, localParticipant]);

  const pendingList = useMemo(() => {
    if (!pendingUsers || pendingUsers.size === 0) return [];
    return Array.from(pendingUsers.entries());
  }, [pendingUsers]);

  const beginHostPromotion = useCallback(
    (userId: string) => {
      if (!onPromoteHost || promotingUserId) return;
      setPendingPromoteUserId(userId);
    },
    [onPromoteHost, promotingUserId]
  );

  const cancelHostPromotion = useCallback(() => {
    if (promotingUserId) return;
    setPendingPromoteUserId(null);
  }, [promotingUserId]);

  const confirmHostPromotion = useCallback(
    async (userId: string) => {
      if (!onPromoteHost) return;
      setPromotingUserId(userId);
      try {
        await Promise.resolve(onPromoteHost(userId));
      } finally {
        setPromotingUserId(null);
        setPendingPromoteUserId(null);
      }
    },
    [onPromoteHost]
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
      detents={[0.6, 1]}
      scrollable
      onDidDismiss={handleDidDismiss}
      {...SHEET_THEME}
    >
      <View style={styles.sheetContent}>
        <View style={styles.headerRow}>
          <Text style={styles.headerText}>
            Participants ({data.length})
          </Text>
          <Pressable onPress={handleDismiss} style={styles.closeButton}>
            <Text style={styles.closeText}>Done</Text>
          </Pressable>
        </View>

        {isAdmin && pendingList.length > 0 ? (
          <View style={styles.pendingSection}>
            <View style={styles.pendingHeader}>
              <Text style={styles.pendingTitle}>
                Waiting ({pendingList.length})
              </Text>
            </View>
            <View style={styles.pendingList}>
              {pendingList.map(([userId, displayName]) => (
                <View key={userId} style={styles.pendingRow}>
                  <Text style={styles.pendingName} numberOfLines={1}>
                    {displayName || userId}
                  </Text>
                  <View style={styles.pendingActions}>
                    <Pressable
                      onPress={() => onRejectPendingUser?.(userId)}
                      style={({ pressed }) => [
                        styles.pendingIconButton,
                        styles.pendingReject,
                        pressed && styles.pendingButtonPressed,
                      ]}
                      accessibilityRole="button"
                      accessibilityLabel="Reject"
                    >
                      <Text style={styles.pendingRejectIcon}>✕</Text>
                    </Pressable>
                    <Pressable
                      onPress={() => onAdmitPendingUser?.(userId)}
                      style={({ pressed }) => [
                        styles.pendingIconButton,
                        styles.pendingAdmit,
                        pressed && styles.pendingButtonPressed,
                      ]}
                      accessibilityRole="button"
                      accessibilityLabel="Admit"
                    >
                      <Text style={styles.pendingAdmitIcon}>✓</Text>
                    </Pressable>
                  </View>
                </View>
              ))}
            </View>
          </View>
        ) : null}

        <FlatList
          data={data}
          keyExtractor={(item) => item.userId}
          contentContainerStyle={styles.listContent}
          renderItem={({ item }) => {
            const isYou = item.userId === currentUserId;
            const isHost = effectiveHostUserIds.has(item.userId);
            const statusParts: string[] = [];
            if (item.isMuted) statusParts.push("Muted");
            if (item.isCameraOff) statusParts.push("Cam Off");
            if (item.isHandRaised) statusParts.push("✋");
            const canPromote =
              Boolean(onPromoteHost) &&
              isAdmin &&
              !isYou &&
              !isHost &&
              !item.isGhost;
            const isPendingPromotion = pendingPromoteUserId === item.userId;
            const isPromoting = promotingUserId === item.userId;
            return (
              <View style={styles.row}>
                <View style={styles.rowLeft}>
                  <Text style={styles.nameText} numberOfLines={1}>
                    {resolveDisplayName(item.userId)}
                    {isYou ? (
                      <Text style={styles.youLabel}> (You)</Text>
                    ) : null}
                  </Text>
                  {isHost ? <Text style={styles.hostBadge}>Host</Text> : null}
                </View>
                <View style={styles.rowRight}>
                  {statusParts.length ? (
                    <Text style={styles.statusText}>
                      {statusParts.join(" · ")}
                    </Text>
                  ) : null}
                  {canPromote ? (
                    <View style={styles.promoteRow}>
                      {isPendingPromotion ? (
                        <>
                          <Pressable
                            onPress={() => confirmHostPromotion(item.userId)}
                            disabled={isPromoting}
                            style={({ pressed }) => [
                              styles.promoteButton,
                              styles.promoteConfirm,
                              pressed && styles.pendingButtonPressed,
                              isPromoting && styles.promoteDisabled,
                            ]}
                            accessibilityRole="button"
                            accessibilityLabel="Confirm host promotion"
                          >
                            <Text style={[styles.promoteText, styles.promoteConfirmText]}>
                              {isPromoting ? "Promoting" : "Confirm"}
                            </Text>
                          </Pressable>
                          <Pressable
                            onPress={cancelHostPromotion}
                            disabled={isPromoting}
                            style={({ pressed }) => [
                              styles.promoteButton,
                              styles.promoteCancel,
                              pressed && styles.pendingButtonPressed,
                              isPromoting && styles.promoteDisabled,
                            ]}
                            accessibilityRole="button"
                            accessibilityLabel="Cancel host promotion"
                          >
                            <Text style={styles.promoteText}>Cancel</Text>
                          </Pressable>
                        </>
                      ) : (
                        <Pressable
                          onPress={() => beginHostPromotion(item.userId)}
                          disabled={isPromoting}
                          style={({ pressed }) => [
                            styles.promoteButton,
                            pressed && styles.pendingButtonPressed,
                            isPromoting && styles.promoteDisabled,
                          ]}
                          accessibilityRole="button"
                          accessibilityLabel="Promote to host"
                        >
                          <Text style={styles.promoteText}>Host</Text>
                        </Pressable>
                      )}
                    </View>
                  ) : null}
                </View>
              </View>
            );
          }}
        />
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
  listContent: {
    gap: 12,
    paddingBottom: 12,
  },
  pendingSection: {
    marginBottom: 12,
    borderRadius: 16,
    padding: 12,
    backgroundColor: "rgba(254, 252, 217, 0.04)",
    borderWidth: 1,
    borderColor: SHEET_COLORS.border,
  },
  pendingHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 10,
  },
  pendingTitle: {
    fontSize: 12,
    color: "rgba(249, 95, 74, 0.85)",
    textTransform: "uppercase",
    letterSpacing: 1.2,
  },
  pendingList: {
    gap: 8,
  },
  pendingRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  pendingName: {
    flex: 1,
    fontSize: 13,
    color: SHEET_COLORS.text,
  },
  pendingActions: {
    flexDirection: "row",
    gap: 6,
  },
  pendingIconButton: {
    width: 28,
    height: 28,
    borderRadius: 8,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  pendingReject: {
    borderColor: "rgba(239, 68, 68, 0.5)",
    backgroundColor: "rgba(239, 68, 68, 0.15)",
  },
  pendingAdmit: {
    borderColor: "rgba(249, 95, 74, 0.6)",
    backgroundColor: "rgba(249, 95, 74, 0.85)",
  },
  pendingRejectIcon: {
    fontSize: 14,
    fontWeight: "700",
    color: "rgba(248, 113, 113, 0.95)",
  },
  pendingAdmitIcon: {
    fontSize: 14,
    fontWeight: "700",
    color: "#16a34a",
  },
  pendingButtonPressed: {
    opacity: 0.7,
    transform: [{ scale: 0.98 }],
  },
  row: {
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderRadius: 14,
    backgroundColor: "rgba(254, 252, 217, 0.04)",
    borderWidth: 1,
    borderColor: SHEET_COLORS.border,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  rowLeft: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  nameText: {
    fontSize: 14,
    color: SHEET_COLORS.text,
  },
  hostBadge: {
    fontSize: 10,
    textTransform: "uppercase",
    letterSpacing: 1,
    color: "rgba(249, 95, 74, 0.85)",
    borderWidth: 1,
    borderColor: "rgba(249, 95, 74, 0.35)",
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 999,
  },
  youLabel: {
    color: "rgba(249, 95, 74, 0.8)",
    fontSize: 12,
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  statusRow: {
    flexDirection: "row",
    gap: 6,
  },
  statusText: {
    fontSize: 12,
    color: SHEET_COLORS.textMuted,
  },
  rowRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  promoteRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  promoteButton: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: SHEET_COLORS.border,
    backgroundColor: "rgba(254, 252, 217, 0.04)",
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  promoteConfirm: {
    borderColor: "rgba(249, 95, 74, 0.45)",
    backgroundColor: "rgba(249, 95, 74, 0.12)",
  },
  promoteCancel: {
    borderColor: "rgba(254, 252, 217, 0.2)",
  },
  promoteDisabled: {
    opacity: 0.5,
  },
  promoteText: {
    fontSize: 10,
    textTransform: "uppercase",
    letterSpacing: 1.2,
    color: SHEET_COLORS.textMuted,
  },
  promoteConfirmText: {
    color: "rgba(249, 95, 74, 0.9)",
  },
});

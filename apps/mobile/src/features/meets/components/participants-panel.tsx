import React, { useCallback, useEffect, useMemo, useRef } from "react";
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
  visible?: boolean;
}

export function ParticipantsPanel({
  participants,
  localParticipant,
  currentUserId,
  resolveDisplayName,
  onClose,
  visible = true,
}: ParticipantsPanelProps) {
  const sheetRef = useRef<TrueSheet>(null);
  const hasPresented = useRef(false);

  const handleDismiss = useCallback(() => {
    void sheetRef.current?.dismiss();
  }, []);

  const handleDidDismiss = useCallback(() => {
    hasPresented.current = false;
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

        <FlatList
          data={data}
          keyExtractor={(item) => item.userId}
          contentContainerStyle={styles.listContent}
          renderItem={({ item }) => {
            const isYou = item.userId === currentUserId;
            const statusParts: string[] = [];
            if (item.isMuted) statusParts.push("Muted");
            if (item.isCameraOff) statusParts.push("Cam Off");
            if (item.isHandRaised) statusParts.push("✋");
            return (
              <View style={styles.row}>
                <Text style={styles.nameText}>
                  {resolveDisplayName(item.userId)}
                  {isYou ? (
                    <Text style={styles.youLabel}> (You)</Text>
                  ) : null}
                </Text>
                <View style={styles.statusRow}>
                  {statusParts.length ? (
                    <Text style={styles.statusText}>
                      {statusParts.join(" · ")}
                    </Text>
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
  nameText: {
    fontSize: 14,
    color: SHEET_COLORS.text,
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
});

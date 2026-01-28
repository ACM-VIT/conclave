import React, { useMemo } from "react";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, useWindowDimensions, View as RNView } from "react-native";
import { RTCView } from "react-native-webrtc";
import type { ConnectionState, Participant } from "../types";
import { isSystemUserId } from "../utils";
import { useDeviceLayout, getGridColumns } from "../hooks/use-device-layout";
import { ControlsBar } from "./controls-bar";
import { ParticipantTile } from "./participant-tile";
import { FlatList, Text, Pressable } from "@/tw";
import { Lock, Users, MicOff, VenetianMask } from "lucide-react-native";
import { GlassPill } from "./glass-pill";

const COLORS = {
  primaryOrange: "#F95F4A",
  cream: "#FEFCD9",
  dark: "#060606",
  creamMuted: "rgba(254, 252, 217, 0.5)",
  creamFaint: "rgba(254, 252, 217, 0.1)",
  amber: "#fbbf24",
  amberDim: "rgba(251, 191, 36, 0.2)",
  amberBorder: "rgba(251, 191, 36, 0.3)",
} as const;

interface CallScreenProps {
  roomId: string;
  connectionState: ConnectionState;
  participants: Map<string, Participant>;
  localParticipant: Participant;
  presentationStream?: MediaStream | null;
  presenterName?: string;
  isMuted: boolean;
  isCameraOff: boolean;
  isHandRaised: boolean;
  isScreenSharing: boolean;
  isChatOpen: boolean;
  unreadCount: number;
  isMirrorCamera: boolean;
  activeSpeakerId: string | null;
  resolveDisplayName: (userId: string) => string;
  onToggleMute: () => void;
  onToggleCamera: () => void;
  onToggleScreenShare: () => void;
  onToggleHandRaised: () => void;
  onToggleChat: () => void;
  onToggleParticipants: () => void;
  onToggleRoomLock?: (locked: boolean) => void;
  onSendReaction: (emoji: string) => void;
  onOpenAudio: () => void;
  onLeave: () => void;
  participantCount?: number;
  isRoomLocked?: boolean;
  isAdmin?: boolean;
  pendingUsersCount?: number;
}

const columnWrapperStyle = { gap: 12 } as const;
const columnWrapperStyleTablet = { gap: 16 } as const;

export function CallScreen({
  roomId,
  connectionState,
  participants,
  localParticipant,
  isMuted,
  isCameraOff,
  isHandRaised,
  isScreenSharing,
  isChatOpen,
  unreadCount,
  isMirrorCamera,
  activeSpeakerId,
  resolveDisplayName,
  onToggleMute,
  onToggleCamera,
  onToggleScreenShare,
  onToggleHandRaised,
  onToggleChat,
  onToggleParticipants,
  onToggleRoomLock,
  onSendReaction,
  onOpenAudio,
  onLeave,
  participantCount,
  isRoomLocked = false,
  isAdmin = false,
  pendingUsersCount = 0,
  presentationStream = null,
  presenterName = "",
}: CallScreenProps) {
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const { layout, isTablet, spacing } = useDeviceLayout();

  const participantList = useMemo(() => {
    const list = Array.from(participants.values()).filter(
      (participant) => !isSystemUserId(participant.userId)
    );
    const hasLocal = list.some((participant) => participant.userId === localParticipant.userId);
    return hasLocal ? list : [localParticipant, ...list];
  }, [participants, localParticipant]);

  const displayParticipantCount = participantCount ?? participantList.length;

  const stripParticipants = useMemo(() => {
    const list = Array.from(participants.values()).filter(
      (participant) => !isSystemUserId(participant.userId)
    );
    const hasLocal = list.some(
      (participant) => participant.userId === localParticipant.userId
    );
    return hasLocal ? list : [localParticipant, ...list];
  }, [participants, localParticipant]);

  // Use responsive grid columns based on device layout
  const columns = useMemo(
    () => getGridColumns(participantList.length, layout),
    [participantList.length, layout]
  );

  const safePaddingLeft = Math.max(isTablet ? 12 : 6, insets.left);
  const safePaddingRight = Math.max(isTablet ? 12 : 6, insets.right);
  const availableWidth = width - safePaddingLeft - safePaddingRight;
  const gridGap = isTablet ? 16 : 12;
  const tileWidth = Math.floor((availableWidth - 32 - (columns - 1) * gridGap) / columns);
  const tileStyle = useMemo(
    () => ({
      width: tileWidth,
      height: Math.round(tileWidth * (isTablet ? 10 / 16 : 9 / 16))
    }),
    [tileWidth, isTablet]
  );

  // Strip tile size for presentation mode - larger on iPad
  const stripTileSize = isTablet ? 120 : 88;

  const connectionLabel =
    connectionState === "reconnecting"
      ? "Reconnecting"
      : connectionState === "connecting"
        ? "Connecting"
        : connectionState === "waiting"
          ? "Waiting"
          : null;

  const isPresenting = Boolean(presentationStream);

  return (
    <RNView style={styles.container}>
      <RNView
        style={[
          styles.content,
          {
            paddingTop: insets.top,
            paddingLeft: safePaddingLeft,
            paddingRight: safePaddingRight,
          },
        ]}
      >
        {/* Header */}
        <RNView style={styles.header}>
          <GlassPill style={styles.pillGlass}>
            <RNView style={styles.roomPill}>
              {isRoomLocked ? (
                <Lock size={12} color={COLORS.primaryOrange} />
              ) : null}
              <Text style={styles.roomId} numberOfLines={1}>
                {roomId.toUpperCase()}
              </Text>
            </RNView>
          </GlassPill>

          {connectionLabel ? (
            <RNView style={styles.statusPill}>
              <Text style={styles.statusText}>{connectionLabel}</Text>
            </RNView>
          ) : (
            <Pressable onPress={onToggleParticipants}>
              <GlassPill style={styles.pillGlass}>
                <RNView style={styles.participantsPill}>
                  <Users size={12} color={COLORS.cream} />
                  <Text style={styles.participantsCount}>{displayParticipantCount}</Text>
                </RNView>
              </GlassPill>
            </Pressable>
          )}
        </RNView>

        {isPresenting && presentationStream ? (
          <RNView
            style={[
              styles.presentationContainer,
              { paddingBottom: 140 + insets.bottom },
            ]}
          >
            <RNView style={styles.presentationStage}>
              <RTCView
                streamURL={presentationStream.toURL()}
                style={styles.presentationVideo}
                mirror={false}
                objectFit="contain"
              />
              <RNView style={styles.presenterBadge}>
                <Text style={styles.presenterText}>
                  {presenterName || "Presenter"} is presenting
                </Text>
              </RNView>
            </RNView>

            <FlatList
              data={stripParticipants}
              keyExtractor={(item) => item.userId}
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.stripContent}
              renderItem={({ item }) => {
                const label =
                  item.userId === localParticipant.userId
                    ? "You"
                    : resolveDisplayName(item.userId);
                const initials =
                  label?.trim()?.[0]?.toUpperCase() || "?";
                return (
                  <RNView style={[styles.stripTile, { width: stripTileSize, height: stripTileSize }]}>
                    {item.videoStream && !item.isCameraOff ? (
                      <RTCView
                        streamURL={item.videoStream.toURL()}
                        style={styles.stripVideo}
                        mirror={
                          item.userId === localParticipant.userId
                            ? isMirrorCamera
                            : false
                        }
                        objectFit="cover"
                      />
                    ) : (
                      <RNView style={styles.stripAvatar}>
                        <Text style={styles.stripInitial}>{initials}</Text>
                      </RNView>
                    )}

                    {item.isGhost && (
                      <RNView style={styles.stripGhost}>
                        <VenetianMask size={16} color={COLORS.primaryOrange} />
                      </RNView>
                    )}

                    <RNView style={styles.stripLabel}>
                      <Text style={styles.stripLabelText} numberOfLines={1}>
                        {label}
                      </Text>
                      {item.isMuted && (
                        <MicOff size={12} color={COLORS.primaryOrange} />
                      )}
                    </RNView>
                  </RNView>
                );
              }}
            />
          </RNView>
        ) : (
          /* Video Grid */
          <FlatList
            data={participantList}
            key={`${columns}`}
            numColumns={columns}
            keyExtractor={(item) => item.userId}
            style={styles.grid}
            contentContainerStyle={[
              styles.gridContent,
              { paddingBottom: 140 + insets.bottom },
            ]}
            columnWrapperStyle={columns > 1 ? (isTablet ? columnWrapperStyleTablet : columnWrapperStyle) : undefined}
            renderItem={({ item }) => (
              <RNView style={tileStyle}>
                <ParticipantTile
                  participant={item}
                  displayName={resolveDisplayName(item.userId)}
                  isLocal={item.userId === localParticipant.userId}
                  mirror={item.userId === localParticipant.userId ? isMirrorCamera : false}
                  isActiveSpeaker={activeSpeakerId === item.userId}
                />
              </RNView>
            )}
          />
        )}
      </RNView>

      {/* Controls Bar - positioned absolutely at bottom */}
      <ControlsBar
        isMuted={isMuted}
        isCameraOff={isCameraOff}
        isHandRaised={isHandRaised}
        isScreenSharing={isScreenSharing}
        isChatOpen={isChatOpen}
        isRoomLocked={isRoomLocked}
        isAdmin={isAdmin}
        pendingUsersCount={pendingUsersCount}
        unreadCount={unreadCount}
        availableWidth={availableWidth}
        onToggleMute={onToggleMute}
        onToggleCamera={onToggleCamera}
        onToggleScreenShare={onToggleScreenShare}
        onToggleHand={onToggleHandRaised}
        onToggleChat={onToggleChat}
        onToggleParticipants={onToggleParticipants}
        onToggleRoomLock={onToggleRoomLock}
        onSendReaction={onSendReaction}
        onOpenAudio={onOpenAudio}
        onLeave={onLeave}
      />
    </RNView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.dark,
  },
  content: {
    flex: 1,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  roomPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  pillGlass: {
    borderRadius: 50,
    borderWidth: 1,
    borderColor: COLORS.creamFaint,
  },
  roomId: {
    fontSize: 12,
    fontWeight: "500",
    color: COLORS.cream,
    letterSpacing: 1,
    fontFamily: "PolySans-Mono",
  },
  statusPill: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: COLORS.amberDim,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: COLORS.amberBorder,
  },
  statusText: {
    fontSize: 12,
    fontWeight: "500",
    color: COLORS.amber,
    fontFamily: "PolySans-Mono",
  },
  participantsPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  participantsCount: {
    fontSize: 12,
    fontWeight: "500",
    color: COLORS.cream,
    fontFamily: "PolySans-Mono",
  },
  grid: {
    flex: 1,
  },
  gridContent: {
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 140,
    gap: 12,
  },
  presentationContainer: {
    flex: 1,
    gap: 12,
    paddingHorizontal: 12,
    paddingTop: 8,
  },
  presentationStage: {
    flex: 1,
    borderRadius: 16,
    overflow: "hidden",
    backgroundColor: "#0b0b0b",
    borderWidth: 1,
    borderColor: "rgba(254, 252, 217, 0.08)",
  },
  presentationVideo: {
    width: "100%",
    height: "100%",
  },
  presenterBadge: {
    position: "absolute",
    top: 12,
    left: 12,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: "rgba(0, 0, 0, 0.6)",
    borderWidth: 1,
    borderColor: "rgba(254, 252, 217, 0.12)",
  },
  presenterText: {
    fontSize: 10,
    color: COLORS.cream,
    letterSpacing: 1,
    textTransform: "uppercase",
    fontFamily: "PolySans-Mono",
  },
  stripContent: {
    paddingHorizontal: 4,
    gap: 10,
  },
  stripTile: {
    width: 88,
    height: 88,
    borderRadius: 14,
    overflow: "hidden",
    backgroundColor: "#121212",
    borderWidth: 1,
    borderColor: "rgba(254, 252, 217, 0.1)",
  },
  stripVideo: {
    width: "100%",
    height: "100%",
  },
  stripAvatar: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(249, 95, 74, 0.15)",
  },
  stripInitial: {
    fontSize: 20,
    fontWeight: "700",
    color: COLORS.cream,
    fontFamily: "PolySans-BulkyWide",
  },
  stripGhost: {
    position: "absolute",
    top: 6,
    right: 6,
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: "rgba(0, 0, 0, 0.5)",
    alignItems: "center",
    justifyContent: "center",
  },
  stripLabel: {
    position: "absolute",
    bottom: 6,
    left: 6,
    right: 6,
    paddingHorizontal: 6,
    paddingVertical: 4,
    borderRadius: 10,
    backgroundColor: "rgba(0, 0, 0, 0.6)",
    borderWidth: 1,
    borderColor: "rgba(254, 252, 217, 0.08)",
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  stripLabelText: {
    flex: 1,
    fontSize: 9,
    color: COLORS.cream,
    textTransform: "uppercase",
    letterSpacing: 1,
    fontFamily: "PolySans-Mono",
  },
});

import React, { useMemo } from "react";
import { StyleSheet, View as RNView } from "react-native";
import { RTCView } from "react-native-webrtc";
import { LinearGradient } from "expo-linear-gradient";
import type { Participant } from "../types";
import { useDeviceLayout } from "../hooks/use-device-layout";
import { Text } from "@/tw";
import { Hand, MicOff, VenetianMask } from "lucide-react-native";

const COLORS = {
  primaryOrange: "#F95F4A",
  primaryPink: "#FF007A",
  cream: "#FEFCD9",
  creamMuted: "rgba(254, 252, 217, 0.5)",
  creamFaint: "rgba(254, 252, 217, 0.15)",
  creamSubtle: "rgba(254, 252, 217, 0.2)",
  orangeDim: "rgba(249, 95, 74, 0.5)",
  surface: "#1a1a1a",
  speakerGlow: "rgba(249, 95, 74, 0.3)",
} as const;

interface ParticipantTileProps {
  participant: Participant;
  displayName: string;
  isLocal?: boolean;
  isActiveSpeaker?: boolean;
  mirror?: boolean;
}

const hiddenAudioStyle = {
  width: 1,
  height: 1,
  opacity: 0,
};

export function ParticipantTile({
  participant,
  displayName,
  isLocal = false,
  isActiveSpeaker = false,
  mirror = false,
}: ParticipantTileProps) {
  const { isTablet } = useDeviceLayout();
  const videoStream = participant.videoStream;
  const audioStream = participant.audioStream;
  const hasVideo = !!videoStream && !participant.isCameraOff;
  const shouldRenderAudioView = !!audioStream && !hasVideo;

  const initials = useMemo(() => {
    const parts = displayName.trim().split(/\s+/).filter(Boolean);
    return parts[0]?.[0]?.toUpperCase() || "?";
  }, [displayName]);

  const displayNameUpper = displayName.toUpperCase();

  // iPad-responsive sizing
  const avatarSize = isTablet ? 80 : 64;
  const avatarFontSize = isTablet ? 28 : 24;
  const ghostIconSize = isTablet ? 56 : 48;
  const handBadgeSize = isTablet ? 36 : 32;
  const namePillFontSize = isTablet ? 12 : 11;

  return (
    <RNView style={[styles.outer, isActiveSpeaker && styles.outerActive]}>
      {isActiveSpeaker ? (
        <RNView pointerEvents="none" style={styles.activeSpeakerRing} />
      ) : null}
      <RNView style={[styles.container, isActiveSpeaker && styles.activeSpeaker]}>
      {hasVideo ? (
        <RTCView
          streamURL={videoStream.toURL()}
          style={styles.video}
          mirror={mirror}
        />
      ) : (
        <RNView style={styles.avatarContainer}>
          <LinearGradient
            colors={["rgba(249, 95, 74, 0.2)", "rgba(255, 0, 122, 0.1)"]}
            style={styles.avatarGradient}
          />
          <RNView style={[
            styles.avatar,
            { width: avatarSize, height: avatarSize, borderRadius: avatarSize / 2 }
          ]}>
            <RNView style={[styles.avatarBorder, { borderRadius: avatarSize / 2 }]} />
            <Text style={[styles.avatarText, { fontSize: avatarFontSize }]}>{initials}</Text>
          </RNView>
        </RNView>
      )}

      {shouldRenderAudioView ? (
        <RTCView streamURL={audioStream.toURL()} style={hiddenAudioStyle} />
      ) : null}

      {participant.isGhost && (
        <RNView style={styles.ghostOverlay}>
          <VenetianMask size={ghostIconSize} color={COLORS.primaryPink} strokeWidth={1.6} />
          <RNView style={styles.ghostBadge}>
            <Text style={styles.ghostBadgeText}>GHOST</Text>
          </RNView>
        </RNView>
      )}

      {participant.isHandRaised && (
        <RNView style={styles.handRaisedContainer}>
          <RNView style={[
            styles.handRaisedBadge,
            { width: handBadgeSize, height: handBadgeSize, borderRadius: handBadgeSize / 2 }
          ]}>
            <Hand size={isTablet ? 16 : 14} color={COLORS.cream} strokeWidth={2} />
          </RNView>
        </RNView>
      )}

      {/* Name overlay at bottom */}
      <RNView style={styles.nameOverlay}>
        <RNView style={[styles.namePill, isTablet && styles.namePillTablet]}>
          <Text style={[styles.nameText, { fontSize: namePillFontSize }]} numberOfLines={1}>
            {displayNameUpper}
          </Text>
          {isLocal && (
            <Text style={[styles.youLabel, isTablet && { fontSize: 10 }]}>YOU</Text>
          )}
          {participant.isMuted && (
            <MicOff size={isTablet ? 14 : 12} color={COLORS.primaryOrange} strokeWidth={2} />
          )}
        </RNView>
      </RNView>
      </RNView>
    </RNView>
  );
}

const styles = StyleSheet.create({
  outer: {
    flex: 1,
    borderRadius: 18,
  },
  outerActive: {
    shadowColor: COLORS.primaryOrange,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.35,
    shadowRadius: 18,
    elevation: 8,
  },
  activeSpeakerRing: {
    ...StyleSheet.absoluteFillObject,
    top: -2,
    right: -2,
    bottom: -2,
    left: -2,
    borderRadius: 20,
    borderWidth: 2,
    borderColor: "rgba(249, 95, 74, 0.3)",
  },
  container: {
    flex: 1,
    borderRadius: 16,
    overflow: "hidden",
    backgroundColor: "#0d0e0d",
    borderWidth: 1,
    borderColor: "rgba(254, 252, 217, 0.1)",
  },
  activeSpeaker: {
    borderColor: COLORS.primaryOrange,
  },
  video: {
    width: "100%",
    height: "100%",
  },
  avatarContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#0d0e0d",
  },
  avatarGradient: {
    ...StyleSheet.absoluteFillObject,
  },
  avatar: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(249, 95, 74, 0.15)",
    position: "relative",
  },
  avatarBorder: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: 32,
    borderWidth: 1,
    borderColor: "rgba(254, 252, 217, 0.2)",
  },
  avatarText: {
    fontSize: 24,
    fontWeight: "700",
    color: COLORS.cream,
    fontFamily: "PolySans-BulkyWide",
  },
  ghostOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0, 0, 0, 0.4)",
    alignItems: "center",
    justifyContent: "center",
  },
  ghostBadge: {
    marginTop: 8,
    paddingHorizontal: 12,
    paddingVertical: 4,
    backgroundColor: "rgba(0, 0, 0, 0.6)",
    borderRadius: 20,
    borderWidth: 1,
    borderColor: "rgba(255, 0, 122, 0.3)",
  },
  ghostBadgeText: {
    fontSize: 10,
    fontWeight: "500",
    color: COLORS.primaryPink,
    letterSpacing: 2,
    fontFamily: "PolySans-Mono",
  },
  handRaisedContainer: {
    position: "absolute",
    top: 12,
    left: 12,
  },
  handRaisedBadge: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: "rgba(255, 128, 0, 0.2)",
    borderWidth: 1,
    borderColor: "rgba(255, 128, 0, 0.4)",
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "rgba(255, 128, 0, 0.3)",
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 1,
    shadowRadius: 8,
  },
  nameOverlay: {
    position: "absolute",
    bottom: 12,
    left: 12,
    right: 12,
  },
  namePill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    alignSelf: "flex-start",
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: "rgba(0, 0, 0, 0.7)",
    borderRadius: 20,
    borderWidth: 1,
    borderColor: "rgba(254, 252, 217, 0.1)",
  },
  nameText: {
    fontSize: 11,
    fontWeight: "500",
    color: COLORS.cream,
    letterSpacing: 1,
    fontFamily: "PolySans-Mono",
  },
  youLabel: {
    fontSize: 9,
    fontWeight: "500",
    color: COLORS.orangeDim,
    letterSpacing: 2,
    fontFamily: "PolySans-Mono",
  },
  mutedIcon: {
    fontSize: 10,
    color: COLORS.primaryOrange,
  },
  // iPad-responsive styles
  namePillTablet: {
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 24,
  },
});

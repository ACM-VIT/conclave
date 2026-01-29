import React, { useCallback, useState } from "react";
import * as Haptics from "expo-haptics";
import { StyleSheet, View as RNView } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { Pressable, Text, View } from "@/tw";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  Hand,
  Lock,
  LockOpen,
  MessageCircle,
  Mic,
  MicOff,
  PhoneOff,
  ScreenShare,
  Smile,
  Users,
  Video,
  VideoOff,
} from "lucide-react-native";
import { EMOJI_REACTIONS } from "../constants";
import { useDeviceLayout, TOUCH_TARGETS } from "../hooks/use-device-layout";
import { GlassPill } from "./glass-pill";

const COLORS = {
  primaryOrange: "#F95F4A",
  primaryPink: "#FF007A",
  cream: "#FEFCD9",
  dark: "#060606",
  surface: "#1a1a1a",
  creamDim: "rgba(254, 252, 217, 0.1)",
  creamMuted: "rgba(254, 252, 217, 0.8)",
  creamFaint: "rgba(254, 252, 217, 0.15)",
  orangeDim: "rgba(249, 95, 74, 0.15)",
  amber: "#fbbf24",
  amberDim: "rgba(251, 191, 36, 0.15)",
  redDim: "rgba(239, 68, 68, 0.15)",
} as const;

const QUICK_REACTIONS = EMOJI_REACTIONS;

interface ControlsBarProps {
  isMuted: boolean;
  isCameraOff: boolean;
  isHandRaised: boolean;
  isScreenSharing: boolean;
  isChatOpen: boolean;
  isRoomLocked: boolean;
  isAdmin: boolean;
  pendingUsersCount: number;
  unreadCount: number;
  availableWidth: number;
  onToggleMute: () => void;
  onToggleCamera: () => void;
  onToggleScreenShare: () => void;
  onToggleHand: () => void;
  onToggleChat: () => void;
  onToggleParticipants: () => void;
  onToggleRoomLock?: (locked: boolean) => void;
  onSendReaction: (emoji: string) => void;
  onLeave: () => void;
}

interface ControlButtonProps {
  icon: React.ComponentType<{ color?: string; size?: number; strokeWidth?: number }>;
  size?: number;
  iconSize?: number;
  isActive?: boolean;
  isMuted?: boolean;
  isHandRaised?: boolean;
  isDanger?: boolean;
  activeColor?: string;
  badge?: number;
  onPress: () => void;
}

function ControlButton({
  icon,
  size,
  iconSize,
  isActive = false,
  isMuted = false,
  isHandRaised = false,
  isDanger = false,
  activeColor,
  badge,
  onPress,
}: ControlButtonProps) {
  const haptic = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => { });
  }, []);

  const handlePress = () => {
    haptic();
    onPress();
  };

  let buttonBg = styles.buttonDefault;
  let iconColor: string = COLORS.creamMuted;

  const isWarningActive = isActive && activeColor === COLORS.amber;

  if (isDanger) {
    buttonBg = styles.buttonDanger;
    iconColor = "rgba(255, 0, 0, 0.9)";
  } else if (isHandRaised || isWarningActive) {
    buttonBg = styles.buttonHandRaised;
    iconColor = COLORS.cream;
  } else if (isMuted) {
    buttonBg = styles.buttonMuted;
    iconColor = COLORS.primaryOrange;
  } else if (isActive) {
    buttonBg = styles.buttonActive;
    iconColor = COLORS.cream;
  }

  const Icon = icon;
  const buttonSize = size ?? TOUCH_TARGETS.MIN;
  const resolvedIconSize = iconSize ?? 16;

  return (
    <Pressable
      onPress={handlePress}
      style={({ pressed }) => [
        styles.controlButton,
        {
          width: buttonSize,
          height: buttonSize,
          borderRadius: buttonSize / 2,
        },
        buttonBg,
        pressed && styles.buttonPressed,
      ]}
    >
      <Icon color={iconColor} size={resolvedIconSize} strokeWidth={2} />
      {typeof badge === "number" && badge > 0 ? (
        <RNView style={styles.badge}>
          <Text style={styles.badgeText}>
            {badge > 9 ? "9+" : badge}
          </Text>
        </RNView>
      ) : null}
    </Pressable>
  );
}

function ReactionPicker({
  visible,
  onSelect,
  onClose,
}: {
  visible: boolean;
  onSelect: (emoji: string) => void;
  onClose: () => void;
}) {
  const haptic = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => { });
  }, []);

  if (!visible) return null;

  return (
    <RNView style={styles.reactionPickerContainer}>
      <Pressable style={styles.reactionPickerBackdrop} onPress={onClose} />
      <RNView style={styles.reactionPicker}>
        {QUICK_REACTIONS.map((emoji) => (
          <Pressable
            key={emoji}
            onPress={() => {
              haptic();
              onSelect(emoji);
            }}
            style={({ pressed }) => [
              styles.reactionOption,
              pressed && styles.reactionOptionPressed,
            ]}
          >
            <Text style={styles.reactionEmoji}>{emoji}</Text>
          </Pressable>
        ))}
      </RNView>
    </RNView>
  );
}

export function ControlsBar({
  isMuted,
  isCameraOff,
  isHandRaised,
  isScreenSharing,
  isChatOpen,
  isRoomLocked,
  isAdmin,
  pendingUsersCount,
  unreadCount,
  availableWidth,
  onToggleMute,
  onToggleCamera,
  onToggleScreenShare,
  onToggleHand,
  onToggleChat,
  onToggleParticipants,
  onToggleRoomLock,
  onSendReaction,
  onLeave,
}: ControlsBarProps) {
  const insets = useSafeAreaInsets();
  const { isTablet, touchTargetSize } = useDeviceLayout();
  const [showReactionPicker, setShowReactionPicker] = useState(false);

  // On iPad, never use compact mode - show all controls
  const isCompact = !isTablet && availableWidth < 420;
  const pillMaxWidth = isCompact
    ? Math.min(340, availableWidth - 32)
    : isTablet
      ? Math.min(800, availableWidth - 80)
      : availableWidth - 40;

  const buttonSize = Math.max(touchTargetSize, TOUCH_TARGETS.MIN);
  const iconSize = isTablet ? 18 : 16;
  const showInlineToggles = isTablet;
  const pillGap = isCompact ? 12 : Math.max(8, Math.round(buttonSize * 0.2));

  const handleReactionSelect = (emoji: string) => {
    onSendReaction(emoji);
    setShowReactionPicker(false);
  };

  const toggleReactionPicker = () => {
    Haptics.selectionAsync().catch(() => { });
    setShowReactionPicker(!showReactionPicker);
  };

  return (
    <RNView style={styles.container}>
      {/* Gradient fade at top */}
      <LinearGradient
        colors={["rgba(0, 0, 0, 0)", "rgba(0, 0, 0, 0.95)"]}
        style={styles.gradient}
        pointerEvents="none"
      />

      {/* Controls pill */}
      <RNView style={[styles.pillContainer, { paddingBottom: Math.max(insets.bottom, 12) }]}>
        {/* Reaction picker popover - positioned above controls */}
        <ReactionPicker
          visible={showReactionPicker}
          onSelect={handleReactionSelect}
          onClose={() => setShowReactionPicker(false)}
        />

        <GlassPill style={[styles.controlsGlass, { maxWidth: pillMaxWidth }]}>
          <RNView
            style={[
              styles.controlsPill,
              {
                gap: pillGap,
              },
            ]}
          >
            {!isCompact ? (
              <>
                <ControlButton
                  icon={Users}
                  badge={pendingUsersCount}
                  size={buttonSize}
                  iconSize={iconSize}
                  onPress={onToggleParticipants}
                />

                {isAdmin ? (
                  <ControlButton
                    icon={isRoomLocked ? Lock : LockOpen}
                    isActive={isRoomLocked}
                    activeColor={COLORS.amber}
                    size={buttonSize}
                    iconSize={iconSize}
                    onPress={() => onToggleRoomLock?.(!isRoomLocked)}
                  />
                ) : null}
              </>
            ) : null}

            <ControlButton
              icon={isMuted ? MicOff : Mic}
              isMuted={isMuted}
              size={buttonSize}
              iconSize={iconSize}
              onPress={onToggleMute}
            />

            <ControlButton
              icon={isCameraOff ? VideoOff : Video}
              isMuted={isCameraOff}
              size={buttonSize}
              iconSize={iconSize}
              onPress={onToggleCamera}
            />

            {showInlineToggles ? (
              <>
                <ControlButton
                  icon={ScreenShare}
                  isActive={isScreenSharing}
                  size={buttonSize}
                  iconSize={iconSize}
                  onPress={onToggleScreenShare}
                />

                <ControlButton
                  icon={Hand}
                  isHandRaised={isHandRaised}
                  size={buttonSize}
                  iconSize={iconSize}
                  onPress={onToggleHand}
                />
              </>
            ) : null}

            <ControlButton
              icon={MessageCircle}
              isActive={isChatOpen}
              badge={unreadCount}
              size={buttonSize}
              iconSize={iconSize}
              onPress={onToggleChat}
            />

            <ControlButton
              icon={Smile}
              isActive={showReactionPicker}
              size={buttonSize}
              iconSize={iconSize}
              onPress={toggleReactionPicker}
            />

            <RNView style={[styles.divider, { marginHorizontal: isCompact ? 2 : 4 }]} />

            <ControlButton
              icon={PhoneOff}
              isDanger
              size={buttonSize}
              iconSize={iconSize}
              onPress={onLeave}
            />
          </RNView>
        </GlassPill>
      </RNView>
    </RNView>
  );
}

const styles = StyleSheet.create({
  container: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
  },
  gradient: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    height: 140,
  },
  pillContainer: {
    alignItems: "center",
    paddingHorizontal: 20,
  },
  controlsPill: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: "transparent",
    borderRadius: 999,
  },
  controlsGlass: {
    alignSelf: "center",
    borderRadius: 999,
    borderWidth: 1,
    borderColor: COLORS.creamFaint,
    marginHorizontal: 6,
  },
  controlButton: {
    alignItems: "center",
    justifyContent: "center",
    position: "relative",
    borderWidth: 1,
    borderColor: COLORS.creamFaint,
  },
  buttonDefault: {
    backgroundColor: "transparent",
  },
  buttonActive: {
    backgroundColor: COLORS.primaryOrange,
    borderColor: "transparent",
  },
  buttonMuted: {
    backgroundColor: "rgba(249, 95, 74, 0.15)",
    borderColor: "transparent",
  },
  buttonHandRaised: {
    backgroundColor: COLORS.amber,
    borderColor: "transparent",
  },
  buttonDanger: {
    backgroundColor: COLORS.redDim,
    borderColor: "transparent",
  },
  buttonPressed: {
    opacity: 0.7,
    transform: [{ scale: 0.95 }],
  },
  divider: {
    width: 1,
    height: 20,
    backgroundColor: COLORS.creamFaint,
  },
  badge: {
    position: "absolute",
    top: -2,
    right: -2,
    minWidth: 16,
    height: 16,
    paddingHorizontal: 4,
    backgroundColor: COLORS.primaryOrange,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  badgeText: {
    fontSize: 10,
    fontWeight: "700",
    color: "#FFFFFF",
  },
  reactionPickerContainer: {
    position: "absolute",
    bottom: 70,
    left: 0,
    right: 0,
    alignItems: "center",
    zIndex: 100,
  },
  reactionPickerBackdrop: {
    position: "absolute",
    top: -500,
    left: -100,
    right: -100,
    bottom: -100,
  },
  reactionPicker: {
    flexDirection: "row",
    gap: 4,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: "rgba(0, 0, 0, 0.9)",
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "rgba(254, 252, 217, 0.1)",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 8,
  },
  reactionOption: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  reactionOptionPressed: {
    backgroundColor: "rgba(254, 252, 217, 0.1)",
    transform: [{ scale: 1.1 }],
  },
  reactionEmoji: {
    fontSize: 22,
  },
});

import React, { useCallback } from "react";
import * as Haptics from "expo-haptics";
import { StyleSheet, View as RNView } from "react-native";
import { Pressable, Text } from "@/tw";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  Mic,
  MicOff,
  MoreHorizontal,
  PhoneOff,
  ScreenShare,
  Video,
  VideoOff,
} from "lucide-react-native";
import { useDeviceLayout, TOUCH_TARGETS } from "../hooks/use-device-layout";
import { GlassPill } from "./glass-pill";

const COLORS = {
  primaryOrange: "#F95F4A",
  primaryPink: "#FF007A",
  cream: "#fafafa",
  dark: "#0a0a0b",
  surface: "#18181b",
  creamDim: "rgba(250, 250, 250, 0.1)",
  creamMuted: "rgba(250, 250, 250, 0.8)",
  creamFaint: "rgba(250, 250, 250, 0.15)",
  orangeDim: "rgba(249, 95, 74, 0.15)",
  amber: "#fbbf24",
  amberDim: "rgba(251, 191, 36, 0.15)",
  redDim: "rgba(234, 67, 53, 0.15)",
} as const;

interface ControlsBarProps {
  isMuted: boolean;
  isCameraOff: boolean;
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
  isObserverMode?: boolean;
  pendingUsersCount: number;
  unreadCount: number;
  availableWidth: number;
  showParticipantsControl?: boolean;
  isWhiteboardActive?: boolean;
  showWhiteboardControl?: boolean;
  isAppsLocked?: boolean;
  onToggleMute: () => void;
  onToggleCamera: () => void;
  onToggleScreenShare: () => void;
  onToggleHand: () => void;
  onToggleChat: () => void;
  onToggleParticipants: () => void;
  onToggleRoomLock?: (locked: boolean) => void;
  onToggleNoGuests?: (noGuests: boolean) => void;
  onToggleChatLock?: (locked: boolean) => void;
  onToggleTtsDisabled?: (disabled: boolean) => void;
  onToggleDmEnabled?: (enabled: boolean) => void;
  onToggleWhiteboard?: () => void;
  onToggleAppsLock?: (locked: boolean) => void;
  onSendReaction: (emoji: string) => void;
  onOpenMore: () => void;
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
  disabled?: boolean;
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
  disabled = false,
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
      disabled={disabled}
      style={({ pressed }) => [
        styles.controlButton,
        {
          width: buttonSize,
          height: buttonSize,
          borderRadius: buttonSize / 2,
        },
        buttonBg,
        disabled && styles.buttonDisabled,
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

export function ControlsBar({
  isMuted,
  isCameraOff,
  isScreenSharing,
  isScreenShareAvailable = true,
  isObserverMode = false,
  availableWidth,
  onToggleMute,
  onToggleCamera,
  onToggleScreenShare,
  onOpenMore,
  onLeave,
}: ControlsBarProps) {
  const insets = useSafeAreaInsets();
  const { isTablet, touchTargetSize } = useDeviceLayout();

  const isCompact = !isTablet && availableWidth < 420;
  const pillMaxWidth = isCompact
    ? Math.min(360, Math.round(availableWidth * 0.9))
    : isTablet
      ? Math.min(860, availableWidth - 60)
      : Math.round(availableWidth * 0.9);

  const buttonSize = Math.round(
    Math.max(touchTargetSize, TOUCH_TARGETS.MIN) * (isTablet ? 1.24 : 1.18)
  );
  const iconSize = isTablet ? 22 : 19;
  const canUseScreenShareControl = isScreenSharing || isScreenShareAvailable;
  const pillGap = isCompact ? 14 : Math.max(12, Math.round(buttonSize * 0.25));

  if (isObserverMode) {
    return (
      <RNView style={styles.container}>
        <RNView
          style={[styles.pillContainer, { paddingBottom: Math.max(insets.bottom, 12) }]}
        >
          <GlassPill style={[styles.controlsGlass, { maxWidth: pillMaxWidth }]}>
            <RNView
              style={[
                styles.controlsPill,
                {
                  gap: pillGap,
                  justifyContent: "space-between",
                  minWidth: Math.min(pillMaxWidth, 320),
                },
              ]}
            >
              <Text style={styles.observerLabel}>Watching webinar</Text>
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

  return (
    <RNView style={styles.container}>
      {/* Controls pill */}
      <RNView style={[styles.pillContainer, { paddingBottom: Math.max(insets.bottom, 12) }]}>
        <GlassPill style={[styles.controlsGlass, { maxWidth: pillMaxWidth }]}>
          <RNView
            style={[
              styles.controlsPill,
              {
                gap: pillGap,
              },
            ]}
          >
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

            <ControlButton
              icon={ScreenShare}
              isActive={isScreenSharing}
              size={buttonSize}
              iconSize={iconSize}
              onPress={onToggleScreenShare}
              disabled={!canUseScreenShareControl}
            />

            <ControlButton
              icon={MoreHorizontal}
              size={buttonSize}
              iconSize={iconSize}
              onPress={onOpenMore}
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
    paddingHorizontal: 20,
    paddingVertical: 16,
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
    height: 26,
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
  buttonDisabled: {
    opacity: 0.35,
  },
  observerLabel: {
    fontSize: 12,
    color: COLORS.creamMuted,
    letterSpacing: 0.2,
    fontFamily: "PolySans-Regular",
  },
});

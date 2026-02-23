import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  LayoutAnimation,
  PanResponder,
  Platform,
  Share,
  StyleSheet,
  UIManager,
  useWindowDimensions,
  View as RNView,
} from "react-native";
import { RTCView } from "react-native-webrtc";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import type {
  ConnectionState,
  Participant,
  WebinarConfigSnapshot,
} from "../types";
import { isSystemUserId } from "../utils";
import { useDeviceLayout, type DeviceLayout } from "../hooks/use-device-layout";
import { ControlsBar } from "./controls-bar";
import { ParticipantTile } from "./participant-tile";
import { FlatList, Text, Pressable } from "@/tw";
import { Lock, Settings, Users, MicOff, VenetianMask } from "lucide-react-native";
import { GlassPill } from "./glass-pill";
import { useApps } from "@conclave/apps-sdk";
import { WhiteboardNativeApp } from "@conclave/apps-sdk/whiteboard/native";

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

const MEETING_LINK_BASE = "https://conclave.acmvit.in";
const COPY_RESET_DELAY_MS = 1500;
const GRID_HORIZONTAL_PADDING = 32;

const getMaxGridColumns = (layout: DeviceLayout, participantCount: number) => {
  if (layout === "large") {
    if (participantCount >= 9) return 4;
    return 3;
  }
  if (layout === "regular") {
    return 3;
  }
  if (participantCount >= 7) {
    return 3;
  }
  return 2;
};

interface CallScreenProps {
  roomId: string;
  connectionState: ConnectionState;
  serverRestartNotice?: string | null;
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
  onToggleNoGuests?: (noGuests: boolean) => void;
  onToggleChatLock?: (locked: boolean) => void;
  onToggleTtsDisabled?: (disabled: boolean) => void;
  onSendReaction: (emoji: string) => void;
  onOpenSettings: () => void;
  onLeave: () => void;
  participantCount?: number;
  isRoomLocked?: boolean;
  isNoGuests?: boolean;
  isChatLocked?: boolean;
  isTtsDisabled?: boolean;
  isAdmin?: boolean;
  pendingUsersCount?: number;
  isObserverMode?: boolean;
  webinarConfig?: WebinarConfigSnapshot | null;
  webinarSpeakerUserId?: string | null;
}

const columnWrapperStyle = { gap: 12 } as const;
const columnWrapperStyleTablet = { gap: 16 } as const;
const observerAudioStyle = { width: 1, height: 1, opacity: 0 };
type PipCorner = "top-left" | "top-right" | "bottom-left" | "bottom-right";
const OBSERVER_PIP_MARGIN = 12;
const OBSERVER_PIP_WIDTH = 132;
const OBSERVER_PIP_HEIGHT = 84;

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

const getObserverPipCornerPosition = (
  corner: PipCorner,
  stageWidth: number,
  stageHeight: number
) => {
  const minX = OBSERVER_PIP_MARGIN;
  const minY = OBSERVER_PIP_MARGIN;
  const maxX = Math.max(minX, stageWidth - OBSERVER_PIP_WIDTH - OBSERVER_PIP_MARGIN);
  const maxY = Math.max(minY, stageHeight - OBSERVER_PIP_HEIGHT - OBSERVER_PIP_MARGIN);

  switch (corner) {
    case "top-left":
      return { x: minX, y: minY };
    case "top-right":
      return { x: maxX, y: minY };
    case "bottom-left":
      return { x: minX, y: maxY };
    case "bottom-right":
    default:
      return { x: maxX, y: maxY };
  }
};

const resolveObserverPipCorner = (
  x: number,
  y: number,
  stageWidth: number,
  stageHeight: number
): PipCorner => {
  const horizontal = x + OBSERVER_PIP_WIDTH / 2 <= stageWidth / 2 ? "left" : "right";
  const vertical = y + OBSERVER_PIP_HEIGHT / 2 <= stageHeight / 2 ? "top" : "bottom";
  return `${vertical}-${horizontal}` as PipCorner;
};

const getLiveVideoStream = (stream: MediaStream | null): MediaStream | null => {
  if (!stream) return null;
  const [track] = stream.getVideoTracks();
  if (!track || track.readyState === "ended") {
    return null;
  }
  return stream;
};

export function CallScreen({
  roomId,
  connectionState,
  serverRestartNotice = null,
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
  onToggleNoGuests,
  onToggleChatLock,
  onToggleTtsDisabled,
  onSendReaction,
  onOpenSettings,
  onLeave,
  participantCount,
  isRoomLocked = false,
  isNoGuests = false,
  isChatLocked = false,
  isTtsDisabled = false,
  isAdmin = false,
  pendingUsersCount = 0,
  isObserverMode = false,
  webinarConfig,
  webinarSpeakerUserId,
  presentationStream = null,
  presenterName = "",
}: CallScreenProps) {
  const { state: appsState, openApp, closeApp, setLocked, refreshState } = useApps();
  const isWhiteboardActive = appsState.activeAppId === "whiteboard";
  const handleOpenWhiteboard = useCallback(() => openApp("whiteboard"), [openApp]);
  const handleCloseWhiteboard = useCallback(() => closeApp(), [closeApp]);
  const handleToggleAppsLock = useCallback(
    () => setLocked(!appsState.locked),
    [appsState.locked, setLocked]
  );
  const handleToggleWhiteboard = useCallback(
    () => (isWhiteboardActive ? handleCloseWhiteboard() : handleOpenWhiteboard()),
    [isWhiteboardActive, handleCloseWhiteboard, handleOpenWhiteboard]
  );
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const { layout, isTablet } = useDeviceLayout();
  const [copied, setCopied] = useState(false);
  const [gridViewportHeight, setGridViewportHeight] = useState(0);
  const copyResetRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const meetingLink = useMemo(
    () =>
      roomId
        ? `${MEETING_LINK_BASE}/${isObserverMode ? `w/${roomId}` : roomId}`
        : "",
    [isObserverMode, roomId]
  );

  const meetingCopyText = useMemo(() => {
    if (!meetingLink) return "";
    return `Join my Conclave meeting: ${meetingLink}`;
  }, [meetingLink]);

  const handleCopyMeeting = useCallback(async () => {
    if (!meetingCopyText) return;
    await Clipboard.setStringAsync(meetingCopyText);
    Haptics.selectionAsync().catch(() => { });
    setCopied(true);
    if (copyResetRef.current) {
      clearTimeout(copyResetRef.current);
    }
    copyResetRef.current = setTimeout(() => {
      setCopied(false);
    }, COPY_RESET_DELAY_MS);
  }, [meetingCopyText]);

  const handleShareMeeting = useCallback(async () => {
    if (!meetingCopyText) return;
    try {
      await Share.share({
        message: meetingCopyText,
      });
    } catch (err) {
      console.warn("[Meet] Share failed", err);
    }
  }, [meetingCopyText]);

  useEffect(() => {
    return () => {
      if (copyResetRef.current) {
        clearTimeout(copyResetRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (connectionState === "joined") {
      refreshState();
    }
  }, [connectionState, refreshState]);

  const participantList = useMemo(() => {
    const list = Array.from(participants.values()).filter(
      (participant) => !isSystemUserId(participant.userId)
    );
    const hasLocal = list.some((participant) => participant.userId === localParticipant.userId);
    return hasLocal ? list : [localParticipant, ...list];
  }, [participants, localParticipant]);
  const webinarParticipants = useMemo(
    () =>
      Array.from(participants.values()).filter(
        (participant) => !isSystemUserId(participant.userId)
      ),
    [participants]
  );
  const webinarStage = useMemo(() => {
    if (!webinarParticipants.length) {
      return null;
    }

    const byPresentedScreen = presentationStream
      ? webinarParticipants.find(
          (participant) =>
            participant.screenShareStream?.id === presentationStream.id &&
            getLiveVideoStream(participant.screenShareStream)
        )
      : null;
    const byAnyScreenShare = webinarParticipants.find(
      (participant) => getLiveVideoStream(participant.screenShareStream)
    );
    const fallbackAudioStream =
      webinarParticipants.find((participant) => participant.audioStream)
        ?.audioStream ?? null;
    const screenShareParticipant = byPresentedScreen ?? byAnyScreenShare;

    if (screenShareParticipant) {
      const mainVideoStream =
        getLiveVideoStream(presentationStream) ??
        getLiveVideoStream(screenShareParticipant.screenShareStream);
      if (mainVideoStream) {
        return {
          mainVideoStream,
          mainAudioStream:
            screenShareParticipant.audioStream ?? fallbackAudioStream,
          displayName:
            presenterName || resolveDisplayName(screenShareParticipant.userId),
          pipVideoStream: getLiveVideoStream(screenShareParticipant.videoStream),
          pipDisplayName: resolveDisplayName(screenShareParticipant.userId),
          isScreenShare: true,
        };
      }
    }

    const preferredIds = [
      webinarSpeakerUserId ?? null,
      activeSpeakerId ?? null,
    ].filter((value, index, list): value is string => {
      return Boolean(value) && list.indexOf(value) === index;
    });
    const preferredParticipant = preferredIds
      .map((userId) =>
        webinarParticipants.find((participant) => participant.userId === userId)
      )
      .find((participant) => participant !== undefined);
    const preferredVideoParticipant =
      preferredParticipant &&
      getLiveVideoStream(preferredParticipant.videoStream)
        ? preferredParticipant
        : null;
    const preferredAudioParticipant =
      preferredParticipant && preferredParticipant.audioStream
        ? preferredParticipant
        : null;

    const cameraParticipant =
      preferredVideoParticipant ??
      webinarParticipants.find(
        (participant) =>
          !participant.isCameraOff &&
          getLiveVideoStream(participant.videoStream)
      ) ??
      webinarParticipants.find((participant) =>
        getLiveVideoStream(participant.videoStream)
      ) ??
      preferredAudioParticipant ??
      webinarParticipants.find((participant) => participant.audioStream) ??
      webinarParticipants[0];
    const cameraStream = getLiveVideoStream(cameraParticipant.videoStream);

    return {
      mainVideoStream: cameraStream,
      mainAudioStream: cameraParticipant.audioStream ?? fallbackAudioStream,
      displayName: presenterName || resolveDisplayName(cameraParticipant.userId),
      pipVideoStream: null,
      pipDisplayName: "",
      isScreenShare: false,
    };
  }, [
    activeSpeakerId,
    presentationStream,
    presenterName,
    resolveDisplayName,
    webinarParticipants,
    webinarSpeakerUserId,
  ]);
  const [observerPipCorner, setObserverPipCorner] = useState<PipCorner>("bottom-right");
  const [observerPipDragPosition, setObserverPipDragPosition] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const observerPipDragOriginRef = useRef<{
    x: number;
    y: number;
    stageWidth: number;
    stageHeight: number;
  } | null>(null);
  const [observerStageSize, setObserverStageSize] = useState({
    width: 0,
    height: 0,
  });
  const observerPipPanResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: () => {
          if (observerStageSize.width <= 0 || observerStageSize.height <= 0) {
            return;
          }
          const origin = getObserverPipCornerPosition(
            observerPipCorner,
            observerStageSize.width,
            observerStageSize.height
          );
          observerPipDragOriginRef.current = {
            x: origin.x,
            y: origin.y,
            stageWidth: observerStageSize.width,
            stageHeight: observerStageSize.height,
          };
          setObserverPipDragPosition(origin);
        },
        onPanResponderMove: (_, gestureState) => {
          const origin = observerPipDragOriginRef.current;
          if (!origin) return;
          const minX = OBSERVER_PIP_MARGIN;
          const minY = OBSERVER_PIP_MARGIN;
          const maxX = Math.max(
            minX,
            origin.stageWidth - OBSERVER_PIP_WIDTH - OBSERVER_PIP_MARGIN
          );
          const maxY = Math.max(
            minY,
            origin.stageHeight - OBSERVER_PIP_HEIGHT - OBSERVER_PIP_MARGIN
          );
          const nextX = clamp(origin.x + gestureState.dx, minX, maxX);
          const nextY = clamp(origin.y + gestureState.dy, minY, maxY);
          setObserverPipDragPosition({ x: nextX, y: nextY });
        },
        onPanResponderRelease: (_, gestureState) => {
          const origin = observerPipDragOriginRef.current;
          if (!origin) return;

          const minX = OBSERVER_PIP_MARGIN;
          const minY = OBSERVER_PIP_MARGIN;
          const maxX = Math.max(
            minX,
            origin.stageWidth - OBSERVER_PIP_WIDTH - OBSERVER_PIP_MARGIN
          );
          const maxY = Math.max(
            minY,
            origin.stageHeight - OBSERVER_PIP_HEIGHT - OBSERVER_PIP_MARGIN
          );
          const fallbackX = clamp(origin.x + gestureState.dx, minX, maxX);
          const fallbackY = clamp(origin.y + gestureState.dy, minY, maxY);
          const resolvedX = observerPipDragPosition?.x ?? fallbackX;
          const resolvedY = observerPipDragPosition?.y ?? fallbackY;
          setObserverPipCorner(
            resolveObserverPipCorner(
              resolvedX,
              resolvedY,
              origin.stageWidth,
              origin.stageHeight
            )
          );
          setObserverPipDragPosition(null);
          observerPipDragOriginRef.current = null;
        },
        onPanResponderTerminate: () => {
          setObserverPipDragPosition(null);
          observerPipDragOriginRef.current = null;
        },
      }),
    [observerPipCorner, observerPipDragPosition, observerStageSize]
  );
  const observerPipPositionStyle = useMemo(() => {
    if (observerPipDragPosition) {
      return {
        left: observerPipDragPosition.x,
        top: observerPipDragPosition.y,
        right: undefined,
        bottom: undefined,
      };
    }
    const position = getObserverPipCornerPosition(
      observerPipCorner,
      observerStageSize.width,
      observerStageSize.height
    );
    return {
      left: position.x,
      top: position.y,
      right: undefined,
      bottom: undefined,
    };
  }, [observerPipCorner, observerPipDragPosition, observerStageSize]);

  const displayParticipantCount = isObserverMode
    ? webinarConfig?.attendeeCount ?? 0
    : participantCount ?? participantList.length;
  const isWebinarSession = isObserverMode || Boolean(webinarConfig?.enabled);
  const webinarTextStyle = isWebinarSession ? styles.webinarRegularText : null;

  const stripParticipants = useMemo(() => {
    const list = Array.from(participants.values()).filter(
      (participant) => !isSystemUserId(participant.userId)
    );
    const hasLocal = list.some(
      (participant) => participant.userId === localParticipant.userId
    );
    return hasLocal ? list : [localParticipant, ...list];
  }, [participants, localParticipant]);

  const safePaddingLeft = Math.max(isTablet ? 12 : 6, insets.left);
  const safePaddingRight = Math.max(isTablet ? 12 : 6, insets.right);
  const availableWidth = width - safePaddingLeft - safePaddingRight;
  const gridGap = isTablet ? 16 : 12;
  const participantCountForLayout = Math.max(participantList.length, 1);
  const controlsReservedHeight = 140 + insets.bottom;
  const gridTopPadding =
    layout === "compact" && participantCountForLayout === 2 ? 16 : 8;
  const estimatedGridHeight = Math.max(
    0,
    height - insets.top - controlsReservedHeight - (isTablet ? 108 : 96)
  );
  const measuredGridHeight =
    gridViewportHeight > 0 ? gridViewportHeight : estimatedGridHeight;
  const usableGridHeight = Math.max(
    0,
    measuredGridHeight - controlsReservedHeight - gridTopPadding
  );
  const gridWidthForTiles = Math.max(0, availableWidth - GRID_HORIZONTAL_PADDING);

  const optimalGrid = useMemo(() => {
    const maxColumns = Math.max(
      1,
      Math.min(
        participantCountForLayout,
        getMaxGridColumns(layout, participantCountForLayout)
      )
    );
    const targetAspect = layout === "compact" ? 1.1 : 0.9;

    let best = {
      columns: 1,
      rows: participantCountForLayout,
      tileWidth: Math.floor(gridWidthForTiles),
      tileHeight: Math.max(
        1,
        Math.floor(usableGridHeight / participantCountForLayout)
      ),
      score: Number.NEGATIVE_INFINITY,
    };

    for (let candidateColumns = 1; candidateColumns <= maxColumns; candidateColumns += 1) {
      const candidateRows = Math.ceil(participantCountForLayout / candidateColumns);
      const candidateWidth = Math.floor(
        (gridWidthForTiles - (candidateColumns - 1) * gridGap) / candidateColumns
      );
      const candidateHeight = Math.floor(
        (usableGridHeight - (candidateRows - 1) * gridGap) / candidateRows
      );

      if (candidateWidth <= 0 || candidateHeight <= 0) continue;

      const capacity = candidateColumns * candidateRows;
      const emptySlots = capacity - participantCountForLayout;
      const fillRatio = participantCountForLayout / capacity;
      const area = candidateWidth * candidateHeight;
      const aspectPenalty = Math.abs(candidateHeight / candidateWidth - targetAspect);

      let score = area;
      score += area * fillRatio * 0.25;
      score -= emptySlots * area * 0.08;
      score -= aspectPenalty * area * 0.18;

      if (layout === "compact" && participantCountForLayout <= 2 && candidateColumns === 1) {
        score += area * 0.15;
      }

      if (score > best.score) {
        best = {
          columns: candidateColumns,
          rows: candidateRows,
          tileWidth: candidateWidth,
          tileHeight: candidateHeight,
          score,
        };
      }
    }

    return best;
  }, [
    participantCountForLayout,
    layout,
    gridWidthForTiles,
    usableGridHeight,
    gridGap,
  ]);

  const columns = optimalGrid.columns;
  const isTwoUp =
    layout === "compact" && participantCountForLayout === 2 && columns === 1;

  const tileStyle = useMemo(
    () => ({
      width: optimalGrid.tileWidth,
      height: Math.max(isTablet ? 92 : 76, optimalGrid.tileHeight),
    }),
    [optimalGrid.tileWidth, optimalGrid.tileHeight, isTablet]
  );

  const stripTileSize = isTablet ? 120 : 88;
  const hasTerminalConnectionState =
    connectionState === "disconnected" || connectionState === "error";
  const showServerRestartNotice =
    Boolean(serverRestartNotice) && !hasTerminalConnectionState;

  const connectionLabel =
    showServerRestartNotice
      ? "Server restarting, reconnecting"
      : connectionState === "reconnecting"
      ? "Reconnecting"
      : connectionState === "connecting"
        ? "Connecting"
        : connectionState === "waiting"
          ? "Waiting"
          : null;

  const isPresenting = Boolean(presentationStream);
  const isScreenShareAvailable =
    isScreenSharing || !isPresenting || presenterName === "You";

  useEffect(() => {
    if (Platform.OS === "android") {
      UIManager.setLayoutAnimationEnabledExperimental?.(true);
    }
  }, []);

  useEffect(() => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
  }, [participantList.length, columns, tileStyle.height, tileStyle.width]);

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
        <RNView style={styles.header}>
          {isObserverMode ? (
            <GlassPill style={styles.pillGlass}>
              <RNView style={styles.roomPill}>
                <Text style={[styles.roomId, webinarTextStyle]} numberOfLines={1}>
                  WEBINAR
                </Text>
              </RNView>
            </GlassPill>
          ) : (
            <Pressable
              onPress={handleShareMeeting}
              onLongPress={handleCopyMeeting}
              accessibilityRole="button"
              accessibilityLabel={`Share meeting link for room ${roomId}`}
              accessibilityHint="Tap to share. Long press to copy."
              style={({ pressed }) => [pressed && styles.roomPressed]}
            >
              <GlassPill style={[styles.pillGlass, copied && styles.pillCopied]}>
                <RNView style={styles.roomPill}>
                  {isRoomLocked ? (
                    <Lock size={12} color={COLORS.primaryOrange} />
                  ) : null}
                  <Text
                    style={[
                      styles.roomId,
                      webinarTextStyle,
                      copied && styles.roomIdCopied,
                    ]}
                    numberOfLines={1}
                  >
                    {roomId.toUpperCase()}
                  </Text>
                </RNView>
              </GlassPill>
            </Pressable>
          )}

        {connectionLabel ? (
          <RNView style={styles.statusPill}>
            <Text style={[styles.statusText, webinarTextStyle]}>
              {connectionLabel}
            </Text>
          </RNView>
        ) : (
          isObserverMode ? null : !isTablet ? (
            isWebinarSession ? (
              <GlassPill style={styles.pillGlass}>
                <Pressable onPress={onOpenSettings} style={styles.headerPillIconButtonOnly}>
                  <Settings size={14} color={COLORS.cream} />
                </Pressable>
              </GlassPill>
            ) : (
              <GlassPill style={[styles.pillGlass, styles.headerPill]}>
                <Pressable onPress={onOpenSettings} style={styles.headerPillIconButton}>
                  <Settings size={14} color={COLORS.cream} />
                </Pressable>
                <RNView style={styles.headerPillDivider} />
                <Pressable onPress={onToggleParticipants} style={styles.headerPillButton}>
                  <RNView style={styles.participantsPill}>
                    <Users size={12} color={COLORS.cream} />
                    <Text style={[styles.participantsCount, webinarTextStyle]}>
                      {displayParticipantCount}
                    </Text>
                  </RNView>
                </Pressable>
              </GlassPill>
            )
          ) : isWebinarSession ? null : (
            <Pressable onPress={onToggleParticipants}>
              <GlassPill style={styles.pillGlass}>
                <RNView style={styles.participantsPill}>
                  <Users size={12} color={COLORS.cream} />
                  <Text style={[styles.participantsCount, webinarTextStyle]}>
                    {displayParticipantCount}
                  </Text>
                </RNView>
              </GlassPill>
            </Pressable>
          )
        )}
      </RNView>

        {isObserverMode ? (
          <RNView
            style={[
              styles.presentationContainer,
              { paddingBottom: 140 + insets.bottom },
            ]}
          >
            <RNView
              style={styles.presentationStage}
              onLayout={(event) => {
                const { width: nextWidth, height: nextHeight } =
                  event.nativeEvent.layout;
                if (
                  nextWidth <= 0 ||
                  nextHeight <= 0 ||
                  (observerStageSize.width === nextWidth &&
                    observerStageSize.height === nextHeight)
                ) {
                  return;
                }
                setObserverStageSize({
                  width: nextWidth,
                  height: nextHeight,
                });
              }}
            >
              {webinarStage?.mainVideoStream ? (
                <RTCView
                  streamURL={webinarStage.mainVideoStream.toURL()}
                  style={styles.presentationVideo}
                  mirror={false}
                  objectFit={webinarStage.isScreenShare ? "contain" : "cover"}
                />
              ) : (
                <RNView style={styles.observerFallback}>
                  <Text style={[styles.presenterText, webinarTextStyle]}>
                    Waiting for the host to start speaking...
                  </Text>
                </RNView>
              )}
              {webinarStage?.mainAudioStream ? (
                <RTCView
                  streamURL={webinarStage.mainAudioStream.toURL()}
                  style={styles.observerAudio}
                  mirror={false}
                  objectFit="contain"
                />
              ) : null}
              {webinarStage ? (
                <RNView style={styles.presenterBadge}>
                  <Text style={[styles.presenterText, webinarTextStyle]}>
                    {webinarStage.displayName}
                  </Text>
                </RNView>
              ) : null}
              {webinarStage?.isScreenShare && webinarStage.pipVideoStream ? (
                <RNView
                  style={[styles.observerPip, observerPipPositionStyle]}
                  {...observerPipPanResponder.panHandlers}
                >
                  <RTCView
                    streamURL={webinarStage.pipVideoStream.toURL()}
                    style={styles.observerPipVideo}
                    mirror={false}
                    objectFit="cover"
                  />
                  <RNView style={styles.observerPipBadge}>
                    <Text style={[styles.observerPipText, webinarTextStyle]}>
                      {webinarStage.pipDisplayName}
                    </Text>
                  </RNView>
                </RNView>
              ) : null}
            </RNView>
          </RNView>
        ) : isWhiteboardActive ? (
          <RNView style={[styles.whiteboardContainer, { paddingBottom: 140 + insets.bottom }]}>
            <WhiteboardNativeApp />
          </RNView>
        ) : isPresenting && presentationStream ? (
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
                <Text style={[styles.presenterText, webinarTextStyle]}>
                  {presenterName === "You"
                    ? "You're presenting"
                    : `${presenterName || "Presenter"} is presenting`}
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
                      <Text
                        style={[styles.stripLabelText, webinarTextStyle]}
                        numberOfLines={1}
                      >
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
          <RNView
            style={styles.gridViewport}
            onLayout={(event) => {
              const nextHeight = Math.round(event.nativeEvent.layout.height);
              if (nextHeight > 0 && nextHeight !== gridViewportHeight) {
                setGridViewportHeight(nextHeight);
              }
            }}
          >
            <FlatList
              data={participantList}
              key={`${columns}`}
              numColumns={columns}
              keyExtractor={(item) => item.userId}
              style={styles.grid}
              contentContainerStyle={[
                styles.gridContent,
                { paddingBottom: controlsReservedHeight },
                isTwoUp && styles.gridContentTwoUp,
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
          </RNView>
        )}
      </RNView>

      {/* Controls Bar - positioned absolutely at bottom */}
      <ControlsBar
        isMuted={isMuted}
        isCameraOff={isCameraOff}
        isHandRaised={isHandRaised}
        isScreenSharing={isScreenSharing}
        isScreenShareAvailable={isScreenShareAvailable}
        isChatOpen={isChatOpen}
        isRoomLocked={isRoomLocked}
        isNoGuests={isNoGuests}
        isChatLocked={isChatLocked}
        isTtsDisabled={isTtsDisabled}
        isAdmin={isAdmin}
        isObserverMode={isObserverMode}
        pendingUsersCount={pendingUsersCount}
        unreadCount={unreadCount}
        availableWidth={availableWidth}
        showParticipantsControl={!isWebinarSession}
        onToggleMute={onToggleMute}
        onToggleCamera={onToggleCamera}
        onToggleScreenShare={onToggleScreenShare}
        onToggleHand={onToggleHandRaised}
        onToggleChat={onToggleChat}
        onToggleParticipants={onToggleParticipants}
        onToggleRoomLock={onToggleRoomLock}
        onToggleNoGuests={onToggleNoGuests}
        onToggleChatLock={onToggleChatLock}
        onToggleTtsDisabled={onToggleTtsDisabled}
        isWhiteboardActive={isWhiteboardActive}
        showWhiteboardControl={isTablet && isAdmin}
        isAppsLocked={appsState.locked}
        onToggleWhiteboard={isAdmin ? handleToggleWhiteboard : undefined}
        onToggleAppsLock={handleToggleAppsLock}
        onSendReaction={onSendReaction}
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
    position: "relative",
  },
  roomPressed: {
    opacity: 0.75,
    transform: [{ scale: 0.98 }],
  },
  pillGlass: {
    borderRadius: 50,
    borderWidth: 1,
    borderColor: COLORS.creamFaint,
  },
  pillCopied: {
    borderColor: "rgba(249, 95, 74, 0.5)",
  },
  roomId: {
    fontSize: 12,
    fontWeight: "500",
    color: COLORS.cream,
    letterSpacing: 1,
    fontFamily: "PolySans-Mono",
  },
  roomIdCopied: {
    textDecorationLine: "underline",
    textDecorationStyle: "solid",
    textDecorationColor: "rgba(249, 95, 74, 0.85)",
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
    paddingLeft: 8,
    paddingRight: 12,
    paddingVertical: 8,
  },
  headerPill: {
    flexDirection: "row",
    alignItems: "center",
  },
  headerPillButton: {
    paddingHorizontal: 0,
    paddingVertical: 4,
  },
  headerPillIconButton: {
    paddingLeft: 12,
    paddingRight: 8,
    paddingVertical: 6,
  },
  headerPillIconButtonOnly: {
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  headerPillDivider: {
    width: 1,
    height: 18,
    backgroundColor: COLORS.creamFaint,
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
  gridViewport: {
    flex: 1,
    minHeight: 0,
  },
  gridContent: {
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 140,
    gap: 12,
  },
  gridContentTwoUp: {
    flexGrow: 1,
    justifyContent: "space-between",
    paddingTop: 16,
  },
  presentationContainer: {
    flex: 1,
    gap: 12,
    paddingHorizontal: 12,
    paddingTop: 8,
  },
  whiteboardContainer: {
    flex: 1,
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
  observerFallback: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 24,
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
    fontSize: 11,
    color: COLORS.cream,
    letterSpacing: 2,
    fontWeight: "500",
    textTransform: "uppercase",
    fontFamily: "PolySans-Mono",
  },
  observerPip: {
    position: "absolute",
    width: 132,
    height: 84,
    borderRadius: 12,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "rgba(254, 252, 217, 0.2)",
    backgroundColor: "rgba(0, 0, 0, 0.75)",
  },
  observerPipVideo: {
    width: "100%",
    height: "100%",
  },
  observerPipBadge: {
    position: "absolute",
    left: 6,
    right: 6,
    bottom: 6,
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderRadius: 999,
    backgroundColor: "rgba(0, 0, 0, 0.62)",
    borderWidth: 1,
    borderColor: "rgba(254, 252, 217, 0.16)",
  },
  observerPipText: {
    fontSize: 9,
    color: COLORS.cream,
    letterSpacing: 1.2,
    textTransform: "uppercase",
    fontFamily: "PolySans-Mono",
  },
  observerAudio: observerAudioStyle,
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
  webinarRegularText: {
    fontFamily: "PolySans-Regular",
    letterSpacing: 0,
    textTransform: "none",
  },
});

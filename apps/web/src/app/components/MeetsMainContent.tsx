"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, PointerEvent, SetStateAction } from "react";
import { LogOut, RefreshCw } from "lucide-react";
import type { Socket } from "socket.io-client";
import type { RoomInfo } from "@/lib/sfu-types";
import ChatOverlay from "./ChatOverlay";
import ChatPanel from "./ChatPanel";
import ControlsBar from "./ControlsBar";
import GridLayout from "./GridLayout";
import ConnectionBanner from "./ConnectionBanner";
import AdminNoticePill from "./AdminNoticePill";
import ParticipantsPanel from "./ParticipantsPanel";
import MeetSettingsPanel from "./MeetSettingsPanel";
import MeetViewPanel from "./MeetViewPanel";
import ReactionOverlay from "./ReactionOverlay";
import BrowserLayout from "./BrowserLayout";
import DevPlaygroundLayout from "./DevPlaygroundLayout";
import ScreenShareAudioPlayers from "./ScreenShareAudioPlayers";
import SystemAudioPlayers from "./SystemAudioPlayers";
import WhiteboardLayout from "./WhiteboardLayout";
import ParticipantVideo from "./ParticipantVideo";
import ToastQueue from "./ToastQueue";
import TranscriptPanel from "./TranscriptPanel";
import AndroidUpsellSheet from "./AndroidUpsellSheet";
import type { BrowserState } from "../hooks/useSharedBrowser";
import type {
  VideoEffectsDebugStats,
  VideoEffectsRuntimeStatus,
} from "../hooks/useVideoEffects";
import type { MeetingTranscriptController } from "../hooks/useMeetingTranscript";
import type {
  CapturedSurfaceControlState,
  CaptureControllerLike,
} from "../lib/captured-surface-control";
import type {
  AdminNoticeNotification,
  ChatGifAttachment,
  ChatMessage,
  ChatReplyPreview,
  ConnectionState,
  MeetError,
  MeetingConfigSnapshot,
  MeetingUpdateRequest,
  Participant,
  ReconnectRecoveryStatus,
  ReactionEvent,
  ReactionOption,
  WebinarConfigSnapshot,
  WebinarLinkResponse,
  WebinarUpdateRequest,
  PrejoinMediaHandoff,
} from "../lib/types";
import {
  formatDisplayName,
  isBrowserVideoUserId,
  isSystemUserId,
} from "../lib/utils";
import { useApps, useGame } from "@conclave/apps-sdk";
import { GamePanel } from "./games/GamePanel";
import { GamesPanel } from "./games/GamesPanel";
import {
  GAME_DOCK_DEFAULT_WIDTH,
  GAME_DOCK_MAX_WIDTH,
  GAME_DOCK_MIN_WIDTH,
} from "./games/gameUi";
import { useCameraPermissionState } from "../hooks/useCameraPermissionState";
import { useStableSpeakerId } from "../hooks/useStableSpeakerId";
import {
  type VideoEffectsState,
} from "../lib/video-effects";
import {
  DEFAULT_MEET_VIEW_SETTINGS,
  normalizeMeetViewSettings,
  type MeetViewSettings,
} from "../lib/meet-view";
import { getRenderableParticipantVideoStream } from "../lib/participant-media";
import { isRemoteParticipantVisible } from "../lib/participant-visibility";
import { prewarmVideoEffectsAssetsDeferred } from "../lib/video-effects-lazy";

const JoinScreen = dynamic(() => import("./JoinScreen"), {
  ssr: false,
});
const VideoEffectsPanel = dynamic(() => import("./VideoEffectsPanel"), {
  ssr: false,
});
const DevMeetToolsPanel = dynamic(() => import("./DevMeetToolsPanel"), {
  ssr: false,
});

interface MeetsMainContentProps {
  isJoined: boolean;
  /** True under the phone-width breakpoint. Gates compact control/panel layout. */
  isMobile?: boolean;
  connectionState: ConnectionState;
  isLoading: boolean;
  roomId: string;
  setRoomId: Dispatch<SetStateAction<string>>;
  joinRoomById: (roomId: string) => void;
  retryReconnect?: () => Promise<void> | void;
  reconnectRecoveryStatus?: ReconnectRecoveryStatus | null;
  hideJoinUI?: boolean;
  isWebinarAttendee?: boolean;
  enableRoomRouting: boolean;
  forceJoinOnly: boolean;
  allowGhostMode: boolean;
  user?: {
    id?: string;
    email?: string | null;
    name?: string | null;
  };
  userEmail: string;
  isAdmin: boolean;
  showPermissionHint: boolean;
  availableRooms: RoomInfo[];
  roomsStatus: "idle" | "loading" | "error";
  refreshRooms: () => void;
  displayNameInput: string;
  setDisplayNameInput: Dispatch<SetStateAction<string>>;
  ghostEnabled: boolean;
  isGhostMode: boolean;
  setIsGhostMode: Dispatch<SetStateAction<boolean>>;
  presentationStream: MediaStream | null;
  presenterName: string;
  screenShareControlState: CapturedSurfaceControlState;
  screenShareCaptureController: CaptureControllerLike | null;
  localStream: MediaStream | null;
  videoEffects: VideoEffectsState;
  onVideoEffectsChange: Dispatch<SetStateAction<VideoEffectsState>>;
  onVideoEffectsRecenter?: () => void;
  videoEffectsStatus: VideoEffectsRuntimeStatus;
  videoEffectsError: string | null;
  videoEffectsDebugStats?: VideoEffectsDebugStats | null;
  activeVideoEffectsCount: number;
  deferVideoEffectsPreload?: boolean;
  onDevCameraStreamChange?: (stream: MediaStream | null) => void;
  onPrejoinMediaCommit?: (handoff: PrejoinMediaHandoff) => void;
  isCameraOff: boolean;
  isMuted: boolean;
  isMuteTogglePending?: boolean;
  isHandRaised: boolean;
  participants: Map<string, Participant>;
  isMirrorCamera: boolean;
  mirrorLocalPreview: boolean;
  onToggleMirror?: () => void;
  selectedAudioInputDeviceId?: string;
  selectedAudioOutputDeviceId?: string;
  selectedVideoInputDeviceId?: string;
  onAudioInputDeviceChange?: (deviceId: string) => void;
  onAudioOutputDeviceChange?: (deviceId: string) => void;
  onVideoInputDeviceChange?: (deviceId: string) => void;
  activeSpeakerId: string | null;
  currentUserId: string;
  audioOutputDeviceId?: string;
  activeScreenShareId: string | null;
  isScreenSharing: boolean;
  isChatOpen: boolean;
  unreadCount: number;
  reactionOptions: ReactionOption[];
  toggleMute: () => void;
  toggleCamera: () => void;
  toggleScreenShare: () => void;
  toggleChat: () => void;
  toggleHandRaised: () => void;
  sendReaction: (reaction: ReactionOption) => void;
  leaveRoom: () => void;
  isParticipantsOpen: boolean;
  setIsParticipantsOpen: Dispatch<SetStateAction<boolean>>;
  pendingUsers: Map<string, string>;
  chatMessages: ChatMessage[];
  chatInput: string;
  setChatInput: Dispatch<SetStateAction<string>>;
  sendChat: (content: string) => void;
  sendChatGif: (gif: ChatGifAttachment) => void;
  chatOverlayMessages: ChatMessage[];
  setChatOverlayMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  replyTarget: ChatReplyPreview | null;
  onReplyToMessage: (message: ChatMessage) => void;
  onCancelReply: () => void;
  socket: Socket | null;
  setPendingUsers: Dispatch<SetStateAction<Map<string, string>>>;
  resolveDisplayName: (userId: string) => string;
  reactions: ReactionEvent[];
  onUserChange: (
    user: { id: string; email: string; name: string } | null,
  ) => void;
  onIsAdminChange: (isAdmin: boolean) => void;
  onPendingUserStale?: (userId: string) => void;
  isRoomLocked: boolean;
  onToggleLock: () => void;
  isNoGuests: boolean;
  onToggleNoGuests: () => void;
  isChatLocked: boolean;
  onToggleChatLock: () => void;
  browserState?: BrowserState;
  isBrowserLaunching?: boolean;
  browserLaunchError?: string | null;
  showBrowserControls?: boolean;
  onLaunchBrowser?: (url: string) => Promise<boolean>;
  onNavigateBrowser?: (url: string) => Promise<boolean>;
  onCloseBrowser?: () => Promise<boolean>;
  onClearBrowserError?: () => void;
  isBrowserAudioMuted: boolean;
  onToggleBrowserAudio: () => void;
  meetError?: MeetError | null;
  onDismissMeetError?: () => void;
  browserAudioNeedsGesture: boolean;
  onBrowserAudioAutoplayBlocked: () => void;
  isVoiceAgentRunning?: boolean;
  isVoiceAgentStarting?: boolean;
  voiceAgentError?: string | null;
  onStartVoiceAgent?: () => void;
  onStopVoiceAgent?: () => void;
  onClearVoiceAgentError?: () => void;
  onRetryMedia?: () => void;
  isPopoutActive?: boolean;
  isPopoutSupported?: boolean;
  onOpenPopout?: () => void;
  onClosePopout?: () => void;
  hostUserId: string | null;
  hostUserIds: string[];
  isNetworkOffline: boolean;
  serverRestartNotice?: string | null;
  adminNotice?: AdminNoticeNotification | null;
  isTtsDisabled: boolean;
  isDmEnabled: boolean;
  isReactionsDisabled: boolean;
  meetingRequiresInviteCode: boolean;
  webinarConfig?: WebinarConfigSnapshot | null;
  webinarRole?: "attendee" | "participant" | "host" | null;
  webinarSpeakerUserId?: string | null;
  webinarLink?: string | null;
  onSetWebinarLink?: (link: string | null) => void;
  onGetMeetingConfig?: () => Promise<MeetingConfigSnapshot | null>;
  onUpdateMeetingConfig?: (
    update: MeetingUpdateRequest,
  ) => Promise<MeetingConfigSnapshot | null>;
  onGetWebinarConfig?: () => Promise<WebinarConfigSnapshot | null>;
  onUpdateWebinarConfig?: (
    update: WebinarUpdateRequest,
  ) => Promise<WebinarConfigSnapshot | null>;
  onGenerateWebinarLink?: () => Promise<WebinarLinkResponse | null>;
  onRotateWebinarLink?: () => Promise<WebinarLinkResponse | null>;
  transcript: MeetingTranscriptController;
}

const MEET_VIEW_STORAGE_KEY = "conclave:meet-view";

const readStoredMeetViewSettings = (): MeetViewSettings => {
  if (typeof window === "undefined") return DEFAULT_MEET_VIEW_SETTINGS;
  try {
    const storedValue = window.localStorage.getItem(MEET_VIEW_STORAGE_KEY);
    if (!storedValue) return DEFAULT_MEET_VIEW_SETTINGS;
    return normalizeMeetViewSettings(JSON.parse(storedValue));
  } catch {
    return DEFAULT_MEET_VIEW_SETTINGS;
  }
};

const writeStoredMeetViewSettings = (settings: MeetViewSettings) => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      MEET_VIEW_STORAGE_KEY,
      JSON.stringify(normalizeMeetViewSettings(settings)),
    );
  } catch {}
};

const getLiveVideoStream = (stream: MediaStream | null): MediaStream | null => {
  if (!stream) return null;
  const [track] = stream.getVideoTracks();
  if (!track || track.readyState === "ended") {
    return null;
  }
  return stream;
};

const normalizeMentionToken = (value: string): string =>
  value.trim().toLowerCase().replace(/[^a-z0-9._-]/g, "");

const getMentionTokenForParticipant = (
  userId: string,
  displayName: string,
): string => {
  const displayNameToken = normalizeMentionToken(displayName);
  if (displayNameToken) {
    return displayNameToken;
  }

  const base = userId.split("#")[0] || userId;
  const handle = base.split("@")[0] || base;
  return normalizeMentionToken(handle) || normalizeMentionToken(base);
};

type PipCorner = "top-left" | "top-right" | "bottom-left" | "bottom-right";
type PipDragMeta = {
  pointerId: number;
  stageRect: DOMRect;
  pipWidth: number;
  pipHeight: number;
  offsetX: number;
  offsetY: number;
};

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

const WEBINAR_SPEAKER_PROMOTE_DELAY_MS = 450;
const WEBINAR_SPEAKER_MIN_SWITCH_INTERVAL_MS = 1800;
const DOCKED_PANEL_WIDTH = 360;
const GAME_DOCK_MIN_STAGE_WIDTH = 420;

const getGameDockMaxWidth = (
  viewportWidth: number,
  rightOffset: number,
): number =>
  clamp(
    viewportWidth - rightOffset - GAME_DOCK_MIN_STAGE_WIDTH,
    GAME_DOCK_MIN_WIDTH,
    GAME_DOCK_MAX_WIDTH,
  );

const getPipCornerClass = (corner: PipCorner): string => {
  switch (corner) {
    case "top-left":
      return "top-4 left-4";
    case "top-right":
      return "top-4 right-4";
    case "bottom-left":
      return "bottom-4 left-4";
    case "bottom-right":
    default:
      return "bottom-4 right-4";
  }
};

export default function MeetsMainContent({
  isJoined,
  isMobile = false,
  connectionState,
  isLoading,
  roomId,
  setRoomId,
  joinRoomById,
  retryReconnect,
  reconnectRecoveryStatus,
  hideJoinUI = false,
  isWebinarAttendee = false,
  enableRoomRouting,
  forceJoinOnly,
  allowGhostMode,
  user,
  userEmail,
  isAdmin,
  showPermissionHint,
  availableRooms,
  roomsStatus,
  refreshRooms,
  displayNameInput,
  setDisplayNameInput,
  ghostEnabled,
  isGhostMode,
  setIsGhostMode,
  presentationStream,
  presenterName,
  screenShareControlState,
  screenShareCaptureController,
  localStream,
  videoEffects,
  onVideoEffectsChange,
  onVideoEffectsRecenter,
  videoEffectsStatus,
  videoEffectsError,
  videoEffectsDebugStats = null,
  activeVideoEffectsCount,
  deferVideoEffectsPreload = false,
  onDevCameraStreamChange,
  onPrejoinMediaCommit,
  isCameraOff,
  isMuted,
  isMuteTogglePending = false,
  isHandRaised,
  participants,
  isMirrorCamera,
  mirrorLocalPreview,
  onToggleMirror,
  selectedAudioInputDeviceId,
  selectedAudioOutputDeviceId,
  selectedVideoInputDeviceId,
  onAudioInputDeviceChange,
  onAudioOutputDeviceChange,
  onVideoInputDeviceChange,
  activeSpeakerId,
  currentUserId,
  audioOutputDeviceId,
  activeScreenShareId,
  isScreenSharing,
  isChatOpen,
  unreadCount,
  reactionOptions,
  toggleMute,
  toggleCamera,
  toggleScreenShare,
  toggleChat,
  toggleHandRaised,
  sendReaction,
  leaveRoom,
  isParticipantsOpen,
  setIsParticipantsOpen,
  pendingUsers,
  chatMessages,
  chatInput,
  setChatInput,
  sendChat,
  sendChatGif,
  chatOverlayMessages,
  setChatOverlayMessages,
  replyTarget,
  onReplyToMessage,
  onCancelReply,
  socket,
  setPendingUsers,
  resolveDisplayName,
  reactions,
  onUserChange,
  onIsAdminChange,
  onPendingUserStale,
  isRoomLocked,
  onToggleLock,
  isNoGuests,
  onToggleNoGuests,
  isChatLocked,
  onToggleChatLock,
  browserState,
  isBrowserLaunching,
  browserLaunchError,
  showBrowserControls = true,
  onLaunchBrowser,
  onNavigateBrowser,
  onCloseBrowser,
  onClearBrowserError,
  isBrowserAudioMuted,
  onToggleBrowserAudio,
  browserAudioNeedsGesture,
  onBrowserAudioAutoplayBlocked,
  isVoiceAgentRunning = false,
  isVoiceAgentStarting = false,
  voiceAgentError = null,
  onStartVoiceAgent,
  onStopVoiceAgent,
  onClearVoiceAgentError,
  meetError,
  onDismissMeetError,
  onRetryMedia,
  isPopoutActive,
  isPopoutSupported,
  onOpenPopout,
  onClosePopout,
  hostUserId,
  hostUserIds,
  isNetworkOffline,
  serverRestartNotice = null,
  adminNotice = null,
  isTtsDisabled,
  isDmEnabled,
  isReactionsDisabled,
  meetingRequiresInviteCode,
  webinarConfig,
  webinarRole,
  webinarSpeakerUserId,
  webinarLink,
  onSetWebinarLink,
  onGetMeetingConfig,
  onUpdateMeetingConfig,
  onGetWebinarConfig,
  onUpdateWebinarConfig,
  onGenerateWebinarLink,
  onRotateWebinarLink,
  transcript,
}: MeetsMainContentProps) {
  const {
    state: appsState,
    openApp,
    closeApp,
    setLocked,
    refreshState,
  } = useApps();
  const { isActive: isGameActive, refresh: refreshGameState } = useGame();
  const [isGamesOpen, setIsGamesOpen] = useState(false);
  const isDevToolsEnabled = process.env.NODE_ENV === "development";
  const isDevPlaygroundEnabled = isDevToolsEnabled;
  const isWhiteboardActive = appsState.activeAppId === "whiteboard";
  const isDevPlaygroundActive = appsState.activeAppId === "dev-playground";
  const handleOpenWhiteboard = useCallback(
    () => openApp("whiteboard"),
    [openApp],
  );
  const handleCloseWhiteboard = useCallback(() => closeApp(), [closeApp]);
  const handleOpenDevPlayground = useCallback(
    () => openApp("dev-playground"),
    [openApp],
  );
  const handleCloseDevPlayground = useCallback(() => closeApp(), [closeApp]);
  const handleToggleAppsLock = useCallback(
    () => setLocked(!appsState.locked),
    [appsState.locked, setLocked],
  );
  useEffect(() => {
    if (connectionState === "joined") {
      refreshState();
      refreshGameState();
    }
  }, [connectionState, refreshState, refreshGameState]);
  const participantsArray = useMemo(
    () => Array.from(participants.values()),
    [participants],
  );
  const nonSystemParticipants = useMemo(
    () =>
      participantsArray.filter(
        (participant) =>
          participant.userId !== currentUserId &&
          !isSystemUserId(participant.userId) &&
          isRemoteParticipantVisible(
            participant,
            ghostEnabled,
            currentUserId,
          ),
      ),
    [currentUserId, ghostEnabled, participantsArray],
  );
  const webinarParticipantIds = useMemo(
    () => nonSystemParticipants.map((participant) => participant.userId),
    [nonSystemParticipants],
  );
  const stableWebinarSpeakerId = useStableSpeakerId({
    primarySpeakerId: webinarSpeakerUserId,
    secondarySpeakerId: activeSpeakerId,
    participantIds: webinarParticipantIds,
    promoteDelayMs: WEBINAR_SPEAKER_PROMOTE_DELAY_MS,
    minSwitchIntervalMs: WEBINAR_SPEAKER_MIN_SWITCH_INTERVAL_MS,
  });
  const webinarStageRef = useRef<HTMLDivElement>(null);
  const pipDragRef = useRef<PipDragMeta | null>(null);
  const [pipCorner, setPipCorner] = useState<PipCorner>("bottom-right");
  const [pipDragPosition, setPipDragPosition] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [webinarAudioBlocked, setWebinarAudioBlocked] = useState(false);
  const [webinarAudioPlaybackAttempt, setWebinarAudioPlaybackAttempt] = useState(0);
  // Right-docked panels are owned here so the stage reserve stays in sync.
  const [isHostControlsOpen, setIsHostControlsOpen] = useState(false);
  const [isVideoEffectsOpen, setIsVideoEffectsOpen] = useState(false);
  const [isViewPanelOpen, setIsViewPanelOpen] = useState(false);
  const [isTranscriptOpen, setIsTranscriptOpen] = useState(false);
  const [canReserveDockedPanel, setCanReserveDockedPanel] = useState(false);
  const [viewportWidth, setViewportWidth] = useState(1280);
  const [gameDockWidth, setGameDockWidth] = useState(
    GAME_DOCK_DEFAULT_WIDTH,
  );
  const [showAndroidUpsell, setShowAndroidUpsell] = useState(false);
  const [viewSettings, setViewSettings] = useState<MeetViewSettings>(
    readStoredMeetViewSettings,
  );
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mediaQuery = window.matchMedia("(min-width: 640px)");
    const updateReserveBreakpoint = () => {
      setCanReserveDockedPanel(mediaQuery.matches);
    };

    updateReserveBreakpoint();
    mediaQuery.addEventListener("change", updateReserveBreakpoint);
    return () => {
      mediaQuery.removeEventListener("change", updateReserveBreakpoint);
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onResize = () => setViewportWidth(window.innerWidth);
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  useEffect(() => {
    writeStoredMeetViewSettings(viewSettings);
  }, [viewSettings]);
  useEffect(() => {
    if (typeof navigator === "undefined" || typeof window === "undefined") return;
    const isAndroid = /android/i.test(navigator.userAgent);
    const dismissed = window.localStorage.getItem(
      "conclave_android_upsell_dismissed",
    );
    if (isAndroid && !dismissed) {
      setShowAndroidUpsell(true);
    }
  }, []);
  const dismissAndroidUpsell = useCallback(() => {
    setShowAndroidUpsell(false);
    if (typeof window !== "undefined") {
      window.localStorage.setItem("conclave_android_upsell_dismissed", "1");
    }
  }, []);
  const [devPresentationStream, setDevPresentationStream] =
    useState<MediaStream | null>(null);
  const [devCameraStream, setDevCameraStream] =
    useState<MediaStream | null>(null);
  const cameraPermissionState = useCameraPermissionState();
  const hasLiveLocalCamera = Boolean(getLiveVideoStream(localStream));
  const hasLiveDevCamera = Boolean(getLiveVideoStream(devCameraStream));
  const isCameraPermissionBlocked =
    meetError?.code === "PERMISSION_DENIED" ||
    (!hasLiveLocalCamera &&
      !hasLiveDevCamera &&
      (cameraPermissionState === "prompt" ||
        cameraPermissionState === "denied"));
  // You're the one sharing your screen, so the stage tile defaults to a
  // chooser instead of mirroring your own share back at you (see
  // GridLayout's `isLocalPresenter` handling).
  const isLocalPresenter = isScreenSharing && Boolean(presentationStream);
  const effectivePresentationStream =
    presentationStream ?? devPresentationStream;
  const effectivePresenterName = presentationStream
    ? presenterName
    : devPresentationStream
      ? "Dev presentation"
      : presenterName;
  const shouldUseDevCameraStream =
    Boolean(devCameraStream) && !getLiveVideoStream(localStream);
  const effectiveLocalStream = shouldUseDevCameraStream
    ? devCameraStream
    : localStream;
  const hasRenderedLocalVideo = Boolean(getLiveVideoStream(effectiveLocalStream));
  const effectiveIsCameraOff =
    shouldUseDevCameraStream && hasLiveDevCamera ? false : isCameraOff;
  const effectiveActiveSpeakerId =
    shouldUseDevCameraStream && hasLiveDevCamera
      ? currentUserId
      : activeSpeakerId;
  const handleDevCameraStreamChange = useCallback(
    (stream: MediaStream | null) => {
      setDevCameraStream(stream);
      onDevCameraStreamChange?.(stream);
    },
    [onDevCameraStreamChange],
  );

  const webinarStage = useMemo(() => {
    if (!nonSystemParticipants.length) {
      return null;
    }

    const byScreenShareId = activeScreenShareId
      ? nonSystemParticipants.find(
          (participant) =>
            participant.screenShareProducerId === activeScreenShareId &&
            getLiveVideoStream(participant.screenShareStream),
        )
      : null;
    const byAnyScreenShare = nonSystemParticipants.find(
      (participant) => getLiveVideoStream(participant.screenShareStream),
    );
    const fallbackAudioStream =
      nonSystemParticipants.find((participant) => participant.audioStream)
        ?.audioStream ?? null;
    const screenShareParticipant = byScreenShareId ?? byAnyScreenShare;

    if (screenShareParticipant) {
      const screenShareStream =
        getLiveVideoStream(screenShareParticipant.screenShareStream);
      if (screenShareStream) {
        const mainAudioStream =
          screenShareParticipant.audioStream ?? fallbackAudioStream;
        const presenterCameraStream = getLiveVideoStream(
          getRenderableParticipantVideoStream(screenShareParticipant),
        );

        return {
          main: {
            participant: {
              ...screenShareParticipant,
              videoStream: screenShareStream,
              audioStream: mainAudioStream,
              isCameraOff: false,
              isVideoAdaptivelyPaused: false,
            },
            displayName: resolveDisplayName(screenShareParticipant.userId),
          },
          pip: presenterCameraStream
            ? {
                participant: {
                  ...screenShareParticipant,
                  videoStream: presenterCameraStream,
                  screenShareStream: null,
                  audioStream: null,
                  isMuted: true,
                  isCameraOff: false,
                  isVideoAdaptivelyPaused: false,
                },
                displayName: resolveDisplayName(screenShareParticipant.userId),
              }
            : null,
          isScreenShare: true,
        };
      }
    }

    const preferredIds = [
      stableWebinarSpeakerId ?? null,
      webinarSpeakerUserId ?? null,
      activeSpeakerId ?? null,
    ].filter((value, index, list): value is string => {
      return Boolean(value) && list.indexOf(value) === index;
    });
    const preferredParticipant = preferredIds
      .map((userId) =>
        nonSystemParticipants.find((participant) => participant.userId === userId),
      )
      .find((participant) => participant !== undefined);
    const preferredVideoParticipant =
      preferredParticipant &&
      getLiveVideoStream(getRenderableParticipantVideoStream(preferredParticipant))
        ? preferredParticipant
        : null;
    const preferredAudioParticipant =
      preferredParticipant && preferredParticipant.audioStream
        ? preferredParticipant
        : null;

    const cameraParticipant =
      preferredVideoParticipant ??
      nonSystemParticipants.find(
        (participant) =>
          getLiveVideoStream(getRenderableParticipantVideoStream(participant)),
      ) ??
      nonSystemParticipants.find((participant) =>
        getLiveVideoStream(getRenderableParticipantVideoStream(participant)),
      ) ??
      preferredAudioParticipant ??
      nonSystemParticipants.find((participant) => participant.audioStream) ??
      nonSystemParticipants[0];
    const cameraStream = getLiveVideoStream(
      getRenderableParticipantVideoStream(cameraParticipant),
    );
    const mainAudioStream = cameraParticipant.audioStream ?? fallbackAudioStream;

    return {
      main: {
        participant: {
          ...cameraParticipant,
          videoStream: cameraStream,
          screenShareStream: null,
          audioStream: mainAudioStream,
          isCameraOff: !cameraStream,
          isVideoAdaptivelyPaused: false,
        },
        displayName: resolveDisplayName(cameraParticipant.userId),
      },
      pip: null,
      isScreenShare: false,
    };
  }, [
    activeScreenShareId,
    activeSpeakerId,
    nonSystemParticipants,
    resolveDisplayName,
    stableWebinarSpeakerId,
    webinarSpeakerUserId,
  ]);
  const pipCornerClass = useMemo(() => getPipCornerClass(pipCorner), [pipCorner]);
  const handlePipPointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const stage = webinarStageRef.current;
      if (!stage) return;

      const stageRect = stage.getBoundingClientRect();
      const pipRect = event.currentTarget.getBoundingClientRect();

      pipDragRef.current = {
        pointerId: event.pointerId,
        stageRect,
        pipWidth: pipRect.width,
        pipHeight: pipRect.height,
        offsetX: event.clientX - pipRect.left,
        offsetY: event.clientY - pipRect.top,
      };

      setPipDragPosition({
        x: pipRect.left - stageRect.left,
        y: pipRect.top - stageRect.top,
      });

      event.currentTarget.setPointerCapture(event.pointerId);
      event.preventDefault();
    },
    [],
  );
  const handlePipPointerMove = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const drag = pipDragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;

      const minX = 12;
      const minY = 12;
      const maxX = Math.max(minX, drag.stageRect.width - drag.pipWidth - 12);
      const maxY = Math.max(minY, drag.stageRect.height - drag.pipHeight - 12);
      const nextX = clamp(
        event.clientX - drag.stageRect.left - drag.offsetX,
        minX,
        maxX,
      );
      const nextY = clamp(
        event.clientY - drag.stageRect.top - drag.offsetY,
        minY,
        maxY,
      );

      setPipDragPosition({ x: nextX, y: nextY });
      event.preventDefault();
    },
    [],
  );
  const handlePipPointerUp = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const drag = pipDragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;

      const minX = 12;
      const minY = 12;
      const maxX = Math.max(minX, drag.stageRect.width - drag.pipWidth - 12);
      const maxY = Math.max(minY, drag.stageRect.height - drag.pipHeight - 12);
      const finalX = pipDragPosition
        ? pipDragPosition.x
        : clamp(
            event.clientX - drag.stageRect.left - drag.offsetX,
            minX,
            maxX,
          );
      const finalY = pipDragPosition
        ? pipDragPosition.y
        : clamp(
            event.clientY - drag.stageRect.top - drag.offsetY,
            minY,
            maxY,
          );
      const horizontal =
        finalX + drag.pipWidth / 2 <= drag.stageRect.width / 2 ? "left" : "right";
      const vertical =
        finalY + drag.pipHeight / 2 <= drag.stageRect.height / 2 ? "top" : "bottom";
      setPipCorner(`${vertical}-${horizontal}` as PipCorner);
      setPipDragPosition(null);
      pipDragRef.current = null;

      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      event.preventDefault();
    },
    [pipDragPosition],
  );
  const handlePipPointerCancel = useCallback(() => {
    pipDragRef.current = null;
    setPipDragPosition(null);
  }, []);
  const handleWebinarAudioAutoplayBlocked = useCallback(() => {
    setWebinarAudioBlocked(true);
  }, []);
  const handleWebinarAudioPlaybackStarted = useCallback(() => {
    setWebinarAudioBlocked(false);
  }, []);
  const handlePlayWebinarAudio = useCallback(() => {
    setWebinarAudioBlocked(false);
    setWebinarAudioPlaybackAttempt((attempt) => attempt + 1);
  }, []);
  useEffect(() => {
    if (isJoined && isWebinarAttendee) return;
    setWebinarAudioBlocked(false);
    setWebinarAudioPlaybackAttempt(0);
  }, [isJoined, isWebinarAttendee]);
  const visibleParticipantCount = nonSystemParticipants.length;
  const mentionableParticipants = useMemo(
    () =>
      nonSystemParticipants
        .filter((participant) => participant.userId !== currentUserId)
        .map((participant) => {
          const displayName = formatDisplayName(
            resolveDisplayName(participant.userId),
          );
          return {
            userId: participant.userId,
            displayName,
            mentionToken: getMentionTokenForParticipant(
              participant.userId,
              displayName,
            ),
          };
        })
        .sort((left, right) => left.displayName.localeCompare(right.displayName)),
    [nonSystemParticipants, currentUserId, resolveDisplayName],
  );
  const handleToggleParticipants = useCallback(() => {
    const opening = !isParticipantsOpen;
    // Fire the chat side effect outside the state updater so StrictMode's
    // double-invoke doesn't toggle chat twice and leave panels open.
    if (opening && isChatOpen) {
      toggleChat();
    }
    if (opening) {
      setIsHostControlsOpen(false);
      setIsVideoEffectsOpen(false);
      setIsViewPanelOpen(false);
      setIsTranscriptOpen(false);
    }
    setIsParticipantsOpen(opening);
  }, [isParticipantsOpen, isChatOpen, setIsParticipantsOpen, toggleChat]);

  const isChatOpenRef = useRef(isChatOpen);
  useEffect(() => {
    isChatOpenRef.current = isChatOpen;
  }, [isChatOpen]);

  const handleOpenParticipants = useCallback(() => {
    if (isChatOpenRef.current) {
      toggleChat();
    }
    setIsHostControlsOpen(false);
    setIsVideoEffectsOpen(false);
    setIsViewPanelOpen(false);
    setIsTranscriptOpen(false);
    setIsParticipantsOpen(true);
  }, [toggleChat, setIsParticipantsOpen]);

  const handleCloseParticipants = useCallback(
    () => setIsParticipantsOpen(false),
    [setIsParticipantsOpen],
  );

  // The game dock (launcher / active game) is independent of the chat &
  // participants panels: on wide screens it docks side-by-side with them, so
  // you can chat while a game runs. Toggling it does NOT close the others.
  const handleToggleGames = useCallback(() => {
    setIsGamesOpen((open) => !open);
  }, []);

  // Once a game is actually running, the active GamePanel takes the dock slot,
  // so collapse the (now-redundant) launcher.
  useEffect(() => {
    if (isGameActive) setIsGamesOpen(false);
  }, [isGameActive]);

  // Secondary right-dock panels (chat, participants, etc). The game dock sits to
  // the left of these when both are open on a wide enough screen.
  const isSecondaryPanelOpen =
    isChatOpen ||
    isParticipantsOpen ||
    isHostControlsOpen ||
    isVideoEffectsOpen ||
    isViewPanelOpen ||
    isTranscriptOpen;
  const isGameDockPresent = isGameActive || isGamesOpen;
  const gameDockOffset =
    canReserveDockedPanel && isSecondaryPanelOpen ? DOCKED_PANEL_WIDTH : 0;
  const gameDockMaxWidth = useMemo(
    () => getGameDockMaxWidth(viewportWidth, gameDockOffset),
    [gameDockOffset, viewportWidth],
  );
  const handleGameDockWidthChange = useCallback(
    (nextWidth: number) => {
      setGameDockWidth(
        clamp(Math.round(nextWidth), GAME_DOCK_MIN_WIDTH, gameDockMaxWidth),
      );
    },
    [gameDockMaxWidth],
  );
  useEffect(() => {
    setGameDockWidth((currentWidth) =>
      clamp(currentWidth, GAME_DOCK_MIN_WIDTH, gameDockMaxWidth),
    );
  }, [gameDockMaxWidth]);
  const gameDockPanelWidth = canReserveDockedPanel
    ? gameDockWidth
    : undefined;

  const handleToggleHostControls = useCallback(() => {
    const opening = !isHostControlsOpen;
    // One right-dock panel at a time. Fire the side effects OUTSIDE the setState
    // updater so StrictMode's double-invoke doesn't toggle chat twice and leave
    // both panels docked (mirrors handleToggleParticipants).
    if (opening && isChatOpenRef.current) {
      toggleChat();
    }
    if (opening) {
      setIsParticipantsOpen(false);
      setIsVideoEffectsOpen(false);
      setIsViewPanelOpen(false);
      setIsTranscriptOpen(false);
    }
    setIsHostControlsOpen(opening);
  }, [isHostControlsOpen, toggleChat, setIsParticipantsOpen]);

  const handleCloseHostControls = useCallback(
    () => setIsHostControlsOpen(false),
    [],
  );

  const prewarmEffectsPanelOpen = useCallback(() => {
    if (deferVideoEffectsPreload) return;
    void prewarmVideoEffectsAssetsDeferred({
      segmentation: true,
      face: true,
      faceFilter:
        videoEffects.filter !== "none" ? videoEffects.filter : undefined,
      reason: "effects-panel-open",
    });
  }, [deferVideoEffectsPreload, videoEffects.filter]);

  const handleToggleVideoEffects = useCallback(() => {
    if (isCameraPermissionBlocked) return;
    const opening = !isVideoEffectsOpen;
    if (opening) {
      prewarmEffectsPanelOpen();
    }
    if (opening && isChatOpenRef.current) {
      toggleChat();
    }
    if (opening) {
      setIsParticipantsOpen(false);
      setIsHostControlsOpen(false);
      setIsViewPanelOpen(false);
      setIsTranscriptOpen(false);
    }
    setIsVideoEffectsOpen(opening);
  }, [
    isCameraPermissionBlocked,
    isVideoEffectsOpen,
    prewarmEffectsPanelOpen,
    setIsParticipantsOpen,
    toggleChat,
  ]);

  const handleCloseVideoEffects = useCallback(
    () => setIsVideoEffectsOpen(false),
    [],
  );
  const handleOpenVideoEffects = useCallback(() => {
    if (isCameraPermissionBlocked) return;
    prewarmEffectsPanelOpen();
    if (isChatOpenRef.current) {
      toggleChat();
    }
    setIsParticipantsOpen(false);
    setIsHostControlsOpen(false);
    setIsViewPanelOpen(false);
    setIsTranscriptOpen(false);
    setIsVideoEffectsOpen(true);
  }, [
    isCameraPermissionBlocked,
    prewarmEffectsPanelOpen,
    setIsParticipantsOpen,
    toggleChat,
  ]);

  const handleToggleViewPanel = useCallback(() => {
    const opening = !isViewPanelOpen;
    if (opening && isChatOpenRef.current) {
      toggleChat();
    }
    if (opening) {
      setIsParticipantsOpen(false);
      setIsHostControlsOpen(false);
      setIsVideoEffectsOpen(false);
      setIsTranscriptOpen(false);
    }
    setIsViewPanelOpen(opening);
  }, [isViewPanelOpen, setIsParticipantsOpen, toggleChat]);

  const handleCloseViewPanel = useCallback(() => {
    setIsViewPanelOpen(false);
  }, []);

  const handleToggleTranscript = useCallback(() => {
    const opening = !isTranscriptOpen;
    if (opening && isChatOpenRef.current) {
      toggleChat();
    }
    if (opening) {
      setIsParticipantsOpen(false);
      setIsHostControlsOpen(false);
      setIsVideoEffectsOpen(false);
      setIsViewPanelOpen(false);
    }
    setIsTranscriptOpen(opening);
  }, [isTranscriptOpen, setIsParticipantsOpen, toggleChat]);

  const handleCloseTranscript = useCallback(() => {
    setIsTranscriptOpen(false);
  }, []);

  const handleToggleVideoFraming = useCallback(() => {
    if (!deferVideoEffectsPreload) {
      void prewarmVideoEffectsAssetsDeferred({
        face: true,
        reason: "meeting-framing-toggle:select",
      });
    }
    onVideoEffectsChange((current) => ({
      ...current,
      framing: !current.framing,
    }));
  }, [deferVideoEffectsPreload, onVideoEffectsChange]);
  useEffect(() => {
    if (!isChatOpen || chatOverlayMessages.length === 0) return;
    setChatOverlayMessages([]);
  }, [isChatOpen, chatOverlayMessages.length, setChatOverlayMessages]);

  const sendChatRef = useRef(sendChat);
  useEffect(() => {
    sendChatRef.current = sendChat;
  }, [sendChat]);
  const handleSendChat = useCallback((content: string) => {
    sendChatRef.current(content);
  }, []);
  const sendChatGifRef = useRef(sendChatGif);
  useEffect(() => {
    sendChatGifRef.current = sendChatGif;
  }, [sendChatGif]);
  const handleSendChatGif = useCallback((gif: ChatGifAttachment) => {
    sendChatGifRef.current(gif);
  }, []);

  const handleToggleTtsDisabled = useCallback(() => {
    if (!socket) return;
    socket.emit(
      "setTtsDisabled",
      { disabled: !isTtsDisabled },
      (res: { error?: string }) => {
        if (res?.error) {
          console.error("Failed to toggle TTS:", res.error);
        }
      },
    );
  }, [socket, isTtsDisabled]);

  const handleToggleDmEnabled = useCallback(() => {
    if (!socket) return;
    socket.emit(
      "setDmEnabled",
      { enabled: !isDmEnabled },
      (res: { error?: string }) => {
        if (res?.error) {
          console.error("Failed to toggle direct messages:", res.error);
        }
      },
    );
  }, [socket, isDmEnabled]);

  const handleToggleReactionsDisabled = useCallback(() => {
    if (!socket) return;
    socket.emit(
      "setReactionsDisabled",
      { disabled: !isReactionsDisabled },
      (res: { error?: string }) => {
        if (res?.error) {
          console.error("Failed to toggle reactions:", res.error);
        }
      },
    );
  }, [socket, isReactionsDisabled]);

  const handleToggleChat = useCallback(() => {
    if (!isChatOpen) {
      if (isParticipantsOpen) {
        setIsParticipantsOpen(false);
      }
      setIsHostControlsOpen(false);
      setIsVideoEffectsOpen(false);
      setIsViewPanelOpen(false);
      setIsTranscriptOpen(false);
    }
    toggleChat();
  }, [isChatOpen, isParticipantsOpen, setIsParticipantsOpen, toggleChat]);

  const handlePendingUserStale = useCallback(
    (staleUserId: string) => {
      setPendingUsers((prev) => {
        const next = new Map(prev);
        next.delete(staleUserId);
        return next;
      });
      onPendingUserStale?.(staleUserId);
    },
    [onPendingUserStale, setPendingUsers],
  );
  const hasBrowserAudio = useMemo(
    () =>
      participantsArray.some(
        (participant) =>
          isSystemUserId(participant.userId) &&
          Boolean(participant.audioStream),
      ),
    [participantsArray],
  );
  const browserVideoStream = useMemo(() => {
    const videoParticipant = participantsArray.find(
      (participant) =>
        isBrowserVideoUserId(participant.userId) &&
        participant.screenShareStream,
    );
    return videoParticipant?.screenShareStream ?? null;
  }, [participantsArray]);
  const dockedPanelReserve =
    canReserveDockedPanel && isJoined && !isWebinarAttendee
      ? (isSecondaryPanelOpen ? DOCKED_PANEL_WIDTH : 0) +
        (isGameDockPresent ? gameDockWidth : 0)
      : 0;
  const mainContentStyle = isJoined
    ? { paddingRight: `calc(1rem + ${dockedPanelReserve}px)` }
    : undefined;
  // When docked panels eat into the stage, the full controls bar (clock +
  // center + side cluster) gets cramped. Fold it to its compact layout once the
  // remaining width is tight so it stays comfortable instead of squeezing.
  const stageWidth = viewportWidth - dockedPanelReserve;
  const isControlsBarTight = !isMobile && isJoined && stageWidth < 900;
  const useCompactControls = isMobile || isControlsBarTight;
  const isRecoveringMeeting = isJoined && connectionState !== "joined";
  const isTerminalMeetingError =
    Boolean(meetError) && meetError?.recoverable === false;
  const canRetryRecovery = !isTerminalMeetingError && !isNetworkOffline;
  const isReconnectRetryBusy =
    reconnectRecoveryStatus?.phase === "connecting" ||
    reconnectRecoveryStatus?.phase === "joining";
  const reconnectRetryAt = reconnectRecoveryStatus?.retryAt ?? null;
  const [reconnectCountdownSeconds, setReconnectCountdownSeconds] =
    useState<number | null>(null);

  useEffect(() => {
    if (!reconnectRetryAt) {
      setReconnectCountdownSeconds(null);
      return;
    }

    const updateCountdown = () => {
      setReconnectCountdownSeconds(
        Math.max(0, Math.ceil((reconnectRetryAt - Date.now()) / 1000)),
      );
    };

    updateCountdown();
    const intervalId = window.setInterval(updateCountdown, 250);
    return () => {
      window.clearInterval(intervalId);
    };
  }, [reconnectRetryAt]);

  const reconnectAttemptLabel =
    reconnectRecoveryStatus && reconnectRecoveryStatus.attempt > 0
      ? `Attempt ${Math.min(
          reconnectRecoveryStatus.attempt,
          reconnectRecoveryStatus.maxAttempts,
        )} of ${reconnectRecoveryStatus.maxAttempts}`
      : null;
  const reconnectLastError = reconnectRecoveryStatus?.lastError ?? null;
  const recoveryTitle = isNetworkOffline
    ? "Waiting for internet"
    : isTerminalMeetingError
      ? "Meeting unavailable"
      : reconnectRecoveryStatus?.phase === "failed"
        ? "Reconnect failed"
        : canRetryRecovery
          ? "Connection interrupted"
          : "Reconnecting";
  const recoveryDetail = isNetworkOffline
    ? "We are keeping the room open and will restore media when your connection returns."
    : connectionState === "connected" || connectionState === "joining"
      ? "Connection is back. Restoring media, participants, and room state."
      : isTerminalMeetingError
        ? meetError?.message
      : reconnectRetryAt && reconnectCountdownSeconds !== null
        ? reconnectCountdownSeconds > 0
          ? `Retrying automatically in ${reconnectCountdownSeconds}s.`
          : "Retrying reconnect now."
      : reconnectRecoveryStatus?.message
        ? reconnectRecoveryStatus.message
      : canRetryRecovery
        ? (meetError?.message ?? "We could not restore the connection yet.")
        : "Keeping your meeting open while the connection is restored.";
  return (
    <div
      className={`flex-1 flex flex-col relative ${
        isJoined ? "overflow-hidden p-4" : "overflow-y-auto p-0"
      }`}
      style={mainContentStyle}
    >
      {isJoined &&
        !isRecoveringMeeting &&
        (!isWebinarAttendee || serverRestartNotice) && (
        <ConnectionBanner
          state={connectionState}
          isOffline={isNetworkOffline}
          serverRestartNotice={serverRestartNotice}
        />
      )}
      {isRecoveringMeeting && (
        <div
          className="absolute inset-0 z-[95] flex items-center justify-center bg-[#050506]/70 px-4 backdrop-blur-md animate-fade-in"
          aria-live="assertive"
          aria-label="Reconnecting to the meeting"
        >
          <section
            className="w-full max-w-[400px] animate-scale-in rounded-2xl border border-[#fafafa]/12 bg-[#131316]/95 px-7 py-8 text-center shadow-2xl"
            style={{ fontFamily: "'PolySans Trial', sans-serif" }}
            role="dialog"
            aria-modal="true"
          >
            <div className="relative mx-auto h-11 w-11">
              <div className="absolute inset-0 rounded-full border-2 border-[#fafafa]/10" />
              <div className="absolute inset-0 animate-spin rounded-full border-2 border-transparent border-t-[#F95F4A]" />
              <div className="absolute inset-[5px] rounded-full bg-[#F95F4A]/10" />
            </div>
            <h2
              className="mt-5 text-balance text-[17px] leading-tight text-[#fafafa]"
              style={{ fontFamily: "'PolySans Bulky Wide', sans-serif" }}
            >
              {recoveryTitle}
            </h2>
            <p className="mx-auto mt-2 max-w-[280px] text-pretty text-[12.5px] leading-relaxed text-[#fafafa]/60">
              {recoveryDetail}
            </p>
            {reconnectAttemptLabel ? (
              <p className="mt-2.5 text-[11px] font-medium uppercase tracking-[0.16em] text-[#fafafa]/38">
                {reconnectAttemptLabel}
              </p>
            ) : null}
            {reconnectLastError ? (
              <div className="mx-auto mt-4 w-full max-w-[320px] rounded-xl border border-[#fafafa]/8 bg-[#fafafa]/[0.03] px-3.5 py-2.5 text-left">
                <p className="text-[9.5px] font-semibold uppercase tracking-[0.16em] text-[#fafafa]/40">
                  Last error
                </p>
                <p className="mt-1 break-words text-[11.5px] leading-relaxed text-[#fafafa]/55">
                  {reconnectLastError}
                </p>
              </div>
            ) : null}
            <div className="mt-5 flex items-center justify-center gap-2.5">
              {canRetryRecovery ? (
                <button
                  type="button"
                  disabled={isReconnectRetryBusy}
                  onClick={() => {
                    if (retryReconnect) {
                      void retryReconnect();
                      return;
                    }
                    void joinRoomById(roomId);
                  }}
                  className="inline-flex h-9 items-center justify-center gap-2 rounded-full border border-[#F95F4A]/45 bg-[#F95F4A]/20 px-4 text-[12.5px] font-medium text-[#fafafa] transition-all hover:border-[#F95F4A]/70 hover:bg-[#F95F4A]/35 disabled:cursor-not-allowed disabled:border-[#fafafa]/12 disabled:bg-[#fafafa]/8 disabled:text-[#fafafa]/42"
                >
                  <RefreshCw
                    size={14}
                    strokeWidth={1.8}
                    className={isReconnectRetryBusy ? "animate-spin" : undefined}
                  />
                  {isReconnectRetryBusy
                    ? "Retrying"
                    : reconnectRecoveryStatus?.phase === "failed"
                      ? "Try again"
                      : "Retry now"}
                </button>
              ) : null}
              <button
                type="button"
                onClick={leaveRoom}
                className="inline-flex h-9 items-center justify-center gap-2 rounded-full border border-[#fafafa]/15 px-4 text-[12.5px] font-medium text-[#fafafa]/76 transition-all hover:border-[#fafafa]/35 hover:bg-[#fafafa]/10 hover:text-[#fafafa]"
              >
                <LogOut size={14} strokeWidth={1.8} />
                Leave
              </button>
            </div>
          </section>
        </div>
      )}
      {isJoined && <AdminNoticePill notice={adminNotice} />}
      <SystemAudioPlayers
        participants={participants}
        audioOutputDeviceId={audioOutputDeviceId}
        muted={isBrowserAudioMuted}
        onAutoplayBlocked={onBrowserAudioAutoplayBlocked}
      />
      <ScreenShareAudioPlayers
        participants={participants}
        currentUserId={currentUserId}
        audioOutputDeviceId={audioOutputDeviceId}
        onAutoplayBlocked={
          isWebinarAttendee ? handleWebinarAudioAutoplayBlocked : undefined
        }
        onPlaybackStarted={
          isWebinarAttendee ? handleWebinarAudioPlaybackStarted : undefined
        }
        playbackAttemptToken={
          isWebinarAttendee ? webinarAudioPlaybackAttempt : undefined
        }
      />
      {isJoined && reactions.length > 0 && (
        <ReactionOverlay
          reactions={reactions}
          getDisplayName={resolveDisplayName}
        />
      )}
      {isDevToolsEnabled && isJoined && !isWebinarAttendee && (
        <DevMeetToolsPanel
          roomId={roomId}
          onPresentationStreamChange={setDevPresentationStream}
          onCameraStreamChange={handleDevCameraStreamChange}
        />
      )}
      {!isJoined ? (
        hideJoinUI ? (
          (() => {
            const errorMessage = meetError?.message ?? "";
            const isWaitingForHost =
              /not live|not started|no room|not ready/i.test(errorMessage);
            const isFatal = errorMessage && !isWaitingForHost;
            const headline = isFatal
              ? "we hit a snag"
              : isWaitingForHost
                ? "waiting for the host to start"
                : isLoading
                  ? "getting you in"
                  : "almost there";
            return (
              <main className="flex min-h-dvh items-center justify-center bg-[#0a0a0b] px-4 py-10 text-[#fafafa]">
                <section className="animate-fade-in w-full max-w-[420px] rounded-2xl border border-white/10 bg-[#0e0e10] p-6 sm:p-8 text-center">
                  <div className="mx-auto mb-4 flex items-center justify-center gap-2">
                    <span
                      className={`h-2 w-2 rounded-full ${
                        isFatal ? "bg-[#F95F4A]" : "bg-[#F95F4A] animate-pulse"
                      }`}
                    />
                    <span className="text-[11.5px] font-semibold uppercase tracking-[0.07em] text-[#fafafa]/40">
                      {isFatal
                        ? "Couldn't join the room"
                        : isWaitingForHost
                          ? "The room isn't open yet"
                          : isLoading
                            ? "Connecting"
                            : "Preparing"}
                    </span>
                  </div>
                  <h1
                    className="text-[22px] leading-tight text-[#fafafa]"
                    style={{ fontFamily: "'PolySans Bulky Wide', sans-serif" }}
                  >
                    {headline}
                  </h1>
                  {isWaitingForHost ? (
                    <p className="mt-2 text-[13.5px] leading-snug text-[#fafafa]/55">
                      Hang tight. This page will refresh on its own the moment
                      the host opens the room.
                    </p>
                  ) : isFatal ? (
                    <p className="mt-2 text-[13.5px] leading-snug text-[#fafafa]/55">
                      {errorMessage}
                    </p>
                  ) : (
                    <p className="mt-2 text-[13.5px] leading-snug text-[#fafafa]/55">
                      Sit tight. Getting your camera, mic, and the room ready in
                      a moment.
                    </p>
                  )}
                </section>
              </main>
            );
          })()
        ) : (
          <JoinScreen
            roomId={roomId}
            onRoomIdChange={setRoomId}
            isLoading={isLoading}
            user={user}
            userEmail={userEmail}
            connectionState={connectionState}
            isAdmin={isAdmin}
            enableRoomRouting={enableRoomRouting}
            forceJoinOnly={forceJoinOnly}
            allowGhostMode={allowGhostMode}
            showPermissionHint={showPermissionHint}
            rooms={availableRooms}
            roomsStatus={roomsStatus}
            onRefreshRooms={refreshRooms}
            onJoinRoom={joinRoomById}
            displayNameInput={displayNameInput}
            onDisplayNameInputChange={setDisplayNameInput}
            isGhostMode={isGhostMode}
            onGhostModeChange={setIsGhostMode}
            onUserChange={onUserChange}
            onIsAdminChange={onIsAdminChange}
            meetError={meetError}
            onDismissMeetError={onDismissMeetError}
            onRetryMedia={onRetryMedia}
            videoEffects={videoEffects}
            onVideoEffectsChange={onVideoEffectsChange}
            onPrejoinMediaCommit={onPrejoinMediaCommit}
          />
        )
      ) : isWebinarAttendee ? (
        <div className="relative flex flex-1 items-center justify-center p-4">
          {webinarStage ? (
            <div ref={webinarStageRef} className="relative h-[72vh] w-full max-w-6xl">
              <ParticipantVideo
                key={webinarStage.main.participant.userId}
                participant={webinarStage.main.participant}
                displayName={webinarStage.main.displayName}
                isActiveSpeaker={
                  activeSpeakerId === webinarStage.main.participant.userId
                }
                audioOutputDeviceId={audioOutputDeviceId}
                videoObjectFit={webinarStage.isScreenShare ? "contain" : "cover"}
                onAudioAutoplayBlocked={handleWebinarAudioAutoplayBlocked}
                onAudioPlaybackStarted={handleWebinarAudioPlaybackStarted}
                audioPlaybackAttemptToken={webinarAudioPlaybackAttempt}
              />
              {webinarStage.pip ? (
                <div
                  className={`absolute h-28 w-44 overflow-hidden rounded-xl border border-[#fafafa]/20 bg-black/75 shadow-[0_16px_36px_rgba(0,0,0,0.5)] sm:h-32 sm:w-56 ${pipDragPosition ? "" : pipCornerClass} cursor-grab active:cursor-grabbing touch-none select-none`}
                  style={
                    pipDragPosition
                      ? {
                          left: `${pipDragPosition.x}px`,
                          top: `${pipDragPosition.y}px`,
                          right: "auto",
                          bottom: "auto",
                        }
                      : undefined
                  }
                  onPointerDown={handlePipPointerDown}
                  onPointerMove={handlePipPointerMove}
                  onPointerUp={handlePipPointerUp}
                  onPointerCancel={handlePipPointerCancel}
                >
                  <ParticipantVideo
                    key={webinarStage.pip.participant.userId}
                    participant={webinarStage.pip.participant}
                    displayName={webinarStage.pip.displayName}
                    onAudioAutoplayBlocked={handleWebinarAudioAutoplayBlocked}
                    onAudioPlaybackStarted={handleWebinarAudioPlaybackStarted}
                    audioPlaybackAttemptToken={webinarAudioPlaybackAttempt}
                  />
                </div>
              ) : null}
            </div>
          ) : (
            <div className="rounded-xl border border-white/10 bg-black/40 px-6 py-4 text-center">
              <p className="text-sm text-[#fafafa]">
                Waiting for the host to start speaking...
              </p>
            </div>
          )}
          {webinarAudioBlocked && (
            <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/65 p-4 backdrop-blur-sm">
              <div className="w-full max-w-sm rounded-2xl border border-[#fafafa]/20 bg-[#131316]/95 p-6 text-center shadow-2xl">
                <p
                  className="text-sm uppercase tracking-[0.2em] text-[#fafafa]"
                  style={{ fontFamily: "'PolySans Trial', sans-serif" }}
                >
                  Webinar audio is blocked
                </p>
                <p className="mt-3 text-xs text-[#fafafa]/82">
                  Your browser needs a click before playback can start.
                </p>
                <button
                  type="button"
                  onClick={handlePlayWebinarAudio}
                  className="mt-5 inline-flex items-center justify-center rounded-full border border-[#F95F4A]/60 bg-[#F95F4A]/15 px-5 py-2 text-xs uppercase tracking-[0.2em] text-[#fafafa] transition hover:bg-[#F95F4A]/25"
                  style={{ fontFamily: "'PolySans Trial', sans-serif" }}
                >
                  Play webinar
                </button>
              </div>
            </div>
          )}
        </div>
      ) : isWhiteboardActive ? (
        <WhiteboardLayout
          localStream={localStream}
          isCameraOff={isCameraOff}
          isMuted={isMuted}
          isHandRaised={isHandRaised}
          isGhost={ghostEnabled}
          participants={participants}
          userEmail={userEmail}
          isMirrorCamera={mirrorLocalPreview}
          activeSpeakerId={activeSpeakerId}
          currentUserId={currentUserId}
          audioOutputDeviceId={audioOutputDeviceId}
          getDisplayName={resolveDisplayName}
        />
      ) : isDevPlaygroundEnabled && isDevPlaygroundActive ? (
        <DevPlaygroundLayout
          localStream={localStream}
          isCameraOff={isCameraOff}
          isMuted={isMuted}
          isHandRaised={isHandRaised}
          isGhost={ghostEnabled}
          participants={participants}
          userEmail={userEmail}
          isMirrorCamera={mirrorLocalPreview}
          activeSpeakerId={activeSpeakerId}
          currentUserId={currentUserId}
          audioOutputDeviceId={audioOutputDeviceId}
          getDisplayName={resolveDisplayName}
        />
      ) : browserState?.active && browserState.noVncUrl ? (
        <BrowserLayout
          browserUrl={browserState.url || ""}
          noVncUrl={browserState.noVncUrl}
          controllerName={resolveDisplayName(
            browserState.controllerUserId || "",
          )}
          localStream={localStream}
          isCameraOff={isCameraOff}
          isMuted={isMuted}
          isHandRaised={isHandRaised}
          isGhost={ghostEnabled}
          participants={participants}
          userEmail={userEmail}
          isMirrorCamera={mirrorLocalPreview}
          activeSpeakerId={activeSpeakerId}
          currentUserId={currentUserId}
          audioOutputDeviceId={audioOutputDeviceId}
          getDisplayName={resolveDisplayName}
          isAdmin={isAdmin}
          isBrowserLaunching={isBrowserLaunching}
          onNavigateBrowser={onNavigateBrowser}
          browserVideoStream={browserVideoStream}
        />
      ) : (
        <GridLayout
          localStream={effectiveLocalStream}
          isCameraOff={effectiveIsCameraOff}
          isMuted={isMuted}
          isHandRaised={isHandRaised}
          isGhost={ghostEnabled}
          participants={participants}
          userEmail={userEmail}
          isMirrorCamera={mirrorLocalPreview}
          activeSpeakerId={effectiveActiveSpeakerId}
          currentUserId={currentUserId}
          audioOutputDeviceId={audioOutputDeviceId}
          onOpenParticipantsPanel={handleOpenParticipants}
          activeVideoEffectsCount={activeVideoEffectsCount}
          isVideoFramingEnabled={videoEffects.framing}
          onToggleVideoFraming={handleToggleVideoFraming}
          viewSettings={viewSettings}
          onViewSettingsChange={setViewSettings}
          presentationStream={effectivePresentationStream}
          presenterName={effectivePresenterName}
          isLocalPresenter={isLocalPresenter}
          screenShareControlState={screenShareControlState}
          screenShareCaptureController={screenShareCaptureController}
          getDisplayName={resolveDisplayName}
          sidePanelReserve={dockedPanelReserve}
          isMobile={isMobile}
        />
      )}

      {!isWebinarAttendee && (
        <AndroidUpsellSheet
          isOpen={showAndroidUpsell}
          onClose={dismissAndroidUpsell}
        />
      )}

      {isJoined && (
        <ToastQueue
          toasts={[
            browserLaunchError
              ? {
                  id: "browser",
                  label: "Browser error",
                  message: browserLaunchError,
                  tone: "danger" as const,
                  onDismiss: onClearBrowserError,
                }
              : null,
            voiceAgentError
              ? {
                  id: "voice",
                  label: "Voice agent error",
                  message: voiceAgentError,
                  tone: "danger" as const,
                  onDismiss: onClearVoiceAgentError,
                }
              : null,
          ]}
        />
      )}

      {isJoined &&
        (isWebinarAttendee ? (
          <div className="flex items-center justify-between gap-3 rounded-2xl border border-white/10 bg-black/30 px-4 py-3">
            <div>
              <p className="text-xs text-[#fafafa]/82">
                {webinarConfig?.attendeeCount ?? 0} attendees watching
              </p>
            </div>
          </div>
        ) : (
          <div className="safe-area-pb flex w-full flex-col items-center gap-2">
            <ControlsBar
                compact={useCompactControls}
                roomId={roomId}
                isMuted={isMuted}
                isMuteTogglePending={isMuteTogglePending}
                isCameraOff={isCameraOff}
                isScreenSharing={isScreenSharing}
                activeScreenShareId={activeScreenShareId}
                isChatOpen={isChatOpen}
                isTranscriptOpen={isTranscriptOpen}
                isTranscriptLive={transcript.isLive}
                transcriptStatus={transcript.session.status}
                unreadCount={unreadCount}
                isHandRaised={isHandRaised}
                reactionOptions={reactionOptions}
                onToggleMute={toggleMute}
                onToggleCamera={toggleCamera}
                onToggleScreenShare={toggleScreenShare}
                onToggleChat={handleToggleChat}
                onToggleTranscript={handleToggleTranscript}
                onToggleHandRaised={toggleHandRaised}
                onSendReaction={sendReaction}
                onLeave={leaveRoom}
                selectedAudioInputDeviceId={selectedAudioInputDeviceId}
                selectedAudioOutputDeviceId={selectedAudioOutputDeviceId}
                selectedVideoInputDeviceId={selectedVideoInputDeviceId}
                onAudioInputDeviceChange={onAudioInputDeviceChange}
                onAudioOutputDeviceChange={onAudioOutputDeviceChange}
                onVideoInputDeviceChange={onVideoInputDeviceChange}
                isMirrorCamera={isMirrorCamera}
                onToggleMirror={onToggleMirror}
                isVideoEffectsOpen={isVideoEffectsOpen}
                activeVideoEffectsCount={activeVideoEffectsCount}
                isVideoEffectsPermissionBlocked={isCameraPermissionBlocked}
                onToggleVideoEffects={handleToggleVideoEffects}
                isViewPanelOpen={isViewPanelOpen}
                onToggleViewPanel={handleToggleViewPanel}
                isAdmin={isAdmin}
                isGhostMode={ghostEnabled}
                isParticipantsOpen={isParticipantsOpen}
                onToggleParticipants={handleToggleParticipants}
                isGamesOpen={isGamesOpen}
                onToggleGames={handleToggleGames}
                hasActiveGame={isGameActive}
                isHostControlsOpen={isHostControlsOpen}
                onToggleHostControls={
                  isAdmin ? handleToggleHostControls : undefined
                }
                pendingUsersCount={isAdmin ? pendingUsers.size : 0}
                isRoomLocked={isRoomLocked}
                onToggleLock={onToggleLock}
                isNoGuests={isNoGuests}
                onToggleNoGuests={onToggleNoGuests}
                isChatLocked={isChatLocked}
                onToggleChatLock={onToggleChatLock}
                isTtsDisabled={isTtsDisabled}
                onToggleTtsDisabled={handleToggleTtsDisabled}
                isDmEnabled={isDmEnabled}
                onToggleDmEnabled={handleToggleDmEnabled}
                isReactionsDisabled={isReactionsDisabled}
                onToggleReactionsDisabled={handleToggleReactionsDisabled}
                isBrowserActive={browserState?.active ?? false}
                isBrowserLaunching={isBrowserLaunching}
                showBrowserControls={showBrowserControls}
                onLaunchBrowser={onLaunchBrowser}
                onCloseBrowser={onCloseBrowser}
                hasBrowserAudio={hasBrowserAudio}
                isBrowserAudioMuted={isBrowserAudioMuted}
                onToggleBrowserAudio={onToggleBrowserAudio}
                isWhiteboardActive={isWhiteboardActive}
                onOpenWhiteboard={isAdmin ? handleOpenWhiteboard : undefined}
                onCloseWhiteboard={isAdmin ? handleCloseWhiteboard : undefined}
                isDevPlaygroundEnabled={isDevPlaygroundEnabled}
                isDevPlaygroundActive={isDevPlaygroundActive}
                onOpenDevPlayground={
                  isAdmin ? handleOpenDevPlayground : undefined
                }
                onCloseDevPlayground={
                  isAdmin ? handleCloseDevPlayground : undefined
                }
                isAppsLocked={appsState.locked}
                onToggleAppsLock={isAdmin ? handleToggleAppsLock : undefined}
                isVoiceAgentRunning={isVoiceAgentRunning}
                isVoiceAgentStarting={isVoiceAgentStarting}
                onStartVoiceAgent={isAdmin ? onStartVoiceAgent : undefined}
                onStopVoiceAgent={isAdmin ? onStopVoiceAgent : undefined}
                isPopoutActive={isPopoutActive}
                isPopoutSupported={isPopoutSupported}
                onOpenPopout={onOpenPopout}
                onClosePopout={onClosePopout}
                meetingRequiresInviteCode={meetingRequiresInviteCode}
                webinarConfig={webinarConfig}
                webinarRole={webinarRole}
                webinarLink={webinarLink}
                onSetWebinarLink={onSetWebinarLink}
                onGetMeetingConfig={onGetMeetingConfig}
                onUpdateMeetingConfig={onUpdateMeetingConfig}
                onGetWebinarConfig={onGetWebinarConfig}
                onUpdateWebinarConfig={onUpdateWebinarConfig}
                onGenerateWebinarLink={onGenerateWebinarLink}
                onRotateWebinarLink={onRotateWebinarLink}
              />
            {browserAudioNeedsGesture && (
              <div className="w-full mt-2 text-center text-[11px] text-[#F95F4A]/70 uppercase tracking-[0.3em]">
                Click “Shared browser audio” to unlock the system sound.
              </div>
            )}
          </div>
        ))}

      {isJoined && !isWebinarAttendee && isGameActive && (
        <GamePanel
          rightOffset={gameDockOffset}
          dockWidth={gameDockPanelWidth}
          maxDockWidth={gameDockMaxWidth}
          onDockWidthChange={handleGameDockWidthChange}
        />
      )}

      {isJoined && !isWebinarAttendee && isGamesOpen && !isGameActive && (
        <GamesPanel
          rightOffset={gameDockOffset}
          dockWidth={gameDockPanelWidth}
          maxDockWidth={gameDockMaxWidth}
          onDockWidthChange={handleGameDockWidthChange}
          onClose={() => setIsGamesOpen(false)}
        />
      )}

      {isJoined && !isWebinarAttendee && isChatOpen && (
        <ChatPanel
          messages={chatMessages}
          chatInput={chatInput}
          onInputChange={setChatInput}
          onSend={handleSendChat}
          onSendGif={handleSendChatGif}
          onClose={handleToggleChat}
          currentUserId={currentUserId}
          isGhostMode={ghostEnabled}
          isChatLocked={isChatLocked}
          isDmEnabled={isDmEnabled}
          isAdmin={isAdmin}
          mentionableParticipants={mentionableParticipants}
          replyTarget={replyTarget}
          onReply={onReplyToMessage}
          onCancelReply={onCancelReply}
        />
      )}

      {isJoined && !isWebinarAttendee && isTranscriptOpen && (
        <TranscriptPanel
          transcript={transcript}
          onClose={handleCloseTranscript}
        />
      )}

      {isJoined && !isWebinarAttendee && isParticipantsOpen && (
        <ParticipantsPanel
          participants={participants}
          currentUserId={currentUserId}
          onClose={handleCloseParticipants}
          socket={socket}
          isAdmin={isAdmin}
          pendingUsers={pendingUsers}
          localState={{
            isMuted,
            isCameraOff,
            isHandRaised,
            isScreenSharing,
            isGhost: ghostEnabled,
          }}
          viewerIsGhost={ghostEnabled}
          getDisplayName={resolveDisplayName}
          onPendingUserStale={handlePendingUserStale}
          hostUserId={hostUserId}
          hostUserIds={hostUserIds}
        />
      )}

      {isJoined &&
        !isWebinarAttendee &&
        isAdmin &&
        isHostControlsOpen && (
          <MeetSettingsPanel
            isRoomLocked={isRoomLocked}
            onToggleLock={onToggleLock}
            isNoGuests={isNoGuests}
            onToggleNoGuests={onToggleNoGuests}
            isChatLocked={isChatLocked}
            onToggleChatLock={onToggleChatLock}
            isTtsDisabled={isTtsDisabled}
            onToggleTtsDisabled={handleToggleTtsDisabled}
            isDmEnabled={isDmEnabled}
            onToggleDmEnabled={handleToggleDmEnabled}
            isReactionsDisabled={isReactionsDisabled}
            onToggleReactionsDisabled={handleToggleReactionsDisabled}
            meetingRequiresInviteCode={meetingRequiresInviteCode}
            onGetMeetingConfig={onGetMeetingConfig}
            onUpdateMeetingConfig={onUpdateMeetingConfig}
            webinarConfig={webinarConfig}
            webinarRole={webinarRole}
            webinarLink={webinarLink}
            onSetWebinarLink={onSetWebinarLink}
            onGetWebinarConfig={onGetWebinarConfig}
            onUpdateWebinarConfig={onUpdateWebinarConfig}
            onGenerateWebinarLink={onGenerateWebinarLink}
            onRotateWebinarLink={onRotateWebinarLink}
            onClose={handleCloseHostControls}
          />
        )}

      {isJoined && !isWebinarAttendee && isVideoEffectsOpen && (
        <VideoEffectsPanel
          effects={videoEffects}
          onEffectsChange={onVideoEffectsChange}
          onRecenterFraming={onVideoEffectsRecenter}
          localStream={effectiveLocalStream}
          isCameraOff={effectiveIsCameraOff}
          status={videoEffectsStatus}
          error={videoEffectsError}
          debugStats={videoEffectsDebugStats}
          activeCount={activeVideoEffectsCount}
          deferPreload={deferVideoEffectsPreload}
          cameraPermissionBlocked={isCameraPermissionBlocked}
          onToggleCamera={toggleCamera}
          onClose={handleCloseVideoEffects}
        />
      )}

      {isJoined && !isWebinarAttendee && isViewPanelOpen && (
        <MeetViewPanel
          settings={viewSettings}
          onSettingsChange={setViewSettings}
          participantCount={visibleParticipantCount + 1}
          onClose={handleCloseViewPanel}
        />
      )}

      {isJoined &&
        !isWebinarAttendee &&
        !isChatOpen &&
        chatOverlayMessages.length > 0 && (
        <ChatOverlay
          messages={chatOverlayMessages}
          onDismiss={(id) =>
            setChatOverlayMessages((prev) => prev.filter((m) => m.id !== id))
          }
        />
      )}
    </div>
  );
}

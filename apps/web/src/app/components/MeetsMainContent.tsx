"use client";

import { lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  Dispatch,
  PointerEvent,
  ReactNode,
  SetStateAction,
} from "react";
import {
  ChartBar,
  Globe,
  Headphones,
  Home,
  Loader2,
  LogOut,
  MessageCircleQuestion,
  MonitorPlay,
  Plus,
  RefreshCw,
  VolumeX,
} from "lucide-react";
import type { Socket } from "socket.io-client";
import type { RoomInfo } from "@/lib/sfu-types";
import ChatOverlay from "./ChatOverlay";
import MeetingPanelBoundary, { meetingPanelKey } from "./MeetingPanelBoundary";
import JoinScreen from "./JoinScreen";
import type { RoomAiController } from "../hooks/useRoomAi";
import { useElementSize } from "../hooks/useElementSize";
import ControlsBar, { type ControlsBarProps } from "./ControlsBar";
import CommandPalette from "./CommandPalette";
import ShortcutsHelpDialog from "./ShortcutsHelpDialog";
import GridLayout from "./GridLayout";
import ConnectionBanner from "./ConnectionBanner";
import AdminNoticePill from "./AdminNoticePill";
import CatchUpPill from "./CatchUpPill";
import InCallNotice from "./InCallNotice";
import InCallNoticeCard from "./InCallNoticeCard";
import InCallNoticeSlot from "./InCallNoticeSlot";
import ParticipantsPanel from "./ParticipantsPanel";
import MeetSettingsPanel from "./MeetSettingsPanel";
import MeetViewPanel from "./MeetViewPanel";
import ReactionOverlay from "./ReactionOverlay";
import MeetingAppLayout from "./MeetingAppLayout";
import SharedBrowserStage from "./SharedBrowserStage";
import ScreenShareAudioPlayers from "./ScreenShareAudioPlayers";
import SystemAudioPlayers from "./SystemAudioPlayers";
import ParticipantVideo from "./ParticipantVideo";
import ParticipantAudio from "./ParticipantAudio";
import WebinarViewerChrome, {
  WebinarStageInviteDialog,
  WebinarWaitingCard,
} from "./WebinarViewer";
import { QaPanel } from "./qa/QaPanel";
import { PollsPanel } from "./polls/PollsPanel";
import ToastQueue, { type ToastItem } from "./ToastQueue";
import RoomAiPanel from "./RoomAiPanel";
import AndroidUpsellSheet from "./AndroidUpsellSheet";
import type { BrowserCommand, BrowserState } from "../hooks/useSharedBrowser";
import type {
  ConclaveAssistantApiKeyPromptState,
} from "../hooks/useMeetChat";
import {
  CONCLAVE_ASSISTANT_USER_ID,
  type AssistantChatMessage,
  type AssistantToolApprovalDecision,
  type ConclaveAssistantModel,
} from "../lib/conclave-assistant";
import type {
  VideoEffectsDebugStats,
  VideoEffectsRuntimeStatus,
} from "../hooks/useVideoEffects";
import type { ConnectionQualityStats } from "../hooks/useConnectionQuality";
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
  ReactionOption,
  SendChatMessageOptions,
  WebinarConfigSnapshot,
  WebinarHandQueueEntry,
  WebinarLinkResponse,
  WebinarQaEntry,
  WebinarQaModerateRequest,
  WebinarUpdateRequest,
  PrejoinMediaHandoff,
} from "../lib/types";
import type { ReactionStore } from "../lib/reaction-store";
import {
  formatDisplayName,
  isBrowserVideoUserId,
  isSystemUserId,
  isMediaDeviceBlocked,
} from "../lib/utils";
import { hiddenSetupView, type SetupNotice } from "../lib/setup-notice";
import { useApps, useAuthorityRuntime, useGame } from "@conclave/apps-sdk";
import { GamePanel } from "./games/GamePanel";
import { GamesPanel } from "./games/GamesPanel";
import { AppsPanel, type PanelAppEntry } from "./apps/AppsPanel";
import { pollsApp } from "@conclave/apps-sdk/polls/web";
import { qaApp } from "@conclave/apps-sdk/qa/web";
import { hasUnseenMeetingQuestion, useMeetingQa } from "../hooks/useMeetingQa";
import { useMeetingPolls } from "../hooks/useMeetingPolls";
import { useReconnectHold } from "../hooks/useHeldThroughReconnect";
import { panelAppNeedsServerUpdate } from "../lib/panel-app-availability";
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
import type { MeetViewSettings } from "../lib/meet-view";
import type { MediaQualitySettings } from "../lib/media-quality-settings";
import type {
  ClonedTtsVoice,
  TtsSystemVoiceOption,
} from "../hooks/useMeetTts";
import { getRenderableParticipantVideoStream } from "../lib/participant-media";
import { prewarmVideoEffectsAssetsDeferred } from "../lib/video-effects-lazy";

const loadChatPanel = () => import("./ChatPanel");
const loadTranscriptPanel = () => import("./TranscriptPanel");
const ChatPanel = lazy(loadChatPanel);
const TranscriptPanel = lazy(loadTranscriptPanel);
const VideoEffectsPanel = lazy(() => import("./VideoEffectsPanel"));
const DeviceSettingsPanel = lazy(() => import("./DeviceSettingsPanel"));
const DevMeetToolsPanel = lazy(() => import("./DevMeetToolsPanel"));

interface MeetsMainContentProps {
  roomAi: RoomAiController;
  errorNotice?: ReactNode;
  mediaErrorNotice?: ReactNode;
  isJoined: boolean;
  isMobile?: boolean;
  viewSettings: MeetViewSettings;
  onViewSettingsChange: Dispatch<SetStateAction<MeetViewSettings>>;
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
  presentationStream: MediaStream | null;
  presenterName: string;
  presentationProducerId?: string | null;
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
  cameraPreviewStream?: MediaStream | null;
  isCameraPreviewStarting?: boolean;
  cameraPreviewError?: string | null;
  onStartCameraPreview?: () => void;
  onStopCameraPreview?: () => void;
  connectionStats?: ConnectionQualityStats;
  onDevCameraStreamChange?: (stream: MediaStream | null) => void;
  onPrejoinMediaCommit?: (handoff: PrejoinMediaHandoff) => void;
  isCameraOff: boolean;
  isMuted: boolean;
  isHandRaised: boolean;
  participants: Map<string, Participant>;
  isMirrorCamera: boolean;
  mirrorLocalPreview: boolean;
  onToggleMirror?: () => void;
  mediaQualitySettings: MediaQualitySettings;
  onMediaQualitySettingsChange: Dispatch<
    SetStateAction<MediaQualitySettings>
  >;
  selectedAudioInputDeviceId?: string;
  selectedAudioOutputDeviceId?: string;
  ttsSystemVoices?: TtsSystemVoiceOption[];
  selectedTtsSystemVoiceUri?: string | null;
  onTtsSystemVoiceChange?: (voiceUri: string | null) => void;
  clonedTtsVoice?: ClonedTtsVoice | null;
  onClonedTtsVoiceChange?: (voice: ClonedTtsVoice) => void;
  onClonedTtsVoiceClear?: () => void;
  canCloneTtsVoice?: boolean;
  ttsVoiceOwnerName?: string;
  selectedVideoInputDeviceId?: string;
  onAudioInputDeviceChange?: (deviceId: string) => void;
  onAudioOutputDeviceChange?: (deviceId: string) => void;
  onVideoInputDeviceChange?: (deviceId: string) => void;
  isNoiseCancellationEnabled?: boolean;
  onToggleNoiseCancellation?: () => void;
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
  endRoomForEveryone?: () => Promise<boolean> | boolean;
  onGoHome?: () => void;
  onStartNewMeeting?: () => void;
  onEnterMeetingStart?: (action: "new" | "join") => void;
  isParticipantsOpen: boolean;
  setIsParticipantsOpen: Dispatch<SetStateAction<boolean>>;
  pendingUsers: Map<string, string>;
  chatMessages: ChatMessage[];
  chatInput: string;
  setChatInput: Dispatch<SetStateAction<string>>;
  sendChat: (content: string, options?: SendChatMessageOptions) => void;
  sendChatGif: (gif: ChatGifAttachment) => void;
  sendChatImage: (
    file: File,
    caption: string,
    onProgress?: (progress: number) => void,
  ) => Promise<boolean>;
  chatOverlayMessages: ChatMessage[];
  setChatOverlayMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  replyTarget: ChatReplyPreview | null;
  onReplyToMessage: (message: ChatMessage) => void;
  onToggleMessageReaction?: (messageId: string, emoji: string) => void;
  onCancelReply: () => void;
  activeTtsMessageId?: string | null;
  onReplayTtsMessage?: (message: ChatMessage) => void;
  onStopTts?: () => void;
  hasClonedTtsVoice?: boolean;
  assistantApiKeyPrompt: ConclaveAssistantApiKeyPromptState;
  onSubmitAssistantApiKey: (
    apiKey: string,
    model: ConclaveAssistantModel,
  ) => void;
  onCancelAssistantApiKey: () => void;
  onAssistantToolApproval: (
    answerId: string,
    decision: AssistantToolApprovalDecision,
  ) => void;
  socket: Socket | null;
  setPendingUsers: Dispatch<SetStateAction<Map<string, string>>>;
  resolveDisplayName: (userId: string) => string;
  reactionStore: ReactionStore;
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
  browserFailedCommand?: BrowserCommand | null;
  showBrowserControls?: boolean;
  onLaunchBrowser?: (url: string) => Promise<boolean>;
  onNavigateBrowser?: (url: string) => Promise<boolean>;
  onCloseBrowser?: () => Promise<boolean>;
  onClearBrowserError?: () => void;
  isBrowserAudioMuted: boolean;
  onToggleBrowserAudio: () => void;
  meetError?: MeetError | null;
  mediaError?: MeetError | null;
  setupNotice?: SetupNotice | null;
  onDismissSetupNotice?: () => void;
  browserAudioNeedsGesture: boolean;
  browserAudioPlaybackAttemptToken?: number;
  onBrowserAudioAutoplayBlocked: () => void;
  onBrowserAudioPlaybackStarted?: () => void;
  isVoiceAgentRunning?: boolean;
  isVoiceAgentStarting?: boolean;
  voiceAgentError?: string | null;
  onStartVoiceAgent?: () => void;
  onStopVoiceAgent?: () => void;
  onClearVoiceAgentError?: () => void;
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
  areImageAttachmentsEnabled: boolean;
  isReactionsDisabled: boolean;
  isParticipantUnmuteAllowed: boolean;
  onToggleParticipantUnmuteAllowed: () => void;
  isParticipantVideoAllowed: boolean;
  onToggleParticipantVideoAllowed: () => void;
  meetingRequiresInviteCode: boolean;
  webinarConfig?: WebinarConfigSnapshot | null;
  webinarRole?: "attendee" | "participant" | "host" | null;
  webinarSpeakerUserId?: string | null;
  webinarLink?: string | null;
  webinarTitle?: string;
  /** The old events' Q&A list for this connection, null until it is sent one. */
  webinarQaEntries?: WebinarQaEntry[] | null;
  webinarQaListFromThisConnection?: boolean;
  /** Drops that list, once the Q&A app's view has taken over from it. */
  onForgetWebinarQaEntries: () => void;
  webinarHandQueue?: WebinarHandQueueEntry[];
  isWebinarHandRaised?: boolean;
  webinarStageInvite?: {
    promotedByName?: string;
    rejoinRoomId: string;
  } | null;
  onAcceptWebinarStageInvite?: () => void;
  onDismissWebinarStageInvite?: () => void;
  onSubmitWebinarQuestion?: (
    question: string,
  ) => Promise<{ ok: boolean; error?: string }>;
  onUpvoteWebinarQuestion?: (id: string) => void;
  onModerateWebinarQuestion?: (
    request: WebinarQaModerateRequest,
  ) => Promise<{ ok: boolean; error?: string }>;
  onSetWebinarHandRaised?: (raised: boolean) => void;
  onPromoteWebinarAttendee?: (
    userId: string,
  ) => Promise<{ ok: boolean; error?: string }>;
  onDemoteWebinarParticipant?: (
    userId: string,
  ) => Promise<{ ok: boolean; error?: string }>;
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
// The shared Q&A panel, `sm:w-[360px]` in QaPanel, which attendees use too.
const WEBINAR_QA_PANEL_WIDTH = 360;
// The meeting area's bottom padding (p-4) plus a gap above the controls bar.
const NOTICE_CONTROLS_CLEARANCE_PX = 24;
const BROWSER_ERROR_TITLES: Record<BrowserCommand, string> = {
  launch: "Couldn’t open the shared browser",
  navigate: "Couldn’t open that page",
  close: "Couldn’t close the shared browser",
};
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

export default function MeetsMainContent({
  isJoined,
  isMobile = false,
  viewSettings,
  onViewSettingsChange,
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
  user,
  userEmail,
  isAdmin,
  showPermissionHint,
  availableRooms,
  roomsStatus,
  refreshRooms,
  displayNameInput,
  setDisplayNameInput,
  presentationStream,
  presenterName,
  presentationProducerId = null,
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
  cameraPreviewStream = null,
  isCameraPreviewStarting = false,
  cameraPreviewError = null,
  onStartCameraPreview,
  onStopCameraPreview,
  connectionStats,
  onDevCameraStreamChange,
  onPrejoinMediaCommit,
  isCameraOff,
  isMuted,
  isHandRaised,
  participants,
  isMirrorCamera,
  mirrorLocalPreview,
  onToggleMirror,
  mediaQualitySettings,
  onMediaQualitySettingsChange,
  selectedAudioInputDeviceId,
  selectedAudioOutputDeviceId,
  ttsSystemVoices,
  selectedTtsSystemVoiceUri,
  onTtsSystemVoiceChange,
  clonedTtsVoice,
  onClonedTtsVoiceChange,
  onClonedTtsVoiceClear,
  canCloneTtsVoice,
  ttsVoiceOwnerName,
  selectedVideoInputDeviceId,
  onAudioInputDeviceChange,
  onAudioOutputDeviceChange,
  onVideoInputDeviceChange,
  isNoiseCancellationEnabled,
  onToggleNoiseCancellation,
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
  endRoomForEveryone,
  onGoHome,
  onStartNewMeeting,
  onEnterMeetingStart,
  isParticipantsOpen,
  setIsParticipantsOpen,
  pendingUsers,
  chatMessages,
  chatInput,
  setChatInput,
  sendChat,
  sendChatGif,
  sendChatImage,
  chatOverlayMessages,
  setChatOverlayMessages,
  replyTarget,
  onReplyToMessage,
  onToggleMessageReaction,
  onCancelReply,
  activeTtsMessageId,
  onReplayTtsMessage,
  onStopTts,
  hasClonedTtsVoice,
  assistantApiKeyPrompt,
  onSubmitAssistantApiKey,
  onCancelAssistantApiKey,
  onAssistantToolApproval,
  socket,
  setPendingUsers,
  resolveDisplayName,
  reactionStore,
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
  browserFailedCommand,
  showBrowserControls = true,
  onLaunchBrowser,
  onNavigateBrowser,
  onCloseBrowser,
  onClearBrowserError,
  isBrowserAudioMuted,
  onToggleBrowserAudio,
  browserAudioNeedsGesture,
  browserAudioPlaybackAttemptToken,
  onBrowserAudioAutoplayBlocked,
  onBrowserAudioPlaybackStarted,
  isVoiceAgentRunning = false,
  isVoiceAgentStarting = false,
  voiceAgentError = null,
  onStartVoiceAgent,
  onStopVoiceAgent,
  onClearVoiceAgentError,
  meetError,
  mediaError,
  setupNotice,
  onDismissSetupNotice,
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
  areImageAttachmentsEnabled,
  isReactionsDisabled,
  isParticipantUnmuteAllowed,
  onToggleParticipantUnmuteAllowed,
  isParticipantVideoAllowed,
  onToggleParticipantVideoAllowed,
  meetingRequiresInviteCode,
  webinarConfig,
  webinarRole,
  webinarSpeakerUserId,
  webinarLink,
  webinarTitle,
  webinarQaEntries: legacyQaEntries = null,
  webinarQaListFromThisConnection = false,
  onForgetWebinarQaEntries,
  webinarHandQueue = [],
  isWebinarHandRaised = false,
  webinarStageInvite = null,
  onAcceptWebinarStageInvite,
  onDismissWebinarStageInvite,
  onSubmitWebinarQuestion: legacySubmitQuestion,
  onUpvoteWebinarQuestion: legacyUpvoteQuestion,
  onModerateWebinarQuestion: legacyModerateQuestion,
  onSetWebinarHandRaised,
  onPromoteWebinarAttendee,
  onDemoteWebinarParticipant,
  onSetWebinarLink,
  onGetMeetingConfig,
  onUpdateMeetingConfig,
  onGetWebinarConfig,
  onUpdateWebinarConfig,
  onGenerateWebinarLink,
  onRotateWebinarLink,
  transcript,
  roomAi,
  errorNotice,
  mediaErrorNotice,
}: MeetsMainContentProps) {
  const {
    state: appsState,
    apps,
    openApp,
    closeApp,
    setLocked,
    refreshState,
  } = useApps();
  const { isActive: isGameActive, refresh: refreshGameState } = useGame();
  // Q&A comes from the Q&A app once this connection has the app's view, and
  // from the old webinar events until then, or for good on a server that
  // does not offer the app. Everything below reads this one source.
  const reconnectHold = useReconnectHold({ isJoined, connectionState });
  const meetingQa = useMeetingQa({
    legacy: {
      entries: legacyQaEntries,
      fromThisConnection: webinarQaListFromThisConnection,
      forget: onForgetWebinarQaEntries,
      submit: legacySubmitQuestion,
      upvote: legacyUpvoteQuestion,
      moderate: legacyModerateQuestion,
    },
    isWebinar: Boolean(webinarConfig?.enabled) || isWebinarAttendee,
    hold: reconnectHold,
    currentUserId,
  });
  const webinarQaEntries = meetingQa.entries;
  const onSubmitWebinarQuestion = meetingQa.onSubmit;
  const onUpvoteWebinarQuestion = meetingQa.onUpvote;
  const onModerateWebinarQuestion = meetingQa.onModerate;
  const [isGamesOpen, setIsGamesOpen] = useState(false);
  const [isAppsOpen, setIsAppsOpen] = useState(false);
  const [activityPanel, setActivityPanel] = useState<"polls" | "qa" | null>(
    null,
  );
  const isDevToolsEnabled = process.env.NODE_ENV === "development";
  const isDevPlaygroundEnabled = isDevToolsEnabled;

  useEffect(() => {
    if (!isJoined || isWebinarAttendee) return;

    function preloadMeetingPanels() {
      void loadChatPanel().catch(() => {});
      void loadTranscriptPanel().catch(() => {});
    }

    if (typeof window.requestIdleCallback === "function") {
      const idleId = window.requestIdleCallback(preloadMeetingPanels, { timeout: 1800 });
      return () => window.cancelIdleCallback(idleId);
    }

    const timeoutId = window.setTimeout(preloadMeetingPanels, 300);
    return () => window.clearTimeout(timeoutId);
  }, [isJoined, isWebinarAttendee]);

  const isWhiteboardActive = appsState.activeAppId === "whiteboard";
  const isWatchActive = appsState.activeAppId === "watch";
  const isDevPlaygroundActive = appsState.activeAppId === "dev-playground";
  const ActiveMeetingApp = useMemo(
    () => apps.find((app) => app.id === appsState.activeAppId)?.web ?? null,
    [apps, appsState.activeAppId],
  );
  const handleOpenWhiteboard = useCallback(
    () => openApp("whiteboard"),
    [openApp],
  );
  const handleCloseWhiteboard = useCallback(() => closeApp(), [closeApp]);
  const handleOpenWatch = useCallback(() => openApp("watch"), [openApp]);
  const handleCloseWatch = useCallback(() => closeApp(), [closeApp]);
  // Opting out of Watch together is local: this participant goes back to the
  // call view while everyone else keeps watching. It lasts until the current
  // Watch together session ends, so the next one starts joined.
  const [isWatchOptedOut, setIsWatchOptedOut] = useState(false);
  const [wasWatchActive, setWasWatchActive] = useState(isWatchActive);
  if (wasWatchActive !== isWatchActive) {
    setWasWatchActive(isWatchActive);
    if (!isWatchActive) setIsWatchOptedOut(false);
  }
  const isWatchHiddenLocally = isWatchActive && isWatchOptedOut;
  const watchLeaveAction = useMemo(
    () => ({
      label: "Leave watch together",
      hint: "You stay in the call. Others keep watching.",
      onLeave: () => setIsWatchOptedOut(true),
    }),
    [],
  );
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
          !isSystemUserId(participant.userId),
      ),
    [currentUserId, participantsArray],
  );

  const coachAvatars = useMemo(() => {
    const cast: { id: string; name: string }[] = [
      { id: currentUserId || "you", name: "You" },
    ];
    for (const participant of nonSystemParticipants) {
      if (cast.length >= 4) break;
      cast.push({
        id: participant.userId,
        name: resolveDisplayName(participant.userId),
      });
    }
    let filler = 0;
    while (cast.length < 3) {
      filler += 1;
      cast.push({ id: `watch-friend-${filler}`, name: `Friend ${filler}` });
    }
    return cast;
  }, [currentUserId, nonSystemParticipants, resolveDisplayName]);
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
  const [isWebinarQaOpen, setIsWebinarQaOpen] = useState(false);
  const [webinarQaSeenAt, setWebinarQaSeenAt] = useState(0);
  const isWebinarQaEnabled = webinarConfig?.qaEnabled !== false;
  useEffect(() => {
    if (!isWebinarQaEnabled) setIsWebinarQaOpen(false);
  }, [isWebinarQaEnabled]);
  useEffect(() => {
    if (isWebinarQaOpen) setWebinarQaSeenAt(Date.now());
  }, [isWebinarQaOpen, webinarQaEntries]);
  const unseenWebinarQaCount = useMemo(() => {
    if (isWebinarQaOpen) return 0;
    return webinarQaEntries.filter(
      (entry) =>
        (entry.status === "answering" || entry.status === "answered") &&
        entry.updatedAt > webinarQaSeenAt,
    ).length;
  }, [isWebinarQaOpen, webinarQaEntries, webinarQaSeenAt]);
  const handleToggleWebinarQa = useCallback(() => {
    setIsWebinarQaOpen((previous) => !previous);
  }, []);
  const handleToggleWebinarHand = useCallback(() => {
    onSetWebinarHandRaised?.(!isWebinarHandRaised);
  }, [onSetWebinarHandRaised, isWebinarHandRaised]);
  const [participantAudioBlocked, setParticipantAudioBlocked] = useState(false);
  const [participantAudioPlaybackAttempt, setParticipantAudioPlaybackAttempt] =
    useState(0);
  const [isHostControlsOpen, setIsHostControlsOpen] = useState(false);
  const [isVideoEffectsOpen, setIsVideoEffectsOpen] = useState(false);
  const [isViewPanelOpen, setIsViewPanelOpen] = useState(false);
  const [isDeviceSettingsOpen, setIsDeviceSettingsOpen] = useState(false);
  const [isTranscriptOpen, setIsTranscriptOpen] = useState(false);
  const [isAiPanelOpen, setIsAiPanelOpen] = useState(false);
  const [transcriptInitialTab, setTranscriptInitialTab] = useState<
    "transcript" | "ask" | "minutes"
  >("transcript");
  const [joinedAt, setJoinedAt] = useState<number | null>(null);
  useEffect(() => {
    if (isJoined && joinedAt == null) {
      setJoinedAt(Date.now());
    }
  }, [isJoined, joinedAt]);
  const [canReserveDockedPanel, setCanReserveDockedPanel] = useState(false);
  const [viewportWidth, setViewportWidth] = useState(1280);
  const [gameDockWidth, setGameDockWidth] = useState(
    GAME_DOCK_DEFAULT_WIDTH,
  );
  const [showAndroidUpsell, setShowAndroidUpsell] = useState(false);
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
    isMediaDeviceBlocked(mediaError, "camera") ||
    (!hasLiveLocalCamera &&
      !hasLiveDevCamera &&
      (cameraPermissionState === "prompt" ||
        cameraPermissionState === "denied"));
  const isLocalPresenter = isScreenSharing && Boolean(presentationStream);
  const effectivePresentationStream =
    presentationStream ?? devPresentationStream;
  const effectivePresenterName = presentationStream
    ? presenterName
    : devPresentationStream
      ? "Dev presentation"
      : presenterName;
  const presentationPresenterId = useMemo(() => {
    if (!presentationStream) return null;

    const activeScreenShareParticipant = activeScreenShareId
      ? nonSystemParticipants.find(
          (participant) =>
            participant.screenShareProducerId === activeScreenShareId &&
            getLiveVideoStream(participant.screenShareStream),
        )
      : null;
    const fallbackScreenShareParticipant = nonSystemParticipants.find(
      (participant) => getLiveVideoStream(participant.screenShareStream),
    );

    return (
      activeScreenShareParticipant?.userId ??
      fallbackScreenShareParticipant?.userId ??
      (isScreenSharing ? currentUserId : null)
    );
  }, [
    activeScreenShareId,
    currentUserId,
    isScreenSharing,
    nonSystemParticipants,
    presentationStream,
  ]);
  const shouldUseDevCameraStream =
    Boolean(devCameraStream) && !getLiveVideoStream(localStream);
  const effectiveLocalStream = shouldUseDevCameraStream
    ? devCameraStream
    : localStream;
  const effectiveIsCameraOff =
    shouldUseDevCameraStream && hasLiveDevCamera ? false : isCameraOff;
  const hasLivePreviewVideo = Boolean(getLiveVideoStream(cameraPreviewStream));
  const panelPreviewStream = getLiveVideoStream(effectiveLocalStream)
    ? effectiveLocalStream
    : hasLivePreviewVideo
      ? cameraPreviewStream
      : effectiveLocalStream;
  const panelPreviewIsLocalOnly =
    !getLiveVideoStream(effectiveLocalStream) && hasLivePreviewVideo;
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
  const webinarStageIsLive = useMemo(() => {
    if (!isWebinarAttendee || !webinarStage) return false;
    if (webinarStage.main.participant.videoStream) return true;
    return nonSystemParticipants.some(
      (participant) => !participant.isMuted && participant.audioStream,
    );
  }, [isWebinarAttendee, webinarStage, nonSystemParticipants]);
  const [hasWebinarStageBeenLive, setHasWebinarStageBeenLive] = useState(false);
  useEffect(() => {
    if (webinarStageIsLive) setHasWebinarStageBeenLive(true);
  }, [webinarStageIsLive]);
  const showWebinarStage =
    Boolean(webinarStage) && (webinarStageIsLive || hasWebinarStageBeenLive);
  const webinarPipCornerClass = useMemo(() => {
    switch (pipCorner) {
      case "top-left":
        return "top-24 left-5";
      case "top-right":
        return "top-24 right-5";
      case "bottom-left":
        return "bottom-24 left-5";
      case "bottom-right":
      default:
        return "bottom-24 right-5";
    }
  }, [pipCorner]);
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
  const handleParticipantAudioAutoplayBlocked = useCallback(() => {
    setParticipantAudioBlocked(true);
  }, []);
  const handleParticipantAudioPlaybackStarted = useCallback(() => {
    setParticipantAudioBlocked(false);
  }, []);
  const handlePlayParticipantAudio = useCallback(() => {
    setParticipantAudioBlocked(false);
    setParticipantAudioPlaybackAttempt((attempt) => attempt + 1);
  }, []);
  useEffect(() => {
    if (isJoined) return;
    setParticipantAudioBlocked(false);
    setParticipantAudioPlaybackAttempt(0);
  }, [isJoined]);
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
    if (opening && isChatOpen) {
      toggleChat();
    }
    if (opening) {
      setIsHostControlsOpen(false);
      setIsVideoEffectsOpen(false);
      setIsViewPanelOpen(false);
      setIsDeviceSettingsOpen(false);
      setIsTranscriptOpen(false);
      setIsAiPanelOpen(false);
      setActivityPanel(null);
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
    setIsDeviceSettingsOpen(false);
    setIsTranscriptOpen(false);
    setIsAiPanelOpen(false);
    setActivityPanel(null);
    setIsParticipantsOpen(true);
  }, [toggleChat, setIsParticipantsOpen]);

  const handleCloseParticipants = useCallback(
    () => setIsParticipantsOpen(false),
    [setIsParticipantsOpen],
  );

  const handleToggleGames = useCallback(() => {
    const opening = !isGamesOpen;
    if (opening) setIsAppsOpen(false);
    setIsGamesOpen(opening);
  }, [isGamesOpen]);

  const handleToggleApps = useCallback(() => {
    const opening = !isAppsOpen;
    if (opening) setIsGamesOpen(false);
    setIsAppsOpen(opening);
  }, [isAppsOpen]);

  useEffect(() => {
    if (isGameActive) {
      setIsGamesOpen(false);
      setIsAppsOpen(false);
    }
  }, [isGameActive]);

  const isSecondaryPanelOpen =
    isChatOpen ||
    isParticipantsOpen ||
    isHostControlsOpen ||
    isVideoEffectsOpen ||
    isViewPanelOpen ||
    isDeviceSettingsOpen ||
    isTranscriptOpen ||
    isAiPanelOpen ||
    activityPanel !== null;
  const isGameDockPresent = isGameActive || isGamesOpen || isAppsOpen;
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
    if (opening && isChatOpenRef.current) {
      toggleChat();
    }
    if (opening) {
      setIsParticipantsOpen(false);
      setIsVideoEffectsOpen(false);
      setIsViewPanelOpen(false);
      setIsDeviceSettingsOpen(false);
      setIsTranscriptOpen(false);
      setIsAiPanelOpen(false);
      setActivityPanel(null);
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
      setIsDeviceSettingsOpen(false);
      setIsTranscriptOpen(false);
      setIsAiPanelOpen(false);
      setActivityPanel(null);
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
  const handleToggleViewPanel = useCallback(() => {
    const opening = !isViewPanelOpen;
    if (opening && isChatOpenRef.current) {
      toggleChat();
    }
    if (opening) {
      setIsParticipantsOpen(false);
      setIsHostControlsOpen(false);
      setIsVideoEffectsOpen(false);
      setIsDeviceSettingsOpen(false);
      setIsTranscriptOpen(false);
      setIsAiPanelOpen(false);
      setActivityPanel(null);
    }
    setIsViewPanelOpen(opening);
  }, [isViewPanelOpen, setIsParticipantsOpen, toggleChat]);

  const handleCloseViewPanel = useCallback(() => {
    setIsViewPanelOpen(false);
  }, []);

  const handleToggleDeviceSettings = useCallback(() => {
    const opening = !isDeviceSettingsOpen;
    if (opening && isChatOpenRef.current) {
      toggleChat();
    }
    if (opening) {
      setIsParticipantsOpen(false);
      setIsHostControlsOpen(false);
      setIsVideoEffectsOpen(false);
      setIsViewPanelOpen(false);
      setIsTranscriptOpen(false);
      setIsAiPanelOpen(false);
      setActivityPanel(null);
    }
    setIsDeviceSettingsOpen(opening);
  }, [isDeviceSettingsOpen, setIsParticipantsOpen, toggleChat]);

  const handleCloseDeviceSettings = useCallback(() => {
    setIsDeviceSettingsOpen(false);
  }, []);

  useEffect(() => {
    if (!isVideoEffectsOpen && !isDeviceSettingsOpen) {
      onStopCameraPreview?.();
    }
  }, [isVideoEffectsOpen, isDeviceSettingsOpen, onStopCameraPreview]);

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
      setIsDeviceSettingsOpen(false);
      setIsAiPanelOpen(false);
      setActivityPanel(null);
    } else {
      setTranscriptInitialTab("transcript");
    }
    setIsTranscriptOpen(opening);
  }, [isTranscriptOpen, setIsParticipantsOpen, toggleChat]);

  const handleToggleAiPanel = useCallback(() => {
    const opening = !isAiPanelOpen;
    if (opening && isChatOpenRef.current) {
      toggleChat();
    }
    if (opening) {
      setIsParticipantsOpen(false);
      setIsHostControlsOpen(false);
      setIsVideoEffectsOpen(false);
      setIsViewPanelOpen(false);
      setIsDeviceSettingsOpen(false);
      setIsTranscriptOpen(false);
      setActivityPanel(null);
    }
    setIsAiPanelOpen(opening);
  }, [isAiPanelOpen, setIsParticipantsOpen, toggleChat]);

  const handleOpenAiPanel = useCallback(() => {
    if (!isAiPanelOpen) handleToggleAiPanel();
  }, [isAiPanelOpen, handleToggleAiPanel]);

  const toggleActivityPanel = useCallback(
    (panel: "polls" | "qa") => {
      const opening = activityPanel !== panel;
      if (opening) {
        if (isChatOpenRef.current) toggleChat();
        setIsParticipantsOpen(false);
        setIsHostControlsOpen(false);
        setIsVideoEffectsOpen(false);
        setIsViewPanelOpen(false);
        setIsDeviceSettingsOpen(false);
        setIsTranscriptOpen(false);
        setIsAiPanelOpen(false);
      }
      setActivityPanel(opening ? panel : null);
    },
    [activityPanel, setIsParticipantsOpen, toggleChat],
  );
  const handleTogglePolls = useCallback(
    () => toggleActivityPanel("polls"),
    [toggleActivityPanel],
  );
  const handleToggleQa = useCallback(
    () => toggleActivityPanel("qa"),
    [toggleActivityPanel],
  );

  const [startedPoll, setStartedPoll] = useState<{
    id: string;
    createdByName: string;
  } | null>(null);
  const handlePollStarted = useCallback(
    (poll: { id: string; createdByName: string }) => {
      setStartedPoll(poll);
    },
    [],
  );
  const polls = useMeetingPolls({
    hold: reconnectHold,
    isWebinarAttendee,
    onPollStarted: handlePollStarted,
  });
  const authorityRuntime = useAuthorityRuntime();
  const isPollsAvailable = polls.isAvailable;
  const isPollsOpen = activityPanel === "polls" && isPollsAvailable;
  const awaitsVote = (poll: (typeof polls.polls)[number]) =>
    poll.status === "open" && poll.myVote.length === 0;
  const hasPollAwaitingVote =
    !isAdmin && polls.canVote && polls.polls.some(awaitsVote);
  const startedPollStillOpen =
    startedPoll !== null &&
    polls.canVote &&
    polls.polls.some((poll) => poll.id === startedPoll.id && awaitsVote(poll));
  useEffect(() => {
    if (isPollsOpen && startedPoll) setStartedPoll(null);
  }, [isPollsOpen, startedPoll]);
  useEffect(() => {
    if (activityPanel === "polls" && !isPollsAvailable) setActivityPanel(null);
  }, [activityPanel, isPollsAvailable]);

  const isMeetingQaAvailable = meetingQa.isAvailable;
  const isMeetingQaOpen = activityPanel === "qa" && isMeetingQaAvailable;
  useEffect(() => {
    if (activityPanel === "qa" && !isMeetingQaAvailable) setActivityPanel(null);
  }, [activityPanel, isMeetingQaAvailable]);
  const [seenMeetingQuestionIds, setSeenMeetingQuestionIds] = useState<
    ReadonlySet<string>
  >(() => new Set());
  useEffect(() => {
    if (isMeetingQaOpen) {
      setSeenMeetingQuestionIds(new Set(webinarQaEntries.map((entry) => entry.id)));
    }
  }, [isMeetingQaOpen, webinarQaEntries]);
  const hasUnseenQuestion = hasUnseenMeetingQuestion({
    isAvailable: isMeetingQaAvailable,
    isOpen: isMeetingQaOpen,
    entries: webinarQaEntries,
    currentUserId,
    seenIds: seenMeetingQuestionIds,
  });

  // Polls and Q&A open beside the call for this viewer alone. They are
  // opened from the Apps panel when the server offers them. On a server that
  // does not, whatever the reason, they are listed switched off as needing
  // a server update, so their absence is explained.
  const pollsNeedServerUpdate = panelAppNeedsServerUpdate({
    runtime: authorityRuntime,
    offered: polls.offered,
    isJoined,
    isWebinarAttendee,
  });
  // A webinar's questions live in its own Questions section, which an older
  // server still feeds, so nothing is missing there.
  const qaNeedsServerUpdate =
    !webinarConfig?.enabled &&
    panelAppNeedsServerUpdate({
      runtime: authorityRuntime,
      offered: meetingQa.offered,
      isJoined,
      isWebinarAttendee,
    });
  const panelApps: PanelAppEntry[] = [
    ...(isPollsAvailable
      ? [
          {
            id: pollsApp.id,
            name: pollsApp.name,
            description: pollsApp.description,
            icon: <ChartBar size={19} strokeWidth={1.75} />,
            isOpen: isPollsOpen,
            needsAttention: hasPollAwaitingVote,
            onToggle: () => {
              setIsAppsOpen(false);
              handleTogglePolls();
            },
          },
        ]
      : pollsNeedServerUpdate
        ? [
            {
              id: pollsApp.id,
              name: pollsApp.name,
              icon: <ChartBar size={19} strokeWidth={1.75} />,
              isOpen: false,
              needsServerUpdate: true,
              onToggle: () => {},
            },
          ]
        : []),
    ...(isMeetingQaAvailable
      ? [
          {
            id: qaApp.id,
            name: qaApp.name,
            description: qaApp.description,
            icon: <MessageCircleQuestion size={19} strokeWidth={1.75} />,
            isOpen: isMeetingQaOpen,
            needsAttention: hasUnseenQuestion,
            onToggle: () => {
              setIsAppsOpen(false);
              handleToggleQa();
            },
          },
        ]
      : qaNeedsServerUpdate
        ? [
            {
              id: qaApp.id,
              name: qaApp.name,
              icon: <MessageCircleQuestion size={19} strokeWidth={1.75} />,
              isOpen: false,
              needsServerUpdate: true,
              onToggle: () => {},
            },
          ]
        : []),
  ];

  const handleCloseTranscript = useCallback(() => {
    setIsTranscriptOpen(false);
    setTranscriptInitialTab("transcript");
  }, []);

  const handleOpenCatchUp = useCallback(() => {
    setTranscriptInitialTab("minutes");
    if (!isTranscriptOpen) {
      handleToggleTranscript();
    }
  }, [isTranscriptOpen, handleToggleTranscript]);

  const canPostRecapToChat = !isChatLocked || isAdmin;
  const handlePostRecap = useCallback((): boolean => {
    if (!canPostRecapToChat) return false;
    sendChat(
      "@Conclave wrap up the meeting. Post a short recap: what we covered, decisions made, and action items with owners.",
    );
    return true;
  }, [canPostRecapToChat, sendChat]);

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
  const handleSendChat = useCallback(
    (content: string, options?: SendChatMessageOptions) => {
      sendChatRef.current(content, options);
    },
    [],
  );
  const sendChatGifRef = useRef(sendChatGif);
  useEffect(() => {
    sendChatGifRef.current = sendChatGif;
  }, [sendChatGif]);
  const handleSendChatGif = useCallback((gif: ChatGifAttachment) => {
    sendChatGifRef.current(gif);
  }, []);

  const handleSendChatImage = useCallback(
    (
      file: File,
      caption: string,
      onProgress?: (progress: number) => void,
    ) => sendChatImage(file, caption, onProgress),
    [sendChatImage],
  );

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

  const handleToggleImageAttachments = useCallback(() => {
    if (!socket) return;
    socket.emit(
      "setImageAttachmentsEnabled",
      { enabled: !areImageAttachmentsEnabled },
      (res: { error?: string }) => {
        if (res?.error) {
          console.error("Failed to toggle image attachments:", res.error);
        }
      },
    );
  }, [areImageAttachmentsEnabled, socket]);

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
      setIsDeviceSettingsOpen(false);
      setIsTranscriptOpen(false);
      setIsAiPanelOpen(false);
      setActivityPanel(null);
    }
    toggleChat();
  }, [isChatOpen, isParticipantsOpen, setIsParticipantsOpen, toggleChat]);

  const previousDockOpenRef = useRef({
    chat: isChatOpen,
    participants: isParticipantsOpen,
  });
  useEffect(() => {
    const previous = previousDockOpenRef.current;
    previousDockOpenRef.current = {
      chat: isChatOpen,
      participants: isParticipantsOpen,
    };
    const chatOpened = isChatOpen && !previous.chat;
    const participantsOpened = isParticipantsOpen && !previous.participants;
    if (!chatOpened && !participantsOpened) return;
    setIsHostControlsOpen(false);
    setIsVideoEffectsOpen(false);
    setIsViewPanelOpen(false);
    setIsDeviceSettingsOpen(false);
    setIsTranscriptOpen(false);
    setIsAiPanelOpen(false);
    setActivityPanel(null);
    if (chatOpened && isParticipantsOpen && !participantsOpened) {
      setIsParticipantsOpen(false);
    } else if (participantsOpened && isChatOpen && !chatOpened) {
      toggleChat();
    }
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

  const [endFlowState, setEndFlowState] = useState<
    "idle" | "confirm" | "posting"
  >("idle");
  const recapRequestedAtRef = useRef(0);

  const endRoomNow = useCallback(() => {
    setEndFlowState("idle");
    if (!endRoomForEveryone) return;
    void endRoomForEveryone();
  }, [endRoomForEveryone]);

  const handleEndRoomForEveryone = useCallback(() => {
    if (!endRoomForEveryone) return;
    const canOfferRecap =
      canPostRecapToChat &&
      transcript.isLive &&
      transcript.allSegments.length > 0 &&
      endFlowState === "idle";
    if (canOfferRecap) {
      setEndFlowState("confirm");
      return;
    }
    void endRoomForEveryone();
  }, [
    endRoomForEveryone,
    canPostRecapToChat,
    transcript.isLive,
    transcript.allSegments.length,
    endFlowState,
  ]);

  const handlePostRecapAndEnd = useCallback(() => {
    recapRequestedAtRef.current = Date.now();
    if (!handlePostRecap()) {
      endRoomNow();
      return;
    }
    setEndFlowState("posting");
  }, [endRoomNow, handlePostRecap]);

  useEffect(() => {
    if (endFlowState !== "posting") return;
    const requestedAt = recapRequestedAtRef.current;
    const settled = chatMessages.some((message) => {
      if (message.userId !== CONCLAVE_ASSISTANT_USER_ID) return false;
      if (message.timestamp < requestedAt) return false;
      const status = (message as AssistantChatMessage).assistantStatus;
      return status === "done" || status === "error";
    });
    if (settled) {
      endRoomNow();
    }
  }, [chatMessages, endFlowState, endRoomNow]);

  useEffect(() => {
    if (endFlowState !== "posting") return;
    const timer = window.setTimeout(endRoomNow, 30_000);
    return () => window.clearTimeout(timer);
  }, [endFlowState, endRoomNow]);

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
  const webinarQaReserve =
    isWebinarAttendee && isWebinarQaOpen && canReserveDockedPanel
      ? WEBINAR_QA_PANEL_WIDTH
      : 0;
  const isFullScreenPanelOpen =
    isJoined &&
    !canReserveDockedPanel &&
    (isWebinarAttendee ? isWebinarQaOpen : isSecondaryPanelOpen || isGameDockPresent);
  const controlsDockRef = useRef<HTMLDivElement>(null);
  const controlsDockSize = useElementSize(
    controlsDockRef,
    isJoined && !isWebinarAttendee,
  );
  const mainContentStyle =
    isJoined && !isWebinarAttendee
      ? { paddingRight: `calc(1rem + ${dockedPanelReserve}px)` }
      : undefined;
  const stageWidth = viewportWidth - dockedPanelReserve;
  const isControlsBarTight = !isMobile && isJoined && stageWidth < 900;
  const useCompactControls = isMobile || isControlsBarTight;
  const useSlimControls =
    !useCompactControls && isJoined && !isMobile && stageWidth < 1080;
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
  const openWhiteboard = useCallback(() => {
    void handleOpenWhiteboard();
  }, [handleOpenWhiteboard]);
  const closeWhiteboard = useCallback(() => {
    void handleCloseWhiteboard();
  }, [handleCloseWhiteboard]);
  const openWatch = useCallback(() => {
    void handleOpenWatch();
  }, [handleOpenWatch]);
  const closeWatch = useCallback(() => {
    void handleCloseWatch();
  }, [handleCloseWatch]);
  const openDevPlayground = useCallback(() => {
    void handleOpenDevPlayground();
  }, [handleOpenDevPlayground]);
  const closeDevPlayground = useCallback(() => {
    void handleCloseDevPlayground();
  }, [handleCloseDevPlayground]);
  const toggleAppsLock = useCallback(() => {
    void handleToggleAppsLock();
  }, [handleToggleAppsLock]);
  const isParticipantMicrophoneActivationBlocked =
    !isAdmin && !isParticipantUnmuteAllowed;
  const isParticipantCameraActivationBlocked =
    !isAdmin && !isParticipantVideoAllowed;
  const toasts: (ToastItem | null)[] = [
    browserLaunchError
      ? {
          id: "browser",
          label: browserFailedCommand
            ? BROWSER_ERROR_TITLES[browserFailedCommand]
            : "Shared browser",
          message: browserLaunchError,
          tone: "danger",
          onDismiss: onClearBrowserError,
        }
      : null,
    startedPollStillOpen && !isPollsOpen && startedPoll
      ? {
          id: `poll-${startedPoll.id}`,
          label: "Poll",
          message: `${startedPoll.createdByName} started a poll`,
          action: { label: "Vote", onPress: handleTogglePolls },
          onDismiss: () => setStartedPoll(null),
        }
      : null,
    voiceAgentError
      ? {
          id: "voice",
          label: "Voice agent error",
          message: voiceAgentError,
          tone: "danger",
          onDismiss: onClearVoiceAgentError,
        }
      : null,
  ];

  const controlsBarProps: ControlsBarProps = {
    compact: useCompactControls,
    slim: useSlimControls,
    coachAvatars,
    roomId,
    isMuted,
    isMicrophoneUnmuteDisabled: isParticipantMicrophoneActivationBlocked,
    isCameraOff,
    isCameraEnableDisabled: isParticipantCameraActivationBlocked,
    isAudioOnly: viewSettings.audioOnlyMode,
    isScreenSharing,
    activeScreenShareId,
    isChatOpen,
    isTranscriptOpen,
    isTranscriptLive: transcript.isLive,
    transcriptStatus: transcript.session.status,
    unreadCount,
    isHandRaised,
    reactionOptions,
    onToggleMute: toggleMute,
    onToggleCamera: toggleCamera,
    onToggleScreenShare: toggleScreenShare,
    onToggleChat: handleToggleChat,
    onToggleTranscript: handleToggleTranscript,
    isAiSettingsOpen: isAiPanelOpen,
    onToggleAiSettings: roomAi ? handleToggleAiPanel : undefined,
    onToggleHandRaised: toggleHandRaised,
    onSendReaction: sendReaction,
    onLeave: leaveRoom,
    onEndForEveryone: endRoomForEveryone ? handleEndRoomForEveryone : undefined,
    selectedAudioInputDeviceId,
    selectedAudioOutputDeviceId,
    selectedVideoInputDeviceId,
    onAudioInputDeviceChange,
    onAudioOutputDeviceChange,
    onVideoInputDeviceChange,
    isNoiseCancellationEnabled,
    onToggleNoiseCancellation,
    isMirrorCamera,
    onToggleMirror,
    isVideoEffectsOpen,
    activeVideoEffectsCount,
    isVideoEffectsPermissionBlocked: isCameraPermissionBlocked,
    onToggleVideoEffects: handleToggleVideoEffects,
    isViewPanelOpen,
    onToggleViewPanel: handleToggleViewPanel,
    isDeviceSettingsOpen,
    onToggleDeviceSettings: handleToggleDeviceSettings,
    isAdmin,
    isParticipantsOpen,
    onToggleParticipants: handleToggleParticipants,
    isGamesOpen,
    onToggleGames: handleToggleGames,
    hasActiveGame: isGameActive,
    isHostControlsOpen,
    onToggleHostControls: isAdmin ? handleToggleHostControls : undefined,
    pendingUsersCount: isAdmin ? pendingUsers.size : 0,
    isRoomLocked,
    onToggleLock,
    isNoGuests,
    onToggleNoGuests,
    isChatLocked,
    onToggleChatLock,
    isTtsDisabled,
    onToggleTtsDisabled: handleToggleTtsDisabled,
    isDmEnabled,
    onToggleDmEnabled: handleToggleDmEnabled,
    isReactionsDisabled,
    onToggleReactionsDisabled: handleToggleReactionsDisabled,
    isBrowserActive: browserState?.active ?? false,
    isBrowserLaunching,
    showBrowserControls,
    onLaunchBrowser,
    onNavigateBrowser,
    onCloseBrowser,
    hasBrowserAudio,
    isBrowserAudioMuted,
    onToggleBrowserAudio,
    isWhiteboardActive,
    onOpenWhiteboard: isAdmin ? openWhiteboard : undefined,
    onCloseWhiteboard: isAdmin ? closeWhiteboard : undefined,
    isWatchActive,
    onOpenWatch: isAdmin ? openWatch : undefined,
    onCloseWatch: isAdmin ? closeWatch : undefined,
    isAppsOpen,
    hasActiveApp: Boolean(appsState.activeAppId),
    hasAppWaiting: hasPollAwaitingVote || hasUnseenQuestion,
    isToastShowing: isJoined && toasts.some(Boolean),
    onToggleApps: handleToggleApps,
    isDevPlaygroundEnabled,
    isDevPlaygroundActive,
    onOpenDevPlayground: isAdmin ? openDevPlayground : undefined,
    onCloseDevPlayground: isAdmin ? closeDevPlayground : undefined,
    isAppsLocked: appsState.locked,
    onToggleAppsLock: isAdmin ? toggleAppsLock : undefined,
    isVoiceAgentRunning,
    isVoiceAgentStarting,
    onStartVoiceAgent: isAdmin ? onStartVoiceAgent : undefined,
    onStopVoiceAgent: isAdmin ? onStopVoiceAgent : undefined,
    isPopoutActive,
    isPopoutSupported,
    onOpenPopout,
    onClosePopout,
    meetingRequiresInviteCode,
    webinarConfig,
    webinarRole,
    webinarLink,
    onSetWebinarLink,
    onGetMeetingConfig,
    onUpdateMeetingConfig,
    onGetWebinarConfig,
    onUpdateWebinarConfig,
    onGenerateWebinarLink,
    onRotateWebinarLink,
  };
  return (
    <div
      className={`flex-1 flex flex-col relative ${
        isJoined
          ? isWebinarAttendee
            ? "overflow-hidden p-0"
            : "overflow-hidden p-4"
          : "overflow-y-auto p-0"
      }`}
      style={mainContentStyle}
    >
      {isRecoveringMeeting && (
        <div
          className="absolute inset-0 z-[95] flex items-center justify-center bg-[#050506]/70 px-4 backdrop-blur-md animate-fade-in"
          aria-live="assertive"
          aria-label="Reconnecting to the meeting"
        >
          <section
            className="w-full max-w-[400px] rounded-2xl border border-[#fafafa]/12 bg-[#131316]/95 px-7 py-8 text-center shadow-2xl"
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
            <div className="mt-5 flex flex-wrap items-center justify-center gap-2.5">
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
                  className="inline-flex h-9 items-center justify-center gap-2 rounded-full border border-[#F95F4A]/45 bg-[#F95F4A]/20 px-4 text-[12.5px] font-medium text-[#fafafa] transition-colors hover:border-[#F95F4A]/70 hover:bg-[#F95F4A]/35 disabled:cursor-not-allowed disabled:border-[#fafafa]/12 disabled:bg-[#fafafa]/8 disabled:text-[#fafafa]/42"
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
              {isTerminalMeetingError && onStartNewMeeting ? (
                <button
                  type="button"
                  onClick={onStartNewMeeting}
                  className="inline-flex h-9 items-center justify-center gap-2 rounded-full border border-[#F95F4A]/45 bg-[#F95F4A]/20 px-4 text-[12.5px] font-medium text-[#fafafa] transition-colors hover:border-[#F95F4A]/70 hover:bg-[#F95F4A]/35"
                >
                  <Plus size={14} strokeWidth={1.8} />
                  New Meeting
                </button>
              ) : null}
              <button
                type="button"
                onClick={isTerminalMeetingError ? (onGoHome ?? leaveRoom) : leaveRoom}
                className="inline-flex h-9 items-center justify-center gap-2 rounded-full border border-[#fafafa]/15 px-4 text-[12.5px] font-medium text-[#fafafa]/76 transition-colors hover:border-[#fafafa]/35 hover:bg-[#fafafa]/10 hover:text-[#fafafa]"
              >
                {isTerminalMeetingError ? (
                  <Home size={14} strokeWidth={1.8} />
                ) : (
                  <LogOut size={14} strokeWidth={1.8} />
                )}
                {isTerminalMeetingError ? "Go home" : "Leave"}
              </button>
            </div>
          </section>
        </div>
      )}
      {isJoined ? (
        <InCallNoticeSlot
          rightInset={isWebinarAttendee ? webinarQaReserve : dockedPanelReserve}
          bottomInset={
            controlsDockSize
              ? controlsDockSize.height + NOTICE_CONTROLS_CLEARANCE_PX
              : 0
          }
          clearWebinarChrome={isWebinarAttendee}
          overPanel={isFullScreenPanelOpen}
        >
          <InCallNotice show={Boolean(mediaErrorNotice)}>{mediaErrorNotice}</InCallNotice>
          <InCallNotice show={Boolean(errorNotice)}>{errorNotice}</InCallNotice>
          {!isRecoveringMeeting && (!isWebinarAttendee || serverRestartNotice) ? (
            <ConnectionBanner
              state={connectionState}
              isOffline={isNetworkOffline}
              serverRestartNotice={serverRestartNotice}
            />
          ) : null}
          <InCallNotice show={!isWebinarAttendee && participantAudioBlocked}>
            <InCallNoticeCard
              tone="warning"
              icon={VolumeX}
              title="Your browser paused audio"
              actionLabel="Turn on audio"
              onAction={handlePlayParticipantAudio}
              actionOnCardClick
            />
          </InCallNotice>
          <InCallNotice show={!isWebinarAttendee && browserAudioNeedsGesture}>
            <InCallNoticeCard
              icon={Globe}
              title="Shared browser sound is paused"
              actionLabel="Turn on sound"
              onAction={onToggleBrowserAudio}
            />
          </InCallNotice>
          {!isWebinarAttendee && !isTranscriptOpen && transcript.isLive ? (
            <CatchUpPill
              startedAt={transcript.session.startedAt}
              joinedAt={joinedAt}
              sessionKey={`${transcript.session.roomId}:${transcript.session.startedAt ?? 0}`}
              onOpen={handleOpenCatchUp}
            />
          ) : null}
          <InCallNotice show={viewSettings.audioOnlyMode}>
            <InCallNoticeCard
              icon={Headphones}
              title="Audio-only mode is on"
              actionLabel="Turn off"
              onAction={() =>
                onViewSettingsChange((current) => ({
                  ...current,
                  audioOnlyMode: false,
                }))
              }
            />
          </InCallNotice>
        </InCallNoticeSlot>
      ) : null}
      {isJoined && <AdminNoticePill notice={adminNotice} />}
      {endFlowState !== "idle" ? (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/55 px-4">
          <div
            className="w-full max-w-[22rem] rounded-2xl border border-white/10 bg-[#18181b] p-5"
            style={{ fontFamily: "'PolySans Trial', sans-serif" }}
            role="dialog"
            aria-modal="true"
            aria-label="End call for everyone"
          >
            {endFlowState === "confirm" ? (
              <>
                <h2 className="text-[15px] font-semibold text-[#fafafa]">
                  End call for everyone?
                </h2>
                <p className="mt-1.5 text-[12.5px] leading-relaxed text-[#a1a1aa]">
                  Conclave can post a recap of the meeting to chat before the
                  call ends.
                </p>
                <div className="mt-4 flex flex-col gap-2">
                  <button
                    type="button"
                    onClick={handlePostRecapAndEnd}
                    className="w-full rounded-xl bg-[#F95F4A] px-3.5 py-2.5 text-[13px] font-medium text-white transition-opacity hover:opacity-90"
                  >
                    Post recap and end
                  </button>
                  <button
                    type="button"
                    onClick={endRoomNow}
                    className="w-full rounded-xl border border-white/10 px-3.5 py-2.5 text-[13px] font-medium text-[#fafafa] transition-colors hover:bg-white/[0.06]"
                  >
                    End without recap
                  </button>
                  <button
                    type="button"
                    onClick={() => setEndFlowState("idle")}
                    className="w-full rounded-xl px-3.5 py-2 text-[12.5px] font-medium text-[#a1a1aa] transition-colors hover:text-[#fafafa]"
                  >
                    Cancel
                  </button>
                </div>
              </>
            ) : (
              <>
                <h2 className="text-[15px] font-semibold text-[#fafafa]">
                  Posting recap
                </h2>
                <p className="mt-1.5 text-[12.5px] leading-relaxed text-[#a1a1aa]">
                  Conclave is writing the recap in chat. The call ends for
                  everyone once it lands.
                </p>
                <div className="mt-4 flex items-center justify-between gap-3">
                  <span className="inline-flex items-center gap-2 text-[12px] text-[#a1a1aa]">
                    <Loader2 size={13} className="animate-spin text-[#4F9CF9]" />
                    Posting to chat
                  </span>
                  <button
                    type="button"
                    onClick={endRoomNow}
                    className="rounded-xl border border-white/10 px-3 py-1.5 text-[12px] font-medium text-[#fafafa] transition-colors hover:bg-white/[0.06]"
                  >
                    End now
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      ) : null}
      <SystemAudioPlayers
        participants={participants}
        audioOutputDeviceId={audioOutputDeviceId}
        muted={isBrowserAudioMuted}
        onAutoplayBlocked={onBrowserAudioAutoplayBlocked}
        onPlaybackStarted={onBrowserAudioPlaybackStarted}
        playbackAttemptToken={browserAudioPlaybackAttemptToken}
      />
      <ScreenShareAudioPlayers
        participants={participants}
        currentUserId={currentUserId}
        activeScreenShareId={activeScreenShareId}
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
      {isJoined && (
        <ReactionOverlay
          store={reactionStore}
          getDisplayName={resolveDisplayName}
          participantCount={nonSystemParticipants.length + 1}
        />
      )}
      {isDevToolsEnabled && isJoined && !isWebinarAttendee && (
        <MeetingPanelBoundary key="developer-tools" name="Developer tools">
          <DevMeetToolsPanel
            roomId={roomId}
            onPresentationStreamChange={setDevPresentationStream}
            onCameraStreamChange={handleDevCameraStreamChange}
          />
        </MeetingPanelBoundary>
      )}
      {isJoined && !isWebinarAttendee && isWatchHiddenLocally ? (
        <div className="mb-3 flex shrink-0 justify-center">
          <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-[#18181b] py-1 pl-3 pr-1 text-[12.5px] text-[#a1a1aa]">
            <MonitorPlay size={14} strokeWidth={1.75} aria-hidden="true" />
            <span>Watch together is playing</span>
            <button
              type="button"
              onClick={() => setIsWatchOptedOut(false)}
              className="inline-flex h-7 items-center rounded-full bg-[#F95F4A] px-3 font-medium text-white transition-[filter] duration-150 hover:brightness-105 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/40"
            >
              Rejoin
            </button>
          </div>
        </div>
      ) : null}
      {!isJoined ? (
        hideJoinUI ? (
          (() => {
            const view = hiddenSetupView({
              notice: setupNotice,
              errorMessage: meetError?.message ?? "",
              isLoading,
            });
            return (
              <main className="flex min-h-dvh items-center justify-center bg-[#0a0a0b] px-6 py-10 text-[#fafafa]">
                <div className="w-full max-w-md text-center">
                  {view.busy ? (
                    <div className="relative mx-auto mb-5 h-9 w-9">
                      <div className="absolute inset-0 rounded-full border-2 border-[#fafafa]/10" />
                      <div className="absolute inset-0 animate-spin rounded-full border-2 border-transparent border-t-[#F95F4A]" />
                    </div>
                  ) : null}
                  <h1
                    className="text-balance text-[24px] leading-tight text-[#fafafa]"
                    style={{ fontFamily: "'PolySans Bulky Wide', sans-serif" }}
                  >
                    {view.headline}
                  </h1>
                  <p className="mx-auto mt-3 max-w-[340px] text-pretty text-[13.5px] leading-relaxed text-[#fafafa]/55">
                    {view.body}
                  </p>
                  {view.action === "home" ? (
                    <a
                      href="/"
                      className="mt-7 inline-flex h-11 items-center justify-center rounded-full bg-[#F95F4A] px-6 text-[14px] font-medium text-white transition-[filter] duration-150 hover:brightness-105"
                    >
                      Back to home
                    </a>
                  ) : view.action === "retry" ? (
                    <button
                      type="button"
                      onClick={() => window.location.reload()}
                      className="mt-7 inline-flex h-11 items-center justify-center rounded-full bg-[#F95F4A] px-6 text-[14px] font-medium text-white transition-[filter] duration-150 hover:brightness-105"
                    >
                      Try again
                    </button>
                  ) : null}
                </div>
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
            showPermissionHint={showPermissionHint}
            rooms={availableRooms}
            roomsStatus={roomsStatus}
            onRefreshRooms={refreshRooms}
            onJoinRoom={joinRoomById}
            displayNameInput={displayNameInput}
            onDisplayNameInputChange={setDisplayNameInput}
            onUserChange={onUserChange}
            onIsAdminChange={onIsAdminChange}
            mediaError={mediaError}
            setupNotice={setupNotice}
            onDismissSetupNotice={onDismissSetupNotice}
            videoEffects={videoEffects}
            onVideoEffectsChange={onVideoEffectsChange}
            onPrejoinMediaCommit={onPrejoinMediaCommit}
            onEnterStart={onEnterMeetingStart}
          />
        )
      ) : isWebinarAttendee ? (
        <div
          ref={webinarStageRef}
          className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-[#0a0a0b]"
          style={{ marginRight: webinarQaReserve }}
        >
          <div
            className="pointer-events-none h-0 w-0 overflow-hidden"
            aria-hidden={true}
          >
            {nonSystemParticipants.map((participant) => (
              <ParticipantAudio
                key={`webinar-audio-${participant.userId}`}
                participant={participant}
                audioOutputDeviceId={audioOutputDeviceId}
                onAudioAutoplayBlocked={handleWebinarAudioAutoplayBlocked}
                onAudioPlaybackStarted={handleWebinarAudioPlaybackStarted}
                audioPlaybackAttemptToken={webinarAudioPlaybackAttempt}
              />
            ))}
          </div>

          {webinarStage && showWebinarStage ? (
            <div className="webinar-stage-main relative min-h-0 flex-1">
              <ParticipantVideo
                key={webinarStage.main.participant.userId}
                participant={webinarStage.main.participant}
                displayName={webinarStage.main.displayName}
                isActiveSpeaker={
                  activeSpeakerId === webinarStage.main.participant.userId
                }
                disableAudio
                hideLabel
                videoObjectFit={webinarStage.isScreenShare ? "contain" : "cover"}
              />
              {webinarStage.pip ? (
                <div
                  className={`absolute z-30 h-28 w-44 overflow-hidden rounded-xl border border-[#fafafa]/20 bg-black/75 shadow-[0_16px_36px_rgba(0,0,0,0.5)] sm:h-32 sm:w-56 ${pipDragPosition ? "" : webinarPipCornerClass} cursor-grab active:cursor-grabbing touch-none select-none`}
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
                    disableAudio
                  />
                </div>
              ) : null}
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 items-center justify-center p-6">
              <WebinarWaitingCard
                attendeeCount={webinarConfig?.attendeeCount ?? 0}
              />
            </div>
          )}

          <WebinarViewerChrome
            title={webinarTitle}
            attendeeCount={webinarConfig?.attendeeCount ?? 0}
            hasLiveStage={webinarStageIsLive}
            speakerName={webinarStage?.main.displayName ?? null}
            qaEnabled={isWebinarQaEnabled}
            isQaOpen={isWebinarQaOpen}
            unseenQaCount={unseenWebinarQaCount}
            onToggleQa={handleToggleWebinarQa}
            isHandRaised={isWebinarHandRaised}
            onToggleHand={
              onSetWebinarHandRaised ? handleToggleWebinarHand : undefined
            }
            stageContainerRef={webinarStageRef}
            onLeave={leaveRoom}
          />

          {isWebinarQaOpen && isWebinarQaEnabled ? (
            <QaPanel
              audience="webinar"
              entries={webinarQaEntries}
              qaEnabled={isWebinarQaEnabled}
              currentUserId={currentUserId}
              askNeedsIdentity={meetingQa.askNeedsIdentity}
              onClose={handleToggleWebinarQa}
              onSubmit={onSubmitWebinarQuestion}
              onUpvote={
                isWebinarQaEnabled ? onUpvoteWebinarQuestion : undefined
              }
              waiting={meetingQa.waiting}
              connection={meetingQa.connection}
            />
          ) : null}

          {webinarStageInvite &&
          onAcceptWebinarStageInvite &&
          onDismissWebinarStageInvite ? (
            <WebinarStageInviteDialog
              promotedByName={webinarStageInvite.promotedByName}
              onAccept={onAcceptWebinarStageInvite}
              onDismiss={onDismissWebinarStageInvite}
            />
          ) : null}

          {webinarAudioBlocked && (
            <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/65 p-4 backdrop-blur-sm">
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
      ) : ActiveMeetingApp &&
        !isWatchHiddenLocally &&
        (!isDevPlaygroundActive || isDevPlaygroundEnabled) ? (
        <MeetingAppLayout
          stageId="app"
          fullStageBelowLarge
          frameContent={!isDevPlaygroundActive}
          leaveAction={isWatchActive ? watchLeaveAction : undefined}
          localStream={localStream}
          isCameraOff={isCameraOff}
          isMuted={isMuted}
          isHandRaised={isHandRaised}
          participants={participants}
          userEmail={userEmail}
          isMirrorCamera={mirrorLocalPreview}
          activeSpeakerId={activeSpeakerId}
          currentUserId={currentUserId}
          audioOutputDeviceId={audioOutputDeviceId}
          onAudioAutoplayBlocked={handleParticipantAudioAutoplayBlocked}
          onAudioPlaybackStarted={handleParticipantAudioPlaybackStarted}
          audioPlaybackAttemptToken={participantAudioPlaybackAttempt}
          getDisplayName={resolveDisplayName}
        >
          <ActiveMeetingApp />
        </MeetingAppLayout>
      ) : browserState?.active && browserState.noVncUrl ? (
        <MeetingAppLayout
          stageId="shared-browser"
          localStream={localStream}
          isCameraOff={isCameraOff}
          isMuted={isMuted}
          isHandRaised={isHandRaised}
          participants={participants}
          userEmail={userEmail}
          isMirrorCamera={mirrorLocalPreview}
          activeSpeakerId={activeSpeakerId}
          currentUserId={currentUserId}
          audioOutputDeviceId={audioOutputDeviceId}
          onAudioAutoplayBlocked={handleParticipantAudioAutoplayBlocked}
          onAudioPlaybackStarted={handleParticipantAudioPlaybackStarted}
          audioPlaybackAttemptToken={participantAudioPlaybackAttempt}
          getDisplayName={resolveDisplayName}
        >
          <SharedBrowserStage
            noVncUrl={browserState.noVncUrl}
            controllerName={
              browserState.controllerUserId
                ? resolveDisplayName(browserState.controllerUserId)
                : ""
            }
            isLocalController={
              Boolean(browserState.controllerUserId) &&
              browserState.controllerUserId === currentUserId
            }
            provider={browserState.provider}
            browserVideoStream={browserVideoStream}
          />
        </MeetingAppLayout>
      ) : (
        <GridLayout
          localStream={effectiveLocalStream}
          isCameraOff={effectiveIsCameraOff}
          isMuted={isMuted}
          isHandRaised={isHandRaised}
          participants={participants}
          userEmail={userEmail}
          isMirrorCamera={mirrorLocalPreview}
          activeSpeakerId={effectiveActiveSpeakerId}
          currentUserId={currentUserId}
          audioOutputDeviceId={audioOutputDeviceId}
          onAudioAutoplayBlocked={handleParticipantAudioAutoplayBlocked}
          onAudioPlaybackStarted={handleParticipantAudioPlaybackStarted}
          audioPlaybackAttemptToken={participantAudioPlaybackAttempt}
          onOpenParticipantsPanel={handleOpenParticipants}
          activeVideoEffectsCount={activeVideoEffectsCount}
          isVideoFramingEnabled={videoEffects.framing}
          onToggleVideoFraming={handleToggleVideoFraming}
          viewSettings={viewSettings}
          onViewSettingsChange={onViewSettingsChange}
          presentationStream={effectivePresentationStream}
          presenterName={effectivePresenterName}
          presentationPresenterId={presentationPresenterId}
          presentationProducerId={presentationProducerId}
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
        <ToastQueue toasts={toasts} />
      )}

      {isJoined &&
        (isWebinarAttendee ? null : (
          <div
            ref={controlsDockRef}
            data-in-call-controls
            className="safe-area-pb flex w-full flex-col items-center gap-2"
          >
            <ControlsBar {...controlsBarProps} />
            <CommandPalette
              controls={controlsBarProps}
              onSendChatMessage={handleSendChat}
            />
            <ShortcutsHelpDialog />
          </div>
        ))}

      {/* Apps covers a running game while it is open, so the panel apps
          stay reachable. The game goes on underneath and is back when Apps
          closes or one of its apps is picked. */}
      {isJoined && !isWebinarAttendee && isGameActive && (
        <GamePanel
          rightOffset={gameDockOffset}
          dockWidth={gameDockPanelWidth}
          maxDockWidth={gameDockMaxWidth}
          onDockWidthChange={handleGameDockWidthChange}
          isCovered={isAppsOpen}
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

      {isJoined && !isWebinarAttendee && isAppsOpen && (
        <AppsPanel
          panelApps={panelApps}
          rightOffset={gameDockOffset}
          dockWidth={gameDockPanelWidth}
          maxDockWidth={gameDockMaxWidth}
          onDockWidthChange={handleGameDockWidthChange}
          onClose={() => setIsAppsOpen(false)}
        />
      )}

      {isJoined && !isWebinarAttendee && isChatOpen && (
        <MeetingPanelBoundary
          name="Chat"
          key={meetingPanelKey("chat", currentUserId, roomId)}
          onClose={handleToggleChat}
        >
          <ChatPanel
            roomAi={roomAi}
            onOpenAiSettings={roomAi ? handleOpenAiPanel : undefined}
            messages={chatMessages}
            chatInput={chatInput}
            onInputChange={setChatInput}
            onSend={handleSendChat}
            onSendGif={handleSendChatGif}
            onSendImage={handleSendChatImage}
            onClose={handleToggleChat}
            currentUserId={currentUserId}
            isChatLocked={isChatLocked}
            isDmEnabled={isDmEnabled}
            areImageAttachmentsEnabled={areImageAttachmentsEnabled}
            isAdmin={isAdmin}
            mentionableParticipants={mentionableParticipants}
            replyTarget={replyTarget}
            onReply={onReplyToMessage}
            onToggleReaction={onToggleMessageReaction}
            isReactionsDisabled={isReactionsDisabled}
            resolveDisplayName={resolveDisplayName}
            onCancelReply={onCancelReply}
            activeTtsMessageId={activeTtsMessageId}
            onReplayTtsMessage={onReplayTtsMessage}
            onStopTts={onStopTts}
            hasClonedTtsVoice={hasClonedTtsVoice}
            isTtsDisabled={isTtsDisabled}
            assistantApiKeyPrompt={assistantApiKeyPrompt}
            onSubmitAssistantApiKey={onSubmitAssistantApiKey}
            onCancelAssistantApiKey={onCancelAssistantApiKey}
            onAssistantToolApproval={onAssistantToolApproval}
          />
        </MeetingPanelBoundary>
      )}

      {isJoined && !isWebinarAttendee && isTranscriptOpen && (
        <MeetingPanelBoundary
          name="Transcript"
          key={meetingPanelKey("transcript", currentUserId, roomId)}
          onClose={handleCloseTranscript}
        >
          <TranscriptPanel
            roomAi={roomAi}
            onOpenAiSettings={roomAi ? handleOpenAiPanel : undefined}
            transcript={transcript}
            onClose={handleCloseTranscript}
            initialTab={transcriptInitialTab}
            onPostRecap={canPostRecapToChat ? handlePostRecap : undefined}
          />
        </MeetingPanelBoundary>
      )}

      {isJoined && isPollsOpen && (
        <PollsPanel
          polls={polls.polls}
          isHost={polls.canManage}
          canVote={polls.canVote}
          voteNeedsIdentity={polls.voteNeedsIdentity}
          onClose={handleTogglePolls}
          onCreate={polls.createPoll}
          onVote={polls.vote}
          onEnd={polls.endPoll}
          onShare={polls.shareResults}
          onExport={polls.exportCsv}
          waiting={polls.waiting}
          connection={polls.connection}
        />
      )}

      {isJoined && isMeetingQaOpen && (
        <QaPanel
          audience="meeting"
          entries={webinarQaEntries}
          qaEnabled
          currentUserId={currentUserId}
          askNeedsIdentity={meetingQa.askNeedsIdentity}
          onClose={handleToggleQa}
          onSubmit={onSubmitWebinarQuestion}
          onUpvote={onUpvoteWebinarQuestion}
          onModerate={onModerateWebinarQuestion}
          waiting={meetingQa.waiting}
          connection={meetingQa.connection}
        />
      )}

      {isJoined && !isWebinarAttendee && isAiPanelOpen && roomAi && (
        <RoomAiPanel controller={roomAi} onClose={() => setIsAiPanelOpen(false)} />
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
          }}
          getDisplayName={resolveDisplayName}
          onPendingUserStale={handlePendingUserStale}
          hostUserId={hostUserId}
          hostUserIds={hostUserIds}
          webinarEnabled={Boolean(webinarConfig?.enabled)}
          webinarAttendeeCount={webinarConfig?.attendeeCount ?? 0}
          webinarQaEntries={webinarQaEntries}
          webinarHandQueue={webinarHandQueue}
          onModerateWebinarQuestion={onModerateWebinarQuestion}
          webinarQaWaiting={meetingQa.waiting}
          webinarQaConnection={meetingQa.connection}
          onPromoteWebinarAttendee={onPromoteWebinarAttendee}
          onDemoteWebinarParticipant={onDemoteWebinarParticipant}
        />
      )}

      {isJoined &&
        !isWebinarAttendee &&
        isAdmin &&
        isHostControlsOpen && (
          <MeetSettingsPanel
            onOpenAiSettings={roomAi ? handleOpenAiPanel : undefined}
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
            areImageAttachmentsEnabled={areImageAttachmentsEnabled}
            onToggleImageAttachments={handleToggleImageAttachments}
            isReactionsDisabled={isReactionsDisabled}
            onToggleReactionsDisabled={handleToggleReactionsDisabled}
            isParticipantUnmuteAllowed={isParticipantUnmuteAllowed}
            onToggleParticipantUnmuteAllowed={
              onToggleParticipantUnmuteAllowed
            }
            isParticipantVideoAllowed={isParticipantVideoAllowed}
            onToggleParticipantVideoAllowed={onToggleParticipantVideoAllowed}
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
        <MeetingPanelBoundary
          key="video-effects"
          name="Backgrounds and effects"
          onClose={handleCloseVideoEffects}
        >
          <VideoEffectsPanel
            effects={videoEffects}
            onEffectsChange={onVideoEffectsChange}
            onRecenterFraming={onVideoEffectsRecenter}
            localStream={panelPreviewStream}
            isCameraOff={effectiveIsCameraOff && !panelPreviewIsLocalOnly}
            status={videoEffectsStatus}
            error={videoEffectsError}
            debugStats={videoEffectsDebugStats}
            activeCount={activeVideoEffectsCount}
            deferPreload={deferVideoEffectsPreload}
            cameraPermissionBlocked={isCameraPermissionBlocked}
            cameraActivationBlocked={isParticipantCameraActivationBlocked}
            onToggleCamera={toggleCamera}
            isCameraPreviewActive={panelPreviewIsLocalOnly}
            isCameraPreviewStarting={isCameraPreviewStarting}
            cameraPreviewError={cameraPreviewError}
            onStartCameraPreview={onStartCameraPreview}
            onStopCameraPreview={onStopCameraPreview}
            onClose={handleCloseVideoEffects}
          />
        </MeetingPanelBoundary>
      )}

      {isJoined && !isWebinarAttendee && isDeviceSettingsOpen && (
        <MeetingPanelBoundary
          key="device-settings"
          name="Settings"
          onClose={handleCloseDeviceSettings}
        >
          <DeviceSettingsPanel
            roomAi={roomAi}
            localStream={panelPreviewStream}
            isLocalVideoLive={Boolean(getLiveVideoStream(effectiveLocalStream))}
            isPreviewOnly={panelPreviewIsLocalOnly}
            mirrorLocalPreview={mirrorLocalPreview}
            isMirrorCamera={isMirrorCamera}
            onToggleMirror={onToggleMirror}
            activeVideoEffectsCount={activeVideoEffectsCount}
            mediaQualitySettings={mediaQualitySettings}
            onMediaQualitySettingsChange={onMediaQualitySettingsChange}
            selectedAudioInputDeviceId={selectedAudioInputDeviceId}
            selectedAudioOutputDeviceId={selectedAudioOutputDeviceId}
            ttsSystemVoices={ttsSystemVoices}
            selectedTtsSystemVoiceUri={selectedTtsSystemVoiceUri}
            onTtsSystemVoiceChange={onTtsSystemVoiceChange}
            clonedTtsVoice={clonedTtsVoice}
            onClonedTtsVoiceChange={onClonedTtsVoiceChange}
            onClonedTtsVoiceClear={onClonedTtsVoiceClear}
            canCloneTtsVoice={canCloneTtsVoice}
            ttsVoiceOwnerName={ttsVoiceOwnerName}
            selectedVideoInputDeviceId={selectedVideoInputDeviceId}
            onAudioInputDeviceChange={onAudioInputDeviceChange}
            onAudioOutputDeviceChange={onAudioOutputDeviceChange}
            onVideoInputDeviceChange={onVideoInputDeviceChange}
            isNoiseCancellationEnabled={isNoiseCancellationEnabled}
            onToggleNoiseCancellation={onToggleNoiseCancellation}
            isCameraPreviewStarting={isCameraPreviewStarting}
            cameraPreviewError={cameraPreviewError}
            onStartCameraPreview={onStartCameraPreview}
            onStopCameraPreview={onStopCameraPreview}
            connectionStats={connectionStats}
            isCameraPermissionBlocked={isCameraPermissionBlocked}
            onOpenEffects={
              isCameraPermissionBlocked ? undefined : handleToggleVideoEffects
            }
            onClose={handleCloseDeviceSettings}
          />
        </MeetingPanelBoundary>
      )}

      {isJoined && !isWebinarAttendee && isViewPanelOpen && (
        <MeetViewPanel
          settings={viewSettings}
          onSettingsChange={onViewSettingsChange}
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

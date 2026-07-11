"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useHotkey } from "@tanstack/react-hotkeys";
import type { RegisterableHotkey } from "@tanstack/hotkeys";
import { HOTKEYS } from "./lib/hotkeys";
import type { Socket } from "socket.io-client";
import type { RoomInfo } from "@/lib/sfu-types";
import { useSession } from "@/lib/auth-client";
import {
  AppsProvider,
  GameProvider,
} from "@conclave/apps-sdk";
import { devPlaygroundApp } from "@conclave/apps-sdk/dev-playground/web";
import { watchApp } from "@conclave/apps-sdk/watch/web";
import { whiteboardApp } from "@conclave/apps-sdk/whiteboard/web";
import MeetsErrorBanner from "./components/MeetsErrorBanner";
import MeetsHeader from "./components/MeetsHeader";
import MeetsMainContent from "./components/MeetsMainContent";
import MeetsWaitingScreen from "./components/MeetsWaitingScreen";
import MeetingEnterOverlay from "./components/MeetingEnterOverlay";

const MEETING_APPS =
  process.env.NODE_ENV === "development"
    ? [whiteboardApp, watchApp, devPlaygroundApp]
    : [whiteboardApp, watchApp];

import { useMeetAudioActivity } from "./hooks/useMeetAudioActivity";
import { useMeetChat, type ConclaveAssistantContext } from "./hooks/useMeetChat";
import { formatTranscriptForAssistant } from "./lib/conclave-assistant";
import { useMeetDisplayName } from "./hooks/useMeetDisplayName";
import { useMeetHandRaise } from "./hooks/useMeetHandRaise";
import { useMeetHandRaiseSound } from "./hooks/useMeetHandRaiseSound";
import { useMeetLifecycle } from "./hooks/useMeetLifecycle";
import { useMeetMedia } from "./hooks/useMeetMedia";
import { useMeetMediaSettings } from "./hooks/useMeetMediaSettings";
import { useLocalCameraPreview } from "./hooks/useLocalCameraPreview";
import { useMeetPictureInPicture } from "./hooks/useMeetPictureInPicture";
import { useMeetPopout } from "./hooks/useMeetPopout";
import { useMeetReactions } from "./hooks/useMeetReactions";
import { useMeetRefs } from "./hooks/useMeetRefs";
import { useMeetRooms } from "./hooks/useMeetRooms";
import { useMeetSocket } from "./hooks/useMeetSocket";
import { useMeetState } from "./hooks/useMeetState";
import { useMeetTts } from "./hooks/useMeetTts";
import { useMeetingTranscript } from "./hooks/useMeetingTranscript";
import { MeetVolumeProvider } from "./hooks/useMeetVolume";
import {
  useBandwidthHeavyPreloadDeferred,
} from "./hooks/useBandwidthHeavyPreloadDeferred";
import {
  useAdaptiveConsumerPreferences,
  type AdaptiveConsumerPreferencesDebugSnapshot,
  type AdaptiveConsumerVideoPauseStateChange,
} from "./hooks/useAdaptiveConsumerPreferences";
import {
  useAdaptivePublishQuality,
  type AdaptivePublishQualityDebugSnapshot,
} from "./hooks/useAdaptivePublishQuality";
import {
  useConnectionQuality,
  type ConnectionQuality,
  type ConnectionQualityStats,
} from "./hooks/useConnectionQuality";
import { useIsMobile } from "./hooks/useIsMobile";
import { usePrewarmSocket } from "./hooks/usePrewarmSocket";
import { useScreenWakeLock } from "./hooks/useScreenWakeLock";
import { useSharedBrowser } from "./hooks/useSharedBrowser";
import { useVoiceAgentParticipant } from "./hooks/useVoiceAgentParticipant";
import VoiceAgentDialog from "./components/VoiceAgentDialog";
import {
  clearStoredVoiceAgentKey,
  getStoredVoiceAgentKey,
  storeVoiceAgentKey,
} from "./lib/voice-agent-key";
import type { JoinMode, PrejoinMediaHandoff } from "./lib/types";
import {
  readStoredMeetViewSettings,
  writeStoredMeetViewSettings,
  type MeetViewSettings,
} from "./lib/meet-view";
import {
  countActiveVideoEffects,
  DEFAULT_VIDEO_EFFECTS,
  hasActiveVideoEffects,
  normalizeVideoEffectsState,
  normalizeVideoEffectsStateForStorage,
  type BackgroundEffectId,
  type VideoEffectsState,
} from "./lib/video-effects";
import { getCustomVideoBackground } from "./lib/video-effects-custom-backgrounds";
import {
  prewarmVideoEffectsAssetsDeferred,
  prewarmVideoEffectsRuntimeDeferred,
} from "./lib/video-effects-lazy";
import {
  getBrowserNetworkInformation,
  getBrowserNetworkSnapshot,
} from "./lib/network-information";
import {
  generateRoomCode,
  isSystemUserId,
  sanitizeInstitutionDisplayName,
  sanitizeRoomCode,
} from "./lib/utils";
import type { VideoEffectsBridgeState } from "./components/VideoEffectsBridge";

type MeetUser = {
  id?: string;
  email?: string | null;
  name?: string | null;
};

type MeetVideoDebugWindow = Window & {
  __conclaveGetMeetVideoDebug?: () => Record<string, unknown>;
  __conclaveMeetVideoDebug?: Record<string, unknown>;
  __conclaveCloseLocalVideoProducerForDebug?: (
    reason?: string,
  ) => Promise<Record<string, unknown>>;
};

const PUBLISH_RECOVERY_RTT_POOR_MS = 500;
const PUBLISH_RECOVERY_LOSS_POOR = 0.08;
const PUBLISH_RECOVERY_JITTER_POOR_MS = 60;

const VideoEffectsBridge = dynamic(
  () => import("./components/VideoEffectsBridge"),
  { ssr: false },
);

const VIDEO_EFFECTS_OFF_STATE: VideoEffectsBridgeState = {
  effectiveStream: null,
  processedTrackVersion: 0,
  processedTrackReady: false,
  status: "off",
  error: null,
  debugStats: null,
};

const GUEST_USER_STORAGE_KEY = "conclave:guest-user";
const DEBUG_VIDEO_EFFECTS_STORAGE_KEY = "conclave:debug-video-effects";
const VIDEO_EFFECTS_STORAGE_KEY = "conclave:video-effects";

const isMeetVideoDebugEnabled = () => {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(DEBUG_VIDEO_EFFECTS_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
};

const readStoredVideoEffects = (): VideoEffectsState => {
  if (typeof window === "undefined") return DEFAULT_VIDEO_EFFECTS;
  try {
    const storedValue = window.localStorage.getItem(VIDEO_EFFECTS_STORAGE_KEY);
    if (!storedValue) return DEFAULT_VIDEO_EFFECTS;
    return normalizeVideoEffectsState(JSON.parse(storedValue));
  } catch {
    return DEFAULT_VIDEO_EFFECTS;
  }
};

const writeStoredVideoEffects = (effects: VideoEffectsState) => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      VIDEO_EFFECTS_STORAGE_KEY,
      JSON.stringify(normalizeVideoEffectsStateForStorage(effects)),
    );
  } catch {}
};

const areVideoEffectsEqual = (
  left: VideoEffectsState,
  right: VideoEffectsState,
) => JSON.stringify(left) === JSON.stringify(right);

const getMeetVideoEffectsDebugSnapshot = (effects: VideoEffectsState) => {
  const normalized = normalizeVideoEffectsState(effects);
  const dataUrlBytes = normalized.customBackgroundDataUrl?.length ?? 0;

  return {
    ...normalized,
    customBackgroundDataUrl: dataUrlBytes > 0 ? "[redacted]" : null,
    customBackgroundDataUrlBytes: dataUrlBytes,
  };
};

const hasLiveVideoTrack = (stream: MediaStream | null | undefined) =>
  Boolean(stream?.getVideoTracks().some((track) => track.readyState === "live"));

const getMeetTrackDebugSnapshot = (track: MediaStreamTrack | null) => {
  if (!track) return null;
  let settings: MediaTrackSettings = {};
  try {
    settings = track.getSettings();
  } catch {
    settings = {};
  }
  return {
    id: track.id,
    kind: track.kind,
    label: track.label,
    enabled: track.enabled,
    muted: track.muted,
    readyState: track.readyState,
    settings,
  };
};

const getDebugTrackId = (track: unknown) => {
  if (typeof track !== "object" || track === null) return null;
  const id = (track as { id?: unknown }).id;
  return typeof id === "string" ? id : null;
};

const getVideoEffectsDebugTrackId = (
  debugStats: Record<string, unknown> | null | undefined,
  key: "outputTrack" | "sourceTrack",
) => getDebugTrackId(debugStats?.[key]);

const getVideoEffectsChainedSourceTrackId = (
  debugStats: Record<string, unknown> | null | undefined,
  rawTrackId: string | null,
) => {
  if (!rawTrackId) return null;
  const sourceTrackId = getVideoEffectsDebugTrackId(debugStats, "sourceTrack");
  if (!sourceTrackId) return null;
  const meetVideoPipe = debugStats?.meetVideoPipe;
  if (typeof meetVideoPipe !== "object" || meetVideoPipe === null) {
    return null;
  }
  const gate = (meetVideoPipe as { gate?: unknown }).gate;
  if (typeof gate !== "object" || gate === null) return null;
  const gateRecord = gate as {
    active?: unknown;
    rawTrack?: unknown;
  };
  const gateRawTrackId = getDebugTrackId(gateRecord.rawTrack);
  if (gateRecord.active === true && gateRawTrackId === rawTrackId) {
    return sourceTrackId;
  }
  return null;
};

const getVideoEffectsDebugOutputPublished = (
  debugStats: Record<string, unknown> | null | undefined,
) => {
  if (debugStats?.outputTrackPublished === true) return true;
  const framePipeline = debugStats?.framePipeline;
  if (typeof framePipeline !== "object" || framePipeline === null) {
    return false;
  }
  return (
    (framePipeline as { outputTrackPublished?: unknown })
      .outputTrackPublished === true
  );
};

const getMeetStreamDebugSnapshot = (stream: MediaStream | null) => {
  if (!stream) return null;
  return {
    id: stream.id,
    active: stream.active,
    audioTracks: stream.getAudioTracks().map(getMeetTrackDebugSnapshot),
    videoTracks: stream.getVideoTracks().map(getMeetTrackDebugSnapshot),
  };
};

const serializeMeetVideoDebugPayload = (payload: unknown) => {
  if (typeof payload === "string") return payload;
  try {
    return JSON.stringify(payload);
  } catch {
    return String(payload);
  }
};

const logMeetVideo = (event: string, payload?: unknown) => {
  if (!isMeetVideoDebugEnabled()) return;
  if (payload === undefined) {
    console.debug(`[Meets video] ${event}`);
    return;
  }
  console.debug(`[Meets video] ${event}`, serializeMeetVideoDebugPayload(payload));
};

const warnMeetVideo = (event: string, payload?: unknown) => {
  if (!isMeetVideoDebugEnabled()) return;
  if (payload === undefined) {
    console.warn(`[Meets video] ${event}`);
    return;
  }
  console.warn(`[Meets video] ${event}`, serializeMeetVideoDebugPayload(payload));
};

const isGuestUser = (
  candidate?: MeetUser | null,
): candidate is MeetUser & { id: string } =>
  Boolean(candidate?.id?.startsWith("guest-"));

const isGeneratedGuestDisplayName = (value?: string | null): boolean =>
  Boolean(value?.trim().match(/^Guest\s+\d/i));

const parseGuestUser = (raw: string | null): MeetUser | null => {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id : undefined;
    if (!id || !id.startsWith("guest-")) {
      return null;
    }
    const email =
      typeof record.email === "string"
        ? record.email
        : record.email === null
          ? null
          : undefined;
    const name =
      typeof record.name === "string"
        ? record.name
        : record.name === null
          ? null
          : undefined;
    if (isGeneratedGuestDisplayName(name)) {
      return null;
    }
    return { id, email, name };
  } catch {
    return null;
  }
};

const normalizeSessionUser = (user: {
  id?: string;
  email?: string | null;
  name?: string | null;
}): MeetUser | undefined => {
  if (!user.id) return undefined;
  const email = user.email || null;
  return {
    id: user.id,
    email,
    name: sanitizeInstitutionDisplayName(
      user.name || user.email || "User",
      email,
    ),
  };
};

export type MeetsClientProps = {
  initialRoomId?: string;
  enableRoomRouting?: boolean;
  forceJoinOnly?: boolean;
  bypassMediaPermissions?: boolean;
  user?: {
    id?: string;
    email?: string | null;
    name?: string | null;
  };
  isAdmin?: boolean;
  getJoinInfo: (
    roomId: string,
    sessionId: string,
    options?: {
      user?: { id?: string; email?: string | null; name?: string | null };
      isHost?: boolean;
      joinMode?: JoinMode;
    },
  ) => Promise<{
    token: string;
    sfuUrl: string;
    iceServers?: RTCIceServer[];
  }>;
  joinMode?: JoinMode;
  autoJoinOnMount?: boolean;
  hideJoinUI?: boolean;
  getRooms?: () => Promise<RoomInfo[]>;
  getRoom?: (roomId: string) => Promise<RoomInfo | null>;
  reactionAssets?: string[];
};

export default function MeetsClient({
  initialRoomId,
  enableRoomRouting = false,
  forceJoinOnly = false,
  bypassMediaPermissions = false,
  user,
  isAdmin = false,
  getJoinInfo,
  joinMode = "meeting",
  autoJoinOnMount = false,
  hideJoinUI = false,
  getRooms,
  getRoom,
  reactionAssets,
}: MeetsClientProps) {
  const { data: authSession, isPending: isAuthSessionPending } = useSession();
  const authSessionUser = authSession?.user;
  const [currentUser, setCurrentUser] = useState<MeetUser | undefined>(user);
  const [currentIsAdmin, setCurrentIsAdmin] = useState(isAdmin);
  const [pendingNewMeetingRoomId, setPendingNewMeetingRoomId] =
    useState<string | null>(null);
  const [meetingEndedNotice, setMeetingEndedNotice] = useState<string | null>(
    null,
  );
  const [guestStorageReady, setGuestStorageReady] = useState(false);
  const [appsSocket, setAppsSocket] = useState<Socket | null>(null);
  const [viewSettings, setViewSettings] = useState<MeetViewSettings>(
    readStoredMeetViewSettings,
  );
  const [browserSaveDataMode, setBrowserSaveDataMode] = useState(
    () => getBrowserNetworkSnapshot().saveData === true,
  );
  const effectiveDataSaverMode =
    viewSettings.dataSaverMode || browserSaveDataMode;
  useEffect(() => {
    writeStoredMeetViewSettings(viewSettings);
  }, [viewSettings]);

  useEffect(() => {
    const syncBrowserSaveDataMode = () => {
      setBrowserSaveDataMode(getBrowserNetworkSnapshot().saveData === true);
    };
    const connection = getBrowserNetworkInformation();

    syncBrowserSaveDataMode();
    connection?.addEventListener?.("change", syncBrowserSaveDataMode);
    return () => {
      connection?.removeEventListener?.("change", syncBrowserSaveDataMode);
    };
  }, []);

  useEffect(() => {
    if (guestStorageReady || typeof window === "undefined") return;
    if (isAuthSessionPending) return;
    if (!user && !authSessionUser?.id) {
      const storedGuestRaw = window.localStorage.getItem(GUEST_USER_STORAGE_KEY);
      const storedGuest = parseGuestUser(storedGuestRaw);
      if (storedGuest) {
        setCurrentUser(storedGuest);
      } else if (storedGuestRaw) {
        window.localStorage.removeItem(GUEST_USER_STORAGE_KEY);
      }
    }
    setGuestStorageReady(true);
  }, [authSessionUser?.id, guestStorageReady, isAuthSessionPending, user]);

  useEffect(() => {
    if (!guestStorageReady || typeof window === "undefined") return;
    if (isGuestUser(currentUser)) {
      window.localStorage.setItem(
        GUEST_USER_STORAGE_KEY,
        JSON.stringify(currentUser),
      );
      return;
    }
    window.localStorage.removeItem(GUEST_USER_STORAGE_KEY);
  }, [currentUser, guestStorageReady]);

  const clearGuestStorage = useCallback(() => {
    if (typeof window === "undefined") return;
    window.localStorage.removeItem(GUEST_USER_STORAGE_KEY);
  }, []);

  useEffect(() => {
    if (!user?.id) return;
    const nextUser = normalizeSessionUser(user);
    if (!nextUser) return;
    clearGuestStorage();
    setCurrentUser((current) => {
      if (
        current?.id === nextUser.id &&
        current?.email === nextUser.email &&
        current?.name === nextUser.name
      ) {
        return current;
      }
      return nextUser;
    });
    setCurrentIsAdmin(isAdmin);
  }, [clearGuestStorage, isAdmin, user]);

  useEffect(() => {
    const nextUser = authSessionUser
      ? normalizeSessionUser(authSessionUser)
      : undefined;
    if (!nextUser) return;
    clearGuestStorage();
    setCurrentUser((current) => {
      if (
        current?.id === nextUser.id &&
        current?.email === nextUser.email &&
        current?.name === nextUser.name
      ) {
        return current;
      }
      return nextUser;
    });
    setCurrentIsAdmin(isAdmin);
  }, [
    authSessionUser?.email,
    authSessionUser?.id,
    authSessionUser?.name,
    clearGuestStorage,
    isAdmin,
  ]);

  const prewarm = usePrewarmSocket();

  const refs = useMeetRefs();
  const connectionQualityDebugRef = useRef<ConnectionQualityStats | null>(null);
  const networkManagedVideoQualityRef = useRef(false);
  const adaptivePublishDebugRef =
    useRef<AdaptivePublishQualityDebugSnapshot | null>(null);
  const adaptiveConsumerDebugRef =
    useRef<AdaptiveConsumerPreferencesDebugSnapshot | null>(null);
  const {
    connectionState,
    setConnectionState,
    roomId,
    setRoomId,
    isMuted,
    setIsMuted,
    isCameraOff,
    setIsCameraOff,
    isScreenSharing,
    setIsScreenSharing,
    isHandRaised,
    setIsHandRaised,
    activeScreenShareId,
    setActiveScreenShareId,
    participants,
    dispatchParticipants,
    localStream,
    setLocalStream,
    activeSpeakerId,
    setActiveSpeakerId,
    meetError,
    setMeetError,
    waitingMessage,
    setWaitingMessage,
    pendingUsers,
    setPendingUsers,
    isParticipantsOpen,
    setIsParticipantsOpen,
    isRoomLocked,
    setIsRoomLocked,
    isNoGuests,
    setIsNoGuests,
    isChatLocked,
    setIsChatLocked,
    isTtsDisabled,
    setIsTtsDisabled,
    isDmEnabled,
    setIsDmEnabled,
    isReactionsDisabled,
    setIsReactionsDisabled,
    isBrowserAudioMuted,
    setIsBrowserAudioMuted,
    meetVolume,
    setMeetVolume,
    hostUserId,
    setHostUserId,
    hostUserIds,
    setHostUserIds,
    isNetworkOffline,
    setIsNetworkOffline,
    meetingRequiresInviteCode,
    setMeetingRequiresInviteCode,
    webinarConfig,
    setWebinarConfig,
    webinarRole,
    setWebinarRole,
    webinarLink,
    setWebinarLink,
    webinarSpeakerUserId,
    setWebinarSpeakerUserId,
    serverRestartNotice,
    setServerRestartNotice,
    adminNotice,
    setAdminNotice,
  } = useMeetState({ initialRoomId });

  const [serverActiveSpeakerAvailable, setServerActiveSpeakerAvailable] =
    useState(false);
  const handleVideoAdaptivePauseStateChange = useCallback(
    (change: AdaptiveConsumerVideoPauseStateChange) => {
      dispatchParticipants({
        type: "UPDATE_VIDEO_ADAPTIVE_PAUSED",
        userId: change.userId,
        producerId: change.producerId,
        adaptivelyPaused: change.adaptivelyPaused,
      });
    },
    [dispatchParticipants],
  );
  const [videoEffects, setVideoEffects] =
    useState<VideoEffectsState>(readStoredVideoEffects);
  const [framingRecenterToken, setFramingRecenterToken] = useState(0);
  const [devCameraStream, setDevCameraStream] = useState<MediaStream | null>(
    null,
  );
  const [isDocumentVisible, setIsDocumentVisible] = useState(
    () =>
      typeof document === "undefined" ||
      document.visibilityState === "visible",
  );
  const activeVideoEffectsCount = useMemo(
    () => countActiveVideoEffects(videoEffects),
    [videoEffects],
  );
  const shouldDeferVideoEffectsPreload =
    useBandwidthHeavyPreloadDeferred();
  const shouldRunVisualVideoEffects = activeVideoEffectsCount > 0;
  const [videoEffectsBridgeState, setVideoEffectsBridgeState] =
    useState<VideoEffectsBridgeState>(VIDEO_EFFECTS_OFF_STATE);
  const handleVideoEffectsBridgeStateChange = useCallback(
    (state: VideoEffectsBridgeState) => {
      setVideoEffectsBridgeState(state);
    },
    [],
  );
  const getVideoPublishTrackRef = useRef<
    ((stream?: MediaStream | null) => MediaStreamTrack | null) | null
  >(null);
  const suppressedProcessedPublishTrackRef = useRef<{
    trackId: string;
    processedTrackVersion: number;
    reason: string;
  } | null>(null);
  const publishTrackSwitchRef = useRef<{
    sequence: number;
    promise: Promise<void>;
  }>({
    sequence: 0,
    promise: Promise.resolve(),
  });
  const restoredVideoEffectsPrewarmDoneRef = useRef(false);
  const cameraLiveEffectsPrewarmDoneRef = useRef(false);

  useEffect(() => {
    const syncDocumentVisibility = () => {
      setIsDocumentVisible(document.visibilityState === "visible");
    };
    syncDocumentVisibility();
    document.addEventListener("visibilitychange", syncDocumentVisibility);
    window.addEventListener("pageshow", syncDocumentVisibility);
    return () => {
      document.removeEventListener("visibilitychange", syncDocumentVisibility);
      window.removeEventListener("pageshow", syncDocumentVisibility);
    };
  }, []);

  useEffect(() => {
    const normalized = normalizeVideoEffectsState(videoEffects);
    if (areVideoEffectsEqual(videoEffects, normalized)) return;
    setVideoEffects(normalized);
  }, [videoEffects]);

  useEffect(() => {
    let cancelled = false;
    let timeoutId: number | null = null;
    let idleId: number | null = null;
    const run = () => {
      if (cancelled) return;
      if (activeVideoEffectsCount <= 0) return;
      if (!isDocumentVisible) return;
      if (shouldDeferVideoEffectsPreload) return;
      void prewarmVideoEffectsRuntimeDeferred({
        reason: "meet-shell-runtime",
        outputWriter: true,
      });
    };
    const idleWindow = window as Window & {
      requestIdleCallback?: (
        callback: IdleRequestCallback,
        options?: IdleRequestOptions,
      ) => number;
      cancelIdleCallback?: (handle: number) => void;
    };
    if (typeof idleWindow.requestIdleCallback === "function") {
      idleId = idleWindow.requestIdleCallback(run, { timeout: 1800 });
    } else {
      timeoutId = window.setTimeout(run, 300);
    }
    return () => {
      cancelled = true;
      if (
        idleId !== null &&
        typeof idleWindow.cancelIdleCallback === "function"
      ) {
        idleWindow.cancelIdleCallback(idleId);
      }
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [
    activeVideoEffectsCount,
    isDocumentVisible,
    shouldDeferVideoEffectsPreload,
  ]);

  useEffect(() => {
    writeStoredVideoEffects(videoEffects);
  }, [videoEffects]);

  useEffect(() => {
    if (
      videoEffects.background !== "custom" ||
      !videoEffects.customBackgroundId ||
      videoEffects.customBackgroundDataUrl
    ) {
      return;
    }

    let cancelled = false;
    const customBackgroundId = videoEffects.customBackgroundId;
    void getCustomVideoBackground(customBackgroundId)
      .then((background) => {
        if (cancelled) return;
        setVideoEffects((current) => {
          if (
            current.background !== "custom" ||
            current.customBackgroundId !== customBackgroundId ||
            current.customBackgroundDataUrl
          ) {
            return current;
          }
          if (!background) {
            return {
              ...current,
              background: DEFAULT_VIDEO_EFFECTS.background,
              customBackgroundId: DEFAULT_VIDEO_EFFECTS.customBackgroundId,
              customBackgroundDataUrl:
                DEFAULT_VIDEO_EFFECTS.customBackgroundDataUrl,
              customBackgroundName: DEFAULT_VIDEO_EFFECTS.customBackgroundName,
            };
          }
          return {
            ...current,
            customBackgroundDataUrl: background.dataUrl,
            customBackgroundName: background.name,
          };
        });
      })
      .catch(() => {
        if (cancelled) return;
        setVideoEffects((current) =>
          current.background === "custom" &&
          current.customBackgroundId === customBackgroundId &&
          !current.customBackgroundDataUrl
            ? {
                ...current,
                background: DEFAULT_VIDEO_EFFECTS.background,
                customBackgroundId: DEFAULT_VIDEO_EFFECTS.customBackgroundId,
                customBackgroundDataUrl:
                  DEFAULT_VIDEO_EFFECTS.customBackgroundDataUrl,
                customBackgroundName: DEFAULT_VIDEO_EFFECTS.customBackgroundName,
              }
            : current,
        );
      });

    return () => {
      cancelled = true;
    };
  }, [
    videoEffects.background,
    videoEffects.customBackgroundDataUrl,
    videoEffects.customBackgroundId,
  ]);

  useEffect(() => {
    if (!hasActiveVideoEffects(videoEffects)) {
      restoredVideoEffectsPrewarmDoneRef.current = false;
      return;
    }
    if (restoredVideoEffectsPrewarmDoneRef.current) return;
    if (!isDocumentVisible) return;
    if (shouldDeferVideoEffectsPreload) return;
    restoredVideoEffectsPrewarmDoneRef.current = true;
    const backgroundNeedsSegmentation =
      videoEffects.background !== "none" &&
      (videoEffects.background !== "custom" ||
        Boolean(videoEffects.customBackgroundDataUrl));
    const backgrounds: BackgroundEffectId[] =
      backgroundNeedsSegmentation &&
      videoEffects.background !== "blur-light" &&
      videoEffects.background !== "blur-strong" &&
      videoEffects.background !== "custom"
        ? [videoEffects.background]
        : [];
    void prewarmVideoEffectsAssetsDeferred({
      segmentation: backgroundNeedsSegmentation,
      face: videoEffects.filter !== "none" || videoEffects.framing,
      faceFilter:
        videoEffects.filter !== "none" ? videoEffects.filter : undefined,
      backgrounds,
      reason: "restored-effects-state",
    });
  }, [isDocumentVisible, shouldDeferVideoEffectsPreload, videoEffects]);

  useEffect(() => {
    if (cameraLiveEffectsPrewarmDoneRef.current) return;
    if (activeVideoEffectsCount <= 0) return;
    if (isCameraOff || !hasLiveVideoTrack(localStream)) return;
    if (!isDocumentVisible) return;
    if (shouldDeferVideoEffectsPreload) return;

    cameraLiveEffectsPrewarmDoneRef.current = true;
    void prewarmVideoEffectsAssetsDeferred({
      segmentation: true,
      face: true,
      reason: "camera-live",
    });
  }, [
    activeVideoEffectsCount,
    isDocumentVisible,
    isCameraOff,
    localStream,
    shouldDeferVideoEffectsPreload,
  ]);

  const [browserAudioNeedsGesture, setBrowserAudioNeedsGesture] =
    useState(false);
  const [browserAudioPlaybackAttempt, setBrowserAudioPlaybackAttempt] =
    useState(0);
  const [isBrowserServiceAvailable, setIsBrowserServiceAvailable] =
    useState(false);
  const [isVoiceAgentDialogOpen, setIsVoiceAgentDialogOpen] = useState(false);
  const toggleMuteCommandRef = useRef<(() => void | Promise<void>) | null>(null);
  const toggleCameraCommandRef = useRef<(() => void | Promise<void>) | null>(
    null,
  );
  const ensureProducerTransportRef = useRef<(() => Promise<boolean>) | null>(
    null,
  );
  const setHandRaisedCommandRef = useRef<((raised: boolean) => void) | null>(
    null,
  );
  const leaveRoomCommandRef = useRef<(() => void) | null>(null);

  const handleToggleMuteCommand = useCallback(() => {
    void toggleMuteCommandRef.current?.();
  }, []);

  useHotkey(
    HOTKEYS.toggleMute.keys as RegisterableHotkey,
    handleToggleMuteCommand,
    {
      enabled: connectionState === "joined",
      requireReset: true,
      ignoreInputs: true,
    },
  );

  const handleToggleCameraCommand = useCallback(() => {
    void toggleCameraCommandRef.current?.();
  }, []);

  const handleSetHandRaisedCommand = useCallback((raised: boolean) => {
    setHandRaisedCommandRef.current?.(raised);
  }, []);

  const handleLeaveCommand = useCallback(() => {
    leaveRoomCommandRef.current?.();
  }, []);

  useEffect(() => {
    if (!enableRoomRouting && !forceJoinOnly) return;
    if (roomId.trim().length > 0) return;
    if (typeof window === "undefined") return;
    const path = window.location.pathname.replace(/^\/+/, "");
    if (!path) return;
    const decoded = decodeURIComponent(path);
    if (!decoded || decoded === "undefined" || decoded === "null") return;
    const sanitized = sanitizeRoomCode(decoded);
    if (!sanitized) return;
    setRoomId(sanitized);
  }, [enableRoomRouting, forceJoinOnly, roomId, setRoomId]);

  useEffect(() => {
    if (!autoJoinOnMount) return;
    if (!roomId || roomId.trim().length === 0) return;
    if (!refs.prejoinMediaIntentRef.current) {
      const autoJoinStream = refs.localStreamRef.current;
      refs.prejoinMediaIntentRef.current = {
        streamId: autoJoinStream?.id ?? null,
        trackIds: new Set(
          autoJoinStream?.getTracks().map((track) => track.id) ?? [],
        ),
        isCameraOn: false,
        isMicOn: false,
      };
    }
    refs.shouldAutoJoinRef.current = true;
  }, [
    autoJoinOnMount,
    roomId,
    refs.localStreamRef,
    refs.prejoinMediaIntentRef,
    refs.shouldAutoJoinRef,
  ]);

  const {
    setNetworkManagedVideoQuality,
    isMirrorCamera,
    setIsMirrorCamera,
    selectedAudioInputDeviceId,
    setSelectedAudioInputDeviceId,
    selectedAudioOutputDeviceId,
    setSelectedAudioOutputDeviceId,
    selectedVideoInputDeviceId,
    setSelectedVideoInputDeviceId,
    isNoiseCancellationEnabled,
    setIsNoiseCancellationEnabled,
  } = useMeetMediaSettings({
    videoQualityRef: refs.videoQualityRef,
    networkManagedVideoQualityRef,
    allowNetworkAutoDowngrade:
      connectionState === "disconnected" || connectionState === "waiting",
  });

  // Local-only camera preview for the Settings/effects panels: acquired with a
  // plain getUserMedia and never attached to a producer, so nothing reaches
  // the room while the real camera stays off.
  const cameraPreview = useLocalCameraPreview({
    deviceId: selectedVideoInputDeviceId,
  });
  const stopCameraPreview = cameraPreview.stop;
  const localStreamHasLiveVideo = hasLiveVideoTrack(localStream);
  useEffect(() => {
    // The real camera taking over makes the private preview redundant (and
    // would hold a second capture of the same device) — release it.
    if (localStreamHasLiveVideo) stopCameraPreview();
  }, [localStreamHasLiveVideo, stopCameraPreview]);

  const isAdminFlag = Boolean(currentIsAdmin);
  const isWebinarAttendee =
    joinMode === "webinar_attendee" || webinarRole === "attendee";
  const isReadOnlyObserver = isWebinarAttendee;
  const canModerateMeeting = isAdminFlag && !isReadOnlyObserver;
  const shouldRunVideoEffects = shouldRunVisualVideoEffects;
  const shouldPublishProcessedVideo = shouldRunVisualVideoEffects;
  const normalizedCurrentUserName =
    typeof currentUser?.name === "string"
      ? sanitizeInstitutionDisplayName(currentUser.name, currentUser.email)
      : currentUser?.name;

  const sessionId = refs.sessionIdRef.current;
  const userEmail =
    normalizedCurrentUserName ||
    currentUser?.email ||
    currentUser?.id ||
    "You";
  const isGuestIdentity = !currentUser || isGuestUser(currentUser);
  const userKey = isGuestIdentity
    ? `guest-${sessionId}`
    : currentUser.email || currentUser.id || `guest-${sessionId}`;
  const userId = `${userKey}#${sessionId}`;

  useEffect(() => {
    if (typeof window === "undefined") return;

    const updateOfflineState = () => {
      setIsNetworkOffline(!window.navigator.onLine);
    };

    updateOfflineState();
    window.addEventListener("offline", updateOfflineState);
    window.addEventListener("online", updateOfflineState);

    return () => {
      window.removeEventListener("offline", updateOfflineState);
      window.removeEventListener("online", updateOfflineState);
    };
  }, [setIsNetworkOffline]);

  const {
    setDisplayNames,
    displayNameInput,
    setDisplayNameInput,
    resolveDisplayName,
  } = useMeetDisplayName({
    user: currentUser,
    userId,
    isAdmin: isAdminFlag,
    socketRef: refs.socketRef,
    joinOptionsRef: refs.joinOptionsRef,
  });
  const appsUser = useMemo(
    () => ({
      id: userId,
      name:
        displayNameInput ||
        normalizedCurrentUserName ||
        currentUser?.email ||
        currentUser?.id ||
        "You",
      email: currentUser?.email ?? null,
    }),
    [userId, displayNameInput, normalizedCurrentUserName, currentUser],
  );

  const { availableRooms, roomsStatus, refreshRooms } = useMeetRooms({
    isAdmin: isAdminFlag,
    getRooms,
    getRoom,
  });

  const {
    reactionStore,
    reactionOptions,
    addReaction,
    sendReaction,
    clearReactions,
  } = useMeetReactions({
    userId,
    socketRef: refs.socketRef,
    isObserverMode: isWebinarAttendee,
    reactionAssets,
  });

  const {
    ttsSpeakerId,
    handleTtsMessage,
    availableSystemVoices,
    selectedSystemVoiceUri,
    setSelectedSystemVoiceUri,
    clonedVoice,
    saveClonedVoice,
    clearClonedVoice,
    outgoingTtsVoiceToken,
  } = useMeetTts({
    meetVolume,
    audioOutputDeviceId: selectedAudioOutputDeviceId,
  });
  const effectiveActiveSpeakerId = ttsSpeakerId ?? activeSpeakerId;

  // Latest transcript snapshot for the "@Conclave" assistant. Updated from the
  // transcript hook below; read lazily so useMeetChat stays decoupled from it.
  const assistantContextRef = useRef<ConclaveAssistantContext>({
    transcript: "",
    transcriptActive: false,
  });
  const getAssistantContextRef = useRef(() => assistantContextRef.current);

  const {
    chatMessages,
    setChatMessages,
    chatOverlayMessages,
    setChatOverlayMessages,
    isChatOpen,
    unreadCount,
    setUnreadCount,
    chatInput,
    setChatInput,
    toggleChat,
    sendChat,
    sendChatGif,
    isChatOpenRef,
    replyTarget,
    startReply,
    cancelReply,
    assistantApiKeyPrompt,
    submitAssistantApiKey,
    cancelAssistantApiKeyPrompt,
    resolveAssistantToolApproval,
  } = useMeetChat({
    socketRef: refs.socketRef,
    currentUserId: userId,
    currentUserDisplayName:
      displayNameInput ||
      normalizedCurrentUserName ||
      currentUser?.email ||
      currentUser?.id ||
      "You",
    isObserverMode: isWebinarAttendee,
    isChatLocked,
    isAdmin: isAdminFlag,
    isDmEnabled,
    isMuted,
    isCameraOff,
    onToggleMute: handleToggleMuteCommand,
    onToggleCamera: handleToggleCameraCommand,
    onSetHandRaised: handleSetHandRaisedCommand,
    onLeaveRoom: handleLeaveCommand,
    onTtsMessage: handleTtsMessage,
    outgoingTtsVoiceToken,
    isTtsDisabled,
    getAssistantContext: getAssistantContextRef.current,
  });

  const handlePreferredVideoPublishTrackRejected = useCallback(
    (track: MediaStreamTrack, reason: string) => {
      const processedTrack = refs.processedVideoTrackRef.current;
      if (!processedTrack || processedTrack.id !== track.id) return;

      suppressedProcessedPublishTrackRef.current = {
        trackId: track.id,
        processedTrackVersion: videoEffectsBridgeState.processedTrackVersion,
        reason,
      };
      warnMeetVideo("suppress_processed_publish_track_after_raw_repair", {
        reason,
        processedTrack: getMeetTrackDebugSnapshot(processedTrack),
        processedTrackVersion: videoEffectsBridgeState.processedTrackVersion,
      });
    },
    [
      refs.processedVideoTrackRef,
      videoEffectsBridgeState.processedTrackVersion,
    ],
  );

  const {
    showPermissionHint,
    screenShareControlState,
    requestMediaPermissions,
    handleAudioInputDeviceChange,
    handleVideoInputDeviceChange,
    handleAudioOutputDeviceChange,
    updateVideoQualityRef,
    requestAudioProducerRecovery,
    requestCameraProducerRecovery,
    prepareAudioPublishTrack,
    toggleMute,
    isMuteTogglePending,
    toggleCamera,
    toggleScreenShare,
    stopLocalTrack,
    handleLocalTrackEnded,
    playNotificationSound,
    primeAudioOutput,
    refreshScreenAudioProducerForNetworkProfile,
  } = useMeetMedia({
    isObserverMode: isWebinarAttendee,
    connectionState,
    isMuted,
    setIsMuted,
    isCameraOff,
    setIsCameraOff,
    isScreenSharing,
    setIsScreenSharing,
    activeScreenShareId,
    setActiveScreenShareId,
    localStream,
    setLocalStream,
    setMeetError,
    selectedAudioInputDeviceId,
    setSelectedAudioInputDeviceId,
    setSelectedAudioOutputDeviceId,
    selectedVideoInputDeviceId,
    setSelectedVideoInputDeviceId,
    isNoiseCancellationEnabled,
    meetVolume,
    videoQualityRef: refs.videoQualityRef,
    dataSaverMode: effectiveDataSaverMode,
    activeVideoEffectsCount,
    shouldUsePreferredVideoPublishTrack: shouldPublishProcessedVideo,
    getVideoPublishTrackRef,
    onPreferredVideoPublishTrackRejected:
      handlePreferredVideoPublishTrackRejected,
    socketRef: refs.socketRef,
    deviceRef: refs.deviceRef,
    producerTransportRef: refs.producerTransportRef,
    ensureProducerTransportRef,
    audioProducerRef: refs.audioProducerRef,
    videoProducerRef: refs.videoProducerRef,
    screenProducerRef: refs.screenProducerRef,
    screenAudioProducerRef: refs.screenAudioProducerRef,
    screenShareStreamRef: refs.screenShareStreamRef,
    screenShareCaptureControllerRef: refs.screenShareCaptureControllerRef,
    intentionalLocalProducerCloseIdsRef:
      refs.intentionalLocalProducerCloseIdsRef,
    localStreamRef: refs.localStreamRef,
    connectionQualityRef: connectionQualityDebugRef,
    intentionalTrackStopsRef: refs.intentionalTrackStopsRef,
    permissionHintTimeoutRef: refs.permissionHintTimeoutRef,
    audioContextRef: refs.audioContextRef,
    mediaRecoveryBlockedRef: refs.reconnectInFlightRef,
  });

  // Record the picked camera so the dropdown reflects the selection, then run
  // the media swap. Mirrors how the audio-input handler tracks its selected id.
  const handleVideoInputDeviceSelect = useCallback(
    (deviceId: string) => {
      setSelectedVideoInputDeviceId(deviceId);
      void handleVideoInputDeviceChange(deviceId);
    },
    [setSelectedVideoInputDeviceId, handleVideoInputDeviceChange]
  );

  const participantCount = useMemo(() => {
    let count = 1;
    participants.forEach((participant) => {
      if (
        participant.userId !== userId &&
        !isSystemUserId(participant.userId)
      ) {
        count += 1;
      }
    });
    return count;
  }, [participants, userId]);

  const participantCountRef = useRef(participantCount);
  useEffect(() => {
    participantCountRef.current = participantCount;
  }, [participantCount]);

  const shouldPlayJoinLeaveSound = useCallback(
    (type: "join" | "leave") => {
      const currentCount = participantCountRef.current ?? 1;
      const projectedCount = type === "join" ? currentCount + 1 : currentCount;
      return projectedCount < 30;
    },
    []
  );

  const playNotificationSoundForEvents = useCallback(
    (type: "join" | "leave" | "waiting" | "handRaise") => {
      if ((type === "join" || type === "leave") && !shouldPlayJoinLeaveSound(type)) {
        return;
      }
      playNotificationSound(type);
    },
    [playNotificationSound, shouldPlayJoinLeaveSound]
  );

  useEffect(() => {
    toggleMuteCommandRef.current = toggleMute;
  }, [toggleMute]);

  useEffect(() => {
    toggleCameraCommandRef.current = toggleCamera;
  }, [toggleCamera]);

  const handleRetryMedia = useCallback(async () => {
    const stream = await requestMediaPermissions();
    if (!stream) return;
    const refreshedTrackIds = new Set(
      stream.getTracks().map((track) => track.id),
    );
    localStream?.getTracks().forEach((track) => {
      if (!refreshedTrackIds.has(track.id)) {
        stopLocalTrack(track);
      }
    });
    setLocalStream(stream);
    setMeetError(null);
  }, [
    localStream,
    requestMediaPermissions,
    setLocalStream,
    setMeetError,
    stopLocalTrack,
  ]);

  const handlePrejoinMediaCommit = useCallback(
    (handoff: PrejoinMediaHandoff) => {
      const liveTracks =
        handoff.stream
          ?.getTracks()
          .filter((track) => {
            if (track.readyState !== "live") return false;
            if (track.kind === "video") return handoff.isCameraOn;
            if (track.kind === "audio") return handoff.isMicOn;
            return true;
          }) ?? [];
      const liveTrackIds = new Set(liveTracks.map((track) => track.id));
      const nextStream =
        liveTracks.length > 0 ? new MediaStream(liveTracks) : null;
      const hasLiveAudio = liveTracks.some((track) => track.kind === "audio");
      const hasLiveVideo = liveTracks.some((track) => track.kind === "video");
      const previousStream = refs.localStreamRef.current ?? localStream;

      previousStream?.getTracks().forEach((track) => {
        if (liveTrackIds.has(track.id)) return;
        stopLocalTrack(track);
      });

      refs.localStreamRef.current = nextStream;
      refs.prejoinMediaIntentRef.current = {
        streamId: nextStream?.id ?? null,
        trackIds: liveTrackIds,
        isCameraOn: handoff.isCameraOn && hasLiveVideo,
        isMicOn: handoff.isMicOn && hasLiveAudio,
      };
      setLocalStream(nextStream);
      setIsCameraOff(!(handoff.isCameraOn && hasLiveVideo));
      setIsMuted(!(handoff.isMicOn && hasLiveAudio));
      setMeetError(null);
      logMeetVideo("adopt_prejoin_media", {
        handoff: {
          stream: getMeetStreamDebugSnapshot(handoff.stream),
          isCameraOn: handoff.isCameraOn,
          isMicOn: handoff.isMicOn,
        },
        nextStream: getMeetStreamDebugSnapshot(nextStream),
        previousStream: getMeetStreamDebugSnapshot(previousStream),
      });
    },
    [
      localStream,
      refs.localStreamRef,
      refs.prejoinMediaIntentRef,
      setIsCameraOff,
      setIsMuted,
      setLocalStream,
      setMeetError,
      stopLocalTrack,
    ],
  );

  const videoEffectsSourceStream = hasLiveVideoTrack(localStream)
    ? localStream
    : (devCameraStream ?? cameraPreview.stream);
  const processedLocalStream = shouldRunVideoEffects
    ? videoEffectsBridgeState.effectiveStream
    : null;
  const processedTrackVersion = shouldRunVideoEffects
    ? videoEffectsBridgeState.processedTrackVersion
    : 0;
  const processedTrackReady =
    shouldRunVideoEffects && videoEffectsBridgeState.processedTrackReady;
  const videoEffectsStatus = shouldRunVideoEffects
    ? videoEffectsBridgeState.status
    : "off";
  const videoEffectsError = shouldRunVideoEffects
    ? videoEffectsBridgeState.error
    : null;
  const videoEffectsDebugStats = shouldRunVideoEffects
    ? videoEffectsBridgeState.debugStats
    : null;
  // When the effects pipeline is fed by the private preview (camera off, no
  // dev fixture), its processed output must stay panel-only: it must not
  // become the display stream that the grid / PiP / popout render, or the
  // preview would look like the camera is on.
  const processedSourceIsLocalPreview =
    !hasLiveVideoTrack(localStream) &&
    !devCameraStream &&
    Boolean(cameraPreview.stream);
  // Once the bridge has processed the private preview, its output track (which
  // can survive source switches with the same id) must not be published until
  // the effects debug metadata positively confirms the source is the real
  // camera again. Cleared inside getVideoPublishTrack on that confirmation.
  const requireExplicitProcessedSourceMatchRef = useRef(false);
  useEffect(() => {
    if (processedSourceIsLocalPreview) {
      requireExplicitProcessedSourceMatchRef.current = true;
    }
  }, [processedSourceIsLocalPreview]);
  const displayLocalStream =
    (processedSourceIsLocalPreview ? null : processedLocalStream) ??
    localStream;
  // What the Settings/effects panels render while previewing: the processed
  // output when effects are active, otherwise the raw private preview.
  const cameraPreviewDisplayStream = cameraPreview.stream
    ? ((processedSourceIsLocalPreview ? processedLocalStream : null) ??
      cameraPreview.stream)
    : null;
  const mirrorLocalPreview = isMirrorCamera;
  const getVideoPublishTrack = useCallback(
    (stream?: MediaStream | null) => {
      const rawTrack =
        stream?.getVideoTracks().find((track) => track.readyState === "live") ??
        refs.localStreamRef.current
          ?.getVideoTracks()
          .find((track) => track.readyState === "live") ??
        null;
      const producerTrack = refs.videoProducerRef.current?.track ?? null;
      const processedTrack = refs.processedVideoTrackRef.current;
      const suppressedProcessedPublishTrack =
        suppressedProcessedPublishTrackRef.current;
      const processedTrackSuppressed = Boolean(
        suppressedProcessedPublishTrack &&
          processedTrack &&
          suppressedProcessedPublishTrack.trackId === processedTrack.id &&
          suppressedProcessedPublishTrack.processedTrackVersion ===
            processedTrackVersion,
      );
      if (
        suppressedProcessedPublishTrack &&
        (!processedTrack ||
          suppressedProcessedPublishTrack.trackId !== processedTrack.id ||
          suppressedProcessedPublishTrack.processedTrackVersion !==
            processedTrackVersion)
      ) {
        suppressedProcessedPublishTrackRef.current = null;
      }
      const processedSourceTrackId = getVideoEffectsDebugTrackId(
        videoEffectsDebugStats,
        "sourceTrack",
      );
      const processedOutputTrackId = getVideoEffectsDebugTrackId(
        videoEffectsDebugStats,
        "outputTrack",
      );
      const processedDebugOutputPublished =
        getVideoEffectsDebugOutputPublished(videoEffectsDebugStats);
      const processedChainedSourceTrackId = getVideoEffectsChainedSourceTrackId(
        videoEffectsDebugStats,
        rawTrack?.id ?? null,
      );
      const processedSourceMatchesRawTrack = Boolean(
        processedSourceTrackId &&
          rawTrack &&
          processedSourceTrackId === rawTrack.id,
      );
      const processedSourceMatchesChainedInput = Boolean(
        processedSourceTrackId &&
          processedChainedSourceTrackId &&
          processedSourceTrackId === processedChainedSourceTrackId,
      );
      const processedTrackHasExplicitSourceMismatch = Boolean(
        processedSourceTrackId &&
          rawTrack &&
          !processedSourceMatchesRawTrack &&
          !processedSourceMatchesChainedInput,
      );
      const processedTrackHasExplicitOutputMismatch = Boolean(
        processedOutputTrackId &&
          processedTrack &&
          processedOutputTrackId !== processedTrack.id,
      );
      const processedTrackAlreadyPublished = Boolean(
        producerTrack &&
          processedTrack &&
          producerTrack.id === processedTrack.id &&
          processedTrack.readyState === "live",
      );
      const processedTrackOutputIsWarming = Boolean(
        processedTrackHasExplicitOutputMismatch &&
          !processedDebugOutputPublished &&
          processedTrackAlreadyPublished,
      );
      const processedTrackMatchesCurrentSource = Boolean(
        rawTrack &&
          !processedTrackHasExplicitSourceMismatch &&
          (!processedTrackHasExplicitOutputMismatch ||
            processedTrackOutputIsWarming),
      );
      // Guard against publishing output derived from the PRIVATE camera
      // preview. While the preview feeds the bridge, processed output is
      // blocked outright; after a handoff to the real camera it stays blocked
      // until the debug metadata positively names the real camera track as
      // the source (mere absence of metadata is not proof during a handoff —
      // the retained output track may still be showing preview frames).
      const processedSourceExplicitlyMatches =
        processedSourceMatchesRawTrack || processedSourceMatchesChainedInput;
      if (
        requireExplicitProcessedSourceMatchRef.current &&
        !processedSourceIsLocalPreview &&
        processedSourceExplicitlyMatches
      ) {
        requireExplicitProcessedSourceMatchRef.current = false;
      }
      const processedTrackPublishBlocked = Boolean(
        processedTrack &&
          (processedSourceIsLocalPreview ||
            (requireExplicitProcessedSourceMatchRef.current &&
              !processedSourceExplicitlyMatches)),
      );
      if (processedTrackPublishBlocked && processedTrack) {
        // The bridge output is (or may still be) the private preview. That
        // must never be published: it dies when the panel closes, and it was
        // never meant to leave this machine. Publish raw; the effects bridge
        // re-pipes to the real camera right after it goes live.
        logMeetVideo("skip_processed_track_local_preview_source", {
          processedTrack: getMeetTrackDebugSnapshot(processedTrack),
          rawTrack: getMeetTrackDebugSnapshot(rawTrack),
          processedSourceIsLocalPreview,
          processedSourceExplicitlyMatches,
        });
      } else if (
        shouldPublishProcessedVideo &&
        !processedTrackSuppressed &&
        processedTrackReady &&
        processedTrack &&
        processedTrack.readyState === "live" &&
        processedTrackMatchesCurrentSource
      ) {
        const metadataPending = !processedSourceTrackId || !processedOutputTrackId;
        logMeetVideo(
          metadataPending
            ? "select_publish_track_processed_metadata_pending"
            : "select_publish_track_processed",
          {
            processedTrack: getMeetTrackDebugSnapshot(processedTrack),
            rawStream: getMeetStreamDebugSnapshot(stream ?? null),
            rawTrack: getMeetTrackDebugSnapshot(rawTrack),
            processedSourceTrackId,
            processedOutputTrackId,
            processedDebugOutputPublished,
            processedChainedSourceTrackId,
            processedSourceMatchesChainedInput,
            processedTrackOutputIsWarming,
            suppressedProcessedPublishTrack,
          },
        );
        return processedTrack;
      }
      if (
        shouldPublishProcessedVideo &&
        !processedTrackPublishBlocked &&
        !processedTrackSuppressed &&
        !processedTrackReady &&
        processedTrack &&
        processedTrack.readyState === "live" &&
        processedTrackMatchesCurrentSource &&
        processedTrackAlreadyPublished
      ) {
        logMeetVideo("select_publish_track_processed_transition_hold", {
          processedTrack: getMeetTrackDebugSnapshot(processedTrack),
          producerTrack: getMeetTrackDebugSnapshot(producerTrack),
          rawTrack: getMeetTrackDebugSnapshot(rawTrack),
          processedSourceTrackId,
          processedOutputTrackId,
          processedDebugOutputPublished,
          processedChainedSourceTrackId,
          processedSourceMatchesChainedInput,
          processedTrackOutputIsWarming,
          suppressedProcessedPublishTrack,
        });
        return processedTrack;
      }
      if (processedTrackSuppressed) {
        logMeetVideo("skip_processed_track_suppressed_after_raw_repair", {
          processedTrack: getMeetTrackDebugSnapshot(processedTrack),
          producerTrack: getMeetTrackDebugSnapshot(producerTrack),
          suppressedProcessedPublishTrack,
          processedTrackVersion,
        });
      }
      if (processedTrack && !processedTrackReady) {
        logMeetVideo("skip_processed_track_not_ready", {
          processedTrack: getMeetTrackDebugSnapshot(processedTrack),
          producerTrack: getMeetTrackDebugSnapshot(producerTrack),
        });
      }
      if (
        processedTrackReady &&
        processedTrack?.readyState === "live" &&
        !processedTrackMatchesCurrentSource
      ) {
        logMeetVideo("skip_processed_track_source_mismatch", {
          processedTrack: getMeetTrackDebugSnapshot(processedTrack),
          rawTrack: getMeetTrackDebugSnapshot(rawTrack),
          processedSourceTrackId,
          processedOutputTrackId,
          processedDebugOutputPublished,
          processedChainedSourceTrackId,
          processedSourceMatchesChainedInput,
          processedTrackHasExplicitSourceMismatch,
          processedTrackHasExplicitOutputMismatch,
          processedTrackOutputIsWarming,
        });
      }
      if (processedTrack && processedTrack.readyState !== "live") {
        warnMeetVideo("discard_stale_processed_track", {
          processedTrack: getMeetTrackDebugSnapshot(processedTrack),
        });
        refs.processedVideoTrackRef.current = null;
      }

      logMeetVideo("select_publish_track_raw", {
        processedTrack: getMeetTrackDebugSnapshot(processedTrack),
        rawTrack: getMeetTrackDebugSnapshot(rawTrack),
        rawStream: getMeetStreamDebugSnapshot(stream ?? null),
        localStreamRef: getMeetStreamDebugSnapshot(refs.localStreamRef.current),
        processedDebugOutputPublished,
        processedChainedSourceTrackId,
        processedSourceMatchesChainedInput,
        processedTrackOutputIsWarming,
        suppressedProcessedPublishTrack,
      });
      return rawTrack;
    },
    [
      processedSourceIsLocalPreview,
      processedTrackVersion,
      processedTrackReady,
      refs.localStreamRef,
      refs.processedVideoTrackRef,
      refs.videoProducerRef,
      shouldPublishProcessedVideo,
      suppressedProcessedPublishTrackRef,
      videoEffectsDebugStats,
    ],
  );

  useEffect(() => {
    getVideoPublishTrackRef.current = getVideoPublishTrack;
    return () => {
      if (getVideoPublishTrackRef.current === getVideoPublishTrack) {
        getVideoPublishTrackRef.current = null;
      }
    };
  }, [getVideoPublishTrack]);

  const getRawVideoPublishTrack = useCallback(
    (stream?: MediaStream | null) =>
      stream?.getVideoTracks().find((track) => track.readyState === "live") ??
      refs.localStreamRef.current
        ?.getVideoTracks()
        .find((track) => track.readyState === "live") ??
      null,
    [refs.localStreamRef],
  );

  const buildMeetVideoDebugSnapshot = useCallback(
    (phase = "snapshot") => {
      const producer = refs.videoProducerRef.current;
      const producerTrack = producer?.track ?? null;
      const processedTrack = refs.processedVideoTrackRef.current;
      const rawTrack = getRawVideoPublishTrack(localStream);
      const processedSourceTrackId = getVideoEffectsDebugTrackId(
        videoEffectsDebugStats,
        "sourceTrack",
      );
      const processedOutputTrackId = getVideoEffectsDebugTrackId(
        videoEffectsDebugStats,
        "outputTrack",
      );
      const processedDebugOutputPublished =
        getVideoEffectsDebugOutputPublished(videoEffectsDebugStats);
      const processedChainedSourceTrackId = getVideoEffectsChainedSourceTrackId(
        videoEffectsDebugStats,
        rawTrack?.id ?? null,
      );
      const processedSourceMatchesRawTrack = Boolean(
        processedSourceTrackId &&
          rawTrack &&
          processedSourceTrackId === rawTrack.id,
      );
      const processedSourceMatchesChainedInput = Boolean(
        processedSourceTrackId &&
          processedChainedSourceTrackId &&
          processedSourceTrackId === processedChainedSourceTrackId,
      );
      const processedTrackHasExplicitSourceMismatch = Boolean(
        processedSourceTrackId &&
          rawTrack &&
          !processedSourceMatchesRawTrack &&
          !processedSourceMatchesChainedInput,
      );
      const processedTrackHasExplicitOutputMismatch = Boolean(
        processedOutputTrackId &&
          processedTrack &&
          processedOutputTrackId !== processedTrack.id,
      );
      const processedTrackAlreadyPublished = Boolean(
        producerTrack &&
          processedTrack &&
          producerTrack.id === processedTrack.id &&
          processedTrack.readyState === "live",
      );
      const processedTrackOutputIsWarming = Boolean(
        processedTrackHasExplicitOutputMismatch &&
          !processedDebugOutputPublished &&
          processedTrackAlreadyPublished,
      );
      const processedTrackMatchesCurrentSource = Boolean(
        rawTrack &&
          !processedTrackHasExplicitSourceMismatch &&
          (!processedTrackHasExplicitOutputMismatch ||
            processedTrackOutputIsWarming),
      );
      const shouldPublishProcessed =
        shouldPublishProcessedVideo &&
        processedTrackReady &&
        processedTrack?.readyState === "live" &&
        processedTrackMatchesCurrentSource;
      const usingProcessedTrack = Boolean(
        producerTrack &&
          processedTrack &&
          producerTrack.id === processedTrack.id,
      );
      const usingRawTrack = Boolean(
        producerTrack && rawTrack && producerTrack.id === rawTrack.id,
      );

      return {
        phase,
        timestamp: Date.now(),
        connectionState,
        meetError,
        isCameraOff,
        isMirrorCamera,
        network: connectionQualityDebugRef.current,
        adaptivePublish: adaptivePublishDebugRef.current,
        adaptiveConsumers: adaptiveConsumerDebugRef.current,
        consumerTelemetry: Array.from(
          refs.consumerTelemetryRef.current.values(),
        ),
        isDocumentVisible,
        activeVideoEffectsCount,
        shouldDeferVideoEffectsPreload,
        shouldRunVideoEffects,
        videoEffects: getMeetVideoEffectsDebugSnapshot(videoEffects),
        videoEffectsStatus,
        videoEffectsError,
        videoEffectsDebugStats,
        processedTrackReady,
        processedTrackVersion,
        videoProducer: producer
          ? {
              id: producer.id,
              closed: producer.closed,
              paused: producer.paused,
              kind: producer.kind,
              track: getMeetTrackDebugSnapshot(producerTrack),
            }
          : null,
        publish: {
          shouldPublishProcessed,
          shouldPublishProcessedVideo,
          usingProcessedTrack,
          usingRawTrack,
          processedTrackMatchesCurrentSource,
          processedTrackHasExplicitSourceMismatch,
          processedTrackHasExplicitOutputMismatch,
          processedTrackOutputIsWarming,
          processedChainedSourceTrackId,
          processedSourceMatchesChainedInput,
          processedTrackMetadataPending:
            !processedSourceTrackId || !processedOutputTrackId,
          processedSourceTrackId,
          processedOutputTrackId,
          processedDebugOutputPublished,
          producerTrackLive:
            Boolean(producer) &&
            !producer?.closed &&
            producerTrack?.readyState === "live",
          producerTrackEnabled: producerTrack?.enabled ?? null,
        },
        rawTrack: getMeetTrackDebugSnapshot(rawTrack),
        processedTrack: getMeetTrackDebugSnapshot(processedTrack),
        localStream: getMeetStreamDebugSnapshot(localStream),
        localStreamRef: getMeetStreamDebugSnapshot(refs.localStreamRef.current),
        processedLocalStream: getMeetStreamDebugSnapshot(processedLocalStream),
        displayLocalStream: getMeetStreamDebugSnapshot(displayLocalStream),
      };
    },
    [
      activeVideoEffectsCount,
      adaptiveConsumerDebugRef,
      adaptivePublishDebugRef,
      connectionQualityDebugRef,
      connectionState,
      displayLocalStream,
      getRawVideoPublishTrack,
      isDocumentVisible,
      isCameraOff,
      isMirrorCamera,
      localStream,
      meetError,
      processedLocalStream,
      processedTrackReady,
      processedTrackVersion,
      refs.consumerTelemetryRef,
      refs.localStreamRef,
      refs.processedVideoTrackRef,
      refs.videoProducerRef,
      shouldPublishProcessedVideo,
      shouldRunVideoEffects,
      shouldDeferVideoEffectsPreload,
      videoEffects,
      videoEffectsError,
      videoEffectsDebugStats,
      videoEffectsStatus,
    ],
  );

  const closeLocalVideoProducerForDebug = useCallback(
    async (reason = "debug") => {
      if (!isMeetVideoDebugEnabled()) {
        return { ok: false, error: "debug video effects disabled" };
      }

      const producer = refs.videoProducerRef.current;
      if (!producer || producer.closed) {
        return {
          ok: false,
          error: "local video producer missing or already closed",
          snapshot: buildMeetVideoDebugSnapshot("debug_close_missing"),
        };
      }

      const producerId = producer.id;
      const socket = refs.socketRef.current;
      const closeAck =
        socket?.connected === true
          ? await new Promise<Record<string, unknown>>((resolve) => {
              let settled = false;
              const timeout = window.setTimeout(() => {
                if (settled) return;
                settled = true;
                resolve({ timeout: true });
              }, 5000);
              socket.emit(
                "closeProducer",
                { producerId },
                (response: Record<string, unknown> = {}) => {
                  if (settled) return;
                  settled = true;
                  window.clearTimeout(timeout);
                  resolve(response);
                },
              );
            })
          : { skipped: true, reason: "socket disconnected" };

      try {
        producer.close();
      } catch {}
      if (refs.videoProducerRef.current?.id === producerId) {
        refs.videoProducerRef.current = null;
      }

      const result = {
        ok: true,
        reason,
        producerId,
        closeAck,
        snapshot: buildMeetVideoDebugSnapshot("debug_close_done"),
      };
      logMeetVideo("debug_close_local_video_producer", result);
      return result;
    },
    [
      buildMeetVideoDebugSnapshot,
      refs.socketRef,
      refs.videoProducerRef,
    ],
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    const debugWindow = window as MeetVideoDebugWindow;
    if (!isMeetVideoDebugEnabled()) {
      delete debugWindow.__conclaveGetMeetVideoDebug;
      delete debugWindow.__conclaveMeetVideoDebug;
      delete debugWindow.__conclaveCloseLocalVideoProducerForDebug;
      return;
    }
    debugWindow.__conclaveGetMeetVideoDebug = () =>
      buildMeetVideoDebugSnapshot("getter");
    debugWindow.__conclaveMeetVideoDebug =
      buildMeetVideoDebugSnapshot("render");
    debugWindow.__conclaveCloseLocalVideoProducerForDebug =
      closeLocalVideoProducerForDebug;
    return () => {
      if (debugWindow.__conclaveGetMeetVideoDebug) {
        debugWindow.__conclaveMeetVideoDebug =
          buildMeetVideoDebugSnapshot("cleanup");
        delete debugWindow.__conclaveGetMeetVideoDebug;
      }
      if (
        debugWindow.__conclaveCloseLocalVideoProducerForDebug ===
        closeLocalVideoProducerForDebug
      ) {
        delete debugWindow.__conclaveCloseLocalVideoProducerForDebug;
      }
    };
  }, [buildMeetVideoDebugSnapshot, closeLocalVideoProducerForDebug]);

  useEffect(() => {
    if (connectionState !== "joined" || isCameraOff) {
      logMeetVideo("skip_replace_track_not_joined_or_camera_off", {
        connectionState,
        isCameraOff,
        processedTrackVersion,
        processedTrackReady,
      });
      return;
    }
    const initialProducer = refs.videoProducerRef.current;
    if (!initialProducer || initialProducer.closed) {
      warnMeetVideo("skip_replace_track_missing_or_closed_producer", {
        hasProducer: Boolean(initialProducer),
        producerClosed: initialProducer?.closed,
        processedTrackVersion,
        processedTrackReady,
      });
      return;
    }

    const sequence = publishTrackSwitchRef.current.sequence + 1;
    const previousSwitch = publishTrackSwitchRef.current.promise;
    publishTrackSwitchRef.current.sequence = sequence;

    const runSwitch = async () => {
      await previousSwitch.catch(() => {});
      if (publishTrackSwitchRef.current.sequence !== sequence) return;

      const producer = refs.videoProducerRef.current;
      if (!producer || producer.closed || producer.id !== initialProducer.id) {
        warnMeetVideo("skip_replace_track_producer_changed", {
          initialProducerId: initialProducer.id,
          currentProducerId: producer?.id ?? null,
          producerClosed: producer?.closed ?? null,
          processedTrackVersion,
          processedTrackReady,
        });
        return;
      }

      const publishStream = refs.localStreamRef.current ?? localStream;
      const nextTrack = getVideoPublishTrack(publishStream);
      if (!nextTrack) {
        warnMeetVideo("skip_replace_track_no_next_track", {
          producerTrack: getMeetTrackDebugSnapshot(producer.track ?? null),
          localStream: getMeetStreamDebugSnapshot(publishStream),
          processedTrackVersion,
          processedTrackReady,
        });
        return;
      }
      if (nextTrack.readyState !== "live") {
        warnMeetVideo("skip_replace_track_candidate_not_live", {
          nextTrack: getMeetTrackDebugSnapshot(nextTrack),
          producerTrack: getMeetTrackDebugSnapshot(producer.track ?? null),
          processedTrackVersion,
          processedTrackReady,
        });
        if (refs.processedVideoTrackRef.current?.id === nextTrack.id) {
          refs.processedVideoTrackRef.current = null;
        }
        return;
      }
      if (producer.track?.id === nextTrack.id) {
        logMeetVideo("skip_replace_track_same_track", {
          track: getMeetTrackDebugSnapshot(nextTrack),
          processedTrackVersion,
          processedTrackReady,
        });
        return;
      }

      logMeetVideo("replace_track_start", {
        from: getMeetTrackDebugSnapshot(producer.track ?? null),
        to: getMeetTrackDebugSnapshot(nextTrack),
        processedTrackVersion,
        processedTrackReady,
      });
      const isProcessedCandidate =
        refs.processedVideoTrackRef.current?.id === nextTrack.id;
      try {
        await producer.replaceTrack({ track: nextTrack });
        if (typeof window !== "undefined" && isMeetVideoDebugEnabled()) {
          (window as MeetVideoDebugWindow).__conclaveMeetVideoDebug =
            buildMeetVideoDebugSnapshot("replace_track_done");
        }
        logMeetVideo("replace_track_done", {
          producerTrack: getMeetTrackDebugSnapshot(producer.track ?? null),
        });
      } catch (err) {
        if (typeof window !== "undefined" && isMeetVideoDebugEnabled()) {
          (window as MeetVideoDebugWindow).__conclaveMeetVideoDebug =
            buildMeetVideoDebugSnapshot("replace_track_failed");
        }
        warnMeetVideo("replace_track_failed", {
          error:
            err instanceof Error
              ? { name: err.name, message: err.message, stack: err.stack }
              : err,
          from: getMeetTrackDebugSnapshot(producer.track ?? null),
          to: getMeetTrackDebugSnapshot(nextTrack),
        });
        console.error("[Meets] Failed to publish processed camera track:", err);
        if (!isProcessedCandidate || producer.closed) return;
        if (refs.processedVideoTrackRef.current?.id === nextTrack.id) {
          refs.processedVideoTrackRef.current = null;
        }
        if (publishTrackSwitchRef.current.sequence !== sequence) return;
        const rawFallbackTrack = getRawVideoPublishTrack(publishStream);
        if (!rawFallbackTrack || rawFallbackTrack.readyState !== "live") {
          warnMeetVideo("replace_track_raw_fallback_unavailable", {
            rawFallbackTrack: getMeetTrackDebugSnapshot(rawFallbackTrack),
            localStream: getMeetStreamDebugSnapshot(publishStream),
          });
          return;
        }
        if (producer.track?.id === rawFallbackTrack.id) {
          logMeetVideo("replace_track_raw_fallback_already_published", {
            rawFallbackTrack: getMeetTrackDebugSnapshot(rawFallbackTrack),
          });
          return;
        }
        logMeetVideo("replace_track_raw_fallback_start", {
          from: getMeetTrackDebugSnapshot(producer.track ?? null),
          to: getMeetTrackDebugSnapshot(rawFallbackTrack),
        });
        try {
          await producer.replaceTrack({ track: rawFallbackTrack });
          if (typeof window !== "undefined" && isMeetVideoDebugEnabled()) {
            (window as MeetVideoDebugWindow).__conclaveMeetVideoDebug =
              buildMeetVideoDebugSnapshot("replace_track_raw_fallback_done");
          }
          logMeetVideo("replace_track_raw_fallback_done", {
            producerTrack: getMeetTrackDebugSnapshot(producer.track ?? null),
          });
        } catch (fallbackErr) {
          warnMeetVideo("replace_track_raw_fallback_failed", {
            error:
              fallbackErr instanceof Error
                ? {
                    name: fallbackErr.name,
                    message: fallbackErr.message,
                    stack: fallbackErr.stack,
                  }
                : fallbackErr,
            rawFallbackTrack: getMeetTrackDebugSnapshot(rawFallbackTrack),
          });
        }
      }
    };

    const switchPromise = runSwitch();
    publishTrackSwitchRef.current.promise = switchPromise;
  }, [
    buildMeetVideoDebugSnapshot,
    connectionState,
    getRawVideoPublishTrack,
    getVideoPublishTrack,
    isCameraOff,
    localStream,
    processedTrackVersion,
    processedTrackReady,
    refs.localStreamRef,
    refs.videoProducerRef,
    refs.processedVideoTrackRef,
  ]);

  const { toggleHandRaised, setHandRaisedState } = useMeetHandRaise({
    isHandRaised,
    setIsHandRaised,
    isHandRaisedRef: refs.isHandRaisedRef,
    isObserverMode: isWebinarAttendee,
    socketRef: refs.socketRef,
  });

  useMeetHandRaiseSound({
    participants,
    connectionState,
    currentUserId: userId,
    isHandRaised,
    playNotificationSound,
  });

  useEffect(() => {
    setHandRaisedCommandRef.current = setHandRaisedState;
  }, [setHandRaisedState]);

  useHotkey(
    HOTKEYS.toggleCamera.keys as RegisterableHotkey,
    handleToggleCameraCommand,
    {
      enabled: connectionState === "joined",
      requireReset: true,
      ignoreInputs: true,
    },
  );

  useHotkey(
    HOTKEYS.toggleHandRaise.keys as RegisterableHotkey,
    toggleHandRaised,
    {
      enabled: connectionState === "joined",
      requireReset: true,
      ignoreInputs: true,
    },
  );

  useHotkey(HOTKEYS.toggleChat.keys as RegisterableHotkey, toggleChat, {
    enabled: connectionState === "joined",
    requireReset: true,
    ignoreInputs: true,
  });

  useHotkey(
    HOTKEYS.toggleParticipants.keys as RegisterableHotkey,
    () => setIsParticipantsOpen((prev) => !prev),
    {
      enabled: connectionState === "joined",
      requireReset: true,
      ignoreInputs: true,
    },
  );

  useHotkey(HOTKEYS.toggleScreenShare.keys as RegisterableHotkey, () => {
    void toggleScreenShare();
  }, {
    enabled: connectionState === "joined",
    requireReset: true,
    ignoreInputs: true,
  });

  const inviteCodeResolverRef = useRef<((value: string | null) => void) | null>(
    null,
  );
  const [isInviteCodePromptOpen, setIsInviteCodePromptOpen] = useState(false);
  const [inviteCodePromptMode, setInviteCodePromptMode] = useState<
    "meeting" | "webinar"
  >("webinar");
  const [inviteCodeInput, setInviteCodeInput] = useState("");
  const [inviteCodePromptError, setInviteCodePromptError] = useState<
    string | null
  >(null);

  const resolveInviteCodePrompt = useCallback((value: string | null) => {
    inviteCodeResolverRef.current?.(value);
    inviteCodeResolverRef.current = null;
    setIsInviteCodePromptOpen(false);
    setInviteCodeInput("");
    setInviteCodePromptError(null);
  }, []);

  const requestWebinarInviteCode = useCallback(async () => {
    return new Promise<string | null>((resolve) => {
      inviteCodeResolverRef.current = resolve;
      setInviteCodePromptMode("webinar");
      setInviteCodeInput("");
      setInviteCodePromptError(null);
      setIsInviteCodePromptOpen(true);
    });
  }, []);

  const requestMeetingInviteCode = useCallback(async () => {
    return new Promise<string | null>((resolve) => {
      inviteCodeResolverRef.current = resolve;
      setInviteCodePromptMode("meeting");
      setInviteCodeInput("");
      setInviteCodePromptError(null);
      setIsInviteCodePromptOpen(true);
    });
  }, []);

  const handleSubmitInviteCodePrompt = useCallback(() => {
    const trimmed = inviteCodeInput.trim();
    if (!trimmed) {
      setInviteCodePromptError("Invite code is required.");
      return;
    }
    resolveInviteCodePrompt(trimmed);
  }, [inviteCodeInput, resolveInviteCodePrompt]);

  const handleCancelInviteCodePrompt = useCallback(() => {
    resolveInviteCodePrompt(null);
  }, [resolveInviteCodePrompt]);

  useEffect(() => {
    return () => {
      if (inviteCodeResolverRef.current) {
        inviteCodeResolverRef.current(null);
        inviteCodeResolverRef.current = null;
      }
    };
  }, []);

  const handleLocalRoomEnded = useCallback(() => {
    setMeetingEndedNotice(null);
    setMeetError(null);
    setWaitingMessage(null);
    setPendingNewMeetingRoomId(null);
    setCurrentIsAdmin(false);
    setRoomId("");
    if (typeof window !== "undefined") {
      window.location.assign("/");
    }
  }, [setMeetError, setRoomId, setWaitingMessage]);

  const socket = useMeetSocket({
    refs,
    roomId,
    setRoomId,
    isAdmin: isAdminFlag,
    setIsAdmin: setCurrentIsAdmin,
    user: currentUser,
    userId,
    getJoinInfo,
    joinMode,
    requestWebinarInviteCode,
    requestMeetingInviteCode,
    displayNameInput,
    localStream,
    setLocalStream,
    getVideoPublishTrack,
    onPreferredVideoPublishTrackRejected:
      handlePreferredVideoPublishTrackRejected,
    dispatchParticipants,
    setDisplayNames,
    setPendingUsers,
    setConnectionState,
    setMeetError,
    setMeetingEndedNotice,
    setWaitingMessage,
    setHostUserId,
    setHostUserIds,
    setServerRestartNotice,
    setAdminNotice,
    setWebinarConfig,
    setWebinarRole,
    setWebinarSpeakerUserId,
    isMuted,
    setIsMuted,
    isCameraOff,
    setIsCameraOff,
    setIsScreenSharing,
    setIsHandRaised,
    setIsRoomLocked,
    setIsNoGuests,
    setIsChatLocked,
    setMeetingRequiresInviteCode,
    isTtsDisabled,
    setIsTtsDisabled,
    setIsDmEnabled,
    setIsReactionsDisabled,
    setActiveScreenShareId,
    setActiveSpeakerId,
    setServerActiveSpeakerAvailable,
    setNetworkManagedVideoQuality,
    videoQualityRef: refs.videoQualityRef,
    connectionQualityRef: connectionQualityDebugRef,
    dataSaverMode: effectiveDataSaverMode,
    isDocumentVisible,
    updateVideoQualityRef,
    requestMediaPermissions,
    requestAudioProducerRecovery,
    requestCameraProducerRecovery,
    prepareAudioPublishTrack,
    stopLocalTrack,
    handleLocalTrackEnded,
    playNotificationSound: playNotificationSoundForEvents,
    primeAudioOutput,
    addReaction,
    clearReactions,
    chat: {
      setChatMessages,
      setChatOverlayMessages,
      setUnreadCount,
      isChatOpenRef,
    },
    onTtsMessage: handleTtsMessage,
    prewarm,
    onSocketReady: setAppsSocket,
    onLocalRoomEnded: handleLocalRoomEnded,
    bypassMediaPermissions,
  });

  useEffect(() => {
    ensureProducerTransportRef.current = socket.ensureProducerTransport;
    return () => {
      if (ensureProducerTransportRef.current === socket.ensureProducerTransport) {
        ensureProducerTransportRef.current = null;
      }
    };
  }, [socket.ensureProducerTransport]);

  useMeetAudioActivity({
    enabled: !serverActiveSpeakerAvailable,
    participants,
    localStream,
    isMuted,
    userId,
    setActiveSpeakerId,
    audioContextRef: refs.audioContextRef,
    audioAnalyserMapRef: refs.audioAnalyserMapRef,
    lastActiveSpeakerRef: refs.lastActiveSpeakerRef,
  });

  const transcript = useMeetingTranscript({
    roomId,
    isJoined: connectionState === "joined" && !isWebinarAttendee,
    currentUserId: userId,
    currentDisplayName:
      displayNameInput ||
      normalizedCurrentUserName ||
      currentUser?.email ||
      currentUser?.id ||
      "You",
    isMuted,
    localStream,
    participants,
    activeSpeakerId: effectiveActiveSpeakerId,
    isViewOnly: false,
    resolveDisplayName,
    getTranscriptToken: socket.getTranscriptToken,
    getTranscriptSfuRelayStatus: socket.getTranscriptSfuRelayStatus,
    startTranscriptSfuRelay: socket.startTranscriptSfuRelay,
    stopTranscriptSfuRelay: socket.stopTranscriptSfuRelay,
  });

  // Feed the live transcript to "@Conclave" only while a session is running, so
  // the assistant cites the transcript when it's on and ignores it when it's off.
  const transcriptActive = transcript.isLive || transcript.isPaused;
  useEffect(() => {
    assistantContextRef.current = {
      transcript: transcriptActive
        ? formatTranscriptForAssistant(transcript.allSegments)
        : "",
      transcriptActive,
    };
  }, [transcriptActive, transcript.allSegments]);

  const {
    browserState,
    isLaunching: isBrowserLaunching,
    launchError: browserLaunchError,
    launchBrowser,
    navigateTo: navigateBrowser,
    closeBrowser,
    clearError: clearBrowserError,
  } = useSharedBrowser({
    socketRef: refs.socketRef,
    isAdmin: canModerateMeeting,
  });
  const showBrowserControls = Boolean(
    browserState?.active || isBrowserServiceAvailable,
  );

  const voiceAgent = useVoiceAgentParticipant({
    roomId,
    isJoined: connectionState === "joined",
    isAdmin: canModerateMeeting,
    isMuted,
    activeSpeakerId,
    localUserId: userId,
    localStream,
    participants,
    recentMessages: chatMessages,
    // Give the agent recall over the meeting: the live transcript feed and the
    // running notes/minutes so it can answer "what was decided" accurately.
    transcriptSegments: transcript.allSegments,
    isTranscriptActive: transcriptActive,
    meetingMinutes: transcriptActive ? transcript.minutes : null,
    resolveDisplayName,
  });

  const {
    start: startVoiceAgent,
    stop: stopVoiceAgent,
    clearError: clearVoiceAgentError,
    isStarting: isVoiceAgentStarting,
    isRunning: isVoiceAgentRunning,
    errorCode: voiceAgentErrorCode,
  } = voiceAgent;

  const handleStartVoiceAgent = useCallback(() => {
    // The dialog is the single surface for starting: it shows the key form,
    // or — when a key is already remembered for this tab — a connecting state
    // while the agent joins. It closes itself once the agent is live.
    clearVoiceAgentError();
    setIsVoiceAgentDialogOpen(true);
    const storedKey = getStoredVoiceAgentKey();
    if (storedKey) void startVoiceAgent(storedKey);
  }, [clearVoiceAgentError, startVoiceAgent]);

  const handleVoiceAgentDialogStart = useCallback(
    (apiKey: string, remember: boolean) => {
      storeVoiceAgentKey(apiKey, remember);
      void startVoiceAgent(apiKey);
    },
    [startVoiceAgent],
  );

  const handleCloseVoiceAgentDialog = useCallback(() => {
    setIsVoiceAgentDialogOpen(false);
    // Cancelling mid-connect aborts the start; otherwise just drop any
    // stale error so the next open starts clean.
    if (isVoiceAgentStarting) stopVoiceAgent();
    else clearVoiceAgentError();
  }, [clearVoiceAgentError, isVoiceAgentStarting, stopVoiceAgent]);

  // The dialog stays open (showing progress) until the agent is actually
  // live, so failures land inline instead of in a toast after the fact.
  useEffect(() => {
    if (isVoiceAgentRunning) setIsVoiceAgentDialogOpen(false);
  }, [isVoiceAgentRunning]);

  // A rejected key is useless — forget it and re-prompt with the reason.
  useEffect(() => {
    if (voiceAgentErrorCode !== "invalid-key") return;
    clearStoredVoiceAgentKey();
    setIsVoiceAgentDialogOpen(true);
  }, [voiceAgentErrorCode]);

  const handleStopVoiceAgent = useCallback(() => {
    // Deliberately keeps the remembered key: stop → start again later in the
    // meeting shouldn't demand re-entering it. It dies with the tab.
    setIsVoiceAgentDialogOpen(false);
    stopVoiceAgent();
  }, [stopVoiceAgent]);

  const { mounted } = useMeetLifecycle({
    cleanup: socket.cleanup,
    abortControllerRef: refs.abortControllerRef,
  });

  const isMobile = useIsMobile();
  const [hasEnteredMeetingSurface, setHasEnteredMeetingSurface] =
    useState(false);
  const shouldResetMeetingSurfaceOnDisconnectRef = useRef(false);

  useEffect(() => {
    if (connectionState === "joined") {
      shouldResetMeetingSurfaceOnDisconnectRef.current = false;
      setHasEnteredMeetingSurface(true);
      return;
    }
    if (connectionState === "waiting") {
      shouldResetMeetingSurfaceOnDisconnectRef.current = false;
      setHasEnteredMeetingSurface(false);
      return;
    }
    if (
      connectionState === "disconnected" &&
      shouldResetMeetingSurfaceOnDisconnectRef.current
    ) {
      shouldResetMeetingSurfaceOnDisconnectRef.current = false;
      setHasEnteredMeetingSurface(false);
    }
  }, [connectionState]);

  // Pre-join occupancy: keep the room-presence indicator fresh while the user is
  // still on the join screen. Poll when there's a room code to inspect (so guests
  // see who's already there before joining); admins also get a one-shot refresh.
  useEffect(() => {
    if (connectionState === "joined") return;
    const normalizedRoomId = roomId.trim();
    const hasRoom = normalizedRoomId.length > 0;
    if (!hasRoom && !isAdminFlag) return;

    const refresh = () => {
      void refreshRooms(isAdminFlag ? undefined : normalizedRoomId);
    };

    refresh();
    if (!hasRoom) return;
    const interval = setInterval(() => {
      refresh();
    }, 10000);
    return () => clearInterval(interval);
  }, [roomId, isAdminFlag, connectionState, refreshRooms]);

  const joinRoomById = socket.joinRoomById;
  const retryReconnect = socket.retryReconnect;
  const reconnectRecoveryStatus = socket.reconnectRecoveryStatus;
  const getMeetingConfig = socket.getMeetingConfig;
  const getWebinarConfig = socket.getWebinarConfig;

  useEffect(() => {
    if (connectionState !== "joined") return;
    if (!canModerateMeeting) return;
    void getMeetingConfig?.();
    void getWebinarConfig?.();
  }, [connectionState, canModerateMeeting, getMeetingConfig, getWebinarConfig]);

  const handleGoHome = useCallback(() => {
    handleStopVoiceAgent();
    socket.cleanup();
    setMeetError(null);
    setMeetingEndedNotice(null);
    setWaitingMessage(null);
    setPendingNewMeetingRoomId(null);
    setCurrentIsAdmin(false);
    setRoomId("");
    if (typeof window !== "undefined") {
      window.location.assign("/");
    }
  }, [
    handleStopVoiceAgent,
    setMeetError,
    setRoomId,
    setWaitingMessage,
    socket.cleanup,
  ]);

  const handleStartNewMeeting = useCallback(() => {
    const targetRoomId = generateRoomCode();
    handleStopVoiceAgent();
    socket.cleanup();
    setMeetError(null);
    setMeetingEndedNotice(null);
    setWaitingMessage(null);
    setCurrentIsAdmin(true);
    setRoomId(targetRoomId);
    if (enableRoomRouting && typeof window !== "undefined") {
      window.history.pushState(null, "", `/${targetRoomId}`);
    }
    setPendingNewMeetingRoomId(targetRoomId);
  }, [
    enableRoomRouting,
    handleStopVoiceAgent,
    setMeetError,
    setRoomId,
    setWaitingMessage,
    socket.cleanup,
  ]);

  useEffect(() => {
    if (!pendingNewMeetingRoomId || !isAdminFlag) return;
    const targetRoomId = pendingNewMeetingRoomId;
    setPendingNewMeetingRoomId(null);
    void joinRoomById(targetRoomId);
  }, [isAdminFlag, joinRoomById, pendingNewMeetingRoomId]);

  const leaveRoom = useCallback(() => {
    handleStopVoiceAgent();
    playNotificationSoundForEvents("leave");
    shouldResetMeetingSurfaceOnDisconnectRef.current = true;
    socket.cleanup();
    setIsCameraOff(true);
    setIsMuted(true);
  }, [
    handleStopVoiceAgent,
    playNotificationSoundForEvents,
    setIsCameraOff,
    setIsMuted,
    socket.cleanup,
  ]);

  useEffect(() => {
    leaveRoomCommandRef.current = leaveRoom;
  }, [leaveRoom]);

  const toggleBrowserAudio = useCallback(() => {
    if (browserAudioNeedsGesture) {
      setBrowserAudioNeedsGesture(false);
      setIsBrowserAudioMuted(false);
      setBrowserAudioPlaybackAttempt((attempt) => attempt + 1);
      return;
    }
    setBrowserAudioNeedsGesture(false);
    if (isBrowserAudioMuted) {
      setBrowserAudioPlaybackAttempt((attempt) => attempt + 1);
    }
    setIsBrowserAudioMuted((prev) => !prev);
  }, [browserAudioNeedsGesture, isBrowserAudioMuted, setIsBrowserAudioMuted]);

  const handleBrowserAudioAutoplayBlocked = useCallback(() => {
    setBrowserAudioNeedsGesture(true);
  }, []);
  const handleBrowserAudioPlaybackStarted = useCallback(() => {
    setBrowserAudioNeedsGesture(false);
  }, []);

  useEffect(() => {
    let isMounted = true;
    const checkBrowserService = async () => {
      try {
        const response = await fetch("/api/shared-browser/health", {
          cache: "no-store",
        });
        if (!isMounted) return;
        if (!response.ok) {
          setIsBrowserServiceAvailable(false);
          return;
        }
        const data = (await response.json().catch(() => null)) as {
          ok?: boolean;
        } | null;
        setIsBrowserServiceAvailable(Boolean(data?.ok));
      } catch (_error) {
        if (isMounted) {
          setIsBrowserServiceAvailable(false);
        }
      }
    };

    void checkBrowserService();
    const interval = setInterval(() => {
      void checkBrowserService();
    }, 30000);
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, []);

  const screenTrack = refs.screenProducerRef.current?.track;
  const localScreenShareStream = useMemo(() => {
    if (!screenTrack) return null;
    return new MediaStream([screenTrack]);
  }, [screenTrack]);

  const { presentationStream, presenterName, presentationProducerId } =
    useMemo(() => {
      let nextStream: MediaStream | null = null;
      let nextPresenterName = "";
      let nextProducerId: string | null = null;

      if (isScreenSharing && localScreenShareStream) {
        nextStream = localScreenShareStream;
        nextPresenterName = "You";
        nextProducerId =
          refs.screenProducerRef.current?.id ?? activeScreenShareId ?? null;
      } else if (activeScreenShareId) {
        // Prefer the participant whose screen producer matches the ACTIVE id so
        // the staged stream + "X is presenting" always correspond to the right
        // sharer; fall back to any present share so the stage is never blank.
        let matchedStream: MediaStream | null = null;
        let matchedName = "";
        let matchedProducerId: string | null = null;
        let anyStream: MediaStream | null = null;
        let anyName = "";
        let anyProducerId: string | null = null;
        for (const participant of participants.values()) {
          if (!participant.screenShareStream) continue;
          if (!anyStream) {
            anyStream = participant.screenShareStream;
            anyName = resolveDisplayName(participant.userId);
            anyProducerId = participant.screenShareProducerId;
          }
          if (participant.screenShareProducerId === activeScreenShareId) {
            matchedStream = participant.screenShareStream;
            matchedName = resolveDisplayName(participant.userId);
            matchedProducerId = participant.screenShareProducerId;
            break;
          }
        }
        nextStream = matchedStream ?? anyStream;
        nextPresenterName = matchedStream ? matchedName : anyName;
        nextProducerId = matchedProducerId ?? anyProducerId;
      }

      return {
        presentationStream: nextStream,
        presenterName: nextPresenterName,
        presentationProducerId: nextProducerId,
      };
    }, [
      activeScreenShareId,
      isScreenSharing,
      localScreenShareStream,
      participants,
      refs.screenProducerRef,
      resolveDisplayName,
    ]);

  useMeetPictureInPicture({
    isJoined: connectionState === "joined",
    localStream: displayLocalStream,
    participants,
    activeSpeakerId: effectiveActiveSpeakerId,
    presentationStream,
    presenterName,
    currentUserId: userId,
    isCameraOff,
    userEmail,
    getDisplayName: resolveDisplayName,
  });

  const { isPopoutActive, isPopoutSupported, openPopout, closePopout } =
    useMeetPopout({
      isJoined: connectionState === "joined",
      localStream: displayLocalStream,
      participants,
      activeSpeakerId: effectiveActiveSpeakerId,
      currentUserId: userId,
      isCameraOff,
      isMuted,
      mirrorLocalPreview,
      getDisplayName: resolveDisplayName,
      onToggleMute: () => {
        void toggleMute();
      },
      onToggleCamera: () => {
        void toggleCamera();
      },
      onLeave: () => {
        leaveRoom();
      },
    });

  useHotkey(HOTKEYS.toggleLockMeeting.keys as RegisterableHotkey, () => {
    if (canModerateMeeting) {
      void socket.toggleRoomLock(!isRoomLocked);
    }
  }, {
    enabled: connectionState === "joined",
    requireReset: true,
    ignoreInputs: true,
  });

  useHotkey(HOTKEYS.toggleMiniView.keys as RegisterableHotkey, () => {
    if (isPopoutActive) {
      closePopout();
    } else if (isPopoutSupported) {
      void openPopout();
    }
  }, {
    enabled: connectionState === "joined",
    requireReset: true,
    ignoreInputs: true,
  });

  // Network-quality polling reuses the media hook's existing transport refs;
  // it does not create or own any peer connection. This hook MUST run above the
  // `if (!mounted) return null` early-return below — every hook has to be called
  // unconditionally on every render (Rules of Hooks), or React throws a
  // "change in the order of Hooks" error and the whole client crashes.
  const selfConnectionStats = useConnectionQuality({
    producerTransportRef: refs.producerTransportRef,
    consumerTransportRef: refs.consumerTransportRef,
    enabled: connectionState === "joined",
  });
  connectionQualityDebugRef.current = selfConnectionStats;
  const {
    publishQuality: selfPublishQuality,
    receiveQuality: selfReceiveQuality,
    publishEmergencyMode: selfPublishEmergencyMode,
    receiveEmergencyMode: selfReceiveEmergencyMode,
  } = selfConnectionStats;
  const hasPoorPublishRecoverySignal =
    (selfConnectionStats.publishRttMs !== null &&
      selfConnectionStats.publishRttMs >= PUBLISH_RECOVERY_RTT_POOR_MS) ||
    (selfConnectionStats.publishPacketLoss !== null &&
      selfConnectionStats.publishPacketLoss >= PUBLISH_RECOVERY_LOSS_POOR) ||
    (selfConnectionStats.publishJitterMs !== null &&
      selfConnectionStats.publishJitterMs >= PUBLISH_RECOVERY_JITTER_POOR_MS);
  const hasBrowserEmergencySignal =
    selfConnectionStats.browserNetwork.emergency === true;
  const browserPublishRecoveryQuality = (
    selfConnectionStats.browserNetwork.quality === "unknown"
      ? selfConnectionStats.browserNetwork.startupQuality
      : selfConnectionStats.browserNetwork.quality
  );
  const browserAllowsPublishCapRecovery =
    !hasBrowserEmergencySignal &&
    selfConnectionStats.browserNetwork.saveData !== true &&
    (browserPublishRecoveryQuality === "good" ||
      browserPublishRecoveryQuality === "unknown");
  const selfPublishCapRecoveryQuality: ConnectionQuality =
    browserAllowsPublishCapRecovery && !hasPoorPublishRecoverySignal
      ? "good"
      : selfPublishQuality;
  useAdaptiveConsumerPreferences({
    refs,
    enabled: connectionState === "joined",
    connectionQuality: selfReceiveQuality,
    emergencyMode: selfReceiveEmergencyMode,
    availableIncomingBitrateBps: selfConnectionStats.availableIncomingBitrate,
    activeSpeakerId: effectiveActiveSpeakerId,
    dataSaverMode: effectiveDataSaverMode,
    isDocumentVisible,
    debugStateRef: adaptiveConsumerDebugRef,
    onVideoAdaptivePauseStateChange: handleVideoAdaptivePauseStateChange,
  });
  useAdaptivePublishQuality({
    enabled: connectionState === "joined",
    connectionQuality: selfPublishQuality,
    capRecoveryQuality: selfPublishCapRecoveryQuality,
    emergencyMode: selfPublishEmergencyMode,
    availableOutgoingBitrateBps: selfConnectionStats.availableOutgoingBitrate,
    publishCpuLimited: selfConnectionStats.publishMedia.video.cpuLimited,
    dataSaverMode: effectiveDataSaverMode,
    isCameraOff,
    participantCount,
    audioProducerRef: refs.audioProducerRef,
    videoProducerRef: refs.videoProducerRef,
    screenProducerRef: refs.screenProducerRef,
    screenAudioProducerRef: refs.screenAudioProducerRef,
    videoQualityRef: refs.videoQualityRef,
    networkManagedVideoQualityRef,
    setVideoQuality: setNetworkManagedVideoQuality,
    updateVideoQualityRef,
    refreshScreenAudioProducerForNetworkProfile,
    debugStateRef: adaptivePublishDebugRef,
  });

  // Full-screen brand animation that takes over the instant a meeting is
  // created/joined from the lobby, so navigation feels immediate while the SFU
  // connection settles underneath. Driven by the lobby's join/new click; on
  // success it hands off to the meeting/waiting screen, and on failure it
  // surfaces the error in place instead of bouncing back to the lobby.
  const [enterAction, setEnterAction] = useState<"new" | "join" | null>(null);
  const [enterErrored, setEnterErrored] = useState(false);

  const handleEnterMeetingStart = useCallback(
    (action: "new" | "join") => {
      setMeetError(null);
      setMeetingEndedNotice(null);
      setEnterErrored(false);
      setEnterAction(action);
    },
    [setMeetError],
  );

  const handleEnterRetry = useCallback(() => {
    setMeetError(null);
    setMeetingEndedNotice(null);
    setEnterErrored(false);
    setConnectionState("connecting");
    if (enterAction === "new") {
      handleStartNewMeeting();
    } else if (roomId) {
      void joinRoomById(roomId);
    }
  }, [
    enterAction,
    handleStartNewMeeting,
    joinRoomById,
    roomId,
    setConnectionState,
    setMeetError,
  ]);

  const handleEnterDismiss = useCallback(() => {
    setEnterAction(null);
    setEnterErrored(false);
    setMeetError(null);
    setMeetingEndedNotice(null);
    setConnectionState("disconnected");
  }, [setConnectionState, setMeetError]);

  useEffect(() => {
    if (!enterAction) return;
    // Success / waiting-room hand off to their own screens — fade the overlay.
    if (connectionState === "joined" || connectionState === "waiting") {
      setEnterAction(null);
      setEnterErrored(false);
      return;
    }
    // Otherwise reflect whether the attempt has failed; the overlay stays up
    // and switches to its error presentation.
    setEnterErrored(connectionState === "error" || Boolean(meetError));
  }, [enterAction, connectionState, meetError]);

  // Safety net while connecting: if nothing resolves, return to the lobby.
  // Errored overlays wait for the user instead of auto-dismissing.
  useEffect(() => {
    if (!enterAction || enterErrored) return;
    const timeout = window.setTimeout(() => {
      setEnterAction(null);
      setEnterErrored(false);
    }, 20000);
    return () => window.clearTimeout(timeout);
  }, [enterAction, enterErrored]);

  const meetingSurfaceWakeLockEnabled =
    connectionState === "joined" ||
    (hasEnteredMeetingSurface &&
      (connectionState === "reconnecting" ||
        connectionState === "connecting" ||
        connectionState === "connected" ||
        connectionState === "joining" ||
        connectionState === "disconnected"));
  useScreenWakeLock({ enabled: meetingSurfaceWakeLockEnabled });

  if (!mounted) return null;

  const isRejoiningMeetingSurface =
    hasEnteredMeetingSurface &&
    (connectionState === "reconnecting" ||
      connectionState === "connecting" ||
      connectionState === "connected" ||
      connectionState === "joining" ||
      connectionState === "disconnected" ||
      connectionState === "error");
  const isJoined = connectionState === "joined" || isRejoiningMeetingSurface;
  const isLoading =
    connectionState === "connecting" ||
    connectionState === "joining" ||
    connectionState === "reconnecting" ||
    connectionState === "waiting";

  const renderWithApps = (content: React.ReactNode) => (
    <>
      {shouldRunVideoEffects ? (
        <VideoEffectsBridge
          sourceStream={videoEffectsSourceStream}
          effects={videoEffects}
          processedVideoTrackRef={refs.processedVideoTrackRef}
          framingRecenterToken={framingRecenterToken}
          mirrorOutput={false}
          onStateChange={handleVideoEffectsBridgeStateChange}
        />
      ) : null}
      <AppsProvider
        socket={appsSocket}
        apps={MEETING_APPS}
        user={appsUser}
        isAdmin={canModerateMeeting}
        isReadOnly={isReadOnlyObserver}
      >
        <GameProvider
          socket={appsSocket}
          user={appsUser}
          isAdmin={canModerateMeeting}
          isReadOnly={isReadOnlyObserver}
        >
          <MeetVolumeProvider
            meetVolume={meetVolume}
            setMeetVolume={setMeetVolume}
          >
            {content}
          </MeetVolumeProvider>
        </GameProvider>
      </AppsProvider>
      <MeetingEnterOverlay
        show={enterAction !== null}
        action={enterAction}
        // Some failure paths flip connectionState to "error" without a
        // meetError (e.g. media unavailable on join). Fall back to a generic
        // recoverable error so the overlay always shows retry/dismiss controls
        // instead of stranding the user behind the loading animation.
        error={
          enterErrored
            ? (meetError ?? {
                code: "UNKNOWN",
                message: "",
                recoverable: true,
              })
            : null
        }
        onRetry={handleEnterRetry}
        onDismiss={handleEnterDismiss}
      />
    </>
  );
  const inviteCodePromptTitle =
    inviteCodePromptMode === "meeting"
      ? "Meeting Invite Code"
      : "Webinar Invite Code";
  const inviteCodePromptMessage =
    inviteCodePromptMode === "meeting"
      ? "Enter the invite code to join this meeting."
      : "Enter the invite code to join this webinar.";
  const inviteCodePrompt = isInviteCodePromptOpen ? (
    <div className="fixed inset-0 z-[140] flex items-center justify-center bg-black/75 px-4">
      <div className="w-full max-w-sm rounded-2xl border border-white/10 bg-[#111111] p-5 shadow-2xl">
        <h2 className="text-sm font-semibold text-[#fafafa]">
          {inviteCodePromptTitle}
        </h2>
        <p className="mt-1 text-xs text-[#fafafa]/75">
          {inviteCodePromptMessage}
        </p>
        <input
          value={inviteCodeInput}
          onChange={(event) => {
            setInviteCodeInput(event.target.value);
            if (inviteCodePromptError) {
              setInviteCodePromptError(null);
            }
          }}
          autoFocus
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          placeholder="Invite code"
          className="mt-4 w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2.5 text-sm text-[#fafafa] outline-none focus:border-[#fafafa]/35"
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              handleSubmitInviteCodePrompt();
            }
            if (event.key === "Escape") {
              event.preventDefault();
              handleCancelInviteCodePrompt();
            }
          }}
        />
        {inviteCodePromptError ? (
          <p className="mt-2 text-xs text-[#F95F4A]">{inviteCodePromptError}</p>
        ) : null}
        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={handleCancelInviteCodePrompt}
            className="rounded-xl border border-white/15 px-3 py-2 text-[11px] uppercase tracking-[0.14em] text-[#fafafa]/82 transition-colors hover:border-white/25 hover:text-[#fafafa]"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmitInviteCodePrompt}
            className="rounded-xl bg-[#F95F4A] px-3 py-2 text-[11px] uppercase tracking-[0.14em] text-white transition-opacity hover:opacity-90"
          >
            Continue
          </button>
        </div>
      </div>
    </div>
  ) : null;
  const voiceAgentKeyPrompt = (
    <VoiceAgentDialog
      open={isVoiceAgentDialogOpen}
      isStarting={isVoiceAgentStarting}
      error={voiceAgent.error}
      onStart={handleVoiceAgentDialogStart}
      onClose={handleCloseVoiceAgentDialog}
    />
  );

  if (connectionState === "waiting") {
    const waitingTitle = waitingMessage ?? "Waiting for host to let you in";
    const isLockedRoom = waitingMessage?.toLowerCase().includes("locked");
    const waitingIntro = isLockedRoom
      ? "Please wait while the host reviews your request."
      : waitingMessage
        ? "The host left the room, so there is no one available to admit you right now."
        : "Hang tight.";
    return renderWithApps(
      <MeetsWaitingScreen
        waitingTitle={waitingTitle}
        waitingIntro={waitingIntro}
        roomId={roomId}
        isAdmin={canModerateMeeting}
      />,
    );
  }

  return renderWithApps(
    <div className="flex flex-col h-full w-full bg-[#18181b] text-white">
      <MeetsHeader isJoined={isJoined} />
      {connectionState === "joined" && meetError && (
        <MeetsErrorBanner
          meetError={meetError}
          onDismiss={() => setMeetError(null)}
          primaryActionLabel={
            meetError.code === "PERMISSION_DENIED"
              ? "Retry Permissions"
              : meetError.code === "MEDIA_ERROR"
                ? "Retry Devices"
                : undefined
          }
          onPrimaryAction={
            meetError.code === "PERMISSION_DENIED" ||
            meetError.code === "MEDIA_ERROR"
              ? handleRetryMedia
              : undefined
          }
        />
      )}
      <MeetsMainContent
        isJoined={isJoined}
        isMobile={isMobile}
        viewSettings={viewSettings}
        onViewSettingsChange={setViewSettings}
        connectionState={connectionState}
        isLoading={isLoading}
        roomId={roomId}
        setRoomId={setRoomId}
        joinRoomById={joinRoomById}
        retryReconnect={retryReconnect}
        reconnectRecoveryStatus={reconnectRecoveryStatus}
        hideJoinUI={hideJoinUI || joinMode === "webinar_attendee"}
        isWebinarAttendee={isWebinarAttendee}
        enableRoomRouting={enableRoomRouting}
        forceJoinOnly={forceJoinOnly}
        user={currentUser}
        userEmail={userEmail}
        isAdmin={canModerateMeeting}
        showPermissionHint={showPermissionHint}
        availableRooms={availableRooms}
        roomsStatus={roomsStatus}
        refreshRooms={refreshRooms}
        displayNameInput={displayNameInput}
        setDisplayNameInput={setDisplayNameInput}
        presentationStream={presentationStream}
        presenterName={presenterName || ""}
        presentationProducerId={presentationProducerId}
        screenShareControlState={screenShareControlState}
        screenShareCaptureController={refs.screenShareCaptureControllerRef.current}
        localStream={displayLocalStream}
        videoEffects={videoEffects}
        onVideoEffectsChange={setVideoEffects}
        onVideoEffectsRecenter={() =>
          setFramingRecenterToken((token) => token + 1)
        }
        videoEffectsStatus={videoEffectsStatus}
        videoEffectsError={videoEffectsError}
        videoEffectsDebugStats={videoEffectsDebugStats}
        activeVideoEffectsCount={activeVideoEffectsCount}
        deferVideoEffectsPreload={shouldDeferVideoEffectsPreload}
        cameraPreviewStream={cameraPreviewDisplayStream}
        isCameraPreviewStarting={cameraPreview.isStarting}
        cameraPreviewError={cameraPreview.error}
        onStartCameraPreview={cameraPreview.start}
        onStopCameraPreview={stopCameraPreview}
        connectionStats={selfConnectionStats}
        onDevCameraStreamChange={setDevCameraStream}
        onPrejoinMediaCommit={handlePrejoinMediaCommit}
        isCameraOff={isCameraOff}
        isMuted={isMuted}
        isMuteTogglePending={isMuteTogglePending}
        isHandRaised={isHandRaised}
        participants={participants}
        isMirrorCamera={isMirrorCamera}
        mirrorLocalPreview={mirrorLocalPreview}
        onToggleMirror={() => setIsMirrorCamera((prev) => !prev)}
        selectedAudioInputDeviceId={selectedAudioInputDeviceId}
        selectedAudioOutputDeviceId={selectedAudioOutputDeviceId}
        ttsSystemVoices={availableSystemVoices}
        selectedTtsSystemVoiceUri={selectedSystemVoiceUri}
        onTtsSystemVoiceChange={setSelectedSystemVoiceUri}
        clonedTtsVoice={clonedVoice}
        onClonedTtsVoiceChange={saveClonedVoice}
        onClonedTtsVoiceClear={clearClonedVoice}
        canCloneTtsVoice={Boolean(currentUser?.id && currentUser?.email)}
        ttsVoiceOwnerName={
          normalizedCurrentUserName || currentUser?.email || displayNameInput || "My voice"
        }
        selectedVideoInputDeviceId={selectedVideoInputDeviceId}
        onAudioInputDeviceChange={handleAudioInputDeviceChange}
        onAudioOutputDeviceChange={handleAudioOutputDeviceChange}
        onVideoInputDeviceChange={handleVideoInputDeviceSelect}
        isNoiseCancellationEnabled={isNoiseCancellationEnabled}
        onToggleNoiseCancellation={() =>
          setIsNoiseCancellationEnabled((value) => !value)
        }
        activeSpeakerId={effectiveActiveSpeakerId}
        currentUserId={userId}
        audioOutputDeviceId={selectedAudioOutputDeviceId}
        activeScreenShareId={activeScreenShareId}
        isScreenSharing={isScreenSharing}
        isChatOpen={isChatOpen}
        unreadCount={unreadCount}
        reactionOptions={reactionOptions}
        toggleMute={toggleMute}
        toggleCamera={toggleCamera}
        toggleScreenShare={toggleScreenShare}
        toggleChat={toggleChat}
        toggleHandRaised={toggleHandRaised}
        sendReaction={sendReaction}
        leaveRoom={leaveRoom}
        endRoomForEveryone={
          canModerateMeeting ? socket.endRoomForEveryone : undefined
        }
        onGoHome={handleGoHome}
        onStartNewMeeting={
          joinMode === "meeting" ? handleStartNewMeeting : undefined
        }
        onEnterMeetingStart={handleEnterMeetingStart}
        isParticipantsOpen={isParticipantsOpen}
        setIsParticipantsOpen={setIsParticipantsOpen}
        pendingUsers={pendingUsers}
        chatMessages={chatMessages}
        chatInput={chatInput}
        setChatInput={setChatInput}
        sendChat={sendChat}
        sendChatGif={sendChatGif}
        chatOverlayMessages={chatOverlayMessages}
        setChatOverlayMessages={setChatOverlayMessages}
        replyTarget={replyTarget}
        onReplyToMessage={startReply}
        onCancelReply={cancelReply}
        assistantApiKeyPrompt={assistantApiKeyPrompt}
        onSubmitAssistantApiKey={submitAssistantApiKey}
        onCancelAssistantApiKey={cancelAssistantApiKeyPrompt}
        onAssistantToolApproval={resolveAssistantToolApproval}
        socket={refs.socketRef.current}
        setPendingUsers={setPendingUsers}
        resolveDisplayName={resolveDisplayName}
        reactionStore={reactionStore}
        onUserChange={(user) => setCurrentUser(user ?? undefined)}
        onIsAdminChange={setCurrentIsAdmin}
        onPendingUserStale={(userId) => {
          setPendingUsers((prev) => {
            const next = new Map(prev);
            next.delete(userId);
            return next;
          });
        }}
        isRoomLocked={isRoomLocked}
        isTtsDisabled={isTtsDisabled}
        isDmEnabled={isDmEnabled}
        isReactionsDisabled={isReactionsDisabled}
        onToggleLock={() => {
          if (canModerateMeeting) void socket.toggleRoomLock(!isRoomLocked);
        }}
        isNoGuests={isNoGuests}
        onToggleNoGuests={() => {
          if (canModerateMeeting) void socket.toggleNoGuests(!isNoGuests);
        }}
        isChatLocked={isChatLocked}
        onToggleChatLock={() => {
          if (canModerateMeeting) void socket.toggleChatLock(!isChatLocked);
        }}
        browserState={browserState}
        isBrowserLaunching={isBrowserLaunching}
        browserLaunchError={browserLaunchError}
        showBrowserControls={showBrowserControls}
        onLaunchBrowser={launchBrowser}
        onNavigateBrowser={navigateBrowser}
        onCloseBrowser={closeBrowser}
        onClearBrowserError={clearBrowserError}
        isBrowserAudioMuted={isBrowserAudioMuted}
        onToggleBrowserAudio={toggleBrowserAudio}
        browserAudioNeedsGesture={browserAudioNeedsGesture}
        browserAudioPlaybackAttemptToken={browserAudioPlaybackAttempt}
        onBrowserAudioAutoplayBlocked={handleBrowserAudioAutoplayBlocked}
        onBrowserAudioPlaybackStarted={handleBrowserAudioPlaybackStarted}
        meetError={meetError}
        meetingEndedNotice={meetingEndedNotice}
        onDismissMeetingEndedNotice={() => setMeetingEndedNotice(null)}
        isPopoutActive={isPopoutActive}
        isPopoutSupported={isPopoutSupported}
        onOpenPopout={openPopout}
        onClosePopout={closePopout}
        hostUserId={hostUserId}
        hostUserIds={hostUserIds}
        isNetworkOffline={isNetworkOffline}
        serverRestartNotice={serverRestartNotice}
        adminNotice={adminNotice}
        meetingRequiresInviteCode={meetingRequiresInviteCode}
        webinarConfig={webinarConfig}
        webinarRole={webinarRole}
        webinarSpeakerUserId={webinarSpeakerUserId}
        webinarLink={webinarLink}
        onSetWebinarLink={setWebinarLink}
        onGetMeetingConfig={
          canModerateMeeting ? socket.getMeetingConfig : undefined
        }
        onUpdateMeetingConfig={
          canModerateMeeting ? socket.updateMeetingConfig : undefined
        }
        onGetWebinarConfig={
          canModerateMeeting ? socket.getWebinarConfig : undefined
        }
        onUpdateWebinarConfig={
          canModerateMeeting ? socket.updateWebinarConfig : undefined
        }
        onGenerateWebinarLink={
          canModerateMeeting ? socket.generateWebinarLink : undefined
        }
        onRotateWebinarLink={
          canModerateMeeting ? socket.rotateWebinarLink : undefined
        }
        transcript={transcript}
        isVoiceAgentRunning={voiceAgent.isRunning}
        isVoiceAgentStarting={voiceAgent.isStarting}
        voiceAgentError={
          // The dialog surfaces start/key errors inline; the toast only
          // covers failures that happen while no dialog is up (e.g. the
          // agent dropping mid-call).
          isVoiceAgentDialogOpen || voiceAgentErrorCode === "invalid-key"
            ? null
            : voiceAgent.error
        }
        onStartVoiceAgent={canModerateMeeting ? handleStartVoiceAgent : undefined}
        onStopVoiceAgent={canModerateMeeting ? handleStopVoiceAgent : undefined}
        onClearVoiceAgentError={voiceAgent.clearError}
      />
      {inviteCodePrompt}
      {voiceAgentKeyPrompt}
    </div>,
  );
}

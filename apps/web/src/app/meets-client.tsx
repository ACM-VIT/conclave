"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useHotkey } from "@tanstack/react-hotkeys";
import type { RegisterableHotkey } from "@tanstack/hotkeys";
import { HOTKEYS } from "./lib/hotkeys";
import type { Socket } from "socket.io-client";
import type { RoomInfo } from "@/lib/sfu-types";
import { signOut } from "@/lib/auth-client";
import type { AssetUploadHandler } from "@conclave/apps-sdk";
import {
  AppsProvider,
  createAssetUploadHandler,
  registerApps,
} from "@conclave/apps-sdk";
import { devPlaygroundApp } from "@conclave/apps-sdk/dev-playground/web";
import { whiteboardApp } from "@conclave/apps-sdk/whiteboard/web";
import MeetsErrorBanner from "./components/MeetsErrorBanner";
import MeetsHeader from "./components/MeetsHeader";
import MeetsMainContent from "./components/MeetsMainContent";
import MeetsWaitingScreen from "./components/MeetsWaitingScreen";
import MobileMeetsMainContent from "./components/mobile/MobileMeetsMainContent";

import { useMeetAudioActivity } from "./hooks/useMeetAudioActivity";
import { useMeetChat } from "./hooks/useMeetChat";
import { useMeetDisplayName } from "./hooks/useMeetDisplayName";
import { useMeetGhostMode } from "./hooks/useMeetGhostMode";
import { useMeetHandRaise } from "./hooks/useMeetHandRaise";
import { useMeetHandRaiseSound } from "./hooks/useMeetHandRaiseSound";
import { useMeetLifecycle } from "./hooks/useMeetLifecycle";
import { useMeetMedia } from "./hooks/useMeetMedia";
import { useMeetMediaSettings } from "./hooks/useMeetMediaSettings";
import { useMeetPictureInPicture } from "./hooks/useMeetPictureInPicture";
import { useMeetPopout } from "./hooks/useMeetPopout";
import { useMeetReactions } from "./hooks/useMeetReactions";
import { useMeetRefs } from "./hooks/useMeetRefs";
import { useMeetRooms } from "./hooks/useMeetRooms";
import { useMeetSocket } from "./hooks/useMeetSocket";
import { useMeetState } from "./hooks/useMeetState";
import { useMeetTts } from "./hooks/useMeetTts";
import {
  prewarmVideoEffectsAssets,
  prewarmVideoEffectsRuntime,
  useVideoEffects,
} from "./hooks/useVideoEffects";
import { useConnectionQuality } from "./hooks/useConnectionQuality";
import { useIsMobile } from "./hooks/useIsMobile";
import { usePrewarmSocket } from "./hooks/usePrewarmSocket";
import { useSharedBrowser } from "./hooks/useSharedBrowser";
import { useVoiceAgentParticipant } from "./hooks/useVoiceAgentParticipant";
import type { JoinMode, PrejoinMediaHandoff } from "./lib/types";
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
  isSystemUserId,
  sanitizeInstitutionDisplayName,
  sanitizeRoomCode,
} from "./lib/utils";

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
    return { id, email, name };
  } catch {
    return null;
  }
};

export type MeetsClientProps = {
  initialRoomId?: string;
  enableRoomRouting?: boolean;
  forceJoinOnly?: boolean;
  allowGhostMode?: boolean;
  bypassMediaPermissions?: boolean;
  fontClassName?: string;
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
  reactionAssets?: string[];
};

export default function MeetsClient({
  initialRoomId,
  enableRoomRouting = false,
  forceJoinOnly = false,
  allowGhostMode = true,
  bypassMediaPermissions = false,
  fontClassName,
  user,
  isAdmin = false,
  getJoinInfo,
  joinMode = "meeting",
  autoJoinOnMount = false,
  hideJoinUI = false,
  getRooms,
  reactionAssets,
}: MeetsClientProps) {
  const [currentUser, setCurrentUser] = useState<MeetUser | undefined>(user);
  const [currentIsAdmin, setCurrentIsAdmin] = useState(isAdmin);
  const [guestStorageReady, setGuestStorageReady] = useState(false);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [appsSocket, setAppsSocket] = useState<Socket | null>(null);
  const uploadAsset: AssetUploadHandler = useMemo(
    () => createAssetUploadHandler(),
    [],
  );

  useEffect(() => {
    if (guestStorageReady || typeof window === "undefined") return;
    if (!user) {
      const storedGuest = parseGuestUser(
        window.localStorage.getItem(GUEST_USER_STORAGE_KEY),
      );
      if (storedGuest) {
        setCurrentUser(storedGuest);
      }
    }
    setGuestStorageReady(true);
  }, [guestStorageReady, user]);

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
    clearGuestStorage();
    setCurrentUser((current) => {
      if (
        current?.id === user.id &&
        current?.email === user.email &&
        current?.name === user.name
      ) {
        return current;
      }
      return user;
    });
    setCurrentIsAdmin(isAdmin);
  }, [clearGuestStorage, isAdmin, user]);

  useEffect(() => {
    if (process.env.NODE_ENV === "development") {
      registerApps([whiteboardApp, devPlaygroundApp]);
      return;
    }
    registerApps([whiteboardApp]);
  }, []);

  const prewarm = usePrewarmSocket();

  const refs = useMeetRefs();
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
    isGhostMode,
    setIsGhostMode,
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
    isBrowserAudioMuted,
    setIsBrowserAudioMuted,
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
  const [videoEffects, setVideoEffects] =
    useState<VideoEffectsState>(readStoredVideoEffects);
  const [framingRecenterToken, setFramingRecenterToken] = useState(0);
  const [devCameraStream, setDevCameraStream] = useState<MediaStream | null>(
    null,
  );
  const activeVideoEffectsCount = useMemo(
    () => countActiveVideoEffects(videoEffects),
    [videoEffects],
  );
  const getVideoPublishTrackRef = useRef<
    ((stream?: MediaStream | null) => MediaStreamTrack | null) | null
  >(null);
  const restoredVideoEffectsPrewarmDoneRef = useRef(false);
  const cameraLiveEffectsPrewarmDoneRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    let timeoutId: number | null = null;
    let idleId: number | null = null;
    const run = () => {
      if (cancelled) return;
      void prewarmVideoEffectsRuntime({
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
  }, []);

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
    restoredVideoEffectsPrewarmDoneRef.current = true;
    const backgroundNeedsSegmentation =
      videoEffects.background !== "none" &&
      videoEffects.background !== "gradient" &&
      (videoEffects.background !== "custom" ||
        Boolean(videoEffects.customBackgroundDataUrl));
    const backgrounds: BackgroundEffectId[] =
      backgroundNeedsSegmentation &&
      videoEffects.background !== "blur-light" &&
      videoEffects.background !== "blur-strong" &&
      videoEffects.background !== "custom"
        ? [videoEffects.background]
        : [];
    void prewarmVideoEffectsAssets({
      segmentation: backgroundNeedsSegmentation,
      face: videoEffects.filter !== "none" || videoEffects.framing,
      faceFilter:
        videoEffects.filter !== "none" ? videoEffects.filter : undefined,
      backgrounds,
      reason: "restored-effects-state",
    });
  }, [videoEffects]);

  useEffect(() => {
    if (cameraLiveEffectsPrewarmDoneRef.current) return;
    if (isCameraOff || !hasLiveVideoTrack(localStream)) return;

    cameraLiveEffectsPrewarmDoneRef.current = true;
    void prewarmVideoEffectsAssets({
      segmentation: true,
      face: true,
      reason: "camera-live",
    });
  }, [isCameraOff, localStream]);

  const [browserAudioNeedsGesture, setBrowserAudioNeedsGesture] =
    useState(false);
  const [isBrowserServiceAvailable, setIsBrowserServiceAvailable] =
    useState(false);
  const [isVoiceAgentKeyPromptOpen, setIsVoiceAgentKeyPromptOpen] =
    useState(false);
  const [voiceAgentKeyInput, setVoiceAgentKeyInput] = useState("");
  const [voiceAgentKeyPromptError, setVoiceAgentKeyPromptError] =
    useState<string | null>(null);
  const voiceAgentApiKeyRef = useRef("");
  const toggleMuteCommandRef = useRef<(() => void) | null>(null);
  const toggleCameraCommandRef = useRef<(() => void) | null>(null);
  const ensureProducerTransportRef = useRef<(() => Promise<boolean>) | null>(
    null,
  );
  const setHandRaisedCommandRef = useRef<((raised: boolean) => void) | null>(
    null,
  );
  const leaveRoomCommandRef = useRef<(() => void) | null>(null);

  const handleToggleMuteCommand = useCallback(() => {
    toggleMuteCommandRef.current?.();
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
    toggleCameraCommandRef.current?.();
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
    videoQuality,
    setVideoQuality,
    isMirrorCamera,
    setIsMirrorCamera,
    selectedAudioInputDeviceId,
    setSelectedAudioInputDeviceId,
    selectedAudioOutputDeviceId,
    setSelectedAudioOutputDeviceId,
    selectedVideoInputDeviceId,
    setSelectedVideoInputDeviceId,
  } = useMeetMediaSettings({ videoQualityRef: refs.videoQualityRef });

  const isAdminFlag = Boolean(currentIsAdmin);
  const isWebinarAttendee =
    joinMode === "webinar_attendee" || webinarRole === "attendee";
  const ghostEnabled = allowGhostMode && isAdminFlag && isGhostMode;
  const canSignOut = Boolean(
    currentUser && !currentUser.id?.startsWith("guest-"),
  );
  const normalizedCurrentUserName =
    typeof currentUser?.name === "string"
      ? sanitizeInstitutionDisplayName(currentUser.name, currentUser.email)
      : currentUser?.name;

  const sessionId = refs.sessionIdRef.current;
  const userEmail =
    normalizedCurrentUserName ||
    currentUser?.email ||
    currentUser?.id ||
    "guest";
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
    ghostEnabled,
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
        "Guest",
      email: currentUser?.email ?? null,
    }),
    [userId, displayNameInput, normalizedCurrentUserName, currentUser],
  );

  const { availableRooms, roomsStatus, refreshRooms } = useMeetRooms({
    isAdmin: isAdminFlag,
    getRooms,
  });

  const {
    reactions: reactionEvents,
    reactionOptions,
    addReaction,
    sendReaction,
    clearReactions,
  } = useMeetReactions({
    userId,
    socketRef: refs.socketRef,
    ghostEnabled,
    isObserverMode: isWebinarAttendee,
    reactionAssets,
  });

  const { ttsSpeakerId, handleTtsMessage } = useMeetTts();
  const effectiveActiveSpeakerId = ttsSpeakerId ?? activeSpeakerId;

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
    isChatOpenRef,
  } = useMeetChat({
    socketRef: refs.socketRef,
    ghostEnabled,
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
    isTtsDisabled,
  });

  const {
    showPermissionHint,
    requestMediaPermissions,
    handleAudioInputDeviceChange,
    handleVideoInputDeviceChange,
    handleAudioOutputDeviceChange,
    updateVideoQualityRef,
    toggleMute,
    isMuteTogglePending,
    toggleCamera,
    toggleScreenShare,
    stopLocalTrack,
    handleLocalTrackEnded,
    playNotificationSound,
    primeAudioOutput,
  } = useMeetMedia({
    ghostEnabled,
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
    selectedAudioOutputDeviceId,
    setSelectedAudioOutputDeviceId,
    videoQuality,
    videoQualityRef: refs.videoQualityRef,
    activeVideoEffectsCount,
    getVideoPublishTrackRef,
    socketRef: refs.socketRef,
    deviceRef: refs.deviceRef,
    producerTransportRef: refs.producerTransportRef,
    ensureProducerTransportRef,
    audioProducerRef: refs.audioProducerRef,
    videoProducerRef: refs.videoProducerRef,
    screenProducerRef: refs.screenProducerRef,
    screenAudioProducerRef: refs.screenAudioProducerRef,
    localStreamRef: refs.localStreamRef,
    intentionalTrackStopsRef: refs.intentionalTrackStopsRef,
    permissionHintTimeoutRef: refs.permissionHintTimeoutRef,
    audioContextRef: refs.audioContextRef,
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
    localStream?.getTracks().forEach((track) => stopLocalTrack(track));
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

  const {
    effectiveStream: processedLocalStream,
    processedTrackVersion,
    processedTrackReady,
    status: videoEffectsStatus,
    error: videoEffectsError,
    debugStats: videoEffectsDebugStats,
  } = useVideoEffects({
    sourceStream: hasLiveVideoTrack(localStream) ? localStream : devCameraStream,
    effects: videoEffects,
    processedVideoTrackRef: refs.processedVideoTrackRef,
    framingRecenterToken,
  });
  const displayLocalStream = processedLocalStream ?? localStream;
  const getVideoPublishTrack = useCallback(
    (stream?: MediaStream | null) => {
      const rawTrack =
        stream?.getVideoTracks().find((track) => track.readyState === "live") ??
        refs.localStreamRef.current
          ?.getVideoTracks()
          .find((track) => track.readyState === "live") ??
        null;
      const processedTrack = refs.processedVideoTrackRef.current;
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
        processedDebugOutputPublished &&
          processedOutputTrackId &&
          processedTrack &&
          processedOutputTrackId !== processedTrack.id,
      );
      const processedTrackMatchesCurrentSource = Boolean(
        rawTrack &&
          !processedTrackHasExplicitSourceMismatch &&
          !processedTrackHasExplicitOutputMismatch,
      );
      if (
        activeVideoEffectsCount > 0 &&
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
          },
        );
        return processedTrack;
      }
      if (processedTrack && !processedTrackReady) {
        logMeetVideo("skip_processed_track_not_ready", {
          processedTrack: getMeetTrackDebugSnapshot(processedTrack),
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
      });
      return rawTrack;
    },
    [
      activeVideoEffectsCount,
      processedTrackReady,
      refs.localStreamRef,
      refs.processedVideoTrackRef,
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
        processedDebugOutputPublished &&
          processedOutputTrackId &&
          processedTrack &&
          processedOutputTrackId !== processedTrack.id,
      );
      const processedTrackMatchesCurrentSource = Boolean(
        rawTrack &&
          !processedTrackHasExplicitSourceMismatch &&
          !processedTrackHasExplicitOutputMismatch,
      );
      const shouldPublishProcessed =
        activeVideoEffectsCount > 0 &&
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
        isCameraOff,
        activeVideoEffectsCount,
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
          usingProcessedTrack,
          usingRawTrack,
          processedTrackMatchesCurrentSource,
          processedTrackHasExplicitSourceMismatch,
          processedTrackHasExplicitOutputMismatch,
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
      connectionState,
      displayLocalStream,
      getRawVideoPublishTrack,
      isCameraOff,
      localStream,
      processedLocalStream,
      processedTrackReady,
      processedTrackVersion,
      refs.localStreamRef,
      refs.processedVideoTrackRef,
      refs.videoProducerRef,
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
    const producer = refs.videoProducerRef.current;
    if (!producer || producer.closed) {
      warnMeetVideo("skip_replace_track_missing_or_closed_producer", {
        hasProducer: Boolean(producer),
        producerClosed: producer?.closed,
        processedTrackVersion,
        processedTrackReady,
      });
      return;
    }

    const nextTrack = getVideoPublishTrack(localStream);
    if (!nextTrack) {
      warnMeetVideo("skip_replace_track_no_next_track", {
        producerTrack: getMeetTrackDebugSnapshot(producer.track ?? null),
        localStream: getMeetStreamDebugSnapshot(localStream),
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
    producer
      .replaceTrack({ track: nextTrack })
      .then(() => {
        if (typeof window !== "undefined" && isMeetVideoDebugEnabled()) {
          (window as MeetVideoDebugWindow).__conclaveMeetVideoDebug =
            buildMeetVideoDebugSnapshot("replace_track_done");
        }
        logMeetVideo("replace_track_done", {
          producerTrack: getMeetTrackDebugSnapshot(producer.track ?? null),
        });
      })
      .catch((err) => {
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
        const rawFallbackTrack = getRawVideoPublishTrack(localStream);
        if (!rawFallbackTrack || rawFallbackTrack.readyState !== "live") {
          warnMeetVideo("replace_track_raw_fallback_unavailable", {
            rawFallbackTrack: getMeetTrackDebugSnapshot(rawFallbackTrack),
            localStream: getMeetStreamDebugSnapshot(localStream),
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
        producer
          .replaceTrack({ track: rawFallbackTrack })
          .then(() => {
            if (typeof window !== "undefined" && isMeetVideoDebugEnabled()) {
              (window as MeetVideoDebugWindow).__conclaveMeetVideoDebug =
                buildMeetVideoDebugSnapshot("replace_track_raw_fallback_done");
            }
            logMeetVideo("replace_track_raw_fallback_done", {
              producerTrack: getMeetTrackDebugSnapshot(producer.track ?? null),
            });
          })
          .catch((fallbackErr) => {
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
          });
      });
  }, [
    buildMeetVideoDebugSnapshot,
    connectionState,
    getRawVideoPublishTrack,
    getVideoPublishTrack,
    isCameraOff,
    localStream,
    processedTrackVersion,
    processedTrackReady,
    refs.videoProducerRef,
    refs.processedVideoTrackRef,
  ]);

  const { toggleHandRaised, setHandRaisedState } = useMeetHandRaise({
    isHandRaised,
    setIsHandRaised,
    isHandRaisedRef: refs.isHandRaisedRef,
    ghostEnabled,
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

  useHotkey(HOTKEYS.toggleScreenShare.keys as RegisterableHotkey, toggleScreenShare, {
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
    ghostEnabled,
    displayNameInput,
    localStream,
    setLocalStream,
    getVideoPublishTrack,
    dispatchParticipants,
    setDisplayNames,
    setPendingUsers,
    setConnectionState,
    setMeetError,
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
    setActiveScreenShareId,
    setVideoQuality,
    videoQualityRef: refs.videoQualityRef,
    updateVideoQualityRef,
    requestMediaPermissions,
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
    participants,
    localStream,
    isMuted,
    userId,
    setActiveSpeakerId,
    audioContextRef: refs.audioContextRef,
    audioAnalyserMapRef: refs.audioAnalyserMapRef,
    lastActiveSpeakerRef: refs.lastActiveSpeakerRef,
  });

  useMeetGhostMode({
    isAdmin: isAdminFlag,
    isGhostMode,
    setIsGhostMode,
    ghostEnabled,
    setIsMuted,
    setIsCameraOff,
    setIsScreenSharing,
    setIsHandRaised,
  });

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
    isAdmin: isAdminFlag,
  });
  const showBrowserControls = Boolean(
    browserState?.active || isBrowserServiceAvailable,
  );

  const voiceAgent = useVoiceAgentParticipant({
    roomId,
    isJoined: connectionState === "joined",
    isAdmin: isAdminFlag,
    isMuted,
    activeSpeakerId,
    localUserId: userId,
    localStream,
    participants,
    recentMessages: chatMessages,
    resolveDisplayName,
  });

  const openVoiceAgentKeyPrompt = useCallback(() => {
    setVoiceAgentKeyPromptError(null);
    setVoiceAgentKeyInput("");
    setIsVoiceAgentKeyPromptOpen(true);
  }, []);

  const closeVoiceAgentKeyPrompt = useCallback(() => {
    setVoiceAgentKeyPromptError(null);
    setVoiceAgentKeyInput("");
    setIsVoiceAgentKeyPromptOpen(false);
  }, []);

  const handleStartVoiceAgent = useCallback(() => {
    const apiKey = voiceAgentApiKeyRef.current.trim();
    if (!apiKey) {
      openVoiceAgentKeyPrompt();
      return;
    }
    void voiceAgent.start(apiKey);
  }, [openVoiceAgentKeyPrompt, voiceAgent]);

  const handleSubmitVoiceAgentKeyPrompt = useCallback(() => {
    const apiKey = voiceAgentKeyInput.trim();
    if (!apiKey) {
      setVoiceAgentKeyPromptError("Enter your OpenAI API key.");
      return;
    }
    if (!apiKey.startsWith("sk-")) {
      setVoiceAgentKeyPromptError("OpenAI API keys usually start with \"sk-\".");
      return;
    }
    voiceAgentApiKeyRef.current = apiKey;
    setVoiceAgentKeyPromptError(null);
    setVoiceAgentKeyInput("");
    setIsVoiceAgentKeyPromptOpen(false);
    void voiceAgent.start(apiKey);
  }, [voiceAgent, voiceAgentKeyInput]);

  useEffect(() => {
    if (!voiceAgent.error) return;
    const lower = voiceAgent.error.toLowerCase();
    const isApiKeyError =
      lower.includes("api key") ||
      lower.includes("unauthorized") ||
      lower.includes("401");
    if (!isApiKeyError) return;
    voiceAgentApiKeyRef.current = "";
    setVoiceAgentKeyInput("");
    setVoiceAgentKeyPromptError("API key rejected. Enter a valid key.");
    setIsVoiceAgentKeyPromptOpen(true);
  }, [voiceAgent.error]);

  const handleStopVoiceAgent = useCallback(() => {
    voiceAgentApiKeyRef.current = "";
    setVoiceAgentKeyInput("");
    setVoiceAgentKeyPromptError(null);
    setIsVoiceAgentKeyPromptOpen(false);
    voiceAgent.stop();
  }, [voiceAgent]);

  const { mounted } = useMeetLifecycle({
    cleanup: socket.cleanup,
    abortControllerRef: refs.abortControllerRef,
  });

  const isMobile = useIsMobile();

  useEffect(() => {
    if (isAdminFlag && connectionState !== "joined") {
      refreshRooms();
    }
  }, [isAdminFlag, connectionState, refreshRooms]);

  const joinRoomById = socket.joinRoomById;
  const getMeetingConfig = socket.getMeetingConfig;
  const getWebinarConfig = socket.getWebinarConfig;

  useEffect(() => {
    if (connectionState !== "joined") return;
    if (!isAdminFlag) return;
    void getMeetingConfig?.();
    void getWebinarConfig?.();
  }, [connectionState, isAdminFlag, getMeetingConfig, getWebinarConfig]);

  const handleSignOut = useCallback(async () => {
    if (isSigningOut) return;
    setIsSigningOut(true);
    if (isGuestUser(currentUser)) {
      clearGuestStorage();
      setCurrentUser(undefined);
      setCurrentIsAdmin(false);
      setIsSigningOut(false);
      return;
    }

    try {
      await signOut();
      clearGuestStorage();
      setCurrentUser(undefined);
      setCurrentIsAdmin(false);
    } catch (error) {
      console.error("Sign out error:", error);
    } finally {
      setIsSigningOut(false);
    }
  }, [clearGuestStorage, currentUser, isSigningOut]);

  const leaveRoom = useCallback(() => {
    handleStopVoiceAgent();
    playNotificationSoundForEvents("leave");
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

  useEffect(() => {
    return () => {
      voiceAgentApiKeyRef.current = "";
    };
  }, []);

  const toggleBrowserAudio = useCallback(() => {
    setBrowserAudioNeedsGesture(false);
    setIsBrowserAudioMuted((prev) => !prev);
  }, [setIsBrowserAudioMuted]);

  const handleBrowserAudioAutoplayBlocked = useCallback(() => {
    setBrowserAudioNeedsGesture(true);
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

    checkBrowserService();
    const interval = setInterval(checkBrowserService, 30000);
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

  const { presentationStream, presenterName } = useMemo(() => {
    let nextStream: MediaStream | null = null;
    let nextPresenterName = "";

    if (isScreenSharing && localScreenShareStream) {
      nextStream = localScreenShareStream;
      nextPresenterName = "You";
    } else if (activeScreenShareId) {
      // Prefer the participant whose screen producer matches the ACTIVE id so
      // the staged stream + "X is presenting" always correspond to the right
      // sharer; fall back to any present share so the stage is never blank.
      let matchedStream: MediaStream | null = null;
      let matchedName = "";
      let anyStream: MediaStream | null = null;
      let anyName = "";
      for (const participant of participants.values()) {
        if (!participant.screenShareStream) continue;
        if (!anyStream) {
          anyStream = participant.screenShareStream;
          anyName = resolveDisplayName(participant.userId);
        }
        if (participant.screenShareProducerId === activeScreenShareId) {
          matchedStream = participant.screenShareStream;
          matchedName = resolveDisplayName(participant.userId);
          break;
        }
      }
      nextStream = matchedStream ?? anyStream;
      nextPresenterName = matchedStream ? matchedName : anyName;
    }

    return { presentationStream: nextStream, presenterName: nextPresenterName };
  }, [
    activeScreenShareId,
    isScreenSharing,
    localScreenShareStream,
    participants,
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
      userEmail,
      getDisplayName: resolveDisplayName,
      onToggleMute: toggleMute,
      onToggleCamera: toggleCamera,
      onLeave: leaveRoom,
    });

  useHotkey(HOTKEYS.toggleLockMeeting.keys as RegisterableHotkey, () => {
    if (isAdminFlag) {
      socket.toggleRoomLock(!isRoomLocked);
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
      openPopout();
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
  const { quality: selfConnectionQuality } = useConnectionQuality({
    producerTransportRef: refs.producerTransportRef,
    consumerTransportRef: refs.consumerTransportRef,
    enabled: connectionState === "joined",
  });

  if (!mounted) return null;

  const isJoined = connectionState === "joined";
  const isLoading =
    connectionState === "connecting" ||
    connectionState === "joining" ||
    connectionState === "reconnecting" ||
    connectionState === "waiting";

  const renderWithApps = (content: React.ReactNode) => (
    <AppsProvider
      socket={appsSocket}
      user={appsUser}
      isAdmin={isAdminFlag}
      uploadAsset={uploadAsset}
    >
      {content}
    </AppsProvider>
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
  const voiceAgentKeyPrompt = isVoiceAgentKeyPromptOpen ? (
    <div className="fixed inset-0 z-[145] flex items-center justify-center bg-black/75 px-4">
      <div className="w-full max-w-sm rounded-2xl border border-white/10 bg-[#111111] p-5 shadow-2xl">
        <h2 className="text-sm font-semibold text-[#fafafa]">
          Voice Agent API Key
        </h2>
        <p className="mt-1 text-xs text-[#fafafa]/75">
          Enter your own OpenAI API key. It stays in-memory in this tab and is
          sent directly to OpenAI, never to this server.
        </p>
        <input
          type="password"
          value={voiceAgentKeyInput}
          onChange={(event) => {
            setVoiceAgentKeyInput(event.target.value);
            if (voiceAgentKeyPromptError) {
              setVoiceAgentKeyPromptError(null);
            }
          }}
          autoFocus
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          autoComplete="off"
          placeholder="sk-..."
          className="mt-4 w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2.5 text-sm text-[#fafafa] outline-none focus:border-[#fafafa]/35"
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              handleSubmitVoiceAgentKeyPrompt();
            }
            if (event.key === "Escape") {
              event.preventDefault();
              closeVoiceAgentKeyPrompt();
            }
          }}
        />
        {voiceAgentKeyPromptError ? (
          <p className="mt-2 text-xs text-[#F95F4A]">{voiceAgentKeyPromptError}</p>
        ) : null}
        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={closeVoiceAgentKeyPrompt}
            className="rounded-xl border border-white/15 px-3 py-2 text-[11px] uppercase tracking-[0.14em] text-[#fafafa]/82 transition-colors hover:border-white/25 hover:text-[#fafafa]"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmitVoiceAgentKeyPrompt}
            className="rounded-xl bg-[#F95F4A] px-3 py-2 text-[11px] uppercase tracking-[0.14em] text-white transition-opacity hover:opacity-90"
          >
            Save & Start
          </button>
        </div>
      </div>
    </div>
  ) : null;

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
        isAdmin={isAdminFlag}
      />,
    );
  }

  if (isMobile) {
    return renderWithApps(
      <div
        className={`flex flex-col h-dvh w-full bg-[#131316] text-white ${fontClassName ?? ""}`}
      >
        {isJoined && meetError && (
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
        <MobileMeetsMainContent
          isJoined={isJoined}
          connectionState={connectionState}
          isLoading={isLoading}
          roomId={roomId}
          setRoomId={setRoomId}
          joinRoomById={joinRoomById}
          hideJoinUI={hideJoinUI || joinMode === "webinar_attendee"}
          isWebinarAttendee={isWebinarAttendee}
          enableRoomRouting={enableRoomRouting}
          forceJoinOnly={forceJoinOnly}
          allowGhostMode={allowGhostMode}
          user={currentUser}
          userEmail={userEmail}
          isAdmin={isAdminFlag}
          showPermissionHint={showPermissionHint}
          displayNameInput={displayNameInput}
          setDisplayNameInput={setDisplayNameInput}
          ghostEnabled={ghostEnabled}
          setIsGhostMode={setIsGhostMode}
          presentationStream={presentationStream}
          presenterName={presenterName || ""}
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
          onPrejoinMediaCommit={handlePrejoinMediaCommit}
          isCameraOff={isCameraOff}
          isMuted={isMuted}
          isMuteTogglePending={isMuteTogglePending}
          isHandRaised={isHandRaised}
          participants={participants}
          isMirrorCamera={isMirrorCamera}
          activeSpeakerId={effectiveActiveSpeakerId}
          currentUserId={userId}
          selectedAudioInputDeviceId={selectedAudioInputDeviceId}
          audioOutputDeviceId={selectedAudioOutputDeviceId}
          onAudioInputDeviceChange={handleAudioInputDeviceChange}
          onAudioOutputDeviceChange={handleAudioOutputDeviceChange}
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
          isParticipantsOpen={isParticipantsOpen}
          setIsParticipantsOpen={setIsParticipantsOpen}
          pendingUsers={pendingUsers}
          chatMessages={chatMessages}
          chatInput={chatInput}
          setChatInput={setChatInput}
          sendChat={sendChat}
          chatOverlayMessages={chatOverlayMessages}
          setChatOverlayMessages={setChatOverlayMessages}
          socket={refs.socketRef.current}
          setPendingUsers={setPendingUsers}
          resolveDisplayName={resolveDisplayName}
          reactions={reactionEvents}
          onUserChange={(user) => setCurrentUser(user ?? undefined)}
          onIsAdminChange={setCurrentIsAdmin}
          isRoomLocked={isRoomLocked}
          isNoGuests={isNoGuests}
          onToggleNoGuests={() => socket.toggleNoGuests(!isNoGuests)}
          isTtsDisabled={isTtsDisabled}
          isDmEnabled={isDmEnabled}
          onToggleLock={() => socket.toggleRoomLock(!isRoomLocked)}
          isChatLocked={isChatLocked}
          onToggleChatLock={() => socket.toggleChatLock(!isChatLocked)}
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
          onBrowserAudioAutoplayBlocked={handleBrowserAudioAutoplayBlocked}
          meetError={meetError}
          onDismissMeetError={() => setMeetError(null)}
          onRetryMedia={handleRetryMedia}
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
          onGetMeetingConfig={socket.getMeetingConfig}
          onUpdateMeetingConfig={socket.updateMeetingConfig}
          onGetWebinarConfig={socket.getWebinarConfig}
          onUpdateWebinarConfig={socket.updateWebinarConfig}
          onGenerateWebinarLink={socket.generateWebinarLink}
          onRotateWebinarLink={socket.rotateWebinarLink}
          isVoiceAgentRunning={voiceAgent.isRunning}
          isVoiceAgentStarting={voiceAgent.isStarting}
          voiceAgentError={voiceAgent.error}
          onStartVoiceAgent={handleStartVoiceAgent}
          onStopVoiceAgent={handleStopVoiceAgent}
          onClearVoiceAgentError={voiceAgent.clearError}
        />
        {inviteCodePrompt}
        {voiceAgentKeyPrompt}
      </div>,
    );
  }

  return renderWithApps(
    <div
      className={`flex flex-col h-full w-full bg-[#18181b] text-white ${fontClassName ?? ""}`}
    >
      <MeetsHeader isJoined={isJoined} />
      {isJoined && meetError && (
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
        connectionState={connectionState}
        selfConnectionQuality={selfConnectionQuality}
        isLoading={isLoading}
        roomId={roomId}
        setRoomId={setRoomId}
        joinRoomById={joinRoomById}
        hideJoinUI={hideJoinUI || joinMode === "webinar_attendee"}
        isWebinarAttendee={isWebinarAttendee}
        enableRoomRouting={enableRoomRouting}
        forceJoinOnly={forceJoinOnly}
        allowGhostMode={allowGhostMode}
        user={currentUser}
        userEmail={userEmail}
        isAdmin={isAdminFlag}
        showPermissionHint={showPermissionHint}
        availableRooms={availableRooms}
        roomsStatus={roomsStatus}
        refreshRooms={refreshRooms}
        displayNameInput={displayNameInput}
        setDisplayNameInput={setDisplayNameInput}
        ghostEnabled={ghostEnabled}
        setIsGhostMode={setIsGhostMode}
        presentationStream={presentationStream}
        presenterName={presenterName || ""}
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
        onDevCameraStreamChange={setDevCameraStream}
        onPrejoinMediaCommit={handlePrejoinMediaCommit}
        isCameraOff={isCameraOff}
        isMuted={isMuted}
        isMuteTogglePending={isMuteTogglePending}
        isHandRaised={isHandRaised}
        participants={participants}
        isMirrorCamera={isMirrorCamera}
        onToggleMirror={() => setIsMirrorCamera((prev) => !prev)}
        selectedAudioInputDeviceId={selectedAudioInputDeviceId}
        selectedAudioOutputDeviceId={selectedAudioOutputDeviceId}
        selectedVideoInputDeviceId={selectedVideoInputDeviceId}
        onAudioInputDeviceChange={handleAudioInputDeviceChange}
        onAudioOutputDeviceChange={handleAudioOutputDeviceChange}
        onVideoInputDeviceChange={handleVideoInputDeviceSelect}
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
        isParticipantsOpen={isParticipantsOpen}
        setIsParticipantsOpen={setIsParticipantsOpen}
        pendingUsers={pendingUsers}
        chatMessages={chatMessages}
        chatInput={chatInput}
        setChatInput={setChatInput}
        sendChat={sendChat}
        chatOverlayMessages={chatOverlayMessages}
        setChatOverlayMessages={setChatOverlayMessages}
        socket={refs.socketRef.current}
        setPendingUsers={setPendingUsers}
        resolveDisplayName={resolveDisplayName}
        reactions={reactionEvents}
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
        onToggleLock={() => socket.toggleRoomLock(!isRoomLocked)}
        isNoGuests={isNoGuests}
        onToggleNoGuests={() => socket.toggleNoGuests(!isNoGuests)}
        isChatLocked={isChatLocked}
        onToggleChatLock={() => socket.toggleChatLock(!isChatLocked)}
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
        onBrowserAudioAutoplayBlocked={handleBrowserAudioAutoplayBlocked}
        meetError={meetError}
        onDismissMeetError={() => setMeetError(null)}
        onRetryMedia={handleRetryMedia}
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
        onGetMeetingConfig={socket.getMeetingConfig}
        onUpdateMeetingConfig={socket.updateMeetingConfig}
        onGetWebinarConfig={socket.getWebinarConfig}
        onUpdateWebinarConfig={socket.updateWebinarConfig}
        onGenerateWebinarLink={socket.generateWebinarLink}
        onRotateWebinarLink={socket.rotateWebinarLink}
        isVoiceAgentRunning={voiceAgent.isRunning}
        isVoiceAgentStarting={voiceAgent.isStarting}
        voiceAgentError={voiceAgent.error}
        onStartVoiceAgent={handleStartVoiceAgent}
        onStopVoiceAgent={handleStopVoiceAgent}
        onClearVoiceAgentError={voiceAgent.clearError}
      />
      {inviteCodePrompt}
      {voiceAgentKeyPrompt}
    </div>,
  );
}

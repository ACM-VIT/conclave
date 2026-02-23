import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "expo-router";
import type { Socket } from "socket.io-client";
import { StatusBar } from "expo-status-bar";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import {
  AppState,
  BackHandler,
  Linking,
  NativeModules,
  Platform,
  StyleSheet,
  findNodeHandle,
  type ViewProps,
} from "react-native";
import { ScreenCapturePickerView } from "react-native-webrtc";
import {
  ensureCallKeep,
  endCallSession,
  registerCallKeepHandlers,
  setAudioRoute,
  setCallMuted,
  startCallSession,
  startForegroundCallService,
  startInCall,
  stopForegroundCallService,
  stopInCall,
  updateForegroundCallService,
  registerForegroundCallServiceHandlers,
} from "@/lib/call-service";
import { ensureWebRTCGlobals } from "@/lib/webrtc";
import { Pressable, Text, TextInput, View } from "@/tw";
import { reactionAssetList } from "../reaction-assets";
import { claimMeetingSession, registerMeetingSession } from "../meeting-session-coordinator";
import { useMeetAudioActivity } from "../hooks/use-meet-audio-activity";
import { useMeetChat } from "../hooks/use-meet-chat";
import { useMeetDisplayName } from "../hooks/use-meet-display-name";
import { useMeetHandRaise } from "../hooks/use-meet-hand-raise";
import { useMeetLifecycle } from "../hooks/use-meet-lifecycle";
import { useMeetMedia } from "../hooks/use-meet-media";
import { useMeetMediaSettings } from "../hooks/use-meet-media-settings";
import { useMeetReactions } from "../hooks/use-meet-reactions";
import { useMeetRefs } from "../hooks/use-meet-refs";
import { useMeetSocket } from "../hooks/use-meet-socket";
import { useMeetState } from "../hooks/use-meet-state";
import { useMeetTts } from "../hooks/use-meet-tts";
import { useDeviceLayout } from "../hooks/use-device-layout";
import type { JoinMode, Participant } from "../types";
import { createMeetError, isSystemUserId } from "../utils";
import { getCachedUser, hydrateCachedUser, setCachedUser } from "../auth-session";
import { CallScreen } from "./call-screen";
import { ChatPanel } from "./chat-panel";
import { DisplayNameSheet } from "./display-name-sheet";
import { ErrorSheet } from "./error-sheet";
import { JoinScreen } from "./join-screen";
import { PendingJoinToast } from "./pending-join-toast";
import { ParticipantsPanel } from "./participants-panel";
import { ReactionOverlay } from "./reaction-overlay";
import { ReactionSheet } from "./reaction-sheet";
import { SettingsSheet } from "./settings-sheet";
import {
  AppsProvider,
  createAssetUploadHandler,
  registerApps,
} from "@conclave/apps-sdk";
import { whiteboardApp } from "@conclave/apps-sdk/whiteboard/native";

const clientId = process.env.EXPO_PUBLIC_SFU_CLIENT_ID || "public";
const apiBaseUrl =
  process.env.EXPO_PUBLIC_SFU_BASE_URL ||
  process.env.EXPO_PUBLIC_API_URL ||
  "";

const buildApiUrl = (path: string) => {
  if (!apiBaseUrl) return path;
  return `${apiBaseUrl.replace(/\/$/, "")}${path}`;
};

const readError = async (response: Response) => {
  const data = await response.json().catch(() => null);
  if (data && typeof data === "object" && "error" in data) {
    return String((data as { error?: string }).error || "Request failed");
  }
  return response.statusText || "Request failed";
};

interface MeetScreenProps {
  initialRoomId?: string;
  joinMode?: JoinMode;
  webinarSignedToken?: string;
  autoJoinOnMount?: boolean;
  hideJoinUI?: boolean;
}

export function MeetScreen({
  initialRoomId,
  joinMode = "meeting",
  webinarSignedToken,
  autoJoinOnMount = false,
  hideJoinUI = false,
}: MeetScreenProps = {}) {
  if (process.env.EXPO_OS !== "web") {
    ensureWebRTCGlobals();
  }

  const router = useRouter();
  const { isTablet } = useDeviceLayout();
  const refs = useMeetRefs();
  const meetingSessionIdRef = useRef(`meet-screen:${refs.sessionIdRef.current}`);
  const [appsSocket, setAppsSocket] = useState<Socket | null>(null);
  const uploadAsset = useMemo(
    () =>
      createAssetUploadHandler({
        baseUrl: apiBaseUrl || undefined,
      }),
    []
  );
  const [isAppActive, setIsAppActive] = useState(AppState.currentState === "active");
  const isAppActiveRef = useRef(AppState.currentState === "active");
  const wasCameraOnBeforeBackgroundRef = useRef(false);
  const wasMutedBeforeBackgroundRef = useRef(true);
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
    screenShareStream,
    setScreenShareStream,
    isHandRaised,
    setIsHandRaised,
    isGhostMode,
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
    setPendingUsers,
    isParticipantsOpen,
    setIsParticipantsOpen,
    pendingUsers,
    isRoomLocked,
    setIsRoomLocked,
    isNoGuests,
    setIsNoGuests,
    isChatLocked,
    setIsChatLocked,
    isTtsDisabled,
    setIsTtsDisabled,
    hostUserId,
    setHostUserId,
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
  } = useMeetState({ initialRoomId });
  const isWebinarAttendee =
    joinMode === "webinar_attendee" || webinarRole === "attendee";
  const isWebinarSession = isWebinarAttendee || Boolean(webinarConfig?.enabled);
  const effectiveGhostMode = isGhostMode || isWebinarAttendee;

  useEffect(() => {
    registerApps([whiteboardApp]);
  }, []);
  const isCameraOffRef = useRef(isCameraOff);
  const isMutedRef = useRef(isMuted);
  const isScreenSharingRef = useRef(isScreenSharing);
  const hasActiveCallRef = useRef(false);
  const connectionStateRef = useRef(connectionState);
  const shouldKeepAliveInBackground = isScreenSharing || !!activeScreenShareId;

  const {
    videoQuality,
    setVideoQuality,
    isMirrorCamera,
    selectedAudioInputDeviceId,
    setSelectedAudioInputDeviceId,
    selectedAudioOutputDeviceId,
    setSelectedAudioOutputDeviceId,
  } = useMeetMediaSettings({ videoQualityRef: refs.videoQualityRef });

  const guestSessionId = refs.sessionIdRef.current;
  const guestIdentity = useMemo(
    () => ({
      id: `guest-${guestSessionId}`,
      email: `guest-${guestSessionId}@guest.com`,
      name: "Guest",
    }),
    [guestSessionId]
  );
  const cachedUser = getCachedUser();
  const [currentUser, setCurrentUser] = useState<
    { id?: string; email?: string | null; name?: string | null } | null
  >(cachedUser ?? guestIdentity);
  const [authHydrated, setAuthHydrated] = useState(false);

  useEffect(() => {
    let isMounted = true;
    hydrateCachedUser()
      .then((user) => {
        if (!isMounted) return;
        if (user && !user.id?.startsWith("guest-")) {
          setCurrentUser(user);
        }
        setAuthHydrated(true);
      })
      .catch(() => {
        if (!isMounted) return;
        setAuthHydrated(true);
      });
    return () => {
      isMounted = false;
    };
  }, []);
  useEffect(() => {
    if (!authHydrated) return;
    if (!currentUser || currentUser.id?.startsWith("guest-")) {
      setCurrentUser(guestIdentity);
    }
  }, [authHydrated, currentUser, guestIdentity]);
  const handleUserChange = useCallback(
    (nextUser: { id?: string; email?: string | null; name?: string | null } | null) => {
      setCurrentUser(nextUser);
      if (nextUser && !nextUser.id?.startsWith("guest-")) {
        void setCachedUser(nextUser);
      } else {
        void setCachedUser(null);
      }
    },
    []
  );
  const user = currentUser ?? guestIdentity;
  const [isAdmin, setIsAdmin] = useState(false);
  const [hasActiveCall, setHasActiveCall] = useState(false);
  const [isDisplayNameSheetOpen, setIsDisplayNameSheetOpen] = useState(false);
  const [isScreenSharePending, setIsScreenSharePending] = useState(false);
  const screenShareRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );
  const screenShareRequestTokenRef = useRef(0);
  const [pendingToast, setPendingToast] = useState<{
    userId: string;
    displayName: string;
    count: number;
  } | null>(null);
  const pendingToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingToastSeenRef = useRef<Set<string>>(new Set());

  const userKey = user?.email || user?.id || `guest-${guestSessionId}`;
  const userId = `${userKey}#${refs.sessionIdRef.current}`;

  const {
    setDisplayNames,
    displayNameInput,
    setDisplayNameInput,
    displayNameStatus,
    isDisplayNameUpdating,
    handleDisplayNameSubmit,
    canUpdateDisplayName,
    resolveDisplayName,
  } = useMeetDisplayName({
    user,
    userId,
    isAdmin,
    ghostEnabled: isGhostMode,
    socketRef: refs.socketRef,
    joinOptionsRef: refs.joinOptionsRef,
  });
  const appsUser = useMemo(
    () => ({
      id: userId,
      name: displayNameInput || user?.name || user?.email || user?.id || "Guest",
      email: user?.email ?? null,
    }),
    [userId, displayNameInput, user]
  );

  const joinUser = useMemo(
    () => ({
      ...guestIdentity,
      name: displayNameInput?.trim() || guestIdentity.name,
    }),
    [displayNameInput, guestIdentity]
  );

  const {
    reactions,
    reactionOptions,
    addReaction,
    sendReaction,
    clearReactions,
  } = useMeetReactions({
    userId,
    socketRef: refs.socketRef,
    ghostEnabled: effectiveGhostMode,
    reactionAssets: reactionAssetList.slice(),
  });

  const { ttsSpeakerId, handleTtsMessage } = useMeetTts();

  const {
    mediaState,
    showPermissionHint,
    requestMediaPermissions,
    handleAudioInputDeviceChange,
    handleAudioOutputDeviceChange,
    updateVideoQualityRef,
    toggleMute,
    toggleCamera,
    toggleScreenShare,
    stopScreenShare,
    stopLocalTrack,
    handleLocalTrackEnded,
    playNotificationSound,
    primeAudioOutput,
    startAudioKeepAlive,
    stopAudioKeepAlive,
  } = useMeetMedia({
    ghostEnabled: effectiveGhostMode,
    connectionState,
    isMuted,
    setIsMuted,
    isCameraOff,
    setIsCameraOff,
    isScreenSharing,
    setIsScreenSharing,
    setScreenShareStream,
    screenShareStreamRef: refs.screenShareStreamRef,
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
    socketRef: refs.socketRef,
    producerTransportRef: refs.producerTransportRef,
    audioProducerRef: refs.audioProducerRef,
    videoProducerRef: refs.videoProducerRef,
    screenProducerRef: refs.screenProducerRef,
    localStreamRef: refs.localStreamRef,
    intentionalTrackStopsRef: refs.intentionalTrackStopsRef,
    permissionHintTimeoutRef: refs.permissionHintTimeoutRef,
    audioContextRef: refs.audioContextRef,
  });

  const participantCount = useMemo(() => {
    let count = 1; // include local user
    participants.forEach((participant) => {
      if (!isSystemUserId(participant.userId)) {
        count += 1;
      }
    });
    return count;
  }, [participants]);

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
    (type: "join" | "leave" | "waiting") => {
      if ((type === "join" || type === "leave") && !shouldPlayJoinLeaveSound(type)) {
        return;
      }
      playNotificationSound(type);
    },
    [playNotificationSound, shouldPlayJoinLeaveSound]
  );

  const isJoined = connectionState === "joined";
  const effectiveActiveSpeakerId = ttsSpeakerId ?? activeSpeakerId;
  const isLoading =
    connectionState === "connecting" ||
    connectionState === "joining" ||
    connectionState === "reconnecting" ||
    connectionState === "waiting";
  const blockBackNavigation =
    hasActiveCall ||
    isJoined ||
    connectionState === "connecting" ||
    connectionState === "joining" ||
    connectionState === "reconnecting" ||
    connectionState === "waiting";

  const forceReconnect = useCallback(() => {
    if (!hasActiveCall) return;
    if (connectionState === "joined") return;
    refs.reconnectAttemptsRef.current = 0;
    refs.reconnectInFlightRef.current = false;
    refs.handleReconnectRef.current?.({ immediate: true });
  }, [connectionState, hasActiveCall, refs]);

  useEffect(() => {
    if (isJoined) {
      setHasActiveCall(true);
    }
  }, [isJoined]);

  useEffect(() => {
    isCameraOffRef.current = isCameraOff;
  }, [isCameraOff]);

  useEffect(() => {
    isMutedRef.current = isMuted;
  }, [isMuted]);

  useEffect(() => {
    isScreenSharingRef.current = isScreenSharing;
  }, [isScreenSharing]);

  useEffect(() => {
    hasActiveCallRef.current = hasActiveCall;
  }, [hasActiveCall]);

  useEffect(() => {
    connectionStateRef.current = connectionState;
  }, [connectionState]);

  useEffect(() => {
    if (
      (connectionState === "disconnected" || connectionState === "error") &&
      refs.intentionalDisconnectRef.current
    ) {
      setHasActiveCall(false);
    }
  }, [connectionState, refs.intentionalDisconnectRef]);

  useEffect(() => {
    if (meetError && !meetError.recoverable && !isJoined) {
      setHasActiveCall(false);
    }
  }, [meetError, isJoined]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      const isActive = state === "active";
      isAppActiveRef.current = isActive;
      setIsAppActive(isActive);
      if (!isJoined && !hasActiveCall) return;

      if (!isActive) {
        wasCameraOnBeforeBackgroundRef.current = !isCameraOff;
        wasMutedBeforeBackgroundRef.current = isMuted;
        if (Platform.OS === "ios" && shouldKeepAliveInBackground) {
          startAudioKeepAlive();
        } else if (Platform.OS === "ios") {
          stopAudioKeepAlive();
        }
        return;
      }

      if (Platform.OS === "android") {
        forceReconnect();
      }

      if (Platform.OS === "ios") {
        stopAudioKeepAlive();
      }
      if (wasCameraOnBeforeBackgroundRef.current && isCameraOff) {
        void toggleCamera();
      }
      if (!wasMutedBeforeBackgroundRef.current && isMuted) {
        void toggleMute();
      }
    });
    return () => {
      subscription.remove();
    };
  }, [
    isJoined,
    hasActiveCall,
    isCameraOff,
    isMuted,
    toggleCamera,
    toggleMute,
    startAudioKeepAlive,
    stopAudioKeepAlive,
    shouldKeepAliveInBackground,
    forceReconnect,
  ]);

  useEffect(() => {
    if (Platform.OS !== "ios") return;
    if (!isJoined || isAppActiveRef.current) {
      stopAudioKeepAlive();
      return;
    }
    if (shouldKeepAliveInBackground) {
      startAudioKeepAlive();
    } else {
      stopAudioKeepAlive();
    }
  }, [isJoined, shouldKeepAliveInBackground, startAudioKeepAlive, stopAudioKeepAlive]);

  const { toggleHandRaised, setHandRaisedState } = useMeetHandRaise({
    isHandRaised,
    setIsHandRaised,
    isHandRaisedRef: refs.isHandRaisedRef,
    ghostEnabled: effectiveGhostMode,
    socketRef: refs.socketRef,
  });

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
    ghostEnabled: effectiveGhostMode,
    isChatLocked,
    isAdmin,
    isTtsDisabled,
    isMuted,
    isCameraOff,
    onToggleMute: toggleMute,
    onToggleCamera: toggleCamera,
    onSetHandRaised: setHandRaisedState,
    onTtsMessage: handleTtsMessage,
  });

  const inviteCodeResolverRef = useRef<((value: string | null) => void) | null>(
    null,
  );
  const takeoverResolverRef = useRef<((value: boolean) => void) | null>(null);
  const [isInviteCodePromptOpen, setIsInviteCodePromptOpen] = useState(false);
  const [inviteCodePromptMode, setInviteCodePromptMode] = useState<
    "meeting" | "webinar"
  >("webinar");
  const [inviteCodeInput, setInviteCodeInput] = useState("");
  const [inviteCodePromptError, setInviteCodePromptError] = useState<
    string | null
  >(null);
  const [isTakeoverPromptOpen, setIsTakeoverPromptOpen] = useState(false);
  const [takeoverPromptRoomLabel, setTakeoverPromptRoomLabel] = useState(
    "your current meeting"
  );

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

  const resolveTakeoverPrompt = useCallback((value: boolean) => {
    takeoverResolverRef.current?.(value);
    takeoverResolverRef.current = null;
    setIsTakeoverPromptOpen(false);
    setTakeoverPromptRoomLabel("your current meeting");
  }, []);

  const handleTakeoverPromptStay = useCallback(() => {
    resolveTakeoverPrompt(false);
  }, [resolveTakeoverPrompt]);

  const handleTakeoverPromptJoin = useCallback(() => {
    resolveTakeoverPrompt(true);
  }, [resolveTakeoverPrompt]);

  const confirmMeetingHandoff = useCallback((currentRoomId: string | null) => {
    return new Promise<boolean>((resolve) => {
      if (takeoverResolverRef.current) {
        takeoverResolverRef.current(false);
        takeoverResolverRef.current = null;
      }
      takeoverResolverRef.current = resolve;
      setTakeoverPromptRoomLabel(
        currentRoomId?.trim()
          ? currentRoomId.toUpperCase()
          : "your current meeting"
      );
      setIsTakeoverPromptOpen(true);
    });
  }, []);

  useEffect(() => {
    return () => {
      if (inviteCodeResolverRef.current) {
        inviteCodeResolverRef.current(null);
        inviteCodeResolverRef.current = null;
      }
      if (takeoverResolverRef.current) {
        takeoverResolverRef.current(false);
        takeoverResolverRef.current = null;
      }
    };
  }, []);

  const socket = useMeetSocket({
    refs,
    roomId,
    setRoomId,
    isAdmin,
    setIsAdmin,
    user,
    userId,
    getJoinInfo: useCallback(
      async (targetRoomId: string, sessionId: string, options) => {
        if (!apiBaseUrl) {
          throw new Error("Missing EXPO_PUBLIC_SFU_BASE_URL for mobile API");
        }
        const resolvedJoinMode = options?.joinMode ?? joinMode;
        const resolvedWebinarSignedToken =
          options?.webinarSignedToken ?? webinarSignedToken;
        const response = await fetch(buildApiUrl("/api/sfu/join"), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-sfu-client": clientId,
          },
          body: JSON.stringify({
            roomId: targetRoomId,
            sessionId,
            user: options?.user,
            isHost: options?.isHost,
            isAdmin: options?.isHost,
            clientId,
            joinMode: resolvedJoinMode,
            webinarSignedToken: resolvedWebinarSignedToken,
          }),
        });

        if (!response.ok) {
          throw new Error(await readError(response));
        }

        return response.json();
      },
      [joinMode, webinarSignedToken]
    ),
    joinMode,
    webinarSignedToken,
    ghostEnabled: isGhostMode,
    displayNameInput,
    localStream,
    setLocalStream,
    dispatchParticipants,
    setDisplayNames,
    setPendingUsers,
    setConnectionState,
    setMeetError,
    setWaitingMessage,
    setHostUserId,
    setServerRestartNotice,
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
    onTtsMessage: handleTtsMessage,
    chat: {
      setChatMessages,
      setChatOverlayMessages,
      setUnreadCount,
      isChatOpenRef,
    },
    requestMeetingInviteCode,
    requestWebinarInviteCode,
    isAppActiveRef,
    onSocketReady: setAppsSocket,
  });

  const dismissPendingToast = useCallback(() => {
    if (pendingToastTimerRef.current) {
      clearTimeout(pendingToastTimerRef.current);
      pendingToastTimerRef.current = null;
    }
    setPendingToast(null);
  }, []);

  const showPendingToast = useCallback(
    (userId: string, displayName: string, count: number) => {
      if (pendingToastTimerRef.current) {
        clearTimeout(pendingToastTimerRef.current);
      }
      setPendingToast({ userId, displayName, count });
      pendingToastTimerRef.current = setTimeout(() => {
        setPendingToast(null);
        pendingToastTimerRef.current = null;
      }, 6000);
    },
    []
  );

  useEffect(() => {
    if (!isAdmin || !isJoined) {
      pendingToastSeenRef.current = new Set();
      dismissPendingToast();
      return;
    }

    const currentIds = new Set(pendingUsers.keys());
    const previousIds = pendingToastSeenRef.current;
    const newIds = Array.from(currentIds).filter((id) => !previousIds.has(id));
    pendingToastSeenRef.current = currentIds;

    if (newIds.length > 0) {
      const latestId = newIds[newIds.length - 1];
      const displayName = pendingUsers.get(latestId) || latestId;
      showPendingToast(latestId, displayName, currentIds.size);
    } else if (currentIds.size === 0) {
      dismissPendingToast();
    } else if (pendingToast && pendingToast.count !== currentIds.size) {
      setPendingToast((prev) =>
        prev ? { ...prev, count: currentIds.size } : prev
      );
    }
  }, [
    isAdmin,
    isJoined,
    pendingUsers,
    pendingToast,
    dismissPendingToast,
    showPendingToast,
  ]);

  useEffect(() => {
    return () => {
      if (pendingToastTimerRef.current) {
        clearTimeout(pendingToastTimerRef.current);
      }
    };
  }, []);

  useMeetAudioActivity({
    enabled: isJoined && isAppActive,
    participants,
    localStream,
    isMuted,
    userId,
    setActiveSpeakerId,
    audioContextRef: refs.audioContextRef,
    audioAnalyserMapRef: refs.audioAnalyserMapRef,
    lastActiveSpeakerRef: refs.lastActiveSpeakerRef,
  });

  const { mounted } = useMeetLifecycle({
    cleanup: socket.cleanup,
    abortControllerRef: refs.abortControllerRef,
  });

  const roomIdRef = useRef(roomId);
  roomIdRef.current = roomId;

  const displayNameRef = useRef(displayNameInput);
  displayNameRef.current = displayNameInput;

  useEffect(() => {
    if (isJoined) {
      void activateKeepAwakeAsync("conclave-call");
      return () => {
        void deactivateKeepAwake("conclave-call");
      };
    }
    void deactivateKeepAwake("conclave-call");
    return undefined;
  }, [isJoined]);

  const callIdRef = useRef<string | null>(null);
  const socketCleanupRef = useRef(socket.cleanup);
  socketCleanupRef.current = socket.cleanup;

  const playNotificationSoundRef = useRef(playNotificationSoundForEvents);
  playNotificationSoundRef.current = playNotificationSoundForEvents;

  const stopScreenShareRef = useRef(stopScreenShare);
  stopScreenShareRef.current = stopScreenShare;

  const cancelPendingScreenShareStart = useCallback(() => {
    screenShareRequestTokenRef.current += 1;
    if (screenShareRetryTimerRef.current) {
      clearTimeout(screenShareRetryTimerRef.current);
      screenShareRetryTimerRef.current = null;
    }
    setIsScreenSharePending(false);
  }, []);

  const exitCurrentMeeting = useCallback((options?: { playLeaveSound?: boolean }) => {
    const playLeaveSound = options?.playLeaveSound !== false;
    setHasActiveCall(false);
    hasActiveCallRef.current = false;
    if (playLeaveSound) {
      playNotificationSoundRef.current("leave");
    }
    cancelPendingScreenShareStart();
    stopScreenShareRef.current({ notify: true });
    socketCleanupRef.current();
    if (callIdRef.current) {
      endCallSession(callIdRef.current);
      callIdRef.current = null;
    }
    stopInCall();
  }, [cancelPendingScreenShareStart]);

  const handleLeave = useCallback(() => {
    exitCurrentMeeting({ playLeaveSound: true });
    if (hideJoinUI) {
      router.replace("/");
    }
  }, [exitCurrentMeeting, hideJoinUI, router]);

  useEffect(() => {
    if (!isWebinarSession || !isParticipantsOpen) return;
    setIsParticipantsOpen(false);
  }, [isParticipantsOpen, isWebinarSession, setIsParticipantsOpen]);

  useEffect(() => {
    const unregister = registerMeetingSession(meetingSessionIdRef.current, {
      getSnapshot: () => ({
        roomId: refs.currentRoomIdRef.current ?? roomIdRef.current ?? null,
        connectionState: connectionStateRef.current,
        hasActiveCall: hasActiveCallRef.current,
      }),
      relinquish: async () => {
        exitCurrentMeeting({ playLeaveSound: false });
      },
    });

    return unregister;
  }, [exitCurrentMeeting, refs.currentRoomIdRef]);

  useEffect(() => {
    if (Platform.OS !== "ios") return;
    if (hasActiveCall) return;
    cancelPendingScreenShareStart();
    if (isScreenSharing) {
      stopScreenShare({ notify: false });
    }
  }, [hasActiveCall, isScreenSharing, cancelPendingScreenShareStart, stopScreenShare]);

  useEffect(() => {
    return () => {
      screenShareRequestTokenRef.current += 1;
      if (screenShareRetryTimerRef.current) {
        clearTimeout(screenShareRetryTimerRef.current);
        screenShareRetryTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (process.env.EXPO_OS === "web") return;
    if (!hasActiveCall) return;
    let cleanupHandlers: (() => void) | undefined;
    let activeCallId: string | null = null;
    let foregroundStarted = false;
    let foregroundActionsCleanup: (() => void) | undefined;

    (async () => {
      if (Platform.OS === "android") {
        await startForegroundCallService({
          roomId: roomIdRef.current || roomId,
          includeCamera: !isCameraOffRef.current,
          isMuted: isMutedRef.current,
        });
        foregroundStarted = true;
        foregroundActionsCleanup = registerForegroundCallServiceHandlers({
          onLeave: handleLeave,
          onToggleMute: () => {
            void toggleMute();
          },
        });
      }
      await ensureCallKeep();
      activeCallId = startCallSession(
        roomIdRef.current || "Conclave",
        displayNameRef.current || "Conclave"
      );
      callIdRef.current = activeCallId;
      startInCall();
      setAudioRoute("auto");
      cleanupHandlers = registerCallKeepHandlers(() => {
        handleLeave();
      });
    })();

    return () => {
      if (foregroundActionsCleanup) {
        foregroundActionsCleanup();
      }
      if (foregroundStarted) {
        void stopForegroundCallService();
      }
      if (cleanupHandlers) cleanupHandlers();
      if (activeCallId) endCallSession(activeCallId);
      callIdRef.current = null;
      stopInCall();
    };
  }, [hasActiveCall, handleLeave, roomId]);

  useEffect(() => {
    if (!hasActiveCall) return;
    if (Platform.OS !== "android") return;
    void updateForegroundCallService({
      roomId,
      includeCamera: !isCameraOff,
      isMuted,
    });
  }, [hasActiveCall, roomId, isCameraOff, isMuted]);

  useEffect(() => {
    if (Platform.OS !== "ios") return;
    if (!hasActiveCall) return;
    setCallMuted(isMuted);
  }, [hasActiveCall, isMuted]);

  const handleRequestPermissions = useCallback(async () => {
    try {
      await requestMediaPermissions({ forceVideo: true });
    } catch (err) {
      setMeetError(createMeetError(err));
    }
  }, [requestMediaPermissions, setMeetError]);

  const handleRetryPermissions = useCallback(async () => {
    if (Platform.OS === "ios") {
      Linking.openSettings().catch(() => {});
      return;
    }
    try {
      await requestMediaPermissions({ forceVideo: true });
    } catch (err) {
      setMeetError(createMeetError(err));
    }
  }, [requestMediaPermissions, setMeetError]);

  const handleJoin = useCallback(
    async (value: string, options?: { isHost?: boolean }) => {
      if (!value.trim()) return;
      if (!apiBaseUrl) {
        setMeetError(
          createMeetError("Missing EXPO_PUBLIC_SFU_BASE_URL for mobile")
        );
        return;
      }
      const normalizedRoomId = value.trim();
      const claimed = await claimMeetingSession(meetingSessionIdRef.current, {
        confirmTakeover: async (owner) => {
          if (
            owner.roomId &&
            owner.roomId.trim().toLowerCase() ===
              normalizedRoomId.toLowerCase()
          ) {
            return false;
          }
          return confirmMeetingHandoff(owner.roomId);
        },
      });
      if (!claimed) {
        if (hideJoinUI) {
          setMeetError({
            code: "UNKNOWN",
            message: "Stayed in your current meeting.",
            recoverable: true,
          });
        }
        return;
      }
      const resolvedIsHost =
        joinMode === "webinar_attendee" ? false : Boolean(options?.isHost);
      setIsAdmin(resolvedIsHost);
      socket.joinRoomById(normalizedRoomId, { isHost: resolvedIsHost });
    },
    [confirmMeetingHandoff, hideJoinUI, joinMode, socket, setMeetError, setIsAdmin]
  );

  const [isReactionSheetOpen, setIsReactionSheetOpen] = useState(false);
  const [isSettingsSheetOpen, setIsSettingsSheetOpen] = useState(false);
  const hasAutoJoinedRef = useRef(false);

  const handleToggleChat = useCallback(() => {
    setIsParticipantsOpen(false);
    setIsReactionSheetOpen(false);
    setIsSettingsSheetOpen(false);
    toggleChat();
  }, [toggleChat, setIsParticipantsOpen, setIsReactionSheetOpen, setIsSettingsSheetOpen]);

  useEffect(() => {
    if (Platform.OS !== "android") return;

    const onBackPress = () => {
      if (!blockBackNavigation) {
        return false;
      }

      if (isDisplayNameSheetOpen) {
        setIsDisplayNameSheetOpen(false);
        return true;
      }

      if (isTakeoverPromptOpen) {
        resolveTakeoverPrompt(false);
        return true;
      }

      if (isSettingsSheetOpen) {
        setIsSettingsSheetOpen(false);
        return true;
      }

      if (isReactionSheetOpen) {
        setIsReactionSheetOpen(false);
        return true;
      }

      if (isParticipantsOpen) {
        setIsParticipantsOpen(false);
        return true;
      }

      if (isChatOpen) {
        toggleChat();
        return true;
      }

      if (meetError) {
        setMeetError(null);
        return true;
      }

      return true;
    };

    const subscription = BackHandler.addEventListener(
      "hardwareBackPress",
      onBackPress
    );

    return () => {
      subscription.remove();
    };
  }, [
    blockBackNavigation,
    isDisplayNameSheetOpen,
    isTakeoverPromptOpen,
    isSettingsSheetOpen,
    isReactionSheetOpen,
    isParticipantsOpen,
    isChatOpen,
    resolveTakeoverPrompt,
    toggleChat,
    meetError,
    setMeetError,
    setIsParticipantsOpen,
  ]);

  useEffect(() => {
    if (initialRoomId && !roomId) {
      setRoomId(initialRoomId);
    }
  }, [initialRoomId, roomId, setRoomId]);

  useEffect(() => {
    if (!autoJoinOnMount || hasAutoJoinedRef.current) return;
    const targetRoomId = (initialRoomId ?? roomId).trim();
    if (!targetRoomId) return;
    hasAutoJoinedRef.current = true;
    void handleJoin(targetRoomId, { isHost: false });
  }, [autoJoinOnMount, handleJoin, initialRoomId, roomId]);

  useEffect(() => {
    if (isTablet && isSettingsSheetOpen) {
      setIsSettingsSheetOpen(false);
    }
  }, [isTablet, isSettingsSheetOpen]);

  type ScreenSharePickerHandle = React.Component<any, any>;
  const ScreenSharePicker =
    ScreenCapturePickerView as unknown as React.ComponentType<
      ViewProps & { ref?: React.Ref<ScreenSharePickerHandle> }
    >;
  const screenSharePickerRef = useRef<ScreenSharePickerHandle | null>(null);
  const showScreenSharePicker = useCallback(() => {
    if (Platform.OS !== "ios") return;
    const nodeHandle = findNodeHandle(screenSharePickerRef.current);
    if (!nodeHandle) return;
    const pickerModule =
      NativeModules.ScreenCapturePickerView ??
      NativeModules.ScreenCapturePickerViewManager;
    pickerModule?.show?.(nodeHandle);
  }, []);

  const handleToggleScreenShare = useCallback(() => {
    if (Platform.OS !== "ios") {
      void toggleScreenShare();
      return;
    }

    if (isScreenSharing) {
      cancelPendingScreenShareStart();
      void toggleScreenShare();
      return;
    }

    if (connectionState !== "joined") {
      return;
    }

    showScreenSharePicker();
    screenShareRequestTokenRef.current += 1;
    setIsScreenSharePending(true);
  }, [
    isScreenSharing,
    connectionState,
    showScreenSharePicker,
    toggleScreenShare,
    cancelPendingScreenShareStart,
  ]);

  useEffect(() => {
    if (Platform.OS !== "ios") return;
    if (!isScreenSharePending || isScreenSharing) return;

    const requestToken = ++screenShareRequestTokenRef.current;
    let attempts = 0;
    const maxAttempts = 10;
    const delayMs = 650;

    const schedule = (delay: number) => {
      if (screenShareRetryTimerRef.current) {
        clearTimeout(screenShareRetryTimerRef.current);
      }
      screenShareRetryTimerRef.current = setTimeout(() => {
        void attempt();
      }, delay);
    };

    const attempt = async () => {
      if (screenShareRequestTokenRef.current !== requestToken) return;
      if (
        !hasActiveCallRef.current ||
        connectionStateRef.current !== "joined"
      ) {
        cancelPendingScreenShareStart();
        return;
      }

      attempts += 1;
      await toggleScreenShare();

      if (screenShareRequestTokenRef.current !== requestToken) return;

      if (isScreenSharingRef.current || attempts >= maxAttempts) {
        setIsScreenSharePending(false);
        return;
      }

      schedule(delayMs);
    };

    schedule(350);
    return () => {
      if (screenShareRequestTokenRef.current === requestToken) {
        screenShareRequestTokenRef.current += 1;
      }
      if (screenShareRetryTimerRef.current) {
        clearTimeout(screenShareRetryTimerRef.current);
        screenShareRetryTimerRef.current = null;
      }
    };
  }, [
    isScreenSharePending,
    isScreenSharing,
    toggleScreenShare,
    cancelPendingScreenShareStart,
  ]);

  const localParticipant = useMemo<Participant>(
    () => ({
      userId,
      videoStream: localStream,
      audioStream: localStream,
      screenShareStream: null,
      screenShareAudioStream: null,
      audioProducerId: null,
      videoProducerId: null,
      screenShareProducerId: null,
      screenShareAudioProducerId: null,
      isMuted,
      isCameraOff,
      isHandRaised,
      isGhost: isGhostMode,
    }),
    [
      userId,
      localStream,
      isMuted,
      isCameraOff,
      isHandRaised,
      isGhostMode,
    ]
  );

  const localScreenShareStream = useMemo(() => {
    if (!isScreenSharing) return null;
    if (screenShareStream) return screenShareStream;
    const track = refs.screenProducerRef.current?.track;
    if (!track) return null;
    return new MediaStream([track]);
  }, [isScreenSharing, screenShareStream, refs.screenProducerRef]);

  const { presentationStream, presenterName } = useMemo(() => {
    if (localScreenShareStream) {
      return { presentationStream: localScreenShareStream, presenterName: "You" };
    }

    if (activeScreenShareId) {
      for (const participant of participants.values()) {
        if (
          participant.screenShareStream &&
          participant.screenShareProducerId === activeScreenShareId
        ) {
          const track = participant.screenShareStream.getVideoTracks()[0];
          if (track && track.readyState === "live") {
            return {
              presentationStream: participant.screenShareStream,
              presenterName: resolveDisplayName(participant.userId),
            };
          }
        }
      }
    }

    if (activeScreenShareId) {
      for (const participant of participants.values()) {
        if (participant.screenShareStream) {
          return {
            presentationStream: participant.screenShareStream,
            presenterName: resolveDisplayName(participant.userId),
          };
        }
      }
    }

    return { presentationStream: null, presenterName: "" };
  }, [
    localScreenShareStream,
    activeScreenShareId,
    participants,
    resolveDisplayName,
  ]);

  if (!mounted) return null;

  return (
    <AppsProvider
      socket={appsSocket}
      user={appsUser}
      isAdmin={isAdmin}
      uploadAsset={uploadAsset}
    >
      <View className="flex-1 bg-[#0d0e0d]">
        <StatusBar style="light" />
      {isJoined && meetError ? (
        <ErrorSheet
          visible={!!meetError}
          meetError={meetError}
          onDismiss={() => setMeetError(null)}
          autoDismissMs={6000}
          primaryActionLabel={
            meetError.code === "PERMISSION_DENIED"
              ? Platform.OS === "ios"
                ? "Open Settings"
                : "Retry Permissions"
              : meetError.code === "MEDIA_ERROR"
                ? "Retry Devices"
                : undefined
          }
          onPrimaryAction={
            meetError.code === "PERMISSION_DENIED" ||
              meetError.code === "MEDIA_ERROR"
              ? meetError.code === "PERMISSION_DENIED"
                ? handleRetryPermissions
                : async () => {
                  try {
                    await requestMediaPermissions({ forceVideo: true });
                  } catch (err) {
                    setMeetError(createMeetError(err));
                  }
                }
              : undefined
          }
        />
      ) : null}

      {!isJoined && !hasActiveCall ? (
        hideJoinUI ? (
          <View className="flex-1 items-center justify-center px-6">
            <View className="rounded-2xl border border-white/10 bg-black/50 px-6 py-5">
              <Text className="text-sm font-medium text-[#FEFCD9]">
                {isLoading ? "Joining webinar..." : "Preparing webinar..."}
              </Text>
              {meetError ? (
                <Text className="mt-2 text-xs text-[#F95F4A]">
                  {meetError.message}
                </Text>
              ) : null}
            </View>
          </View>
        ) : (
          <JoinScreen
            roomId={roomId}
            onRoomIdChange={setRoomId}
            onJoinRoom={handleJoin}
            onIsAdminChange={setIsAdmin}
            user={currentUser}
            onUserChange={handleUserChange}
            isLoading={isLoading}
            displayNameInput={displayNameInput}
            onDisplayNameInputChange={setDisplayNameInput}
            isMuted={isMuted}
            isCameraOff={isCameraOff}
            localStream={localStream}
            onToggleMute={toggleMute}
            onToggleCamera={toggleCamera}
            showPermissionHint={showPermissionHint}
            hasAudioPermission={mediaState.hasAudioPermission}
            hasVideoPermission={mediaState.hasVideoPermission}
            permissionsReady={mediaState.permissionsReady}
            meetError={meetError}
            onDismissMeetError={() => setMeetError(null)}
            onRetryMedia={handleRetryPermissions}
            onRequestMedia={handleRequestPermissions}
            forceJoinOnly={hideJoinUI || joinMode === "webinar_attendee"}
          />
        )
      ) : (
        <CallScreen
          roomId={roomId}
          connectionState={connectionState}
          serverRestartNotice={serverRestartNotice}
          participants={participants}
          localParticipant={localParticipant}
          presentationStream={presentationStream}
          presenterName={presenterName}
          isMuted={isMuted}
          isCameraOff={isCameraOff}
          isHandRaised={isHandRaised}
          isScreenSharing={isScreenSharing}
          isChatOpen={isChatOpen}
          unreadCount={unreadCount}
          isMirrorCamera={isMirrorCamera}
          activeSpeakerId={effectiveActiveSpeakerId}
          resolveDisplayName={resolveDisplayName}
          onToggleMute={toggleMute}
          onToggleCamera={toggleCamera}
          onToggleScreenShare={handleToggleScreenShare}
          onToggleHandRaised={toggleHandRaised}
          onToggleChat={handleToggleChat}
          onToggleParticipants={() => {
            if (isWebinarSession) return;
            if (isChatOpen) toggleChat();
            setIsReactionSheetOpen(false);
            setIsSettingsSheetOpen(false);
            setIsParticipantsOpen((prev) => !prev);
          }}
          onToggleRoomLock={(locked) => {
            socket.toggleRoomLock?.(locked);
          }}
          onToggleNoGuests={(noGuests) => {
            socket.toggleNoGuests?.(noGuests);
          }}
          onToggleChatLock={(locked) => {
            socket.toggleChatLock?.(locked);
          }}
          onToggleTtsDisabled={(disabled) => {
            socket.toggleTtsDisabled?.(disabled);
          }}
          onSendReaction={(emoji) => {
            sendReaction({ kind: "emoji", id: emoji, value: emoji, label: emoji });
          }}
          onOpenSettings={() => {
            if (isTablet) return;
            if (isChatOpen) toggleChat();
            setIsParticipantsOpen(false);
            setIsReactionSheetOpen(false);
            setIsSettingsSheetOpen(true);
          }}
          onLeave={handleLeave}
          isAdmin={isAdmin}
          isObserverMode={isWebinarAttendee}
          isRoomLocked={isRoomLocked}
          isNoGuests={isNoGuests}
          isChatLocked={isChatLocked}
          isTtsDisabled={isTtsDisabled}
          pendingUsersCount={pendingUsers.size}
          webinarConfig={webinarConfig}
          webinarSpeakerUserId={webinarSpeakerUserId}
        />
      )}

      {isJoined ? (
        <ReactionOverlay
          reactions={reactions}
          currentUserId={userId}
          resolveDisplayName={resolveDisplayName}
        />
      ) : null}

      {isJoined && !isWebinarAttendee ? (
        <ChatPanel
          visible={isChatOpen}
          messages={chatMessages}
          input={chatInput}
          onInputChange={setChatInput}
          onSend={sendChat}
          onClose={() => {
            if (isChatOpen) toggleChat();
          }}
          currentUserId={userId}
          isGhostMode={effectiveGhostMode}
          isChatLocked={isChatLocked}
          isAdmin={isAdmin}
          resolveDisplayName={resolveDisplayName}
        />
      ) : null}

      {Platform.OS === "ios" ? (
        <ScreenSharePicker
          ref={screenSharePickerRef}
          style={styles.screenSharePicker}
        />
      ) : null}

      {isJoined && !isWebinarSession ? (
        <ParticipantsPanel
          visible={isParticipantsOpen}
          localParticipant={localParticipant}
          currentUserId={userId}
          participants={Array.from(participants.values())}
          resolveDisplayName={resolveDisplayName}
          onClose={() => setIsParticipantsOpen(false)}
          pendingUsers={pendingUsers}
          isAdmin={isAdmin}
          onAdmitPendingUser={(pendingUserId) => {
            socket.admitUser?.(pendingUserId);
            setPendingUsers((prev) => {
              const next = new Map(prev);
              next.delete(pendingUserId);
              return next;
            });
          }}
          onRejectPendingUser={(pendingUserId) => {
            socket.rejectUser?.(pendingUserId);
            setPendingUsers((prev) => {
              const next = new Map(prev);
              next.delete(pendingUserId);
              return next;
            });
          }}
        />
      ) : null}

      {isJoined && !isWebinarAttendee ? (
        <ReactionSheet
          visible={isReactionSheetOpen}
          options={reactionOptions}
          onSelect={(reaction) => {
            sendReaction(reaction);
            setIsReactionSheetOpen(false);
          }}
          onClose={() => setIsReactionSheetOpen(false)}
        />
      ) : null}

      {isJoined && !isTablet && !isWebinarAttendee ? (
        <SettingsSheet
          visible={isSettingsSheetOpen}
          isHandRaised={isHandRaised}
          isRoomLocked={isRoomLocked}
          isNoGuests={isNoGuests}
          isChatLocked={isChatLocked}
          isTtsDisabled={isTtsDisabled}
          isAdmin={isAdmin}
          selectedAudioInputDeviceId={selectedAudioInputDeviceId}
          selectedAudioOutputDeviceId={selectedAudioOutputDeviceId}
          meetingRequiresInviteCode={meetingRequiresInviteCode}
          webinarConfig={webinarConfig}
          webinarLink={webinarLink}
          onSetWebinarLink={setWebinarLink}
          onGetMeetingConfig={socket.getMeetingConfig}
          onUpdateMeetingConfig={socket.updateMeetingConfig}
          onGetWebinarConfig={socket.getWebinarConfig}
          onUpdateWebinarConfig={socket.updateWebinarConfig}
          onGenerateWebinarLink={socket.generateWebinarLink}
          onRotateWebinarLink={socket.rotateWebinarLink}
          onOpenDisplayName={() => {
            setIsSettingsSheetOpen(false);
            setIsDisplayNameSheetOpen(true);
          }}
          onToggleHandRaised={() => {
            setIsSettingsSheetOpen(false);
            toggleHandRaised();
          }}
          onToggleRoomLock={(locked) => {
            setIsSettingsSheetOpen(false);
            socket.toggleRoomLock?.(locked);
          }}
          onToggleNoGuests={(noGuests) => {
            setIsSettingsSheetOpen(false);
            socket.toggleNoGuests?.(noGuests);
          }}
          onToggleChatLock={(locked) => {
            setIsSettingsSheetOpen(false);
            socket.toggleChatLock?.(locked);
          }}
          onToggleTtsDisabled={(disabled) => {
            setIsSettingsSheetOpen(false);
            socket.toggleTtsDisabled?.(disabled);
          }}
          onAudioInputDeviceChange={handleAudioInputDeviceChange}
          onAudioOutputDeviceChange={handleAudioOutputDeviceChange}
          onClose={() => setIsSettingsSheetOpen(false)}
        />
      ) : null}

      {isJoined ? (
        <DisplayNameSheet
          visible={isDisplayNameSheetOpen}
          value={displayNameInput}
          onChange={setDisplayNameInput}
          onSubmit={handleDisplayNameSubmit}
          onClose={() => setIsDisplayNameSheetOpen(false)}
          canSubmit={canUpdateDisplayName}
          isUpdating={isDisplayNameUpdating}
          status={displayNameStatus}
        />
      ) : null}

      {isJoined && isAdmin && pendingToast ? (
        <PendingJoinToast
          visible
          displayName={pendingToast.displayName}
          count={pendingToast.count}
          onAdmit={() => {
            socket.admitUser?.(pendingToast.userId);
            setPendingUsers((prev) => {
              const next = new Map(prev);
              next.delete(pendingToast.userId);
              return next;
            });
            dismissPendingToast();
          }}
          onReject={() => {
            socket.rejectUser?.(pendingToast.userId);
            setPendingUsers((prev) => {
              const next = new Map(prev);
              next.delete(pendingToast.userId);
              return next;
            });
            dismissPendingToast();
          }}
        />
      ) : null}

      {connectionState === "waiting" && waitingMessage ? (
        <View className="absolute inset-0 bg-black/70 items-center justify-center px-6">
          <View className="bg-neutral-900 border border-white/10 rounded-3xl px-6 py-5">
            <View className="gap-2">
              <View className="gap-2">
                <Text className="text-base font-semibold text-[#FEFCD9]" selectable>
                  {waitingMessage}
                </Text>
                <Text className="text-xs text-[#FEFCD9]/60">
                  We’ll let you in as soon as the host admits you.
                </Text>
              </View>
            </View>
          </View>
        </View>
      ) : null}

      {isInviteCodePromptOpen ? (
        <View className="absolute inset-0 bg-black/75 items-center justify-center px-6">
          <View className="w-full max-w-sm rounded-3xl border border-white/10 bg-[#111111] p-5">
            <Text className="text-base font-semibold text-[#FEFCD9]">
              {inviteCodePromptMode === "meeting"
                ? "Meeting invite code"
                : "Webinar invite code"}
            </Text>
            <Text className="mt-1 text-xs text-[#FEFCD9]/60">
              {inviteCodePromptMode === "meeting"
                ? "This meeting requires an invite code."
                : "This webinar requires an invite code."}
            </Text>
            <TextInput
              value={inviteCodeInput}
              onChangeText={(value) => {
                setInviteCodeInput(value);
                if (inviteCodePromptError) {
                  setInviteCodePromptError(null);
                }
              }}
              autoFocus
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="Invite code"
              placeholderTextColor="rgba(254,252,217,0.35)"
              className="mt-4 rounded-xl border border-white/10 bg-black/40 px-3 py-3 text-[#FEFCD9]"
              onSubmitEditing={handleSubmitInviteCodePrompt}
              returnKeyType="done"
            />
            {inviteCodePromptError ? (
              <Text className="mt-2 text-xs text-[#F95F4A]">
                {inviteCodePromptError}
              </Text>
            ) : null}
            <View className="mt-4 flex-row items-center justify-end gap-2">
              <Pressable
                onPress={handleCancelInviteCodePrompt}
                className="rounded-xl border border-white/15 px-3 py-2"
              >
                <Text className="text-xs uppercase tracking-[0.14em] text-[#FEFCD9]/70">
                  Cancel
                </Text>
              </Pressable>
              <Pressable
                onPress={handleSubmitInviteCodePrompt}
                className="rounded-xl bg-[#F95F4A] px-3 py-2"
              >
                <Text className="text-xs uppercase tracking-[0.14em] text-white">
                  Continue
                </Text>
              </Pressable>
            </View>
          </View>
        </View>
      ) : null}

      {isTakeoverPromptOpen ? (
        <View className="absolute inset-0 bg-black/75 items-center justify-center px-6">
          <View className="w-full max-w-sm rounded-3xl border border-white/10 bg-[#111111] p-5">
            <Text className="text-base font-semibold text-[#FEFCD9]">
              Join new meeting?
            </Text>
            <Text className="mt-1 text-xs text-[#FEFCD9]/60">
              You are currently in {takeoverPromptRoomLabel}. Leave it and join this one?
            </Text>
            <View className="mt-4 flex-row items-center justify-end gap-2">
              <Pressable
                onPress={handleTakeoverPromptStay}
                className="rounded-xl border border-white/15 px-3 py-2"
              >
                <Text className="text-xs uppercase tracking-[0.14em] text-[#FEFCD9]/70">
                  Stay
                </Text>
              </Pressable>
              <Pressable
                onPress={handleTakeoverPromptJoin}
                className="rounded-xl bg-[#F95F4A] px-3 py-2"
              >
                <Text className="text-xs uppercase tracking-[0.14em] text-white">
                  Leave & Join
                </Text>
              </Pressable>
            </View>
          </View>
        </View>
      ) : null}
      </View>
    </AppsProvider>
  );
}

const styles = StyleSheet.create({
  screenSharePicker: {
    position: "absolute",
    width: 1,
    height: 1,
    opacity: 0,
    right: 0,
    bottom: 0,
  },
});

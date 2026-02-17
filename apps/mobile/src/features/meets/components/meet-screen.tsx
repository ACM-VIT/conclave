import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Socket } from "socket.io-client";
import { StatusBar } from "expo-status-bar";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import {
  AppState,
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
import { Text, View } from "@/tw";
import { reactionAssetList } from "../reaction-assets";
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
import type { Participant } from "../types";
import { createMeetError } from "../utils";
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

export function MeetScreen({ initialRoomId }: { initialRoomId?: string } = {}) {
  if (process.env.EXPO_OS !== "web") {
    ensureWebRTCGlobals();
  }

  const { isTablet } = useDeviceLayout();
  const refs = useMeetRefs();
  const [appsSocket, setAppsSocket] = useState<Socket | null>(null);
  const uploadAsset = useMemo(
    () =>
      createAssetUploadHandler({
        baseUrl: apiBaseUrl || undefined,
      }),
    []
  );
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
  } = useMeetState({ initialRoomId });

  useEffect(() => {
    registerApps([whiteboardApp]);
  }, []);
  const isCameraOffRef = useRef(isCameraOff);
  const isMutedRef = useRef(isMuted);
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
    ghostEnabled: isGhostMode,
    reactionAssets: reactionAssetList.slice(),
  });

  const { ttsSpeakerId, handleTtsMessage } = useMeetTts();

  const {
    mediaState,
    showPermissionHint,
    requestMediaPermissions,
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
    ghostEnabled: isGhostMode,
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

  const isJoined = connectionState === "joined";
  const effectiveActiveSpeakerId = ttsSpeakerId ?? activeSpeakerId;
  const isLoading =
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
    ghostEnabled: isGhostMode,
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
    ghostEnabled: isGhostMode,
    isMuted,
    isCameraOff,
    onToggleMute: toggleMute,
    onToggleCamera: toggleCamera,
    onSetHandRaised: setHandRaisedState,
    onTtsMessage: handleTtsMessage,
  });

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
          }),
        });

        if (!response.ok) {
          throw new Error(await readError(response));
        }

        return response.json();
      },
      []
    ),
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
    isMuted,
    setIsMuted,
    isCameraOff,
    setIsCameraOff,
    setIsScreenSharing,
    setIsHandRaised,
    setIsRoomLocked,
    setActiveScreenShareId,
    setVideoQuality,
    videoQualityRef: refs.videoQualityRef,
    updateVideoQualityRef,
    requestMediaPermissions,
    stopLocalTrack,
    handleLocalTrackEnded,
    playNotificationSound,
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

  const playNotificationSoundRef = useRef(playNotificationSound);
  playNotificationSoundRef.current = playNotificationSound;

  const stopScreenShareRef = useRef(stopScreenShare);
  stopScreenShareRef.current = stopScreenShare;

  const handleLeave = useCallback(() => {
    setHasActiveCall(false);
    playNotificationSoundRef.current("leave");
    setIsScreenSharePending(false);
    stopScreenShareRef.current({ notify: true });
    socketCleanupRef.current();
    if (callIdRef.current) endCallSession(callIdRef.current);
    stopInCall();
  }, []);

  useEffect(() => {
    if (Platform.OS !== "ios") return;
    if (hasActiveCall) return;
    if (isScreenSharePending) {
      setIsScreenSharePending(false);
    }
    if (isScreenSharing) {
      stopScreenShare({ notify: false });
    }
  }, [hasActiveCall, isScreenSharing, isScreenSharePending, stopScreenShare]);

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
      setAudioRoute("speaker");
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
      setIsAdmin(!!options?.isHost);
      socket.joinRoomById(value.trim(), options);
    },
    [socket, setMeetError, setIsAdmin]
  );

  const [isReactionSheetOpen, setIsReactionSheetOpen] = useState(false);
  const [isSettingsSheetOpen, setIsSettingsSheetOpen] = useState(false);

  const handleToggleChat = useCallback(() => {
    setIsParticipantsOpen(false);
    setIsReactionSheetOpen(false);
    setIsSettingsSheetOpen(false);
    toggleChat();
  }, [toggleChat, setIsParticipantsOpen, setIsReactionSheetOpen, setIsSettingsSheetOpen]);

  useEffect(() => {
    if (initialRoomId && !roomId) {
      setRoomId(initialRoomId);
    }
  }, [initialRoomId, roomId, setRoomId]);

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
      void toggleScreenShare();
      return;
    }

    showScreenSharePicker();
    setIsScreenSharePending(true);
  }, [isScreenSharing, showScreenSharePicker, toggleScreenShare]);

  useEffect(() => {
    if (!isScreenSharePending || isScreenSharing) return;

    let cancelled = false;
    let attempts = 0;
    const maxAttempts = 8;
    const delayMs = 600;

    const attempt = async () => {
      if (cancelled || isScreenSharing) return;
      attempts += 1;
      await toggleScreenShare();
      if (!isScreenSharing && attempts < maxAttempts) {
        setTimeout(attempt, delayMs);
      } else {
        setIsScreenSharePending(false);
      }
    };

    const timer = setTimeout(attempt, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [isScreenSharePending, isScreenSharing, toggleScreenShare]);

  const localParticipant = useMemo<Participant>(
    () => ({
      userId,
      videoStream: localStream,
      audioStream: localStream,
      screenShareStream: null,
      audioProducerId: null,
      videoProducerId: null,
      screenShareProducerId: null,
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
        />
      ) : (
        <CallScreen
          roomId={roomId}
          connectionState={connectionState}
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
            if (isChatOpen) toggleChat();
            setIsReactionSheetOpen(false);
            setIsSettingsSheetOpen(false);
            setIsParticipantsOpen((prev) => !prev);
          }}
          onToggleRoomLock={(locked) => {
            socket.toggleRoomLock?.(locked);
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
          isRoomLocked={isRoomLocked}
          pendingUsersCount={pendingUsers.size}
        />
      )}

      {isJoined ? (
        <ReactionOverlay
          reactions={reactions}
          currentUserId={userId}
          resolveDisplayName={resolveDisplayName}
        />
      ) : null}

      {isJoined ? (
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
          isGhostMode={isGhostMode}
          resolveDisplayName={resolveDisplayName}
        />
      ) : null}

      {Platform.OS === "ios" ? (
        <ScreenSharePicker
          ref={screenSharePickerRef}
          style={styles.screenSharePicker}
        />
      ) : null}

      {isJoined ? (
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

      {isJoined ? (
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

      {isJoined && !isTablet ? (
        <SettingsSheet
          visible={isSettingsSheetOpen}
          isScreenSharing={isScreenSharing}
          isHandRaised={isHandRaised}
          isRoomLocked={isRoomLocked}
          isAdmin={isAdmin}
          onOpenDisplayName={() => {
            setIsSettingsSheetOpen(false);
            setIsDisplayNameSheetOpen(true);
          }}
          onToggleScreenShare={() => {
            setIsSettingsSheetOpen(false);
            handleToggleScreenShare();
          }}
          onToggleHandRaised={() => {
            setIsSettingsSheetOpen(false);
            toggleHandRaised();
          }}
          onToggleRoomLock={(locked) => {
            setIsSettingsSheetOpen(false);
            socket.toggleRoomLock?.(locked);
          }}
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

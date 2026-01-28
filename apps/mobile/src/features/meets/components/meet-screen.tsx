import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { StatusBar } from "expo-status-bar";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import {
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
  startCallSession,
  startInCall,
  stopInCall,
} from "@/lib/call-service";
import { ensureWebRTCGlobals } from "@/lib/webrtc";
import { View } from "@/tw";
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
import type { Participant } from "../types";
import { createMeetError } from "../utils";
import { CallScreen } from "./call-screen";
import { ChatPanel } from "./chat-panel";
import { ErrorBanner } from "./error-banner";
import { JoinScreen } from "./join-screen";
import { ParticipantsPanel } from "./participants-panel";
import { ReactionOverlay } from "./reaction-overlay";
import { ReactionSheet } from "./reaction-sheet";
import { AudioRouteSheet, type AudioRoute } from "./audio-route-sheet";

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

export function MeetScreen() {
  if (process.env.EXPO_OS !== "web") {
    ensureWebRTCGlobals();
  }

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
  } = useMeetState({ initialRoomId: "" });

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
  const [currentUser, setCurrentUser] = useState<
    { id?: string; email?: string | null; name?: string | null } | null
  >(guestIdentity);
  useEffect(() => {
    if (!currentUser || currentUser.id?.startsWith("guest-")) {
      setCurrentUser(guestIdentity);
    }
  }, [currentUser, guestIdentity]);
  const user = currentUser ?? guestIdentity;
  const [isAdmin, setIsAdmin] = useState(false);

  const userKey = user?.email || user?.id || `guest-${guestSessionId}`;
  const userId = `${userKey}#${refs.sessionIdRef.current}`;

  const {
    setDisplayNames,
    displayNameInput,
    setDisplayNameInput,
    resolveDisplayName,
  } = useMeetDisplayName({
    user,
    userId,
    isAdmin,
    ghostEnabled: isGhostMode,
    socketRef: refs.socketRef,
    joinOptionsRef: refs.joinOptionsRef,
  });

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

  const {
    showPermissionHint,
    requestMediaPermissions,
    updateVideoQualityRef,
    toggleMute,
    toggleCamera,
    toggleScreenShare,
    stopLocalTrack,
    handleLocalTrackEnded,
    playNotificationSound,
    primeAudioOutput,
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
    chat: {
      setChatMessages,
      setChatOverlayMessages,
      setUnreadCount,
      isChatOpenRef,
    },
  });

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

  const isJoined = connectionState === "joined";
  const isLoading =
    connectionState === "connecting" ||
    connectionState === "joining" ||
    connectionState === "reconnecting" ||
    connectionState === "waiting";

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

  const handleLeave = useCallback(() => {
    playNotificationSound("leave");
    socket.cleanup();
    if (callIdRef.current) endCallSession(callIdRef.current);
    stopInCall();
  }, [playNotificationSound, socket]);

  useEffect(() => {
    if (process.env.EXPO_OS === "web") return;
    if (!isJoined) return;
    if (__DEV__) return;
    let cleanupHandlers: (() => void) | undefined;
    let activeCallId: string | null = null;

    (async () => {
      await ensureCallKeep();
      activeCallId = startCallSession(
        roomId || "Conclave",
        displayNameInput || "Conclave"
      );
      callIdRef.current = activeCallId;
      startInCall();
      setAudioRoute(audioRoute);
      cleanupHandlers = registerCallKeepHandlers(() => {
        handleLeave();
      });
    })();

    return () => {
      if (cleanupHandlers) cleanupHandlers();
      if (activeCallId) endCallSession(activeCallId);
      callIdRef.current = null;
      stopInCall();
    };
  }, [isJoined, roomId, displayNameInput, handleLeave]);

  const handleJoin = useCallback(
    (value: string, options?: { isHost?: boolean }) => {
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
  const [isAudioSheetOpen, setIsAudioSheetOpen] = useState(false);
  const [audioRoute, setAudioRouteState] = useState<AudioRoute>("speaker");

  const handleToggleChat = useCallback(() => {
    setIsParticipantsOpen(false);
    setIsReactionSheetOpen(false);
    setIsAudioSheetOpen(false);
    toggleChat();
  }, [toggleChat, setIsParticipantsOpen, setIsReactionSheetOpen, setIsAudioSheetOpen]);

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

  const [isScreenSharePending, setIsScreenSharePending] = useState(false);

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
    <View className="flex-1 bg-[#0d0e0d]">
      <StatusBar style="light" />
      {isJoined && meetError ? (
        <ErrorBanner
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
              ? async () => {
                try {
                  await requestMediaPermissions();
                } catch (err) {
                  setMeetError(createMeetError(err));
                }
              }
              : undefined
          }
        />
      ) : null}

      {!isJoined ? (
        <JoinScreen
          roomId={roomId}
          onRoomIdChange={setRoomId}
          onJoinRoom={handleJoin}
          onIsAdminChange={setIsAdmin}
          onUserChange={setCurrentUser}
          isLoading={isLoading}
          displayNameInput={displayNameInput}
          onDisplayNameInputChange={setDisplayNameInput}
          isMuted={isMuted}
          isCameraOff={isCameraOff}
          localStream={localStream}
          onToggleMute={toggleMute}
          onToggleCamera={toggleCamera}
          showPermissionHint={showPermissionHint}
          meetError={meetError}
          onDismissMeetError={() => setMeetError(null)}
          onRetryMedia={async () => {
            try {
              await requestMediaPermissions();
            } catch (err) {
              setMeetError(createMeetError(err));
            }
          }}
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
          activeSpeakerId={activeSpeakerId}
          resolveDisplayName={resolveDisplayName}
          onToggleMute={toggleMute}
          onToggleCamera={toggleCamera}
          onToggleScreenShare={handleToggleScreenShare}
          onToggleHandRaised={toggleHandRaised}
          onToggleChat={handleToggleChat}
          onToggleParticipants={() => {
            if (isChatOpen) toggleChat();
            setIsReactionSheetOpen(false);
            setIsAudioSheetOpen(false);
            setIsParticipantsOpen((prev) => !prev);
          }}
          onToggleRoomLock={(locked) => {
            socket.toggleRoomLock?.(locked);
          }}
          onSendReaction={(emoji) => {
            sendReaction({ kind: "emoji", id: emoji, value: emoji, label: emoji });
          }}
          onOpenAudio={() => {
            if (isChatOpen) toggleChat();
            setIsParticipantsOpen(false);
            setIsReactionSheetOpen(false);
            setIsAudioSheetOpen(true);
          }}
          onLeave={handleLeave}
          isAdmin={isAdmin}
          isRoomLocked={isRoomLocked}
          pendingUsersCount={pendingUsers.size}
        />
      )}

      {isJoined ? <ReactionOverlay reactions={reactions} /> : null}

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

      {isJoined ? (
        <AudioRouteSheet
          visible={isAudioSheetOpen}
          currentRoute={audioRoute}
          onSelect={(route) => {
            setAudioRouteState(route);
            setAudioRoute(route);
            setIsAudioSheetOpen(false);
          }}
          onClose={() => setIsAudioSheetOpen(false)}
        />
      ) : null}

      {connectionState === "waiting" && waitingMessage ? (
        <View className="absolute inset-0 bg-black/70 items-center justify-center px-6">
          <View className="bg-neutral-900 border border-white/10 rounded-3xl px-6 py-5">
            <View className="gap-2">
              <ErrorBanner
                meetError={{
                  code: "UNKNOWN",
                  message: waitingMessage,
                  recoverable: true,
                }}
              />
            </View>
          </View>
        </View>
      ) : null}
    </View>
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

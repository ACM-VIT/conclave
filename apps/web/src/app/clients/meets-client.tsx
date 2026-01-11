"use client";

import { Roboto } from "next/font/google";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { RoomInfo } from "@/lib/sfu-types";
import {
  MeetsErrorBanner,
  MeetsHeader,
  MeetsMainContent,
  MeetsWaitingScreen,
} from "./meets/components";
import { useMeetAudioActivity } from "./meets/hooks/useMeetAudioActivity";
import { useMeetChat } from "./meets/hooks/useMeetChat";
import { useMeetDisplayName } from "./meets/hooks/useMeetDisplayName";
import { useMeetGhostMode } from "./meets/hooks/useMeetGhostMode";
import { useMeetHandRaise } from "./meets/hooks/useMeetHandRaise";
import { useMeetLifecycle } from "./meets/hooks/useMeetLifecycle";
import { useMeetMedia } from "./meets/hooks/useMeetMedia";
import { useMeetMediaSettings } from "./meets/hooks/useMeetMediaSettings";
import { useMeetReactions } from "./meets/hooks/useMeetReactions";
import { useMeetRefs } from "./meets/hooks/useMeetRefs";
import { useMeetRooms } from "./meets/hooks/useMeetRooms";
import { useMeetSocket } from "./meets/hooks/useMeetSocket";
import { useMeetState } from "./meets/hooks/useMeetState";
import type { ParticipantsPanelGetRooms } from "./meets/components/ParticipantsPanel";

const roboto = Roboto({
  subsets: ["latin"],
  weight: ["400", "500", "700"],
  display: "swap",
  variable: "--font-roboto",
});

// ============================================
// Main Component
// ============================================

export type MeetsClientProps = {
  initialRoomId?: string;
  enableRoomRouting?: boolean;
  forceJoinOnly?: boolean;
  allowGhostMode?: boolean;
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
    }
  ) => Promise<{
    token: string;
    sfuUrl: string;
  }>;
  getRooms?: () => Promise<RoomInfo[]>;
  getRoomsForRedirect?: ParticipantsPanelGetRooms;
  reactionAssets?: string[];
};

export default function MeetsClient({
  initialRoomId,
  enableRoomRouting = false,
  forceJoinOnly = false,
  allowGhostMode = true,
  user,
  isAdmin = false,
  getJoinInfo,
  getRooms,
  getRoomsForRedirect,
  reactionAssets,
}: MeetsClientProps) {
  const [currentUser, setCurrentUser] = useState(user);
  const [currentIsAdmin, setCurrentIsAdmin] = useState(isAdmin);

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
  } = useMeetState({ initialRoomId });

  useEffect(() => {
    if (!enableRoomRouting && !forceJoinOnly) return;
    if (roomId.trim().length > 0) return;
    if (typeof window === "undefined") return;
    const path = window.location.pathname.replace(/^\/+/, "");
    if (!path) return;
    const decoded = decodeURIComponent(path);
    if (!decoded || decoded === "undefined" || decoded === "null") return;
    const sanitized = decoded
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "")
      .slice(0, 4);
    if (!sanitized) return;
    setRoomId(sanitized);
  }, [enableRoomRouting, forceJoinOnly, roomId, setRoomId]);

  const {
    videoQuality,
    setVideoQuality,
    isMirrorCamera,
    setIsMirrorCamera,
    isVideoSettingsOpen,
    setIsVideoSettingsOpen,
    selectedAudioInputDeviceId,
    setSelectedAudioInputDeviceId,
    selectedAudioOutputDeviceId,
    setSelectedAudioOutputDeviceId,
  } = useMeetMediaSettings({ videoQualityRef: refs.videoQualityRef });

  const isAdminFlag = Boolean(currentIsAdmin);
  const ghostEnabled = allowGhostMode && isAdminFlag && isGhostMode;

  const userEmail = currentUser?.name || currentUser?.email || currentUser?.id || "guest";
  const userKey = currentUser?.email || currentUser?.id || "guest";
  const userId = `${userKey}#${refs.sessionIdRef.current}`;

  const {
    setDisplayNames,
    displayNameInput,
    setDisplayNameInput,
    displayNameStatus,
    isDisplayNameUpdating,
    handleDisplayNameSubmit,
    resolveDisplayName,
    canUpdateDisplayName,
  } = useMeetDisplayName({
    user: currentUser,
    userId,
    isAdmin: isAdminFlag,
    ghostEnabled,
    socketRef: refs.socketRef,
    joinOptionsRef: refs.joinOptionsRef,
  });

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
    reactionAssets,
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
  } = useMeetChat({ socketRef: refs.socketRef, ghostEnabled });

  const {
    showPermissionHint,
    requestMediaPermissions,
    handleAudioInputDeviceChange,
    handleAudioOutputDeviceChange,
    updateVideoQualityRef,
    toggleMute,
    toggleCamera,
    toggleScreenShare,
    stopLocalTrack,
    handleLocalTrackEnded,
    playNotificationSound,
    primeAudioOutput,
  } = useMeetMedia({
    ghostEnabled,
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

  const { toggleHandRaised } = useMeetHandRaise({
    isHandRaised,
    setIsHandRaised,
    isHandRaisedRef: refs.isHandRaisedRef,
    ghostEnabled,
    socketRef: refs.socketRef,
  });

  const socket = useMeetSocket({
    refs,
    roomId,
    setRoomId,
    isAdmin: isAdminFlag,
    user: currentUser,
    userId,
    getJoinInfo,
    ghostEnabled,
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
    setActiveScreenShareId,
    setVideoQuality,
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

  const { mounted } = useMeetLifecycle({
    cleanup: socket.cleanup,
    abortControllerRef: refs.abortControllerRef,
  });

  useEffect(() => {
    if (isAdminFlag && connectionState !== "joined") {
      refreshRooms();
    }
  }, [isAdminFlag, connectionState, refreshRooms]);

  const joinRoom = socket.joinRoom;
  const joinRoomById = socket.joinRoomById;

  const leaveRoom = useCallback(() => {
    playNotificationSound("leave");
    socket.cleanup();
  }, [playNotificationSound, socket.cleanup]);

  const screenTrack = refs.screenProducerRef.current?.track;
  const localScreenShareStream = useMemo(() => {
    if (!screenTrack) return null;
    return new MediaStream([screenTrack]);
  }, [screenTrack]);

  // ============================================
  // Render Helpers
  // ============================================

  if (!mounted) return null;

  let presentationStream: MediaStream | null = null;
  let presenterName = "";

  if (isScreenSharing && localScreenShareStream) {
    presentationStream = localScreenShareStream;
    presenterName = "You";
  } else if (activeScreenShareId) {
    for (const p of participants.values()) {
      if (p.screenShareStream) {
        presentationStream = p.screenShareStream;
        presenterName = resolveDisplayName(p.userId);
        break;
      }
    }
  }

  const isJoined = connectionState === "joined";
  const isLoading =
    connectionState === "connecting" ||
    connectionState === "joining" ||
    connectionState === "reconnecting" ||
    connectionState === "waiting"; // Waiting is a kind of loading state visually, or handled separately

  if (connectionState === "waiting") {
    const waitingTitle = waitingMessage ?? "Waiting for host to let you in";
    const waitingIntro = waitingMessage
      ? "The host left the room, so there is no one available to admit you right now."
      : "Hang tight.";
    return (
      <MeetsWaitingScreen
        waitingTitle={waitingTitle}
        waitingIntro={waitingIntro}
        roomId={roomId}
        isAdmin={isAdminFlag}
      />
    );
  }

  return (
    <div
      className={`flex flex-col h-full w-full bg-[#1a1a1a] text-white ${roboto.className}`}
      style={{ fontFamily: "'Roboto', sans-serif" }}
    >
      <MeetsHeader
        isJoined={isJoined}
        isAdmin={isAdminFlag}
        roomId={roomId}
        isMirrorCamera={isMirrorCamera}
        isVideoSettingsOpen={isVideoSettingsOpen}
        onToggleVideoSettings={() => setIsVideoSettingsOpen((prev) => !prev)}
        onToggleMirror={() => setIsMirrorCamera((prev) => !prev)}
        isCameraOff={isCameraOff}
        displayNameInput={displayNameInput}
        displayNameStatus={displayNameStatus}
        isDisplayNameUpdating={isDisplayNameUpdating}
        canUpdateDisplayName={canUpdateDisplayName}
        onDisplayNameInputChange={setDisplayNameInput}
        onDisplayNameSubmit={handleDisplayNameSubmit}
        selectedAudioInputDeviceId={selectedAudioInputDeviceId}
        selectedAudioOutputDeviceId={selectedAudioOutputDeviceId}
        onAudioInputDeviceChange={handleAudioInputDeviceChange}
        onAudioOutputDeviceChange={handleAudioOutputDeviceChange}
        showShareLink={enableRoomRouting || forceJoinOnly}
      />
      {meetError && (
        <MeetsErrorBanner
          meetError={meetError}
          onDismiss={() => setMeetError(null)}
        />
      )}
    <MeetsMainContent
      isJoined={isJoined}
      connectionState={connectionState}
      isLoading={isLoading}
      roomId={roomId}
      setRoomId={setRoomId}
      joinRoom={joinRoom}
      joinRoomById={joinRoomById}
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
        presenterName={presenterName}
        localStream={localStream}
        isCameraOff={isCameraOff}
        isMuted={isMuted}
        isHandRaised={isHandRaised}
        participants={participants}
        isMirrorCamera={isMirrorCamera}
        activeSpeakerId={activeSpeakerId}
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
        getRoomsForRedirect={getRoomsForRedirect}
        onUserChange={(user) => setCurrentUser(user ?? undefined)}
        onIsAdminChange={setCurrentIsAdmin}
      />
    </div>
  );
}

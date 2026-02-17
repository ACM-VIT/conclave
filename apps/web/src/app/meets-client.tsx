"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Socket } from "socket.io-client";
import type { RoomInfo } from "@/lib/sfu-types";
import { signOut } from "@/lib/auth-client";
import type { AssetUploadHandler } from "@conclave/apps-sdk";
import {
  AppsProvider,
  createAssetUploadHandler,
  registerApps,
} from "@conclave/apps-sdk";
import { whiteboardApp } from "@conclave/apps-sdk/whiteboard/web";
import MeetsErrorBanner from "./components/MeetsErrorBanner";
import MeetsHeader from "./components/MeetsHeader";
import MeetsMainContent from "./components/MeetsMainContent";
import MeetsWaitingScreen from "./components/MeetsWaitingScreen";
import MobileMeetsMainContent from "./components/mobile/MobileMeetsMainContent";
import type { ParticipantsPanelGetRooms } from "./components/ParticipantsPanel";
import { useMeetAudioActivity } from "./hooks/useMeetAudioActivity";
import { useMeetChat } from "./hooks/useMeetChat";
import { useMeetDisplayName } from "./hooks/useMeetDisplayName";
import { useMeetGhostMode } from "./hooks/useMeetGhostMode";
import { useMeetHandRaise } from "./hooks/useMeetHandRaise";
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
import { useIsMobile } from "./hooks/useIsMobile";
import { usePrewarmSocket } from "./hooks/usePrewarmSocket";
import { useSharedBrowser } from "./hooks/useSharedBrowser";
import { sanitizeRoomCode } from "./lib/utils";

// ============================================
// Main Component
// ============================================

export type MeetsClientProps = {
  initialRoomId?: string;
  enableRoomRouting?: boolean;
  forceJoinOnly?: boolean;
  allowGhostMode?: boolean;
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
  fontClassName,
  user,
  isAdmin = false,
  getJoinInfo,
  getRooms,
  getRoomsForRedirect,
  reactionAssets,
}: MeetsClientProps) {
  const [currentUser, setCurrentUser] = useState(user);
  const [currentIsAdmin, setCurrentIsAdmin] = useState(isAdmin);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [appsSocket, setAppsSocket] = useState<Socket | null>(null);
  const uploadAsset: AssetUploadHandler = useMemo(
    () => createAssetUploadHandler(),
    []
  );

  useEffect(() => {
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
    isBrowserAudioMuted,
    setIsBrowserAudioMuted,
  } = useMeetState({ initialRoomId });

  const [browserAudioNeedsGesture, setBrowserAudioNeedsGesture] = useState(false);
  const [isBrowserServiceAvailable, setIsBrowserServiceAvailable] = useState(false);
  const toggleMuteCommandRef = useRef<(() => void) | null>(null);
  const toggleCameraCommandRef = useRef<(() => void) | null>(null);
  const setHandRaisedCommandRef = useRef<((raised: boolean) => void) | null>(null);
  const leaveRoomCommandRef = useRef<(() => void) | null>(null);

  const handleToggleMuteCommand = useCallback(() => {
    toggleMuteCommandRef.current?.();
  }, []);

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
  const canSignOut = Boolean(
    currentUser && !currentUser.id?.startsWith("guest-")
  );

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
  const appsUser = useMemo(
    () => ({
      id: userId,
      name:
        displayNameInput ||
        currentUser?.name ||
        currentUser?.email ||
        currentUser?.id ||
        "Guest",
      email: currentUser?.email ?? null,
    }),
    [userId, displayNameInput, currentUser]
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
    isMuted,
    isCameraOff,
    onToggleMute: handleToggleMuteCommand,
    onToggleCamera: handleToggleCameraCommand,
    onSetHandRaised: handleSetHandRaisedCommand,
    onLeaveRoom: handleLeaveCommand,
    onTtsMessage: handleTtsMessage,
  });

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
  }, [localStream, requestMediaPermissions, setLocalStream, setMeetError, stopLocalTrack]);

  const handleTestSpeaker = useCallback(() => {
    primeAudioOutput();
    playNotificationSound("join");
  }, [playNotificationSound, primeAudioOutput]);

  const { toggleHandRaised, setHandRaisedState } = useMeetHandRaise({
    isHandRaised,
    setIsHandRaised,
    isHandRaisedRef: refs.isHandRaisedRef,
    ghostEnabled,
    socketRef: refs.socketRef,
  });

  useEffect(() => {
    setHandRaisedCommandRef.current = setHandRaisedState;
  }, [setHandRaisedState]);

  const socket = useMeetSocket({
    refs,
    roomId,
    setRoomId,
    isAdmin: isAdminFlag,
    setIsAdmin: setCurrentIsAdmin,
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
    onTtsMessage: handleTtsMessage,
    prewarm,
    onSocketReady: setAppsSocket,
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
    browserState?.active || isBrowserServiceAvailable
  );

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

  const joinRoom = socket.joinRoom;
  const joinRoomById = socket.joinRoomById;

  const handleSignOut = useCallback(async () => {
    if (isSigningOut) return;
    setIsSigningOut(true);
    try {
      await signOut();
      setCurrentUser(undefined);
      setCurrentIsAdmin(false);
    } catch (error) {
      console.error("Sign out error:", error);
    } finally {
      setIsSigningOut(false);
    }
  }, [isSigningOut]);

  const leaveRoom = useCallback(() => {
    playNotificationSound("leave");
    socket.cleanup();
  }, [playNotificationSound, socket.cleanup]);

  useEffect(() => {
    leaveRoomCommandRef.current = leaveRoom;
  }, [leaveRoom]);

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
        const data = (await response.json().catch(() => null)) as
          | { ok?: boolean }
          | null;
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
      for (const participant of participants.values()) {
        if (participant.screenShareStream) {
          nextStream = participant.screenShareStream;
          nextPresenterName = resolveDisplayName(participant.userId);
          break;
        }
      }
    }

    return { presentationStream: nextStream, presenterName: nextPresenterName };
  }, [
    activeScreenShareId,
    isScreenSharing,
    localScreenShareStream,
    participants,
    resolveDisplayName,
  ]);

  // Picture-in-Picture for when user tabs away
  useMeetPictureInPicture({
    isJoined: connectionState === "joined",
    localStream,
    participants,
    activeSpeakerId: effectiveActiveSpeakerId,
    presentationStream,
    presenterName,
    currentUserId: userId,
    isCameraOff,
    userEmail,
    getDisplayName: resolveDisplayName,
  });

  // Document PiP popout for mini meeting view
  const {
    isPopoutActive,
    isPopoutSupported,
    openPopout,
    closePopout,
  } = useMeetPopout({
    isJoined: connectionState === "joined",
    localStream,
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

  // ============================================
  // Render Helpers
  // ============================================

  if (!mounted) return null;

  const isJoined = connectionState === "joined";
  const isLoading =
    connectionState === "connecting" ||
    connectionState === "joining" ||
    connectionState === "reconnecting" ||
    connectionState === "waiting"; // Waiting is a kind of loading state visually, or handled separately

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
      />
    );
  }

  if (isMobile) {
    return renderWithApps(
      <div
        className={`flex flex-col h-dvh w-full bg-[#0d0e0d] text-white ${fontClassName ?? ""}`}
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
          presenterName={presenterName}
          localStream={localStream}
          isCameraOff={isCameraOff}
          isMuted={isMuted}
          isHandRaised={isHandRaised}
          participants={participants}
          isMirrorCamera={isMirrorCamera}
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
          isRoomLocked={isRoomLocked}
          onToggleLock={() => socket.toggleRoomLock(!isRoomLocked)}
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
          onTestSpeaker={handleTestSpeaker}
        />
      </div>
    );
  }

  // Desktop layout
  return renderWithApps(
    <div
      className={`flex flex-col h-full w-full bg-[#1a1a1a] text-white ${fontClassName ?? ""}`}
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
        canSignOut={canSignOut}
        isSigningOut={isSigningOut}
        onSignOut={handleSignOut}
      />
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
        isLoading={isLoading}
        roomId={roomId}
        setRoomId={setRoomId}
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
        getRoomsForRedirect={getRoomsForRedirect}
        onUserChange={(user) => setCurrentUser(user ?? undefined)}
        onIsAdminChange={setCurrentIsAdmin}
        isRoomLocked={isRoomLocked}
        onToggleLock={() => socket.toggleRoomLock(!isRoomLocked)}
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
        onTestSpeaker={handleTestSpeaker}
        isPopoutActive={isPopoutActive}
        isPopoutSupported={isPopoutSupported}
        onOpenPopout={openPopout}
        onClosePopout={closePopout}
      />
    </div>
  );
}

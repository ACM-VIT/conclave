"use client";

import { RefreshCw, UserX } from "lucide-react";
import Image from "next/image";
import { useCallback, useEffect, useMemo } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { Socket } from "socket.io-client";
import type { RoomInfo } from "@/lib/sfu-types";
import ChatOverlay from "./ChatOverlay";
import ChatPanel from "./ChatPanel";
import ControlsBar from "./ControlsBar";
import GridLayout from "./GridLayout";
import ConnectionBanner from "./ConnectionBanner";
import JoinScreen from "./JoinScreen";
import ParticipantsPanel from "./ParticipantsPanel";
import PresentationLayout from "./PresentationLayout";
import ReactionOverlay from "./ReactionOverlay";
import BrowserLayout from "./BrowserLayout";
import DevPlaygroundLayout from "./DevPlaygroundLayout";
import SystemAudioPlayers from "./SystemAudioPlayers";
import WhiteboardLayout from "./WhiteboardLayout";
import ParticipantVideo from "./ParticipantVideo";
import type { BrowserState } from "../hooks/useSharedBrowser";
import type { ParticipantsPanelGetRooms } from "./ParticipantsPanel";
import type {
  ChatMessage,
  ConnectionState,
  MeetError,
  Participant,
  ReactionEvent,
  ReactionOption,
  WebinarConfigSnapshot,
  WebinarLinkResponse,
  WebinarUpdateRequest,
} from "../lib/types";
import { isBrowserVideoUserId, isSystemUserId } from "../lib/utils";
import { useApps } from "@conclave/apps-sdk";

interface MeetsMainContentProps {
  isJoined: boolean;
  connectionState: ConnectionState;
  isLoading: boolean;
  roomId: string;
  setRoomId: Dispatch<SetStateAction<string>>;
  joinRoomById: (roomId: string) => void;
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
  setIsGhostMode: Dispatch<SetStateAction<boolean>>;
  presentationStream: MediaStream | null;
  presenterName: string;
  localStream: MediaStream | null;
  isCameraOff: boolean;
  isMuted: boolean;
  isHandRaised: boolean;
  participants: Map<string, Participant>;
  isMirrorCamera: boolean;
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
  chatOverlayMessages: ChatMessage[];
  setChatOverlayMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  socket: Socket | null;
  setPendingUsers: Dispatch<SetStateAction<Map<string, string>>>;
  resolveDisplayName: (userId: string) => string;
  reactions: ReactionEvent[];
  getRoomsForRedirect?: ParticipantsPanelGetRooms;
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
  onRetryMedia?: () => void;
  onTestSpeaker?: () => void;
  isPopoutActive?: boolean;
  isPopoutSupported?: boolean;
  onOpenPopout?: () => void;
  onClosePopout?: () => void;
  hostUserId: string | null;
  isNetworkOffline: boolean;
  isTtsDisabled: boolean;
  webinarConfig?: WebinarConfigSnapshot | null;
  webinarRole?: "attendee" | "participant" | "host" | null;
  webinarLink?: string | null;
  onSetWebinarLink?: (link: string | null) => void;
  onGetWebinarConfig?: () => Promise<WebinarConfigSnapshot | null>;
  onUpdateWebinarConfig?: (
    update: WebinarUpdateRequest,
  ) => Promise<WebinarConfigSnapshot | null>;
  onGenerateWebinarLink?: () => Promise<WebinarLinkResponse | null>;
  onRotateWebinarLink?: () => Promise<WebinarLinkResponse | null>;
}

const getLiveVideoStream = (stream: MediaStream | null): MediaStream | null => {
  if (!stream) return null;
  const [track] = stream.getVideoTracks();
  if (!track || track.readyState === "ended") {
    return null;
  }
  return stream;
};

export default function MeetsMainContent({
  isJoined,
  connectionState,
  isLoading,
  roomId,
  setRoomId,
  joinRoomById,
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
  setIsGhostMode,
  presentationStream,
  presenterName,
  localStream,
  isCameraOff,
  isMuted,
  isHandRaised,
  participants,
  isMirrorCamera,
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
  chatOverlayMessages,
  setChatOverlayMessages,
  socket,
  setPendingUsers,
  resolveDisplayName,
  reactions,
  getRoomsForRedirect,
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
  meetError,
  onDismissMeetError,
  onRetryMedia,
  onTestSpeaker,
  isPopoutActive,
  isPopoutSupported,
  onOpenPopout,
  onClosePopout,
  hostUserId,
  isNetworkOffline,
  isTtsDisabled,
  webinarConfig,
  webinarRole,
  webinarLink,
  onSetWebinarLink,
  onGetWebinarConfig,
  onUpdateWebinarConfig,
  onGenerateWebinarLink,
  onRotateWebinarLink,
}: MeetsMainContentProps) {
  const {
    state: appsState,
    openApp,
    closeApp,
    setLocked,
    refreshState,
  } = useApps();
  const isDevPlaygroundEnabled = process.env.NODE_ENV === "development";
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
    }
  }, [connectionState, refreshState]);
  const participantsArray = useMemo(
    () => Array.from(participants.values()),
    [participants],
  );
  const nonSystemParticipants = useMemo(
    () =>
      participantsArray.filter(
        (participant) => !isSystemUserId(participant.userId),
      ),
    [participantsArray],
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
          screenShareParticipant.videoStream,
        );

        return {
          main: {
            participant: {
              ...screenShareParticipant,
              videoStream: screenShareStream,
              audioStream: mainAudioStream,
              isCameraOff: false,
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
                },
                displayName: resolveDisplayName(screenShareParticipant.userId),
              }
            : null,
          isScreenShare: true,
        };
      }
    }

    const cameraParticipant =
      nonSystemParticipants.find(
        (participant) =>
          !participant.isCameraOff &&
          getLiveVideoStream(participant.videoStream),
      ) ??
      nonSystemParticipants.find((participant) =>
        getLiveVideoStream(participant.videoStream),
      ) ??
      nonSystemParticipants.find((participant) => participant.audioStream) ??
      nonSystemParticipants[0];
    const cameraStream = getLiveVideoStream(cameraParticipant.videoStream);
    const mainAudioStream = cameraParticipant.audioStream ?? fallbackAudioStream;

    return {
      main: {
        participant: {
          ...cameraParticipant,
          videoStream: cameraStream,
          screenShareStream: null,
          audioStream: mainAudioStream,
          isCameraOff: !cameraStream,
        },
        displayName: resolveDisplayName(cameraParticipant.userId),
      },
      pip: null,
      isScreenShare: false,
    };
  }, [activeScreenShareId, nonSystemParticipants, resolveDisplayName]);
  const visibleParticipantCount = nonSystemParticipants.length;
  const handleToggleParticipants = useCallback(
    () =>
      setIsParticipantsOpen((prev) => {
        const next = !prev;
        if (next && isChatOpen) {
          toggleChat();
        }
        return next;
      }),
    [isChatOpen, setIsParticipantsOpen, toggleChat],
  );

  const handleCloseParticipants = useCallback(
    () => setIsParticipantsOpen(false),
    [setIsParticipantsOpen],
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
  const handleToggleChat = useCallback(() => {
    if (!isChatOpen && isParticipantsOpen) {
      setIsParticipantsOpen(false);
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
  return (
    <div
      className={`flex-1 flex flex-col overflow-hidden relative ${isJoined ? "p-4" : "p-0"}`}
    >
      {isJoined && !isWebinarAttendee && (
        <ConnectionBanner
          state={connectionState}
          isOffline={isNetworkOffline}
        />
      )}
      <SystemAudioPlayers
        participants={participants}
        audioOutputDeviceId={audioOutputDeviceId}
        muted={isBrowserAudioMuted}
        onAutoplayBlocked={onBrowserAudioAutoplayBlocked}
      />
      {isJoined && reactions.length > 0 && (
        <ReactionOverlay
          reactions={reactions}
          getDisplayName={resolveDisplayName}
        />
      )}
      {!isJoined ? (
        hideJoinUI ? (
          <div className="flex flex-1 items-center justify-center">
            <div className="rounded-xl border border-white/10 bg-black/40 px-6 py-4 text-center">
              <p className="text-sm text-[#FEFCD9]">
                {isLoading ? "Joining webinar..." : "Preparing webinar..."}
              </p>
              {meetError ? (
                <p className="mt-2 text-xs text-[#F95F4A]">{meetError.message}</p>
              ) : null}
            </div>
          </div>
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
            isGhostMode={ghostEnabled}
            onGhostModeChange={setIsGhostMode}
            onUserChange={onUserChange}
            onIsAdminChange={onIsAdminChange}
            meetError={meetError}
            onDismissMeetError={onDismissMeetError}
            onRetryMedia={onRetryMedia}
            onTestSpeaker={onTestSpeaker}
          />
        )
      ) : isWebinarAttendee ? (
        <div className="flex flex-1 items-center justify-center p-4">
          {webinarStage ? (
            <div className="relative h-[72vh] w-full max-w-6xl">
              <ParticipantVideo
                participant={webinarStage.main.participant}
                displayName={webinarStage.main.displayName}
                isActiveSpeaker={
                  activeSpeakerId === webinarStage.main.participant.userId
                }
                audioOutputDeviceId={audioOutputDeviceId}
                videoObjectFit={webinarStage.isScreenShare ? "contain" : "cover"}
              />
              {webinarStage.pip ? (
                <div className="pointer-events-none absolute bottom-4 right-4 h-28 w-44 overflow-hidden rounded-xl border border-[#FEFCD9]/20 bg-black/75 shadow-[0_16px_36px_rgba(0,0,0,0.5)] sm:h-32 sm:w-56">
                  <ParticipantVideo
                    participant={webinarStage.pip.participant}
                    displayName={webinarStage.pip.displayName}
                  />
                </div>
              ) : null}
            </div>
          ) : (
            <div className="rounded-xl border border-white/10 bg-black/40 px-6 py-4 text-center">
              <p className="text-sm text-[#FEFCD9]">
                Waiting for the host to start speaking...
              </p>
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
          isMirrorCamera={isMirrorCamera}
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
          isMirrorCamera={isMirrorCamera}
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
          isMirrorCamera={isMirrorCamera}
          activeSpeakerId={activeSpeakerId}
          currentUserId={currentUserId}
          audioOutputDeviceId={audioOutputDeviceId}
          getDisplayName={resolveDisplayName}
          isAdmin={isAdmin}
          isBrowserLaunching={isBrowserLaunching}
          onNavigateBrowser={onNavigateBrowser}
          browserVideoStream={browserVideoStream}
        />
      ) : presentationStream ? (
        <PresentationLayout
          presentationStream={presentationStream}
          presenterName={presenterName}
          localStream={localStream}
          isCameraOff={isCameraOff}
          isMuted={isMuted}
          isHandRaised={isHandRaised}
          isGhost={ghostEnabled}
          participants={participants}
          userEmail={userEmail}
          isMirrorCamera={isMirrorCamera}
          activeSpeakerId={activeSpeakerId}
          currentUserId={currentUserId}
          audioOutputDeviceId={audioOutputDeviceId}
          getDisplayName={resolveDisplayName}
        />
      ) : (
        <GridLayout
          localStream={localStream}
          isCameraOff={isCameraOff}
          isMuted={isMuted}
          isHandRaised={isHandRaised}
          isGhost={ghostEnabled}
          participants={participants}
          userEmail={userEmail}
          isMirrorCamera={isMirrorCamera}
          activeSpeakerId={activeSpeakerId}
          currentUserId={currentUserId}
          audioOutputDeviceId={audioOutputDeviceId}
          getDisplayName={resolveDisplayName}
        />
      )}

      {isJoined && browserLaunchError && (
        <div className="absolute top-4 right-4 max-w-[320px] rounded-lg border border-[#F95F4A]/30 bg-[#0d0e0d]/95 px-4 py-3 text-xs text-[#FEFCD9]/90 shadow-2xl">
          <div className="flex items-start gap-3">
            <span className="font-medium text-[#F95F4A]">Browser error</span>
            {onClearBrowserError && (
              <button
                onClick={onClearBrowserError}
                className="ml-auto text-[#FEFCD9]/50 hover:text-[#FEFCD9]"
                aria-label="Dismiss browser error"
              >
                X
              </button>
            )}
          </div>
          <p className="mt-1 text-[11px] text-[#FEFCD9]/70">
            {browserLaunchError}
          </p>
        </div>
      )}

      {isJoined &&
        (isWebinarAttendee ? (
          <div className="flex items-center justify-between gap-3 rounded-2xl border border-white/10 bg-black/30 px-4 py-3">
            <div>
              <p className="text-xs text-[#FEFCD9]/70">
                {webinarConfig?.attendeeCount ?? 0} attendees watching
              </p>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-3">
            <a href="/" className="flex items-center">
              <Image
                src="/assets/acm_topleft.svg"
                alt="ACM Logo"
                width={129}
                height={129}
              />
            </a>
            <div className="flex-1 flex justify-center">
              <ControlsBar
                isMuted={isMuted}
                isCameraOff={isCameraOff}
                isScreenSharing={isScreenSharing}
                activeScreenShareId={activeScreenShareId}
                isChatOpen={isChatOpen}
                unreadCount={unreadCount}
                isHandRaised={isHandRaised}
                reactionOptions={reactionOptions}
                onToggleMute={toggleMute}
                onToggleCamera={toggleCamera}
                onToggleScreenShare={toggleScreenShare}
                onToggleChat={handleToggleChat}
                onToggleHandRaised={toggleHandRaised}
                onSendReaction={sendReaction}
                onLeave={leaveRoom}
                isAdmin={isAdmin}
                isGhostMode={ghostEnabled}
                isParticipantsOpen={isParticipantsOpen}
                onToggleParticipants={handleToggleParticipants}
                pendingUsersCount={isAdmin ? pendingUsers.size : 0}
                isRoomLocked={isRoomLocked}
                onToggleLock={onToggleLock}
                isNoGuests={isNoGuests}
                onToggleNoGuests={onToggleNoGuests}
                isChatLocked={isChatLocked}
                onToggleChatLock={onToggleChatLock}
                isTtsDisabled={isTtsDisabled}
                onToggleTtsDisabled={handleToggleTtsDisabled}
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
                isPopoutActive={isPopoutActive}
                isPopoutSupported={isPopoutSupported}
                onOpenPopout={onOpenPopout}
                onClosePopout={onClosePopout}
                webinarConfig={webinarConfig}
                webinarRole={webinarRole}
                webinarLink={webinarLink}
                onSetWebinarLink={onSetWebinarLink}
                onGetWebinarConfig={onGetWebinarConfig}
                onUpdateWebinarConfig={onUpdateWebinarConfig}
                onGenerateWebinarLink={onGenerateWebinarLink}
                onRotateWebinarLink={onRotateWebinarLink}
              />
            </div>
            <div className="flex items-center gap-4">
              {isScreenSharing && (
                <div
                  className="flex items-center gap-1.5 text-[#F95F4A] text-[10px] uppercase tracking-wider"
                  style={{ fontFamily: "'PolySans Mono', monospace" }}
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-[#F95F4A]"></span>
                  Sharing
                </div>
              )}
              {ghostEnabled && (
                <div
                  className="flex items-center gap-1.5 text-[#FF007A] text-[10px] uppercase tracking-wider"
                  style={{ fontFamily: "'PolySans Mono', monospace" }}
                >
                  <UserX className="w-3 h-3" />
                  Ghost
                </div>
              )}
              {connectionState === "reconnecting" && (
                <div
                  className="flex items-center gap-1.5 text-amber-400 text-[10px] uppercase tracking-wider"
                  style={{ fontFamily: "'PolySans Mono', monospace" }}
                >
                  <RefreshCw className="w-3 h-3 animate-spin" />
                  Reconnecting
                </div>
              )}
              <div
                className="flex items-center gap-1 text-[#FEFCD9]/60 text-[10px] uppercase tracking-wider"
                style={{ fontFamily: "'PolySans Mono', monospace" }}
              >
                <span className="inline-flex h-1.5 w-1.5 rounded-full bg-emerald-400" />
                {visibleParticipantCount + 1} in call
              </div>
              <div className="flex flex-col items-end">
                <span
                  className="text-sm text-[#FEFCD9]"
                  style={{ fontFamily: "'PolySans Bulky Wide', sans-serif" }}
                >
                  c0nclav3
                </span>
                <span
                  className="text-[9px] uppercase tracking-[0.15em] text-[#FEFCD9]/40"
                  style={{ fontFamily: "'PolySans Mono', monospace" }}
                >
                  by acm-vit
                </span>
              </div>
            </div>
            {browserAudioNeedsGesture && (
              <div className="w-full mt-2 text-center text-[11px] text-[#F95F4A]/70 uppercase tracking-[0.3em]">
                Click “Shared browser audio” to unlock the system sound.
              </div>
            )}
          </div>
        ))}

      {isJoined && !isWebinarAttendee && isChatOpen && (
        <ChatPanel
          messages={chatMessages}
          chatInput={chatInput}
          onInputChange={setChatInput}
          onSend={sendChat}
          onClose={handleToggleChat}
          currentUserId={currentUserId}
          isGhostMode={ghostEnabled}
          isChatLocked={isChatLocked}
          isAdmin={isAdmin}
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
          roomId={roomId}
          localState={{
            isMuted,
            isCameraOff,
            isHandRaised,
            isScreenSharing,
          }}
          getRooms={getRoomsForRedirect}
          getDisplayName={resolveDisplayName}
          onPendingUserStale={handlePendingUserStale}
          hostUserId={hostUserId}
        />
      )}

      {isJoined && !isWebinarAttendee && chatOverlayMessages.length > 0 && (
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

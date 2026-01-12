"use client";

import { Ghost, RefreshCw, UserX } from "lucide-react";
import { memo, useCallback } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { Socket } from "socket.io-client";
import type { RoomInfo } from "@/lib/sfu-types";
import type {
  ChatMessage,
  ConnectionState,
  Participant,
  ReactionEvent,
  ReactionOption,
} from "../../types";
import ChatOverlay from "../ChatOverlay";
import ReactionOverlay from "../ReactionOverlay";
import MobileChatPanel from "./MobileChatPanel";
import MobileControlsBar from "./MobileControlsBar";
import MobileGridLayout from "./MobileGridLayout";
import MobileJoinScreen from "./MobileJoinScreen";
import MobileParticipantsPanel from "./MobileParticipantsPanel";
import MobilePresentationLayout from "./MobilePresentationLayout";

interface MobileMeetsMainContentProps {
  isJoined: boolean;
  connectionState: ConnectionState;
  isLoading: boolean;
  roomId: string;
  setRoomId: Dispatch<SetStateAction<string>>;
  joinRoom: () => void;
  joinRoomById: (roomId: string) => void;
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
  onUserChange: (user: { id: string; email: string; name: string } | null) => void;
  onIsAdminChange: (isAdmin: boolean) => void;
}

function MobileMeetsMainContent({
  isJoined,
  connectionState,
  isLoading,
  roomId,
  setRoomId,
  joinRoom,
  joinRoomById,
  enableRoomRouting,
  forceJoinOnly,
  allowGhostMode,
  user,
  userEmail,
  isAdmin,
  showPermissionHint,
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
  onUserChange,
  onIsAdminChange,
}: MobileMeetsMainContentProps) {
  const handleToggleParticipants = useCallback(
    () => setIsParticipantsOpen((prev) => !prev),
    [setIsParticipantsOpen]
  );

  const handleCloseParticipants = useCallback(
    () => setIsParticipantsOpen(false),
    [setIsParticipantsOpen]
  );

  if (!isJoined) {
    return (
      <MobileJoinScreen
        roomId={roomId}
        onRoomIdChange={setRoomId}
        onJoin={joinRoom}
        onJoinRoom={joinRoomById}
        isLoading={isLoading}
        user={user}
        userEmail={userEmail}
        connectionState={connectionState}
        isAdmin={isAdmin}
        enableRoomRouting={enableRoomRouting}
        forceJoinOnly={forceJoinOnly}
        allowGhostMode={allowGhostMode}
        showPermissionHint={showPermissionHint}
        displayNameInput={displayNameInput}
        onDisplayNameInputChange={setDisplayNameInput}
        isGhostMode={ghostEnabled}
        onGhostModeChange={setIsGhostMode}
        onUserChange={onUserChange}
        onIsAdminChange={onIsAdminChange}
      />
    );
  }

  return (
    <div className="flex-1 flex flex-col bg-[#0d0e0d] overflow-hidden relative h-full">
      {/* Status bar area */}
      <div className="safe-area-pt bg-[#0d0e0d]" />

      {/* Header with room info */}
      <div className="flex items-center justify-between px-4 py-2 bg-[#0d0e0d]">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-[#FEFCD9]">
            {roomId.toUpperCase()}
          </span>
          <span className="text-[10px] text-[#FEFCD9]/40 uppercase">
            • {participants.size + 1} in call
          </span>
        </div>
        <div className="flex items-center gap-2">
          {isScreenSharing && (
            <div className="flex items-center gap-1 text-[#F95F4A] text-[9px] uppercase tracking-wider">
              <span className="w-1.5 h-1.5 rounded-full bg-[#F95F4A] animate-pulse" />
              Sharing
            </div>
          )}
          {ghostEnabled && (
            <div className="flex items-center gap-1 text-[#FF007A] text-[9px] uppercase tracking-wider">
              <Ghost className="w-3 h-3" />
            </div>
          )}
          {connectionState === "reconnecting" && (
            <div className="flex items-center gap-1 text-amber-400 text-[9px] uppercase tracking-wider">
              <RefreshCw className="w-3 h-3 animate-spin" />
            </div>
          )}
        </div>
      </div>

      {/* Reactions overlay */}
      {reactions.length > 0 && (
        <ReactionOverlay reactions={reactions} getDisplayName={resolveDisplayName} />
      )}

      {/* Main content area - with padding for controls */}
      <div className="flex-1 min-h-0 pb-20">
        {presentationStream ? (
          <MobilePresentationLayout
            presentationStream={presentationStream}
            presenterName={presenterName}
            localStream={localStream}
            isCameraOff={isCameraOff}
            isMuted={isMuted}
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
          <MobileGridLayout
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
      </div>

      {/* Chat overlay messages */}
      {chatOverlayMessages.length > 0 && (
        <div className="absolute top-16 left-4 right-4 z-30 pointer-events-none">
          <ChatOverlay
            messages={chatOverlayMessages}
            onDismiss={(id) =>
              setChatOverlayMessages((prev) => prev.filter((m) => m.id !== id))
            }
          />
        </div>
      )}

      {/* Controls bar */}
      <MobileControlsBar
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
        onToggleChat={toggleChat}
        onToggleHandRaised={toggleHandRaised}
        onSendReaction={sendReaction}
        onLeave={leaveRoom}
        isGhostMode={ghostEnabled}
        isParticipantsOpen={isParticipantsOpen}
        onToggleParticipants={handleToggleParticipants}
        pendingUsersCount={isAdmin ? pendingUsers.size : 0}
      />

      {/* Full-screen chat panel */}
      {isChatOpen && (
        <MobileChatPanel
          messages={chatMessages}
          chatInput={chatInput}
          onInputChange={setChatInput}
          onSend={sendChat}
          onClose={toggleChat}
          currentUserId={currentUserId}
          isGhostMode={ghostEnabled}
          getDisplayName={resolveDisplayName}
        />
      )}

      {/* Full-screen participants panel */}
      {isParticipantsOpen && (
        <MobileParticipantsPanel
          participants={participants}
          currentUserId={currentUserId}
          onClose={handleCloseParticipants}
          socket={socket}
          isAdmin={isAdmin}
          pendingUsers={pendingUsers}
          getDisplayName={resolveDisplayName}
        />
      )}
    </div>
  );
}

export default memo(MobileMeetsMainContent);

"use client";

import {
  Hand,
  Lock,
  LockOpen,
  MessageSquare,
  Mic,
  MicOff,
  MoreVertical,
  Phone,
  Smile,
  Users,
  Video,
  VideoOff,
  Monitor,
  X,
} from "lucide-react";
import { memo, useCallback, useRef, useState } from "react";
import type { ReactionOption } from "../../types";

interface MobileControlsBarProps {
  isMuted: boolean;
  isCameraOff: boolean;
  isScreenSharing: boolean;
  activeScreenShareId: string | null;
  isChatOpen: boolean;
  unreadCount: number;
  isHandRaised: boolean;
  reactionOptions: ReactionOption[];
  onToggleMute: () => void;
  onToggleCamera: () => void;
  onToggleScreenShare: () => void;
  onToggleChat: () => void;
  onToggleHandRaised: () => void;
  onSendReaction: (reaction: ReactionOption) => void;
  onLeave: () => void;
  isGhostMode?: boolean;
  isAdmin?: boolean;
  isParticipantsOpen?: boolean;
  onToggleParticipants?: () => void;
  pendingUsersCount?: number;
  isRoomLocked?: boolean;
  onToggleLock?: () => void;
}

function MobileControlsBar({
  isMuted,
  isCameraOff,
  isScreenSharing,
  activeScreenShareId,
  isChatOpen,
  unreadCount,
  isHandRaised,
  reactionOptions,
  onToggleMute,
  onToggleCamera,
  onToggleScreenShare,
  onToggleChat,
  onToggleHandRaised,
  onSendReaction,
  onLeave,
  isGhostMode = false,
  isAdmin = false,
  isParticipantsOpen,
  onToggleParticipants,
  pendingUsersCount = 0,
  isRoomLocked = false,
  onToggleLock,
}: MobileControlsBarProps) {
  const [isMoreMenuOpen, setIsMoreMenuOpen] = useState(false);
  const [isReactionMenuOpen, setIsReactionMenuOpen] = useState(false);
  const lastReactionTimeRef = useRef<number>(0);
  const REACTION_COOLDOWN_MS = 150;

  const canStartScreenShare = !activeScreenShareId || isScreenSharing;

  const baseButtonClass =
    "w-12 h-12 rounded-full flex items-center justify-center transition-all active:scale-95";
  const defaultButtonClass = `${baseButtonClass} bg-[#2a2a2a] text-[#FEFCD9]/80`;
  const activeButtonClass = `${baseButtonClass} bg-[#F95F4A] text-white`;
  const mutedButtonClass = `${baseButtonClass} bg-[#F95F4A]/15 text-[#F95F4A]`;
  const ghostDisabledClass = `${baseButtonClass} bg-[#2a2a2a] opacity-30`;
  const leaveButtonClass = `${baseButtonClass} bg-red-500 text-white`;

  const handleReactionClick = useCallback(
    (reaction: ReactionOption) => {
      const now = Date.now();
      if (now - lastReactionTimeRef.current < REACTION_COOLDOWN_MS) {
        return;
      }
      lastReactionTimeRef.current = now;
      onSendReaction(reaction);
      setIsReactionMenuOpen(false);
    },
    [onSendReaction]
  );

  return (
    <>
      {/* Reaction menu overlay */}
      {isReactionMenuOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-40"
          onClick={() => setIsReactionMenuOpen(false)}
        >
          <div
            className="absolute bottom-20 left-4 right-4 flex items-center justify-center gap-3 rounded-2xl bg-[#1a1a1a] border border-[#FEFCD9]/10 px-4 py-4 overflow-x-auto touch-pan-x"
            onClick={(e) => e.stopPropagation()}
          >
            {reactionOptions.map((reaction) => (
              <button
                key={reaction.id}
                onClick={() => handleReactionClick(reaction)}
                className="w-12 h-12 shrink-0 rounded-full text-2xl hover:bg-[#FEFCD9]/10 active:scale-110 flex items-center justify-center transition-transform"
              >
                {reaction.kind === "emoji" ? (
                  reaction.value
                ) : (
                  <img
                    src={reaction.value}
                    alt={reaction.label}
                    className="w-8 h-8 object-contain"
                  />
                )}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* More menu overlay */}
      {isMoreMenuOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-40"
          onClick={() => setIsMoreMenuOpen(false)}
        >
          <div
            className="absolute bottom-20 right-4 left-4 bg-[#1a1a1a] border border-[#FEFCD9]/10 rounded-2xl py-2 max-h-[50vh] overflow-y-auto touch-pan-y"
            style={{ fontFamily: "'PolySans Mono', monospace" }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={() => {
                onToggleParticipants?.();
                setIsMoreMenuOpen(false);
              }}
              className="w-full flex items-center gap-3 px-4 py-3 text-[#FEFCD9] hover:bg-[#FEFCD9]/5 active:bg-[#FEFCD9]/10"
            >
              <Users className="w-5 h-5" />
              <span className="text-sm font-medium">Participants</span>
              {pendingUsersCount > 0 && (
                <span className="ml-auto text-xs bg-[#F95F4A] text-white px-1.5 py-0.5 rounded-full font-bold">
                  {pendingUsersCount}
                </span>
              )}
            </button>
            <button
              onClick={() => {
                onToggleHandRaised();
                setIsMoreMenuOpen(false);
              }}
              disabled={isGhostMode}
              className={`w-full flex items-center gap-3 px-4 py-3 ${isGhostMode
                  ? "opacity-30"
                  : isHandRaised
                    ? "text-amber-400"
                    : "text-[#FEFCD9]"
                } hover:bg-[#FEFCD9]/5 active:bg-[#FEFCD9]/10`}
            >
              <Hand className="w-5 h-5" />
              <span className="text-sm font-medium">{isHandRaised ? "Lower hand" : "Raise hand"}</span>
            </button>
            <button
              onClick={() => {
                onToggleScreenShare();
                setIsMoreMenuOpen(false);
              }}
              disabled={isGhostMode || !canStartScreenShare}
              className={`w-full flex items-center gap-3 px-4 py-3 ${isGhostMode || !canStartScreenShare
                  ? "opacity-30"
                  : isScreenSharing
                    ? "text-[#F95F4A]"
                    : "text-[#FEFCD9]"
                } hover:bg-[#FEFCD9]/5 active:bg-[#FEFCD9]/10`}
            >
              <Monitor className="w-5 h-5" />
              <span className="text-sm font-medium">{isScreenSharing ? "Stop sharing" : "Share screen"}</span>
            </button>
            {isAdmin && (
              <button
                onClick={() => {
                  onToggleLock?.();
                  setIsMoreMenuOpen(false);
                }}
                className={`w-full flex items-center gap-3 px-4 py-3 ${isRoomLocked
                    ? "text-amber-400"
                    : "text-[#FEFCD9]"
                  } hover:bg-[#FEFCD9]/5 active:bg-[#FEFCD9]/10`}
              >
                {isRoomLocked ? (
                  <Lock className="w-5 h-5" />
                ) : (
                  <LockOpen className="w-5 h-5" />
                )}
                <span className="text-sm font-medium">{isRoomLocked ? "Unlock meeting" : "Lock meeting"}</span>
              </button>
            )}
          </div>
        </div>
      )}

      {/* Main controls bar */}
      <div className="fixed bottom-0 left-0 right-0 safe-area-pb bg-gradient-to-t from-black via-black/95 to-transparent pt-6 pb-6 px-4">
        <div className="flex items-center justify-between max-w-md mx-auto">
          {/* Mute button */}
          <button
            onClick={onToggleMute}
            disabled={isGhostMode}
            className={
              isGhostMode
                ? ghostDisabledClass
                : isMuted
                  ? mutedButtonClass
                  : defaultButtonClass
            }
          >
            {isMuted ? <MicOff className="w-5 h-5" /> : <Mic className="w-5 h-5" />}
          </button>

          {/* Camera button */}
          <button
            onClick={onToggleCamera}
            disabled={isGhostMode}
            className={
              isGhostMode
                ? ghostDisabledClass
                : isCameraOff
                  ? mutedButtonClass
                  : defaultButtonClass
            }
          >
            {isCameraOff ? <VideoOff className="w-5 h-5" /> : <Video className="w-5 h-5" />}
          </button>

          {/* Reactions button */}
          <button
            onClick={() => setIsReactionMenuOpen(true)}
            disabled={isGhostMode}
            className={isGhostMode ? ghostDisabledClass : defaultButtonClass}
          >
            <Smile className="w-5 h-5" />
          </button>

          {/* Chat button */}
          <button
            onClick={onToggleChat}
            className={`relative ${isChatOpen ? activeButtonClass : defaultButtonClass}`}
          >
            <MessageSquare className="w-5 h-5" />
            {unreadCount > 0 && (
              <span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] px-1 text-[10px] font-bold bg-[#F95F4A] text-white rounded-full flex items-center justify-center">
                {unreadCount > 9 ? "9+" : unreadCount}
              </span>
            )}
          </button>

          {/* More button */}
          <button
            onClick={() => setIsMoreMenuOpen(true)}
            className={defaultButtonClass}
          >
            <MoreVertical className="w-5 h-5" />
          </button>

          {/* Leave button */}
          <button onClick={onLeave} className={leaveButtonClass}>
            <Phone className="rotate-[135deg] w-5 h-5" />
          </button>
        </div>
      </div>
    </>
  );
}

export default memo(MobileControlsBar);

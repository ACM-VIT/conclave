"use client";

import {
  Hand,
  MessageSquare,
  Mic,
  MicOff,
  Monitor,
  Phone,
  Smile,
  Users,
  Video,
  VideoOff,
} from "lucide-react";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import type { ReactionOption } from "../types";

interface ControlsBarProps {
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
  isAdmin?: boolean | null;
  isGhostMode?: boolean;
  isParticipantsOpen?: boolean;
  onToggleParticipants?: () => void;
  pendingUsersCount?: number;
}

function ControlsBar({
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
  isAdmin,
  isGhostMode = false,
  isParticipantsOpen,
  onToggleParticipants,
  pendingUsersCount = 0,
}: ControlsBarProps) {
  const canStartScreenShare = !activeScreenShareId || isScreenSharing;
  const [isReactionMenuOpen, setIsReactionMenuOpen] = useState(false);
  const reactionMenuRef = useRef<HTMLDivElement>(null);
  const lastReactionTimeRef = useRef<number>(0);
  const REACTION_COOLDOWN_MS = 150;
  
  const baseButtonClass = "w-11 h-11 rounded-full flex items-center justify-center transition-all text-[#FEFCD9]/80 hover:text-[#FEFCD9] hover:bg-[#FEFCD9]/10";
  const defaultButtonClass = baseButtonClass;
  const activeButtonClass = `${baseButtonClass} !bg-[#F95F4A] !text-white`;
  const mutedButtonClass = `${baseButtonClass} !text-[#F95F4A] !bg-[#F95F4A]/15`;
  const ghostDisabledClass = `${baseButtonClass} !opacity-30 cursor-not-allowed`;
  const screenShareDisabled = isGhostMode || !canStartScreenShare;

  useEffect(() => {
    if (!isReactionMenuOpen) return;

    const handleClickOutside = (event: MouseEvent) => {
      if (
        reactionMenuRef.current &&
        !reactionMenuRef.current.contains(event.target as Node)
      ) {
        setIsReactionMenuOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isReactionMenuOpen]);

  const handleReactionClick = useCallback(
    (reaction: ReactionOption) => {
      const now = Date.now();
      if (now - lastReactionTimeRef.current < REACTION_COOLDOWN_MS) {
        return;
      }
      lastReactionTimeRef.current = now;
      onSendReaction(reaction);
    },
    [onSendReaction]
  );

  return (
    <div className="flex justify-center items-center gap-1 shrink-0 py-2 px-3 bg-black/40 backdrop-blur-sm rounded-full mx-auto"
      style={{ fontFamily: "'PolySans Mono', monospace" }}
    >
      <button
        onClick={onToggleParticipants}
        className={`relative ${isParticipantsOpen ? activeButtonClass : defaultButtonClass}`}
        title="Participants"
      >
        <Users className="w-4 h-4" />
        {pendingUsersCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-[16px] px-1 text-[10px] font-bold bg-[#F95F4A] text-white rounded-full flex items-center justify-center">
            {pendingUsersCount > 9 ? "9+" : pendingUsersCount}
          </span>
        )}
      </button>

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
        title={isGhostMode ? "Ghost mode: mic locked" : isMuted ? "Unmute" : "Mute"}
      >
        {isMuted ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
      </button>

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
        title={
          isGhostMode
            ? "Ghost mode: camera locked"
            : isCameraOff
            ? "Turn on camera"
            : "Turn off camera"
        }
      >
        {isCameraOff ? (
          <VideoOff className="w-4 h-4" />
        ) : (
          <Video className="w-4 h-4" />
        )}
      </button>

      <button
        onClick={onToggleScreenShare}
        disabled={screenShareDisabled}
        className={
          isScreenSharing
            ? activeButtonClass
            : screenShareDisabled
            ? ghostDisabledClass
            : defaultButtonClass
        }
        title={
          isGhostMode
            ? "Ghost mode: screen share locked"
            : !canStartScreenShare
            ? "Someone else is presenting"
            : isScreenSharing
            ? "Stop sharing"
            : "Share screen"
        }
      >
        <Monitor className="w-4 h-4" />
      </button>

      <button
        onClick={onToggleHandRaised}
        disabled={isGhostMode}
        className={
          isGhostMode
            ? ghostDisabledClass
            : isHandRaised
            ? `${baseButtonClass} !bg-amber-400 !text-black`
            : defaultButtonClass
        }
        title={
          isGhostMode
            ? "Ghost mode: hand raise locked"
            : isHandRaised
            ? "Lower hand"
            : "Raise hand"
        }
      >
        <Hand className="w-4 h-4" />
      </button>

      <div ref={reactionMenuRef} className="relative">
        <button
          onClick={() => setIsReactionMenuOpen((prev) => !prev)}
          disabled={isGhostMode}
          className={
            isGhostMode
              ? ghostDisabledClass
              : isReactionMenuOpen
              ? activeButtonClass
              : defaultButtonClass
          }
          title={isGhostMode ? "Ghost mode: reactions locked" : "Reactions"}
        >
          <Smile className="w-4 h-4" />
        </button>

        {isReactionMenuOpen && (
          <div className="absolute bottom-14 left-1/2 -translate-x-1/2 flex items-center gap-1 rounded-full bg-black/90 backdrop-blur-md px-2 py-1.5 max-w-[300px] overflow-x-auto no-scrollbar">
            {reactionOptions.map((reaction) => (
              <button
                key={reaction.id}
                onClick={() => handleReactionClick(reaction)}
                className="w-8 h-8 shrink-0 rounded-full text-lg hover:bg-[#FEFCD9]/10 transition-all flex items-center justify-center hover:scale-110"
                title={`React ${reaction.label}`}
              >
                {reaction.kind === "emoji" ? (
                  reaction.value
                ) : (
                  <img
                    src={reaction.value}
                    alt={reaction.label}
                    className="w-5 h-5 object-contain"
                    loading="lazy"
                  />
                )}
              </button>
            ))}
          </div>
        )}
      </div>

      <button
        onClick={onToggleChat}
        className={`relative ${isChatOpen ? activeButtonClass : defaultButtonClass}`}
        title="Chat"
      >
        <MessageSquare className="w-4 h-4" />
        {unreadCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-[16px] px-1 text-[10px] font-bold bg-[#F95F4A] text-white rounded-full flex items-center justify-center">
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </button>

      <div className="w-px h-6 bg-[#FEFCD9]/10 mx-1" />

      <button
        onClick={onLeave}
        className={`${baseButtonClass} !text-red-400 hover:!bg-red-500/20`}
        title="Leave meeting"
      >
        <Phone className="rotate-[135deg] w-4 h-4" />
      </button>
    </div>
  );
}

export default memo(ControlsBar);

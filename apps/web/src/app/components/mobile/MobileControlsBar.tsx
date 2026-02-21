"use client";

import {
  Code2,
  Hand,
  Globe,
  Lock,
  LockOpen,
  MessageSquare,
  MessageSquareLock,
  Mic,
  MicOff,
  MoreVertical,
  Phone,
  Smile,
  Users,
  Video,
  VideoOff,
  Monitor,
  Volume2,
  VolumeX,
  X,
  ShieldBan,
} from "lucide-react";
import { memo, useCallback, useRef, useState } from "react";
import type { ReactionOption } from "../../lib/types";
import { normalizeBrowserUrl } from "../../lib/utils";

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
  isNoGuests?: boolean;
  onToggleNoGuests?: () => void;
  isChatLocked?: boolean;
  onToggleChatLock?: () => void;
  isTtsDisabled?: boolean;
  onToggleTtsDisabled?: () => void;
  isBrowserActive?: boolean;
  isBrowserLaunching?: boolean;
  showBrowserControls?: boolean;
  onLaunchBrowser?: (url: string) => Promise<boolean>;
  onNavigateBrowser?: (url: string) => Promise<boolean>;
  onCloseBrowser?: () => Promise<boolean>;
  hasBrowserAudio?: boolean;
  isBrowserAudioMuted?: boolean;
  onToggleBrowserAudio?: () => void;
  isWhiteboardActive?: boolean;
  onOpenWhiteboard?: () => void;
  onCloseWhiteboard?: () => void;
  isDevPlaygroundEnabled?: boolean;
  isDevPlaygroundActive?: boolean;
  onOpenDevPlayground?: () => void;
  onCloseDevPlayground?: () => void;
  isAppsLocked?: boolean;
  onToggleAppsLock?: () => void;
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
  isNoGuests = false,
  onToggleNoGuests,
  isChatLocked = false,
  onToggleChatLock,
  isTtsDisabled = false,
  onToggleTtsDisabled,
  isBrowserActive = false,
  isBrowserLaunching = false,
  showBrowserControls = true,
  onLaunchBrowser,
  onNavigateBrowser,
  onCloseBrowser,
  hasBrowserAudio = false,
  isBrowserAudioMuted = false,
  onToggleBrowserAudio,
  isWhiteboardActive = false,
  onOpenWhiteboard,
  onCloseWhiteboard,
  isDevPlaygroundEnabled = false,
  isDevPlaygroundActive = false,
  onOpenDevPlayground,
  onCloseDevPlayground,
  isAppsLocked = false,
  onToggleAppsLock,
}: MobileControlsBarProps) {
  const [isMoreMenuOpen, setIsMoreMenuOpen] = useState(false);
  const [isReactionMenuOpen, setIsReactionMenuOpen] = useState(false);
  const [isBrowserSheetOpen, setIsBrowserSheetOpen] = useState(false);
  const [browserUrlInput, setBrowserUrlInput] = useState("");
  const [browserUrlError, setBrowserUrlError] = useState<string | null>(null);
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
          className="fixed inset-0 bg-black/50 z-40 animate-fade-in"
          onClick={() => setIsReactionMenuOpen(false)}
        >
          <div
            className="absolute bottom-20 left-4 right-4 flex items-center justify-center gap-3 rounded-2xl bg-[#1a1a1a] border border-[#FEFCD9]/10 px-4 py-4 overflow-x-auto touch-pan-x animate-scale-in"
            role="dialog"
            aria-modal="true"
            aria-label="Reactions"
            onClick={(e) => e.stopPropagation()}
          >
            {reactionOptions.map((reaction) => (
              <button
                key={reaction.id}
                onClick={() => handleReactionClick(reaction)}
                className="w-12 h-12 shrink-0 rounded-full text-2xl hover:bg-[#FEFCD9]/10 active:scale-110 flex items-center justify-center transition-transform duration-150"
                aria-label={`React ${reaction.label}`}
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

      {/* More menu drawer */}
      {isMoreMenuOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-40 animate-fade-in"
          onClick={() => setIsMoreMenuOpen(false)}
        >
          <div
            className="absolute bottom-0 left-0 right-0 bg-[#121212] border-t border-[#FEFCD9]/10 rounded-t-3xl p-3 pb-6 max-h-[70vh] overflow-y-auto touch-pan-y shadow-[0_-18px_45px_rgba(0,0,0,0.35)] animate-slide-up"
            style={{ fontFamily: "'PolySans Trial', sans-serif" }}
            role="dialog"
            aria-modal="true"
            aria-label="More actions"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="relative px-3 pt-1 pb-2">
              <div className="mx-auto h-1 w-10 rounded-full bg-[#FEFCD9]/20" />
              <button
                onClick={() => setIsMoreMenuOpen(false)}
                className="absolute right-2 top-0 h-7 w-7 rounded-full flex items-center justify-center text-[#FEFCD9]/50 hover:text-[#FEFCD9] hover:bg-[#FEFCD9]/10"
                aria-label="Close menu"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            <button
              onClick={() => {
                onToggleParticipants?.();
                setIsMoreMenuOpen(false);
              }}
              className="w-full flex items-center gap-3 px-4 py-3 rounded-xl text-[#FEFCD9] hover:bg-[#FEFCD9]/5 active:bg-[#FEFCD9]/10 transition-transform duration-150 touch-feedback"
            >
              <div className="h-9 w-9 rounded-xl bg-[#2b2b2b] border border-white/5 flex items-center justify-center">
                <Users className="w-4.5 h-4.5" />
              </div>
              <span className="text-sm font-medium">Participants</span>
              {pendingUsersCount > 0 && (
                <span className="ml-auto text-xs bg-[#F95F4A] text-white px-2 py-0.5 rounded-full font-bold">
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
              className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-transform duration-150 touch-feedback ${isGhostMode
                  ? "opacity-30"
                  : isHandRaised
                    ? "text-amber-400"
                    : "text-[#FEFCD9]"
                } hover:bg-[#FEFCD9]/5 active:bg-[#FEFCD9]/10`}
            >
              <div
                className={`h-9 w-9 rounded-xl border border-white/5 flex items-center justify-center ${
                  isHandRaised ? "bg-amber-500/15" : "bg-[#2b2b2b]"
                }`}
              >
                <Hand className="w-4.5 h-4.5" />
              </div>
              <span className="text-sm font-medium">{isHandRaised ? "Lower hand" : "Raise hand"}</span>
            </button>
            <button
              onClick={() => {
                onToggleScreenShare();
                setIsMoreMenuOpen(false);
              }}
              disabled={isGhostMode || !canStartScreenShare}
              className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-transform duration-150 touch-feedback ${isGhostMode || !canStartScreenShare
                  ? "opacity-30"
                  : isScreenSharing
                    ? "text-[#F95F4A]"
                    : "text-[#FEFCD9]"
                } hover:bg-[#FEFCD9]/5 active:bg-[#FEFCD9]/10`}
            >
              <div
                className={`h-9 w-9 rounded-xl border border-white/5 flex items-center justify-center ${
                  isScreenSharing ? "bg-[#F95F4A]/20" : "bg-[#2b2b2b]"
                }`}
              >
                <Monitor className="w-4.5 h-4.5" />
              </div>
              <span className="text-sm font-medium">{isScreenSharing ? "Stop sharing" : "Share screen"}</span>
            </button>
            {showBrowserControls &&
              isAdmin &&
              (onLaunchBrowser || onNavigateBrowser || onCloseBrowser) && (
              <button
                onClick={() => {
                  setIsMoreMenuOpen(false);
                  setIsBrowserSheetOpen(true);
                }}
                className="w-full flex items-center gap-3 px-4 py-3 rounded-xl text-[#FEFCD9] hover:bg-[#FEFCD9]/5 active:bg-[#FEFCD9]/10 transition-transform duration-150 touch-feedback"
              >
                <div className="h-9 w-9 rounded-xl bg-[#2b2b2b] border border-white/5 flex items-center justify-center">
                  <Globe className="w-4.5 h-4.5" />
                </div>
                <span className="text-sm font-medium">Shared browser</span>
                <span
                  className={`ml-auto text-[10px] uppercase tracking-[0.2em] ${
                    isBrowserActive ? "text-emerald-300" : "text-[#FEFCD9]/40"
                  }`}
                >
                  {isBrowserActive ? "Live" : "Off"}
                </span>
              </button>
            )}
            {isAdmin && (onOpenWhiteboard || onCloseWhiteboard) && (
              <button
                onClick={() => {
                  if (isWhiteboardActive) {
                    onCloseWhiteboard?.();
                  } else {
                    onOpenWhiteboard?.();
                  }
                  setIsMoreMenuOpen(false);
                }}
                className="w-full flex items-center gap-3 px-4 py-3 rounded-xl text-[#FEFCD9] hover:bg-[#FEFCD9]/5 active:bg-[#FEFCD9]/10 transition-transform duration-150 touch-feedback"
              >
                <div className="h-9 w-9 rounded-xl bg-[#2b2b2b] border border-white/5 flex items-center justify-center">
                  <Globe className="w-4.5 h-4.5" />
                </div>
                <span className="text-sm font-medium">
                  {isWhiteboardActive ? "Close whiteboard" : "Open whiteboard"}
                </span>
                <span
                  className={`ml-auto text-[10px] uppercase tracking-[0.2em] ${
                    isWhiteboardActive ? "text-emerald-300" : "text-[#FEFCD9]/40"
                  }`}
                >
                  {isWhiteboardActive ? "Live" : "Off"}
                </span>
              </button>
            )}
            {isAdmin &&
              isDevPlaygroundEnabled &&
              (onOpenDevPlayground || onCloseDevPlayground) && (
              <button
                onClick={() => {
                  if (isDevPlaygroundActive) {
                    onCloseDevPlayground?.();
                  } else {
                    onOpenDevPlayground?.();
                  }
                  setIsMoreMenuOpen(false);
                }}
                className="w-full flex items-center gap-3 px-4 py-3 rounded-xl text-[#FEFCD9] hover:bg-[#FEFCD9]/5 active:bg-[#FEFCD9]/10 transition-transform duration-150 touch-feedback"
              >
                <div className="h-9 w-9 rounded-xl bg-[#2b2b2b] border border-white/5 flex items-center justify-center">
                  <Code2 className="w-4.5 h-4.5" />
                </div>
                <span className="text-sm font-medium">
                  {isDevPlaygroundActive
                    ? "Close dev playground"
                    : "Open dev playground"}
                </span>
                <span
                  className={`ml-auto text-[10px] uppercase tracking-[0.2em] ${
                    isDevPlaygroundActive
                      ? "text-emerald-300"
                      : "text-[#FEFCD9]/40"
                  }`}
                >
                  {isDevPlaygroundActive ? "Live" : "Off"}
                </span>
              </button>
            )}
            {showBrowserControls &&
              (hasBrowserAudio || isBrowserActive) &&
              onToggleBrowserAudio && (
              <button
                onClick={() => {
                  onToggleBrowserAudio();
                  setIsMoreMenuOpen(false);
                }}
                className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-transform duration-150 touch-feedback ${
                  isBrowserAudioMuted ? "text-[#F95F4A]" : "text-[#FEFCD9]"
                } hover:bg-[#FEFCD9]/5 active:bg-[#FEFCD9]/10`}
              >
                <div
                  className={`h-9 w-9 rounded-xl border border-white/5 flex items-center justify-center ${
                    isBrowserAudioMuted ? "bg-[#F95F4A]/20" : "bg-[#2b2b2b]"
                  }`}
                >
                  {isBrowserAudioMuted ? (
                    <VolumeX className="w-4.5 h-4.5" />
                  ) : (
                    <Volume2 className="w-4.5 h-4.5" />
                  )}
                </div>
                <span className="text-sm font-medium">Shared browser audio</span>
                <span className="ml-auto text-[10px] uppercase tracking-[0.2em] text-[#FEFCD9]/40">
                  {isBrowserAudioMuted ? "Muted" : "On"}
                </span>
              </button>
            )}
            {isAdmin && onToggleAppsLock && (
              <button
                onClick={() => {
                  onToggleAppsLock();
                  setIsMoreMenuOpen(false);
                }}
                className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-transform duration-150 touch-feedback ${
                  isAppsLocked ? "text-amber-400" : "text-[#FEFCD9]"
                } hover:bg-[#FEFCD9]/5 active:bg-[#FEFCD9]/10`}
              >
                <div
                  className={`h-9 w-9 rounded-xl border border-white/5 flex items-center justify-center ${
                    isAppsLocked ? "bg-amber-500/20" : "bg-[#2b2b2b]"
                  }`}
                >
                  {isAppsLocked ? <Lock className="w-4.5 h-4.5" /> : <LockOpen className="w-4.5 h-4.5" />}
                </div>
                <span className="text-sm font-medium">
                  {isAppsLocked ? "Unlock whiteboard" : "Lock whiteboard"}
                </span>
              </button>
            )}
            {isAdmin && (
              <button
                onClick={() => {
                  onToggleLock?.();
                  setIsMoreMenuOpen(false);
                }}
                className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-transform duration-150 touch-feedback ${isRoomLocked
                    ? "text-amber-400"
                    : "text-[#FEFCD9]"
                  } hover:bg-[#FEFCD9]/5 active:bg-[#FEFCD9]/10`}
              >
                <div
                  className={`h-9 w-9 rounded-xl border border-white/5 flex items-center justify-center ${
                    isRoomLocked ? "bg-amber-500/20" : "bg-[#2b2b2b]"
                  }`}
                >
                  {isRoomLocked ? (
                    <Lock className="w-4.5 h-4.5" />
                  ) : (
                    <LockOpen className="w-4.5 h-4.5" />
                  )}
                </div>
                <span className="text-sm font-medium">{isRoomLocked ? "Unlock meeting" : "Lock meeting"}</span>
              </button>
            )}
            {isAdmin && onToggleNoGuests && (
              <button
                onClick={() => {
                  onToggleNoGuests();
                  setIsMoreMenuOpen(false);
                }}
                className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-transform duration-150 touch-feedback ${
                  isNoGuests ? "text-amber-400" : "text-[#FEFCD9]"
                } hover:bg-[#FEFCD9]/5 active:bg-[#FEFCD9]/10`}
              >
                <div
                  className={`h-9 w-9 rounded-xl border border-white/5 flex items-center justify-center ${
                    isNoGuests ? "bg-amber-500/20" : "bg-[#2b2b2b]"
                  }`}
                >
                  <ShieldBan className="w-4.5 h-4.5" />
                </div>
                <span className="text-sm font-medium">
                  {isNoGuests ? "Allow guests" : "Block guests"}
                </span>
              </button>
            )}
            {isAdmin && onToggleChatLock && (
              <button
                onClick={() => {
                  onToggleChatLock();
                  setIsMoreMenuOpen(false);
                }}
                className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-transform duration-150 touch-feedback ${isChatLocked
                    ? "text-amber-400"
                    : "text-[#FEFCD9]"
                  } hover:bg-[#FEFCD9]/5 active:bg-[#FEFCD9]/10`}
              >
                <div
                  className={`h-9 w-9 rounded-xl border border-white/5 flex items-center justify-center ${
                    isChatLocked ? "bg-amber-500/20" : "bg-[#2b2b2b]"
                  }`}
                >
                  <MessageSquareLock className="w-4.5 h-4.5" />
                </div>
                <span className="text-sm font-medium">{isChatLocked ? "Unlock chat" : "Lock chat"}</span>
              </button>
            )}
            {isAdmin && onToggleTtsDisabled && (
              <button
                onClick={() => {
                  onToggleTtsDisabled();
                  setIsMoreMenuOpen(false);
                }}
                className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-transform duration-150 touch-feedback ${
                  isTtsDisabled ? "text-amber-400" : "text-[#FEFCD9]"
                } hover:bg-[#FEFCD9]/5 active:bg-[#FEFCD9]/10`}
              >
                <div
                  className={`h-9 w-9 rounded-xl border border-white/5 flex items-center justify-center ${
                    isTtsDisabled ? "bg-amber-500/20" : "bg-[#2b2b2b]"
                  }`}
                >
                  <VolumeX className="w-4.5 h-4.5" />
                </div>
                <span className="text-sm font-medium">
                  {isTtsDisabled ? "Enable TTS" : "Disable TTS"}
                </span>
              </button>
            )}
          </div>
        </div>
      )}

      {showBrowserControls && isBrowserSheetOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-50 animate-fade-in"
          onClick={() => {
            setIsBrowserSheetOpen(false);
            setBrowserUrlError(null);
          }}
        >
          <div
            className="absolute bottom-0 left-0 right-0 bg-[#121212] border-t border-[#FEFCD9]/10 rounded-t-3xl p-4 pb-6 max-h-[70vh] overflow-y-auto touch-pan-y shadow-[0_-18px_45px_rgba(0,0,0,0.35)] animate-slide-up"
            style={{ fontFamily: "'PolySans Trial', sans-serif" }}
            role="dialog"
            aria-modal="true"
            aria-label="Shared browser"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="relative px-1 pb-2">
              <div className="mx-auto h-1 w-10 rounded-full bg-[#FEFCD9]/20" />
              <button
                onClick={() => setIsBrowserSheetOpen(false)}
                className="absolute right-0 top-0 h-7 w-7 rounded-full flex items-center justify-center text-[#FEFCD9]/50 hover:text-[#FEFCD9] hover:bg-[#FEFCD9]/10"
                aria-label="Close shared browser"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="flex items-center gap-3 text-[#FEFCD9] px-1">
              <div className="h-10 w-10 rounded-2xl bg-[#2b2b2b] border border-white/5 flex items-center justify-center">
                <Globe className="w-5 h-5" />
              </div>
              <div className="flex flex-col">
                <span className="text-base font-medium">Shared browser</span>
                <span className="text-[11px] text-[#FEFCD9]/45 uppercase tracking-[0.2em]">
                  {isBrowserActive ? "Live" : "Offline"}
                </span>
              </div>
            </div>

            <form
              onSubmit={async (event) => {
                event.preventDefault();
                if (!browserUrlInput.trim()) return;
                const normalized = normalizeBrowserUrl(browserUrlInput);
                if (!normalized.url) {
                  setBrowserUrlError(normalized.error ?? "Enter a valid URL.");
                  return;
                }
                setBrowserUrlError(null);
                setBrowserUrlInput("");
                if (isBrowserActive) {
                  await onNavigateBrowser?.(normalized.url);
                } else {
                  await onLaunchBrowser?.(normalized.url);
                }
                setIsBrowserSheetOpen(false);
              }}
              className="mt-4 flex flex-col gap-3"
            >
              <input
                type="text"
                value={browserUrlInput}
                onChange={(event) => {
                  setBrowserUrlInput(event.target.value);
                  if (browserUrlError) setBrowserUrlError(null);
                }}
                placeholder={isBrowserActive ? "Navigate to URL" : "Launch URL"}
                className="w-full bg-black/40 border border-[#FEFCD9]/10 rounded-xl px-3 py-2 text-sm text-[#FEFCD9] placeholder:text-[#FEFCD9]/30 focus:outline-none focus:border-[#FEFCD9]/25"
              />
              <div className="flex items-center gap-2">
                <button
                  type="submit"
                  disabled={!browserUrlInput.trim() || isBrowserLaunching}
                  className="flex-1 px-3 py-2 rounded-xl bg-[#F95F4A] text-white text-sm font-medium hover:bg-[#F95F4A]/90 disabled:opacity-40 disabled:hover:bg-[#F95F4A] transition-transform duration-150 touch-feedback"
                >
                  {isBrowserActive ? "Navigate" : "Launch"}
                </button>
                {isBrowserActive && onCloseBrowser && (
                  <button
                    type="button"
                    onClick={async () => {
                      await onCloseBrowser();
                      setIsBrowserSheetOpen(false);
                    }}
                    className="px-3 py-2 rounded-xl bg-white/10 text-[#FEFCD9] text-sm font-medium hover:bg-white/20 transition-transform duration-150 touch-feedback"
                  >
                    Close
                  </button>
                )}
              </div>
            </form>
            {browserUrlError && (
              <p className="mt-2 text-[11px] text-[#F95F4A]">
                {browserUrlError}
              </p>
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
            aria-label={isGhostMode ? "Microphone locked" : isMuted ? "Unmute" : "Mute"}
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
            aria-label={isGhostMode ? "Camera locked" : isCameraOff ? "Turn on camera" : "Turn off camera"}
          >
            {isCameraOff ? <VideoOff className="w-5 h-5" /> : <Video className="w-5 h-5" />}
          </button>

          {/* Reactions button */}
          <button
            onClick={() => setIsReactionMenuOpen(true)}
            disabled={isGhostMode}
            className={isGhostMode ? ghostDisabledClass : defaultButtonClass}
            aria-label={isGhostMode ? "Reactions locked" : "Reactions"}
          >
            <Smile className="w-5 h-5" />
          </button>

          {/* Chat button */}
          <button
            onClick={onToggleChat}
            className={`relative ${isChatOpen ? activeButtonClass : defaultButtonClass}`}
            aria-label="Chat"
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
            aria-label="More actions"
          >
            <MoreVertical className="w-5 h-5" />
          </button>

          {/* Leave button */}
          <button onClick={onLeave} className={leaveButtonClass} aria-label="Leave meeting">
            <Phone className="rotate-[135deg] w-5 h-5" />
          </button>
        </div>
      </div>
    </>
  );
}

export default memo(MobileControlsBar);

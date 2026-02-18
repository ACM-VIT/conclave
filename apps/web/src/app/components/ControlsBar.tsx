"use client";

import {
  Globe,
  Hand,
  LayoutGrid,
  Loader2,
  Lock,
  LockOpen,
  MessageSquare,
  Mic,
  MicOff,
  Monitor,
  PictureInPicture2,
  Phone,
  PlaySquare,
  Presentation,
  Volume2,
  VolumeX,
  Sparkles,
  StickyNote,
  Trello,
  Youtube,
  Smile,
  Users,
  Video,
  VideoOff,
  X,
} from "lucide-react";
import { memo, useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { ReactionOption } from "../lib/types";
import { normalizeBrowserUrl } from "../lib/utils";

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
  isRoomLocked?: boolean;
  onToggleLock?: () => void;
  isBrowserActive?: boolean;
  isBrowserLaunching?: boolean;
  showBrowserControls?: boolean;
  onLaunchBrowser?: (url: string) => Promise<boolean>;
  onCloseBrowser?: () => Promise<boolean>;
  hasBrowserAudio?: boolean;
  isBrowserAudioMuted?: boolean;
  onToggleBrowserAudio?: () => void;
  isWhiteboardActive?: boolean;
  onOpenWhiteboard?: () => void;
  onCloseWhiteboard?: () => void;
  isAppsLocked?: boolean;
  onToggleAppsLock?: () => void;
  isPopoutActive?: boolean;
  isPopoutSupported?: boolean;
  onOpenPopout?: () => void;
  onClosePopout?: () => void;
}

const BROWSER_APPS = [
  {
    id: "figma",
    name: "Figma",
    description: "Design board",
    url: "https://www.figma.com",
    icon: LayoutGrid,
    accent: "from-pink-500/20 to-purple-500/20",
    iconClass: "text-pink-200",
  },
  {
    id: "miro",
    name: "Miro",
    description: "Whiteboard",
    url: "https://miro.com",
    icon: Presentation,
    accent: "from-yellow-500/20 to-orange-500/20",
    iconClass: "text-yellow-200",
  },
  {
    id: "notion",
    name: "Notion",
    description: "Docs + tasks",
    url: "https://www.notion.so",
    icon: StickyNote,
    accent: "from-zinc-500/20 to-stone-500/20",
    iconClass: "text-[#FEFCD9]/80",
  },
  {
    id: "google-docs",
    name: "Docs",
    description: "Write together",
    url: "https://docs.google.com",
    icon: Sparkles,
    accent: "from-blue-500/20 to-cyan-500/20",
    iconClass: "text-blue-200",
  },
  {
    id: "trello",
    name: "Trello",
    description: "Kanban board",
    url: "https://trello.com",
    icon: Trello,
    accent: "from-sky-500/20 to-blue-600/20",
    iconClass: "text-sky-200",
  },
  {
    id: "youtube",
    name: "YouTube",
    description: "Video watch",
    url: "https://www.youtube.com",
    icon: Youtube,
    accent: "from-red-500/20 to-rose-500/20",
    iconClass: "text-red-200",
  },
  {
    id: "loom",
    name: "Loom",
    description: "Quick demo",
    url: "https://www.loom.com",
    icon: PlaySquare,
    accent: "from-violet-500/20 to-fuchsia-500/20",
    iconClass: "text-fuchsia-200",
  },
];

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
  isRoomLocked = false,
  onToggleLock,
  isBrowserActive = false,
  isBrowserLaunching = false,
  showBrowserControls = true,
  onLaunchBrowser,
  onCloseBrowser,
  hasBrowserAudio = false,
  isBrowserAudioMuted = false,
  onToggleBrowserAudio,
  isWhiteboardActive = false,
  onOpenWhiteboard,
  onCloseWhiteboard,
  isAppsLocked = false,
  onToggleAppsLock,
  isPopoutActive = false,
  isPopoutSupported = false,
  onOpenPopout,
  onClosePopout,
}: ControlsBarProps) {
  const canStartScreenShare = !activeScreenShareId || isScreenSharing;
  const [isReactionMenuOpen, setIsReactionMenuOpen] = useState(false);
  const [isBrowserMenuOpen, setIsBrowserMenuOpen] = useState(false);
  const [isAppsMenuOpen, setIsAppsMenuOpen] = useState(false);
  const [browserUrlInput, setBrowserUrlInput] = useState("");
  const [browserUrlError, setBrowserUrlError] = useState<string | null>(null);
  const reactionMenuRef = useRef<HTMLDivElement>(null);
  const browserMenuRef = useRef<HTMLDivElement>(null);
  const appsMenuRef = useRef<HTMLDivElement>(null);
  const lastReactionTimeRef = useRef<number>(0);
  const REACTION_COOLDOWN_MS = 150;

  const baseButtonClass = "w-11 h-11 rounded-full flex items-center justify-center transition-all text-[#FEFCD9]/80 hover:text-[#FEFCD9] hover:bg-[#FEFCD9]/10";
  const defaultButtonClass = baseButtonClass;
  const activeButtonClass = `${baseButtonClass} !bg-[#F95F4A] !text-white`;
  const mutedButtonClass = `${baseButtonClass} !text-[#F95F4A] !bg-[#F95F4A]/15`;
  const ghostDisabledClass = `${baseButtonClass} !opacity-30 cursor-not-allowed`;
  const screenShareDisabled = isGhostMode || !canStartScreenShare;
  const canManageWhiteboard = Boolean(isAdmin && (onOpenWhiteboard || onCloseWhiteboard));
  const canShowAppsMenu = canManageWhiteboard || Boolean(onToggleAppsLock);

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

  useEffect(() => {
    if (!isBrowserMenuOpen) return;

    const handleClickOutside = (event: MouseEvent) => {
      if (
        browserMenuRef.current &&
        !browserMenuRef.current.contains(event.target as Node)
      ) {
        setIsBrowserMenuOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isBrowserMenuOpen]);

  useEffect(() => {
    if (!isAppsMenuOpen) return;

    const handleClickOutside = (event: MouseEvent) => {
      if (appsMenuRef.current && !appsMenuRef.current.contains(event.target as Node)) {
        setIsAppsMenuOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isAppsMenuOpen]);

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
        aria-label="Participants"
      >
        <Users className="w-4 h-4" />
        {pendingUsersCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-[16px] px-1 text-[10px] font-bold bg-[#F95F4A] text-white rounded-full flex items-center justify-center">
            {pendingUsersCount > 9 ? "9+" : pendingUsersCount}
          </span>
        )}
      </button>

      {isAdmin && (
        <button
          onClick={onToggleLock}
          className={isRoomLocked
            ? `${baseButtonClass} !bg-amber-400 !text-black`
            : defaultButtonClass
          }
          title={isRoomLocked ? "Unlock meeting" : "Lock meeting"}
          aria-label={isRoomLocked ? "Unlock meeting" : "Lock meeting"}
        >
          {isRoomLocked ? (
            <Lock className="w-4 h-4" />
          ) : (
            <LockOpen className="w-4 h-4" />
          )}
        </button>
      )}

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
        aria-label={isGhostMode ? "Ghost mode: mic locked" : isMuted ? "Unmute" : "Mute"}
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
        aria-label={
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
        aria-label={
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
      {showBrowserControls && isAdmin && onLaunchBrowser && (
        <div className="relative" ref={browserMenuRef}>
          <button
            onClick={() => {
              if (isBrowserActive && onCloseBrowser) {
                onCloseBrowser();
              } else {
                setIsBrowserMenuOpen(!isBrowserMenuOpen);
              }
            }}
            disabled={isBrowserLaunching}
            className={isBrowserActive ? activeButtonClass : isBrowserLaunching ? ghostDisabledClass : defaultButtonClass}
            title={isBrowserActive ? "Close shared browser" : "Launch shared browser"}
            aria-label={isBrowserActive ? "Close shared browser" : "Launch shared browser"}
          >
            {isBrowserLaunching ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Globe className="w-4 h-4" />
            )}
          </button>

          {isBrowserMenuOpen && !isBrowserActive && (
            <div
              className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 bg-[#0d0e0d]/98 backdrop-blur-md border border-[#FEFCD9]/10 rounded-xl p-4 shadow-2xl z-50 min-w-[360px]"
              style={{ fontFamily: "'PolySans Trial', sans-serif" }}
            >
              <div className="flex items-center justify-between mb-3">
                <div>
                  <span
                    className="text-[10px] uppercase tracking-[0.12em] text-[#FEFCD9]/50"
                    style={{ fontFamily: "'PolySans Mono', monospace" }}
                  >
                    Apps & Browser
                  </span>
                  <p className="text-xs text-[#FEFCD9]/60 mt-1">
                    One click launch shared apps.
                  </p>
                </div>
                <button
                  onClick={() => setIsBrowserMenuOpen(false)}
                  className="w-5 h-5 rounded flex items-center justify-center text-[#FEFCD9]/40 hover:text-[#FEFCD9] hover:bg-[#FEFCD9]/10"
                  aria-label="Close browser menu"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
              <div className="grid grid-cols-2 gap-2">
                {BROWSER_APPS.map((app) => {
                  const Icon = app.icon;
                  return (
                    <button
                      key={app.id}
                      type="button"
                      disabled={isBrowserLaunching}
                      onClick={async () => {
                        const normalized = normalizeBrowserUrl(app.url);
                        if (!normalized.url) {
                          setBrowserUrlError(normalized.error ?? "Enter a valid URL.");
                          return;
                        }
                        setBrowserUrlError(null);
                        setBrowserUrlInput("");
                        setIsBrowserMenuOpen(false);
                        await onLaunchBrowser(normalized.url);
                      }}
                      className="group flex items-center gap-2 rounded-lg border border-[#FEFCD9]/10 bg-black/40 p-2 text-left transition hover:border-[#FEFCD9]/25 hover:bg-[#FEFCD9]/5 disabled:opacity-40"
                    >
                      <div
                        className={`h-9 w-9 rounded-lg bg-gradient-to-br ${app.accent} flex items-center justify-center`}
                      >
                        <Icon className={`h-4 w-4 ${app.iconClass}`} />
                      </div>
                      <div>
                        <div className="text-xs text-[#FEFCD9] font-medium">
                          {app.name}
                        </div>
                        <div className="text-[11px] text-[#FEFCD9]/45">
                          {app.description}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
              <div className="mt-3 pt-3 border-t border-[#FEFCD9]/10">
                <form
                  onSubmit={async (e: FormEvent) => {
                    e.preventDefault();
                    if (!browserUrlInput.trim()) return;
                    const normalized = normalizeBrowserUrl(browserUrlInput);
                    if (!normalized.url) {
                      setBrowserUrlError(normalized.error ?? "Enter a valid URL.");
                      return;
                    }
                    setBrowserUrlError(null);
                    setBrowserUrlInput("");
                    setIsBrowserMenuOpen(false);
                    await onLaunchBrowser(normalized.url);
                  }}
                  className="flex gap-2"
                >
                  <input
                    type="text"
                    value={browserUrlInput}
                    onChange={(e) => {
                      setBrowserUrlInput(e.target.value);
                      if (browserUrlError) {
                        setBrowserUrlError(null);
                      }
                    }}
                    placeholder="Paste a URL"
                    autoFocus
                    className="flex-1 px-3 py-1.5 bg-black/40 border border-[#FEFCD9]/10 rounded-lg text-xs text-[#FEFCD9] placeholder:text-[#FEFCD9]/30 focus:outline-none focus:border-[#FEFCD9]/25"
                  />
                  <button
                    type="submit"
                    disabled={!browserUrlInput.trim() || isBrowserLaunching}
                    className="px-3 py-1.5 bg-[#F95F4A] text-white rounded-lg text-xs font-medium hover:bg-[#F95F4A]/90 disabled:opacity-40"
                  >
                    Go
                  </button>
                </form>
              </div>
              {browserUrlError && (
                <p className="mt-2 text-[11px] text-[#F95F4A]">
                  {browserUrlError}
                </p>
              )}
            </div>
          )}
        </div>
      )}
      {showBrowserControls &&
        (hasBrowserAudio || isBrowserActive) &&
        onToggleBrowserAudio && (
        <button
          onClick={onToggleBrowserAudio}
          className={isBrowserAudioMuted ? mutedButtonClass : defaultButtonClass}
          title={
            isBrowserAudioMuted
              ? "Unmute shared browser audio"
              : "Mute shared browser audio"
          }
          aria-label={
            isBrowserAudioMuted
              ? "Unmute shared browser audio"
              : "Mute shared browser audio"
          }
        >
          {isBrowserAudioMuted ? (
            <VolumeX className="w-4 h-4" />
          ) : (
            <Volume2 className="w-4 h-4" />
          )}
        </button>
      )}

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
        aria-label={
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
          aria-label={isGhostMode ? "Ghost mode: reactions locked" : "Reactions"}
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
                aria-label={`React ${reaction.label}`}
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

      {canShowAppsMenu && (
        <div ref={appsMenuRef} className="relative">
          <button
            onClick={() => setIsAppsMenuOpen((prev) => !prev)}
            className={defaultButtonClass}
            title="Apps"
            aria-label="Apps"
          >
            <LayoutGrid className="w-4 h-4" />
          </button>

          {isAppsMenuOpen && (
            <div className="absolute bottom-14 left-1/2 -translate-x-1/2 w-56 rounded-xl border border-white/10 bg-[#0f0f0f] p-3 shadow-xl">
              {canManageWhiteboard && (
                <button
                  type="button"
                  onClick={() => {
                    if (isWhiteboardActive) {
                      onCloseWhiteboard?.();
                    } else {
                      onOpenWhiteboard?.();
                    }
                    setIsAppsMenuOpen(false);
                  }}
                  className="w-full text-left px-3 py-2 rounded-lg text-sm text-[#FEFCD9]/80 hover:bg-white/10"
                >
                  {isWhiteboardActive ? "Close whiteboard" : "Open whiteboard"}
                </button>
              )}
              {onToggleAppsLock && (
                <button
                  type="button"
                  onClick={() => {
                    onToggleAppsLock();
                    setIsAppsMenuOpen(false);
                  }}
                  className="mt-2 w-full text-left px-3 py-2 rounded-lg text-sm text-[#FEFCD9]/60 hover:bg-white/10"
                >
                  {isAppsLocked ? "Unlock editing" : "Lock editing"}
                </button>
              )}
            </div>
          )}
        </div>
      )}

      <button
        onClick={onToggleChat}
        className={`relative ${isChatOpen ? activeButtonClass : defaultButtonClass}`}
        title="Chat"
        aria-label="Chat"
      >
        <MessageSquare className="w-4 h-4" />
        {unreadCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-[16px] px-1 text-[10px] font-bold bg-[#F95F4A] text-white rounded-full flex items-center justify-center">
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </button>

      {isPopoutSupported && (onOpenPopout || onClosePopout) && (
        <button
          onClick={isPopoutActive ? onClosePopout : onOpenPopout}
          className={isPopoutActive ? activeButtonClass : defaultButtonClass}
          title={isPopoutActive ? "Close mini view" : "Pop out mini view"}
          aria-label={isPopoutActive ? "Close mini view" : "Pop out mini view"}
        >
          <PictureInPicture2 className="w-4 h-4" />
        </button>
      )}

      <div className="w-px h-6 bg-[#FEFCD9]/10 mx-1" />

      <button
        onClick={onLeave}
        className={`${baseButtonClass} !text-red-400 hover:!bg-red-500/20`}
        title="Leave meeting"
        aria-label="Leave meeting"
      >
        <Phone className="rotate-[135deg] w-4 h-4" />
      </button>
    </div>
  );
}

export default memo(ControlsBar);

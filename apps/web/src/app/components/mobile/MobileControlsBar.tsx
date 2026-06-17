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
  Settings,
  Smile,
  Users,
  Video,
  VideoOff,
  Monitor,
  Volume2,
  VolumeX,
  WandSparkles,
  X,
  ShieldBan,
  type LucideIcon,
} from "lucide-react";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { SwitchRow } from "@conclave/ui-tokens/web";
import type {
  MeetingConfigSnapshot,
  MeetingUpdateRequest,
  ReactionOption,
  WebinarConfigSnapshot,
  WebinarLinkResponse,
  WebinarUpdateRequest,
} from "../../lib/types";
import { normalizeBrowserUrl } from "../../lib/utils";

interface MediaDeviceOption {
  deviceId: string;
  label: string;
}

type MoreRowTone = "accent" | "warning";

/** Clean sheet row: a plain icon + label + optional trailing accessory. No
 * boxed-icon chrome — the old per-row icon tiles made the sheet read as noise. */
function MoreRow({
  icon: Icon,
  label,
  onClick,
  disabled = false,
  active = false,
  tone = "accent",
  trailing,
  ariaLabel,
  ariaPressed,
  dataAction,
  dataActionState,
}: {
  icon: LucideIcon;
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  active?: boolean;
  tone?: MoreRowTone;
  trailing?: ReactNode;
  ariaLabel?: string;
  ariaPressed?: boolean;
  dataAction?: string;
  dataActionState?: string;
}) {
  const activeColor = tone === "warning" ? "text-amber-400" : "text-[#F95F4A]";
  return (
    <button
      type="button"
      role="menuitem"
      aria-label={ariaLabel}
      aria-pressed={ariaPressed}
      data-mobile-more-action={dataAction}
      data-mobile-more-action-state={dataActionState}
      onClick={onClick}
      disabled={disabled}
      className="flex w-full items-center gap-3.5 rounded-xl px-3 py-3 text-left text-[#fafafa] transition-colors duration-150 hover:bg-[#fafafa]/5 active:bg-[#fafafa]/10 disabled:opacity-30"
    >
      <Icon
        className={`h-[19px] w-[19px] shrink-0 ${active ? activeColor : "text-[#fafafa]/70"}`}
        strokeWidth={1.75}
      />
      <span className="flex-1 text-[15px] font-medium">{label}</span>
      {trailing}
    </button>
  );
}

/** Non-interactive switch pill for use inside a row that is itself the toggle. */
function MiniSwitch({ on, tone = "accent" }: { on: boolean; tone?: MoreRowTone }) {
  const fill = tone === "warning" ? "#fbbf24" : "#F95F4A";
  return (
    <span
      aria-hidden
      className="relative inline-flex h-[22px] w-[38px] shrink-0 items-center rounded-full transition-colors duration-[120ms]"
      style={{ backgroundColor: on ? fill : "rgba(250,250,250,0.16)" }}
    >
      <span
        className="absolute h-[16px] w-[16px] rounded-full bg-white transition-transform duration-[120ms]"
        style={{ transform: on ? "translateX(19px)" : "translateX(3px)" }}
      />
    </span>
  );
}

function MoreSectionLabel({ children }: { children: ReactNode }) {
  return (
    <p className="px-3 pb-1 pt-3 text-[11px] font-medium uppercase tracking-[0.08em] text-[#fafafa]/45">
      {children}
    </p>
  );
}

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
  isVideoEffectsOpen?: boolean;
  activeVideoEffectsCount?: number;
  isVideoEffectsPermissionBlocked?: boolean;
  onToggleVideoEffects?: () => void;
  isRoomLocked?: boolean;
  onToggleLock?: () => void;
  isNoGuests?: boolean;
  onToggleNoGuests?: () => void;
  isChatLocked?: boolean;
  onToggleChatLock?: () => void;
  isTtsDisabled?: boolean;
  onToggleTtsDisabled?: () => void;
  isDmEnabled?: boolean;
  onToggleDmEnabled?: () => void;
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
  isVoiceAgentRunning?: boolean;
  isVoiceAgentStarting?: boolean;
  onStartVoiceAgent?: () => void;
  onStopVoiceAgent?: () => void;
  audioInputDeviceId?: string;
  audioOutputDeviceId?: string;
  onAudioInputDeviceChange?: (deviceId: string) => void;
  onAudioOutputDeviceChange?: (deviceId: string) => void;
  isObserverMode?: boolean;
  meetingRequiresInviteCode?: boolean;
  onGetMeetingConfig?: () => Promise<MeetingConfigSnapshot | null>;
  onUpdateMeetingConfig?: (
    update: MeetingUpdateRequest,
  ) => Promise<MeetingConfigSnapshot | null>;
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
  isVideoEffectsOpen = false,
  activeVideoEffectsCount = 0,
  isVideoEffectsPermissionBlocked = false,
  onToggleVideoEffects,
  isRoomLocked = false,
  onToggleLock,
  isNoGuests = false,
  onToggleNoGuests,
  isChatLocked = false,
  onToggleChatLock,
  isTtsDisabled = false,
  onToggleTtsDisabled,
  isDmEnabled = true,
  onToggleDmEnabled,
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
  audioInputDeviceId,
  audioOutputDeviceId,
  onAudioInputDeviceChange,
  onAudioOutputDeviceChange,
  isObserverMode = false,
  meetingRequiresInviteCode = false,
  onGetMeetingConfig,
  onUpdateMeetingConfig,
  webinarConfig,
  webinarRole,
  webinarLink,
  onSetWebinarLink,
  onGetWebinarConfig,
  onUpdateWebinarConfig,
  onGenerateWebinarLink,
  onRotateWebinarLink,
}: MobileControlsBarProps) {
  const [isMoreMenuOpen, setIsMoreMenuOpen] = useState(false);
  const [isReactionMenuOpen, setIsReactionMenuOpen] = useState(false);
  const [isBrowserSheetOpen, setIsBrowserSheetOpen] = useState(false);
  const [isSettingsSheetOpen, setIsSettingsSheetOpen] = useState(false);
  const [browserUrlInput, setBrowserUrlInput] = useState("");
  const [browserUrlError, setBrowserUrlError] = useState<string | null>(null);
  const [isLoadingAudioDevices, setIsLoadingAudioDevices] = useState(false);
  const [audioDevicesError, setAudioDevicesError] = useState<string | null>(
    null,
  );
  const [audioInputDevices, setAudioInputDevices] = useState<
    MediaDeviceOption[]
  >([]);
  const [audioOutputDevices, setAudioOutputDevices] = useState<
    MediaDeviceOption[]
  >([]);
  const lastReactionTimeRef = useRef<number>(0);
  const REACTION_COOLDOWN_MS = 150;
  const [webinarInviteCodeInput, setWebinarInviteCodeInput] = useState("");
  const [meetingInviteCodeInput, setMeetingInviteCodeInput] = useState("");
  const [meetingNotice, setMeetingNotice] = useState<string | null>(null);
  const [meetingError, setMeetingError] = useState<string | null>(null);
  const [isMeetingWorking, setIsMeetingWorking] = useState(false);
  const [webinarCapInput, setWebinarCapInput] = useState(
    String(webinarConfig?.maxAttendees ?? 500),
  );
  const [webinarNotice, setWebinarNotice] = useState<string | null>(null);
  const [webinarError, setWebinarError] = useState<string | null>(null);
  const [isWebinarWorking, setIsWebinarWorking] = useState(false);

  const closeControlSheets = useCallback(() => {
    setIsMoreMenuOpen(false);
    setIsReactionMenuOpen(false);
    setIsBrowserSheetOpen(false);
    setIsSettingsSheetOpen(false);
  }, []);

  const closeExternalSheets = useCallback(() => {
    if (isChatOpen) {
      onToggleChat();
    }
    if (isParticipantsOpen) {
      onToggleParticipants?.();
    }
    if (isVideoEffectsOpen) {
      onToggleVideoEffects?.();
    }
  }, [
    isChatOpen,
    isParticipantsOpen,
    isVideoEffectsOpen,
    onToggleChat,
    onToggleParticipants,
    onToggleVideoEffects,
  ]);

  const canStartScreenShare = !activeScreenShareId || isScreenSharing;
  const hasActiveVideoEffects = activeVideoEffectsCount > 0;
  const canOpenVideoEffects =
    Boolean(onToggleVideoEffects) &&
    !isGhostMode &&
    !isVideoEffectsPermissionBlocked;
  const videoEffectsStatusLabel = isVideoEffectsPermissionBlocked
    ? "Permission needed"
    : hasActiveVideoEffects
      ? `${activeVideoEffectsCount} active`
      : isVideoEffectsOpen
        ? "Open"
        : "Off";
  const videoEffectsAriaLabel = isVideoEffectsPermissionBlocked
    ? "Backgrounds and effects, permission needed"
    : hasActiveVideoEffects
      ? `Backgrounds and effects, ${activeVideoEffectsCount} active`
      : isVideoEffectsOpen
        ? "Backgrounds and effects, open"
        : "Backgrounds and effects, off";

  const baseButtonClass =
    "mobile-control-btn w-12 h-12 rounded-full flex items-center justify-center active:scale-95";
  const defaultButtonClass = `${baseButtonClass}`;
  const activeButtonClass = `${baseButtonClass} is-active`;
  const mutedButtonClass = `${baseButtonClass} is-muted`;
  const ghostDisabledClass = `${baseButtonClass} is-disabled`;
  const leaveButtonClass = `${baseButtonClass} is-danger`;

  const handleReactionClick = useCallback(
    (reaction: ReactionOption) => {
      if (isObserverMode) return;
      const now = Date.now();
      if (now - lastReactionTimeRef.current < REACTION_COOLDOWN_MS) {
        return;
      }
      lastReactionTimeRef.current = now;
      onSendReaction(reaction);
    },
    [isObserverMode, onSendReaction]
  );

  const fetchAudioDevices = useCallback(async () => {
    if (
      typeof navigator === "undefined" ||
      !navigator.mediaDevices?.enumerateDevices
    ) {
      setAudioDevicesError("Device selection is not supported here.");
      setAudioInputDevices([]);
      setAudioOutputDevices([]);
      return;
    }

    setIsLoadingAudioDevices(true);
    setAudioDevicesError(null);

    try {
      const devices = await navigator.mediaDevices.enumerateDevices();

      const nextAudioInputDevices = devices
        .filter((device) => device.kind === "audioinput")
        .map((device, index) => ({
          deviceId: device.deviceId,
          label: device.label || `Microphone ${index + 1}`,
        }));

      const nextAudioOutputDevices = devices
        .filter((device) => device.kind === "audiooutput")
        .map((device, index) => ({
          deviceId: device.deviceId,
          label: device.label || `Speaker ${index + 1}`,
        }));

      setAudioInputDevices(nextAudioInputDevices);
      setAudioOutputDevices(nextAudioOutputDevices);
    } catch (error) {
      console.error("[MobileControlsBar] Failed to enumerate devices:", error);
      setAudioDevicesError("Unable to load available devices.");
      setAudioInputDevices([]);
      setAudioOutputDevices([]);
    } finally {
      setIsLoadingAudioDevices(false);
    }
  }, []);

  useEffect(() => {
    if (!isSettingsSheetOpen) return;
    void fetchAudioDevices();
  }, [fetchAudioDevices, isSettingsSheetOpen]);

  useEffect(() => {
    if (
      typeof navigator === "undefined" ||
      !navigator.mediaDevices?.addEventListener ||
      !navigator.mediaDevices.removeEventListener
    ) {
      return;
    }

    const handleDeviceChange = () => {
      if (!isSettingsSheetOpen) return;
      void fetchAudioDevices();
    };

    navigator.mediaDevices.addEventListener("devicechange", handleDeviceChange);
    return () => {
      navigator.mediaDevices.removeEventListener(
        "devicechange",
        handleDeviceChange,
      );
    };
  }, [fetchAudioDevices, isSettingsSheetOpen]);

  useEffect(() => {
    setWebinarCapInput(String(webinarConfig?.maxAttendees ?? 500));
  }, [webinarConfig?.maxAttendees]);

  useEffect(() => {
    if (!isSettingsSheetOpen || !isAdmin || isObserverMode) return;
    void onGetMeetingConfig?.();
    void onGetWebinarConfig?.();
  }, [
    isAdmin,
    isObserverMode,
    isSettingsSheetOpen,
    onGetMeetingConfig,
    onGetWebinarConfig,
  ]);

  const runMeetingTask = useCallback(
    async (
      task: () => Promise<void>,
      options?: { successMessage?: string; clearInviteInput?: boolean },
    ) => {
      setMeetingError(null);
      setMeetingNotice(null);
      setIsMeetingWorking(true);
      try {
        await task();
        if (options?.clearInviteInput) {
          setMeetingInviteCodeInput("");
        }
        if (options?.successMessage) {
          setMeetingNotice(options.successMessage);
        }
      } catch (error) {
        setMeetingError(
          error instanceof Error ? error.message : "Meeting update failed.",
        );
      } finally {
        setIsMeetingWorking(false);
      }
    },
    [],
  );

  const runWebinarTask = useCallback(
    async (
      task: () => Promise<void>,
      options?: { successMessage?: string; clearInviteInput?: boolean },
    ) => {
      setWebinarError(null);
      setWebinarNotice(null);
      setIsWebinarWorking(true);
      try {
        await task();
        if (options?.clearInviteInput) {
          setWebinarInviteCodeInput("");
        }
        if (options?.successMessage) {
          setWebinarNotice(options.successMessage);
        }
      } catch (error) {
        setWebinarError(
          error instanceof Error ? error.message : "Webinar update failed.",
        );
      } finally {
        setIsWebinarWorking(false);
      }
    },
    [],
  );

  const copyLink = useCallback(async (value: string) => {
    if (!value.trim()) {
      throw new Error("No webinar link generated yet.");
    }
    if (
      typeof navigator !== "undefined" &&
      navigator.clipboard &&
      typeof navigator.clipboard.writeText === "function"
    ) {
      await navigator.clipboard.writeText(value);
      return;
    }
    throw new Error("Clipboard is unavailable in this browser.");
  }, []);

  const openReactionMenu = useCallback(() => {
    closeExternalSheets();
    setIsMoreMenuOpen(false);
    setIsBrowserSheetOpen(false);
    setIsSettingsSheetOpen(false);
    setIsReactionMenuOpen(true);
  }, [closeExternalSheets]);

  const openMoreMenu = useCallback(() => {
    closeExternalSheets();
    setIsReactionMenuOpen(false);
    setIsBrowserSheetOpen(false);
    setIsSettingsSheetOpen(false);
    setIsMoreMenuOpen(true);
  }, [closeExternalSheets]);

  const openSettingsSheet = useCallback(() => {
    setIsMoreMenuOpen(false);
    setIsReactionMenuOpen(false);
    setIsBrowserSheetOpen(false);
    setIsSettingsSheetOpen(true);
  }, []);

  const openBrowserSheet = useCallback(() => {
    setBrowserUrlError(null);
    setIsMoreMenuOpen(false);
    setIsReactionMenuOpen(false);
    setIsSettingsSheetOpen(false);
    setIsBrowserSheetOpen(true);
  }, []);

  const handleVideoEffectsClick = useCallback(() => {
    if (!canOpenVideoEffects) return;
    onToggleVideoEffects?.();
    closeControlSheets();
  }, [canOpenVideoEffects, closeControlSheets, onToggleVideoEffects]);

  const handleChatButtonClick = useCallback(() => {
    closeControlSheets();
    onToggleChat();
  }, [closeControlSheets, onToggleChat]);

  useEffect(() => {
    if (isChatOpen || isParticipantsOpen || isVideoEffectsOpen) {
      closeControlSheets();
    }
  }, [
    closeControlSheets,
    isChatOpen,
    isParticipantsOpen,
    isVideoEffectsOpen,
  ]);

  const selectedAudioInputValue = audioInputDevices.some(
    (device) => device.deviceId === audioInputDeviceId,
  )
    ? audioInputDeviceId
    : audioInputDevices[0]?.deviceId;

  const selectedAudioOutputValue = audioOutputDevices.some(
    (device) => device.deviceId === audioOutputDeviceId,
  )
    ? audioOutputDeviceId
    : audioOutputDevices[0]?.deviceId;

  const parsedWebinarCap = Number.parseInt(webinarCapInput, 10);
  const webinarCapValue = Number.isFinite(parsedWebinarCap)
    ? Math.max(1, Math.min(5000, parsedWebinarCap))
    : null;

  if (isObserverMode) {
    return (
      <div className="fixed inset-x-0 bottom-0 z-40">
        <div className="absolute inset-x-0 bottom-0 h-28 bg-black/55 pointer-events-none" />
        <div className="relative flex items-center justify-center px-4 pb-[calc(12px+env(safe-area-inset-bottom))] pt-4">
          <div className="mobile-glass mobile-pill flex items-center gap-3 px-4 py-3">
            <span
              className="text-[12px] font-medium text-[#fafafa]/82"
              style={{ fontFamily: "'PolySans Trial', sans-serif" }}
            >
              {webinarConfig?.attendeeCount ?? 0} watching
            </span>
            <button
              onClick={onLeave}
              className="mobile-control-btn is-danger w-10 h-10 rounded-full flex items-center justify-center"
              aria-label="Leave webinar"
            >
              <Phone className="rotate-[135deg] w-4 h-4" />
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      <div
        className="mobile-sheet-root z-50"
        data-state={isReactionMenuOpen ? "open" : "closed"}
        aria-hidden={!isReactionMenuOpen}
      >
        <div
          className="mobile-sheet-overlay"
          onClick={() => setIsReactionMenuOpen(false)}
        />
        <div className="mobile-sheet-panel">
          <div
            className="mobile-sheet w-full px-4 pb-[calc(18px+env(safe-area-inset-bottom))] pt-3"
            role="dialog"
            aria-modal="true"
            aria-label="Reactions"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="relative px-1 pt-1 pb-3">
              <div className="mx-auto mobile-sheet-grabber" />
              <button
                onClick={() => setIsReactionMenuOpen(false)}
                className="absolute right-0 top-0 h-7 w-7 mobile-pill mobile-glass-soft flex items-center justify-center text-[#fafafa]/82 hover:text-[#fafafa]"
                aria-label="Close reactions"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="mt-3 grid grid-cols-6 gap-2 max-h-[40vh] overflow-y-auto no-scrollbar px-2">
              {reactionOptions.map((reaction) => (
                <button
                  key={reaction.id}
                  onClick={() => handleReactionClick(reaction)}
                  className="h-11 w-11 sm:h-12 sm:w-12 rounded-full bg-[#141414]/70 border border-[#fafafa]/10 text-xl sm:text-2xl flex items-center justify-center transition-transform duration-150 active:scale-95 hover:bg-[#fafafa]/10"
                  aria-label={`React ${reaction.label}`}
                >
                  {reaction.kind === "emoji" ? (
                    reaction.value
                  ) : (
                    <img
                      src={reaction.value}
                      alt={reaction.label}
                      className="w-7 h-7 sm:w-8 sm:h-8 object-contain"
                    />
                  )}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div
        className="mobile-sheet-root z-50"
        data-state={isMoreMenuOpen ? "open" : "closed"}
        data-mobile-more-menu-state={isMoreMenuOpen ? "open" : "closed"}
        data-mobile-video-effects-state={videoEffectsStatusLabel}
        data-mobile-video-effects-active-count={activeVideoEffectsCount}
        data-mobile-video-effects-open={isVideoEffectsOpen ? "true" : "false"}
        data-mobile-video-effects-permission-blocked={
          isVideoEffectsPermissionBlocked ? "true" : "false"
        }
        aria-hidden={!isMoreMenuOpen}
      >
        <div
          className="mobile-sheet-overlay"
          onClick={() => setIsMoreMenuOpen(false)}
        />
        <div className="mobile-sheet-panel">
          <div
            className="mobile-sheet mobile-sheet-scroll w-full p-4 pb-[calc(24px+env(safe-area-inset-bottom))] max-h-[80vh] touch-pan-y"
            style={{ fontFamily: "'PolySans Trial', sans-serif" }}
            role="dialog"
            aria-modal="true"
            aria-label="More actions"
            onClick={(e) => e.stopPropagation()}
          >
          <div className="relative px-1 pt-1 pb-3">
            <div className="mx-auto mobile-sheet-grabber" />
            <button
              onClick={() => setIsMoreMenuOpen(false)}
              className="absolute right-0 top-0 h-7 w-7 mobile-pill mobile-glass-soft flex items-center justify-center text-[#fafafa]/82 hover:text-[#fafafa]"
              aria-label="Close menu"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <MoreRow
            icon={WandSparkles}
            label="Backgrounds and effects"
            ariaLabel={videoEffectsAriaLabel}
            ariaPressed={isVideoEffectsOpen || hasActiveVideoEffects}
            dataAction="effects"
            dataActionState={videoEffectsStatusLabel}
            onClick={handleVideoEffectsClick}
            disabled={!canOpenVideoEffects}
            active={isVideoEffectsOpen || hasActiveVideoEffects}
            trailing={
              <span
                className={`text-[12px] ${
                  hasActiveVideoEffects
                    ? "font-semibold text-[#F95F4A]"
                    : "font-medium text-[#fafafa]/56"
                }`}
              >
                {videoEffectsStatusLabel}
              </span>
            }
          />
          <MoreRow
            icon={Users}
            label="Participants"
            dataAction="participants"
            dataActionState={String(pendingUsersCount)}
            onClick={() => {
              onToggleParticipants?.();
              setIsMoreMenuOpen(false);
            }}
            trailing={
              pendingUsersCount > 0 ? (
                <span className="rounded-full bg-[#F95F4A] px-2 py-0.5 text-xs font-bold text-white">
                  {pendingUsersCount}
                </span>
              ) : undefined
            }
          />
          <MoreRow
            icon={Settings}
            label="Settings"
            dataAction="settings"
            dataActionState="available"
            onClick={openSettingsSheet}
          />
          <MoreRow
            icon={Hand}
            label="Raise hand"
            tone="warning"
            active={isHandRaised}
            disabled={isGhostMode}
            onClick={() => {
              onToggleHandRaised();
              setIsMoreMenuOpen(false);
            }}
            trailing={<MiniSwitch on={isHandRaised} tone="warning" />}
          />
          <MoreRow
            icon={Monitor}
            label="Share screen"
            active={isScreenSharing}
            disabled={isGhostMode || !canStartScreenShare}
            onClick={() => {
              onToggleScreenShare();
              setIsMoreMenuOpen(false);
            }}
            trailing={<MiniSwitch on={isScreenSharing} />}
          />
            {isAdmin && <MoreSectionLabel>Host controls</MoreSectionLabel>}
            {showBrowserControls &&
              isAdmin &&
              (onLaunchBrowser || onNavigateBrowser || onCloseBrowser) && (
              <MoreRow
                icon={Globe}
                label="Shared browser"
                active={isBrowserActive}
                onClick={openBrowserSheet}
                trailing={
                  <span
                    className={`text-[12px] font-medium ${
                      isBrowserActive ? "text-emerald-300" : "text-[#fafafa]/56"
                    }`}
                  >
                    {isBrowserActive ? "Live" : "Off"}
                  </span>
                }
              />
            )}
            {isAdmin && (onOpenWhiteboard || onCloseWhiteboard) && (
              <MoreRow
                icon={Globe}
                label="Whiteboard"
                active={isWhiteboardActive}
                onClick={() => {
                  if (isWhiteboardActive) {
                    onCloseWhiteboard?.();
                  } else {
                    onOpenWhiteboard?.();
                  }
                  setIsMoreMenuOpen(false);
                }}
                trailing={
                  <span
                    className={`text-[12px] font-medium ${
                      isWhiteboardActive ? "text-emerald-300" : "text-[#fafafa]/56"
                    }`}
                  >
                    {isWhiteboardActive ? "Live" : "Off"}
                  </span>
                }
              />
            )}
            {/* Voice agent action hidden from the mobile web menu. */}
            {isAdmin &&
              isDevPlaygroundEnabled &&
              (onOpenDevPlayground || onCloseDevPlayground) && (
              <MoreRow
                icon={Code2}
                label="Dev playground"
                active={isDevPlaygroundActive}
                onClick={() => {
                  if (isDevPlaygroundActive) {
                    onCloseDevPlayground?.();
                  } else {
                    onOpenDevPlayground?.();
                  }
                  setIsMoreMenuOpen(false);
                }}
                trailing={
                  <span
                    className={`text-[12px] font-medium ${
                      isDevPlaygroundActive ? "text-emerald-300" : "text-[#fafafa]/56"
                    }`}
                  >
                    {isDevPlaygroundActive ? "Live" : "Off"}
                  </span>
                }
              />
            )}
            {isAdmin && onToggleAppsLock && (
              <MoreRow
                icon={isAppsLocked ? Lock : LockOpen}
                label="Lock whiteboard"
                tone="warning"
                active={isAppsLocked}
                onClick={() => {
                  onToggleAppsLock();
                  setIsMoreMenuOpen(false);
                }}
                trailing={<MiniSwitch on={isAppsLocked} tone="warning" />}
              />
            )}
            {isAdmin && (
              <MoreRow
                icon={isRoomLocked ? Lock : LockOpen}
                label="Lock meeting"
                tone="warning"
                active={isRoomLocked}
                onClick={() => {
                  onToggleLock?.();
                  setIsMoreMenuOpen(false);
                }}
                trailing={<MiniSwitch on={isRoomLocked} tone="warning" />}
              />
            )}
            {isAdmin && onToggleNoGuests && (
              <MoreRow
                icon={ShieldBan}
                label="Block guests"
                tone="warning"
                active={isNoGuests}
                onClick={() => {
                  onToggleNoGuests();
                  setIsMoreMenuOpen(false);
                }}
                trailing={<MiniSwitch on={isNoGuests} tone="warning" />}
              />
            )}
            {isAdmin && onToggleChatLock && (
              <MoreRow
                icon={MessageSquareLock}
                label="Allow chat"
                active={!isChatLocked}
                onClick={() => {
                  onToggleChatLock();
                  setIsMoreMenuOpen(false);
                }}
                trailing={<MiniSwitch on={!isChatLocked} />}
              />
            )}
            {isAdmin && onToggleDmEnabled && (
              <MoreRow
                icon={MessageSquare}
                label="Direct messages"
                active={isDmEnabled}
                onClick={() => {
                  onToggleDmEnabled();
                  setIsMoreMenuOpen(false);
                }}
                trailing={<MiniSwitch on={isDmEnabled} />}
              />
            )}
            {isAdmin && onToggleTtsDisabled && (
              <MoreRow
                icon={Volume2}
                label="Read messages aloud"
                active={!isTtsDisabled}
                onClick={() => {
                  onToggleTtsDisabled();
                  setIsMoreMenuOpen(false);
                }}
                trailing={<MiniSwitch on={!isTtsDisabled} />}
              />
            )}
            {showBrowserControls &&
              (hasBrowserAudio || isBrowserActive) &&
              onToggleBrowserAudio && (
              <MoreRow
                icon={isBrowserAudioMuted ? VolumeX : Volume2}
                label="Shared browser audio"
                active={!isBrowserAudioMuted}
                onClick={() => {
                  onToggleBrowserAudio();
                  setIsMoreMenuOpen(false);
                }}
                trailing={<MiniSwitch on={!isBrowserAudioMuted} />}
              />
            )}
          </div>
        </div>
      </div>

      <div
        className="mobile-sheet-root z-50"
        data-state={isSettingsSheetOpen ? "open" : "closed"}
        aria-hidden={!isSettingsSheetOpen}
      >
        <div
          className="mobile-sheet-overlay"
          onClick={() => setIsSettingsSheetOpen(false)}
        />
        <div className="mobile-sheet-panel">
          <div
            className="mobile-sheet mobile-sheet-scroll w-full p-4 pb-6 max-h-[75vh] touch-pan-y"
            style={{ fontFamily: "'PolySans Trial', sans-serif" }}
            role="dialog"
            aria-modal="true"
            aria-label="Meeting settings"
            onClick={(e) => e.stopPropagation()}
          >
          <div className="relative px-1 pb-3">
            <div className="mx-auto mobile-sheet-grabber" />
            <button
              onClick={() => setIsSettingsSheetOpen(false)}
              className="absolute right-0 top-0 h-7 w-7 mobile-pill mobile-glass-soft flex items-center justify-center text-[#fafafa]/82 hover:text-[#fafafa]"
              aria-label="Close settings"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>

            <div className="px-1">
              <h2 className="text-lg font-medium text-[#fafafa]">
                Meeting settings
              </h2>
            </div>

            <div className="mt-5 space-y-5">
              <section className="space-y-3">
                <h3 className="text-sm font-semibold text-[#fafafa]">Audio</h3>
                <div className="space-y-2">
                  <label className="text-xs text-[#fafafa]/82">
                    Microphone
                  </label>
                  <select
                    value={selectedAudioInputValue ?? ""}
                    onChange={(event) =>
                      onAudioInputDeviceChange?.(event.target.value)
                    }
                    disabled={
                      !onAudioInputDeviceChange || audioInputDevices.length === 0
                    }
                    className="w-full bg-black/40 border border-[#fafafa]/10 rounded-xl px-3 py-2 text-sm text-[#fafafa] focus:outline-none focus:border-[#fafafa]/25 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {audioInputDevices.length === 0 ? (
                      <option value="">No microphones found</option>
                    ) : (
                      audioInputDevices.map((device, index) => (
                        <option
                          key={`${device.deviceId || "audio-input"}-${index}`}
                          value={device.deviceId}
                        >
                          {device.label}
                        </option>
                      ))
                    )}
                  </select>
                </div>

                <div className="space-y-2">
                  <label className="text-xs text-[#fafafa]/82">Speaker</label>
                  <select
                    value={selectedAudioOutputValue ?? ""}
                    onChange={(event) =>
                      onAudioOutputDeviceChange?.(event.target.value)
                    }
                    disabled={
                      !onAudioOutputDeviceChange ||
                      audioOutputDevices.length === 0
                    }
                    className="w-full bg-black/40 border border-[#fafafa]/10 rounded-xl px-3 py-2 text-sm text-[#fafafa] focus:outline-none focus:border-[#fafafa]/25 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {audioOutputDevices.length === 0 ? (
                      <option value="">No speakers found</option>
                    ) : (
                      audioOutputDevices.map((device, index) => (
                        <option
                          key={`${device.deviceId || "audio-output"}-${index}`}
                          value={device.deviceId}
                        >
                          {device.label}
                        </option>
                      ))
                    )}
                  </select>
                </div>

                {isLoadingAudioDevices && (
                  <p className="text-xs text-[#fafafa]/55">
                    Loading devices...
                  </p>
                )}

                {audioDevicesError && (
                  <p className="text-xs text-[#F95F4A]">{audioDevicesError}</p>
                )}

                {audioOutputDevices.length === 0 && !audioDevicesError && (
                  <p className="text-xs text-[#fafafa]/75">
                    Speaker selection may be limited in this mobile browser.
                  </p>
                )}
              </section>

              {isAdmin ? (
                <>
                  <section className="space-y-3">
                    <h3 className="text-sm font-semibold text-[#fafafa]">
                      Meeting access
                    </h3>
                    <p className="text-xs text-[#fafafa]/75">
                      {meetingRequiresInviteCode
                        ? "Invite code required to join."
                        : "Open meeting. Add a code to protect it."}
                    </p>
                    <div className="flex flex-col gap-2">
                      <input
                        type="text"
                        value={meetingInviteCodeInput}
                        onChange={(event) =>
                          setMeetingInviteCodeInput(event.target.value)
                        }
                        placeholder="Invite code"
                        className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-[#fafafa] outline-none placeholder:text-[#fafafa]/30 focus:border-[#fafafa]/25"
                      />
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() =>
                            void runMeetingTask(
                              async () => {
                                if (!onUpdateMeetingConfig) {
                                  throw new Error("Meeting controls unavailable.");
                                }
                                const code = meetingInviteCodeInput.trim();
                                if (!code) {
                                  throw new Error("Enter an invite code.");
                                }
                                const next = await onUpdateMeetingConfig({
                                  inviteCode: code,
                                });
                                if (!next) {
                                  throw new Error("Meeting update rejected.");
                                }
                              },
                              {
                                successMessage: "Meeting invite code saved.",
                                clearInviteInput: true,
                              },
                            )
                          }
                          disabled={
                            isMeetingWorking ||
                            !onUpdateMeetingConfig ||
                            !meetingInviteCodeInput.trim()
                          }
                          className="flex-1 rounded-lg bg-[#F95F4A] px-3 py-2 text-sm font-medium text-white transition hover:bg-[#F95F4A]/90 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          Save
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            void runMeetingTask(
                              async () => {
                                if (!onUpdateMeetingConfig) {
                                  throw new Error("Meeting controls unavailable.");
                                }
                                const next = await onUpdateMeetingConfig({
                                  inviteCode: null,
                                });
                                if (!next) {
                                  throw new Error("Meeting update rejected.");
                                }
                              },
                              { successMessage: "Meeting invite code cleared." },
                            )
                          }
                          disabled={
                            isMeetingWorking ||
                            !onUpdateMeetingConfig ||
                            !meetingRequiresInviteCode
                          }
                          className="flex-1 rounded-lg bg-white/10 px-3 py-2 text-sm text-[#fafafa]/80 transition hover:bg-white/20 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          Clear
                        </button>
                      </div>
                    </div>
                    {meetingNotice ? (
                      <p className="text-xs text-emerald-300/90">
                        {meetingNotice}
                      </p>
                    ) : null}
                    {meetingError ? (
                      <p className="text-xs text-[#F95F4A]">{meetingError}</p>
                    ) : null}
                  </section>

                  <section className="space-y-3">
                    <div className="flex items-center justify-between">
                      <h3 className="text-sm font-semibold text-[#fafafa]">
                        Webinar
                      </h3>
                      {webinarRole ? (
                        <span className="text-xs capitalize text-[#fafafa]/75">
                          {webinarRole}
                        </span>
                      ) : null}
                    </div>

                    <div className="-mx-2 flex flex-col">
                      <SwitchRow
                        label="Webinar mode"
                        tone="success"
                        checked={Boolean(webinarConfig?.enabled)}
                        disabled={isWebinarWorking || !onUpdateWebinarConfig}
                        className="rounded-lg"
                        onChange={() =>
                          void runWebinarTask(
                            async () => {
                              if (!onUpdateWebinarConfig) {
                                throw new Error("Webinar controls unavailable.");
                              }
                              const next = await onUpdateWebinarConfig({
                                enabled: !Boolean(webinarConfig?.enabled),
                              });
                              if (!next) {
                                throw new Error("Webinar update rejected.");
                              }
                            },
                            {
                              successMessage: webinarConfig?.enabled
                                ? "Webinar disabled."
                                : "Webinar enabled.",
                            },
                          )
                        }
                      />
                      <SwitchRow
                        label="Public access"
                        tone="success"
                        checked={Boolean(webinarConfig?.publicAccess)}
                        disabled={
                          isWebinarWorking ||
                          !onUpdateWebinarConfig ||
                          !webinarConfig?.enabled
                        }
                        className="rounded-lg"
                        onChange={() =>
                          void runWebinarTask(
                            async () => {
                              if (!onUpdateWebinarConfig) {
                                throw new Error("Webinar controls unavailable.");
                              }
                              const next = await onUpdateWebinarConfig({
                                publicAccess: !Boolean(webinarConfig?.publicAccess),
                              });
                              if (!next) {
                                throw new Error("Webinar update rejected.");
                              }
                            },
                            {
                              successMessage: webinarConfig?.publicAccess
                                ? "Public access disabled."
                                : "Public access enabled.",
                            },
                          )
                        }
                      />
                      <SwitchRow
                        label="Lock webinar"
                        tone="warning"
                        checked={Boolean(webinarConfig?.locked)}
                        disabled={
                          isWebinarWorking ||
                          !onUpdateWebinarConfig ||
                          !webinarConfig?.enabled
                        }
                        className="rounded-lg"
                        onChange={() =>
                          void runWebinarTask(
                            async () => {
                              if (!onUpdateWebinarConfig) {
                                throw new Error("Webinar controls unavailable.");
                              }
                              const next = await onUpdateWebinarConfig({
                                locked: !Boolean(webinarConfig?.locked),
                              });
                              if (!next) {
                                throw new Error("Webinar update rejected.");
                              }
                            },
                            {
                              successMessage: webinarConfig?.locked
                                ? "Webinar unlocked."
                                : "Webinar locked.",
                            },
                          )
                        }
                      />
                    </div>

                    <p className="text-xs text-[#fafafa]/75">
                      Attendees:{" "}
                      <span className="text-[#fafafa]">
                        {webinarConfig?.attendeeCount ?? 0}
                      </span>{" "}
                      /{" "}
                      <span className="text-[#fafafa]">
                        {webinarConfig?.maxAttendees ?? 500}
                      </span>
                    </p>

                    <div className="flex items-center gap-2">
                      <input
                        type="number"
                        min={1}
                        max={5000}
                        value={webinarCapInput}
                        onChange={(event) => setWebinarCapInput(event.target.value)}
                        placeholder="Attendee cap"
                        className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-[#fafafa] outline-none placeholder:text-[#fafafa]/30 focus:border-[#fafafa]/25"
                      />
                      <button
                        type="button"
                        onClick={() =>
                          void runWebinarTask(
                            async () => {
                              if (!onUpdateWebinarConfig) {
                                throw new Error("Webinar controls unavailable.");
                              }
                              if (webinarCapValue == null) {
                                throw new Error("Enter a valid attendee cap.");
                              }
                              const next = await onUpdateWebinarConfig({
                                maxAttendees: webinarCapValue,
                              });
                              if (!next) {
                                throw new Error("Webinar update rejected.");
                              }
                            },
                            { successMessage: "Attendee cap updated." },
                          )
                        }
                        disabled={
                          isWebinarWorking ||
                          !onUpdateWebinarConfig ||
                          !webinarConfig?.enabled ||
                          webinarCapValue == null
                        }
                        className="rounded-lg bg-white/10 px-3 py-2 text-sm text-[#fafafa] transition hover:bg-white/20 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        Save
                      </button>
                    </div>

                    <div className="flex flex-col gap-2">
                      <input
                        type="text"
                        value={webinarInviteCodeInput}
                        onChange={(event) =>
                          setWebinarInviteCodeInput(event.target.value)
                        }
                        placeholder="Invite code"
                        className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-[#fafafa] outline-none placeholder:text-[#fafafa]/30 focus:border-[#fafafa]/25"
                      />
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() =>
                            void runWebinarTask(
                              async () => {
                                if (!onUpdateWebinarConfig) {
                                  throw new Error("Webinar controls unavailable.");
                                }
                                const code = webinarInviteCodeInput.trim();
                                if (!code) {
                                  throw new Error("Enter an invite code.");
                                }
                                const next = await onUpdateWebinarConfig({
                                  inviteCode: code,
                                });
                                if (!next) {
                                  throw new Error("Webinar update rejected.");
                                }
                              },
                              {
                                successMessage: "Invite code saved.",
                                clearInviteInput: true,
                              },
                            )
                          }
                          disabled={
                            isWebinarWorking ||
                            !onUpdateWebinarConfig ||
                            !webinarConfig?.enabled ||
                            !webinarInviteCodeInput.trim()
                          }
                          className="flex-1 rounded-lg bg-[#F95F4A] px-3 py-2 text-sm font-medium text-white transition hover:bg-[#F95F4A]/90 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          Save
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            void runWebinarTask(
                              async () => {
                                if (!onUpdateWebinarConfig) {
                                  throw new Error("Webinar controls unavailable.");
                                }
                                const next = await onUpdateWebinarConfig({
                                  inviteCode: null,
                                });
                                if (!next) {
                                  throw new Error("Webinar update rejected.");
                                }
                              },
                              { successMessage: "Invite code cleared." },
                            )
                          }
                          disabled={
                            isWebinarWorking ||
                            !onUpdateWebinarConfig ||
                            !webinarConfig?.requiresInviteCode
                          }
                          className="flex-1 rounded-lg bg-white/10 px-3 py-2 text-sm text-[#fafafa]/80 transition hover:bg-white/20 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          Clear
                        </button>
                      </div>
                    </div>

                    <div className="space-y-2">
                      <input
                        readOnly
                        value={webinarLink ?? ""}
                        placeholder="Generate webinar link"
                        className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-[#fafafa] outline-none placeholder:text-[#fafafa]/30"
                      />
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() =>
                            void runWebinarTask(async () => {
                              if (!onGenerateWebinarLink) {
                                throw new Error("Webinar link generation unavailable.");
                              }
                              const linkResponse = await onGenerateWebinarLink();
                              if (!linkResponse?.link) {
                                throw new Error("Webinar link unavailable.");
                              }
                              onSetWebinarLink?.(linkResponse.link);
                              await copyLink(linkResponse.link);
                            }, { successMessage: "Webinar link copied." })
                          }
                          disabled={
                            isWebinarWorking ||
                            !onGenerateWebinarLink ||
                            !webinarConfig?.enabled
                          }
                          className="flex-1 rounded-lg bg-white/10 px-3 py-2 text-sm text-[#fafafa] transition hover:bg-white/20 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          Generate
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            void runWebinarTask(async () => {
                              if (!onRotateWebinarLink) {
                                throw new Error("Webinar link rotation unavailable.");
                              }
                              const linkResponse = await onRotateWebinarLink();
                              if (!linkResponse?.link) {
                                throw new Error("Webinar link unavailable.");
                              }
                              onSetWebinarLink?.(linkResponse.link);
                              await copyLink(linkResponse.link);
                            }, { successMessage: "Webinar link rotated and copied." })
                          }
                          disabled={
                            isWebinarWorking ||
                            !onRotateWebinarLink ||
                            !webinarConfig?.enabled
                          }
                          className="flex-1 rounded-lg bg-white/10 px-3 py-2 text-sm text-[#fafafa] transition hover:bg-white/20 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          Rotate
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            void runWebinarTask(async () => {
                              await copyLink(webinarLink ?? "");
                            }, { successMessage: "Webinar link copied." })
                          }
                          disabled={isWebinarWorking || !webinarLink}
                          className="flex-1 rounded-lg bg-white/10 px-3 py-2 text-sm text-[#fafafa] transition hover:bg-white/20 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          Copy
                        </button>
                      </div>
                    </div>

                    {webinarNotice ? (
                      <p className="text-xs text-emerald-300/90">
                        {webinarNotice}
                      </p>
                    ) : null}
                    {webinarError ? (
                      <p className="text-xs text-[#F95F4A]">{webinarError}</p>
                    ) : null}
                  </section>
                </>
              ) : null}
            </div>
          </div>
        </div>
      </div>

      {showBrowserControls && (
        <div
          className="mobile-sheet-root z-50"
          data-state={isBrowserSheetOpen ? "open" : "closed"}
          aria-hidden={!isBrowserSheetOpen}
        >
          <div
            className="mobile-sheet-overlay"
            onClick={() => {
              setIsBrowserSheetOpen(false);
              setBrowserUrlError(null);
            }}
          />
          <div className="mobile-sheet-panel">
            <div
              className="mobile-sheet mobile-sheet-scroll w-full p-4 pb-6 max-h-[75vh] touch-pan-y"
              style={{ fontFamily: "'PolySans Trial', sans-serif" }}
              role="dialog"
              aria-modal="true"
              aria-label="Shared browser"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="relative px-1 pb-3">
                <div className="mx-auto mobile-sheet-grabber" />
                <button
                  onClick={() => setIsBrowserSheetOpen(false)}
                  className="absolute right-0 top-0 h-7 w-7 mobile-pill mobile-glass-soft flex items-center justify-center text-[#fafafa]/82 hover:text-[#fafafa]"
                  aria-label="Close shared browser"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
              <div className="flex items-center gap-3 text-[#fafafa] px-1">
                <div className="h-10 w-10 rounded-2xl bg-[#2b2b2b] border border-white/5 flex items-center justify-center">
                  <Globe className="w-5 h-5" />
                </div>
                <div className="flex flex-col">
                  <span className="text-base font-medium">Shared browser</span>
                  <span className="text-[12px] font-medium text-[#fafafa]/75">
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
                className="w-full bg-black/40 border border-[#fafafa]/10 rounded-xl px-3 py-2 text-sm text-[#fafafa] placeholder:text-[#fafafa]/30 focus:outline-none focus:border-[#fafafa]/25"
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
                    className="px-3 py-2 rounded-xl bg-white/10 text-[#fafafa] text-sm font-medium hover:bg-white/20 transition-transform duration-150 touch-feedback"
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
      </div>
      )}

      <div className="fixed inset-x-0 bottom-0 z-40">
        <div className="absolute inset-x-0 bottom-0 h-32 bg-black/55 pointer-events-none" />
        <div className="relative flex items-center justify-center px-4 pb-[calc(12px+env(safe-area-inset-bottom))] pt-4">
          <div className="mobile-glass mobile-pill flex items-center gap-3 px-4 py-3">
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
              aria-label={
                isGhostMode ? "Microphone locked" : isMuted ? "Unmute" : "Mute"
              }
            >
              {isMuted ? (
                <MicOff className="w-5 h-5" />
              ) : (
                <Mic className="w-5 h-5" />
              )}
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
              aria-label={
                isGhostMode
                  ? "Camera locked"
                  : isCameraOff
                    ? "Turn on camera"
                    : "Turn off camera"
              }
            >
              {isCameraOff ? (
                <VideoOff className="w-5 h-5" />
              ) : (
                <Video className="w-5 h-5" />
              )}
            </button>

            <button
              onClick={openReactionMenu}
              disabled={isGhostMode}
              className={isGhostMode ? ghostDisabledClass : defaultButtonClass}
              aria-label={isGhostMode ? "Reactions locked" : "Reactions"}
            >
              <Smile className="w-5 h-5" />
            </button>

            <button
              onClick={handleChatButtonClick}
              className={`relative ${isChatOpen ? activeButtonClass : defaultButtonClass}`}
              aria-label="Chat"
            >
              <MessageSquare className="w-5 h-5" />
              {unreadCount > 0 && (
                <span className="absolute -top-1 -right-1 mobile-control-badge">
                  {unreadCount > 9 ? "9+" : unreadCount}
                </span>
              )}
            </button>

            <button
              onClick={openMoreMenu}
              className={defaultButtonClass}
              aria-label="More actions"
            >
              <MoreVertical className="w-5 h-5" />
            </button>

            <div className="w-px h-6 bg-[#fafafa]/10" />

            <button
              onClick={onLeave}
              className={leaveButtonClass}
              aria-label="Leave meeting"
            >
              <Phone className="rotate-[135deg] w-5 h-5" />
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

export default memo(MobileControlsBar);

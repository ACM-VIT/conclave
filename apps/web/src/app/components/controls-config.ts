import {
  Gamepad2,
  FileText,
  Globe,
  Hand,
  LayoutGrid,
  Lock,
  LockOpen,
  MessageSquare,
  Mic,
  MicOff,
  Monitor,
  MonitorPlay,
  PictureInPicture2,
  ScanFace,
  Shield,
  StickyNote,
  TerminalSquare,
  Users,
  Video,
  VideoOff,
  Volume2,
  VolumeX,
  type LucideIcon,
} from "lucide-react";
import type { ControlButtonVariant } from "@conclave/ui-tokens";
import type {
  MeetingConfigSnapshot,
  MeetingUpdateRequest,
  ReactionOption,
  TranscriptSessionStatus,
  WebinarConfigSnapshot,
  WebinarLinkResponse,
  WebinarUpdateRequest,
} from "../lib/types";
import { HOTKEYS } from "../lib/hotkeys";

export interface ControlsBarProps {
  /** Phone-width layout: fold screen-share/reactions into the More menu so the
   * core mic/camera/More/leave row fits without wrapping. */
  compact?: boolean;
  /** Room members (self first) for the watch-together coachmark vignette. */
  coachAvatars?: { id: string; name: string }[];
  roomId?: string;
  isMuted: boolean;
  isMuteTogglePending?: boolean;
  isCameraOff: boolean;
  isScreenSharing: boolean;
  activeScreenShareId: string | null;
  isChatOpen: boolean;
  isTranscriptOpen?: boolean;
  isTranscriptLive?: boolean;
  transcriptStatus?: TranscriptSessionStatus;
  unreadCount: number;
  isHandRaised: boolean;
  reactionOptions: ReactionOption[];
  onToggleMute: () => void;
  onToggleCamera: () => void;
  onToggleScreenShare: () => void;
  onToggleChat: () => void;
  onToggleTranscript?: () => void;
  onToggleHandRaised: () => void;
  onSendReaction: (reaction: ReactionOption) => void;
  onLeave: () => void;
  onEndForEveryone?: () => void;
  selectedAudioInputDeviceId?: string;
  selectedAudioOutputDeviceId?: string;
  selectedVideoInputDeviceId?: string;
  onAudioInputDeviceChange?: (deviceId: string) => void;
  onAudioOutputDeviceChange?: (deviceId: string) => void;
  onVideoInputDeviceChange?: (deviceId: string) => void;
  isMirrorCamera?: boolean;
  onToggleMirror?: () => void;
  isVideoEffectsOpen?: boolean;
  activeVideoEffectsCount?: number;
  isVideoEffectsPermissionBlocked?: boolean;
  onToggleVideoEffects?: () => void;
  isViewPanelOpen?: boolean;
  onToggleViewPanel?: () => void;
  isAdmin?: boolean | null;
  isGhostMode?: boolean;
  isParticipantsOpen?: boolean;
  onToggleParticipants?: () => void;
  isGamesOpen?: boolean;
  onToggleGames?: () => void;
  hasActiveGame?: boolean;
  isHostControlsOpen?: boolean;
  onToggleHostControls?: () => void;
  pendingUsersCount?: number;
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
  isReactionsDisabled?: boolean;
  onToggleReactionsDisabled?: () => void;
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
  isWatchActive?: boolean;
  onOpenWatch?: () => void;
  onCloseWatch?: () => void;
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
  isPopoutActive?: boolean;
  isPopoutSupported?: boolean;
  onOpenPopout?: () => void;
  onClosePopout?: () => void;
  meetingRequiresInviteCode?: boolean;
  webinarConfig?: WebinarConfigSnapshot | null;
  webinarRole?: "attendee" | "participant" | "host" | null;
  webinarLink?: string | null;
  onSetWebinarLink?: (link: string | null) => void;
  onGetMeetingConfig?: () => Promise<MeetingConfigSnapshot | null>;
  onUpdateMeetingConfig?: (
    update: MeetingUpdateRequest,
  ) => Promise<MeetingConfigSnapshot | null>;
  onGetWebinarConfig?: () => Promise<WebinarConfigSnapshot | null>;
  onUpdateWebinarConfig?: (
    update: WebinarUpdateRequest,
  ) => Promise<WebinarConfigSnapshot | null>;
  onGenerateWebinarLink?: () => Promise<WebinarLinkResponse | null>;
  onRotateWebinarLink?: () => Promise<WebinarLinkResponse | null>;
}

export interface ControlDescriptor {
  id: string;
  icon: LucideIcon;
  label: string;
  hotkey?: string;
  showTooltipWithoutHotkey?: boolean;
  variant: ControlButtonVariant;
  badge?: number;
  disabled?: boolean;
  loading?: boolean;
  onPress?: () => void;
}

export interface OverflowRow {
  id: string;
  icon: LucideIcon;
  label: string;
  hotkey?: string;
  active?: boolean;
  badge?: number;
  disabled?: boolean;
  /** When set, this row opens the browser launcher instead of firing onPress. */
  opensBrowserLauncher?: boolean;
  onPress?: () => void;
}

export interface ControlsConfig {
  left: ControlDescriptor[];
  center: ControlDescriptor[];
  overflow: OverflowRow[];
}

export const BROWSER_APPS: { id: string; name: string; description: string; url: string; icon: LucideIcon }[] = [
  { id: "figma", name: "Figma", description: "Design board", url: "https://www.figma.com", icon: StickyNote },
  { id: "miro", name: "Miro", description: "Whiteboard", url: "https://miro.com", icon: StickyNote },
  { id: "notion", name: "Notion", description: "Docs + tasks", url: "https://www.notion.so", icon: StickyNote },
  { id: "google-docs", name: "Docs", description: "Write together", url: "https://docs.google.com", icon: StickyNote },
  { id: "trello", name: "Trello", description: "Kanban board", url: "https://trello.com", icon: StickyNote },
  { id: "youtube", name: "YouTube", description: "Video watch", url: "https://www.youtube.com", icon: StickyNote },
  { id: "loom", name: "Loom", description: "Quick demo", url: "https://www.loom.com", icon: StickyNote },
];

export function canManageWhiteboard(p: ControlsBarProps): boolean {
  return Boolean(p.isAdmin && (p.onOpenWhiteboard || p.onCloseWhiteboard));
}
export function canManageWatch(p: ControlsBarProps): boolean {
  return Boolean(p.isAdmin && (p.onOpenWatch || p.onCloseWatch));
}
export function canManageDevPlayground(p: ControlsBarProps): boolean {
  return Boolean(
    p.isAdmin &&
      p.isDevPlaygroundEnabled &&
      (p.onOpenDevPlayground || p.onCloseDevPlayground),
  );
}

export function buildControlsConfig(p: ControlsBarProps): ControlsConfig {
  const ghost = Boolean(p.isGhostMode);
  const canStartScreenShare = !p.activeScreenShareId || p.isScreenSharing;
  const screenShareDisabled = ghost || !canStartScreenShare;

  const sideControls: ControlDescriptor[] = [];
  if (p.onToggleParticipants) {
    sideControls.push({
      id: "participants",
      icon: Users,
      label: "Participants",
      hotkey: HOTKEYS.toggleParticipants.keys,
      variant: p.isParticipantsOpen ? "active" : "default",
      badge: p.pendingUsersCount,
      onPress: p.onToggleParticipants,
    });
  }
  if (p.onToggleGames) {
    sideControls.push({
      id: "games",
      icon: Gamepad2,
      label: p.hasActiveGame ? "Game in progress" : "Games",
      showTooltipWithoutHotkey: true,
      variant: p.isGamesOpen || p.hasActiveGame ? "active" : "default",
      onPress: p.onToggleGames,
    });
  }
  if (p.onToggleTranscript) {
    sideControls.push({
      id: "transcript",
      icon: FileText,
      label: p.isTranscriptLive ? "Live transcript" : "Transcript",
      showTooltipWithoutHotkey: true,
      variant:
        p.isTranscriptOpen || p.isTranscriptLive ? "active" : "default",
      onPress: p.onToggleTranscript,
    });
  }
  sideControls.push({
    id: "chat",
    icon: MessageSquare,
    label: "Chat",
    hotkey: HOTKEYS.toggleChat.keys,
    variant: p.isChatOpen ? "active" : "default",
    badge: p.unreadCount,
    onPress: p.onToggleChat,
  });
  const left: ControlDescriptor[] = p.compact ? [] : sideControls;

  const center: ControlDescriptor[] = [
    {
      id: "mic",
      icon: p.isMuted ? MicOff : Mic,
      label: ghost
        ? "Ghost mode: mic locked"
        : p.isMuteTogglePending
          ? p.isMuted
            ? "Unmuting"
            : "Muting"
          : p.isMuted
            ? "Unmute"
            : "Mute",
      hotkey: HOTKEYS.toggleMute.keys,
      variant: ghost ? "default" : p.isMuted ? "muted" : "default",
      disabled: ghost,
      loading: Boolean(p.isMuteTogglePending && !ghost),
      onPress: p.onToggleMute,
    },
    {
      id: "camera",
      icon: p.isCameraOff ? VideoOff : Video,
      label: ghost ? "Ghost mode: camera locked" : p.isCameraOff ? "Turn on camera" : "Turn off camera",
      hotkey: HOTKEYS.toggleCamera.keys,
      variant: ghost ? "default" : p.isCameraOff ? "muted" : "default",
      disabled: ghost,
      onPress: p.onToggleCamera,
    },
  ];

  const handDescriptor: ControlDescriptor = {
    id: "hand",
    icon: Hand,
    label: p.isHandRaised ? "Lower hand" : "Raise hand",
    hotkey: HOTKEYS.toggleHandRaise.keys,
    variant: p.isHandRaised ? "active" : "default",
    disabled: ghost,
    onPress: p.onToggleHandRaised,
  };

  const screenShareDescriptor: ControlDescriptor = {
    id: "screen-share",
    icon: Monitor,
    label: !canStartScreenShare
      ? "Someone else is presenting"
      : p.isScreenSharing
        ? "Stop sharing"
        : "Share screen",
    hotkey: HOTKEYS.toggleScreenShare.keys,
    variant: p.isScreenSharing ? "active" : "default",
    disabled: screenShareDisabled,
    onPress: p.onToggleScreenShare,
  };

  const overflow: OverflowRow[] = [];
  if (p.compact) {
    sideControls.forEach((control) => {
      overflow.push({
        id: control.id,
        icon: control.icon,
        label: control.label,
        hotkey: control.hotkey,
        active: control.variant === "active",
        badge: control.badge,
        disabled: control.disabled,
        onPress: control.onPress,
      });
    });
    // Phone-width bar: keep the core row to mic/cam/More/leave, fold
    // side controls, hand raise, and screen-share into the More menu instead
    // of squeezing them into separate rails.
    overflow.push({
      id: handDescriptor.id,
      icon: handDescriptor.icon,
      label: handDescriptor.label,
      hotkey: handDescriptor.hotkey,
      active: handDescriptor.variant === "active",
      disabled: handDescriptor.disabled,
      onPress: handDescriptor.onPress,
    });
    overflow.push({
      id: "screen-share",
      icon: screenShareDescriptor.icon,
      label: screenShareDescriptor.label,
      hotkey: screenShareDescriptor.hotkey,
      active: p.isScreenSharing,
      disabled: screenShareDescriptor.disabled,
      onPress: screenShareDescriptor.onPress,
    });
  } else {
    center.push(handDescriptor);
    center.push(screenShareDescriptor);
  }
  if (p.isPopoutSupported && (p.onOpenPopout || p.onClosePopout)) {
    overflow.push({
      id: "popout",
      icon: PictureInPicture2,
      label: p.isPopoutActive ? "Close mini view" : "Pop out mini view",
      hotkey: HOTKEYS.toggleMiniView.keys,
      active: p.isPopoutActive,
      onPress: p.isPopoutActive ? p.onClosePopout : p.onOpenPopout,
    });
  }
  if (p.onToggleVideoEffects) {
    const effectsPermissionBlocked = Boolean(p.isVideoEffectsPermissionBlocked);
    overflow.push({
      id: "effects",
      icon: ScanFace,
      label: effectsPermissionBlocked
        ? "Permission needed"
        : "Backgrounds and effects",
      active: p.isVideoEffectsOpen || (p.activeVideoEffectsCount ?? 0) > 0,
      disabled: ghost || effectsPermissionBlocked,
      onPress: p.onToggleVideoEffects,
    });
  }
  if (p.onToggleViewPanel) {
    overflow.push({
      id: "adjust-view",
      icon: LayoutGrid,
      label: "Adjust view",
      active: p.isViewPanelOpen,
      onPress: p.onToggleViewPanel,
    });
  }
  if (p.showBrowserControls && p.isAdmin && p.onLaunchBrowser) {
    if (p.isBrowserActive) {
      overflow.push({
        id: "browser",
        icon: Globe,
        label: "Close shared browser",
        active: true,
        onPress: () => void p.onCloseBrowser?.(),
      });
    } else {
      overflow.push({
        id: "browser",
        icon: Globe,
        label: "Shared browser",
        disabled: p.isBrowserLaunching,
        opensBrowserLauncher: true,
      });
    }
  }
  if (
    p.showBrowserControls &&
    (p.hasBrowserAudio || p.isBrowserActive) &&
    p.onToggleBrowserAudio
  ) {
    overflow.push({
      id: "browser-audio",
      icon: p.isBrowserAudioMuted ? VolumeX : Volume2,
      label: p.isBrowserAudioMuted ? "Unmute browser audio" : "Mute browser audio",
      active: !p.isBrowserAudioMuted,
      onPress: p.onToggleBrowserAudio,
    });
  }
  if (canManageWhiteboard(p)) {
    overflow.push({
      id: "whiteboard",
      icon: StickyNote,
      label: p.isWhiteboardActive ? "Close whiteboard" : "Open whiteboard",
      active: p.isWhiteboardActive,
      onPress: () => (p.isWhiteboardActive ? p.onCloseWhiteboard?.() : p.onOpenWhiteboard?.()),
    });
  }
  if (canManageWatch(p)) {
    overflow.push({
      id: "watch",
      icon: MonitorPlay,
      label: p.isWatchActive ? "Close watch together" : "Watch together",
      active: p.isWatchActive,
      onPress: () => (p.isWatchActive ? p.onCloseWatch?.() : p.onOpenWatch?.()),
    });
  }
  if (canManageDevPlayground(p)) {
    overflow.push({
      id: "dev-playground",
      icon: TerminalSquare,
      label: p.isDevPlaygroundActive ? "Close dev playground" : "Open dev playground",
      active: p.isDevPlaygroundActive,
      onPress: () =>
        p.isDevPlaygroundActive ? p.onCloseDevPlayground?.() : p.onOpenDevPlayground?.(),
    });
  }
  if (p.onToggleAppsLock) {
    overflow.push({
      id: "apps-lock",
      icon: p.isAppsLocked ? Lock : LockOpen,
      label: p.isAppsLocked ? "Unlock app editing" : "Lock app editing",
      active: p.isAppsLocked,
      onPress: p.onToggleAppsLock,
    });
  }
  // Phone-width: the standalone host-controls shield is dropped from the right
  // cluster (see ControlsBar) and folded into the More menu like everything else
  // so the compact bar stays mic/cam/More/leave.
  if (p.compact && p.isAdmin && p.onToggleHostControls) {
    overflow.push({
      id: "host-controls",
      icon: Shield,
      label: "Host controls",
      active: p.isHostControlsOpen,
      badge: p.pendingUsersCount,
      onPress: p.onToggleHostControls,
    });
  }

  return { left, center, overflow };
}

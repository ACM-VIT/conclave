/**
 * Descriptor model for the in-call control bar. Collapses the old 128-prop /
 * 896-line flat ControlsBar into typed, zone-assigned descriptors so the JSX
 * just maps over arrays. The external prop contract (ControlsBarProps) is
 * unchanged — only the internal organization moved here.
 */
import {
  Globe,
  Hand,
  Lock,
  LockOpen,
  MessageSquare,
  Mic,
  MicOff,
  Monitor,
  PictureInPicture2,
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
  WebinarConfigSnapshot,
  WebinarLinkResponse,
  WebinarUpdateRequest,
} from "../lib/types";
import { HOTKEYS } from "../lib/hotkeys";

export interface ControlsBarProps {
  roomId?: string;
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

/** A circular bar button (left/center zones). */
export interface ControlDescriptor {
  id: string;
  icon: LucideIcon;
  label: string;
  hotkey?: string;
  variant: ControlButtonVariant;
  badge?: number;
  disabled?: boolean;
  onPress?: () => void;
}

/** A full-width row inside the overflow "More" menu. */
export interface OverflowRow {
  id: string;
  icon: LucideIcon;
  label: string;
  hotkey?: string;
  active?: boolean;
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

/** Flat (no-gradient) quick-launch targets for the shared browser. */
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
export function canManageDevPlayground(p: ControlsBarProps): boolean {
  return Boolean(
    p.isAdmin &&
      p.isDevPlaygroundEnabled &&
      (p.onOpenDevPlayground || p.onCloseDevPlayground),
  );
}

/**
 * Build the zone-assigned descriptor arrays from the raw props. Pure — no JSX,
 * no state. Every onPress is an existing handler from the prop contract.
 */
export function buildControlsConfig(p: ControlsBarProps): ControlsConfig {
  const ghost = Boolean(p.isGhostMode);
  const canStartScreenShare = !p.activeScreenShareId || p.isScreenSharing;
  const screenShareDisabled = ghost || !canStartScreenShare;

  const left: ControlDescriptor[] = [];
  if (p.onToggleParticipants) {
    left.push({
      id: "participants",
      icon: Users,
      label: "Participants",
      hotkey: HOTKEYS.toggleParticipants.keys,
      variant: p.isParticipantsOpen ? "active" : "default",
      badge: p.pendingUsersCount,
      onPress: p.onToggleParticipants,
    });
  }
  left.push({
    id: "chat",
    icon: MessageSquare,
    label: "Chat",
    hotkey: HOTKEYS.toggleChat.keys,
    variant: p.isChatOpen ? "active" : "default",
    badge: p.unreadCount,
    onPress: p.onToggleChat,
  });

  const center: ControlDescriptor[] = [
    {
      id: "mic",
      icon: p.isMuted ? MicOff : Mic,
      label: ghost ? "Ghost mode: mic locked" : p.isMuted ? "Unmute" : "Mute",
      hotkey: HOTKEYS.toggleMute.keys,
      variant: ghost ? "default" : p.isMuted ? "muted" : "default",
      disabled: ghost,
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
    {
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
    },
  ];

  const overflow: OverflowRow[] = [];
  overflow.push({
    id: "hand",
    icon: Hand,
    label: p.isHandRaised ? "Lower hand" : "Raise hand",
    hotkey: HOTKEYS.toggleHandRaise.keys,
    active: p.isHandRaised,
    disabled: ghost,
    onPress: p.onToggleHandRaised,
  });
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

  return { left, center, overflow };
}

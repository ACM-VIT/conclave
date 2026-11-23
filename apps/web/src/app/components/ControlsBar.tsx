"use client";

import {
  ArrowRight,
  ArrowLeft,
  MoreHorizontal,
  PhoneOff,
  Settings,
  Shapes,
  Shield,
  Smile,
  SwitchCamera,
  Users,
  Volume2,
  VolumeX,
} from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { Drawer } from "vaul";
import { Avatar, ControlButton } from "@conclave/ui-tokens/web";
import { color } from "@conclave/ui-tokens";
import {
  DeviceSettingsSection,
  MediaControlCluster,
  useEnumeratedDevices,
  type MediaControlClusterProps,
} from "./DeviceCaretMenu";
import type { ReactionOption, TranscriptSessionStatus } from "../lib/types";
import { normalizeBrowserUrl } from "../lib/utils";
import HotkeyTooltip from "./HotkeyTooltip";
import Coachmark from "./Coachmark";
import MeetingInfoTag from "./MeetingInfoTag";
import { useOneTimeHint } from "../hooks/useOneTimeHint";
import { useMeetVolume } from "../hooks/useMeetVolume";
import { clampMeetVolume } from "../lib/meet-volume";
import {
  buildControlsConfig,
  type ControlDescriptor,
  type ControlsBarProps,
  type OverflowRow,
} from "./controls-config";

export type { ControlsBarProps } from "./controls-config";

const ICON = 20;
const MENU_ICON = 18;
const STROKE = 1.75;

function BarButton({ d, size = 48 }: { d: ControlDescriptor; size?: number }) {
  const shouldShowTooltip = Boolean(d.hotkey || d.showTooltipWithoutHotkey);
  const button = (
    <ControlButton
      icon={d.icon}
      variant={d.variant}
      size={size}
      iconSize={20}
      badge={d.badge}
      label={d.label}
      disabled={d.disabled}
      onClick={d.onPress}
    />
  );
  return shouldShowTooltip ? (
    <HotkeyTooltip
      label={d.label}
      hotkey={d.hotkey}
      showWithoutHotkey={d.showTooltipWithoutHotkey}
    >
      {button}
    </HotkeyTooltip>
  ) : (
    button
  );
}

function MediaClusterButton({
  d,
  disabled,
  audio,
  video,
}: {
  d: ControlDescriptor;
  disabled?: boolean;
  audio?: Pick<
    MediaControlClusterProps,
    | "selectedAudioInputDeviceId"
    | "selectedAudioOutputDeviceId"
    | "onAudioInputDeviceChange"
    | "onAudioOutputDeviceChange"
    | "isNoiseCancellationEnabled"
    | "onToggleNoiseCancellation"
  >;
  video?: Pick<
    MediaControlClusterProps,
    "selectedVideoInputDeviceId" | "onVideoInputDeviceChange" | "isMirrorCamera" | "onToggleMirror"
  >;
}) {
  const cluster = (
    <MediaControlCluster
      kind={d.id === "mic" ? "mic" : "video"}
      icon={d.icon}
      variant={d.variant}
      label={d.label}
      onPress={d.onPress}
      badge={d.badge}
      hotkey={d.hotkey}
      disabled={disabled || d.disabled}
      loading={d.loading}
      {...audio}
      {...video}
    />
  );
  return cluster;
}

const TRANSCRIPT_DOCK_STATE: Partial<
  Record<TranscriptSessionStatus, { label: string; attention: boolean }>
> = {
  live: { label: "Transcript on", attention: false },
  starting: { label: "Transcript on", attention: false },
  paused: { label: "Transcript paused", attention: false },
  takeover_needed: { label: "Transcript needs attention", attention: true },
  error: { label: "Transcript needs attention", attention: true },
};

interface DockEntry {
  d: ControlDescriptor;
  live?: boolean;
}

function DockItem({ entry }: { entry: DockEntry }) {
  const { d } = entry;
  const Icon = d.icon;
  const active = d.variant === "active";
  return (
    <HotkeyTooltip
      label={d.label}
      hotkey={d.hotkey}
      showWithoutHotkey={d.showTooltipWithoutHotkey}
    >
      <button
        type="button"
        onClick={d.onPress}
        aria-label={d.label}
        title={d.label}
        className={
          "relative inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full " +
          "transition-[background-color,color] duration-[120ms] " +
          (active ? "bg-white/[0.09]" : "hover:bg-white/[0.08] hover:!text-[#fafafa]")
        }
        style={{ color: active ? color.accent : color.textMuted }}
      >
        <Icon size={ICON} strokeWidth={STROKE} />
        {typeof d.badge === "number" && d.badge > 0 ? (
          <span
            className="absolute -right-0.5 -top-0.5 inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1 text-[10px] font-semibold leading-none text-white"
            style={{ backgroundColor: color.accent }}
          >
            {d.badge > 9 ? "9+" : d.badge}
          </span>
        ) : null}
      </button>
    </HotkeyTooltip>
  );
}

function DockDivider() {
  return (
    <span
      aria-hidden
      className="mx-1 h-5 w-px shrink-0 rounded-full bg-white/[0.12]"
    />
  );
}

function DockFlyoutRow({
  entry,
  onActivate,
}: {
  entry: DockEntry;
  onActivate: () => void;
}) {
  const { d } = entry;
  const Icon = d.icon;
  const active = d.variant === "active";
  return (
    <button
      type="button"
      aria-label={d.label}
      onClick={onActivate}
      className="flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left text-[14px] font-medium transition-[background-color] duration-[120ms] hover:bg-white/[0.06]"
      style={{ color: active ? color.accent : color.text }}
    >
      <Icon size={MENU_ICON} strokeWidth={STROKE} className="shrink-0" />
      <span className="flex-1">{d.label}</span>
    </button>
  );
}

function ActivityDock({
  core,
  activities,
  promoted,
  host,
  onFlyoutOpenChange,
}: {
  core: DockEntry[];
  activities: DockEntry[];
  promoted?: DockEntry | null;
  host?: DockEntry | null;
  onFlyoutOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    onFlyoutOpenChange?.(open);
  }, [open, onFlyoutOpenChange]);
  const segmentRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const trayId = useId();
  const collapsible = activities.length > 1;

  const cancelClose = useCallback(() => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);
  useEffect(() => cancelClose, [cancelClose]);

  const scheduleClose = () => {
    cancelClose();
    closeTimer.current = setTimeout(() => {
      const segment = segmentRef.current;
      const focused = document.activeElement;
      if (
        segment &&
        focused instanceof HTMLElement &&
        segment.contains(focused) &&
        focused.matches(":focus-visible")
      ) {
        return;
      }
      setOpen(false);
    }, 160);
  };

  const openFlyout = () => {
    cancelClose();
    setOpen(true);
  };

  const openFlyoutWithFocus = () => {
    openFlyout();
    requestAnimationFrame(() => {
      segmentRef.current
        ?.querySelector<HTMLButtonElement>("[data-tray] button")
        ?.focus();
    });
  };

  const face = promoted ?? null;
  const FaceIcon = face?.d.icon ?? Shapes;
  const faceLabel = face ? face.d.label : "Activities";
  const liveAnnouncement = activities
    .filter((entry) => entry.live)
    .map((entry) => entry.d.label)
    .join(". ");
  const faceActive = face?.d.variant === "active";

  const handleFaceClick = () => {
    const hoverCapable =
      typeof window !== "undefined" &&
      window.matchMedia("(hover: hover)").matches;
    if (face && hoverCapable) {
      setOpen(false);
      face.d.onPress?.();
      return;
    }
    if (open) {
      setOpen(false);
      return;
    }
    openFlyoutWithFocus();
  };

  return (
    <div className="flex items-center rounded-full bg-white/[0.05] p-1">
      <span className="sr-only" aria-live="polite">
        {liveAnnouncement}
      </span>
      {core.map((entry) => (
        <DockItem key={entry.d.id} entry={entry} />
      ))}
      {activities.length > 0 && (
        <>
          {core.length > 0 && <DockDivider />}
          {collapsible ? (
            <div
              ref={segmentRef}
              className="relative flex items-center"
              onMouseEnter={openFlyout}
              onMouseLeave={scheduleClose}
              onBlurCapture={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget)) {
                  setOpen(false);
                }
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape" && open) {
                  event.stopPropagation();
                  setOpen(false);
                  segmentRef.current?.querySelector("button")?.focus();
                }
              }}
            >
              <button
                type="button"
                aria-label={faceLabel}
                title={faceLabel}
                aria-expanded={open}
                aria-controls={trayId}
                onClick={handleFaceClick}
                className="relative inline-flex h-10 w-10 items-center justify-center rounded-full transition-[background-color,color] duration-[120ms] hover:bg-white/[0.08] hover:!text-[#fafafa]"
                style={{ color: faceActive ? color.accent : color.textMuted }}
              >
                <span
                  key={face?.d.id ?? "activities"}
                  className="inline-flex animate-[acm-fade-in_150ms_ease-out_both]"
                >
                  <FaceIcon size={ICON} strokeWidth={STROKE} />
                </span>
              </button>
              {open && (
                <div className="absolute bottom-full right-0 z-50 pb-2">
                  <div
                    id={trayId}
                    data-tray
                    className={flyoutPanelClass + " w-44"}
                    style={{
                      backgroundColor: color.surfaceRaised,
                      borderColor: color.border,
                    }}
                  >
                    {activities.map((entry) => (
                      <DockFlyoutRow
                        key={entry.d.id}
                        entry={entry}
                        onActivate={() => {
                          setOpen(false);
                          entry.d.onPress?.();
                        }}
                      />
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : (
            activities.map((entry) => (
              <DockItem key={entry.d.id} entry={entry} />
            ))
          )}
        </>
      )}
      {host ? (
        <>
          <DockDivider />
          <DockItem entry={host} />
        </>
      ) : null}
    </div>
  );
}


function WatchTogetherTip({
  cast,
  onDismiss,
}: {
  cast?: { id: string; name: string }[];
  onDismiss: () => void;
}) {
  return (
      <Coachmark
        title="Watch together"
        description={"You can now watch YouTube together on Conclave."}
        width="w-[16.5rem]"
        className="!left-auto right-0 !translate-x-0"
        arrowLeft="calc(100% - 5rem)"
        onDismiss={onDismiss}
        visual={
          <div
            className="relative h-[4.75rem] w-full overflow-hidden rounded-lg border"
            style={{
              borderColor: color.border,
              backgroundColor: "#101014",
            }}
            aria-hidden="true"
          >
            <span className="absolute inset-0 flex items-center justify-center pb-1">
              <span
                className="flex h-7 w-7 items-center justify-center rounded-full animate-[acm-pop-in_340ms_cubic-bezier(0.22,1,0.36,1)_both]"
                style={{ backgroundColor: "#F95F4A" }}
              >
                <svg
                  width="10"
                  height="10"
                  viewBox="0 0 24 24"
                  fill="#ffffff"
                  style={{ marginLeft: 1.5 }}
                >
                  <polygon points="6 4 20 12 6 20 6 4" />
                </svg>
              </span>
            </span>
            <span className="absolute left-1/2 top-1/2 h-0 w-0 -translate-y-[2px] animate-[acm-orbit_11s_linear_infinite] motion-reduce:animate-none">
              {(cast ?? [])
                .slice(0, 4)
                .map((member, index, orbit) => (
                  <span
                    key={member.id}
                    className="absolute"
                    style={{
                      transform: `rotate(${(360 / orbit.length) * index}deg) translateX(26px)`,
                    }}
                  >
                    <span
                      className="block"
                      style={{
                        transform: `rotate(${(-360 / orbit.length) * index}deg)`,
                      }}
                    >
                      <span
                        className="block h-[18px] w-[18px] overflow-hidden rounded-full animate-[acm-orbit-rev_11s_linear_infinite] motion-reduce:animate-none"
                        style={{
                          boxShadow: "0 0 0 2px #101014",
                          margin: "-9px 0 0 -9px",
                        }}
                      >
                        <Avatar
                          id={member.id}
                          name={member.name}
                          size={18}
                        />
                      </span>
                    </span>
                  </span>
                ))}
            </span>
            <span
              className="absolute inset-x-0 bottom-0 h-[3px]"
              style={{ backgroundColor: "#26262d" }}
            >
              <span
                className="block h-full w-full origin-left animate-[acm-watch-reel_6400ms_cubic-bezier(0.4,0.1,0.4,0.9)_infinite] motion-reduce:animate-none"
                style={{ backgroundColor: "#F95F4A", transform: "scaleX(0.06)" }}
              />
            </span>
          </div>
        }
      />
  );
}

const popoverWrapClass = "absolute bottom-full mb-3 z-50";
const popoverPanelClass =
  "rounded-2xl border p-1.5 origin-bottom will-change-transform " +
  "animate-[meet-popover-in_150ms_cubic-bezier(0.22,1,0.36,1)]";
const flyoutPanelClass =
  "rounded-2xl border p-1.5 animate-[acm-fade-in_150ms_ease-out]";

function useClickOutside(
  open: boolean,
  ref: React.RefObject<HTMLDivElement | null>,
  close: () => void,
) {
  useEffect(() => {
    if (!open) return;
    const handler = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) close();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open, ref, close]);
}

function LeaveControl({
  onLeave,
  onEndForEveryone,
  iconSize,
  strokeWidth,
}: {
  onLeave: () => void;
  onEndForEveryone?: () => void;
  iconSize: number;
  strokeWidth: number;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressTriggered = useRef(false);

  useClickOutside(menuOpen, ref, () => setMenuOpen(false));

  if (!onEndForEveryone) {
    return (
      <HotkeyTooltip label="Leave call">
        <button
          type="button"
          onClick={onLeave}
          aria-label="Leave call"
          title="Leave call"
          className="ml-1 inline-flex h-12 w-[68px] items-center justify-center rounded-full bg-[#ea4335] text-white transition-colors duration-[120ms] hover:bg-[#e8533f] active:bg-[#d24a37]"
        >
          <PhoneOff size={iconSize} strokeWidth={strokeWidth} />
        </button>
      </HotkeyTooltip>
    );
  }

  const clearLongPress = () => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  };

  return (
    <div
      ref={ref}
      className="relative ml-1"
      onMouseEnter={() => setMenuOpen(true)}
      onMouseLeave={() => setMenuOpen(false)}
    >
      {menuOpen && (
        <div className="absolute bottom-full left-1/2 z-50 -translate-x-1/2 pb-2">
          <button
            type="button"
            onClick={() => {
              setMenuOpen(false);
              onEndForEveryone();
            }}
            className="flex origin-bottom items-center gap-2.5 whitespace-nowrap rounded-full border border-[#ea4335]/40 bg-[#2a1d1d]/95 py-2.5 pl-3.5 pr-4 text-sm font-semibold text-[#ff7a6e] shadow-[0_10px_30px_rgba(0,0,0,0.45)] backdrop-blur-md transition-colors will-change-transform hover:border-[#ea4335] hover:bg-[#ea4335] hover:text-white hover:shadow-[0_10px_30px_rgba(234,67,53,0.4)] animate-[meet-popover-in_150ms_cubic-bezier(0.22,1,0.36,1)]"
          >
            <Users size={17} strokeWidth={strokeWidth} className="shrink-0" />
            End call for everyone
          </button>
        </div>
      )}
      <button
        type="button"
        onClick={() => {
          if (longPressTriggered.current) {
            longPressTriggered.current = false;
            return;
          }
          setMenuOpen(false);
          onLeave();
        }}
        onTouchStart={() => {
          clearLongPress();
          longPressTriggered.current = false;
          longPressTimer.current = setTimeout(() => {
            longPressTriggered.current = true;
            setMenuOpen(true);
          }, 450);
        }}
        onTouchEnd={clearLongPress}
        onTouchMove={clearLongPress}
        onContextMenu={(e) => e.preventDefault()}
        aria-label="Leave call"
        title="Leave call"
        className="inline-flex h-12 w-[68px] items-center justify-center rounded-full bg-[#ea4335] text-white transition-colors duration-[120ms] hover:bg-[#e8533f] active:bg-[#d24a37]"
      >
        <PhoneOff size={iconSize} strokeWidth={strokeWidth} />
      </button>
    </div>
  );
}

function ControlsBar(props: ControlsBarProps) {
  const config = buildControlsConfig(props);
  const {
    compact = false,
    roomId,
    reactionOptions,
    onSendReaction,
    onLeave,
    onEndForEveryone,
    isAdmin,
    isBrowserActive = false,
    isBrowserLaunching = false,
    onLaunchBrowser,
    onNavigateBrowser,
    isHostControlsOpen = false,
    onToggleHostControls,
    isReactionsDisabled = false,
    selectedAudioInputDeviceId,
    selectedAudioOutputDeviceId,
    selectedVideoInputDeviceId,
    onAudioInputDeviceChange,
    onAudioOutputDeviceChange,
    onVideoInputDeviceChange,
    isNoiseCancellationEnabled,
    onToggleNoiseCancellation,
    isMirrorCamera,
    onToggleMirror,
    onToggleDeviceSettings,
  } = props;
  const hasAudioDevicePicker = Boolean(
    onAudioInputDeviceChange ||
      onAudioOutputDeviceChange ||
      onToggleNoiseCancellation,
  );
  const hasVideoDevicePicker = Boolean(
    onVideoInputDeviceChange || onToggleMirror,
  );

  const [reactionsOpen, setReactionsOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [browserOpen, setBrowserOpen] = useState(false);
  const [browserUrl, setBrowserUrl] = useState("");
  const [browserError, setBrowserError] = useState<string | null>(null);
  const { meetVolume, setMeetVolume } = useMeetVolume();
  const meetVolumePercent = Math.round(clampMeetVolume(meetVolume) * 100);

  const { videoInput: drawerCameras } = useEnumeratedDevices(
    compact && (moreOpen || settingsOpen),
  );
  const canFlipCamera =
    Boolean(onVideoInputDeviceChange) && drawerCameras.length >= 2;
  const flipCamera = useCallback(() => {
    if (!onVideoInputDeviceChange || drawerCameras.length < 2) return;
    const currentId =
      selectedVideoInputDeviceId || drawerCameras[0]?.deviceId;
    const index = drawerCameras.findIndex((d) => d.deviceId === currentId);
    const next = drawerCameras[(index + 1) % drawerCameras.length];
    if (next) onVideoInputDeviceChange(next.deviceId);
  }, [onVideoInputDeviceChange, drawerCameras, selectedVideoInputDeviceId]);

  const reactionRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLDivElement>(null);
  const browserRef = useRef<HTMLDivElement>(null);

  useClickOutside(reactionsOpen, reactionRef, () => setReactionsOpen(false));
  useClickOutside(moreOpen && !compact, moreRef, () => setMoreOpen(false));
  useClickOutside(browserOpen, browserRef, () => setBrowserOpen(false));

  const moreRows = config.overflow.filter((row) => !row.paletteOnly);

  const hasEffects = config.overflow.some(
    (row) => row.id === "effects" && !row.disabled,
  );
  const filtersTip = useOneTimeHint("more-filters", {
    enabled: hasEffects,
    delay: 1800,
  });
  const hasChatControl = config.left.some(
    (row) => row.id === "chat" && !row.disabled,
  );
  const hasGamesControl = config.left.some(
    (row) => row.id === "games" && !row.disabled,
  );
  const gamesTip = useOneTimeHint("games-launcher", {
    enabled:
      !compact &&
      hasGamesControl &&
      !props.isGamesOpen &&
      !props.hasActiveGame,
    delay: 3000,
  });
  const gifsTip = useOneTimeHint("chat-gifs", {
    enabled: !compact && hasChatControl && !props.isChatOpen,
    delay: 2400,
  });
  const hasWatchControl = config.overflow.some(
    (row) => row.id === "watch" && !row.disabled,
  );
  const watchTip = useOneTimeHint("watch-together", {
    enabled: hasWatchControl,
    delay: 2200,
  });

  const lastReactionRef = useRef(0);
  const handleReaction = useCallback(
    (reaction: ReactionOption) => {
      const now = Date.now();
      if (now - lastReactionRef.current < 150) return;
      lastReactionRef.current = now;
      onSendReaction(reaction);
    },
    [onSendReaction],
  );

  const browserUrlHandler = isBrowserActive
    ? onNavigateBrowser
    : onLaunchBrowser;
  const submitBrowserUrl = useCallback(
    async (url: string) => {
      const normalized = normalizeBrowserUrl(url);
      if (!normalized.url) {
        setBrowserError(normalized.error ?? "Enter a valid URL.");
        return;
      }
      if (!browserUrlHandler) return;
      setBrowserError(null);
      setBrowserUrl("");
      setBrowserOpen(false);
      setMoreOpen(false);
      await browserUrlHandler(normalized.url);
    },
    [browserUrlHandler],
  );

  const showHost = Boolean(isAdmin);
  const VolumeIcon = meetVolumePercent === 0 ? VolumeX : Volume2;

  const transcriptState = props.transcriptStatus
    ? TRANSCRIPT_DOCK_STATE[props.transcriptStatus]
    : undefined;
  const [dockFlyoutOpen, setDockFlyoutOpen] = useState(false);
  const panelCoachmarkVisible =
    !moreOpen &&
    !reactionsOpen &&
    !browserOpen &&
    !dockFlyoutOpen &&
    !filtersTip.visible &&
    (watchTip.visible ||
      (gamesTip.visible && !props.isGamesOpen && !props.hasActiveGame) ||
      (gifsTip.visible && !props.isChatOpen));

  const leftById = new Map(config.left.map((d) => [d.id, d]));
  const withTipDismiss = (
    d: ControlDescriptor | undefined,
    dismiss: () => void,
  ): ControlDescriptor | undefined =>
    d && {
      ...d,
      onPress: () => {
        dismiss();
        d.onPress?.();
      },
    };
  const participantsItem = leftById.get("participants");
  const chatItem = withTipDismiss(leftById.get("chat"), gifsTip.dismiss);
  const gamesItem = withTipDismiss(leftById.get("games"), gamesTip.dismiss);
  const appsItem = withTipDismiss(leftById.get("apps"), watchTip.dismiss);
  const transcriptItem = leftById.get("transcript");

  const gamesEntry: DockEntry | null = gamesItem
    ? {
        d: { ...gamesItem, variant: props.isGamesOpen ? "active" : "default" },
        live: Boolean(props.hasActiveGame),
      }
    : null;
  const appsEntry: DockEntry | null = appsItem
    ? {
        d: { ...appsItem, variant: props.isAppsOpen ? "active" : "default" },
        live: Boolean(props.hasActiveApp),
      }
    : null;
  const transcriptEntry: DockEntry | null = transcriptItem
    ? {
        d: {
          ...transcriptItem,
          label: transcriptState?.label ?? transcriptItem.label,
          variant: props.isTranscriptOpen ? "active" : "default",
        },
        live: Boolean(transcriptState),
      }
    : null;

  const dockCore: DockEntry[] = [
    participantsItem ? { d: participantsItem } : null,
    chatItem ? { d: chatItem } : null,
  ].filter((entry): entry is DockEntry => entry !== null);
  const dockActivities: DockEntry[] = [
    gamesEntry,
    appsEntry,
    transcriptEntry,
  ].filter((entry): entry is DockEntry => entry !== null);

  const promotedEntry =
    (transcriptState?.attention ? transcriptEntry : null) ??
    (props.hasActiveApp ? appsEntry : null) ??
    (props.hasActiveGame ? gamesEntry : null) ??
    (transcriptState ? transcriptEntry : null) ??
    (props.isGamesOpen ? gamesEntry : null) ??
    (props.isAppsOpen ? appsEntry : null) ??
    (props.isTranscriptOpen ? transcriptEntry : null) ??
    null;

  const hostEntry: DockEntry | null =
    showHost && !compact && onToggleHostControls
      ? {
          d: {
            id: "host-controls",
            icon: Shield,
            label: "Host controls",
            showTooltipWithoutHotkey: true,
            variant: isHostControlsOpen ? "active" : "default",
            onPress: onToggleHostControls,
          },
        }
      : null;
  const dockVisible =
    dockCore.length + dockActivities.length > 0 || hostEntry !== null;

  return (
    <div className="relative flex w-full items-center gap-2 px-4 py-3 sm:grid sm:grid-cols-[1fr_auto_1fr]">
      <div className="flex min-w-0 shrink-0 items-center justify-self-start">
        {!compact && <MeetingInfoTag roomId={roomId} />}
      </div>

      <div className="flex flex-1 items-center justify-center justify-self-center gap-2.5">
        {config.center.map((d) => {
          if (d.id === "mic" && hasAudioDevicePicker && !compact) {
            return (
              <MediaClusterButton
                key={d.id}
                d={d}
                audio={{
                  selectedAudioInputDeviceId,
                  selectedAudioOutputDeviceId,
                  onAudioInputDeviceChange,
                  onAudioOutputDeviceChange,
                  isNoiseCancellationEnabled,
                  onToggleNoiseCancellation,
                }}
              />
            );
          }
          if (d.id === "camera" && hasVideoDevicePicker && !compact) {
            return (
              <MediaClusterButton
                key={d.id}
                d={d}
                video={{
                  selectedVideoInputDeviceId,
                  onVideoInputDeviceChange,
                  isMirrorCamera,
                  onToggleMirror,
                }}
              />
            );
          }
          return <BarButton key={d.id} d={d} />;
        })}

        {!compact && (!isReactionsDisabled || isAdmin) && (
          <div ref={reactionRef} className="relative">
            <HotkeyTooltip label="Reactions">
              <ControlButton
                icon={Smile}
                variant={reactionsOpen ? "active" : "default"}
                size={48}
                iconSize={ICON}
                label="Reactions"
                onClick={() => setReactionsOpen((v) => !v)}
              />
            </HotkeyTooltip>
            {reactionsOpen && (
              <div className={popoverWrapClass + " left-1/2 -translate-x-1/2"}>
              <div
                className={popoverPanelClass + " flex items-center gap-1"}
                style={{ backgroundColor: color.surfaceRaised, borderColor: color.border }}
              >
                {reactionOptions.length === 0 ? (
                  <span
                    className="px-3 py-1.5 text-[13px]"
                    style={{ color: color.textFaint }}
                  >
                    No reactions available
                  </span>
                ) : null}
                {reactionOptions.map((reaction) => (
                  <button
                    key={reaction.id}
                    onClick={() => handleReaction(reaction)}
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-lg transition-[background-color] duration-[120ms] hover:bg-white/[0.08]"
                    title={`React with ${reaction.label}`}
                    aria-label={`React with ${reaction.label}`}
                  >
                    {reaction.kind === "emoji" ? (
                      reaction.value
                    ) : (
                      <img
                        src={reaction.value}
                        alt={reaction.label}
                        className="h-5 w-5 object-contain"
                        loading="lazy"
                      />
                    )}
                  </button>
                ))}
              </div>
              </div>
            )}
          </div>
        )}

        <div ref={moreRef} className="relative">
          <ControlButton
            icon={MoreHorizontal}
            variant={moreOpen ? "active" : "default"}
            size={48}
            iconSize={ICON}
            label="More options"
            onClick={() => {
              if (filtersTip.visible) filtersTip.dismiss();
              setMoreOpen((v) => !v);
            }}
          />
          {filtersTip.visible &&
          !watchTip.visible &&
          !moreOpen &&
          !reactionsOpen &&
          !browserOpen ? (
            <Coachmark
              title="New filters to check out!"
              description="We added some more"
              onDismiss={filtersTip.dismiss}
            />
          ) : null}
          {moreOpen && !compact && (
            <div
              ref={browserRef}
              className={popoverWrapClass + " left-1/2 w-60 -translate-x-1/2"}
            >
            <div
              className={popoverPanelClass + " w-full"}
              style={{ backgroundColor: color.surfaceRaised, borderColor: color.border }}
            >
              {moreRows.map((row) => (
                <OverflowItem
                  key={row.id}
                  row={row}
                  onActivate={() => {
                    if (row.opensBrowserLauncher) {
                      setBrowserOpen((v) => !v);
                    } else {
                      row.onPress?.();
                      setMoreOpen(false);
                    }
                  }}
                />
              ))}
              <MeetVolumeOverflowControl
                icon={VolumeIcon}
                volumePercent={meetVolumePercent}
                onVolumePercentChange={(value) => setMeetVolume(value / 100)}
              />
              {browserOpen && browserUrlHandler && (
                <BrowserLauncher
                  url={browserUrl}
                  error={browserError}
                  busy={isBrowserLaunching}
                  onUrlChange={(v) => {
                    setBrowserUrl(v);
                    if (browserError) setBrowserError(null);
                  }}
                  onLaunch={submitBrowserUrl}
                />
              )}
            </div>
            </div>
          )}
          {compact && (
            <Drawer.Root
              open={moreOpen}
              onOpenChange={(open) => {
                if (!open) setBrowserOpen(false);
                setMoreOpen(open);
              }}
            >
              <Drawer.Portal>
                <Drawer.Overlay className="fixed inset-0 z-[90] bg-black/55" />
                <Drawer.Content
                  aria-label="More options"
                  className="fixed inset-x-0 bottom-0 z-[91] flex max-h-[85vh] flex-col rounded-t-3xl border-t outline-none"
                  style={{ backgroundColor: color.surfaceRaised, borderColor: color.border }}
                >
                  <Drawer.Title className="sr-only">More options</Drawer.Title>
                  <div
                    aria-hidden
                    className="mx-auto mt-3 h-1 w-9 shrink-0 rounded-full"
                    style={{ backgroundColor: color.border }}
                  />
                  <div className="overflow-y-auto px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3">
                    {(!isReactionsDisabled || isAdmin) && reactionOptions.length > 0 && (
                      <div
                        className="mb-3 flex flex-wrap items-center justify-center gap-1 rounded-2xl p-1.5"
                        style={{ backgroundColor: color.surface }}
                      >
                        {reactionOptions.map((reaction) => (
                          <button
                            key={reaction.id}
                            onClick={() => {
                              handleReaction(reaction);
                              setMoreOpen(false);
                            }}
                            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-2xl transition-[background-color] duration-[120ms] active:bg-white/[0.1]"
                            title={`React with ${reaction.label}`}
                            aria-label={`React with ${reaction.label}`}
                          >
                            {reaction.kind === "emoji" ? (
                              reaction.value
                            ) : (
                              <img
                                src={reaction.value}
                                alt={reaction.label}
                                className="h-6 w-6 object-contain"
                                loading="lazy"
                              />
                            )}
                          </button>
                        ))}
                      </div>
                    )}
                    <div className="grid grid-cols-3 gap-2">
                      {moreRows.map((row) => (
                        <MoreTile
                          key={row.id}
                          row={row}
                          onActivate={() => {
                            if (row.opensBrowserLauncher) {
                              setBrowserOpen((v) => !v);
                            } else {
                              row.onPress?.();
                              setMoreOpen(false);
                            }
                          }}
                        />
                      ))}
                      {canFlipCamera && (
                        <MoreTile
                          row={{
                            id: "flip-camera",
                            icon: SwitchCamera,
                            label: "Flip camera",
                          }}
                          onActivate={() => {
                            flipCamera();
                            setMoreOpen(false);
                          }}
                        />
                      )}
                      {(hasAudioDevicePicker ||
                        hasVideoDevicePicker ||
                        onToggleDeviceSettings) && (
                          <MoreTile
                            row={{
                              id: "settings",
                              icon: Settings,
                              label: "Settings",
                            }}
                            onActivate={() => {
                              setMoreOpen(false);
                              if (onToggleDeviceSettings) {
                                onToggleDeviceSettings();
                              } else {
                                setSettingsOpen(true);
                              }
                            }}
                          />
                        )}
                    </div>
                    <MeetVolumeOverflowControl
                      icon={VolumeIcon}
                      volumePercent={meetVolumePercent}
                      onVolumePercentChange={(value) => setMeetVolume(value / 100)}
                    />
                    {browserOpen && browserUrlHandler && (
                      <BrowserLauncher
                        url={browserUrl}
                        error={browserError}
                        busy={isBrowserLaunching}
                        onUrlChange={(v) => {
                          setBrowserUrl(v);
                          if (browserError) setBrowserError(null);
                        }}
                        onLaunch={submitBrowserUrl}
                      />
                    )}
                  </div>
                </Drawer.Content>
              </Drawer.Portal>
            </Drawer.Root>
          )}
          {compact && (
            <Drawer.Root open={settingsOpen} onOpenChange={setSettingsOpen}>
              <Drawer.Portal>
                <Drawer.Overlay className="fixed inset-0 z-[90] bg-black/55" />
                <Drawer.Content
                  aria-label="Settings"
                  className="fixed inset-x-0 bottom-0 z-[91] flex max-h-[85vh] flex-col rounded-t-3xl border-t outline-none"
                  style={{ backgroundColor: color.surfaceRaised, borderColor: color.border }}
                >
                  <Drawer.Title className="sr-only">Settings</Drawer.Title>
                  <div
                    aria-hidden
                    className="mx-auto mt-3 h-1 w-9 shrink-0 rounded-full"
                    style={{ backgroundColor: color.border }}
                  />
                  <div className="flex items-center gap-2 px-4 pb-1 pt-3">
                    <button
                      type="button"
                      aria-label="Back"
                      onClick={() => {
                        setSettingsOpen(false);
                        setMoreOpen(true);
                      }}
                      className="-ml-1.5 inline-flex h-8 w-8 items-center justify-center rounded-full transition-[background-color] duration-[120ms] active:bg-white/[0.08]"
                      style={{ color: color.textMuted }}
                    >
                      <ArrowLeft size={MENU_ICON} strokeWidth={STROKE} />
                    </button>
                    <span
                      className="text-[15px] font-semibold"
                      style={{ color: color.text }}
                    >
                      Settings
                    </span>
                  </div>
                  <div className="overflow-y-auto px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-1">
                    <DeviceSettingsSection
                      bare
                      active={settingsOpen}
                      selectedAudioInputDeviceId={selectedAudioInputDeviceId}
                      selectedAudioOutputDeviceId={selectedAudioOutputDeviceId}
                      selectedVideoInputDeviceId={selectedVideoInputDeviceId}
                      onAudioInputDeviceChange={onAudioInputDeviceChange}
                      onAudioOutputDeviceChange={onAudioOutputDeviceChange}
                      onVideoInputDeviceChange={onVideoInputDeviceChange}
                      isNoiseCancellationEnabled={isNoiseCancellationEnabled}
                      onToggleNoiseCancellation={onToggleNoiseCancellation}
                      isMirrorCamera={isMirrorCamera}
                      onToggleMirror={onToggleMirror}
                    />
                  </div>
                </Drawer.Content>
              </Drawer.Portal>
            </Drawer.Root>
          )}
        </div>

        <LeaveControl
          onLeave={onLeave}
          onEndForEveryone={showHost ? onEndForEveryone : undefined}
          iconSize={ICON}
          strokeWidth={STROKE}
        />
      </div>

      <div className="flex min-w-0 shrink-0 items-center justify-self-end">
        {dockVisible && (
          <div className="relative flex pr-[max(0.5rem,env(safe-area-inset-right))]">
            <ActivityDock
              core={dockCore}
              activities={dockActivities}
              promoted={promotedEntry}
              host={hostEntry}
              onFlyoutOpenChange={setDockFlyoutOpen}
            />
            {panelCoachmarkVisible && watchTip.visible ? (
              <WatchTogetherTip
                cast={props.coachAvatars}
                onDismiss={watchTip.dismiss}
              />
            ) : panelCoachmarkVisible && gamesTip.visible ? (
              <Coachmark
                title="Games are here!"
                description="Start a quick room game with everyone."
                onDismiss={gamesTip.dismiss}
              />
            ) : panelCoachmarkVisible && gifsTip.visible ? (
              <Coachmark
                title="GIFs are here!"
                description="You can send your fav reactions on Conclave"
                onDismiss={gifsTip.dismiss}
                arrowLeft="calc(100% - 1.25rem)"
                className="!left-auto right-0 !translate-x-0"
              />
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

function OverflowItem({ row, onActivate }: { row: OverflowRow; onActivate: () => void }) {
  const Icon = row.icon;
  return (
    <button
      type="button"
      aria-label={row.label}
      title={row.label}
      disabled={row.disabled}
      onClick={onActivate}
      className="flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left text-[14px] font-medium transition-[background-color] duration-[120ms] hover:bg-white/[0.06] disabled:opacity-40"
      style={{ color: row.active ? color.accent : color.text }}
    >
      <Icon size={MENU_ICON} strokeWidth={STROKE} className="shrink-0" />
      <span className="flex-1">{row.label}</span>
      {typeof row.badge === "number" && row.badge > 0 ? (
        <span
          className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1 text-[10px] font-semibold leading-none text-white"
          style={{ backgroundColor: color.accent }}
        >
          {row.badge > 9 ? "9+" : row.badge}
        </span>
      ) : null}
    </button>
  );
}

function MoreTile({ row, onActivate }: { row: OverflowRow; onActivate: () => void }) {
  const Icon = row.icon;
  return (
    <button
      type="button"
      aria-label={row.label}
      title={row.label}
      disabled={row.disabled}
      onClick={onActivate}
      className="relative flex flex-col items-center gap-2 rounded-2xl px-1.5 py-3.5 transition-[background-color] duration-[120ms] active:bg-white/[0.06] disabled:opacity-40"
    >
      <span
        className="relative flex h-12 w-12 items-center justify-center rounded-full"
        style={{
          backgroundColor: row.active ? color.accent : "rgba(250,250,250,0.08)",
          color: row.active ? "#fff" : color.text,
        }}
      >
        <Icon size={22} strokeWidth={STROKE} />
        {typeof row.badge === "number" && row.badge > 0 ? (
          <span
            className="absolute -right-0.5 -top-0.5 inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1 text-[10px] font-semibold leading-none text-white"
            style={{ backgroundColor: color.accent }}
          >
            {row.badge > 9 ? "9+" : row.badge}
          </span>
        ) : null}
      </span>
      <span
        className="line-clamp-2 text-center text-[12px] font-medium leading-tight"
        style={{ color: row.active ? color.accent : color.textMuted }}
      >
        {row.label}
      </span>
    </button>
  );
}

function MeetVolumeOverflowControl({
  icon: Icon,
  volumePercent,
  onVolumePercentChange,
}: {
  icon: typeof Volume2;
  volumePercent: number;
  onVolumePercentChange: (value: number) => void;
}) {
  return (
    <div className="mt-1.5 border-t px-2.5 pb-2 pt-3" style={{ borderColor: color.border }}>
      <div className="mb-2 flex items-center gap-3">
        <Icon size={MENU_ICON} strokeWidth={STROKE} className="shrink-0" />
        <span className="flex-1 text-[14px] font-medium" style={{ color: color.text }}>
          Meet volume
        </span>
        <span
          className="text-[12px] tabular-nums"
          style={{ color: color.textMuted }}
        >
          {volumePercent}%
        </span>
      </div>
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={volumePercent}
        onChange={(event) =>
          onVolumePercentChange(Number(event.currentTarget.value))
        }
        aria-label="Meet volume"
        className="h-2 w-full accent-[#F95F4A]"
      />
    </div>
  );
}

function BrowserLauncher({
  url,
  error,
  busy,
  onUrlChange,
  onLaunch,
}: {
  url: string;
  error: string | null;
  busy: boolean;
  onUrlChange: (value: string) => void;
  onLaunch: (url: string) => void;
}) {
  return (
    <div className="mt-1.5 border-t pt-2" style={{ borderColor: color.border }}>
      <form
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          if (url.trim()) onLaunch(url);
        }}
        className="flex min-w-0 items-center gap-2"
      >
        <input
          type="text"
          value={url}
          onChange={(e) => onUrlChange(e.target.value)}
          placeholder="Paste a URL"
          aria-label="Shared browser URL"
          className="h-9 min-w-0 flex-1 rounded-lg border px-3 text-[13px] focus:outline-none"
          style={{ backgroundColor: color.bg, borderColor: color.border, color: color.text }}
        />
        <button
          type="submit"
          disabled={!url.trim() || busy}
          aria-label="Open URL in shared browser"
          title="Open URL"
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#F95F4A] p-0 text-white transition-colors duration-[120ms] hover:bg-[#e8553f] active:bg-[#d34933] disabled:opacity-40"
        >
          <ArrowRight size={16} strokeWidth={STROKE} />
        </button>
      </form>
      {error && (
        <p className="mt-2 text-[12px]" style={{ color: color.danger }}>
          {error}
        </p>
      )}
    </div>
  );
}


export default memo(ControlsBar);

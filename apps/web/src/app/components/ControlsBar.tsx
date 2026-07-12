"use client";

import {
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
import type { ReactionOption } from "../lib/types";
import { normalizeBrowserUrl } from "../lib/utils";
import HotkeyTooltip from "./HotkeyTooltip";
import Coachmark from "./Coachmark";
import MeetingInfoTag from "./MeetingInfoTag";
import { useOneTimeHint } from "../hooks/useOneTimeHint";
import { useMeetVolume } from "../hooks/useMeetVolume";
import { clampMeetVolume } from "../lib/meet-volume";
import {
  BROWSER_APPS,
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

type PanelStatus = "live" | "attention" | null;

/** Room-level "something is happening here" marker on a dock icon. Distinct
 * from the active variant, which means "my panel is open". */
interface DockDot {
  color: string;
  pulse?: boolean;
}

interface DockEntry {
  d: ControlDescriptor;
  dot?: DockDot | null;
}

function DockStatusDot({ dot }: { dot: DockDot }) {
  return (
    <span
      aria-hidden
      className={
        "absolute right-1 top-1 h-2 w-2 rounded-full " +
        (dot.pulse ? "animate-pulse" : "")
      }
      style={{ backgroundColor: dot.color, boxShadow: "0 0 0 2px #131316" }}
    />
  );
}

function DockItem({ entry }: { entry: DockEntry }) {
  const { d, dot } = entry;
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
        {dot ? <DockStatusDot dot={dot} /> : null}
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

/** A labeled row inside the activities flyout: icon, name, and the same
 * status-dot language as the dock (dot = live in the room). */
function DockFlyoutRow({
  entry,
  onActivate,
}: {
  entry: DockEntry;
  onActivate: () => void;
}) {
  const { d, dot } = entry;
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
      {dot ? (
        <span
          aria-hidden
          className={
            "h-2 w-2 shrink-0 rounded-full " + (dot.pulse ? "animate-pulse" : "")
          }
          style={{ backgroundColor: dot.color }}
        />
      ) : null}
    </button>
  );
}

/**
 * The right-rail dock. Panel toggles are grouped by intent instead of lined up
 * as six equal icons: the people panels (participants, chat) stay put, the
 * activity panels (games, apps, transcript) share a single slot, and the host
 * shield anchors its own segment. The slot opens a small flyout above the bar
 * (hover, tap, or keyboard), so the pill never changes width and the bar never
 * shifts. When something is live in the room — game running, app open,
 * transcript recording — the slot wears that activity's icon with a status
 * dot, so one click returns to it without any "LIVE" chrome.
 */
function ActivityDock({
  core,
  activities,
  promoted,
  host,
  onFlyoutOpenChange,
}: {
  core: DockEntry[];
  activities: DockEntry[];
  /** The activity owning the shared slot's face right now (live beats open). */
  promoted?: DockEntry | null;
  host?: DockEntry | null;
  /** Lets the bar hide dock coachmarks while the flyout is up — both float in
   * the same spot above the dock, and the flyout must win. */
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

  // A short grace period keeps the flyout from snapping shut when the pointer
  // crosses the gap between the face and the flyout. Only *keyboard* focus
  // pins it open — a mouse click also focuses the button it hit, and honoring
  // that would leave the flyout stuck open after every click.
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
  const faceActive = face?.d.variant === "active";

  // Clicking the face does what its icon promises: with a promoted activity
  // it toggles that panel directly (the flyout is a hover reveal on pointer
  // devices). Only the idle face — or any tap on a no-hover device, where the
  // flyout is the sole way to reach the activities — toggles the flyout.
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
                {/* Keyed so a promotion change pops the new face in. */}
                <span
                  key={face?.d.id ?? "activities"}
                  className="inline-flex animate-[acm-pop-in_150ms_cubic-bezier(0.22,1,0.36,1)_both]"
                >
                  <FaceIcon size={ICON} strokeWidth={STROKE} />
                </span>
                {face?.dot ? <DockStatusDot dot={face.dot} /> : null}
              </button>
              {open && (
                // pb-2 bridges the gap so hover stays continuous between the
                // face and the flyout (same trick as the leave button's menu).
                <div className="absolute bottom-full right-0 z-50 pb-2">
                  <div
                    id={trayId}
                    data-tray
                    className={popoverPanelClass + " w-44"}
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


/**
 * One-time "Watch together" nudge. It used to point at the More menu; the
 * watch app now lives in the Apps panel, so it anchors to the activity dock
 * (rendered inside the dock's relative wrapper) with the tray held open.
 */
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
          /* A living watch party: the room's real avatars orbit the
             play button (counter-rotated so faces stay upright) while
             the playhead below plays a video through, fades, and starts
             the next one, a seamless nod to the queue. Continuous by
             design; stilled for reduced-motion users. */
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
                      {/* Centered via margins, not translate: the spin
                          animation owns this element's transform. */}
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
                className="block h-full animate-[acm-watch-reel_6400ms_cubic-bezier(0.4,0.1,0.4,0.9)_infinite] motion-reduce:animate-none"
                style={{ backgroundColor: "#F95F4A", width: "6%" }}
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

// Leave button. For hosts, hovering (desktop) or long-pressing (mobile) reveals
// an "End call for everyone" action above it; a plain click still leaves solo.
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

  // If there's no host action available, fall back to a plain leave button.
  if (!onEndForEveryone) {
    return (
      <HotkeyTooltip label="Leave call" hotkey="">
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
        // pb-2 bridges the visual gap so the hover area stays continuous
        // between the button and the pill; no dead zone to cross.
        <div className="absolute bottom-full left-1/2 z-20 -translate-x-1/2 pb-2">
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
    isBrowserLaunching = false,
    onLaunchBrowser,
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
  // Settings is its own drawer, opened from a tile in the More drawer (devices,
  // flip camera, mirror).
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [browserOpen, setBrowserOpen] = useState(false);
  const [browserUrl, setBrowserUrl] = useState("");
  const [browserError, setBrowserError] = useState<string | null>(null);
  const { meetVolume, setMeetVolume } = useMeetVolume();
  const meetVolumePercent = Math.round(clampMeetVolume(meetVolume) * 100);

  // Enumerate cameras only while a compact drawer is open, to power the quick
  // front/rear flip (and to decide whether the flip action is even available).
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
  // The compact More menu uses a vaul Drawer (portaled outside moreRef + its own
  // overlay dismissal), so only the desktop popover needs click-outside handling.
  useClickOutside(moreOpen && !compact, moreRef, () => setMoreOpen(false));
  useClickOutside(browserOpen, browserRef, () => setBrowserOpen(false));

  // Rows owned by the Apps panel stay palette-searchable but are dropped from
  // the visible More menu (popover and phone drawer alike).
  const moreRows = config.overflow.filter((row) => !row.paletteOnly);

  // One-time nudge toward the backgrounds/filters tucked inside More, only
  // surfaced if that option is actually available to this participant.
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
  // One-time nudge for Watch together, only for people who can actually open
  // it (it now lives in the Apps panel, reached through the activity dock).
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

  const launchBrowser = useCallback(
    async (url: string) => {
      const normalized = normalizeBrowserUrl(url);
      if (!normalized.url) {
        setBrowserError(normalized.error ?? "Enter a valid URL.");
        return;
      }
      setBrowserError(null);
      setBrowserUrl("");
      setBrowserOpen(false);
      setMoreOpen(false);
      await onLaunchBrowser?.(normalized.url);
    },
    [onLaunchBrowser],
  );

  const showHost = Boolean(isAdmin);
  const VolumeIcon = meetVolumePercent === 0 ? VolumeX : Volume2;

  const transcriptClusterStatus: PanelStatus =
    props.transcriptStatus === "live" ||
    props.transcriptStatus === "starting" ||
    props.transcriptStatus === "paused"
      ? "live"
      : props.transcriptStatus === "takeover_needed" ||
          props.transcriptStatus === "error"
        ? "attention"
        : null;
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

  // Side-panel toggles regroup into the activity dock: people panels stay
  // always-visible, activity panels fold into one adaptive slot, and the host
  // shield anchors its own segment.
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

  // In the dock, icon tint means "my panel is open" while the dot means
  // "something is live in the room" — two signals, never conflated.
  const gamesEntry: DockEntry | null = gamesItem
    ? {
        d: { ...gamesItem, variant: props.isGamesOpen ? "active" : "default" },
        dot: props.hasActiveGame ? { color: color.accent } : null,
      }
    : null;
  const appsEntry: DockEntry | null = appsItem
    ? {
        d: { ...appsItem, variant: props.isAppsOpen ? "active" : "default" },
        dot: props.hasActiveApp ? { color: color.accent } : null,
      }
    : null;
  const transcriptEntry: DockEntry | null = transcriptItem
    ? {
        d: {
          ...transcriptItem,
          variant: props.isTranscriptOpen ? "active" : "default",
        },
        // One dot language across the dock: the lone coral accent. A pulse —
        // not a different hue — marks the needs-attention state.
        dot:
          transcriptClusterStatus === "live"
            ? { color: color.accent }
            : transcriptClusterStatus === "attention"
              ? { color: color.accent, pulse: true }
              : null,
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

  // The folded slot wears the most urgent activity's face: a transcript that
  // needs attention beats live room state, which beats a merely-open panel.
  const promotedEntry =
    (transcriptEntry?.dot?.pulse ? transcriptEntry : null) ??
    (props.hasActiveApp ? appsEntry : null) ??
    (props.hasActiveGame ? gamesEntry : null) ??
    (transcriptEntry?.dot ? transcriptEntry : null) ??
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
            badge: props.pendingUsersCount,
            onPress: onToggleHostControls,
          },
        }
      : null;
  const dockVisible =
    dockCore.length + dockActivities.length > 0 || hostEntry !== null;

  return (
    <div className="relative flex w-full items-center gap-2 px-4 py-3 sm:grid sm:grid-cols-[1fr_auto_1fr]">
      {/* Equal side columns keep the center controls truly centered; the dock
          never grows sideways (activities open as a flyout above it), so the
          columns cannot collide and the bar never shifts. */}
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
            <HotkeyTooltip label="Reactions" hotkey="">
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
              {browserOpen && onLaunchBrowser && (
                <BrowserLauncher
                  url={browserUrl}
                  error={browserError}
                  busy={isBrowserLaunching}
                  onUrlChange={(v) => {
                    setBrowserUrl(v);
                    if (browserError) setBrowserError(null);
                  }}
                  onLaunch={launchBrowser}
                />
              )}
            </div>
            </div>
          )}
          {/* Phone: present More as a full-width drag-to-dismiss bottom sheet
              (vaul, Meet-style) instead of a cramped anchored dropdown. */}
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
                      {(hasAudioDevicePicker || hasVideoDevicePicker) && (
                          <MoreTile
                            row={{
                              id: "settings",
                              icon: Settings,
                              label: "Settings",
                            }}
                            onActivate={() => {
                              setMoreOpen(false);
                              setSettingsOpen(true);
                            }}
                          />
                        )}
                    </div>
                    <MeetVolumeOverflowControl
                      icon={VolumeIcon}
                      volumePercent={meetVolumePercent}
                      onVolumePercentChange={(value) => setMeetVolume(value / 100)}
                    />
                    {browserOpen && onLaunchBrowser && (
                      <BrowserLauncher
                        url={browserUrl}
                        error={browserError}
                        busy={isBrowserLaunching}
                        onUrlChange={(v) => {
                          setBrowserUrl(v);
                          if (browserError) setBrowserError(null);
                        }}
                        onLaunch={launchBrowser}
                      />
                    )}
                  </div>
                </Drawer.Content>
              </Drawer.Portal>
            </Drawer.Root>
          )}
          {/* Settings drawer, opened from the More drawer's Settings tile. */}
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
      <div className="grid grid-cols-2 gap-1.5">
        {BROWSER_APPS.map((app) => {
          const Icon = app.icon;
          return (
            <button
              key={app.id}
              type="button"
              disabled={busy}
              onClick={() => onLaunch(app.url)}
              className="flex items-center gap-2.5 rounded-lg border p-2 text-left transition-[background-color] duration-[120ms] hover:bg-white/[0.06] disabled:opacity-40"
              style={{ borderColor: color.border }}
            >
              <span
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
                style={{ backgroundColor: color.surface, color: color.textMuted }}
              >
                <Icon size={MENU_ICON} strokeWidth={STROKE} />
              </span>
              <span className="text-[13px] font-medium" style={{ color: color.text }}>
                {app.name}
              </span>
            </button>
          );
        })}
      </div>
      <form
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          if (url.trim()) onLaunch(url);
        }}
        className="mt-2 flex gap-2"
      >
        <input
          type="text"
          value={url}
          onChange={(e) => onUrlChange(e.target.value)}
          placeholder="Paste a URL"
          className="flex-1 rounded-lg border px-3 py-2 text-[13px] focus:outline-none"
          style={{ backgroundColor: color.bg, borderColor: color.border, color: color.text }}
        />
        <button
          type="submit"
          disabled={!url.trim() || busy}
          className="rounded-lg bg-[#F95F4A] px-4 py-2 text-[13px] font-medium text-white transition-colors duration-[120ms] hover:bg-[#e8553f] active:bg-[#d34933] disabled:opacity-40"
        >
          Go
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

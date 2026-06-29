"use client";

import {
  ArrowLeft,
  MoreHorizontal,
  PhoneOff,
  Settings,
  Shield,
  Smile,
  SwitchCamera,
  Volume2,
  VolumeX,
} from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { Drawer } from "vaul";
import { ControlButton } from "@conclave/ui-tokens/web";
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

function PanelClusterItem({
  d,
  status,
}: {
  d: ControlDescriptor;
  status?: PanelStatus;
}) {
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
          "relative inline-flex h-10 w-10 items-center justify-center rounded-full " +
          "transition-[background-color,color] duration-[120ms] hover:bg-white/[0.08] " +
          (active ? "" : "hover:!text-[#fafafa]")
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
        {status ? (
          <span
            aria-hidden
            className={
              "absolute right-1 top-1 h-2 w-2 rounded-full " +
              (status === "attention" ? "animate-pulse" : "")
            }
            style={{
              backgroundColor: status === "live" ? "#32d583" : "#f97066",
              boxShadow: "0 0 0 2px #131316",
            }}
          />
        ) : null}
      </button>
    </HotkeyTooltip>
  );
}

/**
 * The side-panel toggles (participants, games, transcript, chat) collapse into
 * one overlapping "squabble" of icons to keep the bar uncrowded. Hover (or
 * keyboard focus) fans them out so any one can be picked. Badges and the
 * transcript live/paused dot stay visible even while collapsed, so the cluster
 * still surfaces unread chat and transcript state at a glance.
 */
function PanelCluster({
  items,
  transcriptStatus,
  forceOpen = false,
}: {
  items: ControlDescriptor[];
  transcriptStatus?: PanelStatus;
  forceOpen?: boolean;
}) {
  const [hovered, setHovered] = useState(false);
  const open = hovered || forceOpen;

  return (
    <div
      className="relative flex items-center rounded-full transition-colors duration-150"
      style={{ backgroundColor: open ? "rgba(255,255,255,0.04)" : "transparent" }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocusCapture={() => setHovered(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node)) {
          setHovered(false);
        }
      }}
    >
      {items.map((d, index) => {
        const status = d.id === "transcript" ? (transcriptStatus ?? null) : null;
        const raised =
          d.variant === "active" || Boolean(status) || (d.badge ?? 0) > 0;
        return (
          <div
            key={d.id}
            className="transition-[margin] duration-200 ease-out"
            style={{
              marginLeft: index === 0 ? 0 : open ? 2 : -12,
              zIndex: raised ? 20 : 10 - index,
            }}
          >
            <PanelClusterItem d={d} status={status} />
          </div>
        );
      })}
    </div>
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

function ControlsBar(props: ControlsBarProps) {
  const config = buildControlsConfig(props);
  const {
    compact = false,
    roomId,
    reactionOptions,
    onSendReaction,
    onLeave,
    isAdmin,
    isGhostMode = false,
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
    isMirrorCamera,
    onToggleMirror,
  } = props;
  const hasAudioDevicePicker = Boolean(
    onAudioInputDeviceChange || onAudioOutputDeviceChange,
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

  // One-time nudge toward the backgrounds/filters tucked inside More — only
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
    props.transcriptStatus === "live" || props.transcriptStatus === "starting"
      ? "live"
      : props.transcriptStatus === "takeover_needed" ||
          props.transcriptStatus === "error"
        ? "attention"
        : null;
  const panelCoachmarkVisible =
    !moreOpen &&
    !reactionsOpen &&
    !browserOpen &&
    !filtersTip.visible &&
    ((gamesTip.visible && !props.isGamesOpen && !props.hasActiveGame) ||
      (gifsTip.visible && !props.isChatOpen));

  // Side-panel toggles fold into one hover-to-pick cluster. Host controls join
  // it as a final item so the right rail stays a single tidy group.
  const panelItems: ControlDescriptor[] = config.left.map((d) => {
    if (d.id === "games") {
      return {
        ...d,
        onPress: () => {
          gamesTip.dismiss();
          d.onPress?.();
        },
      };
    }
    if (d.id === "chat") {
      return {
        ...d,
        onPress: () => {
          gifsTip.dismiss();
          d.onPress?.();
        },
      };
    }
    return d;
  });
  if (showHost && !compact && onToggleHostControls) {
    panelItems.push({
      id: "host-controls",
      icon: Shield,
      label: "Host controls",
      showTooltipWithoutHotkey: true,
      variant: isHostControlsOpen ? "active" : "default",
      badge: props.pendingUsersCount,
      onPress: onToggleHostControls,
    });
  }

  return (
    <div className="relative flex w-full items-center gap-2 px-4 py-3 sm:grid sm:grid-cols-[1fr_auto_1fr]">
      {/* Equal side columns keep center controls from overlapping side content
          at sm+; below that the tag is dropped and the center group grows to
          fill the row (flex-1) so the bar can't overlap itself. */}
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
                disabled={isGhostMode}
                audio={{
                  selectedAudioInputDeviceId,
                  selectedAudioOutputDeviceId,
                  onAudioInputDeviceChange,
                  onAudioOutputDeviceChange,
                }}
              />
            );
          }
          if (d.id === "camera" && hasVideoDevicePicker && !compact) {
            return (
              <MediaClusterButton
                key={d.id}
                d={d}
                disabled={isGhostMode}
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
                disabled={isGhostMode}
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
          {filtersTip.visible && !moreOpen && !reactionsOpen && !browserOpen ? (
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
              {config.overflow.map((row) => (
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
                    {!isGhostMode && (!isReactionsDisabled || isAdmin) && reactionOptions.length > 0 && (
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
                      {config.overflow.map((row) => (
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
                      {!isGhostMode && canFlipCamera && (
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
                      {!isGhostMode &&
                        (hasAudioDevicePicker || hasVideoDevicePicker) && (
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
          {/* Settings drawer — opened from the More drawer's Settings tile. */}
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
                      isMirrorCamera={isMirrorCamera}
                      onToggleMirror={onToggleMirror}
                    />
                  </div>
                </Drawer.Content>
              </Drawer.Portal>
            </Drawer.Root>
          )}
        </div>

        <HotkeyTooltip label="Leave call" hotkey="">
          <button
            type="button"
            onClick={onLeave}
            aria-label="Leave call"
            title="Leave call"
            className="ml-1 inline-flex h-12 w-[68px] items-center justify-center rounded-full bg-[#ea4335] text-white transition-colors duration-[120ms] hover:bg-[#e8533f] active:bg-[#d24a37]"
          >
            <PhoneOff size={ICON} strokeWidth={STROKE} />
          </button>
        </HotkeyTooltip>
      </div>

      <div className="flex min-w-0 shrink-0 items-center justify-self-end gap-0.5">
        {panelItems.length > 0 && (
          <div className="relative flex">
            <PanelCluster
              items={panelItems}
              transcriptStatus={transcriptClusterStatus}
              forceOpen={panelCoachmarkVisible}
            />
            {panelCoachmarkVisible && gamesTip.visible ? (
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

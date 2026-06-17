"use client";

import {
  MoreHorizontal,
  PhoneOff,
  Shield,
  Smile,
} from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { ControlButton } from "@conclave/ui-tokens/web";
import { color } from "@conclave/ui-tokens";
import { DeviceCaretMenu } from "./DeviceCaretMenu";
import type { ReactionOption } from "../lib/types";
import { normalizeBrowserUrl } from "../lib/utils";
import HotkeyTooltip from "./HotkeyTooltip";
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

function MeetingClock({ roomId }: { roomId?: string }) {
  const [time, setTime] = useState("");
  useEffect(() => {
    const fmt = () =>
      new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    setTime(fmt());
    const id = window.setInterval(() => setTime(fmt()), 15000);
    return () => window.clearInterval(id);
  }, []);
  return (
    <div className="flex items-center gap-2 text-[13px] font-medium leading-none">
      <span className="tabular-nums" style={{ color: color.text }}>
        {time}
      </span>
      {roomId ? (
        <>
          <span
            aria-hidden
            className="inline-block h-[3px] w-[3px] rounded-full"
            style={{ backgroundColor: color.textFaint }}
          />
          <span className="truncate" style={{ color: color.textMuted }}>
            {roomId}
          </span>
        </>
      ) : null}
    </div>
  );
}

function BarButton({ d, size = 48 }: { d: ControlDescriptor; size?: number }) {
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
  return d.hotkey ? (
    <HotkeyTooltip label={d.label} hotkey={d.hotkey}>
      {button}
    </HotkeyTooltip>
  ) : (
    button
  );
}

function PanelButton({ d }: { d: ControlDescriptor }) {
  const Icon = d.icon;
  const active = d.variant === "active";
  const btn = (
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
    </button>
  );
  return d.hotkey ? (
    <HotkeyTooltip label={d.label} hotkey={d.hotkey}>
      {btn}
    </HotkeyTooltip>
  ) : (
    btn
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
  const [browserOpen, setBrowserOpen] = useState(false);
  const [browserUrl, setBrowserUrl] = useState("");
  const [browserError, setBrowserError] = useState<string | null>(null);

  const reactionRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLDivElement>(null);
  const browserRef = useRef<HTMLDivElement>(null);

  useClickOutside(reactionsOpen, reactionRef, () => setReactionsOpen(false));
  useClickOutside(moreOpen, moreRef, () => setMoreOpen(false));
  useClickOutside(browserOpen, browserRef, () => setBrowserOpen(false));

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

  return (
    <div className="relative grid w-full grid-cols-[1fr_auto_1fr] items-center gap-2 px-4 py-3">
      {/* Equal side columns keep center controls from overlapping side content. */}
      <div className="flex min-w-0 items-center justify-self-start">
        <MeetingClock roomId={roomId} />
      </div>

      <div className="flex items-center justify-self-center gap-2.5">
        {config.center.map((d) => {
          if (d.id === "mic" && hasAudioDevicePicker) {
            return (
              <div key={d.id} className="flex items-center">
                <DeviceCaretMenu
                  kind="audio"
                  disabled={isGhostMode}
                  selectedAudioInputDeviceId={selectedAudioInputDeviceId}
                  selectedAudioOutputDeviceId={selectedAudioOutputDeviceId}
                  onAudioInputDeviceChange={onAudioInputDeviceChange}
                  onAudioOutputDeviceChange={onAudioOutputDeviceChange}
                />
                <BarButton d={d} />
              </div>
            );
          }
          if (d.id === "camera" && hasVideoDevicePicker) {
            return (
              <div key={d.id} className="flex items-center">
                <DeviceCaretMenu
                  kind="video"
                  disabled={isGhostMode}
                  selectedVideoInputDeviceId={selectedVideoInputDeviceId}
                  onVideoInputDeviceChange={onVideoInputDeviceChange}
                  isMirrorCamera={isMirrorCamera}
                  onToggleMirror={onToggleMirror}
                />
                <BarButton d={d} />
              </div>
            );
          }
          return <BarButton key={d.id} d={d} />;
        })}

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

        <div ref={moreRef} className="relative">
          <ControlButton
            icon={MoreHorizontal}
            variant={moreOpen ? "active" : "default"}
            size={48}
            iconSize={ICON}
            label="More options"
            onClick={() => setMoreOpen((v) => !v)}
          />
          {moreOpen && (
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

      <div className="flex min-w-0 items-center justify-self-end gap-0.5">
        {config.left.map((d) => (
          <PanelButton key={d.id} d={d} />
        ))}

        {showHost && onToggleHostControls && (
          <button
            type="button"
            onClick={onToggleHostControls}
            aria-label="Host controls"
            aria-pressed={isHostControlsOpen}
            title="Host controls"
            className={
              "inline-flex h-10 w-10 items-center justify-center rounded-full " +
              "transition-[background-color,color] duration-[120ms] hover:bg-white/[0.08] " +
              (isHostControlsOpen ? "" : "hover:!text-[#fafafa]")
            }
            style={{ color: isHostControlsOpen ? color.accent : color.textMuted }}
          >
            <Shield size={ICON} strokeWidth={STROKE} />
          </button>
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
    </button>
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

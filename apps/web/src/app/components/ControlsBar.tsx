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
import type { ReactionOption } from "../lib/types";
import { normalizeBrowserUrl } from "../lib/utils";
import HotkeyTooltip from "./HotkeyTooltip";
import MeetSettingsPanel from "./MeetSettingsPanel";
import {
  BROWSER_APPS,
  buildControlsConfig,
  type ControlDescriptor,
  type ControlsBarProps,
  type OverflowRow,
} from "./controls-config";

export type { ControlsBarProps } from "./controls-config";

/**
 * Single icon convention so the whole bar reads consistent.
 * Control bar = 20px; popover/menu rows = 18px; always strokeWidth 1.75.
 */
const ICON = 20;
const MENU_ICON = 18;
const STROKE = 1.75;

/** Bottom-left: current time + meeting code (Google Meet pattern). */
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

/** Circular control (center cluster), optionally with a hotkey tooltip. */
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

/** Right-side panel toggle: plain icon button, muted -> white on hover. */
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

const popoverClass = "absolute bottom-full mb-3 z-50 rounded-2xl border p-1.5";

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
  } = props;

  const [reactionsOpen, setReactionsOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [browserOpen, setBrowserOpen] = useState(false);
  const [hostOpen, setHostOpen] = useState(false);
  const [browserUrl, setBrowserUrl] = useState("");
  const [browserError, setBrowserError] = useState<string | null>(null);

  const reactionRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLDivElement>(null);
  const browserRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);

  useClickOutside(reactionsOpen, reactionRef, () => setReactionsOpen(false));
  useClickOutside(moreOpen, moreRef, () => setMoreOpen(false));
  useClickOutside(browserOpen, browserRef, () => setBrowserOpen(false));
  useClickOutside(hostOpen, hostRef, () => setHostOpen(false));

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
    <div className="relative flex w-full items-center px-4 py-3">
      {/* LEFT — time + meeting code */}
      <div className="flex min-w-0 items-center">
        <MeetingClock roomId={roomId} />
      </div>

      {/* CENTER — core call controls (absolutely centered, Meet-style) */}
      <div className="absolute left-1/2 flex -translate-x-1/2 items-center gap-2.5">
        {config.center.map((d) => (
          <BarButton key={d.id} d={d} />
        ))}

        {/* Reactions */}
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
            <div
              className={popoverClass + " left-1/2 flex -translate-x-1/2 items-center gap-1"}
              style={{ backgroundColor: color.surfaceRaised, borderColor: color.border }}
            >
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
          )}
        </div>

        {/* More / overflow */}
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
              className={popoverClass + " left-1/2 w-60 -translate-x-1/2"}
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
          )}
        </div>

        {/* Leave — red hangup pill */}
        <HotkeyTooltip label="Leave call" hotkey="">
          <button
            type="button"
            onClick={onLeave}
            aria-label="Leave call"
            title="Leave call"
            className="ml-1 inline-flex h-12 w-[68px] items-center justify-center rounded-full transition-[filter] duration-[120ms] hover:brightness-110 active:brightness-95"
            style={{ backgroundColor: color.danger, color: "#ffffff" }}
          >
            <PhoneOff size={ICON} strokeWidth={STROKE} />
          </button>
        </HotkeyTooltip>
      </div>

      {/* RIGHT — panels + session */}
      <div className="ml-auto flex items-center gap-0.5">
        {config.left.map((d) => (
          <PanelButton key={d.id} d={d} />
        ))}

        {showHost && (
          <div ref={hostRef} className="relative">
            <button
              type="button"
              onClick={() => setHostOpen((v) => !v)}
              aria-label="Host controls"
              title="Host controls"
              className={
                "inline-flex h-10 w-10 items-center justify-center rounded-full " +
                "transition-[background-color,color] duration-[120ms] hover:bg-white/[0.08] " +
                (hostOpen ? "" : "hover:!text-[#fafafa]")
              }
              style={{ color: hostOpen ? color.accent : color.textMuted }}
            >
              <Shield size={ICON} strokeWidth={STROKE} />
            </button>
            {hostOpen && (
              <MeetSettingsPanel
                isRoomLocked={props.isRoomLocked ?? false}
                onToggleLock={props.onToggleLock}
                isNoGuests={props.isNoGuests ?? false}
                onToggleNoGuests={props.onToggleNoGuests}
                isChatLocked={props.isChatLocked ?? false}
                onToggleChatLock={props.onToggleChatLock}
                isTtsDisabled={props.isTtsDisabled ?? false}
                onToggleTtsDisabled={props.onToggleTtsDisabled}
                isDmEnabled={props.isDmEnabled ?? true}
                onToggleDmEnabled={props.onToggleDmEnabled}
                meetingRequiresInviteCode={props.meetingRequiresInviteCode ?? false}
                onGetMeetingConfig={props.onGetMeetingConfig}
                onUpdateMeetingConfig={props.onUpdateMeetingConfig}
                webinarConfig={props.webinarConfig}
                webinarRole={props.webinarRole}
                webinarLink={props.webinarLink}
                onSetWebinarLink={props.onSetWebinarLink}
                onGetWebinarConfig={props.onGetWebinarConfig}
                onUpdateWebinarConfig={props.onUpdateWebinarConfig}
                onGenerateWebinarLink={props.onGenerateWebinarLink}
                onRotateWebinarLink={props.onRotateWebinarLink}
                onClose={() => setHostOpen(false)}
              />
            )}
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
          className="rounded-lg px-4 py-2 text-[13px] font-medium text-white transition-[filter] duration-[120ms] hover:brightness-110 disabled:opacity-40"
          style={{ backgroundColor: color.accent }}
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

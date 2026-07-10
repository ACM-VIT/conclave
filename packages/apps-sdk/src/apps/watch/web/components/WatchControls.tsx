import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { PlaybackState } from "../../core/model/types";
import type { WatchCaptionTrack } from "../hooks/useSyncedPlayback";
import { formatTime } from "../format";

type WatchControlsProps = {
  playbackState: PlaybackState;
  currentTime: number;
  duration: number;
  isLive: boolean;
  isAtLiveEdge: boolean;
  muted: boolean;
  volume: number;
  readOnly: boolean;
  /** Cinema (expanded) view; a local preference, available to everyone. */
  cinema: boolean;
  onToggleCinema: () => void;
  /** Closed captions; a local preference, available to everyone. */
  captionsAvailable: boolean;
  captionsOn: boolean;
  captionTracks: WatchCaptionTrack[];
  captionSizeAvailable: boolean;
  captionFontSize: number;
  onSetCaptionTrack: (language: string | null) => void;
  onSetCaptionFontSize: (size: number) => void;
  onPlay: () => void;
  onPause: () => void;
  onSeek: (seconds: number) => void;
  onGoLive: () => void;
  onToggleMute: () => void;
  onVolumeChange: (value: number) => void;
};

/**
 * Slim control bar under the player. Custom flat chrome: a play/pause toggle, a
 * flat seek bar, current/total time in tabular nums, and a LOCAL-ONLY mute and
 * volume control (volume never syncs to the doc).
 */
export function WatchControls({
  playbackState,
  currentTime,
  duration,
  isLive,
  isAtLiveEdge,
  muted,
  volume,
  readOnly,
  cinema,
  onToggleCinema,
  captionsAvailable,
  captionsOn,
  captionTracks,
  captionSizeAvailable,
  captionFontSize,
  onSetCaptionTrack,
  onSetCaptionFontSize,
  onPlay,
  onPause,
  onSeek,
  onGoLive,
  onToggleMute,
  onVolumeChange,
}: WatchControlsProps) {
  // While dragging the seek bar, show the dragged value locally and only commit
  // on release, so the reconcile tick does not fight the drag.
  const [scrubValue, setScrubValue] = useState<number | null>(null);
  const isPlaying = playbackState === "playing";
  const max = duration > 0 ? duration : 0;
  const displayTime = scrubValue ?? currentTime;
  const clampedDisplay = max > 0 ? Math.min(displayTime, max) : displayTime;
  const liveDelay = Math.max(0, max - clampedDisplay);

  return (
    <div className="flex items-center gap-2.5 py-2 pl-2.5 pr-2">
      <button
        type="button"
        onClick={isPlaying ? onPause : onPlay}
        disabled={readOnly}
        aria-label={isPlaying ? "Pause" : "Play"}
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-white transition-opacity hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
        style={{ backgroundColor: readOnly ? "#26262d" : "#F95F4A" }}
      >
        {isPlaying ? (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <rect x="6" y="5" width="4" height="14" rx="1" />
            <rect x="14" y="5" width="4" height="14" rx="1" />
          </svg>
        ) : (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" style={{ marginLeft: 1.5 }}>
            <polygon points="7 4 20 12 7 20 7 4" />
          </svg>
        )}
      </button>

      <span className="w-10 shrink-0 text-right text-[11px] tabular-nums text-[#e4e4e7]">
        {isLive
          ? isAtLiveEdge && scrubValue === null
            ? "Live"
            : `-${formatTime(liveDelay)}`
          : formatTime(clampedDisplay)}
      </span>

      <Slider
        className="min-w-0 flex-1"
        value={max > 0 ? clampedDisplay : 0}
        max={max || 100}
        step={0.1}
        disabled={readOnly || max <= 0}
        dragging={scrubValue != null}
        tone="accent"
        ariaLabel="Seek"
        onInput={(next) => setScrubValue(next)}
        onCommit={(next) => {
          setScrubValue(null);
          onSeek(next);
        }}
      />

      {isLive ? (
        <button
          type="button"
          onClick={onGoLive}
          disabled={readOnly || isAtLiveEdge}
          aria-label={isAtLiveEdge ? "At live edge" : "Go to live edge"}
          className={`inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-[10px] font-semibold uppercase tracking-[0.08em] transition-colors ${
            isAtLiveEdge
              ? "cursor-default border-[#F95F4A]/35 bg-[#F95F4A]/10 text-[#ff8a78]"
              : "cursor-pointer border-white/10 text-[#e4e4e7] hover:border-[#F95F4A]/35 hover:bg-[#F95F4A]/10 hover:text-[#ff8a78] disabled:cursor-not-allowed disabled:opacity-45"
          }`}
        >
          <span
            className="h-1.5 w-1.5 rounded-full"
            style={{ backgroundColor: "#F95F4A" }}
          />
          {isAtLiveEdge ? "Live" : "Go live"}
        </button>
      ) : (
        <span className="w-9 shrink-0 text-[11px] tabular-nums text-[#71717a]">
          {formatTime(max)}
        </span>
      )}

      <div className="group/vol flex shrink-0 items-center">
        <button
          type="button"
          onClick={onToggleMute}
          aria-label={muted ? "Unmute" : "Mute"}
          className="flex h-8 w-8 items-center justify-center rounded-full text-[#c4c4cc] transition-colors hover:text-white cursor-pointer"
        >
          {muted || volume === 0 ? (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor" stroke="none" />
              <line x1="23" y1="9" x2="17" y2="15" />
              <line x1="17" y1="9" x2="23" y2="15" />
            </svg>
          ) : (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor" stroke="none" />
              <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
              <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
            </svg>
          )}
        </button>
        {/* Volume rail tucks away and slides out on hover or keyboard focus,
            so the seek bar stays the only accent line at rest. */}
        <div className="hidden w-0 overflow-hidden transition-all duration-200 group-focus-within/vol:w-16 group-hover/vol:w-16 sm:block">
          <Slider
            className="w-16 pl-1 pr-1.5"
            value={muted ? 0 : volume}
            max={100}
            step={1}
            disabled={false}
            dragging={false}
            tone="neutral"
            ariaLabel="Volume"
            onInput={(next) => onVolumeChange(next)}
            onCommit={(next) => onVolumeChange(next)}
          />
        </div>
        {captionsAvailable ? (
          <CaptionSettings
            captionsOn={captionsOn}
            tracks={captionTracks}
            sizeAvailable={captionSizeAvailable}
            fontSize={captionFontSize}
            onSetTrack={onSetCaptionTrack}
            onSetFontSize={onSetCaptionFontSize}
          />
        ) : null}
        <button
          type="button"
          onClick={onToggleCinema}
          aria-label={cinema ? "Exit cinema view" : "Cinema view"}
          aria-pressed={cinema}
          title={cinema ? "Exit cinema view" : "Cinema view"}
          className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg text-[#c4c4cc] transition-colors hover:text-white"
        >
          {cinema ? (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="4 14 10 14 10 20" />
              <polyline points="20 10 14 10 14 4" />
              <line x1="14" y1="10" x2="21" y2="3" />
              <line x1="3" y1="21" x2="10" y2="14" />
            </svg>
          ) : (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="15 3 21 3 21 9" />
              <polyline points="9 21 3 21 3 15" />
              <line x1="21" y1="3" x2="14" y2="10" />
              <line x1="3" y1="21" x2="10" y2="14" />
            </svg>
          )}
        </button>
      </div>
    </div>
  );
}

const CAPTION_SIZES: Array<{ label: string; value: number }> = [
  { label: "Small", value: -1 },
  { label: "Default", value: 0 },
  { label: "Large", value: 2 },
  { label: "Huge", value: 3 },
];

/**
 * The one captions control: the CC button opens a small popover with Off, the
 * language tracks, and size. Fixed-positioned from the button's rect (above
 * the bar) so nothing can clip it, closing on outside click, scroll, or
 * resize. All local.
 */
function CaptionSettings({
  captionsOn,
  tracks,
  sizeAvailable,
  fontSize,
  onSetTrack,
  onSetFontSize,
}: {
  captionsOn: boolean;
  tracks: WatchCaptionTrack[];
  sizeAvailable: boolean;
  fontSize: number;
  onSetTrack: (language: string | null) => void;
  onSetFontSize: (size: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ bottom: number; right: number } | null>(
    null,
  );
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        !popoverRef.current?.contains(target) &&
        !buttonRef.current?.contains(target)
      ) {
        setOpen(false);
      }
    };
    const onScrollOrResize = () => setOpen(false);
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("resize", onScrollOrResize);
    window.addEventListener("scroll", onScrollOrResize, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("resize", onScrollOrResize);
      window.removeEventListener("scroll", onScrollOrResize, true);
    };
  }, [open]);

  const anyActive = tracks.some((track) => track.active);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => {
          const rect = buttonRef.current?.getBoundingClientRect();
          if (rect) {
            setAnchor({
              bottom: window.innerHeight - rect.top + 8,
              right: Math.max(8, window.innerWidth - rect.right),
            });
          }
          setOpen((prev) => !prev);
        }}
        aria-label="Captions"
        aria-expanded={open}
        aria-pressed={captionsOn}
        title="Captions"
        className={`flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg transition-colors ${
          captionsOn || open
            ? "bg-white/[0.12] text-white"
            : "text-[#c4c4cc] hover:text-white"
        }`}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="3" y="5" width="18" height="14" rx="2.5" />
          <path d="M10.5 10.2a2.2 2.2 0 0 0-3.6 1.8 2.2 2.2 0 0 0 3.6 1.8" />
          <path d="M17 10.2a2.2 2.2 0 0 0-3.6 1.8 2.2 2.2 0 0 0 3.6 1.8" />
        </svg>
      </button>

      {open && anchor
        ? /* Portaled to body: the control bar's transform and backdrop-filter
             make it the containing block for fixed descendants, which would
             trap this popover inside the bar's overflow clipping. */
          createPortal(
        <div
          ref={popoverRef}
          className="w-44 rounded-xl border border-white/10 p-1"
          style={{
            position: "fixed",
            bottom: anchor.bottom,
            right: anchor.right,
            zIndex: 70,
            backgroundColor: "#18181b",
            fontFamily: "'PolySans Trial', sans-serif",
          }}
        >
          <p className="px-2 pb-0.5 pt-1 text-[10px] font-medium text-[#71717a]">
            Captions
          </p>
          <SettingsRow
            label="Off"
            active={!anyActive}
            onSelect={() => onSetTrack(null)}
          />
          {tracks.map((track) => (
            <SettingsRow
              key={track.language}
              label={track.label}
              active={track.active}
              onSelect={() => onSetTrack(track.language)}
            />
          ))}
          {sizeAvailable ? (
            <>
              <p className="px-2 pb-0.5 pt-1.5 text-[10px] font-medium text-[#71717a]">
                Size
              </p>
              <div className="mx-1 mb-1 flex items-center rounded-lg border border-white/[0.08] p-0.5">
                {CAPTION_SIZES.map((size) => (
                  <button
                    key={size.value}
                    type="button"
                    onClick={() => onSetFontSize(size.value)}
                    aria-pressed={fontSize === size.value}
                    className={`h-5.5 min-w-0 flex-1 cursor-pointer truncate rounded-md px-1 py-0.5 text-[10px] font-medium transition-colors ${
                      fontSize === size.value
                        ? "text-white"
                        : "text-[#71717a] hover:text-[#fafafa]"
                    }`}
                    style={
                      fontSize === size.value
                        ? { backgroundColor: "#F95F4A" }
                        : undefined
                    }
                  >
                    {size.label}
                  </button>
                ))}
              </div>
            </>
          ) : null}
        </div>,
            document.body,
          )
        : null}
    </>
  );
}

function SettingsRow({
  label,
  active,
  onSelect,
}: {
  label: string;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`flex w-full cursor-pointer items-center justify-between gap-2 rounded-lg px-2 py-1 text-left text-[11.5px] transition-colors ${
        active
          ? "bg-white/[0.07] font-medium text-[#fafafa]"
          : "text-[#a1a1aa] hover:bg-white/[0.04] hover:text-[#fafafa]"
      }`}
    >
      <span className="truncate">{label}</span>
      {active ? (
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#F95F4A" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      ) : null}
    </button>
  );
}

type SliderProps = {
  value: number;
  max: number;
  step: number;
  disabled: boolean;
  /** Keeps the thumb visible while the user is scrubbing. */
  dragging: boolean;
  /** Accent (coral) for the seek bar, neutral (white) for volume. */
  tone: "accent" | "neutral";
  ariaLabel: string;
  className?: string;
  onInput: (value: number) => void;
  onCommit: (value: number) => void;
};

/**
 * Flat slider: a hairline rail with a solid fill and a thumb that appears on
 * hover or while dragging, driven by a transparent native range input on top
 * for accessibility and pointer handling. No gradients: the fill is a
 * plain-colored block sized by percentage.
 */
function Slider({
  value,
  max,
  step,
  disabled,
  dragging,
  tone,
  ariaLabel,
  className,
  onInput,
  onCommit,
}: SliderProps) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  const fillColor = disabled
    ? "#5a5a62"
    : tone === "accent"
      ? "#F95F4A"
      : "#d4d4d8";

  const commit = (event: React.SyntheticEvent<HTMLInputElement>) => {
    onCommit(Number(event.currentTarget.value));
  };

  return (
    <div className={`group relative flex h-4 items-center ${className ?? ""}`}>
      {/* rail: hairline at rest, a touch taller under the pointer */}
      <div
        className="absolute left-0 right-0 h-[3px] rounded-full transition-all group-hover:h-1"
        style={{ backgroundColor: "#33333b" }}
      />
      {/* fill (flat solid, sized by percentage) */}
      <div
        className="absolute left-0 h-[3px] rounded-full transition-all group-hover:h-1"
        style={{ width: `${pct}%`, backgroundColor: fillColor }}
      />
      {/* thumb: revealed on hover or while scrubbing. Its travel is clamped
          to the rail (0 to 100% minus its own width) so it never clips at
          either end. */}
      <div
        className={`pointer-events-none absolute h-2.5 w-2.5 rounded-full transition-opacity ${
          dragging ? "opacity-100" : "opacity-0 group-hover:opacity-100"
        }`}
        style={{
          left: `calc(${pct} * (100% - 10px) / 100)`,
          backgroundColor: disabled ? "#6b6b72" : "#ffffff",
        }}
      />
      {/* transparent native input drives interaction + a11y */}
      <input
        type="range"
        min={0}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-label={ariaLabel}
        onChange={(event) => onInput(Number(event.currentTarget.value))}
        onMouseUp={commit}
        onTouchEnd={commit}
        onKeyUp={commit}
        className="absolute inset-0 m-0 w-full cursor-pointer appearance-none bg-transparent opacity-0 disabled:cursor-not-allowed"
      />
    </div>
  );
}

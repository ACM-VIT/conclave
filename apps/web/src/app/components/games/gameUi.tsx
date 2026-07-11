"use client";

import React, { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { color, radius } from "@conclave/ui-tokens";
import type { GameMoveResult, GamePlayer } from "@conclave/apps-sdk";
import { accentFor, nameFor } from "./covers";

export const HEAD_FONT = "'PolySans Trial', sans-serif";
export const GAME_DOCK_DEFAULT_WIDTH = 360;
export const GAME_DOCK_MIN_WIDTH = 320;
export const GAME_DOCK_MAX_WIDTH = 560;
export const GAME_DOCK_PANEL_CLASS =
  "safe-area-pt safe-area-pb fixed right-0 top-0 bottom-0 z-40 flex w-full sm:w-[360px] flex-col border-l border-white/10 bg-[#18181b] animate-[meet-panel-in_280ms_cubic-bezier(0.22,1,0.36,1)]";
export const GAME_DOCK_HEADER_CLASS =
  "flex shrink-0 items-center justify-between border-b border-white/10 px-4 py-3";
export const GAME_DOCK_TITLE_CLASS =
  "min-w-0 truncate text-[15px] font-semibold text-[#fafafa]";

const clampDockWidth = (width: number, minWidth: number, maxWidth: number) =>
  Math.min(Math.max(width, minWidth), maxWidth);

export function GameDockResizeHandle({
  width,
  minWidth = GAME_DOCK_MIN_WIDTH,
  maxWidth = GAME_DOCK_MAX_WIDTH,
  onWidthChange,
}: {
  width?: number;
  minWidth?: number;
  maxWidth?: number;
  onWidthChange?: (width: number) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const cleanupRef = useRef<(() => void) | null>(null);
  const frameRef = useRef<number | null>(null);
  const pendingWidthRef = useRef(width ?? GAME_DOCK_DEFAULT_WIDTH);
  const panelRef = useRef<HTMLElement | null>(null);

  useEffect(
    () => () => {
      cleanupRef.current?.();
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
      }
    },
    [],
  );

  if (!onWidthChange || typeof width !== "number") return null;

  const previewWidth = (nextWidth: number) => {
    pendingWidthRef.current = nextWidth;
    if (frameRef.current !== null) return;
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null;
      if (panelRef.current) {
        panelRef.current.style.width = `${pendingWidthRef.current}px`;
      }
    });
  };

  const flushPreview = () => {
    if (frameRef.current !== null) {
      window.cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    if (panelRef.current) {
      panelRef.current.style.width = `${pendingWidthRef.current}px`;
    }
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    panelRef.current = event.currentTarget.parentElement;
    const startX = event.clientX;
    const startWidth = width;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    let finishDrag: (() => void) | null = null;
    let cancelDrag: (() => void) | null = null;

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const delta = startX - moveEvent.clientX;
      previewWidth(clampDockWidth(startWidth + delta, minWidth, maxWidth));
    };

    const stopDrag = (commit: boolean) => {
      document.removeEventListener("pointermove", handlePointerMove);
      if (finishDrag) document.removeEventListener("pointerup", finishDrag);
      if (cancelDrag) document.removeEventListener("pointercancel", cancelDrag);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      cleanupRef.current = null;
      if (commit) {
        setDragging(false);
        flushPreview();
        onWidthChange(pendingWidthRef.current);
      }
    };
    finishDrag = () => stopDrag(true);
    cancelDrag = () => stopDrag(true);

    cleanupRef.current?.();
    cleanupRef.current = () => stopDrag(false);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    setDragging(true);
    document.addEventListener("pointermove", handlePointerMove);
    document.addEventListener("pointerup", finishDrag);
    document.addEventListener("pointercancel", cancelDrag);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 40 : 16;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      onWidthChange(clampDockWidth(width + step, minWidth, maxWidth));
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      onWidthChange(clampDockWidth(width - step, minWidth, maxWidth));
    }
    if (event.key === "Home") {
      event.preventDefault();
      onWidthChange(minWidth);
    }
    if (event.key === "End") {
      event.preventDefault();
      onWidthChange(maxWidth);
    }
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize games panel"
      aria-valuemin={minWidth}
      aria-valuemax={maxWidth}
      aria-valuenow={Math.round(width)}
      tabIndex={0}
      onPointerDown={handlePointerDown}
      onKeyDown={handleKeyDown}
      className={`absolute bottom-0 left-0 top-0 z-10 w-3 -translate-x-1/2 cursor-col-resize touch-none outline-none transition-colors before:absolute before:bottom-3 before:left-1/2 before:top-3 before:w-px before:-translate-x-1/2 before:rounded-full before:bg-white/10 before:transition-colors hover:before:bg-white/25 focus-visible:before:bg-white/35 ${
        dragging ? "before:bg-white/35" : ""
      }`}
    />
  );
}

export function GameDockCloseButton({
  onClose,
  label = "Close games",
}: {
  onClose: () => void;
  label?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClose}
      aria-label={label}
      title={label}
      className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-[#a1a1aa] transition-colors hover:bg-white/[0.06] hover:text-[#fafafa]"
    >
      <X size={18} strokeWidth={1.75} />
    </button>
  );
}

/** Shared props every game renderer receives from the dock. */
export type GameViewProps<Pub = unknown, Me = unknown> = {
  pub: Pub;
  me: Me;
  players: GamePlayer[];
  isAdmin: boolean;
  readOnly?: boolean;
  userId: string | null;
  hostId: string | null;
  phase: string;
  move: (type: string, payload?: unknown) => Promise<GameMoveResult>;
};

/**
 * Counts down to a server deadline. `deadline` and `serverNow` are server-clock
 * timestamps; we anchor to local time at the moment they arrive so clock skew
 * between client and server never matters.
 */
export const useRemaining = (
  deadline: number | null | undefined,
  serverNow: number | null | undefined,
): number => {
  const [remaining, setRemaining] = useState(0);
  const baseRef = useRef({ deadline, serverNow, at: Date.now() });

  useEffect(() => {
    baseRef.current = { deadline, serverNow, at: Date.now() };
  }, [deadline, serverNow]);

  useEffect(() => {
    if (deadline == null || serverNow == null) {
      setRemaining(0);
      return;
    }
    const tick = () => {
      const base = baseRef.current;
      if (base.deadline == null || base.serverNow == null) {
        setRemaining(0);
        return;
      }
      const elapsed = Date.now() - base.at;
      setRemaining(Math.max(0, base.deadline - base.serverNow - elapsed));
    };
    tick();
    const id = window.setInterval(tick, 200);
    return () => window.clearInterval(id);
  }, [deadline, serverNow]);

  return remaining;
};

const initialsOf = (name: string): string =>
  name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("") || "?";

export function PrimaryButton({
  children,
  onClick,
  disabled,
  tone = "accent",
  full,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  tone?: "accent" | "neutral";
  full?: boolean;
}) {
  const bg = tone === "accent" ? color.accent : color.surfaceRaised;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        width: full ? "100%" : undefined,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        padding: "10px 18px",
        borderRadius: radius.pill,
        border: "none",
        background: disabled ? color.surfaceRaised : bg,
        color: color.text,
        fontFamily: HEAD_FONT,
        fontSize: 14,
        fontWeight: 500,
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.5 : 1,
        transition: "transform 120ms ease, opacity 120ms ease",
      }}
      onMouseDown={(e) => {
        if (!disabled) e.currentTarget.style.transform = "scale(0.97)";
      }}
      onMouseUp={(e) => {
        e.currentTarget.style.transform = "scale(1)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.transform = "scale(1)";
      }}
    >
      {children}
    </button>
  );
}

export function GhostButton({
  children,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: "8px 14px",
        borderRadius: radius.pill,
        border: `1px solid ${color.border}`,
        background: "transparent",
        color: color.textMuted,
        fontFamily: HEAD_FONT,
        fontSize: 13,
        fontWeight: 500,
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {children}
    </button>
  );
}

export function Avatar({
  name,
  size = 34,
  highlight,
  dim,
}: {
  name: string;
  size?: number;
  highlight?: boolean;
  dim?: boolean;
}) {
  return (
    <div
      title={name}
      style={{
        width: size,
        height: size,
        borderRadius: radius.pill,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: highlight ? color.accentSoft : color.surfaceRaised,
        border: `1.5px solid ${highlight ? color.accent : color.border}`,
        color: color.text,
        fontFamily: HEAD_FONT,
        fontSize: size * 0.36,
        fontWeight: 500,
        opacity: dim ? 0.4 : 1,
        flexShrink: 0,
      }}
    >
      {initialsOf(name)}
    </div>
  );
}

/** Pure SVG ring countdown with a number in the middle. */
export function CountdownRing({
  remainingMs,
  totalMs,
  label,
}: {
  remainingMs: number;
  totalMs: number;
  label?: string;
}) {
  const seconds = Math.ceil(remainingMs / 1000);
  const ratio = totalMs > 0 ? Math.max(0, Math.min(1, remainingMs / totalMs)) : 0;
  const r = 34;
  const circ = 2 * Math.PI * r;
  const urgent = remainingMs <= 5000;
  return (
    <div style={{ position: "relative", width: 84, height: 84, flexShrink: 0 }}>
      <svg width={84} height={84} viewBox="0 0 84 84">
        <circle cx={42} cy={42} r={r} fill="none" stroke={color.border} strokeWidth={6} />
        <circle
          cx={42}
          cy={42}
          r={r}
          fill="none"
          stroke={urgent ? color.danger : color.accent}
          strokeWidth={6}
          strokeLinecap="round"
          strokeDasharray={circ}
          strokeDashoffset={circ * (1 - ratio)}
          transform="rotate(-90 42 42)"
          style={{ transition: "stroke-dashoffset 200ms linear" }}
        />
      </svg>
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: HEAD_FONT,
          color: color.text,
        }}
      >
        <span style={{ fontSize: 26, fontWeight: 500, lineHeight: 1 }}>{seconds}</span>
        {label ? (
          <span style={{ fontSize: 10, color: color.textFaint, marginTop: 2 }}>{label}</span>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Party-game lobby: a calm "stage" composition. A soft accent spotlight sits
 * behind a centred game name + title + blurb, with the start (host) or a warm
 * "you're in" state (everyone else) below, so the screen feels good no matter
 * who is looking at it. No artwork, no pills, no pulsing dots, no all-caps.
 */
export function GameLobby({
  gameId,
  title,
  blurb,
  players,
  isAdmin,
  readOnly = false,
  canStart = true,
  startLabel = "Start",
  disabledLabel,
  onStart,
  waitingText = "The host will start the round",
}: {
  gameId?: string;
  title: string;
  blurb: string;
  players: GamePlayer[];
  isAdmin: boolean;
  userId?: string | null;
  readOnly?: boolean;
  canStart?: boolean;
  startLabel?: string;
  disabledLabel?: string;
  onStart: () => void;
  waitingText?: string;
}) {
  const accent = accentFor(gameId);
  const name = nameFor(gameId) ?? "Game";
  const count = `${players.length} ${players.length === 1 ? "player" : "players"} in the lobby`;
  return (
    <div
      style={{
        position: "relative",
        overflow: "hidden",
        height: "100%",
        minHeight: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        padding: "16px 6px",
      }}
    >
      {/* soft accent spotlight */}
      <div
        style={{
          position: "absolute",
          top: "10%",
          left: "50%",
          width: 320,
          height: 320,
          transform: "translateX(-50%)",
          borderRadius: "50%",
          background: accent,
          opacity: 0.18,
          filter: "blur(72px)",
          pointerEvents: "none",
        }}
      />
      <div style={{ position: "relative", zIndex: 1, display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center" }}>
        <span style={{ fontFamily: HEAD_FONT, fontSize: 13, fontWeight: 500, color: accent, margin: 0 }}>{name}</span>
        <p style={{ fontFamily: HEAD_FONT, fontSize: 30, fontWeight: 500, color: color.text, margin: "10px 0 0", lineHeight: 1.12, maxWidth: 300 }}>
          {title}
        </p>
        <p style={{ fontSize: 13.5, color: color.textMuted, margin: "12px 0 0", maxWidth: 290, lineHeight: 1.55 }}>
          {blurb}
        </p>

        <div style={{ width: "100%", maxWidth: 300, marginTop: 26 }}>
          {isAdmin && !readOnly ? (
            <PrimaryButton full disabled={!canStart} onClick={onStart}>
              {canStart ? startLabel : disabledLabel ?? startLabel}
            </PrimaryButton>
          ) : (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 9,
                padding: "13px 16px",
                borderRadius: radius.pill,
                background: color.surfaceRaised,
                border: `1px solid ${color.border}`,
              }}
            >
              <span style={{ width: 7, height: 7, borderRadius: radius.pill, background: accent }} />
              <span style={{ fontSize: 13, color: color.text }}>
                {readOnly ? "Watching" : "You're in"}
              </span>
              <span style={{ fontSize: 13, color: color.textMuted }}>
                · {readOnly ? "observer mode" : waitingText}
              </span>
            </div>
          )}
          <p style={{ fontSize: 12, color: color.textFaint, margin: "12px 0 0" }}>{count}</p>
        </div>
      </div>
    </div>
  );
}

/**
 * Live leaderboard shown in the game dock for scoring games. Static and clean,
 * sorted by score, with the local player highlighted. No animation.
 */
export function Leaderboard({
  rows,
  userId,
  max = 6,
  title = "Leaderboard",
}: {
  rows: { id: string; name: string; score: number }[];
  userId?: string | null;
  max?: number;
  title?: string;
}) {
  const sorted = [...rows].sort((a, b) => b.score - a.score).slice(0, max);
  if (sorted.length === 0) return null;
  return (
    <div style={{ marginTop: 18, paddingTop: 14, borderTop: `1px solid ${color.border}` }}>
      <p style={{ fontSize: 11, color: color.textFaint, fontFamily: HEAD_FONT, margin: "0 0 8px" }}>{title}</p>
      <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
        {sorted.map((r, i) => {
          const you = r.id === userId;
          return (
            <div
              key={r.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "7px 10px",
                borderRadius: radius.sm,
                background: you ? color.accentSoft : "transparent",
              }}
            >
              <span style={{ width: 16, fontSize: 12, color: i === 0 ? color.accent : color.textFaint, fontFamily: HEAD_FONT, fontWeight: 500 }}>
                {i + 1}
              </span>
              <span style={{ flex: 1, minWidth: 0, fontSize: 13.5, color: color.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {r.name}
                {you ? " (you)" : ""}
              </span>
              <span style={{ fontSize: 13, fontFamily: HEAD_FONT, fontWeight: 500, color: color.text }}>{r.score}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

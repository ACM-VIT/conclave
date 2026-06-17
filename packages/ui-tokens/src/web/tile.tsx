"use client";
import React from "react";
import { Facehash } from "facehash";
import { MicOff } from "lucide-react";
import { color } from "../tokens";

const FACEHASH_COLORS = [
  "#F95F4A",
  "#FF007A",
  "#7C5CFF",
  "#2DA8A8",
  "#4F86F7",
  "#3FA66A",
  "#F59E0B",
  "#14B8A6",
  "#E879F9",
  "#38BDF8",
] as const;

/* -------------------------------------------------------------------- Tile ---
 * Flat video-tile frame. Active speaker = a 2px solid accent border (NO glow,
 * NO shadow). The border is always 2px wide so the layout never shifts. */
export interface TileProps {
  speaking?: boolean;
  children?: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}

export function Tile({ speaking = false, children, className = "", style }: TileProps) {
  return (
    <div
      className={"relative overflow-hidden rounded-tile " + className}
      style={{
        backgroundColor: color.bgAlt,
        border: `2px solid ${speaking ? color.speaking : "rgba(250, 250, 250,0.08)"}`,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------ Avatar ---
 * Deterministic Facehash avatar. Seed includes the stable id when available. */
export interface AvatarProps {
  name: string;
  /** Stable id for face hashing (falls back to name). */
  id?: string;
  size?: number | string;
  className?: string;
}

export function Avatar({ name, id, size = 64, className = "" }: AvatarProps) {
  const trimmedName = name.trim();
  const faceName = trimmedName || id?.trim() || "?";
  const seed = id?.trim() ? `${faceName}:${id.trim()}` : faceName;
  const hash = avatarHash(seed);
  const mouthVariant = hash % 4;
  const numericSize = typeof size === "number" ? size : 64;

  return (
    <Facehash
      aria-label={`${faceName} avatar`}
      className={"inline-flex shrink-0 rounded-full text-white " + className}
      colors={[...FACEHASH_COLORS]}
      enableBlink={numericSize >= 40}
      intensity3d="dramatic"
      name={seed}
      onRenderMouth={() => (
        <FacehashMouth size={numericSize} variant={mouthVariant} />
      )}
      role="img"
      showInitial={false}
      size={size}
      style={{
        borderRadius: "9999px",
        boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.18)",
        fontFamily: "var(--font-display)",
        fontWeight: 700,
      }}
      variant="gradient"
    />
  );
}

function avatarHash(seed: string) {
  let hash = 0;
  for (let index = 0; index < seed.length; index++) {
    hash = (hash << 5) - hash + seed.charCodeAt(index);
    hash |= 0;
  }
  return Math.abs(hash);
}

function FacehashMouth({ size, variant }: { size: number; variant: number }) {
  const stroke = Math.max(2, Math.round(size * 0.035));

  if (variant === 0) {
    return (
      <span
        aria-hidden="true"
        style={{
          borderBottom: `${stroke}px solid currentColor`,
          borderRadius: "0 0 999px 999px",
          height: Math.max(5, Math.round(size * 0.11)),
          width: Math.round(size * 0.28),
        }}
      />
    );
  }

  if (variant === 1) {
    return (
      <span
        aria-hidden="true"
        style={{
          backgroundColor: "currentColor",
          borderRadius: "999px",
          height: Math.max(3, Math.round(size * 0.06)),
          width: Math.round(size * 0.24),
        }}
      />
    );
  }

  if (variant === 2) {
    return (
      <span
        aria-hidden="true"
        style={{
          borderTop: `${stroke}px solid currentColor`,
          borderRadius: "999px 999px 0 0",
          height: Math.max(5, Math.round(size * 0.1)),
          width: Math.round(size * 0.22),
        }}
      />
    );
  }

  return (
    <span
      aria-hidden="true"
      style={{
        backgroundColor: "currentColor",
        borderRadius: "999px",
        height: Math.max(4, Math.round(size * 0.08)),
        opacity: 0.9,
        width: Math.max(4, Math.round(size * 0.08)),
      }}
    />
  );
}

/* --------------------------------------------------------------- NamePlate ---
 * Bottom-left name pill on a tile. Sans (NEVER mono), flat dark surface. */
export interface NamePlateProps {
  name: string;
  isLocal?: boolean;
  isMuted?: boolean;
  className?: string;
}

export function NamePlate({ name, isLocal, isMuted, className = "" }: NamePlateProps) {
  return (
    <div
      className={
        "inline-flex max-w-full items-center gap-1.5 rounded-full px-3 py-1.5 " + className
      }
      style={{ backgroundColor: color.scrim, border: `1px solid ${color.border}` }}
    >
      <span
        className="truncate text-[13px] font-medium"
        style={{ color: color.text, fontFamily: "var(--font-sans)" }}
      >
        {name}
      </span>
      {isLocal ? (
        <span className="text-[11px] font-medium" style={{ color: color.accent }}>
          You
        </span>
      ) : null}
      {isMuted ? <MicOff size={13} strokeWidth={2} style={{ color: color.accent }} /> : null}
    </div>
  );
}

/* -------------------------------------------------------------------- Pill ---
 * Generic flat rounded container (replaces .acm-pill glass blur look). */
export interface PillProps {
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}

export function Pill({ children, className = "", style }: PillProps) {
  return (
    <div
      className={"inline-flex items-center gap-2 rounded-full px-3 py-1.5 " + className}
      style={{ backgroundColor: color.scrim, border: `1px solid ${color.border}`, ...style }}
    >
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------- Badge ---
 * Small count badge. */
export interface BadgeProps {
  count: number;
  className?: string;
}

export function Badge({ count, className = "" }: BadgeProps) {
  if (!count || count <= 0) return null;
  return (
    <span
      className={
        "inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-bold text-white " +
        className
      }
      style={{ backgroundColor: color.accent }}
    >
      {count > 9 ? "9+" : count}
    </span>
  );
}

"use client";
import React from "react";
import { MicOff } from "lucide-react";
import { avatarColor, initials } from "../core";
import { color } from "../tokens";

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
 * Solid-fill circular avatar (NO gradient). Color derived from a stable id. */
export interface AvatarProps {
  name: string;
  /** Stable id for color hashing (falls back to name). */
  id?: string;
  size?: number;
  className?: string;
}

export function Avatar({ name, id, size = 64, className = "" }: AvatarProps) {
  return (
    <div
      className={"inline-flex items-center justify-center rounded-full " + className}
      style={{
        width: size,
        height: size,
        backgroundColor: avatarColor(id ?? name),
        color: "#ffffff",
        fontFamily: "var(--font-display)",
        fontSize: Math.round(size * 0.4),
        fontWeight: 700,
      }}
    >
      {initials(name)}
    </div>
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

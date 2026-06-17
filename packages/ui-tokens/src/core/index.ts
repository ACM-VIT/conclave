/**
 * Platform-agnostic helpers shared by the web and native primitives so the two
 * implementations cannot diverge in behavior. No React, no react-native, no DOM.
 */
import { color } from "../tokens";

/* ------------------------------------------------------------------ avatars */

/** Solid, on-brand avatar background palette (NO gradients). Cream text reads
 * on all of these. Index chosen deterministically from a stable id. */
export const AVATAR_PALETTE = [
  "#F95F4A", // orange
  "#FF007A", // pink
  "#7C5CFF", // violet
  "#2DA8A8", // teal
  "#4F86F7", // blue
  "#3FA66A", // green
  "#E0913A", // amber
  "#C44ECF", // magenta
] as const;

/** Deterministic hash → palette color. Same id always yields the same color. */
export function avatarColor(id: string | undefined | null): string {
  const key = (id ?? "").trim();
  if (!key) return AVATAR_PALETTE[0];
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = (hash << 5) - hash + key.charCodeAt(i);
    hash |= 0; // force 32-bit
  }
  return AVATAR_PALETTE[Math.abs(hash) % AVATAR_PALETTE.length];
}

/** First letter of the first word, uppercased. Falls back to "?". */
export function initials(name: string | undefined | null): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  return parts[0]?.[0]?.toUpperCase() || "?";
}

/* ----------------------------------------------------- control button states */

export type ControlButtonVariant =
  | "default"
  | "active"
  | "muted"
  | "danger"
  | "warning";

export interface ControlButtonColors {
  /** Background fill. */
  bg: string;
  /** Icon / foreground color. */
  fg: string;
  /** Border color (use "transparent" to hide). */
  border: string;
}

/**
 * The single source of truth for control-button visual states. Web and native
 * both call this so a "muted" mic looks identical on both. NO glow/shadow is
 * ever returned — state is expressed only via fill / tint / border.
 */
export function controlButtonColors(
  variant: ControlButtonVariant,
): ControlButtonColors {
  switch (variant) {
    case "active":
      // Screen-share / feature ON — solid accent fill
      return { bg: color.accent, fg: "#ffffff", border: "transparent" };
    case "muted":
      // Mic / cam OFF — solid red (Google Meet signature)
      return { bg: color.danger, fg: "#ffffff", border: "transparent" };
    case "danger":
      // Leave / end — solid red
      return { bg: color.danger, fg: "#ffffff", border: "transparent" };
    case "warning":
      return { bg: color.warning, fg: "#1a1a1a", border: "transparent" };
    case "default":
    default:
      // Meet-style: subtle filled grey circle with a bright white icon
      return { bg: "rgba(255,255,255,0.1)", fg: "#ffffff", border: "transparent" };
  }
}

/* ------------------------------------------------------------------- shared */

export type AppButtonVariant = "primary" | "ghost";

/** Tile state used by the Tile primitive on both platforms. */
export interface TileVisualState {
  /** Active speaker → flat 2px solid accent border (never a glow). */
  speaking?: boolean;
}

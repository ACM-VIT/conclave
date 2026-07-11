/**
 * Platform-agnostic helpers shared by the web and native primitives so the two
 * implementations cannot diverge in behavior. No React, no react-native, no DOM.
 */
import { color } from "../tokens.js";

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

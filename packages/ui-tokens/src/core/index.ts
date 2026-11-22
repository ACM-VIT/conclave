import { color } from "../tokens.js";


export type ControlButtonVariant =
  | "default"
  | "active"
  | "muted"
  | "danger"
  | "warning";

export interface ControlButtonColors {
  bg: string;
  fg: string;
  border: string;
}

export function controlButtonColors(
  variant: ControlButtonVariant,
): ControlButtonColors {
  switch (variant) {
    case "active":
      return { bg: color.accent, fg: "#ffffff", border: "transparent" };
    case "muted":
      return { bg: color.danger, fg: "#ffffff", border: "transparent" };
    case "danger":
      return { bg: color.danger, fg: "#ffffff", border: "transparent" };
    case "warning":
      return { bg: color.warning, fg: "#1a1a1a", border: "transparent" };
    case "default":
    default:
      return { bg: "rgba(255,255,255,0.1)", fg: "#ffffff", border: "transparent" };
  }
}

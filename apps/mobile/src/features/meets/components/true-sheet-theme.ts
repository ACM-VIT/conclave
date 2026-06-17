import type { TrueSheetProps } from "@lodev09/react-native-true-sheet";

export const SHEET_COLORS = {
  background: "#0b0b0b",
  surface: "rgba(20, 20, 20, 0.9)",
  row: "#18181b",
  border: "rgba(250, 250, 250, 0.08)",
  text: "#fafafa",
  textMuted: "rgba(250, 250, 250, 0.6)",
  textFaint: "rgba(250, 250, 250, 0.4)",
  accent: "#F95F4A",
  warning: "#fbbf24",
} as const;

export const SHEET_THEME: Pick<
  TrueSheetProps,
  | "backgroundColor"
  | "backgroundBlur"
  | "blurOptions"
  | "cornerRadius"
  | "grabber"
  | "grabberOptions"
  | "dimmed"
  | "dimmedDetentIndex"
  | "insetAdjustment"
> = {
  backgroundColor: SHEET_COLORS.background,
  backgroundBlur: "system-material-dark",
  blurOptions: { intensity: 30, interaction: false },
  cornerRadius: 24,
  grabber: true,
  grabberOptions: {
    width: 36,
    height: 5,
    topMargin: 8,
    cornerRadius: 3,
    color: "rgba(250, 250, 250, 0.25)",
    adaptive: false,
  },
  dimmed: true,
  dimmedDetentIndex: 0,
  insetAdjustment: "automatic",
};

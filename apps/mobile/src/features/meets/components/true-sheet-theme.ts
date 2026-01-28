import type { TrueSheetProps } from "@lodev09/react-native-true-sheet";

export const SHEET_COLORS = {
  background: "#0b0b0b",
  surface: "rgba(20, 20, 20, 0.9)",
  border: "rgba(254, 252, 217, 0.08)",
  text: "#FEFCD9",
  textMuted: "rgba(254, 252, 217, 0.6)",
  textFaint: "rgba(254, 252, 217, 0.4)",
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
    color: "rgba(254, 252, 217, 0.25)",
    adaptive: false,
  },
  dimmed: true,
  dimmedDetentIndex: 0,
  insetAdjustment: "automatic",
};

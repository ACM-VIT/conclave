export type MeetViewMode = "auto" | "tiled" | "spotlight" | "sidebar";
export type MeetSelfViewMode = "auto" | "tile" | "floating" | "minimized";
export type MeetSelfViewCorner =
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right";

export interface MeetViewSettings {
  mode: MeetViewMode;
  maxTiles: number;
  hideTilesWithoutVideo: boolean;
  selfViewMode: MeetSelfViewMode;
  selfViewCorner: MeetSelfViewCorner;
}

export const MEET_VIEW_MIN_TILES = 2;
export const MEET_VIEW_MAX_TILES = 49;

export const DEFAULT_MEET_VIEW_SETTINGS: MeetViewSettings = {
  mode: "auto",
  maxTiles: 16,
  hideTilesWithoutVideo: false,
  selfViewMode: "auto",
  selfViewCorner: "bottom-right",
};

const MEET_VIEW_MODES = new Set<MeetViewMode>([
  "auto",
  "tiled",
  "spotlight",
  "sidebar",
]);
const MEET_SELF_VIEW_MODES = new Set<MeetSelfViewMode>([
  "auto",
  "tile",
  "floating",
  "minimized",
]);
const MEET_SELF_VIEW_CORNERS = new Set<MeetSelfViewCorner>([
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right",
]);

const isMeetViewMode = (value: unknown): value is MeetViewMode =>
  typeof value === "string" && MEET_VIEW_MODES.has(value as MeetViewMode);

const isMeetSelfViewMode = (value: unknown): value is MeetSelfViewMode =>
  typeof value === "string" &&
  MEET_SELF_VIEW_MODES.has(value as MeetSelfViewMode);

const isMeetSelfViewCorner = (value: unknown): value is MeetSelfViewCorner =>
  typeof value === "string" &&
  MEET_SELF_VIEW_CORNERS.has(value as MeetSelfViewCorner);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export const clampMeetViewTiles = (value: number) => {
  const numericValue = Number.isFinite(value)
    ? value
    : DEFAULT_MEET_VIEW_SETTINGS.maxTiles;
  return Math.min(
    Math.max(Math.round(numericValue), MEET_VIEW_MIN_TILES),
    MEET_VIEW_MAX_TILES,
  );
};

export function normalizeMeetViewSettings(value: unknown): MeetViewSettings {
  if (!isRecord(value)) return DEFAULT_MEET_VIEW_SETTINGS;

  return {
    mode: isMeetViewMode(value.mode)
      ? value.mode
      : DEFAULT_MEET_VIEW_SETTINGS.mode,
    maxTiles:
      typeof value.maxTiles === "number"
        ? clampMeetViewTiles(value.maxTiles)
        : DEFAULT_MEET_VIEW_SETTINGS.maxTiles,
    hideTilesWithoutVideo:
      typeof value.hideTilesWithoutVideo === "boolean"
        ? value.hideTilesWithoutVideo
        : DEFAULT_MEET_VIEW_SETTINGS.hideTilesWithoutVideo,
    selfViewMode: isMeetSelfViewMode(value.selfViewMode)
      ? value.selfViewMode
      : DEFAULT_MEET_VIEW_SETTINGS.selfViewMode,
    selfViewCorner: isMeetSelfViewCorner(value.selfViewCorner)
      ? value.selfViewCorner
      : DEFAULT_MEET_VIEW_SETTINGS.selfViewCorner,
  };
}

import type { MeetSelfViewCorner } from "./meet-view";
import type { StageSize } from "./stage-split";

export interface StageRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface StageSurface {
  rect: StageRect;
  cover: "never" | "body";
}

export type StageOverlayForm = "floating" | "minimized";

export interface StageOverlay {
  corner: MeetSelfViewCorner;
  rect: StageRect;
}

const FLOATING_WIDTH_RATIO = 0.32;
const FLOATING_MIN_WIDTH = 160;
const FLOATING_MAX_WIDTH = 240;
const FLOATING_HEIGHT = 112;
const MINIMIZED_MAX_WIDTH = 304;
const MINIMIZED_HEIGHT = 52;
const TILE_CONTROLS: StageSize = { width: 140, height: 48 };

export const stageOverlayFootprint = (form: StageOverlayForm, bounds: StageSize): StageSize =>
  form === "floating"
    ? {
        width: Math.min(
          Math.max(Math.round(bounds.width * FLOATING_WIDTH_RATIO), FLOATING_MIN_WIDTH),
          FLOATING_MAX_WIDTH,
        ),
        height: FLOATING_HEIGHT,
      }
    : { width: Math.min(MINIMIZED_MAX_WIDTH, bounds.width), height: MINIMIZED_HEIGHT };

export const tileControlsRect = ({ x, y, width, height }: StageRect): StageRect => {
  const controlsWidth = Math.min(width, TILE_CONTROLS.width);
  return {
    x: x + width - controlsWidth,
    y,
    width: controlsWidth,
    height: Math.min(height, TILE_CONTROLS.height),
  };
};

export const overlapArea = (a: StageRect, b: StageRect) =>
  Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
  Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));

export const overlayClearsSurface = (overlay: StageRect, { rect, cover }: StageSurface) =>
  cover === "never"
    ? overlapArea(overlay, rect) === 0
    : overlapArea(overlay, tileControlsRect(rect)) === 0 &&
      overlapArea(overlay, rect) * 2 <= rect.width * rect.height;

const flipX = (corner: MeetSelfViewCorner): MeetSelfViewCorner =>
  corner === "top-left"
    ? "top-right"
    : corner === "top-right"
      ? "top-left"
      : corner === "bottom-left"
        ? "bottom-right"
        : "bottom-left";

const flipY = (corner: MeetSelfViewCorner): MeetSelfViewCorner =>
  corner === "top-left"
    ? "bottom-left"
    : corner === "top-right"
      ? "bottom-right"
      : corner === "bottom-left"
        ? "top-left"
        : "top-right";

export function placeStageOverlay({
  bounds,
  surfaces,
  corner,
  form,
}: {
  bounds: StageSize;
  surfaces: readonly StageSurface[];
  corner: MeetSelfViewCorner;
  form: StageOverlayForm;
}): StageOverlay | null {
  const footprint = stageOverlayFootprint(form, bounds);
  if (footprint.width > bounds.width || footprint.height > bounds.height) return null;
  for (const candidate of [corner, flipX(corner), flipY(corner), flipX(flipY(corner))]) {
    const rect = {
      x: candidate.endsWith("left") ? 0 : bounds.width - footprint.width,
      y: candidate.startsWith("top") ? 0 : bounds.height - footprint.height,
      ...footprint,
    };
    if (surfaces.every((surface) => overlayClearsSurface(rect, surface))) {
      return { corner: candidate, rect };
    }
  }
  return null;
}

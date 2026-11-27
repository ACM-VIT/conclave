import type { MeetSelfViewCorner } from "./meet-view";
import type { StageSize } from "./stage-split";

export interface StageRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface StageShare {
  aspect: number | null;
  captureControls: boolean;
}

export type StageSurface =
  | { kind: "camera" | "overflow" | "protected" | "compact-pin"; rect: StageRect }
  | { kind: "share"; rect: StageRect; share: StageShare };

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
const COMPACT_PILL: StageSize = { width: 144, height: 30 };
const SHARE_ZOOM_CHROME: StageSize = { width: 176, height: 56 };

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

const overlayClearsSurface = (overlay: StageRect, { rect, kind }: StageSurface) =>
  kind === "protected" || kind === "share" || kind === "compact-pin"
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

const cornerOrder = (corner: MeetSelfViewCorner) => [
  corner,
  flipX(corner),
  flipY(corner),
  flipX(flipY(corner)),
];

const atCorner = (bounds: StageSize, footprint: StageSize, corner: MeetSelfViewCorner): StageOverlay => ({
  corner,
  rect: {
    x: corner.endsWith("left") ? 0 : bounds.width - footprint.width,
    y: corner.startsWith("top") ? 0 : bounds.height - footprint.height,
    ...footprint,
  },
});

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
  for (const candidate of cornerOrder(corner)) {
    const overlay = atCorner(bounds, footprint, candidate);
    if (surfaces.every((surface) => overlayClearsSurface(overlay.rect, surface))) return overlay;
  }
  return null;
}

const sharePicture = (rect: StageRect, aspect: number | null): StageRect => {
  if (aspect === null) return rect;
  const width = Math.min(rect.width, rect.height * aspect);
  const height = width / aspect;
  return {
    x: rect.x + (rect.width - width) / 2,
    y: rect.y + (rect.height - height) / 2,
    width,
    height,
  };
};

export function placeCompactStageOverlay({
  bounds,
  surfaces,
  corner,
}: {
  bounds: StageSize;
  surfaces: readonly StageSurface[];
  corner: MeetSelfViewCorner;
}): StageOverlay {
  const compactPin = surfaces.find((surface) => surface.kind === "compact-pin");
  const footprint = {
    width: Math.min(COMPACT_PILL.width, bounds.width - (compactPin?.rect.width ?? 0)),
    height: Math.min(COMPACT_PILL.height, bounds.height),
  };
  const controls: StageRect[] = [];
  const pictures: StageRect[] = [];
  const cameras: StageRect[] = [];
  for (const surface of surfaces) {
    const { rect } = surface;
    switch (surface.kind) {
      case "share": {
        controls.push({ ...rect, height: Math.min(rect.height, TILE_CONTROLS.height) });
        if (surface.share.captureControls) {
          const width = Math.min(rect.width, SHARE_ZOOM_CHROME.width);
          const height = Math.min(rect.height, SHARE_ZOOM_CHROME.height);
          controls.push({ x: rect.x + rect.width - width, y: rect.y + rect.height - height, width, height });
        }
        pictures.push(sharePicture(rect, surface.share.aspect));
        break;
      }
      case "camera":
        controls.push(tileControlsRect(rect));
        cameras.push(rect);
        break;
      case "compact-pin":
      case "protected":
      case "overflow":
        controls.push(rect);
        break;
    }
  }

  const cover = (rect: StageRect, targets: readonly StageRect[]) =>
    targets.reduce((area, target) => area + overlapArea(rect, target), 0);
  const score = (rect: StageRect) => {
    const cameraArea = cover(rect, cameras);
    return {
      controls: cover(rect, controls),
      video: cover(rect, pictures) + cameraArea,
      cameras: cameraArea,
    };
  };
  let best = atCorner(bounds, footprint, corner);
  let bestScore = score(best.rect);
  const consider = (candidate: StageOverlay) => {
    const next = score(candidate.rect);
    if (
      next.controls < bestScore.controls ||
      (next.controls === bestScore.controls && (
        next.video < bestScore.video ||
        (next.video === bestScore.video && next.cameras < bestScore.cameras)
      ))
    ) {
      best = candidate;
      bestScore = next;
    }
  };
  for (const alternate of cornerOrder(corner).slice(1)) consider(atCorner(bounds, footprint, alternate));
  if (bestScore.controls === 0) return best;

  const maxX = bounds.width - footprint.width;
  const maxY = bounds.height - footprint.height;
  const xs = new Set([0, maxX, ...controls.flatMap((rect) => [rect.x - footprint.width, rect.x + rect.width])]);
  const ys = new Set([0, maxY, ...controls.flatMap((rect) => [rect.y - footprint.height, rect.y + rect.height])]);
  for (const x of xs) {
    if (x < 0 || x > maxX) continue;
    for (const y of ys) {
      if (y < 0 || y > maxY) continue;
      const candidate = `${y <= maxY / 2 ? "top" : "bottom"}-${x <= maxX / 2 ? "left" : "right"}` as const;
      consider({ corner: candidate, rect: { x, y, ...footprint } });
    }
  }
  return best;
}

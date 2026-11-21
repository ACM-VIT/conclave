import type { CSSProperties } from "react";

// A portrait phone in a landscape tile would lose two thirds of its height to
// a full crop. Zoom it only far enough to keep this share of the height.
export const PORTRAIT_VISIBLE_HEIGHT = 0.6;

export type TileVideoFraming =
  | "cover"
  | "contain"
  | "portrait-zoom"
  | "portrait-full";

// Cameras send a few shapes, and simulcast layers of one camera can miss
// that shape by a pixel of rounding. Snapping to the nearest keeps a layer
// switch from reshaping a tile.
const CAMERA_ASPECTS = [9 / 16, 3 / 5, 2 / 3, 3 / 4, 4 / 5, 1, 5 / 4, 4 / 3, 3 / 2, 16 / 9];

const snapAspect = (aspect: number) => {
  const distance = (candidate: number) => Math.abs(Math.log(candidate / aspect));
  return CAMERA_ASPECTS.reduce((best, candidate) =>
    distance(candidate) < distance(best) ? candidate : best,
  );
};

export const readVideoAspect = (width: number, height: number): number | null =>
  width > 0 && height > 0 ? snapAspect(width / height) : null;

export const isPortraitAspect = (aspect: number | null): boolean =>
  aspect !== null && aspect < 1;

const LANDSCAPE_TILE_ASPECT = 16 / 9;
// A cropped portrait tile keeps the face and loses a little forehead and chin.
const PORTRAIT_TILE_ASPECT = 3 / 4;

// The grid's tile shape for a camera. `sourceAspect` is null when the shape is
// unknown or the camera is off. A full portrait video gets its own shape,
// which the snap keeps no narrower than 9:16.
export const resolveTileAspect = (
  sourceAspect: number | null,
  isFullVideoShown: boolean,
): number => {
  if (sourceAspect === null || !(sourceAspect > 0)) return LANDSCAPE_TILE_ASPECT;
  const snapped = snapAspect(sourceAspect);
  if (!isPortraitAspect(snapped)) return LANDSCAPE_TILE_ASPECT;
  return isFullVideoShown ? snapped : PORTRAIT_TILE_ASPECT;
};

export const resolveTileVideoFraming = ({
  objectFit,
  isPortrait,
  isFullVideoShown,
  isScreenShare,
  isTileShapedToVideo,
}: {
  objectFit: "cover" | "contain";
  isPortrait: boolean;
  isFullVideoShown: boolean;
  isScreenShare: boolean;
  isTileShapedToVideo: boolean;
}): TileVideoFraming => {
  if (isScreenShare || !isPortrait || isTileShapedToVideo) return objectFit;
  return isFullVideoShown ? "portrait-full" : "portrait-zoom";
};

export const isPortraitFraming = (framing: TileVideoFraming): boolean =>
  framing === "portrait-zoom" || framing === "portrait-full";

const zoomedHeightPercent = 100 / PORTRAIT_VISIBLE_HEIGHT;

// The box is taller than the tile and centred, so `contain` scales the video
// up until either the box height or the tile width runs out.
export const PORTRAIT_ZOOM_STYLE: CSSProperties = {
  position: "absolute",
  left: 0,
  width: "100%",
  height: `${zoomedHeightPercent}%`,
  top: `${-(zoomedHeightPercent - 100) / 2}%`,
  objectFit: "contain",
};

export const PORTRAIT_FULL_STYLE: CSSProperties = {
  position: "relative",
};

// The tile's paint containment makes it a stacking context, so a negative
// z-index keeps the blurred copy under the real video and above the tile.
export const PORTRAIT_BACKDROP_STYLE: CSSProperties = {
  position: "absolute",
  inset: 0,
  width: "100%",
  height: "100%",
  objectFit: "cover",
  zIndex: -1,
  transform: "scale(1.15)",
  filter: "blur(32px) brightness(1.05) saturate(1.15)",
  pointerEvents: "none",
};

import type { CSSProperties } from "react";

// A portrait phone in a landscape tile would lose two thirds of its height to
// a full crop. Zoom it only far enough to keep this share of the height.
export const PORTRAIT_VISIBLE_HEIGHT = 0.6;

export type TileVideoFraming =
  | "cover"
  | "contain"
  | "portrait-zoom"
  | "portrait-full";

export const isPortraitFrame = (width: number, height: number): boolean =>
  width > 0 && height > width;

export const resolveTileVideoFraming = ({
  objectFit,
  isPortrait,
  isFullVideoShown,
  isScreenShare,
}: {
  objectFit: "cover" | "contain";
  isPortrait: boolean;
  isFullVideoShown: boolean;
  isScreenShare: boolean;
}): TileVideoFraming => {
  if (isScreenShare || !isPortrait) return objectFit;
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

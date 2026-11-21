import type { CSSProperties } from "react";

// A portrait phone in a landscape tile would lose two thirds of its height to
// a full crop. Zoom it only far enough to keep this share of the height.
export const PORTRAIT_VISIBLE_HEIGHT = 0.6;

export type TileVideoFraming = "cover" | "contain" | "portrait-zoom";

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
  return isFullVideoShown ? "contain" : "portrait-zoom";
};

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

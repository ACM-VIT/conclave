import type { ElementSize } from "../hooks/useElementSize";

export interface TileChrome {
  dense: boolean;
  avatarSize: number;
  avatarLift: number;
}

const LABEL_STRIP_NORMAL = 44;
const LABEL_STRIP_DENSE = 30;
const DENSE_MAX_HEIGHT = 139;
const DENSE_MAX_WIDTH = 167;

export interface TileChromeOptions {
  maxAvatar?: number;
  hasLabel?: boolean;
}

export function computeTileChrome(
  size: ElementSize | null,
  { maxAvatar = 80, hasLabel = true }: TileChromeOptions = {},
): TileChrome {
  if (!size || size.width <= 0 || size.height <= 0) {
    return { dense: false, avatarSize: maxAvatar, avatarLift: 0 };
  }
  const { width, height } = size;
  const dense = height <= DENSE_MAX_HEIGHT || width <= DENSE_MAX_WIDTH;

  if (!hasLabel) {
    return {
      dense,
      avatarSize: Math.max(
        16,
        Math.min(Math.floor(Math.min(width, height) * 0.8), maxAvatar),
      ),
      avatarLift: 0,
    };
  }

  const labelStrip = dense ? LABEL_STRIP_DENSE : LABEL_STRIP_NORMAL;
  const avatarSize = Math.max(
    16,
    Math.min(
      Math.floor(width * 0.42),
      Math.floor((height - labelStrip) * 0.82),
      maxAvatar,
    ),
  );
  const avatarLift = Math.min(
    Math.max(0, Math.round((avatarSize - height) / 2 + labelStrip)),
    Math.max(0, Math.floor((height - avatarSize) / 2)),
  );
  return { dense, avatarSize, avatarLift };
}

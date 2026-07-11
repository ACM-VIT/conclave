/**
 * Density-aware sizing for a video tile's overlay chrome — the camera-off
 * face and the name pill/badges drawn on top of it.
 *
 * The meeting grid packs tiles down to ~100px tall in big calls. Fixed-size
 * chrome breaks there: an 80px face overflows the tile and the name pill cuts
 * straight across its mouth. Everything scales from the measured tile box
 * instead — tiles big enough for the fixed sizes render exactly as before.
 */

import type { ElementSize } from "../hooks/useElementSize";

export interface TileChrome {
  /** Small-tile mode: compact name pill, badges, and hover controls. */
  dense: boolean;
  /** Camera-off face diameter in px. */
  avatarSize: number;
  /** px the face is raised so the name pill never covers it on short tiles. */
  avatarLift: number;
}

// Vertical strip the bottom-left name pill occupies: bottom offset + pill
// height + a small clearance gap. Must track the pill styles in
// ParticipantVideo/GridLayout (normal: bottom-3 + py-1.5 text-xs pill;
// dense: bottom-1.5 + py-0.5 text-[10px] pill).
const LABEL_STRIP_NORMAL = 44;
const LABEL_STRIP_DENSE = 30;
// Tiles below either bound flip to dense chrome. Height bound sits just under
// the fixed rail-tile height (h-36 = 144px); width bound just under the
// packer's 176px minimum, so rails and healthy grids keep normal chrome.
const DENSE_MAX_HEIGHT = 139;
const DENSE_MAX_WIDTH = 167;

export interface TileChromeOptions {
  /** Upper bound for the face diameter (the pre-density fixed size). */
  maxAvatar?: number;
  /** False for decorative faces with no name pill to clear. */
  hasLabel?: boolean;
}

export function computeTileChrome(
  size: ElementSize | null,
  { maxAvatar = 80, hasLabel = true }: TileChromeOptions = {},
): TileChrome {
  if (!size || size.width <= 0 || size.height <= 0) {
    // Unmeasured (first paint) — keep today's fixed-size behavior.
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
  // Center in the full tile, then raise just enough that the face bottom
  // clears the label strip — 0 for tiles already tall enough, so large tiles
  // keep their perfectly centered face.
  const avatarLift = Math.min(
    Math.max(0, Math.round((avatarSize - height) / 2 + labelStrip)),
    // Never lift the face past the top edge.
    Math.max(0, Math.floor((height - avatarSize) / 2)),
  );
  return { dense, avatarSize, avatarLift };
}

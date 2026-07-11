/**
 * Flat segment palette. Every color is bright enough to carry the same dark
 * label ink, so the wheel stays readable at any size without per-segment
 * contrast math. No gradients anywhere by design.
 */
export const WHEEL_SEGMENT_COLORS = [
  "#f95f4a", // coral (brand accent)
  "#f8b13d", // amber
  "#ffd166", // marigold
  "#8fd694", // mint
  "#4fc3a1", // teal
  "#6fb7ff", // sky
  "#b78bf7", // lavender
  "#f77fb0", // rose
] as const;

export const WHEEL_LABEL_INK = "#141417";

/**
 * Cycle the palette by position. When the count would make the last segment
 * touch the first with the same color, swap it to the opposite palette slot
 * so the seam never shows two identical neighbors.
 */
export const segmentColor = (index: number, count: number): string => {
  const colors = WHEEL_SEGMENT_COLORS;
  if (
    count > 1 &&
    index === count - 1 &&
    index % colors.length === 0
  ) {
    return colors[Math.floor(colors.length / 2)];
  }
  return colors[index % colors.length];
};

export const WHEEL_SEGMENT_COLORS = [
  "#f95f4a",
  "#f8b13d",
  "#ffd166",
  "#8fd694",
  "#4fc3a1",
  "#6fb7ff",
  "#b78bf7",
  "#f77fb0",
] as const;

export const WHEEL_LABEL_INK = "#141417";

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

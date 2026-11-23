export const WHEEL_RADIUS = 96;
export const RIM_WIDTH = 7;
export const HUB_RADIUS = 12;
export const LABEL_PAD = 6;
export const VIEW_EXTENT = 109;
export const VIEW_SIZE = VIEW_EXTENT * 2;
export const MIN_LABEL_PX = 10;
export const SINGLE_LABEL_SIZE = 13;
export const SINGLE_LABEL_Y = -((HUB_RADIUS + WHEEL_RADIUS) / 2);
export const SINGLE_LABEL_WIDTH =
  2 * Math.sqrt(WHEEL_RADIUS ** 2 - SINGLE_LABEL_Y ** 2) - 2 * LABEL_PAD;

export const pxPerUnitFor = (wheelPx: number): number => wheelPx / VIEW_SIZE;

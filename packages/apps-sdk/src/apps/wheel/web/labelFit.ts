import {
  HUB_RADIUS,
  LABEL_PAD,
  MIN_LABEL_PX,
  SINGLE_LABEL_SIZE,
  SINGLE_LABEL_WIDTH,
  WHEEL_RADIUS,
  pxPerUnitFor,
} from "./geometry";
import { graphemes } from "./graphemes";
import { hasVisibleText } from "../core/labels";

export type MeasureText = (text: string) => number;

export type LabelGeometry = {
  count: number;
  outerRadius: number;
  innerRadius: number;
  maxFontSize: number;
  pxPerUnit: number;
  minScreenPx: number;
};

export type FittedLabel =
  | { text: string; truncated: boolean; numbered: false }
  | { text: string; truncated: true; numbered: true; radius: number };

export type FittedLabels = {
  fontSize: number;
  labels: (FittedLabel | null)[];
};

const ELLIPSIS = "…";
const THICKNESS = 1.05;
const EDGE_GAP = 0.6;
const OUTLIER_RATIO = 0.7;
const MIN_FULL_RATIO = 0.75;

const mod360 = (value: number): number => ((value % 360) + 360) % 360;

const maxFontFor = (count: number): number =>
  count <= 2 ? 15 : count <= 6 ? 13 : count <= 12 ? 11 : 9.5;

export const wheelLabelGeometry = (count: number, wheelPx: number): LabelGeometry => ({
  count,
  outerRadius: WHEEL_RADIUS - LABEL_PAD,
  innerRadius: HUB_RADIUS + 3.5,
  maxFontSize: maxFontFor(count),
  pxPerUnit: pxPerUnitFor(wheelPx),
  minScreenPx: MIN_LABEL_PX,
});

const halfTan = (count: number): number =>
  count <= 2 ? Number.POSITIVE_INFINITY : Math.tan(Math.PI / count);

const innerLimit = (fontSize: number, geometry: LabelGeometry): number => {
  const tan = halfTan(geometry.count);
  const wedge = Number.isFinite(tan)
    ? ((fontSize * THICKNESS) / 2 + EDGE_GAP) / tan
    : 0;
  return Math.max(geometry.innerRadius, wedge);
};

const maxLabelWidth = (fontSize: number, geometry: LabelGeometry): number =>
  Math.max(0, geometry.outerRadius - innerLimit(fontSize, geometry));

const largestFittingSize = (
  unitWidth: number,
  geometry: LabelGeometry
): number => {
  const tan = halfTan(geometry.count);
  const span = geometry.outerRadius - geometry.innerRadius;
  const byLength = unitWidth > 0 ? span / unitWidth : geometry.maxFontSize;
  const byWedge = Number.isFinite(tan)
    ? (geometry.outerRadius * tan - EDGE_GAP) / (THICKNESS / 2 + unitWidth * tan)
    : geometry.maxFontSize;
  return Math.min(geometry.maxFontSize, byLength, byWedge);
};

const keptClusters = (clusters: string[], count: number): number => {
  let end = count;
  while (end > 0 && !hasVisibleText(clusters[end - 1])) end -= 1;
  return end;
};

const shortened = (clusters: string[], count: number): string =>
  `${clusters.slice(0, keptClusters(clusters, count)).join("")}${ELLIPSIS}`;

const truncateToWidth = (
  label: string,
  widthAtSize: (text: string) => number,
  limit: number
): FittedLabel | null => {
  const width = widthAtSize(label);
  if (!(width > 0)) return null;
  if (width <= limit) return { text: label, truncated: false, numbered: false };
  const characters = graphemes(label);
  let low = 0;
  let high = characters.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const candidate = shortened(characters, mid);
    if (widthAtSize(candidate) <= limit) low = mid;
    else high = mid - 1;
  }
  if (keptClusters(characters, low) < 1) return null;
  return {
    text: shortened(characters, low),
    truncated: true,
    numbered: false,
  };
};

const uprightReach = (unitWidth: number): number => Math.hypot(unitWidth, THICKNESS) / 2;

const largestUprightSize = (unitWidth: number, geometry: LabelGeometry): number => {
  const reach = uprightReach(unitWidth);
  const sinHalf = Math.sin(Math.PI / geometry.count);
  const byWedge = (geometry.outerRadius * sinHalf - EDGE_GAP) / (reach * (1 + sinHalf));
  const byDepth = (geometry.outerRadius - geometry.innerRadius) / (2 * reach);
  return Math.min(geometry.maxFontSize, byWedge, byDepth);
};

const numberedLabel = (
  index: number,
  fontSize: number,
  geometry: LabelGeometry,
  measure: MeasureText
): FittedLabel | null => {
  const text = String(index + 1);
  const unitWidth = measure(text);
  if (fontSize > largestUprightSize(unitWidth, geometry)) return null;
  return {
    text,
    truncated: true,
    numbered: true,
    radius: geometry.outerRadius - fontSize * uprightReach(unitWidth),
  };
};

const fitAtSize = (
  labels: string[],
  fontSize: number,
  geometry: LabelGeometry,
  measure: MeasureText
): (FittedLabel | null)[] => {
  const limit = maxLabelWidth(fontSize, geometry);
  const widthAtSize = (text: string) => measure(text) * fontSize;
  return labels.map(
    (label, index) =>
      truncateToWidth(label, widthAtSize, limit) ??
      numberedLabel(index, fontSize, geometry, measure)
  );
};

const sizeStep = (size: number): number => Math.floor(size * 20) / 20;

export const fitWheelLabels = (
  labels: string[],
  geometry: LabelGeometry,
  measure: MeasureText
): FittedLabels => {
  if (labels.length === 0) return { fontSize: geometry.maxFontSize, labels: [] };
  const hidden = (fontSize: number): FittedLabels => ({
    fontSize,
    labels: labels.map(() => null),
  });
  const minFontSize = geometry.minScreenPx / geometry.pxPerUnit;
  if (!(geometry.pxPerUnit > 0) || !(minFontSize <= geometry.maxFontSize)) {
    return hidden(geometry.maxFontSize);
  }
  const sizes = labels
    .map((label) => largestFittingSize(measure(label), geometry))
    .sort((a, b) => a - b);
  const typical = sizes[Math.floor((sizes.length - 1) / 2)];
  const chosen = sizes[0] >= typical * OUTLIER_RATIO ? sizes[0] : typical;
  const fontSize = Math.max(minFontSize, sizeStep(Math.min(geometry.maxFontSize, chosen)));
  const fitted = fitAtSize(labels, fontSize, geometry, measure);
  const fullCount = fitted.filter((label) => label && !label.truncated).length;
  if (fullCount < labels.length * MIN_FULL_RATIO) return hidden(fontSize);
  if (fitted.every((label) => label !== null)) return { fontSize, labels: fitted };
  const needed = Math.min(
    fontSize,
    ...fitted.flatMap((label, index) =>
      label ? [] : [largestUprightSize(measure(String(index + 1)), geometry)]
    )
  );
  if (needed < minFontSize) return hidden(fontSize);
  const smaller = Math.max(minFontSize, sizeStep(needed));
  const refitted = fitAtSize(labels, smaller, geometry, measure);
  return refitted.every((label) => label !== null)
    ? { fontSize: smaller, labels: refitted }
    : hidden(fontSize);
};

const SINGLE_LABEL_DIRECTION = 90;

export const isLabelFlipped = (
  index: number,
  count: number,
  rotation: number
): boolean => {
  const direction =
    count === 1 ? SINGLE_LABEL_DIRECTION : (360 / count) * (index + 0.5);
  return mod360(direction + rotation) >= 180;
};

export const uprightAngle = (rotation: number): number => -mod360(rotation);

export const labelAngle = (
  index: number,
  count: number,
  rotation: number,
  numbered: boolean
): number => {
  if (numbered) return uprightAngle(rotation);
  const middle = (360 / count) * (index + 0.5);
  return isLabelFlipped(index, count, rotation) ? middle + 90 : middle - 90;
};

export const labelFlipSignature = (rotation: number, count: number): string => {
  let signature = "";
  for (let index = 0; index < count; index += 1) {
    signature += isLabelFlipped(index, count, rotation) ? "1" : "0";
  }
  return signature;
};

export const fitSingleLabel = (
  label: string,
  wheelPx: number,
  measure: MeasureText
): string | null => {
  if (!(wheelPx > 0) || !(SINGLE_LABEL_SIZE * pxPerUnitFor(wheelPx) >= MIN_LABEL_PX)) {
    return null;
  }
  return (
    truncateToWidth(label, (text) => measure(text) * SINGLE_LABEL_SIZE, SINGLE_LABEL_WIDTH)
      ?.text ?? null
  );
};

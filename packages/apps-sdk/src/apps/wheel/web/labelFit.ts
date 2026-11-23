import {
  HUB_RADIUS,
  LABEL_PAD,
  MIN_LABEL_PX,
  SINGLE_LABEL_SIZE,
  SINGLE_LABEL_WIDTH,
  WHEEL_RADIUS,
  pxPerUnitFor,
} from "./geometry";

export type MeasureText = (text: string) => number;

export type LabelGeometry = {
  count: number;
  outerRadius: number;
  innerRadius: number;
  maxFontSize: number;
  pxPerUnit: number;
  minScreenPx: number;
};

export type FittedLabel = {
  text: string;
  truncated: boolean;
};

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

const graphemeSegmenter =
  typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

const EXTENDS_CLUSTER = /^(?:\p{M}|\u200D|\uFE0E|\uFE0F|[\u{1F3FB}-\u{1F3FF}]|[\u{E0020}-\u{E007F}])$/u;
const REGIONAL_INDICATOR = /^[\u{1F1E6}-\u{1F1FF}]$/u;
const PICTOGRAPHIC = /^\p{Extended_Pictographic}$/u;

type HangulPart = "L" | "V" | "T" | "LV" | "LVT";

const hangulPart = (point: string): HangulPart | null => {
  const code = point.codePointAt(0) ?? 0;
  if ((code >= 0x1100 && code <= 0x115f) || (code >= 0xa960 && code <= 0xa97c)) return "L";
  if ((code >= 0x1160 && code <= 0x11a7) || (code >= 0xd7b0 && code <= 0xd7c6)) return "V";
  if ((code >= 0x11a8 && code <= 0x11ff) || (code >= 0xd7cb && code <= 0xd7fb)) return "T";
  if (code >= 0xac00 && code <= 0xd7a3) return (code - 0xac00) % 28 === 0 ? "LV" : "LVT";
  return null;
};

const joinsHangul = (before: HangulPart, after: HangulPart): boolean =>
  before === "L"
    ? after !== "T"
    : before === "LV" || before === "V"
      ? after === "V" || after === "T"
      : after === "T";

export const splitGraphemesFallback = (text: string): string[] => {
  const clusters: string[] = [];
  let pictographicTail = false;
  let afterJoiner = false;
  let flagOpen = false;
  let hangul: HangulPart | null = null;
  for (const point of text) {
    const last = clusters.length - 1;
    const part = hangulPart(point);
    if (last >= 0) {
      if (afterJoiner && PICTOGRAPHIC.test(point)) {
        clusters[last] += point;
        afterJoiner = false;
        pictographicTail = true;
        continue;
      }
      if (EXTENDS_CLUSTER.test(point)) {
        clusters[last] += point;
        const joiner = point === "\u200D";
        afterJoiner = joiner && pictographicTail;
        if (joiner) pictographicTail = false;
        flagOpen = false;
        hangul = null;
        continue;
      }
      if (flagOpen && REGIONAL_INDICATOR.test(point)) {
        clusters[last] += point;
        flagOpen = false;
        continue;
      }
      if (hangul && part && joinsHangul(hangul, part)) {
        clusters[last] += point;
        hangul = part;
        continue;
      }
    }
    clusters.push(point);
    pictographicTail = PICTOGRAPHIC.test(point);
    afterJoiner = false;
    flagOpen = REGIONAL_INDICATOR.test(point);
    hangul = part;
  }
  return clusters;
};

export const graphemes = (text: string): string[] =>
  graphemeSegmenter
    ? Array.from(graphemeSegmenter.segment(text), (part) => part.segment)
    : splitGraphemesFallback(text);

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

const truncateToWidth = (
  label: string,
  widthAtSize: (text: string) => number,
  limit: number
): FittedLabel | null => {
  if (widthAtSize(label) <= limit) return { text: label, truncated: false };
  const characters = graphemes(label);
  let low = 0;
  let high = characters.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const candidate = `${characters.slice(0, mid).join("").trimEnd()}${ELLIPSIS}`;
    if (widthAtSize(candidate) <= limit) low = mid;
    else high = mid - 1;
  }
  if (low < 1) return null;
  return {
    text: `${characters.slice(0, low).join("").trimEnd()}${ELLIPSIS}`,
    truncated: true,
  };
};

export const fitWheelLabels = (
  labels: string[],
  geometry: LabelGeometry,
  measure: MeasureText
): FittedLabels => {
  if (labels.length === 0) return { fontSize: geometry.maxFontSize, labels: [] };
  const minFontSize = geometry.minScreenPx / geometry.pxPerUnit;
  if (!(geometry.pxPerUnit > 0) || !(minFontSize <= geometry.maxFontSize)) {
    return { fontSize: geometry.maxFontSize, labels: labels.map(() => null) };
  }
  const sizes = labels
    .map((label) => largestFittingSize(measure(label), geometry))
    .sort((a, b) => a - b);
  const typical = sizes[Math.floor((sizes.length - 1) / 2)];
  const chosen = sizes[0] >= typical * OUTLIER_RATIO ? sizes[0] : typical;
  const fontSize = Math.max(
    minFontSize,
    Math.floor(Math.min(geometry.maxFontSize, chosen) * 20) / 20
  );
  const limit = maxLabelWidth(fontSize, geometry);
  const widthAtSize = (text: string) => measure(text) * fontSize;
  const fitted = labels.map((label) => truncateToWidth(label, widthAtSize, limit));
  const fullCount = fitted.filter((label) => label && !label.truncated).length;
  if (fullCount < labels.length * MIN_FULL_RATIO) {
    return { fontSize, labels: labels.map(() => null) };
  }
  return { fontSize, labels: fitted };
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

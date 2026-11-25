export type StageSplitMode = "side" | "stack" | "main-only";

export interface StageSplit {
  mode: StageSplitMode;
  railSize: number;
}

export interface StageSize {
  width: number;
  height: number;
}

export interface StageRailSpec {
  sideRatio: number;
  sideMin: number;
  sideMax: number;
  stackMin: number;
  stackMax: number;
}

export const STAGE_GAP = 12;

export const STAGE_MAIN_MIN: StageSize = { width: 160, height: 90 };

export const SIDE_BY_SIDE_PREFERRED_MAIN: StageSize = { width: 400, height: 225 };

export const PARTICIPANT_RAIL: StageRailSpec = {
  sideRatio: 0.22,
  sideMin: 160,
  sideMax: 240,
  stackMin: 80,
  stackMax: 128,
};

export const COMPANION_RAIL: StageRailSpec = {
  sideRatio: 0.32,
  sideMin: 160,
  sideMax: 448,
  stackMin: 112,
  stackMax: 160,
};

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

const fittedWidth = ({ width, height }: StageSize) =>
  Math.max(0, Math.min(width, (height * 16) / 9));

const fittedArea = (size: StageSize) => {
  const width = fittedWidth(size);
  return width * ((width * 9) / 16);
};

export function stageMainSize(size: StageSize, split: StageSplit): StageSize {
  if (split.mode === "side") {
    return { width: size.width - STAGE_GAP - split.railSize, height: size.height };
  }
  if (split.mode === "stack") {
    return { width: size.width, height: size.height - STAGE_GAP - split.railSize };
  }
  return { width: size.width, height: size.height };
}

export function stageSplitCandidates(
  size: StageSize,
  rail: StageRailSpec,
): StageSplit[] {
  const side: StageSplit = {
    mode: "side",
    railSize: clamp(Math.round(size.width * rail.sideRatio), rail.sideMin, rail.sideMax),
  };
  const stack: StageSplit = {
    mode: "stack",
    railSize: clamp(
      Math.floor(size.height - STAGE_GAP - STAGE_MAIN_MIN.height),
      rail.stackMin,
      rail.stackMax,
    ),
  };
  return [side, stack].filter((split) => {
    const main = stageMainSize(size, split);
    return main.width >= STAGE_MAIN_MIN.width && main.height >= STAGE_MAIN_MIN.height;
  });
}

export function chooseStageSplit(
  size: StageSize | null,
  rail: StageRailSpec,
): StageSplit {
  if (!size || size.width <= 0 || size.height <= 0) {
    return { mode: "side", railSize: rail.sideMin };
  }
  const candidates = stageSplitCandidates(size, rail);
  const side = candidates.find((split) => split.mode === "side");
  if (
    side &&
    fittedWidth(stageMainSize(size, side)) >= SIDE_BY_SIDE_PREFERRED_MAIN.width
  ) {
    return side;
  }
  return candidates.reduce<StageSplit>(
    (best, split) =>
      best.mode === "main-only" ||
      fittedArea(stageMainSize(size, split)) > fittedArea(stageMainSize(size, best))
        ? split
        : best,
    { mode: "main-only", railSize: 0 },
  );
}

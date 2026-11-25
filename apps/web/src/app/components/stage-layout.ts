import type { CSSProperties } from "react";
import type { StageSplit, StageSplitMode } from "../lib/stage-split";

export const stageSplitClass = (mode: StageSplitMode) =>
  `flex h-full w-full min-h-0 min-w-0 gap-3 ${mode === "stack" ? "flex-col" : "flex-row"}`;

export const stageRailClass = (mode: StageSplitMode) =>
  mode === "main-only"
    ? "hidden"
    : mode === "stack"
      ? "flex w-full shrink-0 flex-row gap-3 overflow-x-auto overflow-y-hidden pb-1"
      : "flex shrink-0 flex-col gap-3 overflow-y-auto overflow-x-hidden";

export const stageRailStyle = ({ mode, railSize }: StageSplit): CSSProperties | undefined =>
  mode === "stack"
    ? { height: railSize }
    : mode === "side"
      ? { width: railSize }
      : undefined;

export const stageRailTileClass = (mode: StageSplitMode) =>
  mode === "stack" ? "relative h-full w-28 shrink-0" : "relative h-28 w-full shrink-0";

export const STAGE_RAIL_SHORT_LANDSCAPE_HIDDEN_CLASS =
  "[@media(width<40rem)_and_(height<31.25rem)_and_(orientation:landscape)]:hidden";

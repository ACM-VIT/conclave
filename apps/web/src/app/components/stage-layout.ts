import type { CSSProperties } from "react";
import type { PublishedStagePlacement } from "../hooks/useStagePlacementPublisher";
import type { StagePlacement } from "../lib/meeting-stage-layout";
import type { StageRect } from "../lib/stage-overlay";
import type { StageSplit } from "../lib/stage-split";

export type PublishedStage = PublishedStagePlacement<StagePlacement & { split: StageSplit }>;

export const stageSplitClass = ({ split }: PublishedStage) =>
  `flex h-full w-full min-h-0 min-w-0 gap-3 ${split.mode === "stack" ? "flex-col" : "flex-row"}`;

export const stageRailClass = ({ split }: PublishedStage) =>
  split.mode === "stack"
    ? "flex w-full shrink-0 flex-row gap-3 overflow-x-auto overflow-y-hidden pb-1"
    : "flex shrink-0 flex-col gap-3 overflow-y-auto overflow-x-hidden";

export const stageRailStyle = ({ split }: PublishedStage): CSSProperties | undefined =>
  split.mode === "stack"
    ? { height: split.railSize }
    : split.mode === "side"
      ? { width: split.railSize }
      : undefined;

export const stageRailTileClass = ({ split }: PublishedStage) =>
  split.mode === "stack" ? "relative h-full w-28 shrink-0" : "relative h-28 w-full shrink-0";

export const stageRectSize = ({ width, height }: StageRect): CSSProperties => ({ width, height });
